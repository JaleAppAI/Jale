/**
 * analytics-capture-124.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 124 (sprint 28, admin analytics items
 * 16, 17, 18, 20 and 21): the capture tables, the four capture functions and
 * the daily referral snapshot (jale_cap), and the five console reads.
 *
 * Two kinds of test:
 *   - Real logins. Every writer and reader is called over a real
 *     authenticated connection as the login that calls it when deployed
 *     (helpers/login-pool), in every profile: jale_api_public and jale_api
 *     record a signup source, jale_api a job view and feed showings,
 *     jale_whatsapp alert and list showings, jale_job_retention the snapshot,
 *     jale_admin_console the five reads. Each is also refused what it must
 *     not do (a direct table write or read, another login's function). These
 *     use committed fixtures, marked `it-124`, removed afterwards; the rows
 *     the functions write leave with them (ON DELETE CASCADE).
 *   - Exact figures. The reads aggregate the whole database and the snapshot
 *     recomputes whole days, so their figures are asserted inside one
 *     superuser transaction that is rolled back: fixtures are inserted with
 *     session_replication_role = replica (no trigger moves a timestamp), the
 *     function runs under SET LOCAL ROLE as its caller, and figures are deltas
 *     against a baseline call in the same transaction, or exact after the
 *     transaction emptied the source tables. now() is fixed for a
 *     transaction, so a week or day edge can never move mid-test, and nothing
 *     is left behind.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite says so and
 * records that it did not run.
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --no-tests --ref none
 *   then: cd infra && JALE_TEST_DATABASE_URL=<printed url> npx jest --runInBand test/unit/db/analytics-capture-124.integration.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: migration 124 PostgreSQL suite was not run', () => {
    console.warn('[analytics-capture-124] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const MARK = 'it-124';
const CAPTURE_TABLES = ['signup_attribution', 'worker_job_views', 'referral_funnel_daily'] as const;
const READS = ['acquisition', 'job_views', 'template_reuse', 'match_to_apply', 'referral_funnel'] as const;

type Row = Record<string, unknown>;

/** A share code in job_share_links' own format (Crockford, 8 characters). */
function shareCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
}
const hex64 = (): string => randomBytes(32).toString('hex');
/** A placeholder number for a fixture conversation, generated per run. */
const fakeNumber = (): string => `+1999${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

async function superClient(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

/** The SQLSTATE an awaited query fails with, or 'ok'. */
async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

/**
 * Runs `fn` inside one superuser transaction that is always rolled back.
 * `fixtures` runs with triggers off; `as(role, sql)` runs a statement under
 * SET LOCAL ROLE and returns its rows.
 */
async function rolledBack(fn: (tx: {
  fixtures: (sql: string, params?: unknown[]) => Promise<Row[]>;
  as: (role: string, sql: string, params?: unknown[]) => Promise<Row[]>;
  su: (sql: string, params?: unknown[]) => Promise<Row[]>;
}) => Promise<void>): Promise<void> {
  const client = await superClient();
  try {
    await client.query('BEGIN');
    const su = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as Row[];
    await fn({
      su,
      fixtures: async (sql, params = []) => {
        await client.query('SET LOCAL session_replication_role = replica');
        try {
          return await su(sql, params);
        } finally {
          await client.query('SET LOCAL session_replication_role = origin');
        }
      },
      as: async (role, sql, params = []) => {
        await client.query(`SET LOCAL ROLE ${role}`);
        try {
          return await su(sql, params);
        } finally {
          await client.query('RESET ROLE');
        }
      },
    });
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* the connection is closed next */ }
    await client.end();
  }
}

const counts = (row: Row, keys: readonly string[]): Record<string, number> =>
  Object.fromEntries(keys.map((k) => [k, Number(row[k])]));

const delta = (after: Row, before: Row, keys: readonly string[]): Record<string, number> =>
  Object.fromEntries(keys.map((k) => [k, Number(after[k]) - Number(before[k])]));

maybeDescribe('migration 124: analytics capture', () => {
  let su: Client;
  const subs: string[] = [];
  let worker = '';
  let workerSub = '';
  let employer = '';
  let employerSub = '';
  let otherEmployer = '';
  let oldWorker = '';
  let job = '';
  let otherJob = '';
  let ownTemplate = '';
  let foreignTemplate = '';

  async function user(type: 'worker' | 'employer', createdAt = 'now()'): Promise<{ id: string; sub: string }> {
    const sub = `${MARK}-${type}-${randomUUID()}`;
    subs.push(sub);
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type, created_at) VALUES ($1, $2, ${createdAt}) RETURNING id`,
      [sub, type],
    );
    return { id: rows[0].id, sub };
  }

  beforeAll(async () => {
    su = await superClient();
    ({ id: worker, sub: workerSub } = await user('worker'));
    ({ id: employer, sub: employerSub } = await user('employer'));
    ({ id: otherEmployer } = await user('employer'));
    ({ id: oldWorker } = await user('worker', `now() - interval '25 hours'`));
    job = (await su.query<{ id: string }>(
      `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'Analytics capture fixture', 'Austin', 'full-time', 'active') RETURNING id`, [employer],
    )).rows[0].id;
    otherJob = (await su.query<{ id: string }>(
      `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'Analytics capture fixture 2', 'Austin', 'full-time', 'active') RETURNING id`, [otherEmployer],
    )).rows[0].id;
    ownTemplate = (await su.query<{ id: string }>(
      `INSERT INTO public.employer_job_templates (employer_id, name, payload) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [employer, `${MARK} own`],
    )).rows[0].id;
    foreignTemplate = (await su.query<{ id: string }>(
      `INSERT INTO public.employer_job_templates (employer_id, name, payload) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [otherEmployer, `${MARK} foreign`],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (!su) return;
    await su.query(`DELETE FROM public.jobs WHERE employer_id IN (SELECT id FROM public.users WHERE cognito_sub = ANY($1::text[]))`, [subs]);
    await su.query(`DELETE FROM public.employer_job_templates WHERE name LIKE $1`, [`${MARK} %`]);
    await su.query(`DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])`, [subs]);
    await su.end();
  });

  /** Runs `fn` as `login` over a real connection, inside a transaction with the worker context set. */
  async function asWorker<T>(login: string, workerId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient(login, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
  }

  // ── The tables ─────────────────────────────────────────────
  describe('the capture tables', () => {
    it('have row security enabled and forced, and no runtime login holds any right on them', async () => {
      const { rows } = await su.query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_catalog.pg_class c WHERE c.oid = ANY($1::regclass[]) ORDER BY 1`,
        [CAPTURE_TABLES.map((t) => `public.${t}`)],
      );
      expect(rows).toEqual([...CAPTURE_TABLES].sort().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
      const { rows: rights } = await su.query(
        `SELECT r.rolname, t.t
           FROM pg_catalog.pg_roles r, unnest($1::text[]) AS t(t)
          WHERE r.rolname IN ('jale_api', 'jale_api_public', 'jale_whatsapp', 'jale_job_retention', 'jale_admin_console')
            AND (pg_catalog.has_table_privilege(r.oid, ('public.' || t.t)::regclass, 'SELECT, INSERT, UPDATE, DELETE')
                 OR pg_catalog.has_any_column_privilege(r.oid, ('public.' || t.t)::regclass, 'SELECT, INSERT, UPDATE'))`,
        [CAPTURE_TABLES],
      );
      expect(rights).toEqual([]);
    });

    it('the console cannot read them directly, and the writers cannot write them directly (42501)', async () => {
      for (const table of CAPTURE_TABLES) {
        expect([table, await withLoginClient('jale_admin_console', (c) => sqlState(() => c.query(`SELECT 1 FROM public.${table} LIMIT 1`)))])
          .toEqual([table, '42501']);
      }
      expect(await withLoginClient('jale_api', (c) => sqlState(() => c.query(
        `INSERT INTO public.worker_job_views (worker_id, job_id, source, viewed_hour)
         VALUES ($1, $2, 'feed', date_trunc('hour', now(), 'UTC'))`, [worker, job],
      )))).toBe('42501');
      expect(await withLoginClient('jale_api_public', (c) => sqlState(() => c.query(
        `INSERT INTO public.signup_attribution (user_id, door, entry) VALUES ($1, 'web', 'app')`, [worker],
      )))).toBe('42501');
      expect(await withLoginClient('jale_whatsapp', (c) => sqlState(() => c.query(
        `INSERT INTO public.referral_funnel_daily (day, link_kind, channel) VALUES (current_date, 'worker', 'sms')`,
      )))).toBe('42501');
    });
  });

  // ── Signup source (#16) ───────────────────────────────────
  describe('record_signup_source', () => {
    const call = 'SELECT jale_cap.record_signup_source($1, $2, $3, $4) AS recorded';
    const stored = async (userId: string) => (await su.query(
      'SELECT door, entry, src FROM public.signup_attribution WHERE user_id = $1', [userId],
    )).rows;

    it('jale_api_public records a new worker once: the first write wins', async () => {
      const first = await withLoginClient('jale_api_public', (c) => c.query(call, [worker, 'web', 'app', 'qr']));
      expect(first.rows).toEqual([{ recorded: true }]);
      const second = await withLoginClient('jale_api_public', (c) => c.query(call, [worker, 'web', 'job_link', 'flyer']));
      expect(second.rows).toEqual([{ recorded: false }]);
      expect(await stored(worker)).toEqual([{ door: 'web', entry: 'app', src: 'qr' }]);
    });

    it('jale_api records a new employer; a malformed code is kept as no code', async () => {
      const res = await withLoginClient('jale_api', (c) => c.query(call, [employer, 'web', 'signup_page', 'Not A Code!']));
      expect(res.rows).toEqual([{ recorded: true }]);
      expect(await stored(employer)).toEqual([{ door: 'web', entry: 'signup_page', src: null }]);
    });

    it('writes nothing for an account older than 24 hours, an unknown account, or a door and entry that do not match', async () => {
      const outcomes = await withLoginClient('jale_api_public', async (c) => [
        (await c.query(call, [oldWorker, 'web', 'app', null])).rows[0].recorded,
        (await c.query(call, [randomUUID(), 'web', 'app', null])).rows[0].recorded,
        (await c.query(call, [otherEmployer, 'web', 'whatsapp', null])).rows[0].recorded,
        (await c.query(call, [otherEmployer, 'whatsapp', 'app', null])).rows[0].recorded,
        (await c.query(call, [otherEmployer, 'email', 'app', null])).rows[0].recorded,
        (await c.query(call, [null, null, null, null])).rows[0].recorded,
      ]);
      expect(outcomes).toEqual([false, false, false, false, false, false]);
      expect(await stored(oldWorker)).toEqual([]);
      expect(await stored(otherEmployer)).toEqual([]);
    });

    it('is refused to every other runtime login before the body runs', async () => {
      for (const login of ['jale_whatsapp', 'jale_job_retention', 'jale_admin_console']) {
        expect([login, await withLoginClient(login, (c) => sqlState(() => c.query(call, [otherEmployer, 'web', 'app', null])))])
          .toEqual([login, '42501']);
      }
      expect(await stored(otherEmployer)).toEqual([]);
    });
  });

  // ── Job views (#17) ───────────────────────────────────────
  describe('record_job_view', () => {
    const call = 'SELECT jale_cap.record_job_view($1, $2) AS recorded';
    it('jale_api records one row per worker, job and hour: two calls in the same hour leave one row', async () => {
      const results = await asWorker('jale_api', worker, async (c) => [
        (await c.query(call, [job, 'feed'])).rows[0].recorded,
        (await c.query(call, [job, 'direct'])).rows[0].recorded,
        ((await c.query(`SELECT date_trunc('hour', now(), 'UTC') AS h`)).rows[0].h as Date).toISOString(),
      ]);
      expect(results.slice(0, 2)).toEqual([true, false]);
      const { rows } = await su.query(
        'SELECT source, viewed_hour FROM public.worker_job_views WHERE worker_id = $1 AND job_id = $2', [worker, job],
      );
      expect(rows.map((r) => ({ source: r.source, hour: (r.viewed_hour as Date).toISOString() })))
        .toEqual([{ source: 'feed', hour: results[2] }]);
    });

    it('records nothing for an unknown job or source, and refuses a call with no worker context (42501)', async () => {
      const results = await asWorker('jale_api', worker, async (c) => [
        (await c.query(call, [randomUUID(), 'feed'])).rows[0].recorded,
        (await c.query(call, [otherJob, 'newsletter'])).rows[0].recorded,
      ]);
      expect(results).toEqual([false, false]);
      expect(await withLoginClient('jale_api', (c) => sqlState(() => c.query(call, [otherJob, 'feed'])))).toBe('42501');
      expect((await su.query('SELECT count(*)::int AS n FROM public.worker_job_views WHERE job_id = $1', [otherJob])).rows)
        .toEqual([{ n: 0 }]);
    });

    it('is refused to jale_whatsapp and the console', async () => {
      for (const login of ['jale_whatsapp', 'jale_admin_console']) {
        expect([login, await withLoginClient(login, (c) => sqlState(() => c.query(call, [job, 'feed'])))]).toEqual([login, '42501']);
      }
    });
  });

  // ── Showings (#20) ────────────────────────────────────────
  describe('record_feed_impressions and record_whatsapp_impressions', () => {
    const rows = async (channel: string) => (await su.query(
      `SELECT job_id, impression_window_key AS window FROM public.worker_job_impressions
        WHERE worker_id = $1 AND channel = $2 ORDER BY job_id, impression_window_key`, [worker, channel],
    )).rows;
    const dayOf = async (c: Client) => (await c.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`)).rows[0].d as string;

    it('jale_api records each listed job once per UTC day for the calling worker (channel api)', async () => {
      const written = await asWorker('jale_api', worker, async (c) => [
        (await c.query('SELECT jale_cap.record_feed_impressions($1::uuid[]) AS n', [[job, otherJob, job, null]])).rows[0].n,
        (await c.query('SELECT jale_cap.record_feed_impressions($1::uuid[]) AS n', [[job, otherJob]])).rows[0].n,
        (await c.query('SELECT jale_cap.record_feed_impressions($1::uuid[]) AS n', [[]])).rows[0].n,
        await dayOf(c),
      ]);
      expect(written.slice(0, 3)).toEqual([2, 0, 0]);
      expect(await rows('api')).toEqual([job, otherJob].sort().map((jobId) => ({ job_id: jobId, window: written[3] })));
    });

    it('jale_whatsapp records a job alert under alert:<intent> and a job list under list:<day>, beside the same day\'s feed showing', async () => {
      const intent = randomUUID();
      const written = await asWorker('jale_whatsapp', worker, async (c) => [
        (await c.query('SELECT jale_cap.record_whatsapp_impressions($1::uuid[], $2) AS n', [[job], intent])).rows[0].n,
        (await c.query('SELECT jale_cap.record_whatsapp_impressions($1::uuid[], $2) AS n', [[job], intent])).rows[0].n,
        (await c.query('SELECT jale_cap.record_whatsapp_impressions($1::uuid[], NULL) AS n', [[job]])).rows[0].n,
        await dayOf(c),
      ]);
      expect(written.slice(0, 3)).toEqual([1, 0, 1]);
      expect(await rows('whatsapp')).toEqual([
        { job_id: job, window: `list:${written[3] as string}` },
        { job_id: job, window: `alert:${intent}` },
      ].sort((a, b) => a.window.localeCompare(b.window)));
    });

    it('a job removed meanwhile is left out of a batch; the other jobs in it are still recorded', async () => {
      const fresh = async () => (await su.query<{ id: string }>(
        `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'Analytics capture batch fixture', 'Austin', 'full-time', 'active') RETURNING id`, [employer],
      )).rows[0].id;
      const [kept1, kept2, removed] = [await fresh(), await fresh(), await fresh()];
      await su.query('DELETE FROM public.jobs WHERE id = $1', [removed]);
      const written = [
        await asWorker('jale_api', worker, async (c) =>
          (await c.query('SELECT jale_cap.record_feed_impressions($1::uuid[]) AS n', [[kept1, removed, kept2]])).rows[0].n),
        await asWorker('jale_whatsapp', worker, async (c) =>
          (await c.query('SELECT jale_cap.record_whatsapp_impressions($1::uuid[], NULL) AS n', [[kept1, removed, kept2]])).rows[0].n),
      ];
      expect(written).toEqual([2, 2]);
      const { rows: recorded } = await su.query(
        `SELECT channel, count(*)::int AS n FROM public.worker_job_impressions
          WHERE worker_id = $1 AND job_id = ANY($2::uuid[]) GROUP BY channel ORDER BY channel`,
        [worker, [kept1, kept2, removed]],
      );
      expect(recorded).toEqual([{ channel: 'api', n: 2 }, { channel: 'whatsapp', n: 2 }]);
    });

    it('a listed job removed meanwhile records nothing and is not an error; no context is 42501; other logins are refused', async () => {
      expect(await asWorker('jale_api', worker, async (c) =>
        (await c.query('SELECT jale_cap.record_feed_impressions($1::uuid[]) AS n', [[randomUUID()]])).rows[0].n)).toBe(0);
      expect(await withLoginClient('jale_api', (c) => sqlState(() => c.query('SELECT jale_cap.record_feed_impressions($1::uuid[])', [[job]]))))
        .toBe('42501');
      expect(await withLoginClient('jale_whatsapp', (c) => sqlState(() => c.query('SELECT jale_cap.record_feed_impressions($1::uuid[])', [[job]]))))
        .toBe('42501');
      expect(await withLoginClient('jale_api', (c) => sqlState(() => c.query('SELECT jale_cap.record_whatsapp_impressions($1::uuid[], NULL)', [[job]]))))
        .toBe('42501');
    });
  });

  // ── Template id (#18) ─────────────────────────────────────
  describe('jobs.created_from_template_id', () => {
    it('as jale_api, the employer sees its own template and not another employer\'s, and a job stores the id', async () => {
      const visible = await withLoginClient('jale_api', async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [employerSub]);
          await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [employer]);
          const check = 'SELECT 1 FROM employer_job_templates WHERE id = $1 AND employer_id = $2';
          const own = (await c.query(check, [ownTemplate, employer])).rowCount;
          const foreign = (await c.query(check, [foreignTemplate, employer])).rowCount;
          const created = await c.query<{ created_from_template_id: string | null }>(
            `INSERT INTO jobs (employer_id, title, location, job_type, created_from_template_id)
             VALUES ($1, 'Analytics capture template fixture', 'Austin', 'full-time', $2)
             RETURNING created_from_template_id`, [employer, ownTemplate],
          );
          await c.query('COMMIT');
          return { own, foreign, stored: created.rows[0].created_from_template_id };
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      });
      expect(visible).toEqual({ own: 1, foreign: 0, stored: ownTemplate });
    });

    it('deleting the template keeps the job and clears its template id', async () => {
      const throwaway = (await su.query<{ id: string }>(
        `INSERT INTO public.employer_job_templates (employer_id, name, payload) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
        [employer, `${MARK} throwaway`],
      )).rows[0].id;
      const jobId = (await su.query<{ id: string }>(
        `INSERT INTO public.jobs (employer_id, title, location, job_type, created_from_template_id)
         VALUES ($1, 'Analytics capture template fixture 2', 'Austin', 'full-time', $2) RETURNING id`, [employer, throwaway],
      )).rows[0].id;
      await su.query('DELETE FROM public.employer_job_templates WHERE id = $1', [throwaway]);
      expect((await su.query('SELECT created_from_template_id FROM public.jobs WHERE id = $1', [jobId])).rows)
        .toEqual([{ created_from_template_id: null }]);
    });
  });

  // ── The referral snapshot (#21) ───────────────────────────
  describe('referral_funnel_snapshot', () => {
    /**
     * Inside the rolled-back transaction: empties the snapshot and its three
     * source tables (so the figures are exact), then adds two links and
     * events on known UTC days. Returns the days as YYYY-MM-DD.
     */
    async function scene(tx: Parameters<Parameters<typeof rolledBack>[0]>[0]) {
      await tx.fixtures('DELETE FROM public.referral_funnel_daily');
      await tx.fixtures('DELETE FROM public.referral_apply_tokens');
      await tx.fixtures('DELETE FROM public.referral_pending_claims');
      await tx.fixtures('DELETE FROM public.job_share_opens');
      const [workerLink, employerLink] = [shareCode(), shareCode()];
      await tx.fixtures(
        `INSERT INTO public.job_share_links (code, job_id, referrer_worker_id, channel) VALUES ($1, $2, $3, 'sms')`,
        [workerLink, job, worker],
      );
      await tx.fixtures(
        `INSERT INTO public.job_share_links (code, job_id, referrer_employer_id, channel) VALUES ($1, $2, $3, 'whatsapp')`,
        [employerLink, job, employer],
      );
      const day = async (k: number) => (await tx.su(
        `SELECT to_char((now() AT TIME ZONE 'UTC')::date - $1::int, 'YYYY-MM-DD') AS d`, [k],
      ))[0].d as string;
      // Noon UTC k days ago, or now for today.
      const at = (k: number) => (k === 0 ? 'now()' : `((now() AT TIME ZONE 'UTC')::date - ${k})::timestamp AT TIME ZONE 'UTC' + interval '12 hours'`);
      const token = (code: string | null, created: number, consumed: number | null) => tx.fixtures(
        `INSERT INTO public.referral_apply_tokens (token_hash, share_code, job_id, expires_at, created_at, consumed_at, consumed_phone_hash)
         VALUES ($1, $2, $3, ${at(created)} + interval '24 hours', ${at(created)}, ${consumed === null ? 'NULL' : at(consumed)}, $4)`,
        [hex64(), code, job, consumed === null ? null : hex64()],
      );
      await token(workerLink, 6, null);   // the backfill reaches it
      await token(workerLink, 2, 2);      // made and used two days ago
      await token(employerLink, 0, null); // today, an employer's link
      await token(null, 0, null);         // untagged: never counted
      await tx.fixtures(
        `INSERT INTO public.referral_pending_claims (phone_hash, job_id, share_code, expires_at, created_at, claimed_at, claimed_worker_id)
         VALUES ($1, $2, $3, ${at(1)} + interval '30 days', ${at(1)}, ${at(0)}, $4)`,
        [hex64(), job, workerLink, worker],
      );
      await tx.fixtures(`INSERT INTO public.job_share_opens (share_code, job_id, opened_at) VALUES ($1, $2, ${at(0)})`, [workerLink, job]);
      await tx.fixtures(`INSERT INTO public.job_share_opens (share_code, job_id, opened_at) VALUES (NULL, $1, ${at(0)})`, [job]);
      return {
        d0: await day(0), d1: await day(1), d2: await day(2), d3: await day(3), d5: await day(5), d6: await day(6), d7: await day(7),
        at, workerLink,
      };
    }

    const snapshot = async (tx: Parameters<Parameters<typeof rolledBack>[0]>[0]) =>
      (await tx.as('jale_job_retention', 'SELECT days_covered, rows_written FROM jale_cap.referral_funnel_snapshot()'))[0];
    const table = async (tx: Parameters<Parameters<typeof rolledBack>[0]>[0]) => (await tx.su(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, link_kind, channel,
              opens::int, apply_intents::int, intents_consumed::int, claims_parked::int, claims_claimed::int
         FROM public.referral_funnel_daily ORDER BY day, link_kind, channel`,
    ));
    const row = (day: string, link_kind: string, channel: string, c: Partial<Record<string, number>>) => ({
      day, link_kind, channel,
      opens: 0, apply_intents: 0, intents_consumed: 0, claims_parked: 0, claims_claimed: 0, ...c,
    });

    it('on an empty table backfills every day that still has a tagged token or claim, each event on its own day', async () => {
      await rolledBack(async (tx) => {
        const s = await scene(tx);
        expect(await snapshot(tx)).toEqual({ days_covered: 7, rows_written: 5 });
        expect(await table(tx)).toEqual([
          row(s.d6, 'worker', 'sms', { apply_intents: 1 }),
          row(s.d2, 'worker', 'sms', { apply_intents: 1, intents_consumed: 1 }),
          row(s.d1, 'worker', 'sms', { claims_parked: 1 }),
          row(s.d0, 'employer', 'whatsapp', { apply_intents: 1 }),
          row(s.d0, 'worker', 'sms', { opens: 1, claims_claimed: 1 }),
        ]);
      });
    });

    it('is idempotent, and later runs recompute only the last three days', async () => {
      await rolledBack(async (tx) => {
        const s = await scene(tx);
        await snapshot(tx);
        const first = await table(tx);
        // Re-running writes the same rows.
        expect(await snapshot(tx)).toEqual({ days_covered: 3, rows_written: 4 });
        expect(await table(tx)).toEqual(first);
        // A new event five days back is outside the window and stays
        // uncounted; a new one today is counted.
        const link = (await tx.su(`SELECT code FROM public.job_share_links WHERE referrer_worker_id = $1`, [worker]))[0].code as string;
        await tx.fixtures(
          `INSERT INTO public.referral_apply_tokens (token_hash, share_code, job_id, expires_at, created_at)
           VALUES ($1, $2, $3, now() + interval '1 day', ${s.at(5)}), ($4, $2, $3, now() + interval '1 day', now())`,
          [hex64(), link, job, hex64()],
        );
        await snapshot(tx);
        const after = await table(tx);
        expect(after.find((r) => r.day === s.d5)).toBeUndefined();
        expect(after.find((r) => r.day === s.d0 && r.link_kind === 'worker')).toEqual(row(s.d0, 'worker', 'sms', { opens: 1, apply_intents: 1, claims_claimed: 1 }));
        expect(after.filter((r) => r.day === s.d6 || r.day === s.d2)).toEqual(first.filter((r) => r.day === s.d6 || r.day === s.d2));
      });
    });

    it('after missed runs, recomputes the last day written while its rows still exist, and covers the days since', async () => {
      await rolledBack(async (tx) => {
        const s = await scene(tx);
        // Three days ago a run wrote that day early, before its apply tap;
        // the next two runs were missed.
        await tx.fixtures(
          `INSERT INTO public.referral_apply_tokens (token_hash, share_code, job_id, expires_at, created_at)
           VALUES ($1, $2, $3, ${s.at(3)} + interval '24 hours', ${s.at(3)})`,
          [hex64(), s.workerLink, job],
        );
        await tx.fixtures(`INSERT INTO public.referral_funnel_daily (day, link_kind, channel) VALUES ($1::date, 'worker', 'sms')`, [s.d3]);
        expect(await snapshot(tx)).toEqual({ days_covered: 4, rows_written: 5 });
        const t = await table(tx);
        expect(t.find((r) => r.day === s.d3)).toEqual(row(s.d3, 'worker', 'sms', { apply_intents: 1 }));
        expect(t.find((r) => r.day === s.d2)).toEqual(row(s.d2, 'worker', 'sms', { apply_intents: 1, intents_consumed: 1 }));
      });
    });

    it('a last day written before the purge horizon is kept as written, and the days after it are covered', async () => {
      await rolledBack(async (tx) => {
        const s = await scene(tx);
        await tx.fixtures(`INSERT INTO public.referral_funnel_daily (day, link_kind, channel, opens) VALUES ($1::date, 'worker', 'sms', 7)`, [s.d7]);
        expect(await snapshot(tx)).toEqual({ days_covered: 7, rows_written: 5 });
        const t = await table(tx);
        expect(t[0]).toEqual(row(s.d7, 'worker', 'sms', { opens: 7 }));
        expect(t.find((r) => r.day === s.d6)).toEqual(row(s.d6, 'worker', 'sms', { apply_intents: 1 }));
      });
    });

    it('its owner may rewrite the last seven days (today and six before) and nothing older', async () => {
      await rolledBack(async (tx) => {
        const s = await scene(tx);
        await tx.fixtures(
          `INSERT INTO public.referral_funnel_daily (day, link_kind, channel) VALUES ($1::date, 'worker', 'sms'), ($2::date, 'worker', 'sms')`,
          [s.d6, s.d7],
        );
        const deleted = await tx.as(
          'jale_cap_referral_snapshot',
          `DELETE FROM public.referral_funnel_daily WHERE day IN ($1::date, $2::date) RETURNING to_char(day, 'YYYY-MM-DD') AS day`,
          [s.d6, s.d7],
        );
        expect(deleted).toEqual([{ day: s.d6 }]);
      });
    });

    it('jale_job_retention runs it over a real connection; other runtime logins are refused', async () => {
      const res = await withLoginClient('jale_job_retention', (c) => c.query('SELECT days_covered, rows_written FROM jale_cap.referral_funnel_snapshot()'));
      expect(res.rows).toHaveLength(1);
      expect(Number(res.rows[0].days_covered)).toBeGreaterThanOrEqual(3);
      for (const login of ['jale_api', 'jale_whatsapp', 'jale_admin_console']) {
        expect([login, await withLoginClient(login, (c) => sqlState(() => c.query('SELECT * FROM jale_cap.referral_funnel_snapshot()')))])
          .toEqual([login, '42501']);
      }
    });
  });

  // ── The console reads ─────────────────────────────────────
  describe('the console reads', () => {
    it.each(READS)('admin_analytics_%s: the console gets zero-filled Monday weeks, oldest first, the last one partial', async (name) => {
      const res = await withLoginClient('jale_admin_console', (c) => c.query(`SELECT * FROM public.admin_analytics_${name}(3)`));
      const perWeek = name === 'match_to_apply' ? 2 : 1;
      expect(res.rows).toHaveLength(3 * perWeek);
      const { rows: [{ week0 }] } = await su.query(
        `SELECT date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS week0`,
      );
      const weeks = res.rows.map((r) => (r.week_start as Date).toISOString());
      const expectedWeeks = [2, 1, 0].flatMap((n) => Array(perWeek).fill(new Date((week0 as Date).getTime() - n * 7 * 86_400_000).toISOString()));
      expect(weeks).toEqual(expectedWeeks);
      expect(res.rows.map((r) => r.partial)).toEqual([2, 1, 0].flatMap((n) => Array(perWeek).fill(n === 0)));
      if (name === 'match_to_apply') expect(res.rows.map((r) => r.channel)).toEqual(['web', 'whatsapp', 'web', 'whatsapp', 'web', 'whatsapp']);
      const since = name === 'referral_funnel' ? 'snapshots_since' : 'collecting_since';
      expect(new Set(res.rows.map((r) => String(r[since]))).size).toBe(1);
    });

    it.each(READS)('admin_analytics_%s rejects a window outside 1..26 weeks with admin_analytics_invalid_weeks', async (name) => {
      for (const weeks of [0, 27, null]) {
        const message = await withLoginClient('jale_admin_console', async (c) => {
          try {
            await c.query(`SELECT * FROM public.admin_analytics_${name}($1)`, [weeks]);
            return 'accepted';
          } catch (err) {
            return (err as Error).message;
          }
        });
        expect([weeks, message]).toEqual([weeks, 'admin_analytics_invalid_weeks']);
      }
    });

    it.each(READS)('admin_analytics_%s is refused to every runtime login but the console', async (name) => {
      for (const login of ['jale_api', 'jale_api_public', 'jale_whatsapp', 'jale_job_retention']) {
        expect([login, await withLoginClient(login, (c) => sqlState(() => c.query(`SELECT * FROM public.admin_analytics_${name}(4)`)))])
          .toEqual([login, '42501']);
      }
    });

    /** The current week's row of a read, as the console, inside the transaction. */
    const current = async (tx: Parameters<Parameters<typeof rolledBack>[0]>[0], name: string, where = '') =>
      (await tx.as('jale_admin_console', `SELECT * FROM public.admin_analytics_${name}(2) WHERE partial ${where}`));

    it('collecting_since is null with no captured row and the first capture time after one', async () => {
      await rolledBack(async (tx) => {
        await tx.fixtures('DELETE FROM public.signup_attribution');
        await tx.fixtures('DELETE FROM public.worker_job_views');
        await tx.fixtures('DELETE FROM public.worker_job_impressions');
        await tx.fixtures('UPDATE public.jobs SET created_from_template_id = NULL WHERE created_from_template_id IS NOT NULL');
        await tx.fixtures('DELETE FROM public.referral_funnel_daily');
        const sinceOf = async (name: string, column = 'collecting_since') =>
          ((await current(tx, name))[0][column] as Date | null)?.toISOString() ?? null;
        expect(await sinceOf('acquisition')).toBeNull();
        expect(await sinceOf('job_views')).toBeNull();
        expect(await sinceOf('template_reuse')).toBeNull();
        expect(await sinceOf('match_to_apply')).toBeNull();
        expect(await sinceOf('referral_funnel', 'snapshots_since')).toBeNull();

        const [{ t, h, d }] = await tx.su(
          `SELECT now() AS t, date_trunc('hour', now(), 'UTC') AS h, ((now() AT TIME ZONE 'UTC')::date - 1)::timestamp AT TIME ZONE 'UTC' AS d`,
        );
        await tx.fixtures(`INSERT INTO public.signup_attribution (user_id, door, entry, created_at) VALUES ($1, 'web', 'app', now())`, [worker]);
        await tx.fixtures(`INSERT INTO public.worker_job_views (worker_id, job_id, source, viewed_hour) VALUES ($1, $2, 'feed', $3)`, [worker, job, h]);
        await tx.fixtures(`INSERT INTO public.worker_job_impressions (worker_id, job_id, channel, impression_window_key, delivered_at) VALUES ($1, $2, 'api', 'd', now())`, [worker, job]);
        await tx.fixtures(`INSERT INTO public.jobs (employer_id, title, location, job_type, created_from_template_id, created_at) VALUES ($1, 'x', 'Austin', 'full-time', $2, now())`, [employer, ownTemplate]);
        await tx.fixtures(`INSERT INTO public.referral_funnel_daily (day, link_kind, channel) VALUES ((now() AT TIME ZONE 'UTC')::date - 1, 'worker', 'sms')`);
        const iso = (v: unknown) => (v as Date).toISOString();
        expect(await sinceOf('acquisition')).toBe(iso(t));
        expect(await sinceOf('job_views')).toBe(iso(h));
        expect(await sinceOf('template_reuse')).toBe(iso(t));
        expect(await sinceOf('match_to_apply')).toBe(iso(t));
        expect(await sinceOf('referral_funnel', 'snapshots_since')).toBe(iso(d));
      });
    });

    it('acquisition: each new account counts once, by its source', async () => {
      await rolledBack(async (tx) => {
        const keys = ['from_shared_link', 'from_campaign_tag', 'from_referral', 'from_direct', 'from_whatsapp_entry', 'from_unknown', 'total'];
        const before = (await current(tx, 'acquisition'))[0];
        const add = async (type: string) => (await tx.fixtures(
          `INSERT INTO public.users (cognito_sub, user_type, created_at) VALUES ($1, $2, now()) RETURNING id`, [`${MARK}-tx-${randomUUID()}`, type],
        ))[0].id as string;
        const [tagged, referred, jobLink, direct, viaWhatsapp, unknown, laterWhatsapp] = [
          await add('worker'), await add('worker'), await add('worker'), await add('employer'), await add('worker'), await add('worker'), await add('worker'),
        ];
        const source = (id: string, entry: string, src: string | null) => tx.fixtures(
          `INSERT INTO public.signup_attribution (user_id, door, entry, src) VALUES ($1, 'web', $2, $3)`, [id, entry, src]);
        await source(tagged, 'app', 'qr');
        await source(referred, 'job_link', null);
        await tx.fixtures(`INSERT INTO public.worker_attribution (worker_id, first_channel, first_share_code) VALUES ($1, 'sms', NULL)`, [referred]);
        await source(jobLink, 'job_link', null);
        await source(direct, 'signup_page', null);
        await tx.fixtures(`INSERT INTO public.whatsapp_conversations (user_id, whatsapp_number, created_at) VALUES ($1, $2, now() - interval '1 hour')`, [viaWhatsapp, fakeNumber()]);
        await tx.fixtures(`INSERT INTO public.whatsapp_conversations (user_id, whatsapp_number, created_at) VALUES ($1, $2, now() + interval '1 hour')`, [laterWhatsapp, fakeNumber()]);
        void unknown;
        const after = (await current(tx, 'acquisition'))[0];
        expect(delta(after, before, keys)).toEqual({
          from_shared_link: 1, from_campaign_tag: 1, from_referral: 1, from_direct: 1,
          from_whatsapp_entry: 1, from_unknown: 2, total: 7,
        });
      });
    });

    it('job_views: public opens, applications credited to a shared link, distinct views and applications within 7 days of a view', async () => {
      await rolledBack(async (tx) => {
        const keys = ['public_opens', 'public_applications', 'worker_views', 'worker_view_applications'];
        const before = (await current(tx, 'job_views'))[0];
        const add = async () => (await tx.fixtures(
          `INSERT INTO public.users (cognito_sub, user_type, created_at) VALUES ($1, 'worker', now()) RETURNING id`, [`${MARK}-tx-${randomUUID()}`],
        ))[0].id as string;
        const [w1, w2] = [await add(), await add()];
        for (const code of [null, null, null]) {
          await tx.fixtures(`INSERT INTO public.job_share_opens (share_code, job_id, opened_at) VALUES ($1, $2, now())`, [code, job]);
        }
        // w1 is credited to a shared link for `job` and applied: one public
        // application.
        const code = shareCode();
        await tx.fixtures(`INSERT INTO public.job_share_links (code, job_id, referrer_employer_id, channel) VALUES ($1, $2, $3, 'copy_link')`, [code, job, employer]);
        await tx.fixtures(`INSERT INTO public.worker_attribution (worker_id, first_share_code, first_channel, first_job_id) VALUES ($1, $2, 'copy_link', $3)`, [w1, code, job]);
        await tx.fixtures(`INSERT INTO public.job_applications (job_id, worker_id, applied_at) VALUES ($1, $2, now())`, [job, w1]);
        // w1 viewed otherJob (no application); w2 viewed job and applied after.
        const hour = `date_trunc('hour', now(), 'UTC')`;
        await tx.fixtures(`INSERT INTO public.worker_job_views (worker_id, job_id, source, viewed_hour) VALUES ($1, $2, 'feed', ${hour})`, [w1, otherJob]);
        await tx.fixtures(`INSERT INTO public.worker_job_views (worker_id, job_id, source, viewed_hour) VALUES ($1, $2, 'direct', ${hour})`, [w2, job]);
        await tx.fixtures(`INSERT INTO public.job_applications (job_id, worker_id, applied_at) VALUES ($1, $2, now())`, [job, w2]);
        const after = (await current(tx, 'job_views'))[0];
        expect(delta(after, before, keys)).toEqual({ public_opens: 3, public_applications: 1, worker_views: 2, worker_view_applications: 1 });
      });
    });

    it('template_reuse: jobs posted, from a template, employers doing so, templates saved', async () => {
      await rolledBack(async (tx) => {
        const keys = ['jobs', 'from_template', 'employers_using_templates', 'templates_saved'];
        const before = (await current(tx, 'template_reuse'))[0];
        const add = async () => (await tx.fixtures(
          `INSERT INTO public.users (cognito_sub, user_type, created_at) VALUES ($1, 'employer', now()) RETURNING id`, [`${MARK}-tx-${randomUUID()}`],
        ))[0].id as string;
        const [e1, e2] = [await add(), await add()];
        const template = async (e: string) => (await tx.fixtures(
          `INSERT INTO public.employer_job_templates (employer_id, name, payload, created_at) VALUES ($1, 't', '{}'::jsonb, now()) RETURNING id`, [e],
        ))[0].id as string;
        const [t1, t2] = [await template(e1), await template(e2)];
        const post = (e: string, t: string | null) => tx.fixtures(
          `INSERT INTO public.jobs (employer_id, title, location, job_type, created_from_template_id, created_at) VALUES ($1, 'x', 'Austin', 'full-time', $2, now())`, [e, t]);
        await post(e1, t1);
        await post(e1, t1);
        await post(e2, null);
        await post(e2, t2);
        const after = (await current(tx, 'template_reuse'))[0];
        expect(delta(after, before, keys)).toEqual({ jobs: 4, from_template: 3, employers_using_templates: 2, templates_saved: 2 });
      });
    });

    it('match_to_apply: distinct pairs shown per channel, and those applied to at or after the showing within 7 days', async () => {
      await rolledBack(async (tx) => {
        const keys = ['shown', 'applied_within_7d'];
        const before = await current(tx, 'match_to_apply', 'ORDER BY channel');
        const add = async () => (await tx.fixtures(
          `INSERT INTO public.users (cognito_sub, user_type, created_at) VALUES ($1, 'worker', now()) RETURNING id`, [`${MARK}-tx-${randomUUID()}`],
        ))[0].id as string;
        const [w1, w2] = [await add(), await add()];
        const show = (w: string, j: string, channel: string, key: string) => tx.fixtures(
          `INSERT INTO public.worker_job_impressions (worker_id, job_id, channel, impression_window_key, delivered_at) VALUES ($1, $2, $3, $4, now())`, [w, j, channel, key]);
        await show(w1, job, 'api', 'a');
        await show(w1, job, 'api', 'b');
        await show(w1, otherJob, 'whatsapp', 'alert:x');
        await show(w2, job, 'whatsapp', 'd');
        await tx.fixtures(`INSERT INTO public.job_applications (job_id, worker_id, applied_at) VALUES ($1, $2, now())`, [job, w1]);
        // w2 applied before the showing: not counted.
        await tx.fixtures(`INSERT INTO public.job_applications (job_id, worker_id, applied_at) VALUES ($1, $2, now() - interval '1 second')`, [job, w2]);
        const after = await current(tx, 'match_to_apply', 'ORDER BY channel');
        expect(after.map((r) => r.channel)).toEqual(['web', 'whatsapp']);
        expect(delta(after[0], before[0], keys)).toEqual({ shown: 1, applied_within_7d: 1 });
        expect(delta(after[1], before[1], keys)).toEqual({ shown: 2, applied_within_7d: 0 });
      });
    });

    it('referral_funnel: tagged opens, snapshot intents and claims, and applications and hires credited to the job', async () => {
      await rolledBack(async (tx) => {
        await tx.fixtures('DELETE FROM public.referral_funnel_daily');
        const keys = ['opens', 'apply_intents', 'claims', 'applications', 'hires'];
        const before = (await current(tx, 'referral_funnel'))[0];
        const code = shareCode();
        await tx.fixtures(`INSERT INTO public.job_share_links (code, job_id, referrer_worker_id, channel) VALUES ($1, $2, $3, 'sms')`, [code, job, worker]);
        await tx.fixtures(`INSERT INTO public.job_share_opens (share_code, job_id, opened_at) VALUES ($1, $2, now()), ($1, $2, now()), (NULL, $2, now())`, [code, job]);
        await tx.fixtures(
          `INSERT INTO public.referral_funnel_daily (day, link_kind, channel, apply_intents, claims_parked, claims_claimed)
           VALUES ((now() AT TIME ZONE 'UTC')::date, 'worker', 'sms', 3, 2, 1)`,
        );
        const add = async () => (await tx.fixtures(
          `INSERT INTO public.users (cognito_sub, user_type, created_at) VALUES ($1, 'worker', now()) RETURNING id`, [`${MARK}-tx-${randomUUID()}`],
        ))[0].id as string;
        const [credited, elsewhere] = [await add(), await add()];
        await tx.fixtures(`INSERT INTO public.worker_attribution (worker_id, first_share_code, first_channel, first_job_id) VALUES ($1, $2, 'sms', $3)`, [credited, code, job]);
        await tx.fixtures(`INSERT INTO public.worker_attribution (worker_id, first_share_code, first_channel, first_job_id) VALUES ($1, $2, 'sms', $3)`, [elsewhere, code, otherJob]);
        await tx.fixtures(`INSERT INTO public.job_applications (job_id, worker_id, applied_at, status, hired_at) VALUES ($1, $2, now(), 'hired', now())`, [job, credited]);
        await tx.fixtures(`INSERT INTO public.job_applications (job_id, worker_id, applied_at) VALUES ($1, $2, now())`, [job, elsewhere]);
        const after = (await current(tx, 'referral_funnel'))[0];
        expect(delta(after, before, keys)).toEqual({ opens: 2, apply_intents: 3, claims: 1, applications: 1, hires: 1 });
        expect(counts(after, ['apply_intents'])).toEqual({ apply_intents: 3 });
      });
    });
  });
});
