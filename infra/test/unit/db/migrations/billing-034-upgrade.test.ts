/**
 * billing-034-upgrade.test.ts
 *
 * Proves the billing-production-runbook UPGRADE path for migration 034
 * (docs/superpowers/specs/2026-06-30-billing-money-movement-design.md S5.1, S5.3):
 * a database already migrated through 033 (production-equivalent), with 034
 * applied alone on top, ends up in the exact state the runbook's Phase-3
 * verification checklist expects.
 *
 * This complements (does not replace) `apply-order.test.ts`'s clean-chain
 * (001->034 in one pass) coverage. The two paths are not guaranteed to be
 * equivalent — a migration author could accidentally rely on schema state
 * that a clean apply happens to produce but a "033 first, then 034 alone"
 * apply does not (or vice versa) — so both are asserted independently.
 *
 * Connection: set JALE_TEST_UPGRADE_DATABASE_URL to a local, EMPTY Postgres 16
 * superuser URL (e.g. `postgres://postgres:test@localhost:55441/jale` for a
 * throwaway `postgres:16` Docker container with nothing applied yet). This is
 * a distinct env var from `apply-order.test.ts`'s JALE_TEST_DATABASE_URL /
 * `billing-rls.integration.test.ts`'s same-named var because those expect a
 * DB the caller may reuse across runs (idempotent fixtures); this suite
 * mutates schema state destructively (034 is applied exactly once, then a
 * second application is expected to fail) and therefore needs its own empty
 * database per run.
 *
 * Every migration back to 001 writes `GRANT ... TO jale_admin` / `CREATE
 * POLICY ... TO jale_admin` assuming `jale_admin` already exists as a login
 * role — true in the real deployment (DatabaseStack's RDS master user IS
 * `jale_admin`), but not true of a bare `postgres:16` container. Mirroring
 * `billing-rls.integration.test.ts`'s own harness note ("NOT an artifact of
 * this harness applying migrations as postgres instead of jale_admin"),
 * migrations here are applied as the Postgres superuser too — jale_admin is
 * only ever a GRANT/POLICY *target*, never the DDL executor, so it must be
 * created as a plain (non-superuser) login role before the first migration
 * runs, with no owner-implied privileges of its own on any billing table.
 * That's what lets the "jale_admin has NO privilege on billing_webhook_events"
 * assertion below mean something: if jale_admin owned the tables it created,
 * ownership would grant it implicit access regardless of the GRANT list.
 *
 * When JALE_TEST_UPGRADE_DATABASE_URL is absent, every test in this file is
 * explicitly skipped and a concern is logged (Rule 11: no silent skips).
 *
 * Example (after starting a throwaway Postgres 16 container):
 *   JALE_TEST_UPGRADE_DATABASE_URL=postgres://postgres:test@localhost:55441/jale \
 *     npx jest --runInBand test/unit/db/migrations/billing-034-upgrade.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const infraRoot = path.join(__dirname, '..', '..', '..', '..');
const migrationsDir = path.join(infraRoot, 'db', 'migrations');

const databaseUrl = process.env.JALE_TEST_UPGRADE_DATABASE_URL;

// Pre-034 baseline — the "already migrated through 033, production-equivalent"
// starting point. Must exactly match apply-order.test.ts's list minus 034,
// with one deliberate exception: 020b_rls_relationship_recursion_prevention.sql
// is left OUT here. That migration's invariant checks (carried over from 039)
// require the DDL executor to be the CREATEROLE non-superuser jale_admin
// described in infra/db/migrations/020b's header (PG16 auto-grants that
// creator admin-option membership on roles it creates; a real superuser gets
// no such row). This suite's own bootstrapJaleAdminRole() below intentionally
// applies migrations as the Postgres superuser instead (jale_admin here is a
// bootstrapped LOGIN-only role, never the DDL executor — see that function's
// comment), which is the opposite role model from 020b/039's assumption and
// would fail their closing invariant DO block. 020b does not touch any
// billing table or role this suite verifies, so omitting it from this
// narrower baseline does not affect what this suite proves about 034.
const baselineMigrations = [
  '001_initial_schema.sql',
  '002_rls_policies.sql',
  '003_jobs_and_applications.sql',
  '004_whatsapp.sql',
  '005_document_vault.sql',
  '006_trust_signal_layer.sql',
  '007_worker_marketplace.sql',
  '008_worker_skills.sql',
  '009_location_foundation.sql',
  '010_matching_write_semantics.sql',
  '011_ai_profile_media.sql',
  '012_ai_trust_assessment.sql',
  '013_whatsapp_template_outbox.sql',
  '014_employer_candidate_rankings.sql',
  '015_application_status_alignment.sql',
  '016_employer_profiles.sql',
  '017_document_upload_token_hardening.sql',
  '018_document_vault_rls_hardening.sql',
  '019_application_status_constraint_repair.sql',
  '020_worker_pii_rls_hardening.sql',
  '021_whatsapp_required_docs_apply_support.sql',
  '022_job_application_required_docs_guard.sql',
  '023_job_fields_and_statuses_mvp.sql',
  '024_sprint11_hiring_flow_hardening.sql',
  '025_job_messaging.sql',
  '026_admin_panel.sql',
  '027_admin_security_hardening.sql',
  '028_job_messaging_hardening.sql',
  '029_hired_count_trigger_security_definer.sql',
  '030_whatsapp_worker_skills_seed.sql',
  '031_employer_display_name.sql',
  '032_work_authorization_required.sql',
  '033_pay_interval_experience_months_worker_certifications.sql',
];

const migration034 = '034_billing_foundation.sql';

const billingTables = [
  'organizations',
  'billing_plans',
  'billing_customers',
  'subscriptions',
  'billing_operations',
  'billing_webhook_events',
];

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

async function applyBaseline(client: Client): Promise<void> {
  for (const file of baselineMigrations) {
    await client.query(readMigration(file));
  }
}

/**
 * Create the `jale_admin` role as a plain login role (no superuser, no table
 * ownership) via the superuser bootstrap connection. Migrations only ever
 * target `jale_admin` with GRANT/CREATE POLICY statements — they are applied
 * here as the superuser, so `jale_admin` never becomes a table owner and its
 * only privileges are whatever the migrations explicitly grant it.
 */
async function bootstrapJaleAdminRole(superuserUrl: string): Promise<void> {
  const su = new Client({ connectionString: superuserUrl });
  await su.connect();
  try {
    await su.query(`CREATE ROLE jale_admin WITH LOGIN PASSWORD 'test-admin-pw'`);
  } finally {
    await su.end();
  }
}

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    // Rule 11: explicit, loud skip — not a silent pass.
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[billing-034-upgrade] SKIPPED: "${name}" — set JALE_TEST_UPGRADE_DATABASE_URL to an ` +
        'EMPTY local Postgres 16 database to run the migration-034 upgrade-path gate. ' +
        'This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.',
    );
  } else {
    describe(name, fn);
  }
}

maybeDescribe('migration 034 upgrade path (033-baseline then 034 alone)', () => {
  let client: Client;

  beforeAll(async () => {
    if (!databaseUrl) return;
    await bootstrapJaleAdminRole(databaseUrl);
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await applyBaseline(client);
  }, 120_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await client.end();
  });

  it('pre-034 baseline has no billing tables (proves the upgrade starting point)', async () => {
    for (const table of billingTables) {
      const result = await client.query<{ reg: string | null }>(
        `SELECT to_regclass($1)::text AS reg`,
        [`public.${table}`],
      );
      expect(result.rows[0].reg).toBeNull();
    }
    // users.tenant_id exists (since 001) but has no FK yet — 034 adds it.
    const fkResult = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'users_tenant_id_fkey'`,
    );
    expect(fkResult.rows).toHaveLength(0);
  });

  it('applies migration 034 alone on top of the 033 baseline without error', async () => {
    await expect(client.query(readMigration(migration034))).resolves.toBeDefined();
  });

  describe('Phase-3 verification checklist (post-034)', () => {
    it('all six billing/org tables exist', async () => {
      for (const table of billingTables) {
        const result = await client.query<{ reg: string | null }>(
          `SELECT to_regclass($1)::text AS reg`,
          [`public.${table}`],
        );
        expect(result.rows[0].reg).toBe(table);
      }
    });

    it('the three seed plans exist', async () => {
      const result = await client.query<{ code: string }>(
        `SELECT code FROM billing_plans ORDER BY code`,
      );
      expect(result.rows.map((r) => r.code)).toEqual([
        'employer_free',
        'employer_pro',
        'worker_free',
      ]);
    });

    it('employer_free active_job_limit=1 and employer_pro active_job_limit=10', async () => {
      const result = await client.query<{ code: string; entitlements: Record<string, unknown> }>(
        `SELECT code, entitlements FROM billing_plans WHERE code IN ('employer_free', 'employer_pro')`,
      );
      const byCode = new Map(result.rows.map((r) => [r.code, r.entitlements]));
      expect(byCode.get('employer_free')).toEqual({ active_job_limit: 1 });
      expect(byCode.get('employer_pro')).toEqual({ active_job_limit: 10 });
    });

    it('employer_pro catalog price is 2000 minor units, USD, monthly', async () => {
      const result = await client.query<{
        display_price_minor: number;
        currency: string;
        billing_interval: string;
      }>(
        `SELECT display_price_minor, currency, billing_interval
         FROM billing_plans WHERE code = 'employer_pro'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].display_price_minor).toBe(2000);
      expect(result.rows[0].currency).toBe('usd');
      expect(result.rows[0].billing_interval).toBe('month');
    });

    it('RLS is ENABLED and FORCED on all six billing/org tables', async () => {
      const result = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
         WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
        [billingTables],
      );
      expect(result.rows).toHaveLength(billingTables.length);
      for (const row of result.rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it('owner (jale_admin) policies exist on the four user-facing billing tables', async () => {
      const result = await client.query<{ tablename: string; policyname: string }>(
        `SELECT tablename, policyname FROM pg_policies
         WHERE schemaname = 'public'
           AND 'jale_admin' = ANY(roles)
         ORDER BY tablename, policyname`,
      );
      const tables = new Set(result.rows.map((r) => r.tablename));
      expect(tables.has('billing_customers')).toBe(true);
      expect(tables.has('subscriptions')).toBe(true);
      expect(tables.has('billing_operations')).toBe(true);
      expect(tables.has('billing_plans')).toBe(true);
      // jale_admin gets no policy on the processor-only webhook inbox.
      expect(tables.has('billing_webhook_events')).toBe(false);
    });

    it('processor (jale_billing) policies exist on all five billing tables (not organizations)', async () => {
      const result = await client.query<{ tablename: string }>(
        `SELECT DISTINCT tablename FROM pg_policies
         WHERE schemaname = 'public'
           AND 'jale_billing' = ANY(roles)
         ORDER BY tablename`,
      );
      const tables = result.rows.map((r) => r.tablename);
      expect(tables).toEqual([
        'billing_customers',
        'billing_plans',
        'billing_webhook_events',
        'subscriptions',
      ]);
    });

    it('jale_admin grants are scoped to the four user-facing billing tables (not billing_webhook_events)', async () => {
      const admin = {
        billing_plans: await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('jale_admin', 'billing_plans', 'SELECT') AS has`,
        ),
        billing_customers: await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('jale_admin', 'billing_customers', 'INSERT') AS has`,
        ),
        subscriptions: await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('jale_admin', 'subscriptions', 'SELECT') AS has`,
        ),
        billing_operations: await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('jale_admin', 'billing_operations', 'UPDATE') AS has`,
        ),
        billing_webhook_events: await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('jale_admin', 'billing_webhook_events', 'SELECT') AS has`,
        ),
      };
      expect(admin.billing_plans.rows[0].has).toBe(true);
      expect(admin.billing_customers.rows[0].has).toBe(true);
      expect(admin.subscriptions.rows[0].has).toBe(true);
      expect(admin.billing_operations.rows[0].has).toBe(true);
      expect(admin.billing_webhook_events.rows[0].has).toBe(false);
    });

    it('jale_billing grants are scoped to plans/customers (read) + subscriptions/webhooks (read-write)', async () => {
      const plansSelect = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('jale_billing', 'billing_plans', 'SELECT') AS has`,
      );
      const plansInsert = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('jale_billing', 'billing_plans', 'INSERT') AS has`,
      );
      const customersSelect = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('jale_billing', 'billing_customers', 'SELECT') AS has`,
      );
      const subscriptionsInsert = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('jale_billing', 'subscriptions', 'INSERT') AS has`,
      );
      const webhookEventsUpdate = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('jale_billing', 'billing_webhook_events', 'UPDATE') AS has`,
      );
      expect(plansSelect.rows[0].has).toBe(true);
      expect(plansInsert.rows[0].has).toBe(false); // plans read-only for the service role
      expect(customersSelect.rows[0].has).toBe(true);
      expect(subscriptionsInsert.rows[0].has).toBe(true);
      expect(webhookEventsUpdate.rows[0].has).toBe(true);
    });

    it('jale_billing has NO privilege at all on users', async () => {
      const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
      for (const priv of privs) {
        const result = await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('jale_billing', 'users', $1) AS has`,
          [priv],
        );
        expect(result.rows[0].has).toBe(false);
      }
    });

    it('jale_billing has NO privilege at all on billing_operations', async () => {
      const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
      for (const priv of privs) {
        const result = await client.query<{ has: boolean }>(
          `SELECT has_table_privilege('jale_billing', 'billing_operations', $1) AS has`,
          [priv],
        );
        expect(result.rows[0].has).toBe(false);
      }
    });
  });

  describe('idempotence guard (forward-only, not idempotent by design)', () => {
    // 034 is written forward-only (header: "Forward-only. Applied manually via
    // bastion (ADR-005)."), matching every other migration in this repo. It uses
    // plain `CREATE TABLE organizations` (no IF NOT EXISTS), an unconditional
    // `ALTER TABLE users ADD CONSTRAINT users_tenant_id_fkey`, and unconditional
    // seed INSERTs into billing_plans with no ON CONFLICT — any one of which
    // fails on a second application against an already-migrated database. Only
    // the jale_billing role creation is idempotency-guarded (DO $$ IF NOT EXISTS
    // ... $$), because CREATE ROLE has no IF NOT EXISTS form and role creation
    // is the one statement that could otherwise collide with a previous partial
    // run. The design intent is forward-only: re-running 034 must fail loudly,
    // not silently succeed as a no-op, so this asserts the failure.
    it('re-applying 034 to an already-migrated database FAILS', async () => {
      await expect(client.query(readMigration(migration034))).rejects.toThrow(
        /already exists|duplicate key|violates/i,
      );
    });
  });
});
