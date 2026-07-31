/**
 * referrals-rls.integration.test.ts
 *
 * PostgreSQL-backed RLS and constraint tests for the job-referral schema
 * introduced in migration 056 (job_share_links, job_share_opens,
 * worker_attribution, referral_apply_tokens, referral_pending_claims, and the
 * jale_public_jobs anonymous read role).
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with the
 * full migration chain (001→057) already applied. When absent, all tests are
 * explicitly skipped and the concern is logged (Rule 11: no silent skips).
 *
 * The harness mirrors infra/test/unit/db/billing-rls.integration.test.ts:
 * - jale_admin sessions use SET LOCAL app.current_user_id = <cognito_sub>
 * - jale_whatsapp sessions connect directly (no RLS context needed — its
 *   policies are USING (true))
 * - jale_public_jobs sessions connect directly (anonymous — no cognito context
 *   exists for this role at all)
 *
 * ---------------------------------------------------------------------------
 * Bootstrapping note (reproduce this to stand up a fresh testbed by hand):
 *
 * Applying migrations 001→057 into a brand-new container requires:
 *
 *   1. jale_admin must be created as
 *        CREATE ROLE jale_admin WITH LOGIN CREATEROLE CREATEDB NOSUPERUSER;
 *      and must OWN the target database. This mirrors the real RDS master
 *      user model (infra/lib/stacks/database-stack.ts uses
 *      rds.Credentials.fromGeneratedSecret('jale_admin')): the master user is
 *      a member of rds_superuser but its own rolbypassrls/rolsuper attributes
 *      are false. Applying the chain as a genuine Postgres superuser (e.g.
 *      plain `postgres`) does not reproduce the same guard behavior as
 *      production and is not equivalent to this bootstrap.
 *
 *   2. All service roles (jale_billing, jale_whatsapp, jale_matching,
 *      jale_ai, jale_admin_console, jale_public_jobs, etc.) are CLUSTER-WIDE
 *      objects, not database-local. Re-running the full chain against a
 *      *reused* Postgres cluster (only DROP/CREATE DATABASE, not a fresh
 *      container) fails with "role ... already exists" partway through —
 *      the roles must be dropped (or the whole container discarded) between
 *      independent apply runs.
 *
 *   3. Migrations 020b, 036, 038 and 040 contain guards that assert specific
 *      role-membership/attribute invariants (e.g. "helper role has no unsafe
 *      attributes", "grantor is a role recognized as the RDS-style creator").
 *      These guards are written against the non-superuser CREATEROLE
 *      jale_admin model in point (1) and were only verified against that
 *      model — do not assume they pass identically if jale_admin is instead
 *      a real superuser.
 *
 *   4. Migration 023's job_fields_and_statuses_mvp UPDATE would recurse
 *      ("infinite recursion detected in policy for relation users") if
 *      applied to a chain that lacks 020b — 020b exists specifically to
 *      repair that recursion class *before* 023 runs into it, and 038 later
 *      repairs the same relationship again for defense in depth. As long as
 *      migrations are applied strictly in the numeric order
 *      001, 002, ..., 019, 020, 020b, 021, ..., 056, 057 (note: plain
 *      lexical `sort` on most locales places "020b" BEFORE "020_" — use
 *      `LC_ALL=C sort`, or the explicit ordered list in
 *      test/unit/db/migrations/apply-order.test.ts, to get 020 before 020b),
 *      no BYPASSRLS grant is needed for the apply itself.
 *
 *   5. FORCE ROW LEVEL SECURITY applies even to a table's owner — and every
 *      migration in this repo runs as jale_admin, so jale_admin ends up
 *      owning every table it creates. Connecting the *test harness itself*
 *      as jale_admin therefore does NOT bypass RLS: an INSERT into `users`
 *      as jale_admin with no matching RLS-context row fails with "new row
 *      violates row-level security policy for table users" even though
 *      jale_admin is the table owner. Empirically verified against this
 *      exact chain. JALE_TEST_DATABASE_URL must therefore point at a real
 *      Postgres superuser (e.g. `postgres`) for the *test connection*, even
 *      though the migrations underneath it were applied as the non-superuser
 *      jale_admin bootstrap role from point 1. These are two different
 *      roles serving two different purposes: jale_admin applies the chain
 *      (so the CREATEROLE-guard migrations behave like production);
 *      `postgres` (or another genuine superuser) drives this test's fixture
 *      setup (so RLS can be bypassed for inserts unrelated to the behavior
 *      under test).
 *
 * This suite does NOT stand up its own database — it only consumes
 * JALE_TEST_DATABASE_URL, exactly like billing-rls.integration.test.ts. The
 * database pointed to by that URL must already have the full migration
 * chain applied (as jale_admin, per points 1–4), and the URL's own role must
 * be a genuine Postgres superuser (per point 5) so fixture setup can bypass
 * RLS; jale_admin's own password is then set separately for the RLS-enforced
 * test paths.
 * ---------------------------------------------------------------------------
 */

import { randomBytes } from 'crypto';
import { Client } from 'pg';
import type { PoolClient } from 'pg';
import { writeWebAttribution } from '../../../lambda/lib/referral-attribution';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Random fixture generators — every test run mints fresh codes/hashes so the
// suite is idempotent across re-runs against a non-fresh database (mirroring
// the re-runnability the billing-rls suite gets from ON CONFLICT upserts).
// ---------------------------------------------------------------------------

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, minus I L O U

/** Random code matching the '^[0-9A-HJKMNP-TV-Z]{n}$' charset CHECK. */
function randomCode(length: number): string {
  let out = '';
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Random 64-char lowercase hex string matching the '^[0-9a-f]{64}$' CHECKs. */
function randomHash(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Harness helpers (copied from billing-rls.integration.test.ts)
// ---------------------------------------------------------------------------

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    await client.query(`ALTER ROLE jale_billing WITH PASSWORD 'test-billing-pw'`);
    await client.query(`ALTER ROLE jale_matching WITH PASSWORD 'test-matching-pw'`);
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    await client.query(`ALTER ROLE jale_ai WITH PASSWORD 'test-ai-pw'`);
    await client.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`);
    // New in migration 056: the anonymous public-jobs read role.
    await client.query(`ALTER ROLE jale_public_jobs WITH PASSWORD 'test-publicjobs-pw'`);
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

async function asAdmin<T>(
  adminUrl: string,
  cognitoSub: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
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

/** Run a block as jale_whatsapp (service role, no RLS context needed). */
async function asWhatsapp<T>(
  whatsappUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: whatsappUrl });
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

/** Run a block as jale_public_jobs (anonymous read role, no RLS context). */
async function asPublicJobs<T>(
  publicUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: publicUrl });
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

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    // Rule 11: explicit, loud skip — not a silent pass
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[referrals-rls.integration] SKIPPED: "${name}" — set JALE_TEST_DATABASE_URL to run PostgreSQL-backed RLS tests. ` +
        `This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.`,
    );
  } else {
    describe(name, fn);
  }
}

// ---------------------------------------------------------------------------
// Test state — populated once in beforeAll
// ---------------------------------------------------------------------------

let superuserUrl: string; // jale_admin bootstrap URL — bypasses RLS for fixture setup
let adminUrl: string; // jale_admin role — FORCE RLS applies; use for RLS tests
let whatsappUrl: string; // jale_whatsapp service role
let publicUrl: string; // jale_public_jobs anonymous role

let employerUserId: string;
let employerCognitoSub: string;
let workerUserId: string;
let workerCognitoSub: string;

async function makeJob(
  overrides: Partial<{
    employer_id: string;
    public_listing_enabled: boolean;
    status: string;
  }> = {},
): Promise<string> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    const result = await client.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, public_listing_enabled, status)
       VALUES ($1, 'Test Job', 'Austin, TX', 'full-time', $2, $3)
       RETURNING id`,
      [
        overrides.employer_id ?? employerUserId,
        overrides.public_listing_enabled ?? true,
        overrides.status ?? 'active',
      ],
    );
    return result.rows[0].id;
  } finally {
    await client.end();
  }
}

maybeDescribe('job-referrals RLS integration (migration 056)', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;

    superuserUrl = databaseUrl;
    await setServiceRolePasswords(superuserUrl);

    adminUrl = new URL(databaseUrl).username === 'jale_admin'
      ? databaseUrl
      : urlForRole(databaseUrl, 'jale_admin', 'test-admin-pw');
    whatsappUrl = urlForRole(databaseUrl, 'jale_whatsapp', 'test-whatsapp-pw');
    publicUrl = urlForRole(databaseUrl, 'jale_public_jobs', 'test-publicjobs-pw');

    const setup = new Client({ connectionString: superuserUrl });
    await setup.connect();
    try {
      const e1 = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
         VALUES ('referrals-emp-1', 'employer', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      employerUserId = e1.rows[0].id;
      employerCognitoSub = e1.rows[0].cognito_sub;

      const w1 = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number, created_at, updated_at)
         VALUES ('referrals-worker-1', 'worker', '+10000000101', now(), now())
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      workerUserId = w1.rows[0].id;
      workerCognitoSub = w1.rows[0].cognito_sub;
    } finally {
      await setup.end();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Public role cannot reach the never-expose list
  // -------------------------------------------------------------------------
  describe('jale_public_jobs: never-expose column projection is a grant, not handler discipline', () => {
    it('SELECT employer_id FROM jobs fails with a permission error', async () => {
      await expect(
        asPublicJobs(publicUrl, (client) => client.query(`SELECT employer_id FROM jobs`)),
      ).rejects.toThrow(/permission denied/i);
    });

    it('SELECT * FROM jobs also fails — the projection is a grant, not handler discipline', async () => {
      await expect(
        asPublicJobs(publicUrl, (client) => client.query(`SELECT * FROM jobs`)),
      ).rejects.toThrow(/permission denied/i);
    });

    it('selecting only granted columns succeeds', async () => {
      const jobId = await makeJob();
      const result = await asPublicJobs(publicUrl, (client) =>
        client.query<{ id: string; public_code: string }>(
          `SELECT id, public_code, title, status, public_listing_enabled FROM jobs WHERE id = $1`,
          [jobId],
        ),
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe(jobId);
    });

    it.each(['users', 'job_applications', 'employer_profiles'])(
      'gets a permission error on %s',
      async (table) => {
        await expect(
          asPublicJobs(publicUrl, (client) => client.query(`SELECT * FROM ${table}`)),
        ).rejects.toThrow(/permission denied/i);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Employer consent and the closed-job page
  // -------------------------------------------------------------------------
  describe('jale_public_jobs: employer consent and the closed-job page', () => {
    it('a job with public_listing_enabled = false is zero rows, at any status', async () => {
      const activeOptOutJob = await makeJob({ public_listing_enabled: false, status: 'active' });
      const filledOptOutJob = await makeJob({ public_listing_enabled: false, status: 'filled' });

      const result = await asPublicJobs(publicUrl, (client) =>
        client.query(
          `SELECT id FROM jobs WHERE id = ANY($1::uuid[])`,
          [[activeOptOutJob, filledOptOutJob]],
        ),
      );
      expect(result.rows).toHaveLength(0);
    });

    it('a filled job with public_listing_enabled = true IS visible (friendly closed page, not a 404)', async () => {
      const filledJob = await makeJob({ public_listing_enabled: true, status: 'filled' });

      const result = await asPublicJobs(publicUrl, (client) =>
        client.query<{ id: string; status: string }>(
          `SELECT id, status FROM jobs WHERE id = $1`,
          [filledJob],
        ),
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].status).toBe('filled');
    });
  });

  // -------------------------------------------------------------------------
  // First-touch immutability is a trigger, not a withheld grant
  // -------------------------------------------------------------------------
  describe('public listing is opt-IN (migration 057)', () => {
    // makeJob always sets public_listing_enabled explicitly, so these two tests
    // insert WITHOUT the column: the DB default is precisely what is under
    // test. Before 056 the default was true, which would have made every
    // existing job public the moment the route deployed — with no consent step
    // and nothing in the product able to write the column.
    async function makeJobWithDefaultVisibility(): Promise<string> {
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO jobs (employer_id, title, location, job_type, status)
           VALUES ($1, 'Default Visibility Job', 'Austin, TX', 'full-time', 'active')
           RETURNING id`,
          [employerUserId],
        );
        return result.rows[0].id;
      } finally {
        await client.end();
      }
    }

    it('a newly inserted job is NOT publicly visible until opted in', async () => {
      const jobId = await makeJobWithDefaultVisibility();
      const seen = await asPublicJobs(publicUrl, (client) =>
        client.query(`SELECT id FROM jobs WHERE id = $1`, [jobId]),
      );
      expect(seen.rows).toHaveLength(0);
    });

    it('becomes visible once the employer opts in', async () => {
      const jobId = await makeJobWithDefaultVisibility();
      const setup = new Client({ connectionString: superuserUrl });
      await setup.connect();
      try {
        await setup.query(`UPDATE jobs SET public_listing_enabled = true WHERE id = $1`, [jobId]);
      } finally {
        await setup.end();
      }
      const seen = await asPublicJobs(publicUrl, (client) =>
        client.query(`SELECT id FROM jobs WHERE id = $1`, [jobId]),
      );
      expect(seen.rows).toHaveLength(1);
    });
  });

  describe('jale_public_jobs: the REAL open-record statement (migration 058)', () => {
    // Production finding (2026-07-31): the de-duplication guard reads
    // job_share_opens via NOT EXISTS before inserting, but the role was only
    // granted INSERT — every open was dropped with "permission denied" while
    // the page rendered fine. This suite previously never exercised the
    // statement at all, and a plain INSERT...VALUES would still pass today.
    // So: run the EXACT statement public-job.ts executes. If the handler's
    // SQL changes shape again, change it here in lockstep.
    const GUARDED_OPEN_INSERT = `INSERT INTO job_share_opens (share_code, job_id, device_kind, locale, visitor_hash)
             SELECT $1, $2, $3, $4, $5
              WHERE $5::text IS NULL
                 OR NOT EXISTS (
                   SELECT 1 FROM job_share_opens
                    WHERE visitor_hash = $5
                      AND job_id = $2
                      AND opened_at > now() - interval '30 minutes'
                 )
             RETURNING id`;

    it('records an open with a non-null visitor hash (the guard must be readable)', async () => {
      const jobId = await makeJob();
      const visitorHash = randomHash();
      const inserted = await asPublicJobs(publicUrl, (client) =>
        client.query(GUARDED_OPEN_INSERT, [null, jobId, 'mobile', 'es', visitorHash]),
      );
      expect(inserted.rows).toHaveLength(1);
    });

    it('the same visitor within the window is a no-op at the DB layer', async () => {
      const jobId = await makeJob();
      const visitorHash = randomHash();
      await asPublicJobs(publicUrl, (client) =>
        client.query(GUARDED_OPEN_INSERT, [null, jobId, 'mobile', 'es', visitorHash]),
      );
      const repeat = await asPublicJobs(publicUrl, (client) =>
        client.query(GUARDED_OPEN_INSERT, [null, jobId, 'mobile', 'es', visitorHash]),
      );
      expect(repeat.rows).toHaveLength(0);
    });

    it('a null visitor hash always records (no salt configured must not under-count)', async () => {
      const jobId = await makeJob();
      const first = await asPublicJobs(publicUrl, (client) =>
        client.query(GUARDED_OPEN_INSERT, [null, jobId, 'unknown', null, null]),
      );
      const second = await asPublicJobs(publicUrl, (client) =>
        client.query(GUARDED_OPEN_INSERT, [null, jobId, 'unknown', null, null]),
      );
      expect(first.rows).toHaveLength(1);
      expect(second.rows).toHaveLength(1);
    });

    it('the grant stays column-scoped: the role cannot read share_code from opens', async () => {
      await expect(
        asPublicJobs(publicUrl, (client) => client.query(`SELECT share_code FROM job_share_opens LIMIT 1`)),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('worker_attribution: first-touch immutability trigger', () => {
    // Each test below creates its OWN brand-new worker (unique cognito_sub,
    // hence a worker_id that has never existed in worker_attribution before)
    // and seeds the row itself with a freshly-randomized first_channel. This
    // is deliberate: worker_attribution's PK is worker_id, so reusing a
    // shared worker across test runs — combined with a hardcoded seed value
    // like 'whatsapp' and a hardcoded update value like 'sms' — makes
    // ON CONFLICT (worker_id) DO NOTHING a silent no-op on the second and
    // subsequent runs. If the seed value ever happened to already equal the
    // update value (exactly what happens once the trigger is broken and the
    // update commits), IS DISTINCT FROM would read false and the test would
    // wrongly pass even with the immutability trigger completely gone. A
    // fresh worker per test makes the initial INSERT unconditionally the one
    // that creates the row, so no prior run's state can leak in.
    async function makeWorker(): Promise<{ id: string; cognitoSub: string }> {
      const cognitoSub = `referrals-fresh-worker-${randomCode(16)}`;
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
           VALUES ($1, 'worker', now(), now())
           RETURNING id`,
          [cognitoSub],
        );
        return { id: result.rows[0].id, cognitoSub };
      } finally {
        await client.end();
      }
    }

    /** Seeds a NEW row (never an upsert) for a worker_id guaranteed to be fresh. */
    async function seedAttribution(workerId: string, firstChannel: string): Promise<void> {
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO worker_attribution (worker_id, first_channel, first_seen_at)
           VALUES ($1, $2, now())`,
          [workerId, firstChannel],
        );
      } finally {
        await client.end();
      }
    }

    const firstTouchColumnNames = [
      'first_channel',
      'first_share_code',
      'first_referrer_worker_id',
      'first_seen_at',
    ] as const;

    it.each(firstTouchColumnNames)('updating %s raises, as jale_admin', async (column) => {
      const worker = await makeWorker();
      // Seed with 'whatsapp' and update to 'sms' when the mutated column IS
      // first_channel, so the two values are guaranteed distinct regardless
      // of the fresh worker; for the other columns the seed leaves
      // first_channel at 'whatsapp' and only the target column is touched.
      await seedAttribution(worker.id, 'whatsapp');

      const valueByColumn: Record<(typeof firstTouchColumnNames)[number], string> = {
        first_channel: `'sms'`,
        first_share_code: `'${randomCode(8)}'`,
        first_referrer_worker_id: `gen_random_uuid()`,
        first_seen_at: `now() + interval '1 day'`,
      };

      await expect(
        asAdmin(adminUrl, worker.cognitoSub, (client) =>
          client.query(
            `UPDATE worker_attribution SET ${column} = ${valueByColumn[column]} WHERE worker_id = $1`,
            [worker.id],
          ),
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it('updating first_job_id raises, as jale_admin', async () => {
      const worker = await makeWorker();
      const jobId = await makeJob();
      await seedAttribution(worker.id, 'whatsapp');
      await expect(
        asAdmin(adminUrl, worker.cognitoSub, (client) =>
          client.query(`UPDATE worker_attribution SET first_job_id = $2 WHERE worker_id = $1`, [
            worker.id,
            jobId,
          ]),
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it('the same update also raises as jale_whatsapp — a withheld grant would be no protection since jale_admin owns the table', async () => {
      const worker = await makeWorker();
      await seedAttribution(worker.id, 'whatsapp');
      await expect(
        asWhatsapp(whatsappUrl, (client) =>
          client.query(`UPDATE worker_attribution SET first_channel = 'facebook' WHERE worker_id = $1`, [
            worker.id,
          ]),
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it('latest_* columns remain freely writable', async () => {
      const worker = await makeWorker();
      const jobId = await makeJob();
      await seedAttribution(worker.id, 'whatsapp');
      const result = await asAdmin(adminUrl, worker.cognitoSub, (client) =>
        client.query(
          `UPDATE worker_attribution
           SET latest_share_code = $3, latest_channel = 'sms', latest_job_id = $2, latest_seen_at = now()
           WHERE worker_id = $1`,
          [worker.id, jobId, randomCode(8)],
        ),
      );
      expect(result.rowCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The recursion class from migration 038 has not returned
  // -------------------------------------------------------------------------
  describe('no recursion class from migration 038 has returned', () => {
    it('SELECT count(*) FROM users as jale_admin with RLS context set still succeeds', async () => {
      const result = await asAdmin(adminUrl, employerCognitoSub, (client) =>
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM users`),
      );
      expect(Number(result.rows[0].count)).toBeGreaterThan(0);
    });

    it('SELECT on jobs as jale_admin still succeeds', async () => {
      await makeJob();
      const result = await asAdmin(adminUrl, employerCognitoSub, (client) =>
        client.query(`SELECT count(*) FROM jobs`),
      );
      expect(result.rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Share-link uniqueness, including the NULL-referrer trap
  // -------------------------------------------------------------------------
  describe('job_share_links uniqueness', () => {
    it('a duplicate (job_id, referrer_worker_id, channel) insert violates the unique index', async () => {
      const jobId = await makeJob();
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
           VALUES ($1, $2, $3, 'whatsapp')`,
          [randomCode(8), jobId, workerUserId],
        );
        await expect(
          client.query(
            `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
             VALUES ($1, $2, $3, 'whatsapp')`,
            [randomCode(8), jobId, workerUserId],
          ),
        ).rejects.toThrow(/unique/i);
      } finally {
        await client.end();
      }
    });

    it('one organic share (referrer_worker_id IS NULL) inserts fine; a second for the same job+channel is rejected', async () => {
      const jobId = await makeJob();
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
           VALUES ($1, $2, NULL, 'facebook')`,
          [randomCode(8), jobId],
        );
        await expect(
          client.query(
            `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
             VALUES ($1, $2, NULL, 'facebook')`,
            [randomCode(8), jobId],
          ),
        ).rejects.toThrow(/unique/i);
      } finally {
        await client.end();
      }
    });

    it('the same organic job with a DIFFERENT channel inserts fine', async () => {
      const jobId = await makeJob();
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
           VALUES ($1, $2, NULL, 'facebook')`,
          [randomCode(8), jobId],
        );
        const result = await client.query(
          `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
           VALUES ($1, $2, NULL, 'copy_link')`,
          [randomCode(8), jobId],
        );
        expect(result.rowCount).toBe(1);
      } finally {
        await client.end();
      }
    });

    it('a code containing I, L, O or U violates the charset CHECK', async () => {
      const jobId = await makeJob();
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        for (const badCode of ['IAAAAAAA', 'LAAAAAAA', 'OAAAAAAA', 'UAAAAAAA']) {
          await expect(
            client.query(
              `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
               VALUES ($1, $2, NULL, 'unknown')`,
              [badCode, jobId],
            ),
          ).rejects.toThrow(/check/i);
        }
      } finally {
        await client.end().catch(() => {});
      }
    });
  });

  // -------------------------------------------------------------------------
  // Apply tokens
  // -------------------------------------------------------------------------
  describe('referral_apply_tokens', () => {
    it('jale_public_jobs can INSERT a token but gets a permission error setting consumed_at', async () => {
      const jobId = await makeJob();
      const tokenHash = randomHash();
      const insertResult = await asPublicJobs(publicUrl, (client) =>
        client.query(
          `INSERT INTO referral_apply_tokens (token_hash, job_id, expires_at)
           VALUES ($1, $2, now() + interval '1 day')`,
          [tokenHash, jobId],
        ),
      );
      expect(insertResult.rowCount).toBe(1);

      await expect(
        asPublicJobs(publicUrl, (client) =>
          client.query(
            `UPDATE referral_apply_tokens
             SET consumed_at = now(), consumed_phone_hash = repeat('a', 64)
             WHERE token_hash = $1`,
            [tokenHash],
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('setting consumed_at without consumed_phone_hash violates the coherence CHECK', async () => {
      const jobId = await makeJob();
      const tokenHash = randomHash();
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO referral_apply_tokens (token_hash, job_id, expires_at)
           VALUES ($1, $2, now() + interval '1 day')`,
          [tokenHash, jobId],
        );
        await expect(
          client.query(
            `UPDATE referral_apply_tokens SET consumed_at = now() WHERE token_hash = $1`,
            [tokenHash],
          ),
        ).rejects.toThrow(/check/i);
      } finally {
        await client.end();
      }
    });

    it('single-use under real concurrency: two concurrent transactions racing the same claim — exactly one wins', async () => {
      const jobId = await makeJob();
      const tokenHash = randomHash();

      const setup = new Client({ connectionString: superuserUrl });
      await setup.connect();
      try {
        await setup.query(
          `INSERT INTO referral_apply_tokens (token_hash, job_id, expires_at)
           VALUES ($1, $2, now() + interval '1 day')`,
          [tokenHash, jobId],
        );
      } finally {
        await setup.end();
      }

      const c1 = new Client({ connectionString: whatsappUrl });
      const c2 = new Client({ connectionString: whatsappUrl });
      await c1.connect();
      await c2.connect();

      try {
        await c1.query('BEGIN');
        await c2.query('BEGIN');

        const claimSql = `UPDATE referral_apply_tokens
                           SET consumed_at = now(), consumed_phone_hash = repeat('a', 64)
                           WHERE token_hash = $1 AND consumed_at IS NULL`;

        // c1 claims first and HOLDS the row lock uncommitted.
        const r1 = await c1.query(claimSql, [tokenHash]);
        expect(r1.rowCount).toBe(1);

        // c2 attempts the same claim concurrently — it must block on c1's
        // uncommitted row lock, so start it and only await after c1 commits.
        const c2Outcome = (async () => {
          const r = await c2.query(claimSql, [tokenHash]);
          await c2.query('COMMIT');
          return r.rowCount;
        })();

        await new Promise((resolve) => setTimeout(resolve, 250));
        await c1.query('COMMIT');

        const c2RowCount = await c2Outcome;
        expect(c2RowCount).toBe(0);
      } finally {
        await c1.end().catch(() => {});
        await c2.end().catch(() => {});
      }
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Parked claims
  // -------------------------------------------------------------------------
  describe('referral_pending_claims', () => {
    it('a second claim for the same phone_hash with ON CONFLICT DO UPDATE replaces rather than duplicating', async () => {
      const phoneHash = randomHash();
      const job1 = await makeJob();
      const job2 = await makeJob();

      const client = new Client({ connectionString: whatsappUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at)
           VALUES ($1, $2, now() + interval '1 day')
           ON CONFLICT (phone_hash) DO UPDATE SET job_id = EXCLUDED.job_id, updated_at = now()`,
          [phoneHash, job1],
        );
        await client.query(
          `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at)
           VALUES ($1, $2, now() + interval '1 day')
           ON CONFLICT (phone_hash) DO UPDATE SET job_id = EXCLUDED.job_id, updated_at = now()`,
          [phoneHash, job2],
        );
        const result = await client.query<{ job_id: string }>(
          `SELECT job_id FROM referral_pending_claims WHERE phone_hash = $1`,
          [phoneHash],
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].job_id).toBe(job2);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        await client.end();
      }
    });

    it('claimed_at without claimed_worker_id violates the coherence CHECK', async () => {
      const phoneHash = randomHash();
      const jobId = await makeJob();
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at)
           VALUES ($1, $2, now() + interval '1 day')`,
          [phoneHash, jobId],
        );
        await expect(
          client.query(
            `UPDATE referral_pending_claims SET claimed_at = now() WHERE phone_hash = $1`,
            [phoneHash],
          ),
        ).rejects.toThrow(/check/i);
      } finally {
        await client.end();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Generator
  // -------------------------------------------------------------------------
  describe('gen_referral_code', () => {
    it('5000 calls to gen_referral_code(8) produce zero codes containing I, L, O or U, and all match the alphabet pattern', async () => {
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        const result = await client.query<{ code: string }>(
          `SELECT gen_referral_code(8) AS code FROM generate_series(1, 5000)`,
        );
        expect(result.rows).toHaveLength(5000);
        for (const { code } of result.rows) {
          expect(code).not.toMatch(/[ILOU]/);
          expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
        }
      } finally {
        await client.end();
      }
    }, 30_000);

    it('over enough samples all 32 alphabet characters appear', async () => {
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        const result = await client.query<{ code: string }>(
          `SELECT gen_referral_code(24) AS code FROM generate_series(1, 2000)`,
        );
        const seen = new Set<string>();
        for (const { code } of result.rows) {
          for (const ch of code) seen.add(ch);
        }
        const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        for (const ch of alphabet) {
          expect(seen.has(ch)).toBe(true);
        }
        expect(seen.size).toBe(32);
      } finally {
        await client.end();
      }
    }, 30_000);

    it('gen_referral_code(2) raises', async () => {
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await expect(client.query(`SELECT gen_referral_code(2)`)).rejects.toThrow(/code_len must be/i);
      } finally {
        await client.end();
      }
    });

    it('every row in jobs has a non-null public_code matching the 6-char charset pattern (backfill worked)', async () => {
      await makeJob();
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM jobs
           WHERE public_code IS NULL OR public_code !~ '^[0-9A-HJKMNP-TV-Z]{6}$'`,
        );
        expect(result.rows[0].count).toBe('0');
      } finally {
        await client.end();
      }
    });
  });
  // -------------------------------------------------------------------------
  // writeWebAttribution -- the REAL exported function (referral-attribution.ts),
  // run against real Postgres under the CLAIMER's RLS context.
  //
  // Review lesson baked in: an earlier revision replayed a hand-copied INSERT
  // with pre-resolved parameters and only ever built SELF-referrals -- so it
  // stayed green while the RLS-gated share-link SELECT (the exact statement
  // that filtered to zero rows for every genuine referral before migration
  // 059) went untested. These tests call the real function, and the primary
  // fixture is the genuine shape: referrer and claimer are DIFFERENT workers.
  // -------------------------------------------------------------------------
  describe('writeWebAttribution (real function, real RLS)', () => {
    async function makeClaimWorker(): Promise<{ id: string; cognitoSub: string }> {
      const cognitoSub = `referrals-claim-worker-${randomCode(16)}`;
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        const result = await client.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type, created_at, updated_at)
           VALUES ($1, 'worker', now(), now())
           RETURNING id`,
          [cognitoSub],
        );
        return { id: result.rows[0].id, cognitoSub };
      } finally {
        await client.end();
      }
    }

    /** Mints a job_share_links row as superuser, bypassing RLS. */
    async function makeShareLink(
      channel: string,
      referrerWorkerId: string | null,
      jobId?: string,
    ): Promise<{ code: string; jobId: string }> {
      const resolvedJobId = jobId ?? (await makeJob());
      const code = randomCode(8);
      const client = new Client({ connectionString: superuserUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
           VALUES ($1, $2, $3, $4)`,
          [code, resolvedJobId, referrerWorkerId, channel],
        );
      } finally {
        await client.end();
      }
      return { code, jobId: resolvedJobId };
    }

    /** Runs the real function as jale_admin under the given cognito context. */
    async function claimAs(
      cognitoSub: string,
      workerId: string,
      shareCode: string,
    ): Promise<{ written: boolean }> {
      return asAdmin(adminUrl, cognitoSub, (client) =>
        writeWebAttribution(client as unknown as PoolClient, workerId, shareCode, new Date()),
      );
    }

    it('a GENUINE referral persists: referrer and claimer are different workers (migration 059)', async () => {
      const referrer = await makeClaimWorker();
      const claimer = await makeClaimWorker();
      const link = await makeShareLink('copy_link', referrer.id);

      const result = await claimAs(claimer.cognitoSub, claimer.id, link.code);
      expect(result.written).toBe(true);

      const row = await asAdmin(adminUrl, claimer.cognitoSub, (client) =>
        client.query<{ first_channel: string; first_referrer_worker_id: string }>(
          `SELECT first_channel, first_referrer_worker_id
             FROM worker_attribution WHERE worker_id = $1`,
          [claimer.id],
        ),
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].first_channel).toBe('copy_link');
      expect(row.rows[0].first_referrer_worker_id).toBe(referrer.id);
    });

    it('a SELF-referral earns nothing: claiming your own link writes no row', async () => {
      const worker = await makeClaimWorker();
      const link = await makeShareLink('whatsapp', worker.id);

      const result = await claimAs(worker.cognitoSub, worker.id, link.code);
      expect(result.written).toBe(false);

      const check = new Client({ connectionString: superuserUrl });
      await check.connect();
      try {
        const rows = await check.query(`SELECT 1 FROM worker_attribution WHERE worker_id = $1`, [worker.id]);
        expect(rows.rows).toHaveLength(0);
      } finally {
        await check.end();
      }
    });

    it('an unknown share code returns written:false without error', async () => {
      const claimer = await makeClaimWorker();
      const result = await claimAs(claimer.cognitoSub, claimer.id, 'ZZZZZZZ2');
      expect(result.written).toBe(false);
    });

    it('a second genuine claim moves latest_* and leaves first_* untouched', async () => {
      const referrer = await makeClaimWorker();
      const claimer = await makeClaimWorker();
      const link1 = await makeShareLink('whatsapp', referrer.id);
      const link2 = await makeShareLink('facebook', referrer.id, link1.jobId);

      expect((await claimAs(claimer.cognitoSub, claimer.id, link1.code)).written).toBe(true);
      expect((await claimAs(claimer.cognitoSub, claimer.id, link2.code)).written).toBe(true);

      const row = await asAdmin(adminUrl, claimer.cognitoSub, (client) =>
        client.query<{
          first_share_code: string;
          first_channel: string;
          latest_share_code: string;
          latest_channel: string;
        }>(
          `SELECT first_share_code, first_channel, latest_share_code, latest_channel
             FROM worker_attribution WHERE worker_id = $1`,
          [claimer.id],
        ),
      );
      expect(row.rows[0].first_share_code).toBe(link1.code);
      expect(row.rows[0].first_channel).toBe('whatsapp');
      expect(row.rows[0].latest_share_code).toBe(link2.code);
      expect(row.rows[0].latest_channel).toBe('facebook');
    });

    it('WITHOUT an RLS context no attribution row can persist -- pins the FORCE-RLS trap', async () => {
      const referrer = await makeClaimWorker();
      const claimer = await makeClaimWorker();
      const link = await makeShareLink('sms', referrer.id);

      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        // Deliberately NOT setting app.current_user_id.
        await writeWebAttribution(client as unknown as PoolClient, claimer.id, link.code, new Date()).catch(() => {});
        await client.query('COMMIT').catch(() => {});
      } finally {
        await client.end();
      }

      const check = new Client({ connectionString: superuserUrl });
      await check.connect();
      try {
        const rows = await check.query(`SELECT 1 FROM worker_attribution WHERE worker_id = $1`, [claimer.id]);
        expect(rows.rows).toHaveLength(0);
      } finally {
        await check.end();
      }
    });

    it('a revoked link cannot be claimed', async () => {
      const referrer = await makeClaimWorker();
      const claimer = await makeClaimWorker();
      const link = await makeShareLink('copy_link', referrer.id);
      const revoke = new Client({ connectionString: superuserUrl });
      await revoke.connect();
      try {
        await revoke.query(`UPDATE job_share_links SET revoked_at = now() WHERE code = $1`, [link.code]);
      } finally {
        await revoke.end();
      }

      const result = await claimAs(claimer.cognitoSub, claimer.id, link.code);
      expect(result.written).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// If DB is unavailable, emit a single top-level concern notice so CI captures it
// ---------------------------------------------------------------------------
if (!databaseUrl) {
  test(
    'CONCERN: referrals-rls PostgreSQL gate was not run — JALE_TEST_DATABASE_URL not set',
    () => {
      // eslint-disable-next-line no-console
      console.warn(
        '[referrals-rls.integration] DONE_WITH_CONCERNS: The PostgreSQL RLS gate for migration 056 ' +
          'was skipped because JALE_TEST_DATABASE_URL is not set in this environment. ' +
          'Run with a local Postgres 16 container to validate all referral RLS assertions.',
      );
      expect(databaseUrl).toBeUndefined();
    },
  );
}
