/**
 * sprint24-data-backfills-094.integration.test.ts
 *
 * Sprint 24 P4. Migration 094's TWO DATA BACKFILLS against REAL PostgreSQL 16,
 * applied from the migration FILE ITSELF, connected as the REAL `jale_admin`
 * role -- not as the superuser, and not through a re-implementation of the
 * migration's SQL.
 *
 * WHY THIS SUITE EXISTS, AND WHY IT CANNOT BE MOCKED OR RUN AS SUPERUSER.
 *
 * Both tables 094 writes are ENABLE + FORCE ROW LEVEL SECURITY:
 * `users` (002_rls_policies.sql, `users_isolation_*` keyed on
 * `cognito_sub = current_setting('app.current_user_id', true)`) and
 * `worker_application_defaults` (079, `worker_application_defaults_self`, plus
 * 081/091's jale_whatsapp policies keyed on `app.current_internal_user_id`).
 * FORCE is the part that matters: it makes the table OWNER obey those policies
 * too. jale_admin owns both tables AND is the role migrations run as, so with
 * no GUC set every policy evaluates `= NULL` and matches NOTHING.
 *
 * That is not a theory -- it is why 094 exists. `scripts/backfill-trade-canonical.ts`
 * issues its UPDATE as jale_admin and would rewrite ZERO rows against
 * production while reporting success. Measured on this suite's own testbed
 * with seven candidate rows present: visible un-forced = 7, visible under
 * FORCE = 0.
 *
 * So the connection this suite applies the migration on is load-bearing. A
 * SUPERUSER bypasses RLS entirely, which means a 094 that FORGOT its
 * `NO FORCE ROW LEVEL SECURITY` would pass a superuser-applied test perfectly
 * -- the suite would be blind to the exact bug the migration exists to fix.
 * Fixtures and verification reads therefore go through the superuser client
 * (`su`), and the MIGRATION goes through a second client connected as
 * `jale_admin`. Case 1 asserts that separation directly.
 *
 * WHAT ELSE ONLY A REAL DATABASE SETTLES:
 *   - the jsonb `-` operator REMOVES an answer key rather than nulling it, so
 *     `hasOwnProperty` in application-requirements.ts stops matching and the
 *     question is asked again for this job. A stored null would read as
 *     answered.
 *   - `translate()` pairs its two arguments POSITIONALLY and silently drops
 *     the overflow, so the accent-folding expression is only correct if the
 *     pair is length-matched. Case 8 runs the migration's own normalizer
 *     expression against `normalizeProfession` over accented input including
 *     circumflexes -- which no alias in 060 contains, so the seeded-alias
 *     parity of case 9 would NOT catch that class of bug on its own.
 *   - SQL/TypeScript parity itself (case 9). 094 re-implements
 *     `normalizeProfession`, `resolveTradeAlias` (including its singular
 *     retry) and `standardTradeKeyForCategory` in SQL. The only way to know
 *     the two agree is to seed one user per distinct raw string, apply the
 *     migration, and compare against what `canonicalizeWorkerTrade` returns
 *     for the same string over the same live `trade_aliases` rows.
 *   - that the tenant boundary is INTACT afterwards (cases 10 and 11): both
 *     tables back to `relforcerowsecurity`, and a real `jale_whatsapp` client
 *     with worker A's GUC still cannot read worker B's defaults row.
 *
 * ONE PATH, NO BRANCHES ON DATABASE STATE. The suite seeds its fixtures and
 * then applies 094's file unconditionally, whatever migration the database is
 * already at. On a database stopped at 093 that is the first application; under
 * `scripts/run-whatsapp-v2-db-tests.sh` -- which requires a database at the
 * LATEST migration -- it is a RE-application over freshly seeded rows. Both
 * reach the same end state because 094 is idempotent, and the re-application
 * path is itself the idempotence proof. The runner exercises the
 * re-application path; case 2 exercises the replay explicitly either way.
 *
 * CASES ARE ORDERED AND STATEFUL: 3-11 all read the end state case 2 produced.
 * Do not reorder them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import {
  canonicalizeWorkerTrade,
  type TradeAliasQueryable,
} from '../../../lambda/lib/trade-canonical';
import { normalizeProfession } from '../../../lambda/lib/profession';
import { FIELD_REUSE_POLICY } from '../../../lambda/lib/job-fields';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIGRATION_PATH = path.join(
  __dirname, '..', '..', '..', 'db', 'migrations', '094_sprint24_data_backfills.sql',
);

/** The four `per_application` keys 094 strips. Derived, never hand-listed. */
const PER_APPLICATION_KEYS = (Object.keys(FIELD_REUSE_POLICY) as Array<
  keyof typeof FIELD_REUSE_POLICY
>).filter((key) => FIELD_REUSE_POLICY[key] === 'per_application');

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

if (!databaseUrl) {
  test('CONCERN: the migration-094 data-backfill DB suite was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[sprint24-data-backfills-094] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a '
      + 'disposable PostgreSQL 16 superuser URL with migrations 001-093 (or later) applied.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

maybeDescribe('P4: migration 094 backfills data under FORCE RLS', () => {
  /** Fixtures and verification reads. Bypasses RLS, so it can never be the
   * connection the migration runs on. */
  const su = new Client({ connectionString: databaseUrl });
  /** The migration's OWN connection: the real, non-superuser jale_admin. */
  let admin: Client;

  const tag = randomUUID().slice(0, 8);
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  /** cognito_sub -> users.id, for every fixture worker. */
  const ids = new Map<string, string>();
  /** The distinct raw trade strings case 9 compares against the TS module. */
  let parityRaws: string[] = [];
  /** `worker_application_defaults.updated_at` as SEEDED, before 094 ran.
   * 079 gives that column no trigger, so the migration advancing it is the
   * only thing that can move it. */
  let seededUpdatedAt = new Date(0);
  /** The same, for the stable-only control row step A must SKIP entirely. */
  let controlUpdatedAt = new Date(0);

  const sub = (name: string) => `p4-094-${tag}-${name}`;
  const idOf = (name: string) => ids.get(sub(name))!;

  /** Both classes of answer in ONE blob, the shape the 2026-09-04 incident
   * left behind: a legacy row written before the reuse policy existed. */
  const STABLE_ANSWERS = {
    home_address: { street: '77 Alameda', city: 'El Paso', state: 'TX', zip: '79901' },
  };
  const PER_APPLICATION_ANSWERS = {
    date_available: '2026-09-10',
    desired_pay: { amount: 25, interval: 'hourly' },
    worked_here_before: { answer: true },
    emergency_contact: { name: 'Maria Lopez', phone: '5551234567' },
  };

  async function seedWorker(name: string, mainTrade: string, other: string | null): Promise<string> {
    // No `phone`: it is nullable, and 60-odd random numbers would be a
    // needless uniqueness-collision surface.
    const row = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, main_trade, main_trade_other)
       VALUES ($1, 'worker', $2, $3) RETURNING id`,
      [sub(name), mainTrade, other],
    );
    ids.set(sub(name), row.rows[0].id);
    return row.rows[0].id;
  }

  async function tradeOf(name: string): Promise<{ main_trade: string | null; main_trade_other: string | null }> {
    const res = await su.query<{ main_trade: string | null; main_trade_other: string | null }>(
      `SELECT main_trade, main_trade_other FROM users WHERE id = $1`,
      [idOf(name)],
    );
    return res.rows[0];
  }

  async function defaultsOf(name: string): Promise<{ answers: Record<string, unknown>; updated_at: Date }> {
    const res = await su.query<{ answers: Record<string, unknown>; updated_at: Date }>(
      `SELECT answers, updated_at FROM worker_application_defaults WHERE worker_id = $1`,
      [idOf(name)],
    );
    return res.rows[0];
  }

  /** Applies 094's file exactly the way run-migrations.sh does: the whole
   * file, in one simple query, as jale_admin. `pg` sends a multi-statement
   * simple query, which is what carries BEGIN/COMMIT and the dollar-quoted DO
   * blocks intact -- and why no bind parameters may appear here (`?|` is an
   * operator, not a placeholder). */
  async function apply094(client: Client = admin): Promise<void> {
    await client.query(migrationSql);
  }

  beforeAll(async () => {
    await su.connect();
    if (new URL(databaseUrl as string).username !== 'jale_admin') {
      await su.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    if (new URL(databaseUrl as string).username !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }
    admin = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_admin', 'test-admin-pw'),
    });
    await admin.connect();

    // ── (a) the mixed legacy defaults blob, and a stable-only control ──
    await seedWorker('defaults-mixed', 'other', 'soldador');
    await seedWorker('defaults-stable', 'plumber', null);
    await su.query(
      `INSERT INTO worker_application_defaults (worker_id, answers)
       VALUES ($1, $2::jsonb), ($3, $4::jsonb)`,
      [
        idOf('defaults-mixed'),
        JSON.stringify({ ...STABLE_ANSWERS, ...PER_APPLICATION_ANSWERS }),
        idOf('defaults-stable'),
        JSON.stringify(STABLE_ANSWERS),
      ],
    );
    seededUpdatedAt = (await su.query<{ updated_at: Date }>(
      `SELECT updated_at FROM worker_application_defaults WHERE worker_id = $1`,
      [idOf('defaults-mixed')],
    )).rows[0].updated_at;
    controlUpdatedAt = (await su.query<{ updated_at: Date }>(
      `SELECT updated_at FROM worker_application_defaults WHERE worker_id = $1`,
      [idOf('defaults-stable')],
    )).rows[0].updated_at;

    // ── (b)-(e) the trade cases ──
    // 'soldador' is the welder alias, and 060's welder row carries
    // trade_category = NULL -- so this stays CUSTOM with canonical_es.
    await seedWorker('welder-lower', 'other', 'soldador');
    // Already canonical: the IS DISTINCT FROM guard must leave it alone.
    await seedWorker('welder-canonical', 'other', 'Soldador');
    // A standard trade_category ('electrician'), reached through an accented
    // alias, so the accent folding is on the path.
    await seedWorker('standard-accented', 'other', 'Eléctrico');
    // The singular retry: 'welders' is not an alias; 'welder' is. This is the
    // example resolveTradeAlias's own docstring names, and it lands on the
    // custom branch, so it is distinct from the standard case above.
    await seedWorker('plural-retry', 'other', 'welders');
    // Unknown: no alias row, so 094 must leave BOTH columns exactly as typed
    // (a deliberate divergence from the TS fallback's tidyTradeText).
    await seedWorker('unknown', 'other', 'Zzzz maquinista lunar');
    // A jobs.trade_category with NO main_trade counterpart: 'tablaroca'
    // resolves to the drywall row, which must stay custom or the 004 CHECK
    // would reject it.
    await seedWorker('non-standard-category', 'other', 'tablaroca');

    // ── (h) parity fixtures: one worker per DISTINCT raw string over every
    // trade_aliases row's aliases, trade_key and canonical_es. Read from the
    // live table so a row alias-generator.ts has learned is covered too.
    const aliasRows = await su.query<{
      trade_key: string; canonical_es: string; aliases: string[];
    }>(`SELECT trade_key, canonical_es, aliases FROM trade_aliases ORDER BY trade_key`);
    expect(aliasRows.rows.length).toBeGreaterThan(0);
    const raws = new Set<string>();
    for (const row of aliasRows.rows) {
      raws.add(row.trade_key);
      raws.add(row.canonical_es);
      for (const alias of row.aliases) raws.add(alias);
    }
    parityRaws = [...raws].sort();
    for (let i = 0; i < parityRaws.length; i += 1) {
      await seedWorker(`parity-${i}`, 'other', parityRaws[i]);
    }
  });

  afterAll(async () => {
    // worker_application_defaults cascades on worker_id, but job_applications
    // is ON DELETE RESTRICT and worker_documents has no cascade -- this suite
    // creates neither, and the deletes below stay in that order anyway so a
    // future fixture cannot turn cleanup into a 23503.
    // try/finally: a failed DELETE must still close BOTH clients, or jest
    // hangs on the open pg handles.
    try {
      const workerIds = [...ids.values()];
      if (workerIds.length > 0) {
        await su.query(`DELETE FROM job_applications WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
        await su.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
        await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [workerIds]);
      }
    } finally {
      await admin.end();
      await su.end();
    }
  });

  // ── 1. the connection the migration runs on ────────────────────
  // If this suite applied 094 as the superuser, a 094 that dropped its
  // `NO FORCE` would still pass -- so this case pins the separation, and
  // measures the zero-row no-op that makes the migration necessary.
  it('1. applies as the real jale_admin, which under FORCE sees NONE of the rows it must rewrite', async () => {
    const who = await admin.query<{ user: string; super: boolean }>(
      `SELECT current_user AS user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
    );
    expect(who.rows[0].user).toBe('jale_admin');
    expect(who.rows[0].super).toBe(false);
    // ...and it OWNS both tables, which is precisely why FORCE binds it.
    const owned = await admin.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relname IN ('users', 'worker_application_defaults')
          AND pg_get_userbyid(relowner) = 'jale_admin'`,
    );
    expect(owned.rows.map((r) => r.relname).sort())
      .toEqual(['users', 'worker_application_defaults']);

    // THE no-op, measured. The candidate filter 094 (and the L6 script) uses,
    // run as jale_admin with no GUC set: zero rows, though the fixtures above
    // planted many.
    const forced = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users
        WHERE main_trade = 'other' AND btrim(coalesce(main_trade_other, '')) <> ''`,
    );
    expect(Number(forced.rows[0].n)).toBe(0);
    const visible = await su.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users
        WHERE main_trade = 'other' AND btrim(coalesce(main_trade_other, '')) <> ''`,
    );
    expect(Number(visible.rows[0].n)).toBeGreaterThan(0);
  });

  // ── 2. apply, then replay ──────────────────────────────────────
  it('2. applies cleanly, and a replay is a no-op the SQL itself accepts', async () => {
    await expect(apply094()).resolves.not.toThrow();
    // The self-checks are inside the file; a replay re-runs them against the
    // end state the first apply produced, and the two IS DISTINCT FROM
    // clauses plus `answers ?|` mean it changes nothing. Only the migration
    // LEDGER refuses a replay in the deploy path -- never the SQL.
    await expect(apply094()).resolves.not.toThrow();

    // Nothing outside the fixtures moved: the stable-only control row keeps
    // its blob untouched by step A.
    const control = await defaultsOf('defaults-stable');
    expect(control.answers).toEqual(STABLE_ANSWERS);
  });

  // ── 3. step A: the per-application keys are GONE, not nulled ───
  it('3. strips exactly the four per_application answers and advances updated_at', async () => {
    expect(PER_APPLICATION_KEYS.sort()).toEqual(
      ['date_available', 'desired_pay', 'emergency_contact', 'worked_here_before'],
    );

    const after = await defaultsOf('defaults-mixed');
    // Only the stable half survives, and by VALUE -- home_address is not
    // merely present, it is unmodified.
    expect(after.answers).toEqual(STABLE_ANSWERS);
    // REMOVED, not set to null: `hasOwnProperty` is what the engine tests, so
    // a stored null would still read as answered and the question would never
    // be asked again for this job.
    for (const key of PER_APPLICATION_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(after.answers, key)).toBe(false);
    }
    expect(Object.keys(after.answers)).toEqual(['home_address']);

    // updated_at ADVANCED. 079 gives this column no trigger -- every writer
    // sets it explicitly -- so the migration's `updated_at = now()` is the
    // only thing that can have moved it past the value the INSERT defaulted
    // to in beforeAll.
    expect(after.updated_at.getTime()).toBeGreaterThan(seededUpdatedAt.getTime());

    // ...and the control row, which step A's `answers ?|` guard skipped, was
    // NOT touched at all. A step A that rewrote every row would pass the
    // assertion above and fail this one.
    const control = await defaultsOf('defaults-stable');
    expect(control.answers).toEqual(STABLE_ANSWERS);
    expect(control.updated_at.getTime()).toBe(controlUpdatedAt.getTime());
  });

  // ── 4. step B, custom branch ───────────────────────────────────
  it('4. rewrites a custom trade to canonical_es and keeps main_trade custom', async () => {
    // 060's welder row has trade_category = NULL, so standardTradeKeyForCategory
    // returns null and the trade stays custom with the Spanish canonical name.
    expect(await tradeOf('welder-lower')).toEqual({
      main_trade: 'other', main_trade_other: 'Soldador',
    });
    // 'tablaroca' resolves to the drywall row, whose trade_category IS set --
    // but 'drywall' is a jobs.trade_category with no main_trade counterpart,
    // so writing it would be a 23514 on the 004 CHECK. It stays custom.
    expect(await tradeOf('non-standard-category')).toEqual({
      main_trade: 'other', main_trade_other: 'Tablaroquero',
    });
    // chk_trade_other (004) is satisfied throughout: 'other' never comes back
    // with a null name.
    for (const name of ['welder-lower', 'non-standard-category', 'welder-canonical']) {
      const row = await tradeOf(name);
      if (row.main_trade === 'other') expect(row.main_trade_other).not.toBeNull();
    }
  });

  // ── 5. step B, standard branch ─────────────────────────────────
  it('5. moves a standard-category trade onto the enum key and CLEARS the free text', async () => {
    // 'Eléctrico' -> normalized 'electrico' -> the electrician alias row ->
    // trade_category 'electrician', which IS a main_trade key.
    expect(await tradeOf('standard-accented')).toEqual({
      main_trade: 'electrician', main_trade_other: null,
    });
    // Cleared, not left beside the key: a stale spelling next to the enum is
    // exactly the fragmentation D4 removes.
  });

  // ── 6. the singular retry ──────────────────────────────────────
  it("6. resolves a plural through resolveTradeAlias's single 's'-stripping retry", async () => {
    // 'welders' is in no `aliases` array and is no trade_key; 'welder' is
    // both. Only the retry reaches it.
    const direct = await su.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM trade_aliases
        WHERE trade_key = 'welders' OR 'welders' = ANY(aliases)`,
    );
    expect(Number(direct.rows[0].n)).toBe(0);
    expect(await tradeOf('plural-retry')).toEqual({
      main_trade: 'other', main_trade_other: 'Soldador',
    });
  });

  // ── 7. unresolved and already-canonical rows are untouched ─────
  it('7. leaves an unknown trade and an already-canonical trade exactly as they were', async () => {
    // A deliberate divergence from canonicalizeWorkerTrade, whose fallback
    // returns tidyTradeText(raw): rewriting text the alias cache has not
    // learned gains nothing and loses the worker's own words. Byte-for-byte.
    expect(await tradeOf('unknown')).toEqual({
      main_trade: 'other', main_trade_other: 'Zzzz maquinista lunar',
    });
    expect(normalizeProfession('Zzzz maquinista lunar')).toBe('zzzz maquinista lunar');
    const noAlias = await su.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM trade_aliases
        WHERE trade_key = $1 OR $1 = ANY(aliases)`,
      ['zzzz maquinista lunar'],
    );
    expect(Number(noAlias.rows[0].n)).toBe(0);

    // Already canonical: the two IS DISTINCT FROM clauses mean no UPDATE was
    // issued for this row at all, which is what makes a replay report 0.
    expect(await tradeOf('welder-canonical')).toEqual({
      main_trade: 'other', main_trade_other: 'Soldador',
    });
  });

  // ── 8. the normalizer, character by character ──────────────────
  // THE case that catches a broken translate() pair. translate() pairs its
  // arguments positionally and silently ignores the overflow, so one extra
  // target character shifts every later mapping. No alias in 060 contains a
  // circumflex, so case 9's seeded-alias parity would NOT catch it -- this
  // one runs the migration's OWN expression, extracted from the file, over
  // input that does.
  it("8. its normalizer expression equals normalizeProfession, extracted from the migration itself", async () => {
    const norm = migrationSql.match(
      /btrim\(regexp_replace\(regexp_replace\(translate\(lower\([^)]*\),[\s\S]*?'\\s\+', ' ', 'g'\)\)/,
    )?.[0];
    expect(norm).toBeDefined();
    // The length-matched pair, asserted on the real file text.
    const pair = norm!.match(/translate\(lower\([^)]*\),\s*'([^']*)',\s*'([^']*)'\)/);
    expect(pair).not.toBeNull();
    expect([...pair![1]].length).toBe([...pair![2]].length);

    // The expression reads `u.main_trade_other`; re-point it at a bind
    // parameter so the migration's own text can be evaluated over arbitrary
    // input. A function replacement, because '$1' in a string replacement is
    // capture-group syntax.
    const expr = norm!.replace('u.main_trade_other', () => '$1');
    const cases = [
      'soldador', 'Soldador', 'SOLDADOR', 'Eléctrico', 'ELÉCTRICO', 'albañil',
      'Carpintería', 'plomería', 'â ê î ô û', 'ãõç', 'Ünica', 'crème brûlée',
      'São Paulo', 'français', 'niño', 'HVAC/tech', 'a-b', 'a.b', 'a/b',
      '  soldador  ', 'x   y', 'soldador\ttig', 'PLOMERO   -   RESIDENCIAL',
      'Zzzz maquinista lunar', '',
    ];
    for (const raw of cases) {
      const res = await su.query<{ n: string }>(`SELECT ${expr} AS n`, [raw]);
      expect({ raw, sql: res.rows[0].n }).toEqual({ raw, sql: normalizeProfession(raw) });
    }
  });

  // ── 9. SQL/TypeScript parity over every alias in the table ─────
  it('9. produces, for EVERY trade_aliases alias/key/canonical_es, the pair canonicalizeWorkerTrade returns', async () => {
    expect(parityRaws.length).toBeGreaterThan(30);
    const divergences: Array<Record<string, unknown>> = [];

    for (let i = 0; i < parityRaws.length; i += 1) {
      const raw = parityRaws[i];
      const sqlPair = await tradeOf(`parity-${i}`);
      // The TS side, over the SAME live trade_aliases rows, through the
      // superuser client (trade_aliases has no RLS; the module only SELECTs).
      const ts = await canonicalizeWorkerTrade(
        su as unknown as TradeAliasQueryable, { raw, lang: 'es' },
      );
      expect(ts.resolved).toBe(true);
      if (sqlPair.main_trade !== ts.main_trade
        || sqlPair.main_trade_other !== ts.main_trade_other) {
        divergences.push({ raw, sql: sqlPair, ts: { main_trade: ts.main_trade, main_trade_other: ts.main_trade_other } });
      }
    }

    expect(divergences).toEqual([]);
    // The corpus really did exercise BOTH branches, or the parity above would
    // be a parity of one code path. Sequential, not Promise.all: these share
    // one pg client, which serializes overlapping queries and warns about it.
    const pairs: Array<{ main_trade: string | null; main_trade_other: string | null }> = [];
    for (let i = 0; i < parityRaws.length; i += 1) pairs.push(await tradeOf(`parity-${i}`));
    expect(pairs.some((p) => p.main_trade !== 'other' && p.main_trade_other === null)).toBe(true);
    expect(pairs.some((p) => p.main_trade === 'other' && p.main_trade_other !== null)).toBe(true);
  });

  // ── 10. the catalog end state ──────────────────────────────────
  it('10. leaves both tables with RLS ENABLE + FORCE restored', async () => {
    const res = await su.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT rel.relname, rel.relrowsecurity, rel.relforcerowsecurity
         FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public'
          AND rel.relname IN ('users', 'worker_application_defaults')
        ORDER BY rel.relname`,
    );
    expect(res.rows).toEqual([
      { relname: 'users', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'worker_application_defaults', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    // And the migration's own catalog self-check is what would have refused
    // to commit otherwise -- assert the guard exists, by message.
    expect(migrationSql).toContain('migration 094: % lost RLS ENABLE + FORCE');
  });

  // ── 11. the tenant boundary, exercised by a real least-privilege role ──
  // relforcerowsecurity being true is a catalog fact; that it still SEPARATES
  // two workers is a behavioural one. 094 un-forces `worker_application_defaults`
  // mid-transaction, so this is the case that would catch an un-force left in
  // place (or a policy dropped and not recreated).
  it('11. still isolates one worker from another: jale_whatsapp with A\'s GUC cannot read B\'s defaults', async () => {
    const wa = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
    });
    await wa.connect();
    try {
      await wa.query('BEGIN');
      // 081's policy is keyed on app.current_internal_user_id -- the GUC the
      // processor sets per turn.
      await setInternalUserRlsContext(wa, idOf('defaults-mixed'));
      const own = await wa.query(
        `SELECT worker_id FROM worker_application_defaults WHERE worker_id = $1`,
        [idOf('defaults-mixed')],
      );
      expect(own.rows).toHaveLength(1);
      // The OTHER worker's row exists (the superuser sees it) but is invisible
      // to this session. Not an error -- a filtered read, which is what makes
      // a missing FORCE so quiet.
      const other = await wa.query(
        `SELECT worker_id FROM worker_application_defaults WHERE worker_id = $1`,
        [idOf('defaults-stable')],
      );
      expect(other.rows).toHaveLength(0);
      const asSuperuser = await su.query(
        `SELECT worker_id FROM worker_application_defaults WHERE worker_id = $1`,
        [idOf('defaults-stable')],
      );
      expect(asSuperuser.rows).toHaveLength(1);
      // An unscoped read reaches nothing at all.
      await wa.query(`SELECT set_config('app.current_internal_user_id', '', true)`);
      const none = await wa.query(
        `SELECT worker_id FROM worker_application_defaults WHERE worker_id = ANY($1::uuid[])`,
        [[idOf('defaults-mixed'), idOf('defaults-stable')]],
      );
      expect(none.rows).toHaveLength(0);
      await wa.query('ROLLBACK');
    } finally {
      await wa.end();
    }
  });
});
