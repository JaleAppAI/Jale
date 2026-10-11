/**
 * worker-referred-jobs-103.integration.test.ts
 *
 * Migration 103's worker_referred_jobs list against REAL
 * PostgreSQL 16 -- the migration applied from the FILE ITSELF, connected as
 * the bed's non-superuser `jale_admin` -- and the three statements in
 * lambda/lib/referred-jobs.ts run on real connections as the roles that run
 * them.
 *
 * WHY NONE OF THIS CAN BE MOCKED.
 *
 * 1. The backfill reads worker_attribution and referral_pending_claims, both
 *    ENABLE + FORCE ROW LEVEL SECURITY (056). On this bed the migration's
 *    connection reads none of their rows outside the un-force window, so a
 *    103 that forgot its un-force would copy no rows, and its own data
 *    self-check, reading the same empty sources, would pass. A superuser is
 *    not subject to row security and would hide exactly that. So fixtures go
 *    through the superuser client (`su`), and the migration through a second
 *    client on the bed's non-superuser jale_admin (the 094/095 pattern).
 *    Case 1 measures that empty view.
 *
 * 2. A green policy test says nothing about the statements themselves: the
 *    explicit `worker_id = $1` in every statement is the boundary. The
 *    superuser is a session RLS does not filter, so case 5 runs the library
 *    as `su` with worker A's
 *    settings and shows worker B's rows never come back, and that another
 *    worker's application never hides A's job.
 *
 * 3. The two policies are defence in depth. Cases 6-8 prove each one as its
 *    own role: own rows readable and writable, another worker's rows
 *    invisible, a write for another worker refused LOUDLY (WITH CHECK is an
 *    error, unlike a filtered UPDATE), and nothing at all without a setting.
 *
 * 4. The feed reads the list inside its caller's transaction, where a failed
 *    statement aborts everything after it. Case 12 runs job-matching.ts's pin
 *    path the way TRABAJOS does (on the bed's jale_whatsapp login) and makes
 *    the pin read fail for real.
 *
 * HOW THE PRE-103 STATE IS REPRODUCED ON A TESTBED ALREADY AT 103. The
 * referral history is seeded straight into the two source tables and the
 * FILE is re-applied. A replay is the file's idempotence path (IF NOT EXISTS,
 * DROP POLICY IF EXISTS, a held GRANT, an upsert that only widens a row), and
 * it is the only way the backfill is falsifiable: on a virgin database both
 * source tables are empty. The backfill is global, so every assertion is
 * scoped to this suite's own fixture ids.
 *
 * CASES ARE ORDERED AND STATEFUL: 2-4 read what the replays produced (3b's
 * replays are refused and roll back), and
 * 5-12 use the jobs and workers seeded in beforeAll. The replays run first,
 * before any role client opens a transaction, because a replay takes ACCESS
 * EXCLUSIVE on all three tables. Do not reorder them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';

import { setInternalUserRlsContext, setRlsContext } from '../../../lambda/lib/db';
import { listMatchedJobsForWorker } from '../../../lambda/lib/job-matching';
import {
  getReferredJobForOnboarding,
  listOpenReferredJobIds,
  recordReferredJob,
} from '../../../lambda/lib/referred-jobs';
import { reviewedPolicyCopies } from './helpers/policy-copies';
import { itInProfiles } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIGRATION_PATH = path.join(
  __dirname, '..', '..', '..', 'db', 'migrations', '103_worker_referred_jobs.sql',
);
const JOB_DELETE_HANDLER_PATH = path.join(
  __dirname, '..', '..', '..', 'lambda', 'api', 'employer-jobs-delete.ts',
);

/** employer-jobs-delete.ts's DELETE statements, lifted from its source in the
 * order it runs them (the job's children, then the job), so a copy that
 * drifted from the handler would fail here rather than pass. `$1` is the job. */
function jobDeleteStatements(): string[] {
  const source = fs.readFileSync(JOB_DELETE_HANDLER_PATH, 'utf8');
  const found = [...source.matchAll(/client\.query\('(DELETE FROM \w+ WHERE \w+ = \$1)'/g)]
    .map((match) => match[1]);
  expect(found.length).toBeGreaterThan(1);
  expect(found[found.length - 1]).toBe('DELETE FROM jobs WHERE id = $1');
  return found;
}

const PASSWORDS = { jale_admin: 'test-admin-pw', jale_whatsapp: 'test-whatsapp-pw' } as const;
type AppRole = keyof typeof PASSWORDS;

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

if (!databaseUrl) {
  test('CONCERN: the migration-103 referred-jobs DB suite was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[worker-referred-jobs-103] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a '
      + 'disposable PostgreSQL 16 superuser URL with migrations 001-103 applied.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

/** A fixed past instant plus `n` days, so every timestamp is exact. */
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
function day(n: number): Date {
  return new Date(T0 + n * 86_400_000);
}

interface ReferredRow {
  worker_id: string;
  job_id: string;
  source: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface FirstTouch {
  first_share_code: string | null;
  first_channel: string | null;
  first_job_id: string | null;
  first_referrer_worker_id: string | null;
  first_referrer_employer_id: string | null;
  first_seen_at: Date;
}

maybeDescribe('sprint 27: migration 103 and the referred-jobs list', () => {
  /** Fixtures and verification reads. Not subject to RLS, so it is never the
   * connection the migration runs on -- and it is the session RLS does not
   * filter in case 5. */
  const su = new Client({ connectionString: databaseUrl });
  /** The migration's OWN connection: the bed's non-superuser jale_admin. */
  let admin: Client;

  const tag = randomUUID().slice(0, 8);
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  const employerId = randomUUID();
  const employerSub = `s27-103-employer-${tag}`;

  // ── the backfill's referral history ──
  /** first touch != latest touch, a claim that repeats the latest pair, and a
   * row a door already recorded. */
  const w1 = randomUUID();
  /** a first touch whose latest job was deleted (latest_job_id NULL), plus a
   * claim of its own. */
  const w2 = randomUUID();
  /** first touch == latest touch: the same pair twice in one source. */
  const w3 = randomUUID();
  const jobFirst = randomUUID();
  const jobLatest = randomUUID();
  const jobNoLatest = randomUUID();
  const jobClaimed = randomUUID();
  const jobSame = randomUUID();
  const jobUnclaimed = randomUUID();

  // ── the library's predicates and the two policies ──
  const workerA = randomUUID();
  const subA = `s27-103-a-${tag}`;
  const workerB = randomUUID();
  const subB = `s27-103-b-${tag}`;
  const jobOpenOld = randomUUID();
  const jobOpenNew = randomUUID();
  const jobApplied = randomUUID();
  const jobClosed = randomUUID();
  const jobPaused = randomUUID();
  const jobOfB = randomUUID();
  const jobDoomed = randomUUID();

  // ── the two referral-schema repairs 103 folds in ──
  /** a worker whose first touch is a job its employer then deletes. */
  const wTouch = randomUUID();
  const jobTouched = randomUUID();
  const jobElsewhere = randomUUID();
  /** a worker who claimed a WhatsApp referral, and whose account then goes. */
  const wClaimer = randomUUID();

  // ── the feed ──
  /** a worker whose trade no job matches, so their feed is exactly the pins. */
  const wFeed = randomUUID();

  const workerIds = [w1, w2, w3, workerA, workerB, wTouch, wClaimer, wFeed];
  const jobIds = [
    jobFirst, jobLatest, jobNoLatest, jobClaimed, jobSame, jobUnclaimed,
    jobOpenOld, jobOpenNew, jobApplied, jobClosed, jobPaused, jobOfB, jobDoomed,
    jobTouched, jobElsewhere,
  ];
  const labels = new Map<string, string>(Object.entries({
    w1, w2, w3, workerA, workerB, wTouch, wClaimer, wFeed,
    jobFirst, jobLatest, jobNoLatest, jobClaimed, jobSame, jobUnclaimed,
    jobOpenOld, jobOpenNew, jobApplied, jobClosed, jobPaused, jobOfB, jobDoomed,
    jobTouched, jobElsewhere,
  }).map(([name, id]) => [id, name]));

  /** Applies 103 exactly the way run-migrations.sh does: the whole file in
   * one simple query, as jale_admin. A failing statement leaves the file's
   * own BEGIN open and aborted, still holding its ACCESS EXCLUSIVE locks, so
   * it is rolled back here (psql would end the session) -- otherwise every
   * later case would hang on those locks instead of failing. */
  async function apply103(): Promise<void> {
    try {
      await admin.query(migrationSql);
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async function connectAs(role: AppRole): Promise<Client> {
    const client = new Client({
      connectionString: urlForRole(databaseUrl as string, role, PASSWORDS[role]),
    });
    await client.connect();
    return client;
  }

  /** The suite's own rows, as readable one-liners, through `client`. */
  async function referredRows(client: Client, workers: string[]): Promise<string[]> {
    const res = await client.query<ReferredRow>(
      `SELECT worker_id, job_id, source, first_seen_at, last_seen_at
         FROM worker_referred_jobs
        WHERE worker_id = ANY($1::uuid[])`,
      [workers],
    );
    return res.rows
      .map((r) => [
        labels.get(r.worker_id) ?? r.worker_id,
        labels.get(r.job_id) ?? r.job_id,
        r.source,
        r.first_seen_at.toISOString(),
        r.last_seen_at.toISOString(),
      ].join(' '))
      .sort();
  }

  async function countRows(client: Client, sql: string, params: unknown[]): Promise<number> {
    const res = await client.query<{ n: number }>(sql, params);
    return res.rows[0].n;
  }

  /** The six first-touch columns 056/063's trigger guards, read past RLS. */
  async function firstTouch(workerId: string): Promise<FirstTouch> {
    const res = await su.query<FirstTouch>(
      `SELECT first_share_code, first_channel, first_job_id, first_referrer_worker_id,
              first_referrer_employer_id, first_seen_at
         FROM worker_attribution WHERE worker_id = $1`,
      [workerId],
    );
    expect(res.rows).toHaveLength(1);
    return res.rows[0];
  }

  beforeAll(async () => {
    await su.connect();
    for (const role of Object.keys(PASSWORDS) as AppRole[]) {
      if (new URL(databaseUrl as string).username !== role) {
        await su.query(`ALTER ROLE ${role} WITH PASSWORD '${PASSWORDS[role]}'`);
      }
    }
    admin = await connectAs('jale_admin');

    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'employer')`,
      [employerId, employerSub],
    );
    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       VALUES ($1, $2, 'worker'), ($3, $4, 'worker'), ($5, $6, 'worker'),
              ($7, $8, 'worker'), ($9, $10, 'worker'), ($11, $12, 'worker'),
              ($13, $14, 'worker')`,
      [
        w1, `s27-103-w1-${tag}`, w2, `s27-103-w2-${tag}`, w3, `s27-103-w3-${tag}`,
        workerA, subA, workerB, subB,
        wTouch, `s27-103-touch-${tag}`, wClaimer, `s27-103-claimer-${tag}`,
      ],
    );

    // Every job starts active except the paused one; case 5 closes one inside
    // its own (rolled-back) transaction. jobOpenNew has no company, so the
    // summary must fall back to 'Jale' the way the feed does.
    for (const id of jobIds.filter((j) => j !== jobOpenNew && j !== jobClosed && j !== jobPaused)) {
      await su.query(
        `INSERT INTO jobs (id, employer_id, title, location, job_type, status)
         VALUES ($1, $2, $3, 'El Paso, TX', 'full-time', 'active')`,
        [id, employerId, `S27 103 ${labels.get(id)}`],
      );
    }
    await su.query(
      `INSERT INTO jobs (id, employer_id, title, company, location, job_type, status,
                         pay, pay_min, pay_max, pay_interval)
       VALUES ($1, $4, 'S27 103 open new', NULL, 'El Paso, TX', 'full-time', 'active',
               '$22-$26/hour', 22, 26, 'hourly'),
              ($2, $4, 'S27 103 closed', 'NB Construction', 'Las Cruces, NM', 'part-time', 'active',
               NULL, NULL, NULL, NULL),
              ($3, $4, 'S27 103 paused', NULL, 'El Paso, TX', 'full-time', 'paused',
               NULL, NULL, NULL, NULL)`,
      [jobOpenNew, jobClosed, jobPaused, employerId],
    );

    // The referral history, exactly as the old code leaves it.
    await su.query(
      `INSERT INTO worker_attribution (worker_id, first_job_id, first_seen_at, latest_job_id, latest_seen_at)
       VALUES ($1, $2, $3, $4, $5),
              ($6, $7, $8, NULL, $8),
              ($9, $10, $3, $10, $11)`,
      [
        w1, jobFirst, day(1), jobLatest, day(3),
        w2, jobNoLatest, day(2),
        w3, jobSame, day(4),
      ],
    );
    const phone = () => randomBytes(32).toString('hex');
    await su.query(
      `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at, claimed_at, claimed_worker_id)
       VALUES ($1, $4, $7, $8, $9),
              ($2, $5, $7, $10, $11),
              ($3, $6, $7, NULL, NULL)`,
      [
        phone(), phone(), phone(),
        jobLatest, jobClaimed, jobUnclaimed,
        day(60),
        day(0), w1,
        day(5), w2,
      ],
    );
    // A row a door recorded before this replay: its source must survive, and
    // its window may only widen.
    await su.query(
      `INSERT INTO worker_referred_jobs (worker_id, job_id, source, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'job_page', $3, $4)`,
      [w1, jobFirst, day(2), day(6)],
    );
  });

  afterAll(async () => {
    // Plain deletes, and the foreign keys do the rest: jobs take the referred
    // rows and the claims with them and clear the attribution job references
    // (103's repair 3a lets first_job_id go NULL), then users take the
    // attribution rows. Without repair 3a this teardown fails, as case 10
    // does. try/finally so a failed DELETE still closes both clients and jest
    // does not hang on open handles.
    try {
      await su.query(`DELETE FROM job_applications WHERE job_id = ANY($1::uuid[])`, [jobIds]);
      await su.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [jobIds]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[employerId, ...workerIds]]);
    } finally {
      await admin.end();
      await su.end();
    }
  });

  // ── 1. the connection the migration runs on ────────────────────
  // Checks row policies as the standard and request test beds apply them.
  itInProfiles(['standard', 'request'], '1. on the bed\'s migration connection, the history it must copy stays hidden until the un-force window', async () => {
    const who = await admin.query<{ user: string; super: boolean }>(
      `SELECT current_user AS user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
    );
    expect(who.rows[0]).toEqual({ user: 'jale_admin', super: false });
    // ...and it owns all three tables, which is why FORCE applies to it on this bed.
    const owned = await admin.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relname IN ('worker_attribution', 'referral_pending_claims', 'worker_referred_jobs')
          AND pg_get_userbyid(relowner) = 'jale_admin'
        ORDER BY relname`,
    );
    expect(owned.rows.map((r) => r.relname))
      .toEqual(['referral_pending_claims', 'worker_attribution', 'worker_referred_jobs']);

    // THE no-op, measured on the bed: with no GUC set, this connection reads
    // none of the rows the superuser can see.
    const probes: Array<[string, unknown[], number]> = [
      ['SELECT count(*)::int AS n FROM worker_attribution WHERE worker_id = ANY($1::uuid[])', [[w1, w2, w3]], 3],
      ['SELECT count(*)::int AS n FROM referral_pending_claims WHERE job_id = ANY($1::uuid[])',
        [[jobLatest, jobClaimed, jobUnclaimed]], 3],
      ['SELECT count(*)::int AS n FROM worker_referred_jobs WHERE worker_id = $1', [w1], 1],
    ];
    for (const [sql, params, seeded] of probes) {
      expect(await countRows(admin, sql, params)).toBe(0);
      expect(await countRows(su, sql, params)).toBe(seeded);
    }
  });

  // ── 2. the backfill ───────────────────────────────────────────
  it('2. copies first and latest touches and claimed claims, one row per pair, and skips the unclaimed claim', async () => {
    await expect(apply103()).resolves.not.toThrow();

    expect(await referredRows(su, [w1, w2, w3])).toEqual([
      // The door's row: source kept, window widened to the earlier first touch.
      `w1 jobFirst job_page ${day(1).toISOString()} ${day(6).toISOString()}`,
      // The latest touch AND an earlier claim of the same job: one row, both ends.
      `w1 jobLatest backfill ${day(0).toISOString()} ${day(3).toISOString()}`,
      `w2 jobClaimed backfill ${day(5).toISOString()} ${day(5).toISOString()}`,
      `w2 jobNoLatest backfill ${day(2).toISOString()} ${day(2).toISOString()}`,
      // first_job_id = latest_job_id: grouped, not a 21000.
      `w3 jobSame backfill ${day(1).toISOString()} ${day(4).toISOString()}`,
    ]);
    // A claim nobody has claimed belongs to no worker yet.
    expect(await countRows(su,
      'SELECT count(*)::int AS n FROM worker_referred_jobs WHERE job_id = $1', [jobUnclaimed])).toBe(0);
  });

  it('3. replays as a no-op the SQL itself accepts: same rows, same windows, same sources', async () => {
    const before = await referredRows(su, [w1, w2, w3]);
    await expect(apply103()).resolves.not.toThrow();
    expect(await referredRows(su, [w1, w2, w3])).toEqual(before);
  });

  // A replay accepts the reviewed copies of its two policies by exact name
  // only: a stray policy fails the self-check even when its name looks like
  // a copy's. The stray is dropped again whatever happens.
  it.each([
    ['a reviewed copy\'s prefix with another login code', 'worker_referred_jobs_owner__xx'],
    ['a reviewed copy\'s suffix on a policy that is not one of the two', 'worker_referred_jobs_extra__api'],
  ])('3b. refuses a replay over a stray policy named like %s', async (_label, stray) => {
    await su.query(`CREATE POLICY ${stray} ON worker_referred_jobs FOR SELECT TO jale_admin USING (false)`);
    try {
      await expect(apply103()).rejects.toThrow(
        'migration 103: worker_referred_jobs carries a policy other than its two and their reviewed copies',
      );
    } finally {
      await su.query(`DROP POLICY IF EXISTS ${stray} ON worker_referred_jobs`);
    }
  });

  it('4. leaves all three tables ENABLE + FORCE, with the grants and the two role-scoped policies', async () => {
    const rls = await su.query<{ relname: string; on: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced
         FROM pg_class
        WHERE oid IN ('public.worker_attribution'::regclass, 'public.referral_pending_claims'::regclass,
                      'public.worker_referred_jobs'::regclass)
        ORDER BY relname`,
    );
    expect(rls.rows).toEqual([
      { relname: 'referral_pending_claims', on: true, forced: true },
      { relname: 'worker_attribution', on: true, forced: true },
      { relname: 'worker_referred_jobs', on: true, forced: true },
    ]);

    const privileges = await su.query<{ role: string; s: boolean; i: boolean; u: boolean; d: boolean }>(
      `SELECT r AS role,
              has_table_privilege(r, 'public.worker_referred_jobs', 'SELECT') AS s,
              has_table_privilege(r, 'public.worker_referred_jobs', 'INSERT') AS i,
              has_table_privilege(r, 'public.worker_referred_jobs', 'UPDATE') AS u,
              has_table_privilege(r, 'public.worker_referred_jobs', 'DELETE') AS d
         FROM unnest(ARRAY['jale_admin', 'jale_whatsapp']) AS r ORDER BY r`,
    );
    expect(privileges.rows).toEqual([
      // DELETE here is the OWNER's, never a grant: case 9 is why it must stay.
      { role: 'jale_admin', s: true, i: true, u: true, d: true },
      { role: 'jale_whatsapp', s: true, i: true, u: true, d: false },
    ]);

    const policies = await su.query<{ policyname: string; cmd: string; roles: string[] }>(
      `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'worker_referred_jobs' ORDER BY policyname`,
    );
    // The two policies, plus exactly the reviewed copies a later migration
    // adds for a dedicated login (none on a bed without it).
    const copies = await reviewedPolicyCopies(su, 'public.worker_referred_jobs');
    const byName = (a: { policyname: string }, b: { policyname: string }) =>
      (a.policyname < b.policyname ? -1 : a.policyname > b.policyname ? 1 : 0);
    expect([...policies.rows].sort(byName)).toEqual([
      { policyname: 'worker_referred_jobs_owner', cmd: 'ALL', roles: ['jale_admin'] },
      { policyname: 'worker_referred_jobs_whatsapp', cmd: 'ALL', roles: ['jale_whatsapp'] },
      ...copies.map(({ policyname, cmd, roles }) => ({ policyname, cmd, roles })),
    ].sort(byName));
  });

  // ── 5. the predicates are the boundary (a session RLS does not filter) ──
  it("5. as a session RLS does not filter, scopes every read to the worker by its own predicates", async () => {
    const c = su as unknown as PoolClient;
    await su.query('BEGIN');
    try {
      // Worker A's settings, as each real caller sets them. They are
      // inert for the superuser, which is the point: only the SQL scopes it.
      await setRlsContext(su, subA);
      await setInternalUserRlsContext(su, workerA);

      // A's referred jobs, one door each, at distinct instants.
      for (const [jobId, source, at] of [
        [jobOpenOld, 'job_page', 10], [jobOpenNew, 'share_link', 12],
        [jobApplied, 'typed_code', 13], [jobClosed, 'whatsapp_token', 14],
      ] as const) {
        expect(await recordReferredJob(c, { workerId: workerA, jobId, source, now: day(at) })).toBe(true);
      }
      // B's rows are NEWER than every one of A's, so a statement that lost its
      // worker predicate would put them first. B and A share jobOpenOld.
      for (const jobId of [jobOfB, jobOpenOld]) {
        expect(await recordReferredJob(c, { workerId: workerB, jobId, source: 'job_page', now: day(30) })).toBe(true);
      }

      // A re-record refreshes last_seen_at and source, and keeps first_seen_at.
      expect(await recordReferredJob(c, {
        workerId: workerA, jobId: jobOpenOld, source: 'share_link', now: day(11),
      })).toBe(true);
      expect((await referredRows(su, [workerA])).filter((r) => r.startsWith('workerA jobOpenOld ')))
        .toEqual([`workerA jobOpenOld share_link ${day(10).toISOString()} ${day(11).toISOString()}`]);

      // Only an active job is ever recorded: paused or unknown writes nothing.
      expect(await recordReferredJob(c, {
        workerId: workerA, jobId: jobPaused, source: 'job_page', now: day(15),
      })).toBe(false);
      expect(await recordReferredJob(c, {
        workerId: workerA, jobId: randomUUID(), source: 'job_page', now: day(15),
      })).toBe(false);
      expect(await countRows(su,
        'SELECT count(*)::int AS n FROM worker_referred_jobs WHERE worker_id = $1 AND job_id = $2',
        [workerA, jobPaused])).toBe(0);

      // A's job closes and A applies to another. B applies to one of A's open
      // jobs, which must not hide it from A.
      await su.query(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [jobClosed]);
      await su.query(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $2, 'pending'), ($3, $4, 'pending')`,
        [jobApplied, workerA, jobOpenNew, workerB],
      );

      expect(await listOpenReferredJobIds(c, workerA)).toEqual([jobOpenNew, jobOpenOld]);
      expect(await listOpenReferredJobIds(c, workerA, { limit: 1 })).toEqual([jobOpenNew]);
      // B's two rows tie on last_seen_at, so job_id decides -- deterministically.
      expect(await listOpenReferredJobIds(c, workerB)).toEqual([jobOfB, jobOpenOld].sort());

      // The Done screen: jobClosed is A's newest, but open jobs come first.
      expect(await getReferredJobForOnboarding(c, workerA)).toEqual({
        id: jobOpenNew,
        title: 'S27 103 open new',
        company: 'Jale',
        location: 'El Paso, TX',
        payMin: 22,
        payMax: 26,
        payInterval: 'hourly',
        payRaw: '$22-$26/hour',
        open: true,
      });
      // Once A has applied to every open one, the closed job surfaces -- closed.
      await su.query(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $3, 'pending'), ($2, $3, 'pending')`,
        [jobOpenNew, jobOpenOld, workerA],
      );
      expect(await listOpenReferredJobIds(c, workerA)).toEqual([]);
      expect(await getReferredJobForOnboarding(c, workerA)).toEqual({
        id: jobClosed,
        title: 'S27 103 closed',
        company: 'NB Construction',
        location: 'Las Cruces, NM',
        payMin: null,
        payMax: null,
        payInterval: null,
        payRaw: null,
        open: false,
      });
      // ...and B's list is untouched by anything A did.
      expect(await getReferredJobForOnboarding(c, workerB)).toMatchObject({ id: [jobOfB, jobOpenOld].sort()[0] });
    } finally {
      // Everything above rolls back: jobs reopen, applications vanish.
      await su.query('ROLLBACK');
    }
  });

  // ── 6-8. the policies, one role at a time ─────────────────────────
  it('6. jale_whatsapp, keyed on app.current_internal_user_id: its own worker only, and a foreign write is an error', async () => {
    // A committed row for B that this session must never see or touch.
    await su.query(
      `INSERT INTO worker_referred_jobs (worker_id, job_id, source, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'job_page', $3, $3)`,
      [workerB, jobOfB, day(30)],
    );

    const wa = await connectAs('jale_whatsapp');
    const c = wa as unknown as PoolClient;
    try {
      await wa.query('BEGIN');
      await setInternalUserRlsContext(wa, workerA);

      expect(await recordReferredJob(c, {
        workerId: workerA, jobId: jobOpenOld, source: 'whatsapp_token', now: day(20),
      })).toBe(true);
      expect(await listOpenReferredJobIds(c, workerA)).toEqual([jobOpenOld]);
      expect(await getReferredJobForOnboarding(c, workerA)).toMatchObject({ id: jobOpenOld, open: true });

      // B's row exists, but not to this session -- not even when asked by id.
      expect(await listOpenReferredJobIds(c, workerB)).toEqual([]);
      expect(await getReferredJobForOnboarding(c, workerB)).toBeNull();
      expect(await referredRows(wa, [workerA, workerB]))
        .toEqual([`workerA jobOpenOld whatsapp_token ${day(20).toISOString()} ${day(20).toISOString()}`]);

      // Writing for B fails WITH CHECK, and refreshing B's existing row fails
      // the UPDATE USING check: both errors, never a silent zero-row success.
      await wa.query('SAVEPOINT foreign_insert');
      await expect(recordReferredJob(c, {
        workerId: workerB, jobId: jobOpenNew, source: 'whatsapp_token', now: day(20),
      })).rejects.toThrow(/row-level security/);
      await wa.query('ROLLBACK TO SAVEPOINT foreign_insert');
      await wa.query('SAVEPOINT foreign_refresh');
      await expect(recordReferredJob(c, {
        workerId: workerB, jobId: jobOfB, source: 'whatsapp_token', now: day(21),
      })).rejects.toThrow(/row-level security/);
      await wa.query('ROLLBACK TO SAVEPOINT foreign_refresh');
    } finally {
      await wa.query('ROLLBACK').catch(() => undefined);
      await wa.end();
    }
    // B's row is exactly as committed.
    expect(await referredRows(su, [workerB]))
      .toEqual([`workerB jobOfB job_page ${day(30).toISOString()} ${day(30).toISOString()}`]);
  });

  // Checks row policies as the standard and request test beds apply them.
  itInProfiles(['standard', 'request'], '7. the worker_referred_jobs_owner policy, keyed on app.current_user_id: its own worker only, and a foreign write is an error', async () => {
    const adm = await connectAs('jale_admin');
    const c = adm as unknown as PoolClient;
    try {
      await adm.query('BEGIN');
      await setRlsContext(adm, subA);

      expect(await recordReferredJob(c, {
        workerId: workerA, jobId: jobOpenOld, source: 'job_page', now: day(22),
      })).toBe(true);
      expect(await listOpenReferredJobIds(c, workerA)).toEqual([jobOpenOld]);
      expect(await getReferredJobForOnboarding(c, workerA)).toMatchObject({ id: jobOpenOld, open: true });

      expect(await listOpenReferredJobIds(c, workerB)).toEqual([]);
      expect(await getReferredJobForOnboarding(c, workerB)).toBeNull();
      expect(await referredRows(adm, [workerA, workerB]))
        .toEqual([`workerA jobOpenOld job_page ${day(22).toISOString()} ${day(22).toISOString()}`]);

      await adm.query('SAVEPOINT foreign_insert');
      await expect(recordReferredJob(c, {
        workerId: workerB, jobId: jobOpenNew, source: 'job_page', now: day(22),
      })).rejects.toThrow(/row-level security/);
      await adm.query('ROLLBACK TO SAVEPOINT foreign_insert');
      await adm.query('SAVEPOINT foreign_refresh');
      await expect(recordReferredJob(c, {
        workerId: workerB, jobId: jobOfB, source: 'job_page', now: day(23),
      })).rejects.toThrow(/row-level security/);
      await adm.query('ROLLBACK TO SAVEPOINT foreign_refresh');
    } finally {
      await adm.query('ROLLBACK').catch(() => undefined);
      await adm.end();
    }
  });

  // Checks row policies as the standard and request test beds apply them.
  itInProfiles(['standard', 'request'], '8. without a setting -- or with the empty one a warm pooled connection carries -- both roles see and write nothing', async () => {
    for (const role of ['jale_whatsapp', 'jale_admin'] as const) {
      const client = await connectAs(role);
      const c = client as unknown as PoolClient;
      const guc = role === 'jale_whatsapp' ? 'app.current_internal_user_id' : 'app.current_user_id';
      try {
        await client.query('BEGIN');
        for (const setting of [null, ''] as const) {
          if (setting !== null) {
            // ::text in the jale_whatsapp policy is what makes '' a non-match
            // rather than a 22P02 on every statement.
            await client.query(`SELECT set_config($1, $2, true)`, [guc, setting]);
          }
          // B's committed row from case 6 is there; this session sees none of it.
          expect(await referredRows(client, [workerA, workerB])).toEqual([]);
          expect(await listOpenReferredJobIds(c, workerB)).toEqual([]);

          await client.query('SAVEPOINT bare_insert');
          await expect(client.query(
            `INSERT INTO worker_referred_jobs (worker_id, job_id, source) VALUES ($1, $2, 'job_page')`,
            [workerA, jobOpenOld],
          )).rejects.toThrow(/row-level security/);
          await client.query('ROLLBACK TO SAVEPOINT bare_insert');

          // Through the library the two roles differ only in WHERE they stop:
          // jale_whatsapp sees every job (jobs_read_wa) and is refused by
          // WITH CHECK; on the bed, the owner login sees no job without a
          // worker sub, so the INSERT ... SELECT has nothing to insert.
          await client.query('SAVEPOINT library_insert');
          const recorded = recordReferredJob(c, {
            workerId: workerA, jobId: jobOpenOld, source: 'job_page', now: day(24),
          });
          if (role === 'jale_whatsapp') await expect(recorded).rejects.toThrow(/row-level security/);
          else await expect(recorded).resolves.toBe(false);
          await client.query('ROLLBACK TO SAVEPOINT library_insert');
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    }
  });

  // ── 9. rows leave with their job ──────────────────────────────────
  it("9. an employer's hard delete removes the job from every worker's list -- the CASCADE runs on the owner's DELETE", async () => {
    await su.query(
      `INSERT INTO worker_referred_jobs (worker_id, job_id, source)
       VALUES ($1, $3, 'job_page'), ($2, $3, 'share_link')`,
      [workerA, workerB, jobDoomed],
    );

    // Mirrors employer-jobs-delete.ts's delete on the bed, with the EMPLOYER's
    // sub set and row policies forced on every table involved. PostgreSQL
    // runs the cascade's DELETE as worker_referred_jobs' owner, so it needs no
    // DELETE grant -- only the owner's own privilege, which 103 deliberately
    // leaves alone.
    const adm = await connectAs('jale_admin');
    try {
      await adm.query('BEGIN');
      await setRlsContext(adm, employerSub);
      const deleted = await adm.query('DELETE FROM jobs WHERE id = $1', [jobDoomed]);
      expect(deleted.rowCount).toBe(1);
      await adm.query('COMMIT');
    } finally {
      await adm.query('ROLLBACK').catch(() => undefined);
      await adm.end();
    }

    expect(await countRows(su,
      'SELECT count(*)::int AS n FROM worker_referred_jobs WHERE job_id = $1', [jobDoomed])).toBe(0);
  });

  // ── 10-11. the two referral-schema repairs 103 folds in ─────────────
  it("10. an employer can hard-delete a worker's first-touch job: first_job_id goes NULL, the credit stays, nothing else may change", async () => {
    // A first touch the way the attribution writers record one.
    await su.query(
      `INSERT INTO worker_attribution
         (worker_id, first_share_code, first_channel, first_job_id, first_referrer_worker_id,
          first_seen_at, latest_job_id, latest_seen_at)
       VALUES ($1, 'S27A1TCH', 'whatsapp', $2, $3, $4, $2, $4)`,
      [wTouch, jobTouched, w1, day(7)],
    );
    const before = await firstTouch(wTouch);
    expect(before.first_job_id).toBe(jobTouched);

    // employer-jobs-delete.ts's own statements, as the role and setting it
    // runs them with. The job's ON DELETE SET NULL on first_job_id is an
    // UPDATE of worker_attribution, which 056/063's trigger used to reject.
    const adm = await connectAs('jale_admin');
    try {
      await adm.query('BEGIN');
      await setRlsContext(adm, employerSub);
      let jobsDeleted = -1;
      for (const statement of jobDeleteStatements()) {
        const result = await adm.query(statement, [jobTouched]);
        if (statement.startsWith('DELETE FROM jobs ')) jobsDeleted = result.rowCount ?? 0;
      }
      expect(jobsDeleted).toBe(1);
      await adm.query('COMMIT');
    } finally {
      await adm.query('ROLLBACK').catch(() => undefined);
      await adm.end();
    }

    // The job is gone; the credit is not: code, channel, referrer and time
    // are untouched, only the job reference cleared.
    expect(await firstTouch(wTouch)).toEqual({ ...before, first_job_id: null });

    // Every other first-touch change still raises restrict_violation:
    // a job appearing where there was none,
    await expect(su.query(
      `UPDATE worker_attribution SET first_job_id = $2 WHERE worker_id = $1`, [wTouch, jobElsewhere],
    )).rejects.toMatchObject({ code: '23001' });
    // one job replacing another (w3's first touch is still jobSame),
    await expect(su.query(
      `UPDATE worker_attribution SET first_job_id = $2 WHERE worker_id = $1`, [w3, jobElsewhere],
    )).rejects.toMatchObject({ code: '23001' });
    // and any other first_* column.
    await expect(su.query(
      `UPDATE worker_attribution SET first_channel = 'sms' WHERE worker_id = $1`, [wTouch],
    )).rejects.toMatchObject({ code: '23001' });
  });

  it('11. deleting a worker who claimed a referral removes the claim with them, instead of failing the coherence CHECK', async () => {
    const phone = randomBytes(32).toString('hex');
    await su.query(
      `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at, claimed_at, claimed_worker_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [phone, jobOpenOld, day(60), day(8), wClaimer],
    );

    // Any account delete: the users row goes and the foreign keys do the rest.
    // SET NULL used to clear claimed_worker_id and leave claimed_at, a 23514.
    const deleted = await su.query(`DELETE FROM users WHERE id = $1`, [wClaimer]);
    expect(deleted.rowCount).toBe(1);
    expect(await countRows(su,
      'SELECT count(*)::int AS n FROM referral_pending_claims WHERE phone_hash = $1', [phone])).toBe(0);

    // CASCADE removed the row; it did not relax the rule.
    expect(await countRows(su,
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'public.referral_pending_claims'::regclass
          AND conname = 'referral_pending_claims_claimed_coherent'`, [])).toBe(1);
  });

  // ── 12. the feed pins the list ────────────────────────────────────
  it("12. the feed pins the worker's open, unapplied referred jobs -- and a failing pin read leaves the caller's transaction usable", async () => {
    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type, main_trade, main_trade_other)
       VALUES ($1, $2, 'worker', 'other', 'Qzxv')`,
      [wFeed, `s27-103-feed-${tag}`],
    );
    // A paused job (a backfilled pair need not be active) and an applied one
    // must stay off; B's application must not hide wFeed's job.
    await su.query(
      `INSERT INTO worker_referred_jobs (worker_id, job_id, source, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'share_link', $6, $6), ($1, $3, 'job_page', $7, $7),
              ($1, $4, 'backfill', $8, $8), ($1, $5, 'typed_code', $9, $9)`,
      [wFeed, jobOpenOld, jobOpenNew, jobPaused, jobApplied, day(40), day(41), day(42), day(43)],
    );
    await su.query(
      `INSERT INTO job_applications (job_id, worker_id, status)
       VALUES ($1, $2, 'pending'), ($3, $4, 'pending')`,
      [jobApplied, wFeed, jobOpenNew, workerB],
    );
    const feed = async (client: Client) => (await listMatchedJobsForWorker(
      client as unknown as PoolClient, wFeed, { limit: 5, channel: 'whatsapp' },
    ));
    const named = (jobs: Array<{ id: string }>) => jobs.map((job) => labels.get(job.id) ?? job.id);

    // The superuser, which no policy filters: the predicates alone. The
    // savepoint needs the transaction every real caller holds.
    await su.query('BEGIN');
    try {
      const jobs = await feed(su);
      expect(named(jobs)).toEqual(['jobOpenNew', 'jobOpenOld']);
      expect(jobs.every((job) => job.match_reasons[0] === 'referred_job')).toBe(true);
    } finally {
      await su.query('ROLLBACK');
    }

    const wa = await connectAs('jale_whatsapp');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Exactly what TRABAJOS sets before it lists (processor.ts).
      const trabajos = async () => {
        await wa.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [wFeed]);
        return feed(wa);
      };
      await wa.query('BEGIN');
      expect(named(await trabajos())).toEqual(['jobOpenNew', 'jobOpenOld']);
      await wa.query('ROLLBACK');
      expect(warn).not.toHaveBeenCalled();

      // The revoke runs between transactions, so it never waits on this
      // session's locks.
      await su.query(`REVOKE SELECT ON worker_referred_jobs FROM jale_whatsapp`);
      try {
        await wa.query('BEGIN');
        expect(await trabajos()).toEqual([]);
        // Without the savepoint this is 25P02 and the whole TRABAJOS turn is
        // lost with the pin.
        await expect(wa.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
        await wa.query('ROLLBACK');
      } finally {
        await su.query(`GRANT SELECT ON worker_referred_jobs TO jale_whatsapp`);
      }
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))))
        .toEqual([{ metric: 'ReferredJobPinFailed', reason: 'error' }]);
    } finally {
      warn.mockRestore();
      await wa.query('ROLLBACK').catch(() => undefined);
      await wa.end();
    }
  });
});
