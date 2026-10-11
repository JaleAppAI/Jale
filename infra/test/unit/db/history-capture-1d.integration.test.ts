/**
 * history-capture-1d.integration.test.ts
 *
 * PostgreSQL-backed behavior and access tests for the roadmap 1d history
 * tables (migrations 099–101): every tracked change through every real writer
 * role produces exactly one history row, untracked or same-value updates
 * produce none, parent deletes cascade, and access is append-only and gated by
 * 089's analytics flag.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite is explicitly
 * skipped and says so (Rule 11: no silent skips).
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *     sh -c 'cd infra && npx jest test/unit/db/history-capture-1d.integration.test.ts'
 */

import { Client } from 'pg';
import { randomBytes } from 'node:crypto';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    await client.query(`ALTER ROLE jale_billing WITH PASSWORD 'test-billing-pw'`);
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    await client.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`);
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

/** History rows for one parent, read as the superuser (bypasses RLS). */
async function historyRows(superUrl: string, table: string, keyColumn: string, key: string): Promise<any[]> {
  return withClient(superUrl, async (c) =>
    (await c.query(`SELECT * FROM ${table} WHERE ${keyColumn} = $1 ORDER BY id`, [key])).rows);
}

/** Runs one read with 089's analytics gate open for that transaction only. */
async function readWithFlag(url: string, sql: string, params: unknown[] = []): Promise<any[]> {
  return withClient(url, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('app.admin_analytics_read', 'on', true)`);
      return (await c.query(sql, params)).rows;
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

/**
 * A random 64-hex value shaped like a phone hash (never a real number's).
 * A hoisted function declaration on purpose: describe callbacks run at
 * collection time, so a `const` declared below them would not exist yet.
 */
function freshPhoneHash(): string {
  return randomBytes(32).toString('hex');
}

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping 1d history capture integration tests');
}

maybeDescribe('1d history capture (099–101)', () => {
  let superUrl = '';
  let adminUrl = '';
  let whatsappUrl = '';
  let billingUrl = '';
  let consoleUrl = '';

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await setServiceRolePasswords(superUrl);
    adminUrl = new URL(superUrl).username === 'jale_admin'
      ? superUrl
      : urlForRole(superUrl, 'jale_admin', 'test-admin-pw');
    whatsappUrl = urlForRole(superUrl, 'jale_whatsapp', 'test-whatsapp-pw');
    billingUrl = urlForRole(superUrl, 'jale_billing', 'test-billing-pw');
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');
  }, 60_000);

  describe('099 job_application_status_events', () => {
    const TABLE = 'job_application_status_events';
    const subs = ['it-1d-employer', 'it-1d-worker', 'it-1d-worker-2'];
    let employerId = '';
    let workerId = '';
    let worker2Id = '';
    let openJobId = '';     // no requirements: a hire passes 091's guard
    let gatedJobId = '';    // one required field: a hire without it is rejected
    let appId = '';
    let gatedAppId = '';

    beforeAll(async () => {
      await withClient(superUrl, async (su) => {
        const users = await su.query(
          `INSERT INTO users (cognito_sub, user_type) VALUES
             ($1, 'employer'), ($2, 'worker'), ($3, 'worker')
           RETURNING id`,
          subs,
        );
        [employerId, workerId, worker2Id] = users.rows.map((r) => r.id);
        const jobs = await su.query(
          `INSERT INTO jobs (employer_id, title, location, job_type, status, number_of_workers_needed, required_fields) VALUES
             ($1, 'IT 1d Open Job',  'Austin', 'full-time', 'active', 2, '{}'),
             ($1, 'IT 1d Gated Job', 'Austin', 'full-time', 'active', 2, '{date_available}')
           RETURNING id`,
          [employerId],
        );
        [openJobId, gatedJobId] = jobs.rows.map((r) => r.id);
        appId = (await su.query(
          `INSERT INTO job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id`,
          [openJobId, workerId],
        )).rows[0].id;
        gatedAppId = (await su.query(
          `INSERT INTO job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id`,
          [gatedJobId, worker2Id],
        )).rows[0].id;
      });
    }, 60_000);

    afterAll(async () => {
      if (!databaseUrl) return;
      await withClient(superUrl, async (su) => {
        // jobs cascade to job_applications, which cascade to their history.
        await su.query(`DELETE FROM jobs WHERE employer_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1))`, [subs]);
        await su.query(`DELETE FROM users WHERE cognito_sub = ANY($1)`, [subs]);
      });
    }, 60_000);

    it('an insert writes exactly one event from NULL to pending', async () => {
      const rows = await historyRows(superUrl, TABLE, 'application_id', appId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ job_id: openJobId, from_status: null, to_status: 'pending', is_backfill: false });
    });

    it('the employer path (jale_admin) records each status change', async () => {
      await withClient(adminUrl, async (c) => {
        await c.query(`SELECT set_config('app.current_user_id', $1, false)`, ['it-1d-employer']);
        const r = await c.query(`UPDATE job_applications SET status = 'contacted' WHERE id = $1`, [appId]);
        expect(r.rowCount).toBe(1);
      });
      const rows = await historyRows(superUrl, TABLE, 'application_id', appId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ from_status: 'pending', to_status: 'contacted' });
    });

    it('a WhatsApp worker reply (jale_whatsapp) records its status change', async () => {
      await withClient(whatsappUrl, async (c) => {
        await c.query(`SELECT set_config('app.current_internal_user_id', $1, false)`, [workerId]);
        const r = await c.query(`UPDATE job_applications SET status = 'talking', updated_at = now() WHERE id = $1`, [appId]);
        expect(r.rowCount).toBe(1);
      });
      const rows = await historyRows(superUrl, TABLE, 'application_id', appId);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ from_status: 'contacted', to_status: 'talking' });
    });

    it('untracked and same-value updates write nothing', async () => {
      await withClient(superUrl, async (su) => {
        await su.query(`UPDATE job_applications SET updated_at = now() WHERE id = $1`, [appId]);
        await su.query(`UPDATE job_applications SET status = status WHERE id = $1`, [appId]);
      });
      expect(await historyRows(superUrl, TABLE, 'application_id', appId)).toHaveLength(3);
    });

    it('a hire that passes 091 is recorded; one the guard rejects is not', async () => {
      await withClient(adminUrl, async (c) => {
        await c.query(`SELECT set_config('app.current_user_id', $1, false)`, ['it-1d-employer']);
        await c.query(`UPDATE job_applications SET status = 'hired' WHERE id = $1`, [appId]);
        await expect(c.query(`UPDATE job_applications SET status = 'hired' WHERE id = $1`, [gatedAppId]))
          .rejects.toMatchObject({ code: '23514', constraint: 'job_applications_hire_requirements_check' });
      });
      const hired = await historyRows(superUrl, TABLE, 'application_id', appId);
      expect(hired).toHaveLength(4);
      expect(hired[3]).toMatchObject({ from_status: 'talking', to_status: 'hired' });
      expect(await historyRows(superUrl, TABLE, 'application_id', gatedAppId)).toHaveLength(1);
    });

    it('access is append-only and gated by the analytics flag', async () => {
      await expect(withClient(consoleUrl, (c) => c.query(`SELECT count(*) FROM ${TABLE}`)))
        .rejects.toThrow(/permission denied/);
      await expect(withClient(whatsappUrl, (c) => c.query(`SELECT count(*) FROM ${TABLE}`)))
        .rejects.toThrow(/permission denied/);

      const hidden = await withClient(adminUrl, async (c) =>
        (await c.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE application_id = $1`, [gatedAppId])).rows[0].n);
      expect(hidden).toBe(0);
      const visible = await readWithFlag(adminUrl, `SELECT count(*)::int AS n FROM ${TABLE} WHERE application_id = $1`, [gatedAppId]);
      expect(visible[0].n).toBe(1);

      await withClient(adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.admin_analytics_read', 'on', true)`);
        const upd = await c.query(`UPDATE ${TABLE} SET to_status = 'rewritten' WHERE application_id = $1`, [gatedAppId]);
        const del = await c.query(`DELETE FROM ${TABLE} WHERE application_id = $1`, [gatedAppId]);
        await c.query('COMMIT');
        expect(upd.rowCount).toBe(0);
        expect(del.rowCount).toBe(0);
      });
      const rows = await historyRows(superUrl, TABLE, 'application_id', gatedAppId);
      expect(rows).toHaveLength(1);
      expect(rows[0].to_status).toBe('pending');

      // The definer's insert path is the one write jale_admin has; a
      // backfill-shaped row keeps is_backfill.
      await withClient(adminUrl, (c) => c.query(
        `INSERT INTO ${TABLE} (application_id, job_id, from_status, to_status, changed_at, is_backfill)
         VALUES ($1, $2, NULL, 'pending', now() - interval '1 day', true)`,
        [gatedAppId, gatedJobId],
      ));
      const after = await historyRows(superUrl, TABLE, 'application_id', gatedAppId);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ to_status: 'pending', is_backfill: true });
    });

    it('deleting the application removes its history', async () => {
      await withClient(superUrl, (su) => su.query(`DELETE FROM job_applications WHERE id = $1`, [appId]));
      expect(await historyRows(superUrl, TABLE, 'application_id', appId)).toHaveLength(0);
    });

    it('a jale_admin job delete cascades through applications to their history', async () => {
      // 035's jobs_employer_delete policy keys on app.current_user_id (the
      // employer's cognito_sub), same as the employer-path update test above.
      // jobs -> job_applications -> job_application_status_events are all ON
      // DELETE CASCADE, so one employer-initiated delete should wipe both.
      await withClient(adminUrl, async (c) => {
        await c.query(`SELECT set_config('app.current_user_id', $1, false)`, ['it-1d-employer']);
        const r = await c.query(`DELETE FROM jobs WHERE id = $1`, [gatedJobId]);
        expect(r.rowCount).toBe(1);
      });
      expect(await historyRows(superUrl, TABLE, 'application_id', gatedAppId)).toHaveLength(0);
    });
  });

  describe('100 subscription_status_history', () => {
    const TABLE = 'subscription_status_history';
    const SUB = 'it-1d-billing-employer';
    const PLAN_A = 'it_1d_plan_a';
    const PLAN_B = 'it_1d_plan_b';
    const PROVIDER_ID = 'sub_it_1d_a';
    let userId = '';
    let subscriptionId = '';

    beforeAll(async () => {
      await withClient(superUrl, async (su) => {
        userId = (await su.query(
          `INSERT INTO users (cognito_sub, user_type) VALUES ($1, 'employer') RETURNING id`, [SUB],
        )).rows[0].id;
        await su.query(
          `INSERT INTO billing_plans (code, audience, display_name, entitlements) VALUES
             ($1, 'employer', 'IT 1d Plan A', '{}'), ($2, 'employer', 'IT 1d Plan B', '{}')
           ON CONFLICT (code) DO NOTHING`,
          [PLAN_A, PLAN_B],
        );
      });
    }, 60_000);

    afterAll(async () => {
      if (!databaseUrl) return;
      await withClient(superUrl, async (su) => {
        await su.query(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE cognito_sub = $1)`, [SUB]);
        await su.query(`DELETE FROM billing_plans WHERE code = ANY($1)`, [[PLAN_A, PLAN_B]]);
        await su.query(`DELETE FROM users WHERE cognito_sub = $1`, [SUB]);
      });
    }, 60_000);

    it('the billing processor (jale_billing) insert writes exactly one event', async () => {
      subscriptionId = await withClient(billingUrl, async (c) => (await c.query(
        `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status)
         VALUES ($1, $2, $3, 'trialing') RETURNING id`,
        [userId, PLAN_A, PROVIDER_ID],
      )).rows[0].id);
      const rows = await historyRows(superUrl, TABLE, 'subscription_id', subscriptionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: userId, from_status: null, to_status: 'trialing',
        plan_code: PLAN_A, cancel_at_period_end: false, is_backfill: false,
      });
    });

    it('status, plan, and cancellation changes each write one event', async () => {
      await withClient(billingUrl, async (c) => {
        await c.query(`UPDATE subscriptions SET status = 'active' WHERE id = $1`, [subscriptionId]);
        await c.query(`UPDATE subscriptions SET plan_code = $2 WHERE id = $1`, [subscriptionId, PLAN_B]);
        await c.query(`UPDATE subscriptions SET cancel_at_period_end = true WHERE id = $1`, [subscriptionId]);
      });
      const rows = await historyRows(superUrl, TABLE, 'subscription_id', subscriptionId);
      expect(rows).toHaveLength(4);
      expect(rows[1]).toMatchObject({ from_status: 'trialing', to_status: 'active', plan_code: PLAN_A, cancel_at_period_end: false });
      expect(rows[2]).toMatchObject({ from_status: 'active', to_status: 'active', plan_code: PLAN_B, cancel_at_period_end: false });
      expect(rows[3]).toMatchObject({ from_status: 'active', to_status: 'active', plan_code: PLAN_B, cancel_at_period_end: true });
    });

    it('untracked and same-value updates write nothing', async () => {
      await withClient(billingUrl, async (c) => {
        await c.query(`UPDATE subscriptions SET current_period_end = now() + interval '30 days' WHERE id = $1`, [subscriptionId]);
        await c.query(`UPDATE subscriptions SET status = status, plan_code = plan_code WHERE id = $1`, [subscriptionId]);
      });
      expect(await historyRows(superUrl, TABLE, 'subscription_id', subscriptionId)).toHaveLength(4);
    });

    it("the processor's upsert records the update path only", async () => {
      await withClient(billingUrl, (c) => c.query(
        `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status)
         VALUES ($1, $2, $3, 'past_due')
         ON CONFLICT (provider_subscription_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
        [userId, PLAN_B, PROVIDER_ID],
      ));
      const rows = await historyRows(superUrl, TABLE, 'subscription_id', subscriptionId);
      expect(rows).toHaveLength(5);
      expect(rows[4]).toMatchObject({ from_status: 'active', to_status: 'past_due' });
    });

    it('access is append-only and gated by the analytics flag', async () => {
      await expect(withClient(consoleUrl, (c) => c.query(`SELECT count(*) FROM ${TABLE}`)))
        .rejects.toThrow(/permission denied/);
      await expect(withClient(billingUrl, (c) => c.query(`SELECT count(*) FROM ${TABLE}`)))
        .rejects.toThrow(/permission denied/);

      const hidden = await withClient(adminUrl, async (c) =>
        (await c.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE subscription_id = $1`, [subscriptionId])).rows[0].n);
      expect(hidden).toBe(0);
      const visible = await readWithFlag(adminUrl, `SELECT count(*)::int AS n FROM ${TABLE} WHERE subscription_id = $1`, [subscriptionId]);
      expect(visible[0].n).toBe(5);

      await withClient(adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.admin_analytics_read', 'on', true)`);
        const upd = await c.query(`UPDATE ${TABLE} SET to_status = 'rewritten' WHERE subscription_id = $1`, [subscriptionId]);
        const del = await c.query(`DELETE FROM ${TABLE} WHERE subscription_id = $1`, [subscriptionId]);
        await c.query('COMMIT');
        expect(upd.rowCount).toBe(0);
        expect(del.rowCount).toBe(0);
      });
      expect(await historyRows(superUrl, TABLE, 'subscription_id', subscriptionId)).toHaveLength(5);

      // The definer's insert path is the one write jale_admin has; a
      // backfill-shaped row keeps is_backfill.
      await withClient(adminUrl, (c) => c.query(
        `INSERT INTO ${TABLE}
           (subscription_id, user_id, from_status, to_status, plan_code, cancel_at_period_end, changed_at, is_backfill)
         VALUES ($1, $2, NULL, 'trialing', $3, false, now() - interval '1 day', true)`,
        [subscriptionId, userId, PLAN_A],
      ));
      const after = await historyRows(superUrl, TABLE, 'subscription_id', subscriptionId);
      expect(after).toHaveLength(6);
      expect(after[5]).toMatchObject({ to_status: 'trialing', is_backfill: true });
    });

    it('deleting the subscription removes its history', async () => {
      await withClient(superUrl, (su) => su.query(`DELETE FROM subscriptions WHERE id = $1`, [subscriptionId]));
      expect(await historyRows(superUrl, TABLE, 'subscription_id', subscriptionId)).toHaveLength(0);
    });
  });

  describe('101 worker_identity_challenge_events', () => {
    const TABLE = 'worker_identity_challenge_events';
    const phoneHash = freshPhoneHash();
    let challengeId = '';

    const savePreAuth = (patch: Record<string, unknown>) =>
      withClient(whatsappUrl, (c) => c.query(
        'SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [phoneHash, JSON.stringify(patch)],
      ));

    afterAll(async () => {
      if (!databaseUrl) return;
      await withClient(superUrl, (su) =>
        su.query(`DELETE FROM worker_identity_challenges WHERE phone_hash = $1`, [phoneHash]));
    }, 60_000);

    it("save_worker_pre_auth's first call writes exactly one event", async () => {
      // The function inserts a bare row, then updates it in the same call. The
      // update leaves status ('pending'), attempts (0) and locked_until (NULL)
      // unchanged, so only the insert is recorded.
      const res = await savePreAuth({ current_step_key: 'identity.verify_otp' });
      challengeId = res.rows[0].id;
      const rows = await historyRows(superUrl, TABLE, 'challenge_id', challengeId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ from_status: null, to_status: 'pending', attempts: 0, locked_until: null, is_backfill: false });
    });

    it('attempts and lock changes each write one event', async () => {
      const lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString();
      await savePreAuth({ attempts: 1 });
      await savePreAuth({ status: 'locked', locked_until: lockedUntil });
      const rows = await historyRows(superUrl, TABLE, 'challenge_id', challengeId);
      expect(rows).toHaveLength(3);
      expect(rows[1]).toMatchObject({ from_status: 'pending', to_status: 'pending', attempts: 1, locked_until: null });
      expect(rows[2]).toMatchObject({ from_status: 'pending', to_status: 'locked', attempts: 1 });
      expect(new Date(rows[2].locked_until).toISOString()).toBe(lockedUntil);
    });

    it('a call that changes no tracked column writes nothing', async () => {
      await savePreAuth({ context: { note: 'it-1d' } });
      expect(await historyRows(superUrl, TABLE, 'challenge_id', challengeId)).toHaveLength(3);
    });

    it('a verified transition (the bind path) is recorded', async () => {
      await withClient(superUrl, (su) => su.query(
        `UPDATE worker_identity_challenges SET status = 'verified', updated_at = now() WHERE id = $1`, [challengeId],
      ));
      const rows = await historyRows(superUrl, TABLE, 'challenge_id', challengeId);
      expect(rows).toHaveLength(4);
      expect(rows[3]).toMatchObject({ from_status: 'locked', to_status: 'verified' });
    });

    it('access is append-only and gated by the analytics flag', async () => {
      await expect(withClient(consoleUrl, (c) => c.query(`SELECT count(*) FROM ${TABLE}`)))
        .rejects.toThrow(/permission denied/);
      await expect(withClient(whatsappUrl, (c) => c.query(`SELECT count(*) FROM ${TABLE}`)))
        .rejects.toThrow(/permission denied/);

      const hidden = await withClient(adminUrl, async (c) =>
        (await c.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE challenge_id = $1`, [challengeId])).rows[0].n);
      expect(hidden).toBe(0);
      const visible = await readWithFlag(adminUrl, `SELECT count(*)::int AS n FROM ${TABLE} WHERE challenge_id = $1`, [challengeId]);
      expect(visible[0].n).toBe(4);

      await withClient(adminUrl, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.admin_analytics_read', 'on', true)`);
        const upd = await c.query(`UPDATE ${TABLE} SET to_status = 'rewritten' WHERE challenge_id = $1`, [challengeId]);
        const del = await c.query(`DELETE FROM ${TABLE} WHERE challenge_id = $1`, [challengeId]);
        await c.query('COMMIT');
        expect(upd.rowCount).toBe(0);
        expect(del.rowCount).toBe(0);
      });
      expect(await historyRows(superUrl, TABLE, 'challenge_id', challengeId)).toHaveLength(4);

      // The definer's insert path is the one write jale_admin has; a
      // backfill-shaped row keeps is_backfill.
      await withClient(adminUrl, (c) => c.query(
        `INSERT INTO ${TABLE} (challenge_id, from_status, to_status, attempts, locked_until, changed_at, is_backfill)
         VALUES ($1, NULL, 'pending', 0, NULL, now() - interval '1 day', true)`,
        [challengeId],
      ));
      const after = await historyRows(superUrl, TABLE, 'challenge_id', challengeId);
      expect(after).toHaveLength(5);
      expect(after[4]).toMatchObject({ to_status: 'pending', is_backfill: true });
    });

    it('deleting the challenge removes its history', async () => {
      await withClient(superUrl, (su) => su.query(`DELETE FROM worker_identity_challenges WHERE id = $1`, [challengeId]));
      expect(await historyRows(superUrl, TABLE, 'challenge_id', challengeId)).toHaveLength(0);
    });
  });
});
