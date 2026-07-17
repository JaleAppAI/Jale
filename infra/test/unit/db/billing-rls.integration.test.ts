/**
 * billing-rls.integration.test.ts
 *
 * PostgreSQL-backed RLS tests for the billing tables introduced in migration 034.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with the full
 * migration chain (001→034) already applied. When absent, all tests are explicitly
 * skipped and the concern is logged (Rule 11: no silent skips).
 *
 * The URL must point to an already-migrated database (migrations are NOT re-applied
 * in this test — they are run once via the Docker gate in the Postgres clean-apply
 * step or via `apply-order.test.ts`). The DB user in the URL must be a superuser
 * (e.g. `postgres`) so the test can set role passwords and insert fixtures.
 *
 * Example (after running the Docker gate):
 *   JALE_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/jale npx jest billing-rls
 *
 * The test harness mirrors the pattern from infra/test/unit/db/migrations/apply-order.test.ts:
 * - jale_admin sessions use SET LOCAL app.current_user_id = <cognito_sub>
 * - jale_billing sessions connect as jale_billing (no RLS context needed)
 * - cross-user denial is proved via a different cognito_sub with no matching users row
 */

import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

/**
 * Set test-only login passwords on all service roles created by the migrations.
 * This is idempotent — safe to call on an already-configured DB.
 * Also sets jale_admin password so tests can connect as that role for RLS checks.
 */
async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    // When the disposable database itself is bootstrapped as jale_admin, keep
    // its base URL valid. Otherwise configure the separate app role login.
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    await client.query(`ALTER ROLE jale_billing WITH PASSWORD 'test-billing-pw'`);
    await client.query(`ALTER ROLE jale_matching WITH PASSWORD 'test-matching-pw'`);
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    await client.query(`ALTER ROLE jale_ai WITH PASSWORD 'test-ai-pw'`);
    await client.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`);
  } finally {
    await client.end();
  }
}

/** Parse a postgres URL and replace the user+password for a different role. */
function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * Run a block as jale_admin with app.current_user_id set to the given cognito_sub.
 * Returns the query result of the last query in the block.
 */
async function asAdmin<T>(
  adminUrl: string,
  cognitoSub: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL does not accept parameterized values; cognitoSub is a test-controlled
    // string (no SQL-injection risk in test fixtures).
    await client.query(`SET LOCAL app.current_user_id = '${cognitoSub}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

/**
 * Run a block as jale_billing (no RLS context required — service role).
 */
async function asBilling<T>(
  billingUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: billingUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// maybeIt: skip with loud console.warn when DB is unavailable (Rule 11)
// ---------------------------------------------------------------------------

function maybeDescribe(
  name: string,
  fn: () => void,
): void {
  if (!databaseUrl) {
    // Rule 11: explicit, loud skip — not a silent pass
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[billing-rls.integration] SKIPPED: "${name}" — set JALE_TEST_DATABASE_URL to run PostgreSQL-backed RLS tests. ` +
        `This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.`,
    );
  } else {
    describe(name, fn);
  }
}

// ---------------------------------------------------------------------------
// Test state — populated once in beforeAll
// ---------------------------------------------------------------------------

let superuserUrl: string;  // postgres superuser — used for fixtures and DDL (bypasses RLS)
let adminUrl: string;      // jale_admin role — FORCE RLS applies; use for RLS tests
let billingUrl: string;    // jale_billing service role
let employerUserId: string; // UUID of employer1
let employerCognitoSub: string; // cognito_sub of employer1
let otherEmployerUserId: string;
let otherEmployerCognitoSub: string;
let workerUserId: string;
let workerCognitoSub: string;

// ---------------------------------------------------------------------------
// Suite setup: apply migrations, create test fixtures
// ---------------------------------------------------------------------------

maybeDescribe('billing RLS integration (migration 034)', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;

    superuserUrl = databaseUrl;
    // Set test-only passwords; jale_admin password is also set here.
    await setServiceRolePasswords(superuserUrl);
    // Connect as jale_admin for all RLS-enforcing tests.
    adminUrl = new URL(databaseUrl).username === 'jale_admin'
      ? databaseUrl
      : urlForRole(databaseUrl, 'jale_admin', 'test-admin-pw');
    billingUrl = urlForRole(databaseUrl, 'jale_billing', 'test-billing-pw');

    // Create test users via superuser (bypasses RLS for fixture setup)
    const setup = new Client({ connectionString: superuserUrl });
    await setup.connect();
    try {
      // employer1 — upsert so tests are re-runnable against a non-fresh DB
      const e1 = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
         VALUES ('emp-cognito-sub-1', 'employer', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      employerUserId = e1.rows[0].id;
      employerCognitoSub = e1.rows[0].cognito_sub;

      // employer2 (cross-user denial)
      const e2 = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
         VALUES ('emp-cognito-sub-2', 'employer', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      otherEmployerUserId = e2.rows[0].id;
      otherEmployerCognitoSub = e2.rows[0].cognito_sub;

      // worker1
      const w1 = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number, created_at, updated_at)
         VALUES ('worker-cognito-sub-1', 'worker', '+10000000003', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      workerUserId = w1.rows[0].id;
      workerCognitoSub = w1.rows[0].cognito_sub;
    } finally {
      await setup.end();
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Catalog shape tests (static SQL assertions — no DB needed, but run inside
  // the describe block so they show up in the same suite)
  // ---------------------------------------------------------------------------

  describe('catalog shape (SQL assertions)', () => {
    it('migration 034 seeds exactly 3 billing_plans rows', async () => {
      if (!databaseUrl) return;
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        // jale_admin can read billing_plans
        await client.query(`SET app.current_user_id = 'any-cognito-sub'`);
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM billing_plans`,
        );
        expect(result.rows[0].count).toBe('3');
      } finally {
        await client.end();
      }
    });

    it('employer_pro plan has display_price_minor=2000 and active_job_limit=10 in entitlements', async () => {
      if (!databaseUrl) return;
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`SET app.current_user_id = 'any-cognito-sub'`);
        const result = await client.query<{
          display_price_minor: number;
          entitlements: Record<string, unknown>;
        }>(
          `SELECT display_price_minor, entitlements
           FROM billing_plans WHERE code = 'employer_pro'`,
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].display_price_minor).toBe(2000);
        expect(result.rows[0].entitlements).toEqual({ active_job_limit: 10 });
      } finally {
        await client.end();
      }
    });

    it('organizations table exists with FORCE ROW LEVEL SECURITY and no app policies', async () => {
      if (!databaseUrl) return;
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        // Table exists
        const tableResult = await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename = 'organizations'`,
        );
        expect(tableResult.rows).toHaveLength(1);

        // FORCE RLS is on
        const forceResult = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class WHERE relname = 'organizations'`,
        );
        expect(forceResult.rows[0].relrowsecurity).toBe(true);
        expect(forceResult.rows[0].relforcerowsecurity).toBe(true);

        // No app policies (locked by default — no policies = no rows visible to any app role)
        const policyResult = await client.query<{ policyname: string }>(
          `SELECT policyname FROM pg_policies
           WHERE tablename = 'organizations'`,
        );
        expect(policyResult.rows).toHaveLength(0);
      } finally {
        await client.end();
      }
    });

    it('billing_customers.organization_id is nullable and defaults NULL', async () => {
      if (!databaseUrl) return;
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        const result = await client.query<{
          is_nullable: string;
          column_default: string | null;
        }>(
          `SELECT is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = 'billing_customers' AND column_name = 'organization_id'`,
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].is_nullable).toBe('YES');
        expect(result.rows[0].column_default).toBeNull();
      } finally {
        await client.end();
      }
    });

    it('subscriptions.organization_id is nullable and defaults NULL', async () => {
      if (!databaseUrl) return;
      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        const result = await client.query<{
          is_nullable: string;
          column_default: string | null;
        }>(
          `SELECT is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = 'subscriptions' AND column_name = 'organization_id'`,
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].is_nullable).toBe('YES');
        expect(result.rows[0].column_default).toBeNull();
      } finally {
        await client.end();
      }
    });

    it('users.tenant_id FK rejects a nonexistent organization UUID', async () => {
      if (!databaseUrl) return;
      // Use superuser to bypass RLS on users table — we're testing the FK constraint, not RLS
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        // Attempt to set tenant_id to a UUID that does not exist in organizations
        await expect(
          client.query(
            `UPDATE users SET tenant_id = gen_random_uuid() WHERE id = $1`,
            [employerUserId],
          ),
        ).rejects.toThrow(/foreign key/i);
      } finally {
        await client.end();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // jale_admin RLS: employer owner read/write on billing_customers
  // ---------------------------------------------------------------------------

  describe('jale_admin: employer owner on billing_customers', () => {
    it('employer can INSERT their own billing_customer row', async () => {
      // Clean slate via superuser so the suite is idempotent across re-runs
      // (billing_customers PK is user_id).
      const cleanup = new Client({ connectionString: superuserUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DELETE FROM billing_customers WHERE user_id = $1`, [employerUserId]);
      } finally {
        await cleanup.end();
      }
      const result = await asAdmin(adminUrl, employerCognitoSub, async (client) => {
        return client.query(
          `INSERT INTO billing_customers (user_id, provider, provider_customer_id)
           VALUES ($1, 'stripe', 'cus_test_owner_insert')`,
          [employerUserId],
        );
      });
      expect(result.rowCount).toBe(1);
    });

    it('employer can SELECT their own billing_customer row', async () => {
      const result = await asAdmin(adminUrl, employerCognitoSub, async (client) => {
        return client.query<{ user_id: string }>(
          `SELECT user_id FROM billing_customers WHERE user_id = $1`,
          [employerUserId],
        );
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].user_id).toBe(employerUserId);
    });

    it('employer can UPDATE their own billing_customer row', async () => {
      const result = await asAdmin(adminUrl, employerCognitoSub, async (client) => {
        return client.query(
          `UPDATE billing_customers SET updated_at = now() WHERE user_id = $1`,
          [employerUserId],
        );
      });
      expect(result.rowCount).toBe(1);
    });

    it('cross-employer denial: employer2 cannot SELECT employer1 billing_customer', async () => {
      const result = await asAdmin(adminUrl, otherEmployerCognitoSub, async (client) => {
        return client.query<{ user_id: string }>(
          `SELECT user_id FROM billing_customers WHERE user_id = $1`,
          [employerUserId],
        );
      });
      // RLS filters to zero rows — not an error, just empty
      expect(result.rows).toHaveLength(0);
    });

    it('cross-employer denial: employer2 cannot INSERT a billing_customer row for employer1', async () => {
      await expect(
        asAdmin(adminUrl, otherEmployerCognitoSub, async (client) => {
          return client.query(
            `INSERT INTO billing_customers (user_id, provider, provider_customer_id)
             VALUES ($1, 'stripe', 'cus_test_cross_insert')`,
            [employerUserId],
          );
        }),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // jale_admin RLS: subscriptions owner read-only
  // ---------------------------------------------------------------------------

  describe('jale_admin: subscriptions owner read-only', () => {
    let subscriptionId: string;

    beforeAll(async () => {
      if (!databaseUrl) return;
      // Insert a subscription via superuser (bypasses RLS — jale_admin has SELECT-only on subscriptions)
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        // Cancel any existing active subscription for employer first (partial unique index)
        await client.query(
          `UPDATE subscriptions SET status = 'canceled'
           WHERE user_id = $1 AND status NOT IN ('canceled', 'incomplete_expired')`,
          [employerUserId],
        );
        const result = await client.query<{ id: string }>(
          `INSERT INTO subscriptions (user_id, plan_code, status)
           VALUES ($1, 'employer_free', 'active')
           RETURNING id`,
          [employerUserId],
        );
        subscriptionId = result.rows[0].id;
      } finally {
        await client.end();
      }
    });

    it('employer can SELECT their own subscription row', async () => {
      const result = await asAdmin(adminUrl, employerCognitoSub, async (client) => {
        return client.query<{ id: string }>(
          `SELECT id FROM subscriptions WHERE id = $1`,
          [subscriptionId],
        );
      });
      expect(result.rows).toHaveLength(1);
    });

    it('cross-employer denial: employer2 cannot SELECT employer1 subscription', async () => {
      const result = await asAdmin(adminUrl, otherEmployerCognitoSub, async (client) => {
        return client.query<{ id: string }>(
          `SELECT id FROM subscriptions WHERE id = $1`,
          [subscriptionId],
        );
      });
      expect(result.rows).toHaveLength(0);
    });

    it('jale_admin has no INSERT policy on subscriptions — INSERT is denied', async () => {
      // subscriptions_owner_read is FOR SELECT only; INSERT has no policy -> denied
      await expect(
        asAdmin(adminUrl, employerCognitoSub, async (client) => {
          return client.query(
            `INSERT INTO subscriptions (user_id, plan_code, status)
             VALUES ($1, 'employer_pro', 'active')`,
            [employerUserId],
          );
        }),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // jale_admin RLS: worker denial on billing tables
  // ---------------------------------------------------------------------------

  describe('jale_admin: worker denial on billing tables', () => {
    it('worker cannot SELECT billing_customers (no matching row → empty)', async () => {
      const result = await asAdmin(adminUrl, workerCognitoSub, async (client) => {
        return client.query(`SELECT user_id FROM billing_customers`);
      });
      // Workers have no billing_customer row, so result is empty. This is the
      // correct denial behavior: no error, no leakage of other rows.
      expect(result.rows).toHaveLength(0);
    });

    it('worker cannot SELECT billing_operations rows belonging to employer', async () => {
      // Insert a billing operation for employer via superuser (bypasses RLS for fixture)
      const setup = new Client({ connectionString: superuserUrl });
      let opId: string;
      await setup.connect();
      try {
        const r = await setup.query<{ id: string }>(
          `INSERT INTO billing_operations
             (actor_user_id, operation_type, client_idempotency_key, request_hash)
           VALUES ($1, 'create_subscription', gen_random_uuid(), 'hash-1')
           RETURNING id`,
          [employerUserId],
        );
        opId = r.rows[0].id;
      } finally {
        await setup.end();
      }

      const result = await asAdmin(adminUrl, workerCognitoSub, async (client) => {
        return client.query(`SELECT id FROM billing_operations WHERE id = $1`, [opId]);
      });
      expect(result.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // jale_admin denial on billing_webhook_events
  // ---------------------------------------------------------------------------

  describe('jale_admin: denied on billing_webhook_events', () => {
    it('jale_admin cannot INSERT into billing_webhook_events (no policy)', async () => {
      await expect(
        asAdmin(adminUrl, employerCognitoSub, async (client) => {
          return client.query(
            `INSERT INTO billing_webhook_events (stripe_event_id, event_type)
             VALUES ('evt_test_admin_denied', 'customer.subscription.updated')`,
          );
        }),
      ).rejects.toThrow();
    });

    it('jale_admin cannot SELECT from billing_webhook_events (no policy)', async () => {
      // First insert via jale_billing so the table has a row
      await asBilling(billingUrl, async (client) => {
        return client.query(
          `INSERT INTO billing_webhook_events (stripe_event_id, event_type)
           VALUES ('evt_test_admin_select_denied', 'customer.subscription.updated')
           ON CONFLICT DO NOTHING`,
        );
      });

      // Production migrations run as jale_admin, making it the table owner.
      // FORCE RLS still denies the row, but owner-level table privilege means
      // SELECT resolves to an empty result rather than a permission error.
      const result = await asAdmin(adminUrl, employerCognitoSub, async (client) => {
        return client.query(
          `SELECT stripe_event_id FROM billing_webhook_events WHERE stripe_event_id = 'evt_test_admin_select_denied'`,
        );
      });
      expect(result.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // jale_billing allowed operations
  // ---------------------------------------------------------------------------

  describe('jale_billing: allowed operations', () => {
    it('jale_billing can SELECT from billing_plans', async () => {
      const result = await asBilling(billingUrl, async (client) => {
        return client.query<{ count: string }>(`SELECT count(*)::text AS count FROM billing_plans`);
      });
      expect(result.rows[0].count).toBe('3');
    });

    it('jale_billing can SELECT from billing_customers', async () => {
      // employer1 row exists from earlier test
      const result = await asBilling(billingUrl, async (client) => {
        return client.query<{ user_id: string }>(
          `SELECT user_id FROM billing_customers WHERE user_id = $1`,
          [employerUserId],
        );
      });
      expect(result.rows).toHaveLength(1);
    });

    it('jale_billing can INSERT into billing_webhook_events', async () => {
      const result = await asBilling(billingUrl, async (client) => {
        return client.query(
          `INSERT INTO billing_webhook_events (stripe_event_id, event_type)
           VALUES ('evt_billing_insert_test', 'customer.subscription.created')
           ON CONFLICT (stripe_event_id) DO UPDATE SET event_type = EXCLUDED.event_type`,
        );
      });
      expect(result.rowCount).toBe(1);
    });

    it('jale_billing can UPDATE billing_webhook_events (mark processed)', async () => {
      const result = await asBilling(billingUrl, async (client) => {
        return client.query(
          `UPDATE billing_webhook_events
           SET processing_status = 'processed', processed_at = now()
           WHERE stripe_event_id = 'evt_billing_insert_test'`,
        );
      });
      expect(result.rowCount).toBe(1);
    });

    it('jale_billing can INSERT and UPDATE subscriptions', async () => {
      // Cancel any existing non-terminal subscription for otherEmployer (partial unique index)
      const cleanupClient = new Client({ connectionString: superuserUrl });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(
          `UPDATE subscriptions SET status = 'canceled'
           WHERE user_id = $1 AND status NOT IN ('canceled', 'incomplete_expired')`,
          [otherEmployerUserId],
        );
      } finally {
        await cleanupClient.end();
      }

      // Insert a new subscription as jale_billing
      const insertResult = await asBilling(billingUrl, async (client) => {
        return client.query<{ id: string }>(
          `INSERT INTO subscriptions (user_id, plan_code, status)
           VALUES ($1, 'employer_pro', 'active')
           RETURNING id`,
          [otherEmployerUserId],
        );
      });
      expect(insertResult.rows).toHaveLength(1);
      const subId = insertResult.rows[0].id;

      // Update it
      const updateResult = await asBilling(billingUrl, async (client) => {
        return client.query(
          `UPDATE subscriptions SET status = 'canceled' WHERE id = $1`,
          [subId],
        );
      });
      expect(updateResult.rowCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // jale_billing denied operations
  // ---------------------------------------------------------------------------

  describe('jale_billing: denied operations', () => {
    it('jale_billing cannot DELETE from billing_plans', async () => {
      await expect(
        asBilling(billingUrl, async (client) => {
          return client.query(`DELETE FROM billing_plans WHERE code = 'worker_free'`);
        }),
      ).rejects.toThrow();
    });

    it('jale_billing cannot INSERT into billing_plans (catalog is read-only for service role)', async () => {
      await expect(
        asBilling(billingUrl, async (client) => {
          return client.query(
            `INSERT INTO billing_plans (code, audience, display_name, entitlements)
             VALUES ('test_plan', 'employer', 'Test', '{}'::jsonb)`,
          );
        }),
      ).rejects.toThrow();
    });

    it('jale_billing cannot DELETE from billing_webhook_events', async () => {
      await expect(
        asBilling(billingUrl, async (client) => {
          return client.query(
            `DELETE FROM billing_webhook_events WHERE stripe_event_id = 'evt_billing_insert_test'`,
          );
        }),
      ).rejects.toThrow();
    });

    it('jale_billing cannot INSERT into billing_operations', async () => {
      // billing_operations: jale_billing has no GRANT at all
      await expect(
        asBilling(billingUrl, async (client) => {
          return client.query(
            `INSERT INTO billing_operations
               (actor_user_id, operation_type, client_idempotency_key, request_hash)
             VALUES ($1, 'test_op', gen_random_uuid(), 'hash-billing-denied')`,
            [employerUserId],
          );
        }),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent uniqueness: subscriptions_one_current_per_user
  // ---------------------------------------------------------------------------

  describe('subscriptions_one_current_per_user partial uniqueness index', () => {
    it('two concurrent non-terminal inserts for the same user: exactly one wins', async () => {
      if (!databaseUrl) return;

      // Create a fresh user for this test to avoid interference (via superuser)
      const setup = new Client({ connectionString: superuserUrl });
      let testUserId: string;
      await setup.connect();
      try {
        // First cancel any existing active subscriptions for this test user
        // so the unique partial index doesn't block the concurrent insert test.
        await setup.query(
          `UPDATE subscriptions SET status = 'canceled'
           WHERE user_id = (SELECT id FROM users WHERE cognito_sub = 'sub-uniqueness-test')
             AND status NOT IN ('canceled', 'incomplete_expired')`,
        );
        const r = await setup.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
           VALUES ('sub-uniqueness-test', 'employer', now(), now())
           ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
           RETURNING id`,
        );
        testUserId = r.rows[0].id;
      } finally {
        await setup.end();
      }

      const c1 = new Client({ connectionString: superuserUrl });
      const c2 = new Client({ connectionString: superuserUrl });
      await c1.connect();
      await c2.connect();

      try {
        await c1.query('BEGIN');
        await c2.query('BEGIN');

        // Both insert (second one will block or fail at COMMIT due to the partial unique index)
        await c1.query(
          `INSERT INTO subscriptions (user_id, plan_code, status)
           VALUES ($1, 'employer_pro', 'active')`,
          [testUserId],
        );

        // c2's INSERT blocks on c1's uncommitted row (partial unique index),
        // so it must run concurrently — awaiting it before c1 COMMITs deadlocks
        // the single-threaded test against itself.
        const c2Outcome: Promise<Error | null> = (async () => {
          try {
            await c2.query(
              `INSERT INTO subscriptions (user_id, plan_code, status)
               VALUES ($1, 'employer_pro', 'active')`,
              [testUserId],
            );
            await c2.query('COMMIT');
            return null;
          } catch (e) {
            await c2.query('ROLLBACK').catch(() => {});
            return e as Error;
          }
        })();

        // Let c2 reach the lock wait, then commit c1 to release it.
        await new Promise((resolve) => setTimeout(resolve, 250));
        await c1.query('COMMIT');
        const c2Error = await c2Outcome;

        // Verify exactly one non-terminal row exists for this user
        const countResult = await c1.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM subscriptions
           WHERE user_id = $1 AND status NOT IN ('canceled', 'incomplete_expired')`,
          [testUserId],
        );
        expect(parseInt(countResult.rows[0].count, 10)).toBe(1);

        // The count check is the authoritative evidence — c2 either errored on insert
        // or would have errored on COMMIT.
        void c2Error; // acknowledged — count is the proof
      } finally {
        await c1.end().catch(() => {});
        await c2.end().catch(() => {});
      }
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Idempotency UNIQUE constraint on billing_operations
  // ---------------------------------------------------------------------------

  describe('billing_operations idempotency UNIQUE constraint', () => {
    it('same (actor_user_id, operation_type, client_idempotency_key) conflicts on second insert', async () => {
      if (!databaseUrl) return;

      // Use superuser to bypass RLS for direct insert testing of the unique constraint
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        const idempotencyKey = 'a0000000-0000-0000-0000-000000000001';

        // Ensure a clean slate (idempotent across test re-runs)
        await client.query(
          `DELETE FROM billing_operations
           WHERE actor_user_id = $1
             AND operation_type = 'create_subscription'
             AND client_idempotency_key = $2::uuid`,
          [employerUserId, idempotencyKey],
        );

        // First insert
        await client.query(
          `INSERT INTO billing_operations
             (actor_user_id, operation_type, client_idempotency_key, request_hash)
           VALUES ($1, 'create_subscription', $2::uuid, 'hash-idem-1')`,
          [employerUserId, idempotencyKey],
        );

        // Second insert with same key must fail with unique constraint violation
        await expect(
          client.query(
            `INSERT INTO billing_operations
               (actor_user_id, operation_type, client_idempotency_key, request_hash)
             VALUES ($1, 'create_subscription', $2::uuid, 'hash-idem-2')`,
            [employerUserId, idempotencyKey],
          ),
        ).rejects.toThrow(/unique/i);
      } finally {
        await client.end();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// If DB is unavailable, emit a single top-level concern notice so CI captures it
// ---------------------------------------------------------------------------
if (!databaseUrl) {
  test(
    'CONCERN: billing-rls PostgreSQL gate was not run — JALE_TEST_DATABASE_URL not set',
    () => {
      // eslint-disable-next-line no-console
      console.warn(
        '[billing-rls.integration] DONE_WITH_CONCERNS: The PostgreSQL RLS gate for migration 034 ' +
          'was skipped because JALE_TEST_DATABASE_URL is not set in this environment. ' +
          'Run with a local Postgres 16 container to validate all billing RLS assertions.',
      );
      // This test itself always passes — it is a concern notice, not a gate.
      // The real gate is the describe block above.
      expect(databaseUrl).toBeUndefined(); // confirms the skip condition
    },
  );
}
