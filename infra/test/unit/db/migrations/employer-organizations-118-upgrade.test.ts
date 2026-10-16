/**
 * employer-organizations-118-upgrade.test.ts
 *
 * Proves migration 118's BACK-FILL on the upgrade path: a database migrated
 * through 117 that already holds employers, a worker and a job, with 118
 * applied alone on top. Every existing employer must become the active owner
 * of exactly one company, named employer_profiles.company_name, else
 * users.full_name, else 'Employer'; the worker gets no membership; and a job
 * created before 118 keeps created_by_user_id NULL (readers use
 * COALESCE(created_by_user_id, employer_id)).
 *
 * The registered suites run on a bed that already carries 118, where the
 * back-fill has nothing to do, so only a 117 baseline with rows on it can
 * show the back-fill working. Repeatable: every run builds its own baseline.
 *
 * Harness: billing-034-upgrade.test.ts's. JALE_TEST_UPGRADE_DATABASE_URL is a
 * SUPERUSER URL to an EMPTY Postgres 16 database on a bare cluster
 * (bootstrap-testbed.sh --bare: no roles, no extension). Unlike 034, the
 * chain through 117 must be applied by a non-superuser jale_admin with
 * CREATEROLE (020b, 104-106, 114b and 118 check their executor), so this
 * suite prepares that owner exactly as bootstrap-testbed.sh does and applies
 * every migration as it, like apply-order.test.ts. Fixtures are inserted
 * through the superuser connection, past row security.
 *
 * When JALE_TEST_UPGRADE_DATABASE_URL is absent, every test is explicitly
 * skipped and a concern is logged (Rule 11: no silent skips).
 *
 * Run (the database job's standard leg runs it alone, like billing-034-upgrade):
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare \
 *     --url-var JALE_TEST_UPGRADE_DATABASE_URL -- \
 *     bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/employer-organizations-118-upgrade.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const infraRoot = path.join(__dirname, '..', '..', '..', '..');
const repoRoot = path.join(infraRoot, '..');
const migrationsDir = path.join(infraRoot, 'db', 'migrations');

const databaseUrl = process.env.JALE_TEST_UPGRADE_DATABASE_URL;

const migration118 = '118_employer_organizations.sql';
const ADMIN_PASSWORD = 'test-upgrade-admin-pw';

/** The canonical chain (scripts/run-migrations.sh MIGRATIONS), up to and excluding 118. */
function baselineMigrations(): string[] {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-migrations.sh'), 'utf8');
  const block = /^MIGRATIONS=\(\n([\s\S]*?)^\)$/m.exec(script);
  if (!block) throw new Error('scripts/run-migrations.sh has no MIGRATIONS=( ... ) block');
  const chain = [...block[1].matchAll(/"(\d{3}[a-z]?_[^"]+\.sql)"/g)].map((m) => m[1]);
  const at = chain.indexOf(migration118);
  if (at < 1) throw new Error(`${migration118} is not in the MIGRATIONS chain`);
  return chain.slice(0, at);
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    // Rule 11: explicit, loud skip — not a silent pass.
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[employer-organizations-118-upgrade] SKIPPED: "${name}" — set JALE_TEST_UPGRADE_DATABASE_URL to an ` +
        'EMPTY local Postgres 16 database on a bare cluster to run the migration-118 back-fill gate. ' +
        'This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.',
    );
  } else {
    describe(name, fn);
  }
}

type Seed = {
  withCompany: string;
  withFullName: string;
  blank: string;
  worker: string;
  job: string;
};

maybeDescribe('migration 118 upgrade path (117 baseline with rows, then 118 alone)', () => {
  let su: Client;
  let admin: Client;
  let seed: Seed;

  beforeAll(async () => {
    if (!databaseUrl) return;
    su = new Client({ connectionString: databaseUrl });
    await su.connect();

    // The bed's non-superuser owner, as bootstrap-testbed.sh prepares it:
    // pg_trgm first (008 cannot create it as a non-superuser), CREATEROLE for
    // the helper roles, NOBYPASSRLS so FORCE ROW LEVEL SECURITY holds.
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

    // Rows that exist before 118. Inserted as the superuser, past row security.
    const insertUser = async (sub: string, type: 'employer' | 'worker', fullName: string | null): Promise<string> =>
      (await su.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, full_name) VALUES ($1, $2, $3) RETURNING id`,
        [sub, type, fullName],
      )).rows[0].id;
    const withCompany = await insertUser('upgrade118-with-company', 'employer', 'Ana Owner');
    await su.query(`INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, '  ACME Roofing  ')`, [withCompany]);
    const withFullName = await insertUser('upgrade118-full-name', 'employer', '  Pat Builder ');
    const blank = await insertUser('upgrade118-blank', 'employer', '   ');
    await su.query(`INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, '')`, [blank]);
    const worker = await insertUser('upgrade118-worker', 'worker', 'Wanda Worker');
    const job = (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'Roofer', 'Austin', 'full-time', 'active') RETURNING id`,
      [withCompany],
    )).rows[0].id;
    seed = { withCompany, withFullName, blank, worker, job };
  }, 600_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    try {
      await admin?.end();
    } finally {
      await su?.end();
    }
  });

  it('the 117 baseline has no memberships and no actor column (proves the upgrade starting point)', async () => {
    const result = await su.query<{ members: string | null; created_by: string | null }>(
      `SELECT to_regclass('public.organization_members')::text AS members,
              (SELECT attname::text FROM pg_attribute
                WHERE attrelid = 'public.jobs'::regclass AND attname = 'created_by_user_id' AND NOT attisdropped) AS created_by`,
    );
    expect(result.rows[0]).toEqual({ members: null, created_by: null });
    const organizations = await su.query<{ n: string }>(`SELECT count(*)::text AS n FROM organizations`);
    expect(organizations.rows[0].n).toBe('0');
  });

  it('applies migration 118 alone on top of the 117 baseline, as jale_admin, without error', async () => {
    await expect(admin.query(readMigration(migration118))).resolves.toBeDefined();
  });

  it('makes each employer the active owner of exactly one company: company_name, else full_name, else Employer', async () => {
    const { rows } = await su.query<{ user_id: string; role: string; status: string; name: string; members: string }>(
      `SELECT m.user_id, m.role, m.status, o.name,
              (SELECT count(*)::text FROM organization_members x WHERE x.organization_id = m.organization_id) AS members
         FROM organization_members m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ANY($1::uuid[])
        ORDER BY m.user_id`,
      [[seed.withCompany, seed.withFullName, seed.blank]],
    );
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, { role: r.role, status: r.status, name: r.name, members: r.members }]));
    expect(rows).toHaveLength(3);
    expect(byUser).toEqual({
      [seed.withCompany]: { role: 'owner', status: 'active', name: 'ACME Roofing', members: '1' },
      [seed.withFullName]: { role: 'owner', status: 'active', name: 'Pat Builder', members: '1' },
      [seed.blank]: { role: 'owner', status: 'active', name: 'Employer', members: '1' },
    });
    // One company each, and no company without its owner.
    const counts = await su.query<{ organizations: string; members: string }>(
      `SELECT (SELECT count(*)::text FROM organizations) AS organizations,
              (SELECT count(*)::text FROM organization_members) AS members`,
    );
    expect(counts.rows[0]).toEqual({ organizations: '3', members: '3' });
  });

  it('gives the worker no membership', async () => {
    const { rows } = await su.query(`SELECT 1 FROM organization_members WHERE user_id = $1`, [seed.worker]);
    expect(rows).toEqual([]);
  });

  it('leaves created_by_user_id NULL on the job created before 118', async () => {
    const { rows } = await su.query<{ created_by_user_id: string | null; employer_id: string }>(
      `SELECT created_by_user_id, employer_id FROM jobs WHERE id = $1`,
      [seed.job],
    );
    expect(rows).toEqual([{ created_by_user_id: null, employer_id: seed.withCompany }]);
  });

  it('drops the back-fill\'s temporary users read again', async () => {
    const { rows } = await su.query(
      `SELECT polname FROM pg_policy WHERE polrelid = 'public.users'::regclass AND polname = 'users_org_bootstrap_read'`,
    );
    expect(rows).toEqual([]);
  });
});
