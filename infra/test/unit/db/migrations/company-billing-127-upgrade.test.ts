/**
 * company-billing-127-upgrade.test.ts
 *
 * Proves migration 127's BACK-FILL on the upgrade path: a database migrated
 * through everything before 127, holding billing rows written the pre-Phase-2
 * way (a Stripe customer and two subscriptions keyed by the payer alone, as
 * every paying employer's rows are at release), with 127 applied on top.
 * A payer with no company, an employer with no company who pays nothing, a
 * Stripe customer who is a suspended foreman and a company with two current
 * subscriptions each make 127 refuse to apply (naming the payers in its
 * DETAIL) and change nothing; once each is resolved, 127 applies, every row
 * names its payer's company, the columns are NOT NULL and the per-user index
 * is gone.
 *
 * Harness: employer-organizations-118-upgrade.test.ts's. JALE_TEST_UPGRADE_
 * DATABASE_URL is a SUPERUSER URL to an EMPTY Postgres 16 database on a bare
 * cluster (bootstrap-testbed.sh --bare). The chain is applied by a
 * non-superuser jale_admin with CREATEROLE, as on a real bed; fixtures go in
 * through the superuser connection, past row security.
 *
 * When JALE_TEST_UPGRADE_DATABASE_URL is absent, every test is explicitly
 * skipped and a concern is logged (Rule 11: no silent skips).
 *
 * Run (the database job's standard leg runs it alone):
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare \
 *     --url-var JALE_TEST_UPGRADE_DATABASE_URL -- \
 *     bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/company-billing-127-upgrade.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const infraRoot = path.join(__dirname, '..', '..', '..', '..');
const repoRoot = path.join(infraRoot, '..');
const migrationsDir = path.join(infraRoot, 'db', 'migrations');

const databaseUrl = process.env.JALE_TEST_UPGRADE_DATABASE_URL;

const migration127 = '127_company_billing.sql';
const ADMIN_PASSWORD = 'test-upgrade-admin-pw';

/** The canonical chain (scripts/run-migrations.sh MIGRATIONS), up to and excluding 127. */
function baselineMigrations(): string[] {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-migrations.sh'), 'utf8');
  const block = /^MIGRATIONS=\(\n([\s\S]*?)^\)$/m.exec(script);
  if (!block) throw new Error('scripts/run-migrations.sh has no MIGRATIONS=( ... ) block');
  const chain = [...block[1].matchAll(/"(\d{3}[a-z]?_[^"]+\.sql)"/g)].map((m) => m[1]);
  const at = chain.indexOf(migration127);
  if (at < 1) throw new Error(`${migration127} is not in the MIGRATIONS chain`);
  return chain.slice(0, at);
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[company-billing-127-upgrade] SKIPPED: "${name}" — set JALE_TEST_UPGRADE_DATABASE_URL to an ` +
        'EMPTY local Postgres 16 database on a bare cluster to run the migration-127 back-fill gate. ' +
        'This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.',
    );
  } else {
    describe(name, fn);
  }
}

type Seed = { owner: string; company: string; orphan: string; noCompany: string; oldSub: string; newSub: string };

maybeDescribe('migration 127 upgrade path (pre-127 baseline with billing rows, then 127)', () => {
  let su: Client;
  let admin: Client;
  let seed: Seed;
  let orphanCompany: string;

  /** Applies 127 expecting a refusal; returns the error and rolls the session back. */
  async function refusal(): Promise<{ message: string; detail?: string }> {
    const err = await admin.query(readMigration(migration127)).then(
      () => null,
      (e: { message: string; detail?: string }) => e,
    );
    await admin.query('ROLLBACK');
    expect(err).not.toBeNull();
    return err!;
  }

  /** Nothing of 127 is left after a refusal: the whole transaction rolled back. */
  async function expectUntouched(): Promise<void> {
    const { rows } = await su.query(
      `SELECT to_regprocedure('public.billing_stamp_organization()') IS NULL AS no_trigger_function,
              to_regclass('public.subscriptions_one_current_per_user') IS NOT NULL AS old_index,
              to_regclass('public.subscriptions_one_current_per_organization') IS NULL AS no_new_index,
              (SELECT count(*)::int FROM billing_customers WHERE organization_id IS NOT NULL)
                + (SELECT count(*)::int FROM subscriptions WHERE organization_id IS NOT NULL) AS stamped,
              (SELECT count(*)::int FROM pg_policy
                WHERE polname IN ('billing_customers_org_backfill', 'subscriptions_org_backfill', 'billing_plans_seat_seed',
                                  'users_org_bootstrap_read', 'subscriptions_org_member_read',
                                  'organization_members_trigger_read')) AS policies,
              (SELECT count(*)::int FROM billing_plans WHERE entitlements ? 'foreman_seat_limit') AS seeded,
              (SELECT count(*)::int FROM pg_attribute
                WHERE attrelid IN ('public.billing_customers'::regclass, 'public.subscriptions'::regclass)
                  AND attname = 'organization_id' AND attnotnull) AS not_null_columns`,
    );
    expect(rows[0]).toEqual({
      no_trigger_function: true, old_index: true, no_new_index: true, stamped: 0, policies: 0, seeded: 0, not_null_columns: 0,
    });
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    su = new Client({ connectionString: databaseUrl });
    await su.connect();

    // The bed's non-superuser owner, as bootstrap-testbed.sh prepares it.
    await su.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await su.query(
      `CREATE ROLE jale_admin LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
       PASSWORD '${ADMIN_PASSWORD}'`,
    );
    await su.query(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO jale_admin', current_database()); END $$`);
    await su.query('ALTER SCHEMA public OWNER TO jale_admin');

    const adminUrl = new URL(databaseUrl);
    adminUrl.username = 'jale_admin';
    adminUrl.password = ADMIN_PASSWORD;
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    for (const file of baselineMigrations()) {
      try {
        await admin.query(readMigration(file));
      } catch (err) {
        throw new Error(`baseline migration ${file} failed: ${(err as Error).message}`);
      }
    }

    // Rows as they exist at release: a one-person company whose owner pays,
    // with the billing rows keyed by the payer alone. Superuser, past RLS.
    const insertUser = async (sub: string): Promise<string> =>
      (await su.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`,
        [sub, `${sub}@example.invalid`],
      )).rows[0].id;
    const owner = await insertUser('upgrade127-owner');
    const company = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Upgrade Co') RETURNING id`)).rows[0].id;
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [owner, company]);
    await su.query(`INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', 'cus_upgrade127_owner')`, [owner]);
    const oldSub = (await su.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', 'sub_upgrade127_old', 'canceled') RETURNING id`,
      [owner],
    )).rows[0].id;
    const newSub = (await su.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', 'sub_upgrade127_new', 'active') RETURNING id`,
      [owner],
    )).rows[0].id;
    // A payer with no company: 127 must refuse to run until it has one.
    const orphan = await insertUser('upgrade127-orphan');
    await su.query(`INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', 'cus_upgrade127_orphan')`, [orphan]);
    // An employer with no company who pays nothing: 127 must refuse to run until they have one too.
    const noCompany = await insertUser('upgrade127-nocompany');
    seed = { owner, company, orphan, noCompany, oldSub, newSub };
  }, 600_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    try {
      await admin?.end();
    } finally {
      await su?.end();
    }
  });

  it('the baseline has nullable, empty organization_id columns and the per-user index (the upgrade starting point)', async () => {
    const { rows } = await su.query(
      `SELECT (SELECT count(*)::int FROM billing_customers WHERE organization_id IS NOT NULL)
            + (SELECT count(*)::int FROM subscriptions WHERE organization_id IS NOT NULL) AS stamped,
              to_regclass('public.subscriptions_one_current_per_user')::text AS old_index`,
    );
    expect(rows[0]).toEqual({ stamped: 0, old_index: 'subscriptions_one_current_per_user' });
  });

  it('refuses to apply while a payer has no company, names the payer, and changes nothing', async () => {
    const err = await refusal();
    expect(err.message).toMatch(/1 billing_customers rows have a payer with no company/);
    expect(err.detail).toContain(`${seed.orphan} (employer)`);
    await expectUntouched();
  });

  it('refuses to apply while an employer who pays nothing has no company, names them, and changes nothing', async () => {
    orphanCompany = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Orphan Co') RETURNING id`)).rows[0].id;
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [seed.orphan, orphanCompany]);
    const err = await refusal();
    expect(err.message).toMatch(/1 employer users have no company/);
    expect(err.detail).toContain(`${seed.noCompany} (employer)`);
    await expectUntouched();
  });

  it('refuses to apply while a Stripe customer is not the company\'s active owner (a suspended foreman), and changes nothing', async () => {
    const foreman = (await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ('upgrade127-foreman', 'employer', 'upgrade127-foreman@example.invalid') RETURNING id`,
    )).rows[0].id;
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'foreman', 'suspended')`, [foreman, seed.company]);
    await su.query(`INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', 'cus_upgrade127_foreman')`, [foreman]);
    const err = await refusal();
    expect(err.message).toMatch(/1 Stripe customers belong to a member who is not their company's active owner/);
    expect(err.detail).toContain(`${foreman} (employer; foreman, suspended in company ${seed.company})`);
    await expectUntouched();
    // Resolved: the foreman's Stripe customer goes.
    await su.query(`DELETE FROM billing_customers WHERE user_id = $1`, [foreman]);
  });

  it('refuses to apply while a company has two current subscriptions, and changes nothing', async () => {
    const foreman = (await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ('upgrade127-foreman2', 'employer', 'upgrade127-foreman2@example.invalid') RETURNING id`,
    )).rows[0].id;
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'foreman', 'active')`, [foreman, seed.company]);
    // The per-user index allows it: a different payer in the same company.
    await su.query(
      `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', 'sub_upgrade127_foreman2', 'active')`,
      [foreman],
    );
    const err = await refusal();
    expect(err.message).toMatch(/1 companies have more than one current subscription/);
    expect(err.detail).toContain(`company ${seed.company}: `);
    expect(err.detail).toContain(`${seed.owner} (employer)`);
    expect(err.detail).toContain(`${foreman} (employer)`);
    await expectUntouched();
    // Resolved: the second current subscription goes.
    await su.query(`DELETE FROM subscriptions WHERE user_id = $1`, [foreman]);
  });

  it('applies once every employer owns a company', async () => {
    const company = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Quiet Co') RETURNING id`)).rows[0].id;
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [seed.noCompany, company]);
    await expect(admin.query(readMigration(migration127))).resolves.toBeDefined();
  });

  it('stamps the once-orphaned payer\'s Stripe customer with the company it was given', async () => {
    const { rows } = await su.query<{ organization_id: string }>(
      `SELECT organization_id FROM billing_customers WHERE user_id = $1`, [seed.orphan]);
    expect(rows).toEqual([{ organization_id: orphanCompany }]);
  });

  it('back-fills every billing row from its payer\'s company and drops the per-user index', async () => {
    const customers = await su.query<{ provider_customer_id: string; organization_id: string }>(
      `SELECT provider_customer_id, organization_id FROM billing_customers WHERE user_id = $1`, [seed.owner]);
    expect(customers.rows).toEqual([{ provider_customer_id: 'cus_upgrade127_owner', organization_id: seed.company }]);
    const subs = await su.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id FROM subscriptions WHERE user_id = $1 ORDER BY provider_subscription_id`, [seed.owner]);
    expect(subs.rows).toEqual([
      { id: seed.newSub, organization_id: seed.company },
      { id: seed.oldSub, organization_id: seed.company },
    ]);
    const catalog = await su.query(
      `SELECT to_regclass('public.subscriptions_one_current_per_user') IS NULL AS old_index_gone,
              (SELECT count(*)::int FROM pg_attribute
                WHERE attrelid IN ('public.billing_customers'::regclass, 'public.subscriptions'::regclass)
                  AND attname = 'organization_id' AND attnotnull) AS not_null_columns`,
    );
    expect(catalog.rows[0]).toEqual({ old_index_gone: true, not_null_columns: 2 });
  });

  it('seeds the seat limits and leaves no temporary policy behind', async () => {
    const plans = await su.query(
      `SELECT code, (entitlements->>'foreman_seat_limit')::int AS seats FROM billing_plans
        WHERE code IN ('employer_free', 'employer_pro') ORDER BY code`);
    expect(plans.rows).toEqual([{ code: 'employer_free', seats: 0 }, { code: 'employer_pro', seats: 3 }]);
    const temp = await su.query(
      `SELECT polname FROM pg_policy WHERE polname IN ('billing_customers_org_backfill', 'subscriptions_org_backfill', 'billing_plans_seat_seed',
                                                     'users_org_bootstrap_read')`);
    expect(temp.rows).toEqual([]);
  });
});
