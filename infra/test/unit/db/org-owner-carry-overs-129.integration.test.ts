/**
 * org-owner-carry-overs-129 -- migration 129 on a real bed, as jale_api:
 *  - hire details: the active owner of a company saves hire details on a
 *    foreman's hire and passes the "details added" notice's caller check;
 *    another foreman of the same company and a stranger still get
 *    not_found / 42501, exactly as before;
 *  - job edits: the owner pauses and closes a suspended foreman's job in
 *    place and reassigns a suspended or removed member's jobs; nobody, by any
 *    role, moves a job to a person with no company, to a member who is not
 *    active, or into another company, or makes a job active while its
 *    employer is not an active member; the hired-count recount reopens such
 *    a filled job to paused instead (billing-marked when the foreman is
 *    billing-suspended, so 128's restore brings it back).
 *    Each refusal is 42501 with its own DETAIL code.
 * Fixtures through the superuser URL; afterAll removes them.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/org-owner-carry-overs-129.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: org-owner-carry-overs-129 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Person = { id: string; sub: string };

const SAVE_SQL = `SELECT outcome FROM jale_cap.employer_save_hire_details($1, $2, $3::date, $4, $5, $6, $7)`;
const NOTICE_SQL = 'SELECT outcome FROM jale_cap.employer_hire_details_notice($1, $2)';

maybeDescribe('migration 129: Phase 1 owner carry-overs', () => {
  let su: Client;
  const companies: string[] = [];
  let owner: Person;
  let foremanA: Person;
  let foremanB: Person;
  let stranger: Person;
  let worker: Person;
  let jobA: string;
  let applicationA: string;

  async function user(type: 'employer' | 'worker'): Promise<Person> {
    const sub = `carry129-${randomUUID()}`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email, phone) VALUES ($1, $2, $3, '+15550001290') RETURNING id`,
      [sub, type, `${sub}@example.invalid`],
    );
    return { id: rows[0].id, sub };
  }
  async function company(ownerOf: Person): Promise<string> {
    const org = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Carry129 Co') RETURNING id`)).rows[0].id;
    companies.push(org);
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, 'owner')`, [ownerOf.id, org]);
    return org;
  }
  async function member(org: string, p: Person, status: 'active' | 'suspended' | 'removed' = 'active'): Promise<void> {
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'foreman', $3)`, [p.id, org, status]);
  }
  async function job(employer: Person, title: string): Promise<string> {
    return (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status) VALUES ($1, $2, 'Austin', 'full-time', 'active') RETURNING id`,
      [employer.id, title],
    )).rows[0].id;
  }
  /** A fresh company: its owner, an active, a suspended and a removed foreman. */
  async function crew() {
    const boss = await user('employer');
    const org = await company(boss);
    const active = await user('employer');
    const suspended = await user('employer');
    const removed = await user('employer');
    await member(org, active);
    await member(org, suspended, 'suspended');
    await member(org, removed, 'removed');
    return { boss, org, active, suspended, removed };
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    owner = await user('employer');
    foremanA = await user('employer');
    foremanB = await user('employer');
    stranger = await user('employer');
    worker = await user('worker');
    const org = await company(owner);
    await company(stranger);
    await member(org, foremanA);
    await member(org, foremanB);
    jobA = await job(foremanA, 'Roofer');
    applicationA = (await su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status, hired_at) VALUES ($1, $2, 'hired', now()) RETURNING id`,
      [jobA, worker.id],
    )).rows[0].id;
  });
  afterAll(async () => {
    try {
      const ids = (await su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub LIKE 'carry129-%'`)).rows.map((r) => r.id);
      // Notices leave intents and outbox rows for the worker; applications cascade from jobs.
      await su.query(`DELETE FROM whatsapp_outbox WHERE source_type = 'worker_intent'
                        AND source_id IN (SELECT id FROM worker_message_intents WHERE user_id = ANY($1::uuid[]))`, [ids]);
      await su.query(`DELETE FROM worker_message_intents WHERE user_id = ANY($1::uuid[])`, [ids]);
      await su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [ids]);
      await su.query(`DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    } finally {
      await su.end();
    }
  });

  /** Runs fn as jale_api inside a transaction with both caller settings, then rolls back. */
  async function asApi<T>(caller: Person, fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient('jale_api', async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
        await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.id]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }
  /** Runs an expected-error statement under a savepoint, so the transaction stays usable. */
  async function rejects(c: Client, sql: string, params: unknown[], code: string, detail?: string): Promise<void> {
    await c.query('SAVEPOINT expected_error');
    await expect(c.query(sql, params)).rejects.toMatchObject(detail === undefined ? { code } : { code, detail });
    await c.query('ROLLBACK TO SAVEPOINT expected_error');
  }
  const save = (c: Client) => c.query<{ outcome: string }>(
    SAVE_SQL, [jobA, worker.id, '2026-11-02', 'Gate 3', 'Ana', '+15550001291', 'Bring boots']);

  describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'the catalog', () => {
    it('keeps both functions\' owners and their one caller, and gives each the owner case', async () => {
      const { rows } = await su.query(
        `SELECT p.oid::regprocedure::text AS fn, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
                ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee) FROM aclexplode(p.proacl) a
                       WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1)::text[] AS callers,
                position('jale_internal.is_org_owner_of(v_caller, j.employer_id)' IN pg_get_functiondef(p.oid)) > 0 AS owner_case
           FROM pg_proc p
          WHERE p.oid = ANY (ARRAY[
            'jale_cap.employer_save_hire_details(uuid, uuid, date, text, text, text, text)'::regprocedure,
            'jale_cap.employer_hire_details_notice(uuid, text)'::regprocedure])
          ORDER BY 1`,
      );
      expect(rows).toEqual([
        { fn: 'jale_cap.employer_hire_details_notice(uuid,text)', owner: 'jale_cap_worker_lane', callers: ['jale_api'], owner_case: true },
        { fn: 'jale_cap.employer_save_hire_details(uuid,uuid,date,text,text,text,text)', owner: 'jale_cap_hire_details', callers: ['jale_api'], owner_case: true },
      ]);
    });

    it('jobs_org_owner_update accepts any member, and a trigger guards moves', async () => {
      const { rows } = await su.query(
        `SELECT pg_get_expr(polqual, polrelid) = pg_get_expr(polwithcheck, polrelid) AS same,
                position(', false)' IN pg_get_expr(polwithcheck, polrelid)) > 0 AS any_member
           FROM pg_policy WHERE polrelid = 'public.jobs'::regclass AND polname = 'jobs_org_owner_update'`,
      );
      expect(rows).toEqual([{ same: true, any_member: true }]);
      const trigger = await su.query(
        `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
          WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_assignee_must_be_active'`,
      );
      expect(trigger.rows[0].def).toContain(
        'BEFORE UPDATE OF employer_id, status ON public.jobs FOR EACH ROW WHEN (((old.employer_id IS DISTINCT FROM new.employer_id) '
        + 'OR ((old.status IS DISTINCT FROM \'active\'::text) AND (new.status = \'active\'::text))))');
      const callers = await su.query(
        `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner,
                ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee)
                        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner)::text[] AS callers
           FROM pg_proc p WHERE p.oid = 'public.jobs_assignee_must_be_active()'::regprocedure`,
      );
      expect(callers.rows).toEqual([{ owner: 'jale_admin', callers: [] }]);
    });
  });

  describeInProfiles(['standard', 'request'], 'saving and announcing hire details', () => {
    it('the owner saves details on foreman A\'s hire; foreman A still does', async () => {
      expect((await asApi(owner, async (c) => (await save(c)).rows[0].outcome))).toBe('saved');
      expect((await asApi(foremanA, async (c) => (await save(c)).rows[0].outcome))).toBe('saved');
    });

    it('foreman B and a stranger get not_found, as before', async () => {
      expect((await asApi(foremanB, async (c) => (await save(c)).rows[0].outcome))).toBe('not_found');
      expect((await asApi(stranger, async (c) => (await save(c)).rows[0].outcome))).toBe('not_found');
    });

    it('the owner saves details on a foreman\'s hire and queues the notice; foreman B gets 42501', async () => {
      // 125's setup for a 'queued' notice: a ready worker with a number of
      // their own, deferred delivery on, and the worker's own message an hour
      // ago (inside the 24-hour window). Save and notice share one owner
      // transaction, rolled back, so no intent or outbox row survives.
      const ready = await user('worker');
      const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
      await su.query(`UPDATE users SET phone = $1 WHERE id = $2`, [phone, ready.id]);
      await su.query(`INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'ready')`, [ready.id]);
      const readyJob = await job(foremanA, 'Notice job');
      const readyApp = (await su.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status, hired_at) VALUES ($1, $2, 'hired', now()) RETURNING id`,
        [readyJob, ready.id],
      )).rows[0].id;
      const sid = `carry129-${randomUUID()}`;
      await su.query(
        `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, first_seen_at)
         VALUES ($1, $2, 'completed', now() - interval '1 hour')`, [sid, phone]);
      const deliveryWas = (await su.query<{ enabled: boolean }>(
        `SELECT enabled FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`)).rows[0]?.enabled;
      await su.query(`UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'deferred_delivery_enabled'`);
      try {
        const outcomes = await asApi(owner, async (c) => {
          const saved = (await c.query<{ outcome: string }>(
            SAVE_SQL, [readyJob, ready.id, '2026-11-02', 'Gate 3', 'Ana', '+15550001291', 'Bring boots'])).rows[0].outcome;
          const notice = (await c.query<{ outcome: string }>(NOTICE_SQL, [readyApp, 'Details added'])).rows[0].outcome;
          return { saved, notice };
        });
        expect(outcomes).toEqual({ saved: 'saved', notice: 'queued' });
      } finally {
        if (deliveryWas !== undefined) {
          await su.query(`UPDATE whatsapp_runtime_controls SET enabled = $1 WHERE control_key = 'deferred_delivery_enabled'`, [deliveryWas]);
        }
        await su.query(`DELETE FROM whatsapp_processed_messages WHERE message_sid = $1`, [sid]);
      }
      await asApi(foremanB, (c) => rejects(c, NOTICE_SQL, [applicationA, 'Details added'], '42501'));
    });

    it('the owner saves details on a billing-suspended foreman\'s hire', async () => {
      const w = await crew();
      const hired = await user('worker');
      const theirJob = await job(w.active, 'Billing-suspended foreman\'s job');
      await su.query(
        `INSERT INTO job_applications (job_id, worker_id, status, hired_at) VALUES ($1, $2, 'hired', now())`, [theirJob, hired.id]);
      await su.query(
        `UPDATE organization_members SET status = 'suspended', billing_suspended_at = now() WHERE user_id = $1`, [w.active.id]);
      const row = await asApi(w.boss, async (c) => (await c.query<{ outcome: string; updated_at: Date | null }>(
        `SELECT outcome, updated_at FROM jale_cap.employer_save_hire_details($1, $2, $3::date, $4, $5, $6, $7)`,
        [theirJob, hired.id, '2026-11-02', 'Gate 3', 'Ana', '+15550001291', 'Bring boots'])).rows[0]);
      expect(row.outcome).toBe('saved');
      expect(row.updated_at).toBeInstanceOf(Date);
    });
  });

  describeInProfiles(['standard', 'request'], 'owner edits and job moves', () => {
    it('the owner pauses and closes a suspended foreman\'s job in place', async () => {
      const w = await crew();
      const suspendedJob = await job(w.active, 'Becomes a suspended foreman\'s job');
      await su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [w.active.id]);
      await asApi(w.boss, async (c) => {
        expect((await c.query(`UPDATE jobs SET status = 'paused' WHERE id = $1`, [suspendedJob])).rowCount).toBe(1);
        expect((await c.query(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [suspendedJob])).rowCount).toBe(1);
      });
    });

    it('nobody moves a job to a suspended or removed member; a move to an active member still works', async () => {
      const w = await crew();
      const bossJob = await job(w.boss, 'Owner job');
      await asApi(w.boss, async (c) => {
        await rejects(c, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.suspended.id, bossJob], '42501', 'assignee_inactive');
        await rejects(c, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.removed.id, bossJob], '42501', 'assignee_inactive');
        expect((await c.query(`UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.active.id, bossJob])).rowCount).toBe(1);
      });
      // The trigger is the database's rule, not only the request login's.
      await su.query('BEGIN');
      try {
        await rejects(su, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.suspended.id, bossJob], '42501');
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('nobody moves a job to a person with no company or into another company, whoever moves it', async () => {
      const w = await crew();
      const bossJob = await job(w.boss, 'Stays home');
      const loner = await user('employer');
      const other = await crew();
      await su.query('BEGIN');
      try {
        // The superuser passes every policy; only the trigger can refuse.
        await rejects(su, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [loner.id, bossJob], '42501', 'assignee_not_member');
        await rejects(su, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [other.active.id, bossJob], '42501', 'assignee_other_company');
        await rejects(su, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [other.boss.id, bossJob], '42501', 'assignee_other_company');
        expect((await su.query(`UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.active.id, bossJob])).rowCount).toBe(1);
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('the owner reassigns a suspended and a removed member\'s jobs to an active foreman in one statement', async () => {
      const w = await crew();
      const fromSuspended = await job(w.suspended, 'Suspended foreman\'s job');
      const fromRemoved = await job(w.removed, 'Removed foreman\'s job');
      await asApi(w.boss, async (c) => {
        const moved = await c.query(`UPDATE jobs SET employer_id = $1 WHERE id = ANY ($2::uuid[])`,
          [w.active.id, [fromSuspended, fromRemoved]]);
        expect(moved.rowCount).toBe(2);
      });
    });

    it('nobody moves a job whose employer has no company, even to an active member', async () => {
      const w = await crew();
      const loner = await user('employer');
      const lonerJob = await job(loner, 'Has no company');
      await su.query('BEGIN');
      try {
        await rejects(su, `UPDATE jobs SET employer_id = $1 WHERE id = $2`, [w.active.id, lonerJob], '42501', 'job_employer_not_member');
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('a no-op employer_id write on a suspended member\'s job is not a move', async () => {
      const w = await crew();
      const theirJob = await job(w.suspended, 'Stays put');
      await asApi(w.boss, async (c) => {
        expect((await c.query(`UPDATE jobs SET employer_id = employer_id WHERE id = $1`, [theirJob])).rowCount).toBe(1);
      });
      await su.query('BEGIN');
      try {
        expect((await su.query(`UPDATE jobs SET employer_id = employer_id WHERE id = $1`, [theirJob])).rowCount).toBe(1);
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('nobody reactivates a job whose employer is not an active member; pausing, closing and active members\' reactivations still work', async () => {
      const w = await crew();
      const suspendedPaused = await job(w.suspended, 'Suspended foreman\'s paused job');
      const removedPaused = await job(w.removed, 'Removed foreman\'s paused job');
      const activePaused = await job(w.active, 'Active foreman\'s paused job');
      await su.query(`UPDATE jobs SET status = 'paused' WHERE id = ANY ($1::uuid[])`, [[suspendedPaused, removedPaused, activePaused]]);
      await asApi(w.boss, async (c) => {
        await rejects(c, `UPDATE jobs SET status = 'active' WHERE id = $1`, [suspendedPaused], '42501', 'employer_inactive_for_activation');
        await rejects(c, `UPDATE jobs SET status = 'active' WHERE id = $1`, [removedPaused], '42501', 'employer_inactive_for_activation');
        // Still paused, the owner edits and closes it; and reopens an active member's job.
        expect((await c.query(`UPDATE jobs SET status = 'paused', title = 'Edited' WHERE id = $1`, [suspendedPaused])).rowCount).toBe(1);
        expect((await c.query(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [suspendedPaused])).rowCount).toBe(1);
        expect((await c.query(`UPDATE jobs SET status = 'active' WHERE id = $1`, [activePaused])).rowCount).toBe(1);
      });
      // A foreman reactivates their own paused job.
      await asApi(w.active, async (c) => {
        expect((await c.query(`UPDATE jobs SET status = 'active' WHERE id = $1`, [activePaused])).rowCount).toBe(1);
      });
      // The superuser is refused too: the trigger is the database's rule.
      await su.query('BEGIN');
      try {
        await rejects(su, `UPDATE jobs SET status = 'active' WHERE id = $1`, [suspendedPaused], '42501', 'employer_inactive_for_activation');
      } finally {
        await su.query('ROLLBACK');
      }
    });

    /** A job needing one worker, filled by one hire; returns the job and that application. */
    async function filledJob(employer: Person, title: string): Promise<{ jobId: string; appId: string }> {
      const jobId = await job(employer, title);
      await su.query(`UPDATE jobs SET number_of_workers_needed = 1 WHERE id = $1`, [jobId]);
      const hired = await user('worker');
      const appId = (await su.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status, hired_at) VALUES ($1, $2, 'hired', now()) RETURNING id`,
        [jobId, hired.id])).rows[0].id;
      expect((await su.query(`SELECT status FROM jobs WHERE id = $1`, [jobId])).rows[0].status).toBe('filled');
      return { jobId, appId };
    }
    const jobState = async (c: Client, id: string) => (await c.query<{ status: string; workers_hired: number; billing_paused: boolean }>(
      `SELECT status, workers_hired, billing_paused_at IS NOT NULL AS billing_paused FROM jobs WHERE id = $1`, [id])).rows[0];

    it('the hired-count recount reopens a non-active member\'s filled job to paused, never active', async () => {
      const w = await crew();
      const loner = await user('employer');
      const ownerSuspended = await filledJob(w.active, 'Owner-suspended foreman\'s filled job');
      const removed = await filledJob(w.removed, 'Removed foreman\'s filled job');
      const noCompany = await filledJob(loner, 'No-company employer\'s filled job');
      await su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [w.active.id]);
      await su.query('BEGIN');
      try {
        // The job now needs more workers and a worker applies: the recount
        // reopens it, paused and not billing-marked, and the application lands.
        await su.query('SAVEPOINT needs_more');
        await su.query(`UPDATE jobs SET number_of_workers_needed = 3 WHERE id = $1`, [ownerSuspended.jobId]);
        const applicant = await user('worker');
        await su.query(`INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending')`,
          [ownerSuspended.jobId, applicant.id]);
        expect(await jobState(su, ownerSuspended.jobId)).toEqual({ status: 'paused', workers_hired: 1, billing_paused: false });
        await su.query('ROLLBACK TO SAVEPOINT needs_more');
        // A hire is undone, for an owner-suspended, a removed and a no-company employer.
        for (const j of [ownerSuspended, removed, noCompany]) {
          await su.query(`UPDATE job_applications SET status = 'not_interested' WHERE id = $1`, [j.appId]);
          expect(await jobState(su, j.jobId)).toEqual({ status: 'paused', workers_hired: 0, billing_paused: false });
        }
        // A re-hire leaves it paused: 105's recount never moves a paused job.
        await su.query(`UPDATE job_applications SET status = 'hired' WHERE id = $1`, [ownerSuspended.appId]);
        expect(await jobState(su, ownerSuspended.jobId)).toEqual({ status: 'paused', workers_hired: 1, billing_paused: false });
        // A direct write of filled -> active is a reactivation, and is refused.
        await su.query(`UPDATE jobs SET status = 'filled' WHERE id = $1`, [ownerSuspended.jobId]);
        await rejects(su, `UPDATE jobs SET status = 'active' WHERE id = $1`, [ownerSuspended.jobId],
          '42501', 'employer_inactive_for_activation');
      } finally {
        await su.query('ROLLBACK');
      }
      // The owner cannot pass for the recount by lowering workers_hired in a direct statement.
      await asApi(w.boss, async (c) => {
        await rejects(c, `UPDATE jobs SET status = 'active', workers_hired = workers_hired - 1 WHERE id = $1`, [ownerSuspended.jobId],
          '42501', 'employer_inactive_for_activation');
      });
    });

    it('the owner cannot reopen a suspended foreman\'s filled job through the recount', async () => {
      const w = await crew();
      const { jobId } = await filledJob(w.active, 'Owner tries the recount');
      await su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [w.active.id]);
      await asApi(w.boss, async (c) => {
        // Both allowed: an in-place edit (status unchanged), then a no-op write on the job's applications.
        expect((await c.query(`UPDATE jobs SET number_of_workers_needed = 5 WHERE id = $1`, [jobId])).rowCount).toBe(1);
        expect((await c.query(`UPDATE job_applications SET status = status WHERE job_id = $1`, [jobId])).rowCount).toBe(1);
        expect(await jobState(c, jobId)).toEqual({ status: 'paused', workers_hired: 1, billing_paused: false });
      });
    });

    it('a billing-suspended foreman\'s reopened job is billing-paused, and billing_restore_org brings it back', async () => {
      const w = await crew();
      const { jobId, appId } = await filledJob(w.active, 'Billing-suspended foreman\'s filled job');
      await su.query('BEGIN');
      try {
        // A downgrade to no foreman seats suspends and marks foreman w.active.
        const enforced = await su.query<{ suspended_count: number }>(
          `SELECT suspended_count FROM jale_billing_internal.billing_enforce_org_limits($1, 100, 0)`, [w.org]);
        expect(enforced.rows[0].suspended_count).toBe(1);
        expect((await su.query(
          `SELECT status, billing_suspended_at IS NOT NULL AS marked FROM organization_members WHERE user_id = $1`,
          [w.active.id])).rows[0]).toEqual({ status: 'suspended', marked: true });
        // The hire is undone: the recount reopens the job billing-paused.
        await su.query(`UPDATE job_applications SET status = 'not_interested' WHERE id = $1`, [appId]);
        expect(await jobState(su, jobId)).toEqual({ status: 'paused', workers_hired: 0, billing_paused: true });
        // A re-hire and a second undo leave it paused and marked.
        await su.query(`UPDATE job_applications SET status = 'hired' WHERE id = $1`, [appId]);
        expect(await jobState(su, jobId)).toEqual({ status: 'paused', workers_hired: 1, billing_paused: true });
        await su.query(`UPDATE job_applications SET status = 'not_interested' WHERE id = $1`, [appId]);
        expect(await jobState(su, jobId)).toEqual({ status: 'paused', workers_hired: 0, billing_paused: true });
        // The plan comes back: the foreman first, then their billing-paused job.
        const restored = await su.query<{ resumed_count: number; restored_count: number }>(
          `SELECT resumed_count, restored_count FROM jale_billing_internal.billing_restore_org($1, 100, 5)`, [w.org]);
        expect(restored.rows[0]).toEqual({ resumed_count: 1, restored_count: 1 });
        expect(await jobState(su, jobId)).toEqual({ status: 'active', workers_hired: 0, billing_paused: false });
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('a foreman still cannot touch another member\'s job', async () => {
      const w = await crew();
      const otherForeman = await user('employer');
      await member(w.org, otherForeman);
      const theirJob = await job(otherForeman, 'Not yours');
      await asApi(w.active, async (c) => {
        expect((await c.query(`UPDATE jobs SET status = 'paused' WHERE id = $1`, [theirJob])).rowCount).toBe(0);
      });
    });
  });
});
