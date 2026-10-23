/**
 * company-limit-concurrency -- the company lock (migration 128) under real
 * concurrency, as the deployed logins:
 *  1. two members of one company post at the same moment while one slot is
 *     left: the second waits on the company's organizations row, then counts
 *     the first member's committed job, so the handler gate (Task 8) refuses
 *     it;
 *  2. a downgrade that arrives while a member's post is in flight waits for
 *     that post, then pauses the newest job, so no post slips past it;
 *  3. a processor-shaped transaction (it inserts the company's subscription,
 *     whose foreign-key check takes FOR KEY SHARE on the company row, then
 *     enforces the limits) racing a member's post: the post's FOR NO KEY
 *     UPDATE does not wait for the KEY SHARE, the enforcer waits for the
 *     post, and both complete. Under FOR UPDATE the post would wait for the
 *     webhook and the enforcer for the post: a deadlock (40P01);
 *  4. a downgrade that suspends a foreman while the foreman waits for the
 *     company lock: once granted, the usage read checks the caller again
 *     and refuses them (42501).
 * Fixtures through the superuser URL; afterAll removes them.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/company-limit-concurrency.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describeInProfiles, loginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: company-limit-concurrency needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Person = { id: string; sub: string };

maybeDescribe('the company lock under concurrency', () => {
  let su: Client;
  const companies: string[] = [];

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });
  afterAll(async () => {
    try {
      const ids = (await su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub LIKE 'conc128-%'`)).rows.map((r) => r.id);
      await su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [ids]);
      // Subscriptions restrict their company (127); their history cascades.
      await su.query(`DELETE FROM subscriptions WHERE organization_id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    } finally {
      await su.end();
    }
  });

  async function user(): Promise<Person> {
    const sub = `conc128-${randomUUID()}`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`, [sub, `${sub}@example.invalid`]);
    return { id: rows[0].id, sub };
  }
  /** An owner and one active foreman in one company. */
  async function company(): Promise<{ owner: Person; foreman: Person; org: string }> {
    const owner = await user();
    const foreman = await user();
    const org = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Conc128 Co') RETURNING id`)).rows[0].id;
    companies.push(org);
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $3, 'owner'), ($2, $3, 'foreman')`,
      [owner.id, foreman.id, org]);
    return { owner, foreman, org };
  }
  async function begin(c: Client, p: Person): Promise<void> {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [p.sub]);
    await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [p.id]);
  }
  async function lockedUsage(c: Client): Promise<number> {
    return (await c.query<{ active_jobs: number }>(`SELECT active_jobs FROM jale_cap.employer_org_usage(true)`)).rows[0].active_jobs;
  }
  async function pidOf(c: Client): Promise<number> {
    return (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  }
  /** Waits until backend `pid` is blocked on a lock (proves the wait, not just the outcome). */
  async function waitUntilBlocked(pid: number): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await su.query<{ waiting: boolean }>(
        `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backend ${pid} never waited on a lock`);
  }
  const insertJob = (c: Client, employer: Person, title: string) => c.query(
    `INSERT INTO jobs (employer_id, title, location, job_type, trade_category, status)
     VALUES ($1, $2, 'Austin', 'full-time', 'concrete', 'active')`, [employer.id, title]);

  describeInProfiles(['standard', 'request'], 'posts and downgrades', () => {
    it('two members posting at once: the second waits for the company lock and then sees the first job', async () => {
      const { owner, foreman } = await company();
      const first = loginClient('jale_api');
      const second = loginClient('jale_api');
      await first.connect();
      await second.connect();
      try {
        const secondPid = await pidOf(second);
        await begin(first, owner);
        await begin(second, foreman);
        expect(await lockedUsage(first)).toBe(0);
        const secondCount = lockedUsage(second); // blocks on the company row
        await waitUntilBlocked(secondPid);
        await insertJob(first, owner, 'First post');
        await first.query('COMMIT');
        // One slot (employer_free): the handler's gate, 1 >= 1, refuses the second post.
        expect(await secondCount).toBe(1);
        await second.query('ROLLBACK');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        await first.end();
        await second.end();
      }
      const { rows } = await su.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs WHERE employer_id = ANY($1::uuid[]) AND status = 'active'`, [[owner.id, foreman.id]]);
      expect(rows[0].n).toBe(1);
    });

    it('the billing enforcer waits for a post in flight, then pauses the newest job', async () => {
      const { owner, foreman, org } = await company();
      await su.query(
        `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at)
         VALUES ($1, 'Older post', 'Austin', 'full-time', 'active', now() - interval '1 day')`, [owner.id]);
      const poster = loginClient('jale_api');
      const billing = loginClient('jale_billing');
      await poster.connect();
      await billing.connect();
      try {
        const billingPid = await pidOf(billing);
        // The post runs under Pro (one active job of ten) and holds the company lock.
        await begin(poster, foreman);
        expect(await lockedUsage(poster)).toBe(1);
        await insertJob(poster, foreman, 'Newer post');
        // The downgrade to Free (one job) arrives meanwhile.
        await billing.query('BEGIN');
        const enforced = billing.query(
          `SELECT paused_count, paused_titles FROM jale_billing_internal.billing_enforce_org_limits($1, 1, 0)`, [org]);
        await waitUntilBlocked(billingPid);
        await poster.query('COMMIT');
        const result = (await enforced).rows[0];
        await billing.query('COMMIT');
        // Without the lock it would have counted only the older job and paused nothing.
        expect(result).toEqual({ paused_count: 1, paused_titles: ['Newer post'] });
      } finally {
        await poster.query('ROLLBACK').catch(() => undefined);
        await billing.query('ROLLBACK').catch(() => undefined);
        await poster.end();
        await billing.end();
      }
      const { rows } = await su.query<{ title: string; status: string }>(
        `SELECT title, status FROM jobs WHERE employer_id = ANY($1::uuid[]) ORDER BY created_at`, [[owner.id, foreman.id]]);
      expect(rows).toEqual([{ title: 'Older post', status: 'active' }, { title: 'Newer post', status: 'paused' }]);
    });

    it('a processor-shaped downgrade and a post in flight both complete, without a deadlock', async () => {
      const { owner, foreman, org } = await company();
      const poster = loginClient('jale_api');
      const billing = loginClient('jale_billing');
      await poster.connect();
      await billing.connect();
      try {
        const billingPid = await pidOf(billing);
        // The processor's transaction: the subscription upsert comes first, and
        // its foreign-key check takes FOR KEY SHARE on the company row.
        await billing.query('BEGIN');
        await billing.query(
          `INSERT INTO subscriptions (user_id, organization_id, plan_code, provider_subscription_id, status)
           VALUES ($1, $2, 'employer_pro', $3, 'canceled')`,
          [owner.id, org, `sub_conc128_${randomUUID()}`]);
        // A member posts meanwhile. FOR NO KEY UPDATE does not wait for that
        // KEY SHARE; under FOR UPDATE this statement would wait for the
        // webhook, and the lock_timeout turns that into a 55P03 failure here.
        await begin(poster, foreman);
        await poster.query(`SET LOCAL lock_timeout = '2s'`);
        expect(await lockedUsage(poster)).toBe(0);
        await insertJob(poster, foreman, 'Post in flight');
        // The enforcer, in the same webhook transaction, waits for the post.
        const enforced = billing.query(
          `SELECT paused_count, paused_titles FROM jale_billing_internal.billing_enforce_org_limits($1, 0, 1)`, [org]);
        await waitUntilBlocked(billingPid);
        await poster.query('COMMIT');
        const result = (await enforced).rows[0];
        await billing.query('COMMIT');
        expect(result).toEqual({ paused_count: 1, paused_titles: ['Post in flight'] });
      } finally {
        await poster.query('ROLLBACK').catch(() => undefined);
        await billing.query('ROLLBACK').catch(() => undefined);
        await poster.end();
        await billing.end();
      }
      const subs = await su.query<{ n: number }>(`SELECT count(*)::int AS n FROM subscriptions WHERE organization_id = $1`, [org]);
      expect(subs.rows[0].n).toBe(1);
      const jobs = await su.query<{ status: string }>(`SELECT status FROM jobs WHERE employer_id = $1`, [foreman.id]);
      expect(jobs.rows).toEqual([{ status: 'paused' }]);
    });

    it('a foreman suspended by a downgrade while waiting for the company lock is refused once it is granted (42501)', async () => {
      const { foreman, org } = await company();
      const billing = loginClient('jale_billing');
      const poster = loginClient('jale_api');
      await billing.connect();
      await poster.connect();
      try {
        const posterPid = await pidOf(poster);
        // The downgrade to no seats holds the company lock, the foreman suspended but not yet committed.
        await billing.query('BEGIN');
        const enforced = await billing.query<{ suspended_count: number }>(
          `SELECT suspended_count FROM jale_billing_internal.billing_enforce_org_limits($1, 10, 0)`, [org]);
        expect(enforced.rows[0].suspended_count).toBe(1);
        // The foreman, still active in their own snapshot, asks for the lock and waits.
        await begin(poster, foreman);
        const usage = lockedUsage(poster);
        usage.catch(() => undefined); // observed below
        await waitUntilBlocked(posterPid);
        await billing.query('COMMIT');
        // Granted the lock, the caller is checked again and is no longer an active member.
        await expect(usage).rejects.toMatchObject({ code: '42501' });
        await poster.query('ROLLBACK');
      } finally {
        await billing.query('ROLLBACK').catch(() => undefined);
        await poster.query('ROLLBACK').catch(() => undefined);
        await billing.end();
        await poster.end();
      }
      const { rows } = await su.query<{ status: string; marked: boolean }>(
        `SELECT status, billing_suspended_at IS NOT NULL AS marked FROM organization_members WHERE user_id = $1`, [foreman.id]);
      expect(rows).toEqual([{ status: 'suspended', marked: true }]);
    });
  });
});
