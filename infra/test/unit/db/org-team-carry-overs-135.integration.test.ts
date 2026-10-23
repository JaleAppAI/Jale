/**
 * org-team-carry-overs-135 -- migration 135 on a real bed: conversations
 * follow their job, the hire-details nudge goes to the company's owner when
 * the job's member is not active, and the owner's digest session reads the
 * whole company. Code under test runs on its real login (jale_api,
 * jale_job_digest) with the caller context set, as the Lambdas set it.
 *
 *  - the catalog (all profiles): jobs_id_employer_id_key UNIQUE (id,
 *    employer_id); job_conversations_job_employer_fkey (job_id, employer_id)
 *    -> jobs (id, employer_id) ON UPDATE CASCADE ON DELETE CASCADE,
 *    validated; claim_hire_details_nudges keeps its owner, definer security,
 *    pinned search_path, result and one caller; the two nudge-owner policies
 *    and the five digest policies (each 119's jale_api twin, TO
 *    jale_job_digest); the digest login's EXECUTE on the two org helpers and
 *    USAGE on jale_internal; the nudge owner's four organization_members
 *    columns;
 *  - the cascade: an owner moving a job (jale_api, company lock first) moves
 *    its open and closed conversations in the same statement, created_by is
 *    kept, an in-flight outbox row stays pending and addressed to the worker,
 *    the new member reads the conversation and the old one does not; a
 *    conversation naming another employer than its job's is refused (105's
 *    guard, and the foreign key on its own); deleting a job still deletes its
 *    conversations;
 *  - the nudge (jale_job_digest): an active member, the owner and a login
 *    with no company keep their own; a suspended or removed member's goes to
 *    the active owner; one row per application;
 *  - the digest (jale_job_digest): the owner reads every member's jobs,
 *    applications, rankings and applicants' profiles and skills, and
 *    listEmployerCandidates lists a foreman's applicant with contact; a
 *    foreman reads only their own; a suspended or removed member's
 *    org_member_scope is empty and their session reads no other member's
 *    job;
 *  - hire details through the real handler (deferred from Task 1's gate):
 *    the owner saves on a foreman's hire (200); foreman B and a stranger are
 *    refused (404 not_found) and nothing changes.
 * Fixtures are written through the superuser URL (Task 1's World) and removed
 * in afterAll; read-only cases run in transactions that are rolled back.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *   --container <name> --port <port> -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/org-team-carry-overs-135.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { Client, Pool, PoolClient } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { listEmployerCandidates } from '../../../lambda/lib/employer-candidate-ranking';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World, type UserFixture } from './r-paths-world';
import { describeInProfiles, loginUrl, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: hireDetails } = require('../../../lambda/api/employer-application-hire-details');

if (!databaseUrl) {
  test('CONCERN: org-team-carry-overs-135 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;
const ROW_PROFILES = ['standard', 'request'] as const;

const NUDGE_SQL = `SELECT application_id, job_id, employer_id, employer_email, worker_name, job_title, kind, requested_at
                     FROM jale_cap.claim_hire_details_nudges($1)`;

/** The five digest policies and the 119 jale_api policy each copies. */
const DIGEST_POLICIES: Array<[table: string, policy: string, twin: string]> = [
  ['public.employer_candidate_rankings', 'employer_candidate_rankings_job_digest_org_owner_read', 'employer_candidate_rankings_org_owner_read'],
  ['public.job_applications', 'applications_job_digest_org_owner_select', 'applications_org_owner_select'],
  ['public.jobs', 'jobs_job_digest_org_owner_select', 'jobs_org_owner_select'],
  ['public.worker_profiles', 'worker_profiles_job_digest_org_owner_read', 'worker_profiles_org_owner_read'],
  ['public.worker_skills', 'worker_skills_job_digest_org_owner_read', 'worker_skills_org_owner_read'],
];

interface Context { sub?: string; internal?: string }

/** Runs `fn` on `login` in one transaction with the caller context set; commits only when asked. */
async function asLogin<T>(login: string, ctx: Context, fn: (c: Client) => Promise<T>, commit = false): Promise<T> {
  return withLoginClient(login, async (c) => {
    await c.query('BEGIN');
    let done = false;
    try {
      if (ctx.sub) await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.sub]);
      if (ctx.internal) await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [ctx.internal]);
      const result = await fn(c);
      if (commit) {
        await c.query('COMMIT');
        done = true;
      }
      return result;
    } finally {
      if (!done) await c.query('ROLLBACK');
    }
  });
}
const as = (p: UserFixture): Context => ({ sub: p.sub, internal: p.id });

describeInProfiles([...ALL_PROFILES], 'migration 135: the catalog', () => {
  let world: World;
  beforeAll(async () => {
    world = new World(databaseUrl!);
    await world.connect();
  });
  afterAll(async () => { await world.end(); });

  it('the composite FK is ON UPDATE CASCADE ON DELETE CASCADE and validated', async () => {
    const { rows } = await world.su.query(
      `SELECT c.conrelid::regclass::text AS rel, c.conname, c.contype, c.convalidated, c.condeferrable,
              pg_catalog.pg_get_constraintdef(c.oid) AS def
         FROM pg_catalog.pg_constraint c
        WHERE c.conname IN ('jobs_id_employer_id_key', 'job_conversations_job_employer_fkey')
        ORDER BY c.conname`);
    expect(rows).toEqual([
      { rel: 'job_conversations', conname: 'job_conversations_job_employer_fkey', contype: 'f', convalidated: true,
        condeferrable: false,
        def: 'FOREIGN KEY (job_id, employer_id) REFERENCES jobs(id, employer_id) ON UPDATE CASCADE ON DELETE CASCADE' },
      { rel: 'jobs', conname: 'jobs_id_employer_id_key', contype: 'u', convalidated: true, condeferrable: false,
        def: 'UNIQUE (id, employer_id)' },
    ]);
    // The referencing side's index (135), for every key change or delete on jobs.
    expect((await world.su.query(
      `SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname = 'job_conversations_job_id_employer_id_idx'`)).rows)
      .toEqual([{ indexdef: 'CREATE INDEX job_conversations_job_id_employer_id_idx ON public.job_conversations USING btree (job_id, employer_id)' }]);
    // The job-only cascade (025) stays beside it.
    expect((await world.su.query(
      `SELECT pg_catalog.pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.job_conversations'::regclass AND conname = 'job_conversations_job_id_fkey'`)).rows)
      .toEqual([{ def: 'FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE' }]);
  });

  it('the nudge function keeps its owner and caller', async () => {
    const { rows } = await world.su.query(
      `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              l.lanname AS language, pg_catalog.pg_get_function_result(p.oid) AS returns,
              ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                      FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1) AS callers,
              p.prosrc LIKE '%LEFT JOIN public.organization_members em ON em.user_id = j.employer_id%' AS routes
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
        WHERE p.oid = 'jale_cap.claim_hire_details_nudges(integer)'::regprocedure`);
    expect(rows).toEqual([{
      owner: 'jale_cap_hire_nudges', definer: true, config: ['search_path=pg_catalog, pg_temp'], language: 'plpgsql',
      returns: 'TABLE(application_id uuid, job_id uuid, employer_id uuid, employer_email text, worker_name text, job_title text, kind text, requested_at timestamp with time zone)',
      callers: ['jale_job_digest'], routes: true,
    }]);
  });

  it('the nudge owner reads four organization_members columns and the active owners\' users rows, under two SELECT policies', async () => {
    const { rows } = await world.su.query(
      `SELECT p.polrelid::regclass::text AS rel, p.polname, p.polcmd, p.polpermissive,
              ARRAY(SELECT pg_catalog.pg_get_userbyid(r)::text FROM unnest(p.polroles) r) AS roles,
              pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using, p.polwithcheck IS NULL AS no_check
         FROM pg_catalog.pg_policy p
        WHERE p.polname IN ('organization_members_cap_hire_nudges_select', 'users_cap_hire_nudges_org_owner_select')
        ORDER BY p.polname`);
    expect(rows).toEqual([
      { rel: 'organization_members', polname: 'organization_members_cap_hire_nudges_select', polcmd: 'r', polpermissive: true,
        roles: ['jale_cap_hire_nudges'], using: 'true', no_check: true },
      { rel: 'users', polname: 'users_cap_hire_nudges_org_owner_select', polcmd: 'r', polpermissive: true,
        roles: ['jale_cap_hire_nudges'],
        using: "(id IN ( SELECT m.user_id\n   FROM organization_members m\n  WHERE ((m.role = 'owner'::text) AND (m.status = 'active'::text))))",
        no_check: true },
    ]);
    const grants = await world.su.query<{ grant: string }>(
      `SELECT a.attname || ':' || p.privilege AS grant
         FROM pg_catalog.pg_attribute a
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
        WHERE a.attrelid = 'public.organization_members'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege('jale_cap_hire_nudges', a.attrelid, a.attname, p.privilege)
        ORDER BY 1`);
    expect(grants.rows.map((r) => r.grant))
      .toEqual(['organization_id:SELECT', 'role:SELECT', 'status:SELECT', 'user_id:SELECT']);
    expect((await world.su.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_policy WHERE 'jale_cap_hire_nudges'::regrole::oid = ANY (polroles)`)).rows[0].n)
      .toBe(7);
  });

  it('each digest policy is 119\'s jale_api owner policy, for jale_job_digest', async () => {
    for (const [table, policy, twin] of DIGEST_POLICIES) {
      const { rows } = await world.su.query(
        `SELECT ARRAY(SELECT pg_catalog.pg_get_userbyid(r)::text FROM unnest(p.polroles) r) AS roles, p.polcmd, p.polpermissive,
                pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using, p.polwithcheck IS NULL AS no_check,
                pg_catalog.pg_get_expr(t.polqual, t.polrelid) AS twin_using,
                ARRAY(SELECT pg_catalog.pg_get_userbyid(r)::text FROM unnest(t.polroles) r) AS twin_roles, t.polcmd AS twin_cmd
           FROM pg_catalog.pg_policy p
           JOIN pg_catalog.pg_policy t ON t.polrelid = p.polrelid AND t.polname = $3
          WHERE p.polrelid = $1::regclass AND p.polname = $2`, [table, policy, twin]);
      expect([policy, rows.length]).toEqual([policy, 1]);
      const row = rows[0];
      expect([policy, row.roles, row.polcmd, row.polpermissive, row.no_check, row.twin_roles, row.twin_cmd])
        .toEqual([policy, ['jale_job_digest'], 'r', true, true, ['jale_api'], 'r']);
      expect([policy, row.using]).toEqual([policy, row.twin_using]);
      expect(row.using).toContain("jale_internal.org_owner_scope(current_setting('app.current_internal_user_id'::text, true), false)");
    }
  });

  it('the digest login may call the two org helpers, and resolve them in jale_internal', async () => {
    const { rows } = await world.su.query(
      `SELECT has_function_privilege('jale_job_digest', 'jale_internal.org_owner_scope(text, boolean)', 'EXECUTE') AS owner_scope,
              has_function_privilege('jale_job_digest', 'jale_internal.org_member_scope(text)', 'EXECUTE') AS member_scope,
              has_function_privilege('jale_job_digest', 'jale_internal.is_org_owner_of(text, uuid)', 'EXECUTE') AS is_owner_of,
              has_schema_privilege('jale_job_digest', 'jale_internal', 'USAGE') AS usage,
              has_schema_privilege('jale_job_digest', 'jale_internal', 'CREATE') AS can_create`);
    expect(rows).toEqual([{ owner_scope: true, member_scope: true, is_owner_of: false, usage: true, can_create: false }]);
  });
});

describeInProfiles([...ROW_PROFILES], 'migration 135: conversations, nudges and digests on the bed', () => {
  let world: World;
  let owner: UserFixture;
  let foremanA: UserFixture;
  let foremanB: UserFixture;
  let stranger: UserFixture;
  const bareLogins: string[] = [];

  beforeAll(async () => {
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 2 }, 'jale_api', 'test');
    world = new World(databaseUrl!);
    await world.connect();
    owner = await world.employer({ companyName: 'Carry Co' });
    foremanA = await world.foreman(owner.id, { fullName: 'Fixture Foreman A' });
    foremanB = await world.foreman(owner.id, { fullName: 'Fixture Foreman B' });
    stranger = await world.employer({ companyName: 'Other Carry Co' });
  });
  afterAll(async () => {
    try {
      await world.su.query(`DELETE FROM job_message_outbox WHERE conversation_id IN (
          SELECT id FROM job_conversations WHERE employer_id = ANY($1::uuid[]) OR worker_id = ANY($1::uuid[]))`, [world.users]);
      await world.su.query(`DELETE FROM employer_candidate_rankings WHERE worker_id = ANY($1::uuid[])`, [world.users]);
      await world.su.query(`DELETE FROM worker_skills WHERE worker_id = ANY($1::uuid[])`, [world.users]);
      await world.su.query(`DELETE FROM worker_profiles WHERE user_id = ANY($1::uuid[])`, [world.users]);
      await world.su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [bareLogins]);
      await world.cleanup();
      await world.su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [bareLogins]);
    } finally {
      await world.end();
      await mockPool?.end();
      mockPool = undefined;
    }
  });

  /** An employer login with no company (a sign-up that never got one). */
  async function bareLogin(): Promise<UserFixture> {
    const id = randomUUID();
    const sub = `fixture-employer-${randomUUID()}`;
    await world.su.query(
      `INSERT INTO users (id, cognito_sub, user_type, full_name, email, tos_version)
       VALUES ($1, $2, 'employer', 'Bare Login', $3, $4)`, [id, sub, `${id}@fixture.invalid`, FIXTURE_TOS_VERSION]);
    bareLogins.push(id);
    return { id, sub };
  }
  const emailOf = async (p: UserFixture): Promise<string> =>
    (await world.su.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.id])).rows[0].email;

  /** A job of `employerId` with one applicant in each of `statuses`, and a conversation for each. */
  async function threads(employerId: string, conversations: Array<'open' | 'closed'>, jobStatus: 'active' | 'paused' = 'paused') {
    const job = await world.job(employerId, { status: jobStatus });
    const rows = [];
    for (const status of conversations) {
      const worker = await world.worker();
      const applicationId = await world.application(job.id, worker.id);
      const conversationId = await world.conversation({ jobId: job.id, employerId, workerId: worker.id, applicationId });
      if (status === 'closed') {
        await world.su.query(`UPDATE job_conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [conversationId]);
      }
      rows.push({ worker, applicationId, conversationId });
    }
    return { job, rows };
  }

  /**
   * A hired application on a new job of `employerId`, due for its nudge, no details. Hired
   * 6 days 23 hours ago, near the start of the 7-day window: the claim takes the oldest due
   * rows first (at most 200), so this suite's rows come before other suites' leftovers.
   */
  async function dueHire(employerId: string) {
    const job = await world.job(employerId, { title: `Fixture Nudge ${randomUUID().slice(0, 8)}`, numberOfWorkersNeeded: 5 });
    const worker = await world.worker({ fullName: 'Fixture Nudged Worker' });
    const applicationId = await world.application(job.id, worker.id, 'hired');
    await world.su.query(`UPDATE job_applications SET hired_at = now() - interval '6 days 23 hours' WHERE id = $1`, [applicationId]);
    return { jobId: job.id, applicationId };
  }

  describe('conversations follow their job', () => {
    it('moving a job moves its open and closed conversations in the same statement', async () => {
      const t = await threads(foremanA.id, ['open', 'closed']);
      const message = await world.message(t.rows[0].conversationId, 'Fixture in flight');
      const outbox = await world.outbox(t.rows[0].conversationId, message, t.rows[0].worker.phone!, 'Fixture in flight');
      const createdBy = (await world.su.query('SELECT created_by_user_id FROM jobs WHERE id = $1', [t.job.id])).rows[0];

      const moved = await asLogin('jale_api', as(owner), async (c) => {
        await c.query('SELECT active_jobs FROM jale_cap.employer_org_usage(true)');
        const res = await c.query('UPDATE jobs SET employer_id = $1 WHERE id = $2', [foremanB.id, t.job.id]);
        // Right after the UPDATE, before COMMIT: the cascade already ran inside it,
        // so the owner's own session reads the moved rows.
        const seen = await c.query<{ id: string; employer_id: string }>(
          'SELECT id, employer_id FROM job_conversations WHERE job_id = $1 ORDER BY id', [t.job.id]);
        return { count: res.rowCount, seen: seen.rows };
      }, true);
      expect(moved.count).toBe(1);
      expect(moved.seen.map((r) => r.employer_id)).toEqual([foremanB.id, foremanB.id]);

      const after = await world.su.query<{ id: string; employer_id: string; status: string; worker_id: string }>(
        'SELECT id, employer_id, status, worker_id FROM job_conversations WHERE job_id = $1', [t.job.id]);
      expect(after.rows.map((r) => [r.id, r.employer_id, r.status]).sort())
        .toEqual([[t.rows[0].conversationId, foremanB.id, 'open'], [t.rows[1].conversationId, foremanB.id, 'closed']].sort());
      // job_conversations_open_unique still holds: one open conversation per (job, employer, worker).
      expect((await world.su.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM job_conversations WHERE job_id = $1 AND status = 'open'
            GROUP BY job_id, employer_id, worker_id HAVING count(*) > 1) d`, [t.job.id])).rows[0].n).toBe(0);
      expect((await world.su.query('SELECT created_by_user_id FROM jobs WHERE id = $1', [t.job.id])).rows[0]).toEqual(createdBy);

      // The in-flight outbox row is untouched: still pending, still the worker's number, still the worker's to flush.
      expect((await world.su.query(
        `SELECT o.status, o.whatsapp_number, jc.worker_id, jc.employer_id FROM job_message_outbox o
           JOIN job_conversations jc ON jc.id = o.conversation_id WHERE o.id = $1`, [outbox])).rows)
        .toEqual([{ status: 'pending', whatsapp_number: t.rows[0].worker.phone, worker_id: t.rows[0].worker.id, employer_id: foremanB.id }]);

      // The new member reads the conversation; the old one no longer does.
      const read = (p: UserFixture) => asLogin('jale_api', as(p), async (c) =>
        (await c.query('SELECT id FROM job_conversations WHERE job_id = $1', [t.job.id])).rowCount);
      expect(await read(foremanB)).toBe(2);
      expect(await read(foremanA)).toBe(0);
    });

    it('a conversation cannot name another employer than its job\'s', async () => {
      const t = await threads(foremanA.id, []);
      const worker = await world.worker();
      const applicationId = await world.application(t.job.id, worker.id);
      const insert = `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id) VALUES ($1, $2, $3, $4)`;

      await world.su.query('BEGIN');
      try {
        await world.su.query('SAVEPOINT guarded');
        const guarded = await world.su.query(insert, [t.job.id, foremanB.id, worker.id, applicationId]).catch((e) => e);
        expect(['23503', '23514']).toContain(guarded.code);
        await world.su.query('ROLLBACK TO SAVEPOINT guarded');
        // Without 105's guard, the foreign key alone refuses it.
        await world.su.query('ALTER TABLE job_conversations DISABLE TRIGGER job_conversations_application_guard');
        const keyed = await world.su.query(insert, [t.job.id, foremanB.id, worker.id, applicationId]).catch((e) => e);
        expect({ code: keyed.code, constraint: keyed.constraint })
          .toEqual({ code: '23503', constraint: 'job_conversations_job_employer_fkey' });
      } finally {
        await world.su.query('ROLLBACK');
      }
      expect((await world.su.query('SELECT count(*)::int AS n FROM job_conversations WHERE job_id = $1', [t.job.id])).rows[0].n).toBe(0);
    });

    it('deleting a job still deletes its conversations', async () => {
      const t = await threads(foremanA.id, ['open', 'closed']);
      const message = await world.message(t.rows[0].conversationId, 'Fixture before delete');
      await world.outbox(t.rows[0].conversationId, message, t.rows[0].worker.phone!, 'Fixture before delete');
      const ids = t.rows.map((r) => r.conversationId);

      const deleted = await asLogin('jale_api', as(owner), async (c) =>
        (await c.query('DELETE FROM jobs WHERE id = $1', [t.job.id])).rowCount, true);
      expect(deleted).toBe(1);
      expect((await world.su.query(
        `SELECT (SELECT count(*)::int FROM job_conversations WHERE id = ANY($1::uuid[])) AS conversations,
                (SELECT count(*)::int FROM job_conversation_messages WHERE conversation_id = ANY($1::uuid[])) AS messages,
                (SELECT count(*)::int FROM job_message_outbox WHERE conversation_id = ANY($1::uuid[])) AS outbox`, [ids])).rows[0])
        .toEqual({ conversations: 0, messages: 0, outbox: 0 });
    });

    it('remove-with-reassign\'s statement moves every conversation of every job of the member', async () => {
      const from = await world.foreman(owner.id, { fullName: 'Fixture Leaving Foreman' });
      const to = await world.foreman(owner.id, { fullName: 'Fixture Taking Foreman' });
      const first = await threads(from.id, ['open', 'closed']);
      const second = await threads(from.id, ['open', 'closed'], 'active');
      const ids = [...first.rows, ...second.rows].map((r) => r.conversationId);

      // Task 9's statement, under the company lock.
      const moved = await asLogin('jale_api', as(owner), async (c) => {
        await c.query('SELECT active_jobs FROM jale_cap.employer_org_usage(true)');
        return (await c.query(
          'UPDATE jobs SET employer_id = $1, billing_paused_at = NULL, updated_at = now() WHERE employer_id = $2 RETURNING id',
          [to.id, from.id])).rows.map((r) => r.id).sort();
      }, true);
      expect(moved).toEqual([first.job.id, second.job.id].sort());
      expect((await world.su.query<{ employer_id: string; n: number }>(
        `SELECT employer_id, count(*)::int AS n FROM job_conversations WHERE id = ANY($1::uuid[]) GROUP BY employer_id`, [ids])).rows)
        .toEqual([{ employer_id: to.id, n: 4 }]);
      expect((await world.su.query('SELECT count(*)::int AS n FROM job_conversations WHERE employer_id = $1', [from.id])).rows[0].n).toBe(0);
    });

    it('a move 129 refuses (an assignee of another company) leaves the job and its conversations as they were', async () => {
      const t = await threads(foremanA.id, ['open', 'closed']);
      const before = (await world.su.query(
        'SELECT id, employer_id, status, updated_at FROM job_conversations WHERE job_id = $1 ORDER BY id', [t.job.id])).rows;

      // The owner's statement: 129's BEFORE trigger refuses it (before 119's WITH CHECK would).
      const asOwner = await asLogin('jale_api', as(owner), async (c) =>
        c.query('UPDATE jobs SET employer_id = $1 WHERE id = $2', [stranger.id, t.job.id]).catch((e) => e));
      expect({ code: asOwner.code, detail: asOwner.detail }).toEqual({ code: '42501', detail: 'assignee_other_company' });
      // Past row security too: the trigger refuses it for every role.
      const past = await world.su.query('UPDATE jobs SET employer_id = $1 WHERE id = $2', [stranger.id, t.job.id]).catch((e) => e);
      expect({ code: past.code, detail: past.detail }).toEqual({ code: '42501', detail: 'assignee_other_company' });

      expect((await world.su.query('SELECT employer_id FROM jobs WHERE id = $1', [t.job.id])).rows[0].employer_id).toBe(foremanA.id);
      expect((await world.su.query(
        'SELECT id, employer_id, status, updated_at FROM job_conversations WHERE job_id = $1 ORDER BY id', [t.job.id])).rows).toEqual(before);
    });
  });

  describe('the hire-details nudge', () => {
    it('a suspended or removed foreman\'s due nudge goes to the active owner; an active foreman keeps theirs', async () => {
      const suspended = await world.foreman(owner.id, { status: 'suspended', billingSuspended: true });
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const bare = await bareLogin();
      // An owner with no job of their own (outside 125's users policy).
      const joblessOwner = await world.employer({ companyName: 'Jobless Owner Co' });
      const joblessForeman = await world.foreman(joblessOwner.id, { status: 'removed' });
      const hires = {
        active: await dueHire(foremanA.id),
        owner: await dueHire(owner.id),
        suspended: await dueHire(suspended.id),
        removed: await dueHire(removed.id),
        bare: await dueHire(bare.id),
        stranger: await dueHire(stranger.id),
        jobless: await dueHire(joblessForeman.id),
        remind: await dueHire(removed.id),
      };
      // A worker's reminder on a removed member's hire already nudged once: due again, to the owner.
      const remindedAt = (await world.su.query<{ at: Date }>(
        `UPDATE job_applications SET hired_at = now() - interval '8 days', hire_details_nudged_at = now() - interval '6 days 23 hours',
                hire_details_reminded_at = now() - interval '6 days 22 hours'
          WHERE id = $1 RETURNING hire_details_reminded_at AS at`, [hires.remind.applicationId])).rows[0].at;
      const mine = new Set(Object.values(hires).map((h) => h.applicationId));

      // Claimed and rolled back: nothing is stamped.
      const rows = await asLogin('jale_job_digest', {}, async (c) =>
        (await c.query(NUDGE_SQL, [200])).rows.filter((r) => mine.has(r.application_id)));
      const recipients = Object.fromEntries(rows.map((r) => [r.application_id, [r.employer_id, r.employer_email]]));
      expect(rows).toHaveLength(8);
      expect(recipients).toEqual({
        [hires.remind.applicationId]: [owner.id, await emailOf(owner)],
        [hires.jobless.applicationId]: [joblessOwner.id, await emailOf(joblessOwner)],
        [hires.active.applicationId]: [foremanA.id, await emailOf(foremanA)],
        [hires.owner.applicationId]: [owner.id, await emailOf(owner)],
        [hires.suspended.applicationId]: [owner.id, await emailOf(owner)],
        [hires.removed.applicationId]: [owner.id, await emailOf(owner)],
        [hires.bare.applicationId]: [bare.id, await emailOf(bare)],
        [hires.stranger.applicationId]: [stranger.id, await emailOf(stranger)],
      });
      // The rest of each row is 125's.
      expect(rows.find((r) => r.application_id === hires.removed.applicationId)).toMatchObject({
        job_id: hires.removed.jobId, worker_name: 'Fixture Nudged Worker', kind: 'auto', requested_at: null,
      });
      expect(rows.find((r) => r.application_id === hires.remind.applicationId)).toMatchObject({
        job_id: hires.remind.jobId, kind: 'remind', requested_at: remindedAt,
      });
      expect((await world.su.query(
        'SELECT count(*)::int AS n FROM job_applications WHERE id = ANY($1::uuid[]) AND hire_details_nudged_at IS NOT NULL',
        [[...mine].filter((id) => id !== hires.remind.applicationId)])).rows[0].n).toBe(0);
    });
  });

  describe('the owner\'s digest', () => {
    it('the owner\'s digest session reads every member\'s active jobs, applications, rankings and applicant profiles; a foreman\'s only their own', async () => {
      const fixtures: Array<{ employer: UserFixture; jobId: string; workerId: string; applicationId: string }> = [];
      for (const employer of [owner, foremanA, foremanB, stranger]) {
        const job = await world.job(employer.id, { status: 'active' });
        const worker = await world.worker({ fullName: 'Fixture Digest Applicant' });
        await world.workerProfile(worker.id, { location: 'Fixture City' });
        await world.su.query(`INSERT INTO worker_skills (worker_id, skill) VALUES ($1, 'fixture-skill')`, [worker.id]);
        const applicationId = await world.application(job.id, worker.id);
        await world.su.query(
          `INSERT INTO employer_candidate_rankings (job_id, worker_id, application_id, rank, score, score_band, ranking_version, source_hash)
           VALUES ($1, $2, $3, 1, 80, 'strong', 'sql-v1', 'fixture')`, [job.id, worker.id, applicationId]);
        fixtures.push({ employer, jobId: job.id, workerId: worker.id, applicationId });
      }
      const jobs = fixtures.map((f) => f.jobId);
      const workers = fixtures.map((f) => f.workerId);

      const reads = (p: UserFixture) => asLogin('jale_job_digest', as(p), async (c) => ({
        jobs: (await c.query(`SELECT id FROM jobs WHERE id = ANY($1::uuid[]) AND status = 'active'`, [jobs])).rows.map((r) => r.id),
        applications: (await c.query('SELECT job_id FROM job_applications WHERE job_id = ANY($1::uuid[])', [jobs])).rows.map((r) => r.job_id),
        rankings: (await c.query('SELECT job_id FROM employer_candidate_rankings WHERE job_id = ANY($1::uuid[])', [jobs])).rows.map((r) => r.job_id),
        profiles: (await c.query('SELECT user_id FROM worker_profiles WHERE user_id = ANY($1::uuid[])', [workers])).rows.map((r) => r.user_id),
        skills: (await c.query('SELECT worker_id FROM worker_skills WHERE worker_id = ANY($1::uuid[])', [workers])).rows.map((r) => r.worker_id),
      }));
      const expectReach = (got: Record<string, string[]>, reach: number[]) => {
        const want = (key: 'jobId' | 'workerId') => reach.map((i) => fixtures[i][key]).sort();
        expect({
          jobs: got.jobs.sort(), applications: got.applications.sort(), rankings: got.rankings.sort(),
          profiles: got.profiles.sort(), skills: got.skills.sort(),
        }).toEqual({
          jobs: want('jobId'), applications: want('jobId'), rankings: want('jobId'),
          profiles: want('workerId'), skills: want('workerId'),
        });
      };
      expectReach(await reads(owner), [0, 1, 2]);
      expectReach(await reads(foremanA), [1]);
      expectReach(await reads(foremanB), [2]);
      expectReach(await reads(stranger), [3]);
    });

    it('the owner\'s digest reach includes a suspended foreman\'s job and its applicant', async () => {
      const suspended = await world.foreman(owner.id, { status: 'suspended', billingSuspended: true });
      const job = await world.job(suspended.id, { status: 'paused' });
      const worker = await world.worker();
      await world.workerProfile(worker.id, { location: 'Fixture City' });
      await world.application(job.id, worker.id);

      const reach = (p: UserFixture) => asLogin('jale_job_digest', as(p), async (c) => ({
        jobs: (await c.query('SELECT id FROM jobs WHERE id = $1', [job.id])).rowCount,
        applications: (await c.query('SELECT id FROM job_applications WHERE job_id = $1', [job.id])).rowCount,
        profiles: (await c.query('SELECT user_id FROM worker_profiles WHERE user_id = $1', [worker.id])).rowCount,
      }));
      expect(await reach(owner)).toEqual({ jobs: 1, applications: 1, profiles: 1 });
      expect(await reach(foremanA)).toEqual({ jobs: 0, applications: 0, profiles: 0 });
    });

    it('listEmployerCandidates as jale_job_digest for the owner returns the applicants of a foreman\'s job, with contact', async () => {
      const job = await world.job(foremanA.id, { status: 'active', title: 'Fixture Digest Electrician' });
      const worker = await world.worker({ fullName: 'Fixture Listed Applicant' });
      await world.workerProfile(worker.id, { location: 'Fixture City' });
      const applicationId = await world.application(job.id, worker.id);

      const listed = await asLogin('jale_job_digest', as(owner), async (c) =>
        listEmployerCandidates(c as unknown as PoolClient, job.id, { limit: 100, includeContact: true }));
      expect(listed.response.total).toBe(1);
      expect(listed.response.candidates).toEqual([expect.objectContaining({
        application_id: applicationId, worker_id: worker.id, display_name: 'Fixture Listed Applicant', phone: worker.phone,
      })]);

      // Foreman B, in the same company, is not the job's employer nor its owner: nothing.
      const other = await asLogin('jale_job_digest', as(foremanB), async (c) =>
        listEmployerCandidates(c as unknown as PoolClient, job.id, { limit: 100, includeContact: true }));
      expect({ total: other.response.total, candidates: other.response.candidates }).toEqual({ total: 0, candidates: [] });
    });

    it('org_member_scope is empty for a suspended or removed member\'s digest session', async () => {
      const suspended = await world.foreman(owner.id, { status: 'suspended' });
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const ownJob = await world.job(suspended.id, { status: 'paused' });
      const aJob = await world.job(foremanA.id, { status: 'active' });

      const scope = (p: UserFixture) => asLogin('jale_job_digest', as(p), async (c) => (await c.query(
        `SELECT cardinality(jale_internal.org_member_scope($1::text)) AS members,
                cardinality(jale_internal.org_owner_scope($1::text, false)) AS owned`, [p.id])).rows[0]);
      expect(await scope(suspended)).toEqual({ members: 0, owned: 0 });
      expect(await scope(removed)).toEqual({ members: 0, owned: 0 });
      expect((await scope(foremanA)).members).toBeGreaterThanOrEqual(5);
      expect((await scope(foremanA)).owned).toBe(0);
      expect((await scope(owner)).owned).toBeGreaterThanOrEqual(5);

      // Their session reads no other member's job.
      for (const member of [suspended, removed]) {
        const seen = await asLogin('jale_job_digest', as(member), async (c) =>
          (await c.query('SELECT id FROM jobs WHERE id = ANY($1::uuid[])', [[ownJob.id, aJob.id]])).rows.map((r) => r.id));
        expect(seen).toEqual(member === suspended ? [ownJob.id] : []);
      }
    });
  });

  describe('hire details through the handler (the gate\'s deferred case)', () => {
    const DETAILS = { start_date: '2026-11-02', report_location: 'Fixture Yard Gate 3', contact_name: 'Fixture Lead' };
    const put = async (caller: UserFixture, jobId: string, workerId: string) => parseResponse(await hireDetails(apiEvent({
      sub: caller.sub, httpMethod: 'PUT', pathParameters: { jobId, workerId }, body: DETAILS,
    })));
    const stored = async (applicationId: string) => (await world.su.query(
      `SELECT hire_start_date::text AS start_date, hire_report_location AS report_location, hire_contact_name AS contact_name
         FROM job_applications WHERE id = $1`, [applicationId])).rows[0];

    it('the owner saves the details of a hire on foreman A\'s job; foreman B and a stranger are refused', async () => {
      const job = await world.job(foremanA.id, { status: 'active' });
      const worker = await world.worker();
      const applicationId = await world.application(job.id, worker.id, 'hired');
      const empty = { start_date: null, report_location: null, contact_name: null };

      for (const intruder of [foremanB, stranger]) {
        const res = await put(intruder, job.id, worker.id);
        expect(res).toEqual({ statusCode: 404, body: { error: 'not_found' } });
        expect(await stored(applicationId)).toEqual(empty);
      }

      const saved = await put(owner, job.id, worker.id);
      expect(saved.statusCode).toBe(200);
      expect(saved.body.hire_details).toMatchObject(DETAILS);
      expect(await stored(applicationId)).toEqual(DETAILS);
      expect((await world.su.query('SELECT employer_id FROM jobs WHERE id = $1', [job.id])).rows[0].employer_id).toBe(foremanA.id);
    });
  });
});
