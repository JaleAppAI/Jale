/**
 * admin-queues-2d.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 117 (roadmap 2d): the case status
 * triggers (admin_cases.status_changed_at and the "Status changed" timeline
 * event), the one-time status_changed_at backfill, onboarding start over and
 * back by week, door and step (admin_analytics_onboarding_restarts),
 * operator resets with bulk runs taken out (admin_analytics_operator_resets),
 * and the applicant digest's adoption (admin_analytics_digest_adoption) and
 * emails by week (admin_analytics_digest_sends). It also runs the admin
 * console's own case SQL (queue order, Home buckets, timeline order) as
 * jale_admin_console, read from admin/src/lib/server/admin-cases.ts so the
 * text is never copied: a later migration that renames or retypes
 * status_changed_at fails here instead of in production.
 *
 * The read functions aggregate the whole database, so counts are asserted as
 * a delta between a baseline call (before fixtures) and a call after them,
 * for every returned row. Fixture workers, employers and reset reasons are
 * new, so their distinct counts add up and their reasons' rows are compared
 * exactly. No assertion needs a fresh testbed.
 *
 * Fixtures are inserted as the superuser with session_replication_role =
 * replica, so no trigger moves a timestamp. Every time comes from the
 * database clock (now() when the suite starts), never the host's: weekly
 * fixtures are anchored to Monday 00:00 UTC of the previous weeks (W1, W2,
 * and W3, the first week of a 4-week window), so their week never depends on
 * the weekday the suite runs. The functions read now() at every call, so a
 * suite starting less than 5 minutes before Monday 00:00 UTC first waits
 * until that Monday has begun: the window cannot move mid-suite.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite is explicitly
 * skipped and says so (Rule 11: no silent skips).
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --no-tests --ref none
 *   then: cd infra && JALE_TEST_DATABASE_URL=<printed url> npx jest --runInBand test/unit/db/admin-queues-2d.integration.test.ts
 *
 * Always pass --runInBand: the assertions are whole-database deltas, so
 * another suite inserting runs, resets or emails in a parallel worker would
 * break them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPERATOR = 'it-2d';
const MARK = 'it-2d fixture';
const MASK = '••••';

const migrationSql = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'db', 'migrations', '117_admin_queues.sql'), 'utf8');

/**
 * The console's case SQL, read from admin/src/lib/server/admin-cases.ts (the
 * module that runs it) and never copied: its template literals, with their
 * ${NAME} references resolved. Read lazily by the tests that use it, so a
 * refactor of that module fails those tests with a clear message and nothing
 * else. `list` and `openList` take the LIMIT as $1, as the console passes it.
 */
function consoleCaseSql(): { list: string; openList: string; buckets: string; timeline: string } {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'admin', 'src', 'lib', 'server', 'admin-cases.ts'), 'utf8');
  const scope: Record<string, string> = {};
  const resolve = (template: string): string => template.replace(/\$\{(\w+)\}/g, (_, k: string) => {
    if (!(k in scope)) throw new Error(`admin-cases.ts: \${${k}} is not a template const read so far`);
    return scope[k];
  });
  // The consts, in source order: each may use the ones before it.
  for (const name of ['OPEN_CASE_FILTER', 'CLOSED_CASE_FILTER', 'CASE_LIST_SELECT', 'CASE_QUEUE_ORDER', 'OPEN_CASES_BY_WAIT_SQL']) {
    const m = source.match(new RegExp(`const ${name} = \`([^\`]*)\`;`));
    if (!m) throw new Error(`admin-cases.ts: template const ${name} not found`);
    scope[name] = resolve(m[1]);
  }
  // The statements passed to pool.query as a template literal.
  const statements = [...source.matchAll(/pool\.query<[^(]*>\(\s*`([^`]*)`/g)].map((m) => m[1]);
  const only = (what: string, pick: (t: string) => boolean): string => {
    const found = statements.filter(pick);
    if (found.length !== 1) throw new Error(`admin-cases.ts: expected one ${what}, found ${found.length}`);
    return resolve(found[0]);
  };
  return {
    list: only('queue query', (t) => t.includes('${CASE_QUEUE_ORDER}') && !t.includes('WHERE')),
    openList: only('open-case preview query', (t) => t.includes('WHERE ${OPEN_CASE_FILTER}') && t.includes('${CASE_QUEUE_ORDER}')),
    buckets: scope.OPEN_CASES_BY_WAIT_SQL,
    timeline: only('timeline query', (t) => t.includes('FROM admin_case_events')),
  };
}

const RESTART = ['reached', 'restart_workers', 'restart_presses', 'back_workers', 'back_presses'] as const;
const SENDS = ['emailed', 'sent', 'failed', 'unknown', 'in_progress', 'employers_reached'] as const;
const STEP_ORDER = [
  'start.choose_language', 'identity.verify_otp', 'legal.review', 'profile.voice_choice',
  'profile.voice_processing', 'profile.name', 'profile.location', 'profile.trade', 'profile.custom_trade',
  'profile.experience', 'profile.transportation', 'profile.availability', 'trust.question.1',
  'trust.question.2', 'trust.question.3', 'profile.photo', 'profile.photo_type',
];
const DOOR_ORDER = ['all', 'whatsapp', 'web'];

type Row = Record<string, unknown>;
type Counts<K extends string> = Record<K, number>;

const zeros = <K extends string>(cols: readonly K[]): Counts<K> =>
  Object.fromEntries(cols.map((c) => [c, 0])) as Counts<K>;

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    await client.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`);
    await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
  } finally {
    await client.end();
  }
}

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function rowsOf(url: string, sql: string, args: unknown[] = []): Promise<Row[]> {
  return withClient(url, async (c) => (await c.query(sql, args)).rows);
}

/** Monday 00:00 UTC of the week containing `d` (Postgres date_trunc('week', d, 'UTC')). */
function isoWeekStart(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY).toISOString();
}

const iso = (v: unknown): string | null => (v === null ? null : new Date(v as Date).toISOString());

/** Rows keyed by `keyOf`, each column a number. */
function keyed<K extends string>(rows: Row[], keyOf: (r: Row) => string, cols: readonly K[]): Map<string, Counts<K>> {
  const out = new Map<string, Counts<K>>();
  for (const r of rows) {
    out.set(keyOf(r), Object.fromEntries(cols.map((c) => [c, Number(r[c])])) as Counts<K>);
  }
  return out;
}

/** after - before for every row of `after` (a row missing from `before` counts from zero). */
function delta<K extends string>(after: Map<string, Counts<K>>, before: Map<string, Counts<K>>, cols: readonly K[]): Map<string, Counts<K>> {
  const out = new Map<string, Counts<K>>();
  for (const [k, a] of after) {
    const b = before.get(k);
    out.set(k, Object.fromEntries(cols.map((c) => [c, a[c] - (b?.[c] ?? 0)])) as Counts<K>);
  }
  return out;
}

/** Every returned row's delta equals the expectation (zeros where none), and every expected row was returned. */
function expectDeltas<K extends string>(got: Map<string, Counts<K>>, expected: Map<string, Counts<K>>, cols: readonly K[]): void {
  for (const [k, d] of got) {
    expect({ k, d }).toEqual({ k, d: expected.get(k) ?? zeros(cols) });
  }
  for (const k of expected.keys()) expect({ k, returned: got.has(k) }).toEqual({ k, returned: true });
}

async function dbNow(url: string): Promise<number> {
  return withClient(url, async (c) => ((await c.query('SELECT now() AS n')).rows[0].n as Date).getTime());
}

/** Restart row key: week (or the window) | door | step (or all-steps, the step_key NULL row). */
const restartKey = (r: Row): string =>
  `${iso(r.week_start) ?? 'window'}|${r.door as string}|${(r.step_key as string | null) ?? 'all-steps'}`;

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping 2d admin queues integration tests');
}

maybeDescribe('2d admin queues (117)', () => {
  let superUrl = '';
  let consoleUrl = '';
  let whatsappUrl = '';
  let adminUrl = '';
  // The database clock when the suite starts; every fixture time derives from it.
  let T = 0;
  let monday = new Date(0);
  let W1 = new Date(0);
  let W2 = new Date(0);
  let W3 = new Date(0);
  const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

  const call = {
    restarts: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_onboarding_restarts($1)', [weeks]),
    resets: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_operator_resets($1)', [weeks]),
    adoption: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_digest_adoption()'),
    sends: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_digest_sends($1)', [weeks]),
  };

  // Baselines, taken before any fixture.
  const before = {
    restarts: [] as Row[], restarts12: [] as Row[], resets: [] as Row[], resets12: [] as Row[],
    adoption: [] as Row[], sends: [] as Row[], sends12: [] as Row[],
  };

  // Fixture ids, for the assertions and the cleanup.
  const caseIds: string[] = [];
  const employers: Record<string, string> = {};
  // The week (Monday) of worker G's pre-window verification.
  let weekG = '';

  /** Runs `fn` in one superuser transaction with triggers suppressed. */
  async function seed(fn: (c: Client) => Promise<void>): Promise<void> {
    await withClient(superUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await fn(c);
      await c.query('COMMIT');
    });
  }

  const user = async (c: Client, type: 'worker' | 'employer', o: { email?: string | null; sub?: string } = {}): Promise<string> =>
    (await c.query(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, $2, $3) RETURNING id`,
      [o.sub ?? `${OPERATOR}-${randomBytes(6).toString('hex')}`, type, o.email ?? null],
    )).rows[0].id as string;

  /** A case as the console sees it, committed; times explicit. */
  const newCase = async (status: string, createdAt: Date, changedAt: Date, o: { priority?: number; id?: string } = {}): Promise<string> => {
    const id = (await rowsOf(superUrl,
      `INSERT INTO admin_cases (id, case_type, status, priority, summary, created_at, updated_at, status_changed_at)
       VALUES (COALESCE($5::uuid, gen_random_uuid()), 'help_request', $1, $6, $2, $3, $3, $4) RETURNING id`,
      [status, MARK, createdAt, changedAt, o.id ?? null, o.priority ?? 70]))[0].id as string;
    caseIds.push(id);
    return id;
  };

  const caseRow = async (id: string): Promise<Row> =>
    (await rowsOf(superUrl, 'SELECT status, status_changed_at, updated_at, details FROM admin_cases WHERE id = $1', [id]))[0];

  const statusEvents = async (id: string): Promise<Row[]> =>
    rowsOf(superUrl,
      `SELECT event_type, actor_type, actor_id, payload, created_at
         FROM admin_case_events WHERE case_id = $1 AND event_type = 'status_changed' ORDER BY created_at`, [id]);

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await setServiceRolePasswords(superUrl);
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');
    whatsappUrl = urlForRole(superUrl, 'jale_whatsapp', 'test-whatsapp-pw');
    adminUrl = urlForRole(superUrl, 'jale_admin', 'test-admin-pw');

    T = await dbNow(superUrl);
    // The functions read now() at every call, so the suite must not straddle
    // a Monday 00:00 UTC: within 5 minutes of the next one, wait it out.
    const nextMonday = new Date(isoWeekStart(new Date(T))).getTime() + 7 * DAY;
    if (nextMonday - T < 5 * MIN) {
      while ((await dbNow(superUrl)) < nextMonday + 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      T = await dbNow(superUrl);
    }
    monday = new Date(isoWeekStart(new Date(T)));
    W1 = new Date(monday.getTime() - 7 * DAY);
    W2 = new Date(monday.getTime() - 14 * DAY);
    W3 = new Date(monday.getTime() - 21 * DAY);

    before.restarts = await call.restarts(consoleUrl);
    before.restarts12 = await call.restarts(consoleUrl, 12);
    before.resets = await call.resets(consoleUrl);
    before.resets12 = await call.resets(consoleUrl, 12);
    before.adoption = await call.adoption(consoleUrl);
    before.sends = await call.sends(consoleUrl);
    before.sends12 = await call.sends(consoleUrl, 12);

    // ── Onboarding moves. Each worker is new; times are hours after W2 / W1.
    await seed(async (c) => {
      type Move = [from: string | null, to: string, reason: string, at: Date];
      const run = async (userId: string, status: string, moves: Move[]): Promise<void> => {
        const runId = (await c.query(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status, created_at, updated_at)
           VALUES ($1, 2, 'profile.name', $2, $3, $3) RETURNING id`,
          [userId, status, moves[0][3]],
        )).rows[0].id as string;
        for (const [from, to, reason, at] of moves) {
          await c.query(
            `INSERT INTO worker_workflow_transitions (run_id, from_step_key, to_step_key, reason, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [runId, from, to, reason, at],
          );
        }
      };
      const h = (d: Date, hours: number): Date => plus(d, hours * HOUR);

      // A: WhatsApp. Back from location, start over from location, start
      // over twice on profile.name (self-loops, one per week).
      await run(await user(c, 'worker'), 'active', [
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(W2, 1)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(W2, 2)],
        ['profile.voice_choice', 'profile.name', 'profile_voice_skipped', h(W2, 3)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(W2, 4)],
        ['profile.location', 'profile.name', 'worker_back', h(W2, 5)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(W2, 6)],
        ['profile.location', 'profile.name', 'worker_restart', h(W2, 7)],
        ['profile.name', 'profile.name', 'worker_restart', h(W2, 8)],
        ['profile.name', 'profile.name', 'worker_restart', h(W1, 1)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(W1, 2)],
      ]);
      // B: WhatsApp. A voice retry loop (not a back), back from trade twice
      // (two weeks), back from location, a self-loop, an operator repair
      // (a system move: an arrival).
      await run(await user(c, 'worker'), 'active', [
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(W2, 1)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(W2, 2)],
        ['profile.voice_choice', 'profile.voice_processing', 'profile_voice_ingest_started', h(W2, 3)],
        ['profile.voice_processing', 'profile.voice_choice', 'voice_timeout_retry_offered', h(W2, 4)],
        ['profile.voice_choice', 'profile.name', 'profile_voice_skipped', h(W2, 5)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(W2, 6)],
        ['profile.location', 'profile.trade', 'profile_location_recorded', h(W2, 7)],
        ['profile.trade', 'profile.location', 'worker_back', h(W2, 8)],
        ['profile.location', 'profile.trade', 'profile_location_recorded', h(W2, 9)],
        ['profile.trade', 'profile.location', 'worker_back', h(W1, 3)],
        ['profile.location', 'profile.name', 'worker_back', h(W1, 4)],
        ['profile.name', 'profile.name', 'worker_restart', h(W1, 5)],
        ['profile.name', 'profile.location', 'operator_repair: it-2d', h(W1, 6)],
      ]);
      // C: web. Back on the web; a NULL and two unknown steps (left out).
      await run(await user(c, 'worker'), 'active', [
        [null, 'legal.review', 'web_start', h(W1, 1)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(W1, 2)],
        ['profile.voice_choice', 'profile.name', 'profile_voice_skipped', h(W1, 3)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(W1, 4)],
        ['profile.location', 'profile.name', 'worker_back_web', h(W1, 5)],
        ['profile.unknown_step', 'profile.name', 'worker_back_web', h(W1, 6)],
        [null, 'profile.name', 'worker_back_web', h(W1, 7)],
        ['profile.name', 'profile.unknown_target', 'profile_name_recorded', h(W1, 8)],
      ]);
      // D: WhatsApp, but went through the retired web bypass: every move of
      // the worker is out, also those of a later run without the bypass.
      const d = await user(c, 'worker');
      await run(d, 'cancelled', [
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(W1, 1)],
        ['legal.review', 'profile.name', 'web_worker_bypass', h(W1, 2)],
        ['profile.name', 'profile.name', 'worker_restart', h(W1, 3)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(W1, 4)],
      ]);
      await run(d, 'active', [
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(W1, 14)],
        ['profile.location', 'profile.name', 'worker_back', h(W1, 15)],
      ]);
      // E: an adopted run (neither door): counts under 'all' only. Its voice
      // retry loop is the only way it ever "arrives" at voice_choice.
      await run(await user(c, 'worker'), 'active', [
        ['profile.voice_processing', 'profile.voice_choice', 'voice_unclear_retry_offered', h(W1, 0.5)],
        ['legal.review', 'profile.name', 'self_heal_preauth_step', h(W1, 1)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(W1, 2)],
        ['profile.location', 'profile.name', 'worker_back', h(W1, 3)],
      ]);
      // F: both doors -- a cancelled WhatsApp run (W2), then a web run (W1).
      const f = await user(c, 'worker');
      await run(f, 'cancelled', [
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(W2, 10)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(W2, 11)],
      ]);
      await run(f, 'active', [
        [null, 'legal.review', 'web_start', h(W1, 10)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(W1, 11)],
      ]);
      // H: a run with both door transitions (a web worker who later verified
      // on WhatsApp): WhatsApp, as in 113.
      await run(await user(c, 'worker'), 'active', [
        [null, 'legal.review', 'web_start', h(W1, 12)],
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(W1, 13)],
      ]);
      // G: verified and reached the first trust question before a 4-week
      // window (still WhatsApp), then started over from location and from
      // that trust question inside it: one worker pressing at two steps.
      const g1 = plus(W3, -2 * DAY);
      weekG = isoWeekStart(g1);
      await run(await user(c, 'worker'), 'active', [
        ['identity.verify_otp', 'legal.review', 'otp_verified', g1],
        ['profile.availability', 'trust.question.1', 'profile_availability_recorded', plus(W3, -DAY)],
        ['profile.location', 'profile.name', 'worker_restart', h(W2, 12)],
        ['trust.question.1', 'profile.name', 'worker_restart', h(W2, 13)],
      ]);
    });

    // ── Operator resets (worker ids need not exist: no foreign key).
    await seed(async (c) => {
      const reset = async (reason: string, at: Date, o: { user?: string; dry?: boolean } = {}): Promise<string> => {
        const userId = o.user ?? randomUUID();
        await c.query(
          `INSERT INTO worker_reset_audit (user_id, phone_hash, operator, reason, table_counts, dry_run, created_at)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6)`,
          [userId, randomBytes(32).toString('hex'), OPERATOR, reason, o.dry ?? false, at],
        );
        return userId;
      };
      const many = async (reason: string, start: Date, n: number, stepMs: number, o: { dry?: boolean } = {}): Promise<string[]> => {
        const out: string[] = [];
        for (let i = 0; i < n; i += 1) out.push(await reset(reason, plus(start, i * stepMs), o));
        return out;
      };
      // W2: 9 workers in 40 min (not bulk); 10 in 45 min (bulk); 10 spread
      // over 2 hours, at most 5 in any hour (not bulk); one worker reset 10
      // times in 45 min (1 distinct: not bulk); a masked ticket number, also
      // given to the last of the nine and the last of the ten inside their
      // own hour (a worker's earlier reset under another reason is no repeat:
      // the ten stay one bulk run, the nine stay 9).
      const nineWorkers = await many('it-2d nine workers', plus(W2, HOUR), 9, 5 * MIN);
      const tenWorkers = await many('it-2d ten workers', plus(W2, 3 * HOUR), 10, 5 * MIN);
      await many('it-2d spread', plus(W2, 6 * HOUR), 10, 13 * MIN + 20_000);
      const same = randomUUID();
      for (let i = 0; i < 10; i += 1) await reset('it-2d same worker', plus(W2, 10 * HOUR + i * 5 * MIN), { user: same });
      await reset('it-2d ticket 77777 and 987 and 2024-10-01', plus(W2, 12 * HOUR));
      await reset('it-2d ticket 77777 and 987 and 2024-10-01', plus(W2, HOUR + 20 * MIN), { user: nineWorkers[8] });
      await reset('it-2d ticket 77777 and 987 and 2024-10-01', plus(W2, 3 * HOUR + 20 * MIN), { user: tenWorkers[9] });
      // W1: 9 workers plus a second reset of the first one (10 rows, 9
      // distinct: not bulk); two raw reasons that mask alike (one row); a
      // phone number, a ticket number and a version that is not masked; the
      // 80-character cut (after masking); trimming; blank reasons; 9 real
      // resets and a dry run (not bulk, dry run not counted); 10 dry runs
      // (nothing).
      const nine = await many('it-2d nine plus repeat', plus(W1, HOUR), 9, 5 * MIN);
      await reset('it-2d nine plus repeat', plus(W1, HOUR + 45 * MIN), { user: nine[0] });
      await reset('it-2d ticket 12345 and 987 and 2024-10-01', plus(W1, 2 * HOUR));
      await reset('it-2d ticket 55555 and 987 and 2024-10-01', plus(W1, 2 * HOUR + 10 * MIN));
      await reset('it-2d +1 (555) 123-4567 retest', plus(W1, 2 * HOUR + 20 * MIN));
      await reset('it-2d ticket 12345', plus(W1, 2 * HOUR + 30 * MIN));
      await reset('it-2d onboarding v2 gate', plus(W1, 2 * HOUR + 40 * MIN));
      // More free text the mask hides: an email address, a user UUID, and phone
      // numbers written with slashes or underscores (the three mask like the
      // phone above: one row).
      await reset('it-2d reset ana.perez@example.com', plus(W1, 2 * HOUR + 50 * MIN));
      await reset('it-2d user 3f2b8c1e-9a7d-4e21-b6c3-0d9e8f7a6b5c', plus(W1, 2 * HOUR + 55 * MIN));
      await reset('it-2d 555/123/4567 retest', plus(W1, 3 * HOUR + 40 * MIN));
      await reset('it-2d 555_123_4567 retest', plus(W1, 3 * HOUR + 50 * MIN));
      await reset(`it-2d long ${'x'.repeat(80)}`, plus(W1, 3 * HOUR));
      await reset(`it-2d cut ${'y'.repeat(68)}123456`, plus(W1, 3 * HOUR + 10 * MIN));
      await reset('  it-2d padded  ', plus(W1, 3 * HOUR + 20 * MIN));
      // Its 80th character is a space: the cut never ends in one.
      await reset(`it-2d space ${'z'.repeat(67)} tail`, plus(W1, 3 * HOUR + 30 * MIN));
      await reset('', plus(W1, 4 * HOUR));
      await reset('   ', plus(W1, 4 * HOUR + 10 * MIN));
      await many('it-2d nine plus dry', plus(W1, 5 * HOUR), 9, 5 * MIN);
      await reset('it-2d nine plus dry', plus(W1, 5 * HOUR + 45 * MIN), { dry: true });
      await many('it-2d dry run', plus(W1, 7 * HOUR), 10, 3 * MIN, { dry: true });
      // W1 runs of one reason: 10 workers in 27 min; 10 more starting 50 min
      // after (one run of 20); 10 more 3 hours later plus a straggler 50 min
      // after that burst began (a second run of 11); a lone reset 5 hours
      // later (not bulk).
      await many('it-2d cutover 20241001', plus(W1, 10 * HOUR), 10, 3 * MIN);
      await many('it-2d cutover 20241001', plus(W1, 11 * HOUR + 17 * MIN), 10, 3 * MIN);
      await many('it-2d cutover 20241001', plus(W1, 15 * HOUR), 10, 3 * MIN);
      await reset('it-2d cutover 20241001', plus(W1, 15 * HOUR + 50 * MIN));
      await reset('it-2d cutover 20241001', plus(W1, 20 * HOUR));
      // The boundaries, exactly: 10 workers whose first and last resets are
      // exactly an hour apart (one bulk run of 10: the span is closed); two
      // bursts of 10, the second starting exactly an hour after the first
      // burst's last reset (two runs: a gap of an hour starts a new one).
      await many('it-2d exact hour', plus(W1, 21 * HOUR), 10, 6 * MIN + 40_000);
      await many('it-2d exact gap', plus(W1, 30 * HOUR), 10, 3 * MIN);
      await many('it-2d exact gap', plus(W1, 30 * HOUR + 27 * MIN + HOUR), 10, 3 * MIN);
      // The repeats join's p.prev_at >= st.created_at: worker X reset at t and
      // t + 50 min, nine others at t + 40 .. t + 80 min, one reason. The span
      // from the first of the nine holds ten distinct workers (X's second
      // reset and the nine; X's first reset is before it): one bulk run of 10.
      // X's first reset starts no bulk span and belongs to no run. Without the
      // condition X's second reset counts as a repeat inside that span (its
      // earlier reset is before the span), 9 distinct, and nothing is bulk.
      const repeatX = randomUUID();
      await reset('it-2d repeat edge', plus(W1, 35 * HOUR), { user: repeatX });
      await reset('it-2d repeat edge', plus(W1, 35 * HOUR + 50 * MIN), { user: repeatX });
      await many('it-2d repeat edge', plus(W1, 35 * HOUR + 40 * MIN), 9, 5 * MIN);
      // A bulk run across the 4-week window's start: 6 workers before W3, 6
      // after (12 within 40 min). An old reset before the window.
      await many('it-2d straddle', plus(W3, -20 * MIN), 6, 3 * MIN);
      await many('it-2d straddle', plus(W3, 5 * MIN), 6, 3 * MIN);
      await reset('it-2d old', plus(W3, -2 * DAY));
    });

    // ── Digest. Employers E1-E9 (E7 and E8 are test accounts), a worker
    // with a settings row, and E10, deleted after its email was queued.
    await seed(async (c) => {
      const employer = async (name: string, email: string | null, enabled: boolean | null, sub?: string): Promise<string> => {
        const id = await user(c, 'employer', { email, sub });
        if (enabled !== null) {
          await c.query(`INSERT INTO employer_digest_settings (employer_id, enabled) VALUES ($1, $2)`, [id, enabled]);
        }
        employers[name] = id;
        return id;
      };
      await employer('E1', 'e1@it2d.example', true);
      await employer('E2', null, true);
      await employer('E3', '@it2d.example', true);
      await employer('E4', 'a@', true);
      await employer('E5', 'e5@it2d.example', false);
      await employer('E6', 'e6@it2d.example', null);
      await employer('E7', 'tester@jale.test', true);
      await employer('E8', 'e8@it2d.example', true, `seed-${OPERATOR}-${randomBytes(6).toString('hex')}`);
      await employer('E9', `${'a'.repeat(308)}@it2d.example`, true); // 321 characters
      await employer('E10', 'e10@it2d.example', true);
      const worker = await user(c, 'worker', { email: 'w@it2d.example' });
      employers.W = worker;
      await c.query(`INSERT INTO employer_digest_settings (employer_id, enabled) VALUES ($1, true)`, [worker]);

      const email = async (source: string, at: Date, status: string, attempts: number, type = 'employer_digest'): Promise<void> => {
        await c.query(
          `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id, status, attempt_count, created_at, sent_at)
           VALUES ('it2d@example.test', $1, $1, $2, $3, $4, $5, $6, $7)`,
          [MARK, type, source, status, attempts, at, status === 'sent' ? at : null],
        );
      };
      const e = employers;
      // W2: E1 sent twice, failed at 5 and at 7 attempts; E5 sent.
      await email(e.E1, plus(W2, HOUR), 'sent', 1);
      await email(e.E1, plus(W2, DAY), 'sent', 1);
      await email(e.E1, plus(W2, 2 * DAY), 'failed', 5);
      await email(e.E1, plus(W2, 3 * DAY), 'failed', 7);
      await email(e.E5, plus(W2, 4 * DAY), 'sent', 2);
      // W1: E1 failed at 2 (retrying), pending, send_unknown, sent; E2 sent;
      // E6 failed at 4 (retrying).
      await email(e.E1, plus(W1, HOUR), 'failed', 2);
      await email(e.E1, plus(W1, 2 * HOUR), 'pending', 0);
      await email(e.E1, plus(W1, 3 * HOUR), 'send_unknown', 1);
      await email(e.E1, plus(W1, 4 * HOUR), 'sent', 1);
      await email(e.E2, plus(W1, 5 * HOUR), 'sent', 1);
      await email(e.E6, plus(W1, 6 * HOUR), 'failed', 4);
      // Left out: test employers, a worker, billing mail, a deleted employer,
      // a missing one; and (4 weeks only) an older email.
      await email(e.E7, plus(W1, 7 * HOUR), 'sent', 1);
      await email(e.E8, plus(W1, 8 * HOUR), 'sent', 1);
      await email(e.W, plus(W1, 9 * HOUR), 'sent', 1);
      await email(e.E1, plus(W1, 10 * HOUR), 'sent', 1, 'billing_pause');
      await email(e.E10, plus(W2, 5 * DAY), 'sent', 1);
      await email(randomUUID(), plus(W1, 11 * HOUR), 'sent', 1);
      await email(e.E1, plus(W3, -DAY), 'sent', 1);
    });
    // Outside replica mode, so the delete cascades to E10's settings row.
    await withClient(superUrl, (c) => c.query('DELETE FROM users WHERE id = $1', [employers.E10]));
  }, 480_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await withClient(superUrl, async (su) => {
      // Cases cascade their events; outbox rows by marker.
      await su.query('DELETE FROM admin_cases WHERE id = ANY($1::uuid[])', [caseIds]);
      await su.query('DELETE FROM whatsapp_outbox WHERE body = $1', [MARK]);
      await su.query('DELETE FROM email_outbox WHERE subject = $1', [MARK]);
      await su.query('DELETE FROM worker_reset_audit WHERE operator = $1', [OPERATOR]);
      // Users cascade runs, transitions and digest settings.
      await su.query(`DELETE FROM users WHERE cognito_sub LIKE $1 OR cognito_sub LIKE $2`,
        [`${OPERATOR}-%`, `seed-${OPERATOR}-%`]);
    });
  }, 60_000);

  // ── Case status timing ──────────────────────────────────────

  it('stamps a real status change and records it once, as admin from the console and system otherwise', async () => {
    const c1 = await newCase('open', new Date(T - 3 * DAY), new Date(T - 3 * DAY));
    const c2 = await newCase('open', new Date(T - 2 * DAY), new Date(T - 2 * DAY));

    // The console's request_more_info mutation (admin-action-dispatch.ts), verbatim.
    const moved = await withClient(consoleUrl, async (c) => {
      await c.query('BEGIN');
      const r = (await c.query(
        `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1 AND status NOT IN ('resolved', 'dismissed')
         RETURNING status_changed_at, now() AS tx_now`,
        [c1, 'pending_worker', JSON.stringify({ lastAdminNote: MARK })])).rows[0];
      await c.query('COMMIT');
      return r;
    });
    expect(iso(moved.status_changed_at)).toBe(iso(moved.tx_now));
    expect(await statusEvents(c1)).toEqual([{
      event_type: 'status_changed',
      actor_type: 'admin',
      actor_id: null,
      payload: { title: 'Status changed', detail: 'Open → Pending worker', from: 'open', to: 'pending_worker' },
      created_at: moved.tx_now,
    }]);

    // The console's reply_whatsapp status update on a case already waiting
    // on the worker, and an update that does not name status: no stamp, no event.
    await withClient(consoleUrl, async (c) => {
      await c.query(
        `UPDATE admin_cases
            SET status = 'pending_worker',
                details = details || $2::jsonb,
                updated_at = NOW()
          WHERE id = $1
            AND status NOT IN ('resolved', 'dismissed')`,
        [c1, JSON.stringify({ lastAdminNote: MARK })]);
      await c.query('UPDATE admin_cases SET priority = 80 WHERE id = $1', [c1]);
    });
    expect(iso((await caseRow(c1)).status_changed_at)).toBe(iso(moved.status_changed_at));
    expect(await statusEvents(c1)).toHaveLength(1);

    // A bastion edit, logged in as jale_admin: actor system.
    const resolved = await withClient(adminUrl, async (c) => (await c.query(
      `UPDATE public.admin_cases SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1
       RETURNING status_changed_at, now() AS tx_now`, [c1])).rows[0]);
    expect(iso(resolved.status_changed_at)).toBe(iso(resolved.tx_now));
    const c1Events = await statusEvents(c1);
    expect(c1Events.map((e) => [e.actor_type, (e.payload as Row).detail])).toEqual([
      ['admin', 'Open → Pending worker'],
      ['system', 'Pending worker → Resolved'],
    ]);
    expect(c1Events[1]).toMatchObject({
      actor_id: null,
      payload: { title: 'Status changed', from: 'pending_worker', to: 'resolved' },
      created_at: resolved.tx_now,
    });

    // The other two labels: Pending admin (console), Dismissed (a superuser
    // session, so not the console: system).
    await withClient(consoleUrl, (c) => c.query(`UPDATE admin_cases SET status = 'pending_admin' WHERE id = $1`, [c2]));
    await withClient(superUrl, (c) => c.query(`UPDATE admin_cases SET status = 'dismissed', resolved_at = now() WHERE id = $1`, [c2]));
    expect((await statusEvents(c2)).map((e) => [e.actor_type, e.payload])).toEqual([
      ['admin', { title: 'Status changed', detail: 'Open → Pending admin', from: 'open', to: 'pending_admin' }],
      ['system', { title: 'Status changed', detail: 'Pending admin → Dismissed', from: 'pending_admin', to: 'dismissed' }],
    ]);

    // A new case starts in its status at its insert time.
    const created = await withClient(consoleUrl, async (c) => (await c.query(
      `INSERT INTO admin_cases (case_type, status, priority, summary) VALUES ('help_request', 'open', 70, $1)
       RETURNING id, created_at, status_changed_at`, [MARK])).rows[0]);
    caseIds.push(created.id as string);
    expect(iso(created.status_changed_at)).toBe(iso(created.created_at));
  });

  it('leaves the status time alone when a Twilio callback updates a case', async () => {
    const c3 = await newCase('pending_worker', new Date(T - 5 * DAY), new Date(T - 4 * DAY));
    const outboxId = randomUUID();
    await withClient(superUrl, (c) => c.query(
      `INSERT INTO whatsapp_outbox (id, sequence, whatsapp_number, body, status, attempt_count, created_at, sent_at, source_type, source_id)
       VALUES ($1, 1, '+15550002000', $2, 'sent', 1, now(), now(), 'admin_case', $3)`, [outboxId, MARK, c3]));
    const sid = `SM${randomBytes(16).toString('hex')}`;
    const beforeRow = await caseRow(c3);
    // The callback path as production runs it: jale_whatsapp calls 040's
    // wrapper, which writes as jale_twilio_callback (details, updated_at).
    await withClient(whatsappUrl, (c) => c.query(
      `SELECT public.record_admin_whatsapp_delivery($1::uuid, 'sent', $2, NULL)`, [outboxId, sid]));
    const afterRow = await caseRow(c3);
    expect((afterRow.details as Row).lastOutboundTwilioSid).toBe(sid);
    expect(iso(afterRow.updated_at)).not.toBe(iso(beforeRow.updated_at));
    expect(afterRow.status).toBe('pending_worker');
    expect(iso(afterRow.status_changed_at)).toBe(new Date(T - 4 * DAY).toISOString());
    expect(await statusEvents(c3)).toEqual([]);
    expect(await rowsOf(superUrl, `SELECT event_type FROM admin_case_events WHERE case_id = $1`, [c3]))
      .toEqual([{ event_type: 'admin_reply_sent' }]);
  });

  it('rolls a status change back when its timeline event cannot be written', async () => {
    const c4 = await newCase('open', new Date(T - DAY), new Date(T - DAY));
    const after = await withClient(superUrl, async (su) => {
      await su.query('BEGIN');
      try {
        await su.query(`ALTER TABLE admin_case_events ADD CONSTRAINT it_2d_no_status_events CHECK (event_type <> 'status_changed') NOT VALID`);
        await su.query('SET LOCAL ROLE jale_admin_console');
        await su.query('SAVEPOINT s');
        await expect(su.query(`UPDATE admin_cases SET status = 'pending_worker' WHERE id = $1`, [c4]))
          .rejects.toThrow(/it_2d_no_status_events/);
        await su.query('ROLLBACK TO SAVEPOINT s');
        return (await su.query('SELECT status, status_changed_at FROM admin_cases WHERE id = $1', [c4])).rows[0];
      } finally {
        await su.query('ROLLBACK');
      }
    });
    expect(after).toEqual({ status: 'open', status_changed_at: new Date(T - DAY) });
    expect(await statusEvents(c4)).toEqual([]);
  });

  it('backfills each status from the evidence it has, never before the case was opened', async () => {
    const backfill = migrationSql.match(/\n-- BEGIN status_changed_at backfill\n([\s\S]*?)-- END status_changed_at backfill\n/)?.[1] ?? '';
    // One statement, exactly what the migration ran.
    expect(backfill.startsWith('UPDATE public.admin_cases c\n')).toBe(true);
    expect(backfill.trim().split(';').filter((s) => s.trim() !== '')).toHaveLength(1);

    const at = (days: number): Date => new Date(T - days * DAY);
    const got = await withClient(superUrl, async (su) => {
      await su.query('BEGIN');
      try {
        const ids: Record<string, string> = {};
        const add = async (name: string, status: string, created: Date, resolvedAt: Date | null = null): Promise<void> => {
          ids[name] = (await su.query(
            `INSERT INTO admin_cases (case_type, status, summary, created_at, updated_at, resolved_at)
             VALUES ('help_request', $1, $2, $3, $3, $4) RETURNING id`, [status, MARK, created, resolvedAt])).rows[0].id;
        };
        const audit = async (targetType: string, targetId: string, action: string, when: Date): Promise<void> => {
          await su.query(
            `INSERT INTO admin_audit_log (actor_role, action, target_type, target_id, created_at)
             VALUES ('admin_ops', $1, $2, $3, $4)`, [action, targetType, targetId, when]);
        };
        await add('open', 'open', at(10));
        await add('pendingAdmin', 'pending_admin', at(9));
        await add('resolved', 'resolved', at(8), at(2));
        await add('dismissed', 'dismissed', at(8), at(3));
        await add('dismissedNoTime', 'dismissed', at(8));
        await add('resolvedEarly', 'resolved', at(8), at(9));
        await add('resolvedWithInfo', 'resolved', at(8), at(1));
        await add('worker', 'pending_worker', at(7));
        await add('verification', 'pending_worker', at(7));
        await add('workerNoAudit', 'pending_worker', at(7));
        await add('workerEarlyAudit', 'pending_worker', at(7));
        await add('workerOtherCase', 'pending_worker', at(7));
        // The earliest move to pending_worker wins; other actions, other
        // target types and other cases do not count.
        await audit('admin_case', ids.worker, 'reply_whatsapp', at(5));
        await audit('admin_case', ids.worker, 'request_more_info', at(6));
        await audit('admin_case', ids.worker, 'reveal_pii', at(6.5));
        await audit('verification', ids.verification, 'reset_verification_step', at(4));
        await audit('verification', ids.verification, 'approve_verification', at(6));
        await audit('worker', ids.verification, 'request_more_info', at(6.5));
        await audit('admin_case', ids.workerEarlyAudit, 'request_more_info', at(8));
        await audit('admin_case', randomUUID(), 'request_more_info', at(6));
        await audit('admin_case', ids.workerOtherCase.toUpperCase(), 'request_more_info', at(6));
        await audit('admin_case', ids.resolvedWithInfo, 'request_more_info', at(5));

        // As the migration runs it: jale_admin, under FORCE RLS.
        await su.query('SET LOCAL ROLE jale_admin');
        await su.query(backfill);
        await su.query('RESET ROLE');
        const out: Record<string, string | null> = {};
        for (const [name, id] of Object.entries(ids)) {
          out[name] = iso((await su.query('SELECT status_changed_at FROM admin_cases WHERE id = $1', [id])).rows[0].status_changed_at);
        }
        // The backfill names status_changed_at only: no status trigger fired.
        out.events = String((await su.query(
          `SELECT count(*) AS n FROM admin_case_events WHERE case_id = ANY($1::uuid[])`, [Object.values(ids)])).rows[0].n);
        return out;
      } finally {
        await su.query('ROLLBACK');
      }
    });
    const d = (days: number): string => at(days).toISOString();
    expect(got).toEqual({
      open: d(10),
      pendingAdmin: d(9),
      resolved: d(2),
      dismissed: d(3),
      dismissedNoTime: d(8),
      resolvedEarly: d(8),
      resolvedWithInfo: d(1),
      worker: d(6),
      verification: d(4),
      workerNoAudit: d(7),
      workerEarlyAudit: d(7),
      workerOtherCase: d(7),
      events: '0',
    });
  });

  // ── The console's case SQL ──────────────────────────────────
  //
  // The queue order, Home's bucket query and the timeline order, run exactly
  // as the console runs them (consoleCaseSql reads admin-cases.ts), as
  // jale_admin_console. admin/scripts pins their text; these run it, so a later
  // migration that renames or retypes status_changed_at fails here.

  it('orders the case queue: waiting on us, then on the worker, then closed; priority, then the longest wait', async () => {
    const sql = consoleCaseSql();
    const t = await dbNow(superUrl);
    const ago = (ms: number): Date => new Date(t - ms);
    const created = ago(40 * DAY);
    // Two cases tied on everything but id, inserted in descending id order.
    const [tieLow, tieHigh] = [randomUUID(), randomUUID()].sort();
    const tieAt = ago(3 * DAY);
    const ids: Record<string, string> = {};
    ids.tieHigh = await newCase('open', created, tieAt, { priority: 90, id: tieHigh });
    ids.tieLow = await newCase('open', created, tieAt, { priority: 90, id: tieLow });
    ids.usLoOld = await newCase('open', created, ago(9 * DAY), { priority: 40 });
    ids.workerHiNew = await newCase('pending_worker', created, ago(2 * HOUR), { priority: 95 });
    ids.closedOld = await newCase('resolved', created, ago(2 * DAY), { priority: 99 });
    ids.usHiNew = await newCase('open', created, ago(DAY), { priority: 90 });
    ids.workerLoOld = await newCase('pending_worker', created, ago(30 * DAY), { priority: 10 });
    ids.closedNew = await newCase('dismissed', created, ago(DAY), { priority: 1 });
    ids.usHiOld = await newCase('pending_admin', created, ago(5 * DAY), { priority: 90 });
    ids.workerHiOld = await newCase('pending_worker', created, ago(3 * DAY), { priority: 95 });
    const byId = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    const mine = (rows: Row[]): string[] => rows.filter((r) => byId.has(r.id as string)).map((r) => byId.get(r.id as string) as string);

    const rows = await rowsOf(consoleUrl, sql.list, [100_000]);
    expect(mine(rows)).toEqual([
      // Waiting on us: priority first (the 40 is last although it waited longest), then the longest wait, then id.
      'usHiOld', 'tieLow', 'tieHigh', 'usHiNew', 'usLoOld',
      // Waiting on the worker, after every case waiting on us whatever its priority.
      'workerHiOld', 'workerHiNew', 'workerLoOld',
      // Closed, most recently closed first whatever the priority.
      'closedNew', 'closedOld',
    ]);
    // The row carries the column the console maps, as a timestamp.
    const sample = rows.find((r) => r.id === ids.usHiOld) as Row;
    expect(new Date(sample.status_changed_at as Date).toISOString()).toBe(ago(5 * DAY).toISOString());
    // The Home preview: the same order, open cases only.
    expect(mine(await rowsOf(consoleUrl, sql.openList, [100_000])))
      .toEqual(mine(rows).filter((name) => !name.startsWith('closed')));
  });

  it('buckets open cases by who they wait on and the time in their status, at every edge', async () => {
    const sql = consoleCaseSql();
    const read = async (): Promise<Map<string, number>> =>
      new Map((await rowsOf(consoleUrl, sql.buckets)).map((r) => [`${r.waiting_on}|${r.bucket}`, Number(r.count)]));
    const baseline = await read();
    const t = await dbNow(superUrl);
    const waited = (hours: number): Date => new Date(t - hours * HOUR);
    // Hours in the status, two either side of each edge (24, 72 and 168 hours):
    // under a day (-2 is a status change ahead of the clock, which falls in the
    // first bucket), 1-3 days, 3-7 days, over 7 days (the last: the longest of
    // all). Each time is held by a case waiting on us twice (open,
    // pending_admin) and on the worker once.
    const hoursInStatus = [-2, 22, 26, 70, 74, 166, 170, 40 * 24];
    const created = new Date(t - 60 * DAY);
    for (const hours of hoursInStatus) {
      await newCase('open', created, waited(hours));
      await newCase('pending_admin', created, waited(hours));
      await newCase('pending_worker', created, waited(hours));
    }
    // Closed cases are no one's wait.
    await newCase('resolved', created, waited(1));
    await newCase('dismissed', created, waited(40 * 24));

    const after = await read();
    const got: Record<string, number> = {};
    for (const key of new Set([...after.keys(), ...baseline.keys()])) {
      got[key] = (after.get(key) ?? 0) - (baseline.get(key) ?? 0);
    }
    expect(got).toEqual({
      'us|under_1d': 4, 'us|days_1_3': 4, 'us|days_3_7': 4, 'us|over_7d': 4,
      'worker|under_1d': 2, 'worker|days_1_3': 2, 'worker|days_3_7': 2, 'worker|over_7d': 2,
    });
  });

  it('lists a status change above the reply that caused it in the case timeline', async () => {
    const sql = consoleCaseSql();
    // Ten cases, so an order that only works by the luck of random ids is caught.
    const cases: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = await newCase('open', new Date(T - 2 * DAY), new Date(T - 2 * DAY));
      cases.push(id);
      await withClient(superUrl, (c) => c.query(
        `INSERT INTO admin_case_events (case_id, event_type, actor_type, payload, created_at)
         VALUES ($1, 'case_opened', 'system', '{}'::jsonb, $2)`, [id, new Date(T - 2 * DAY)]));
      // The console's reply_whatsapp: the queued-reply event, then the status
      // change (the trigger writes its event at the same transaction time).
      await withClient(consoleUrl, async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
           VALUES ($1, 'admin_reply_queued', 'admin', 'it-2d', '{"title":"WhatsApp reply queued"}'::jsonb)`, [id]);
        await c.query(`UPDATE admin_cases SET status = 'pending_worker', updated_at = NOW() WHERE id = $1`, [id]);
        await c.query('COMMIT');
      });
    }
    const rows = await rowsOf(consoleUrl, sql.timeline, [cases]);
    for (const id of cases) {
      const events = rows.filter((r) => r.case_id === id);
      // Newest first; the two events of the transaction share their time.
      expect(events.map((e) => e.event_type)).toEqual(['status_changed', 'admin_reply_queued', 'case_opened']);
      expect(iso(events[0].created_at)).toBe(iso(events[1].created_at));
    }
  });

  // ── Start over and back ─────────────────────────────────────

  /**
   * The fixtures' contribution, written out per (week, door, step); 'all-steps'
   * is the step_key NULL row. Reached = arrived at the step or pressed from it.
   */
  function expectedRestarts(weeks: 4 | 12): Map<string, Counts<(typeof RESTART)[number]>> {
    const m = new Map<string, Counts<(typeof RESTART)[number]>>();
    const put = (week: string, doors: string[], step: string, c: Partial<Counts<(typeof RESTART)[number]>>): void => {
      for (const door of doors) m.set(`${week}|${door}|${step}`, { ...zeros(RESTART), ...c });
    };
    const w2 = W2.toISOString();
    const w1 = W1.toISOString();
    const both = ['all', 'whatsapp'];
    // W2: WhatsApp only (A, B, F's first run, G). G is reached at location
    // and at the trust question by pressing there: it arrived before the window.
    put(w2, both, 'all-steps', { reached: 4, restart_workers: 2, restart_presses: 4, back_workers: 2, back_presses: 2 });
    put(w2, both, 'legal.review', { reached: 3 });
    put(w2, both, 'profile.voice_choice', { reached: 3 });
    put(w2, both, 'profile.voice_processing', { reached: 1 });
    put(w2, both, 'profile.name', { reached: 2, restart_workers: 1, restart_presses: 1 });
    put(w2, both, 'profile.location', { reached: 3, restart_workers: 2, restart_presses: 2, back_workers: 1, back_presses: 1 });
    put(w2, both, 'profile.trade', { reached: 1, back_workers: 1, back_presses: 1 });
    put(w2, both, 'trust.question.1', { reached: 1, restart_workers: 1, restart_presses: 1 });
    // W1: A, B and H on WhatsApp (D left out), C and F's second run on the
    // web, E (no door) under 'all' only.
    put(w1, ['whatsapp'], 'all-steps', { reached: 3, restart_workers: 2, restart_presses: 2, back_workers: 1, back_presses: 2 });
    put(w1, ['whatsapp'], 'legal.review', { reached: 1 });
    put(w1, ['whatsapp'], 'profile.name', { reached: 2, restart_workers: 2, restart_presses: 2 });
    put(w1, ['whatsapp'], 'profile.location', { reached: 2, back_workers: 1, back_presses: 1 });
    put(w1, ['whatsapp'], 'profile.trade', { reached: 1, back_workers: 1, back_presses: 1 });
    put(w1, ['web'], 'all-steps', { reached: 2, back_workers: 1, back_presses: 1 });
    put(w1, ['web'], 'legal.review', { reached: 2 });
    put(w1, ['web'], 'profile.voice_choice', { reached: 2 });
    put(w1, ['web'], 'profile.name', { reached: 1 });
    put(w1, ['web'], 'profile.location', { reached: 1, back_workers: 1, back_presses: 1 });
    put(w1, ['all'], 'all-steps', { reached: 6, restart_workers: 2, restart_presses: 2, back_workers: 3, back_presses: 4 });
    put(w1, ['all'], 'legal.review', { reached: 3 });
    put(w1, ['all'], 'profile.voice_choice', { reached: 2 });
    put(w1, ['all'], 'profile.name', { reached: 4, restart_workers: 2, restart_presses: 2 });
    put(w1, ['all'], 'profile.location', { reached: 4, back_workers: 3, back_presses: 3 });
    put(w1, ['all'], 'profile.trade', { reached: 1, back_workers: 1, back_presses: 1 });
    // The window: workers distinct across weeks, under 'all' across doors (F
    // once), and in the all-steps rows across steps (G once).
    put('window', ['whatsapp'], 'all-steps', { reached: 5, restart_workers: 3, restart_presses: 6, back_workers: 2, back_presses: 4 });
    put('window', ['whatsapp'], 'legal.review', { reached: weeks === 12 ? 5 : 4 });
    put('window', ['whatsapp'], 'profile.voice_choice', { reached: 3 });
    put('window', ['whatsapp'], 'profile.voice_processing', { reached: 1 });
    put('window', ['whatsapp'], 'profile.name', { reached: 2, restart_workers: 2, restart_presses: 3 });
    put('window', ['whatsapp'], 'profile.location', { reached: 3, restart_workers: 2, restart_presses: 2, back_workers: 2, back_presses: 2 });
    put('window', ['whatsapp'], 'profile.trade', { reached: 1, back_workers: 1, back_presses: 2 });
    put('window', ['whatsapp'], 'trust.question.1', { reached: 1, restart_workers: 1, restart_presses: 1 });
    put('window', ['web'], 'all-steps', { reached: 2, back_workers: 1, back_presses: 1 });
    put('window', ['web'], 'legal.review', { reached: 2 });
    put('window', ['web'], 'profile.voice_choice', { reached: 2 });
    put('window', ['web'], 'profile.name', { reached: 1 });
    put('window', ['web'], 'profile.location', { reached: 1, back_workers: 1, back_presses: 1 });
    put('window', ['all'], 'all-steps', { reached: 7, restart_workers: 3, restart_presses: 6, back_workers: 4, back_presses: 6 });
    put('window', ['all'], 'legal.review', { reached: weeks === 12 ? 6 : 5 });
    put('window', ['all'], 'profile.voice_choice', { reached: 4 });
    put('window', ['all'], 'profile.voice_processing', { reached: 1 });
    put('window', ['all'], 'profile.name', { reached: 4, restart_workers: 2, restart_presses: 3 });
    put('window', ['all'], 'profile.location', { reached: 5, restart_workers: 2, restart_presses: 2, back_workers: 4, back_presses: 4 });
    put('window', ['all'], 'profile.trade', { reached: 1, back_workers: 1, back_presses: 2 });
    put('window', ['all'], 'trust.question.1', { reached: 1, restart_workers: 1, restart_presses: 1 });
    // 12 weeks also hold G's verification and its arrival at the trust
    // question, three weeks and a day or two back (G is already in every
    // window total).
    if (weeks === 12) {
      put(weekG, both, 'all-steps', { reached: 1 });
      put(weekG, both, 'legal.review', { reached: 1 });
      put(weekG, both, 'trust.question.1', { reached: 1 });
    }
    return m;
  }

  it('counts reached, started over and went back per week, door and step, and over the window', async () => {
    for (const weeks of [4, 12] as const) {
      const rows = await call.restarts(consoleUrl, weeks);
      const got = delta(keyed(rows, restartKey, RESTART), keyed(weeks === 4 ? before.restarts : before.restarts12, restartKey, RESTART), RESTART);
      expectDeltas(got, expectedRestarts(weeks), RESTART);
    }
  });

  it('counts a worker once in the all-steps rows, and never more pressers than workers reached', async () => {
    const rows = await call.restarts(consoleUrl);
    const got = delta(keyed(rows, restartKey, RESTART), keyed(before.restarts, restartKey, RESTART), RESTART);
    // W2 on WhatsApp: per-step restart workers add up to 4 (A at
    // profile.name and location, G at location and the trust question);
    // the all-steps row counts A and G once each.
    const w2 = `${W2.toISOString()}|whatsapp|`;
    const perStep = [...got].filter(([k]) => k.startsWith(w2) && !k.endsWith('|all-steps'))
      .reduce((n, [, c]) => n + c.restart_workers, 0);
    expect([perStep, got.get(`${w2}all-steps`)?.restart_workers]).toEqual([4, 2]);
    // G reached the trust question before the window and started over from
    // it inside: reached there, so the share is 1 of 1, not 1 of 0.
    expect(got.get(`${w2}trust.question.1`)).toEqual({ ...zeros(RESTART), reached: 1, restart_workers: 1, restart_presses: 1 });
    // On every row of the database, workers who pressed are among those reached.
    for (const weeks of [4, 12]) {
      for (const r of await call.restarts(consoleUrl, weeks)) {
        expect({ r, ok: Number(r.restart_workers) <= Number(r.reached) && Number(r.back_workers) <= Number(r.reached) })
          .toEqual({ r, ok: true });
      }
    }
  });

  it('returns the three doors and the 17 steps, all-steps rows first, every row non-zero, in week, door and step order', async () => {
    const rows = await call.restarts(consoleUrl, 12);
    expect(rows.length).toBeGreaterThanOrEqual(expectedRestarts(12).size);
    const rank = (r: Row): number[] => [
      r.week_start === null ? Number.MAX_SAFE_INTEGER : new Date(r.week_start as Date).getTime(),
      DOOR_ORDER.indexOf(r.door as string),
      r.step_key === null ? -1 : STEP_ORDER.indexOf(r.step_key as string),
    ];
    for (const r of rows) {
      expect(DOOR_ORDER).toContain(r.door);
      expect([null, ...STEP_ORDER]).toContain(r.step_key);
      expect(RESTART.some((c) => Number(r[c]) > 0)).toBe(true);
    }
    for (let i = 1; i < rows.length; i += 1) {
      const [a, b] = [rank(rows[i - 1]), rank(rows[i])];
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect({ i, ordered: cmp < 0 }).toEqual({ i, ordered: true });
    }
    // Every (week or window, door) group opens with its all-steps row.
    for (let i = 0; i < rows.length; i += 1) {
      const first = i === 0 || rank(rows[i - 1])[0] !== rank(rows[i])[0] || rows[i - 1].door !== rows[i].door;
      expect({ i, first, allSteps: rows[i].step_key === null }).toEqual({ i, first, allSteps: first });
    }
    // The window rows come after every week row.
    const firstWindow = rows.findIndex((r) => r.week_start === null);
    expect(firstWindow).toBeGreaterThan(0);
    expect(rows.slice(firstWindow).every((r) => r.week_start === null)).toBe(true);
  });

  it('groups by UTC weeks whatever the session TimeZone', async () => {
    // The fixtures sit minutes or hours after Monday 00:00 UTC (and the
    // straddling run minutes before the window's first Monday), so a
    // session-TimeZone week would move them.
    for (const fn of ['admin_analytics_onboarding_restarts', 'admin_analytics_operator_resets', 'admin_analytics_digest_sends']) {
      const rowsIn = async (tz: string): Promise<string[]> => withClient(consoleUrl, async (c) => {
        await c.query(`SET TIME ZONE '${tz}'`);
        return (await c.query(`SELECT * FROM ${fn}(4)`)).rows.map((r) => JSON.stringify(r));
      });
      const utc = await rowsIn('UTC');
      expect({ fn, rows: await rowsIn('Pacific/Auckland') }).toEqual({ fn, rows: utc });
      expect({ fn, rows: await rowsIn('America/Los_Angeles') }).toEqual({ fn, rows: utc });
    }
  });

  // ── Operator resets ─────────────────────────────────────────

  type ResetRow = [week: string, reason: string, workers: number, resets: number, bulk: boolean, started: string | null];
  const resetRows = (rows: Row[]): ResetRow[] => rows.map((r) => [
    iso(r.week_start) as string, r.reason as string, Number(r.workers), Number(r.resets), r.bulk as boolean, iso(r.run_started_at),
  ]);
  const fixtureReason = (r: ResetRow): boolean => r[1].startsWith('it-2d');
  // The date is phone-like (a digit, 5+ digits or dashes, a digit): masked whole.
  const ticket = `it-2d ticket ${MASK} and 987 and ${MASK}`;

  it('groups operator resets by week and masked reason, takes bulk runs out and lists them in order', async () => {
    const w2 = W2.toISOString();
    const w1 = W1.toISOString();
    const at = (d: Date, ms: number): string => plus(d, ms).toISOString();
    const rows = resetRows(await call.resets(consoleUrl));
    expect(rows.filter(fixtureReason)).toEqual([
      // Not bulk: weeks oldest first, then the reason (byte order).
      [w2, 'it-2d nine workers', 9, 9, false, null],
      [w2, 'it-2d same worker', 1, 10, false, null],
      [w2, 'it-2d spread', 10, 10, false, null],
      // The original ticket plus the last of the nine and of the ten.
      [w2, ticket, 3, 3, false, null],
      // Masked, then cut at 80 characters: 76 + two of the four bullets.
      [w1, `it-2d cut ${'y'.repeat(68)}${MASK.slice(0, 2)}`, 1, 1, false, null],
      [w1, `it-2d cutover ${MASK}`, 1, 1, false, null],
      [w1, `it-2d long ${'x'.repeat(69)}`, 1, 1, false, null],
      [w1, 'it-2d nine plus dry', 9, 9, false, null],
      [w1, 'it-2d nine plus repeat', 9, 10, false, null],
      // A version number is no phone number, email or ID: left as typed.
      [w1, 'it-2d onboarding v2 gate', 1, 1, false, null],
      [w1, 'it-2d padded', 1, 1, false, null],
      // X's first reset: the second one is in the bulk run below.
      [w1, 'it-2d repeat edge', 1, 1, false, null],
      // An email address, whole.
      [w1, `it-2d reset ${MASK}`, 1, 1, false, null],
      // Cut at 80, then the trailing space dropped: 79 characters.
      [w1, `it-2d space ${'z'.repeat(67)}`, 1, 1, false, null],
      [w1, `it-2d ticket ${MASK}`, 1, 1, false, null],
      [w1, ticket, 2, 2, false, null],
      // A user UUID, whole.
      [w1, `it-2d user ${MASK}`, 1, 1, false, null],
      // The phone number, whole, however its groups are separated: with
      // spaces and parentheses, slashes or underscores (bullets sort after ASCII).
      [w1, `it-2d ${MASK} retest`, 3, 3, false, null],
      // Bulk runs, by first in-window reset: the one across the window's
      // start counts only its in-window resets, from the first of them.
      [W3.toISOString(), 'it-2d straddle', 6, 6, true, at(W3, 5 * MIN)],
      [w2, 'it-2d ten workers', 10, 10, true, at(W2, 3 * HOUR)],
      [w1, `it-2d cutover ${MASK}`, 20, 20, true, at(W1, 10 * HOUR)],
      [w1, `it-2d cutover ${MASK}`, 11, 11, true, at(W1, 15 * HOUR)],
      // First and last exactly an hour apart: one run of 10.
      [w1, 'it-2d exact hour', 10, 10, true, at(W1, 21 * HOUR)],
      // A gap of exactly an hour: two runs.
      [w1, 'it-2d exact gap', 10, 10, true, at(W1, 30 * HOUR)],
      [w1, 'it-2d exact gap', 10, 10, true, at(W1, 31 * HOUR + 27 * MIN)],
      // Ten distinct workers only because X's earlier reset is before the span.
      [w1, 'it-2d repeat edge', 10, 10, true, at(W1, 35 * HOUR + 40 * MIN)],
    ]);
    // Every reason fits in 80 characters and none ends or starts in a space.
    expect(rows.every((r) => r[1].length <= 80 && !/^ | $/.test(r[1]))).toBe(true);
    // Blank reasons: one '(no reason)' row (a delta: other resets may share it).
    const blank = (rs: ResetRow[]): number[] => {
      const r = rs.find((x) => x[0] === w1 && x[1] === '(no reason)' && !x[4]);
      return [r?.[2] ?? 0, r?.[3] ?? 0];
    };
    const was = blank(resetRows(before.resets));
    const now = blank(rows);
    expect([now[0] - was[0], now[1] - was[1]]).toEqual([2, 2]);
    // Non-bulk rows first, bulk rows by first reset.
    const firstBulk = rows.findIndex((r) => r[4]);
    expect(rows.slice(firstBulk).every((r) => r[4])).toBe(true);
    const starts = rows.slice(firstBulk).map((r) => r[5] as string);
    expect([...starts].sort()).toEqual(starts);
  });

  it('decides bulk over every reset but counts only in-window ones', async () => {
    const before12 = resetRows(before.resets12).filter(fixtureReason);
    expect(before12).toEqual([]);
    const rows = resetRows(await call.resets(consoleUrl, 12)).filter(fixtureReason);
    const weekBefore = new Date(W3.getTime() - 7 * DAY).toISOString();
    // 12 weeks hold the whole straddling run (from its first reset, in the
    // week before W3) and the old reset; the 4-week rows are unchanged.
    expect(rows.filter((r) => r[1] === 'it-2d straddle' || r[1] === 'it-2d old')).toEqual([
      [weekBefore, 'it-2d old', 1, 1, false, null],
      [weekBefore, 'it-2d straddle', 12, 12, true, plus(W3, -20 * MIN).toISOString()],
    ]);
    const four = resetRows(await call.resets(consoleUrl)).filter(fixtureReason);
    expect(rows.filter((r) => r[1] !== 'it-2d straddle' && r[1] !== 'it-2d old'))
      .toEqual(four.filter((r) => r[1] !== 'it-2d straddle'));
    // Dry runs never count, bulk or not.
    expect(rows.some((r) => r[1] === 'it-2d dry run')).toBe(false);
  });

  // ── Applicant digest ────────────────────────────────────────

  it('counts digest adoption among real employers, and only through the new gate', async () => {
    const [b] = before.adoption;
    const [a] = await call.adoption(consoleUrl);
    // E1-E6 and E9 count (E7, E8 are test accounts, W is a worker, E10 is
    // gone); on: E1, E2, E3, E4, E9; with an address the producer sends to: E1.
    expect({
      employers: Number(a.employers) - Number(b.employers),
      digest_on: Number(a.digest_on) - Number(b.digest_on),
      digest_on_with_email: Number(a.digest_on_with_email) - Number(b.digest_on_with_email),
    }).toEqual({ employers: 7, digest_on: 5, digest_on_with_email: 1 });

    // Without the new policy a definer reads no settings row at all (the
    // 088 defect): adoption would read zero.
    const withoutPolicy = await withClient(superUrl, async (su) => {
      await su.query('BEGIN');
      try {
        await su.query('DROP POLICY employer_digest_settings_admin_analytics_read ON employer_digest_settings');
        await su.query('SET LOCAL ROLE jale_admin_console');
        return (await su.query('SELECT * FROM admin_analytics_digest_adoption()')).rows[0];
      } finally {
        await su.query('ROLLBACK');
      }
    });
    expect(withoutPolicy).toEqual({ employers: a.employers, digest_on: '0', digest_on_with_email: '0' });

    // The policy is the gate: jale_admin sees the rows only while the flag is on.
    const ids = Object.values(employers);
    const counts = await withClient(adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        const q = 'SELECT count(*) AS n FROM employer_digest_settings WHERE employer_id = ANY($1::uuid[])';
        const off = (await c.query(q, [ids])).rows[0].n;
        await c.query(`SELECT set_config('app.admin_analytics_read', 'on', true)`);
        const on = (await c.query(q, [ids])).rows[0].n;
        return [off, on];
      } finally {
        await c.query('ROLLBACK');
      }
    });
    // E1-E5, E7, E8, E9 and W have rows (E6 none, E10 deleted).
    expect(counts).toEqual(['0', '9']);
  });

  it('counts digest emails per week by outcome, zero-filled, for real employers only', async () => {
    const weekKey = (r: Row): string => iso(r.week_start) ?? 'window';
    for (const weeks of [4, 12] as const) {
      const rows = await call.sends(consoleUrl, weeks);
      // Every week of the window, oldest first, then the window row.
      const mondays = Array.from({ length: weeks }, (_, i) => new Date(monday.getTime() - (weeks - 1 - i) * 7 * DAY).toISOString());
      expect(rows.map((r) => iso(r.week_start))).toEqual([...mondays, null]);
      const got = delta(keyed(rows, weekKey, SENDS), keyed(weeks === 4 ? before.sends : before.sends12, weekKey, SENDS), SENDS);
      const expected = new Map<string, Counts<(typeof SENDS)[number]>>([
        [W2.toISOString(), { emailed: 5, sent: 3, failed: 2, unknown: 0, in_progress: 0, employers_reached: 2 }],
        [W1.toISOString(), { emailed: 6, sent: 2, failed: 0, unknown: 1, in_progress: 3, employers_reached: 2 }],
        // E1, E5, E2: distinct across the window (4 summed by week).
        ['window', { emailed: 11, sent: 5, failed: 2, unknown: 1, in_progress: 3, employers_reached: 3 }],
      ]);
      if (weeks === 12) {
        // The older email (E1, already reached in the window).
        expected.set(new Date(W3.getTime() - 7 * DAY).toISOString(),
          { emailed: 1, sent: 1, failed: 0, unknown: 0, in_progress: 0, employers_reached: 1 });
        expected.set('window', { emailed: 12, sent: 6, failed: 2, unknown: 1, in_progress: 3, employers_reached: 3 });
      }
      expectDeltas(got, expected, SENDS);
    }
  });

  // ── Every function ──────────────────────────────────────────

  it('returns exactly the columns the console maps', async () => {
    const cols = async (sql: string): Promise<string[]> =>
      withClient(consoleUrl, async (c) => (await c.query(sql)).fields.map((f) => f.name));
    expect(await cols('SELECT * FROM admin_analytics_onboarding_restarts(1)')).toEqual(['week_start', 'door', 'step_key', ...RESTART]);
    expect(await cols('SELECT * FROM admin_analytics_operator_resets(1)')).toEqual(['week_start', 'reason', 'workers', 'resets', 'bulk', 'run_started_at']);
    expect(await cols('SELECT * FROM admin_analytics_digest_adoption()')).toEqual(['employers', 'digest_on', 'digest_on_with_email']);
    expect(await cols('SELECT * FROM admin_analytics_digest_sends(1)')).toEqual(['week_start', ...SENDS]);
    expect(await call.adoption(consoleUrl)).toHaveLength(1);
  });

  it('rejects out-of-range weeks', async () => {
    for (const fn of ['admin_analytics_onboarding_restarts', 'admin_analytics_operator_resets', 'admin_analytics_digest_sends']) {
      for (const weeks of [0, 27, null]) {
        await expect(withClient(consoleUrl, (c) => c.query(`SELECT * FROM ${fn}($1)`, [weeks])))
          .rejects.toThrow(/admin_analytics_invalid_weeks/);
      }
    }
  });

  it('lets only the console execute the read functions, and no one the trigger functions', async () => {
    for (const sql of [
      'SELECT * FROM admin_analytics_onboarding_restarts(4)',
      'SELECT * FROM admin_analytics_operator_resets(4)',
      'SELECT * FROM admin_analytics_digest_adoption()',
      'SELECT * FROM admin_analytics_digest_sends(4)',
    ]) {
      await expect(withClient(whatsappUrl, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
    const grantees = await rowsOf(superUrl,
      `SELECT p.proname AS fn, array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) AS who
         FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('admin_analytics_onboarding_restarts', 'admin_analytics_operator_resets',
                            'admin_analytics_digest_adoption', 'admin_analytics_digest_sends',
                            'admin_cases_stamp_status_change', 'admin_cases_record_status_change')
          AND a.privilege_type = 'EXECUTE'
        GROUP BY p.proname
        ORDER BY p.proname`);
    expect(grantees).toEqual([
      { fn: 'admin_analytics_digest_adoption', who: ['jale_admin', 'jale_admin_console'] },
      { fn: 'admin_analytics_digest_sends', who: ['jale_admin', 'jale_admin_console'] },
      { fn: 'admin_analytics_onboarding_restarts', who: ['jale_admin', 'jale_admin_console'] },
      { fn: 'admin_analytics_operator_resets', who: ['jale_admin', 'jale_admin_console'] },
      { fn: 'admin_cases_record_status_change', who: ['jale_admin'] },
      { fn: 'admin_cases_stamp_status_change', who: ['jale_admin'] },
    ]);
  });
});
