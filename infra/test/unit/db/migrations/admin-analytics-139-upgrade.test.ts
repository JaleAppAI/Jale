/**
 * admin-analytics-139-upgrade.test.ts
 *
 * Proves migration 139's RELEASE INVARIANT on the upgrade path: a database
 * migrated through 138 that already holds companies, a memberless employer
 * login, a paying subscription, jobs, applications and a template, with 139
 * applied alone on top, as production will apply it.
 *
 * 139 records eight figures from the OLD function bodies (its section 0b),
 * replaces the bodies, and recomputes the figures from the NEW ones (section
 * 5b). While no company has a foreman, every figure must be equal, or the
 * apply aborts; with a foreman anywhere, the comparison is skipped with a
 * NOTICE. The registered suites apply 139 to a chain with no employers, where
 * every figure is empty on both sides, so only a 138 baseline with rows on it
 * can show the comparison working. Three cases, in this order, on one bed:
 *
 *   (c) a copy of 139 with one body deliberately broken (slowest employers
 *       drop a memberless login's jobs: the LEFT join to its membership made
 *       an inner join) aborts with the "differs from the per-login figure"
 *       message, and the old bodies are left exactly as they were;
 *   (b) with one active foreman, 139 applies and prints the skip NOTICE.
 *       There, the per-login total really does differ (the foreman is an
 *       employer login but not a company), so the skip is what lets it
 *       pass. This apply runs 139's own text with its final COMMIT replaced
 *       by ROLLBACK, so the bed stays at 138 for (a); the foreman is then
 *       removed;
 *   (a) the real 139, applied and committed over the seeded rows: no skip
 *       NOTICE, so the eight figures were compared, and they are not empty
 *       (the comparison saw data). Spot figures match those the old bodies
 *       gave just before.
 *
 * The real 139 file is never modified: (c)'s copy is written to a temporary
 * directory, and (b) edits only an in-memory copy.
 *
 * Harness: employer-organizations-118-upgrade.test.ts's.
 * JALE_TEST_UPGRADE_DATABASE_URL is a SUPERUSER URL to the EMPTY database
 * `jale` on a bare Postgres 16 cluster (bootstrap-testbed.sh --bare: no
 * roles, no extension). This suite prepares the jale_admin owner exactly as
 * bootstrap-testbed.sh does, keeps the migration ledger as the runner does,
 * and applies every migration through 138 as jale_admin. Fixtures are
 * inserted through the superuser connection, past row security, with
 * r-paths-world.ts's World (127's trigger stamps a subscription's company,
 * and 100's writes its history row).
 *
 * When JALE_TEST_UPGRADE_DATABASE_URL is absent, every test is explicitly
 * skipped and a concern is logged (Rule 11: no silent skips).
 *
 * Run (the database job's standard leg runs it alone, like the 118 upgrade suite):
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare \
 *     --url-var JALE_TEST_UPGRADE_DATABASE_URL -- \
 *     bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/admin-analytics-139-upgrade.test.ts
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from 'pg';
import { World, type UserFixture } from '../r-paths-world';

const infraRoot = path.join(__dirname, '..', '..', '..', '..');
const repoRoot = path.join(infraRoot, '..');
const migrationsDir = path.join(infraRoot, 'db', 'migrations');

const databaseUrl = process.env.JALE_TEST_UPGRADE_DATABASE_URL;

const MIGRATION_139 = '139_admin_analytics_by_company.sql';
const ADMIN_PASSWORD = 'test-upgrade-admin-pw';

/** The seven analytics functions 139 redefines, by their pre-139 signatures. */
const REDEFINED = [
  'public.admin_analytics_totals()',
  'public.admin_analytics_signups(timestamp with time zone, text)',
  'public.admin_analytics_acquisition(integer)',
  'public.admin_analytics_paying_weekly(integer)',
  'public.admin_analytics_template_reuse(integer)',
  'public.admin_analytics_paying_employers()',
  'public.admin_analytics_slowest_employers(integer, integer)',
];

/** The skip NOTICE 139's section 5b raises when a company has a foreman. */
const SKIP_NOTICE = /migration 139: a company has a foreman, .*the release invariant was not compared/;

/**
 * (c)'s deliberate defect: in the slowest-employers body only, the LEFT join
 * from a job to its holder's membership becomes an inner join, so a
 * memberless login's jobs are dropped (Review Focus 1). The anchor line
 * before it exists only in that body.
 */
const BROKEN_FROM = '      JOIN public.jobs j ON j.id = wj.job_id\n      LEFT JOIN LATERAL (\n';
const BROKEN_TO = '      JOIN public.jobs j ON j.id = wj.job_id\n      JOIN LATERAL (\n';

const LEDGER = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE public.schema_migrations
    ADD COLUMN IF NOT EXISTS checksum   TEXT,
    ADD COLUMN IF NOT EXISTS applied_by TEXT NOT NULL DEFAULT current_user;
  REVOKE ALL ON public.schema_migrations FROM PUBLIC;`;

/** The canonical chain (scripts/run-migrations.sh MIGRATIONS), up to and excluding 139. */
function baselineMigrations(): string[] {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-migrations.sh'), 'utf8');
  const block = /^MIGRATIONS=\(\n([\s\S]*?)^\)$/m.exec(script);
  if (!block) throw new Error('scripts/run-migrations.sh has no MIGRATIONS=( ... ) block');
  const chain = [...block[1].matchAll(/"(\d{3}[a-z]?_[^"]+\.sql)"/g)].map((m) => m[1]);
  const at = chain.indexOf(MIGRATION_139);
  if (at < 1) throw new Error(`${MIGRATION_139} is not in the MIGRATIONS chain`);
  return chain.slice(0, at);
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

/** Occurrences of `needle` in `text`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    // Rule 11: explicit, loud skip — not a silent pass.
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[admin-analytics-139-upgrade] SKIPPED: "${name}" — set JALE_TEST_UPGRADE_DATABASE_URL to the EMPTY ` +
        'database jale on a bare local Postgres 16 cluster to run the migration-139 release-invariant gate. ' +
        'This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.',
    );
  } else {
    describe(name, fn);
  }
}

type Row = Record<string, any>;

maybeDescribe('migration 139 upgrade path (138 baseline with rows, then 139 alone)', () => {
  let su: Client;
  let admin: Client;
  let world: World;
  let tempDir: string;
  /** NOTICE messages jale_admin's session received since the last reset. */
  let notices: string[] = [];

  let ownerA: UserFixture;
  let ownerB: UserFixture;
  let memberless: UserFixture;
  let orgA: string;

  /** Each redefined function's definition, by md5, as jale_admin's catalog shows it. */
  async function definitions(): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const fn of REDEFINED) {
      const { rows } = await su.query<{ md5: string | null }>(
        `SELECT md5(pg_get_functiondef(to_regprocedure($1))) AS md5`, [fn]);
      out[fn] = rows[0].md5;
    }
    return out;
  }

  /** The figures the release invariant compares, read as jale_admin (the owner of the definers). */
  async function figures(): Promise<{ totals: Row; slowest: Row[]; paying: Row[]; reuse: Row[]; weekly: Row[] }> {
    const q = async (sql: string): Promise<Row[]> => (await admin.query(sql)).rows;
    return {
      totals: (await q('SELECT total_employers, paying_employers FROM admin_analytics_totals()'))[0],
      slowest: await q(`SELECT employer_id, applications, unanswered_7d, active_jobs
                          FROM admin_analytics_slowest_employers(26, 100) ORDER BY employer_id`),
      paying: await q('SELECT employer_id FROM admin_analytics_paying_employers() ORDER BY employer_id'),
      reuse: await q(`SELECT week_start, employers_using_templates FROM admin_analytics_template_reuse(26)
                       WHERE employers_using_templates > 0 ORDER BY week_start`),
      weekly: await q(`SELECT week_start, employers, paying, new_paying, churned FROM admin_analytics_paying_weekly(26)
                        WHERE paying > 0 ORDER BY week_start`),
    };
  }

  /** Three applications to the job, 8 days old and unanswered, so the holder has a slowest row. */
  async function staleApplications(jobId: string, workers: UserFixture[]): Promise<void> {
    for (const w of workers) {
      await su.query(
        `INSERT INTO job_applications (job_id, worker_id, status, applied_at)
         VALUES ($1, $2, 'pending', now() - interval '8 days')`, [jobId, w.id]);
    }
  }

  beforeAll(async () => {
    if (!databaseUrl) return;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-139-upgrade-'));
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
    admin.on('notice', (msg) => notices.push(msg.message ?? ''));
    await admin.query(LEDGER);
    for (const file of baselineMigrations()) {
      try {
        await admin.query(readMigration(file));
      } catch (err) {
        throw new Error(`baseline migration ${file} failed: ${(err as Error).message}`);
      }
      await admin.query(
        `INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
        [file, createHash('sha256').update(fs.readFileSync(path.join(migrationsDir, file))).digest('hex')],
      );
    }

    // Rows that exist before 139, as production has them: two one-person
    // companies (one paying, with a template and a job posted from it), a
    // memberless employer login with its own job, and three workers who
    // applied to both jobs 8 days ago.
    world = new World(databaseUrl);
    await world.connect();
    const workers = [await world.worker(), await world.worker(), await world.worker()];
    ownerA = await world.employer({ companyName: 'Upgrade139 Roofing' });
    ownerB = await world.employer({ companyName: 'Upgrade139 Framing' });
    memberless = await world.employer({ companyName: 'Upgrade139 Memberless' });
    await su.query('DELETE FROM organization_members WHERE user_id = $1', [memberless.id]);
    orgA = (await su.query<{ organization_id: string }>(
      'SELECT organization_id FROM organization_members WHERE user_id = $1', [ownerA.id])).rows[0].organization_id;
    await su.query(
      `INSERT INTO subscriptions (user_id, plan_code, status, current_period_start, current_period_end)
       VALUES ($1, 'employer_pro', 'active', now() - interval '3 days', now() + interval '27 days')`,
      [ownerA.id],
    );
    const templateA = await world.template(ownerA.id, 'Upgrade139 template');
    const jobA = await world.job(ownerA.id, { title: 'Upgrade139 roofer' });
    await su.query('UPDATE jobs SET created_from_template_id = $2 WHERE id = $1', [jobA.id, templateA]);
    const jobM = await world.job(memberless.id, { title: 'Upgrade139 helper' });
    await staleApplications(jobA.id, workers);
    await staleApplications(jobM.id, workers);
  }, 600_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      await world?.end();
      await admin?.end();
    } finally {
      await su?.end();
    }
  });

  it('starts from a 138 baseline holding the rows, with no foreman and 139 not applied', async () => {
    const { rows } = await su.query<{ companies: string | null; foremen: string; employers: string; memberless: string }>(
      `SELECT to_regprocedure('public.admin_analytics_companies(integer, uuid)')::text AS companies,
              (SELECT count(*)::text FROM organization_members m WHERE m.role = 'foreman') AS foremen,
              (SELECT count(*)::text FROM users u WHERE u.user_type = 'employer') AS employers,
              (SELECT count(*)::text FROM users u
                WHERE u.user_type = 'employer'
                  AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id)) AS memberless`,
    );
    expect(rows[0]).toEqual({ companies: null, foremen: '0', employers: '3', memberless: '1' });
    const ledger = await su.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [MIGRATION_139]);
    expect(ledger.rows).toEqual([]);
  });

  it('(c) aborts a 139 whose new body differs from the old figure, and leaves the old bodies in place', async () => {
    const real = readMigration(MIGRATION_139);
    expect(occurrences(real, BROKEN_FROM)).toBe(1);
    const brokenPath = path.join(tempDir, 'broken-139.sql');
    fs.writeFileSync(brokenPath, real.replace(BROKEN_FROM, BROKEN_TO));
    const broken = fs.readFileSync(brokenPath, 'utf8');
    expect(broken).not.toBe(real);

    const before = await definitions();
    expect(Object.values(before).every((md5) => md5 !== null)).toBe(true);

    let failure: string | null = null;
    try {
      await admin.query(broken);
    } catch (err) {
      failure = (err as Error).message;
    } finally {
      // The file's own BEGIN left the session in the failed transaction.
      await admin.query('ROLLBACK');
    }
    expect(failure).toMatch(
      /^migration 139: with no foreman in any company, admin_analytics_slowest_employers\(26, 100\) .* differs from the per-login figure/,
    );

    expect(await definitions()).toEqual(before);
    const { rows } = await su.query<{ companies: string | null; members: string | null; policies: string }>(
      `SELECT to_regprocedure('public.admin_analytics_companies(integer, uuid)')::text AS companies,
              to_regprocedure('public.admin_analytics_company_members(uuid)')::text AS members,
              (SELECT count(*)::text FROM pg_policy
                WHERE polname IN ('organization_members_admin_analytics_read', 'organization_invites_admin_analytics_read')) AS policies`,
    );
    expect(rows[0]).toEqual({ companies: null, members: null, policies: '0' });
  });

  it('(b) with an active foreman, applies 139 and skips the comparison with a NOTICE', async () => {
    const foreman = await world.foreman(ownerA.id, { status: 'active' });
    try {
      // The per-login total counts the foreman; the company total will not.
      // Without the skip, figure 1 would abort the apply.
      const perLogin = (await admin.query('SELECT total_employers FROM admin_analytics_totals()')).rows[0];
      expect(Number(perLogin.total_employers)).toBe(4);

      const real = readMigration(MIGRATION_139);
      expect(real.trimEnd().endsWith('\nCOMMIT;')).toBe(true);
      // Same text, but undone at the end, so (a) still starts from 138.
      const rehearsal = `${real.trimEnd().slice(0, -'COMMIT;'.length)}ROLLBACK;\n`;

      notices = [];
      await expect(admin.query(rehearsal)).resolves.toBeDefined();
      expect(notices.filter((n) => SKIP_NOTICE.test(n))).toHaveLength(1);

      // Rolled back: still the 138 bodies.
      const { rows } = await su.query<{ companies: string | null }>(
        `SELECT to_regprocedure('public.admin_analytics_companies(integer, uuid)')::text AS companies`);
      expect(rows[0].companies).toBeNull();
    } finally {
      await su.query('DELETE FROM organization_members WHERE user_id = $1', [foreman.id]);
      await su.query('DELETE FROM users WHERE id = $1', [foreman.id]);
    }
    const foremen = await su.query(`SELECT 1 FROM organization_members WHERE role = 'foreman'`);
    expect(foremen.rows).toEqual([]);
  });

  it('(a) applies the real 139 over the rows, compares the eight figures, and they are not empty', async () => {
    const before = await figures();
    // The comparison has data to see: every compared family is non-empty.
    expect(Number(before.totals.total_employers)).toBe(3);
    expect(Number(before.totals.paying_employers)).toBe(1);
    expect(before.slowest.map((r) => r.employer_id).sort()).toEqual([ownerA.id, memberless.id].sort());
    expect(before.paying.map((r) => r.employer_id)).toEqual([ownerA.id]);
    expect(before.reuse.length).toBeGreaterThan(0);
    expect(before.weekly.length).toBeGreaterThan(0);

    notices = [];
    await expect(admin.query(readMigration(MIGRATION_139))).resolves.toBeDefined();
    // No skip: the eight figures were compared, and none differed.
    expect(notices.filter((n) => SKIP_NOTICE.test(n))).toEqual([]);

    const { rows } = await su.query<{ companies: string | null }>(
      `SELECT to_regprocedure('public.admin_analytics_companies(integer, uuid)')::text AS companies`);
    expect(rows[0].companies).not.toBeNull();

    // The new bodies give the same figures over the same rows.
    expect(await figures()).toEqual(before);
    // And the new columns place each row in its company: the memberless login has none.
    const slowest = (await admin.query(
      'SELECT employer_id, organization_id FROM admin_analytics_slowest_employers(26, 100)')).rows;
    expect(Object.fromEntries(slowest.map((r) => [r.employer_id, r.organization_id]))).toEqual({
      [ownerA.id]: orgA,
      [memberless.id]: null,
    });
    const companies = (await admin.query('SELECT organization_id, owner_id FROM admin_analytics_companies(10)')).rows;
    expect(companies.map((r) => r.owner_id).sort()).toEqual([ownerA.id, ownerB.id].sort());
  });
});
