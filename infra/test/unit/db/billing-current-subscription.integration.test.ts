/**
 * billing-current-subscription.integration.test.ts
 *
 * Real-PostgreSQL proof for the supersede step in lambda/billing/processor.ts.
 *
 * The processor mirrors Stripe with
 * `INSERT INTO subscriptions ... ON CONFLICT (provider_subscription_id)`.
 * When a user who still holds a current row acquires a NEW
 * provider_subscription_id, that conflict target does not match, so the
 * statement INSERTs — and the partial unique index from migration 034,
 *
 *   CREATE UNIQUE INDEX subscriptions_one_current_per_user
 *       ON subscriptions (user_id)
 *    WHERE status NOT IN ('canceled', 'incomplete_expired');
 *
 * rejects it with 23505. This test proves that rejection is real against a
 * live server (not merely inferred from the DDL) and that the retire UPDATE
 * the processor now issues first is what makes the re-subscribe path work.
 *
 * Connection: JALE_TEST_DATABASE_URL must point at a database with the full
 * migration chain already applied, using a superuser (fixtures need to bypass
 * the FORCE ROW LEVEL SECURITY on subscriptions). When absent, every test is
 * explicitly skipped and the concern is logged — no silent skips.
 *
 * Example (after running the Docker gate):
 *   JALE_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/jale \
 *     npx jest billing-current-subscription
 */

import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: billing current-subscription PostgreSQL gate was not run', () => {
    console.warn('[billing-current-subscription] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}

const maybeDescribe = databaseUrl ? describe : describe.skip;

const COGNITO_SUB = 'b3-current-sub-employer';
const SUB_OLD = 'sub_test_current_a_old';
const SUB_NEW = 'sub_test_current_b_new';

maybeDescribe('subscriptions_one_current_per_user: retire before upsert', () => {
  let employerId: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    try {
      const employer = await setup.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, email)
         VALUES ($1, 'employer', 'current-sub-employer@example.com')
         ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [COGNITO_SUB],
      );
      employerId = employer.rows[0].id;
      // Leftovers from an interrupted run would themselves occupy the slot.
      await setup.query('DELETE FROM subscriptions WHERE user_id = $1', [employerId]);
    } finally {
      await setup.end();
    }
  });

  afterAll(async () => {
    if (!databaseUrl || !employerId) return;
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query('DELETE FROM subscriptions WHERE user_id = $1', [employerId]);
      await cleanup.query('DELETE FROM users WHERE cognito_sub = $1', [COGNITO_SUB]);
    } finally {
      await cleanup.end();
    }
  });

  it('rejects a second current row with 23505, then accepts it after the retire UPDATE', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const oldRow = await client.query<{ id: string }>(
        `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status)
         VALUES ($1, 'employer_pro', $2, 'active')
         RETURNING id`,
        [employerId, SUB_OLD],
      );
      const oldRowId = oldRow.rows[0].id;

      await client.query('BEGIN');
      await client.query('SAVEPOINT before_collision');

      // Exactly what the processor's upsert degrades to when the incoming
      // provider_subscription_id is new: a plain INSERT.
      const collision = await client.query(
        `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status)
         VALUES ($1, 'employer_pro', $2, 'active')`,
        [employerId, SUB_NEW],
      ).then(() => null, (err: unknown) => err as { code?: string; message?: string });

      expect(collision).not.toBeNull();
      expect(collision!.code).toBe('23505');
      // Name the index explicitly: a bare 23505 assertion would also pass for
      // the provider_subscription_id UNIQUE constraint, which is a different
      // failure with a different fix.
      expect(String(collision!.message)).toContain('subscriptions_one_current_per_user');

      // The failed statement aborted the transaction — every later statement
      // returns 25P02 until we unwind to the savepoint.
      await client.query('ROLLBACK TO SAVEPOINT before_collision');

      // The processor's retire step (same shape, same columns, by primary key).
      const retired = await client.query(
        `UPDATE subscriptions
            SET status               = 'canceled',
                cancel_at_period_end = false,
                grace_ends_at        = NULL,
                updated_at           = now()
          WHERE id = ANY($1::uuid[])`,
        [[oldRowId]],
      );
      expect(retired.rowCount).toBe(1);

      // ...after which the very same INSERT succeeds.
      await client.query(
        `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status)
         VALUES ($1, 'employer_pro', $2, 'active')`,
        [employerId, SUB_NEW],
      );
      await client.query('COMMIT');

      const rows = await client.query<{ provider_subscription_id: string; status: string }>(
        `SELECT provider_subscription_id, status FROM subscriptions
          WHERE user_id = $1 ORDER BY provider_subscription_id`,
        [employerId],
      );
      expect(rows.rows).toEqual([
        { provider_subscription_id: SUB_OLD, status: 'canceled' },
        { provider_subscription_id: SUB_NEW, status: 'active' },
      ]);

      // The invariant the index exists to hold.
      const current = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM subscriptions
          WHERE user_id = $1 AND status NOT IN ('canceled', 'incomplete_expired')`,
        [employerId],
      );
      expect(current.rows[0].count).toBe('1');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
});
