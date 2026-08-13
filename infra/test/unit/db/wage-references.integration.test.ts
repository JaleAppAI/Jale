/**
 * wage-references.integration.test.ts
 *
 * PostgreSQL-backed suite for migration 070 (wage_references,
 * city_cbsa_crosswalk) -- schema, RLS, and the real seed loader
 * (scripts/seed-oews-wages.ts), run against real Postgres rather than
 * mocked.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with
 * the full migration chain (001->070) already applied, connected as a
 * superuser (e.g. `postgres`) so this suite can set role passwords and
 * insert fixtures via a separate jale_admin connection. When absent, every
 * test in this file is explicitly skipped and the concern is logged (no
 * silent skip) -- mirrors infra/test/unit/db/billing-rls.integration.test.ts.
 *
 * Example (after running the Docker gate):
 *   JALE_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/jale npx jest wage-references
 */

import { Client } from 'pg';
import * as path from 'path';
import { loadSeed, upsertWageReferences, upsertCrosswalk } from '../../../scripts/seed-oews-wages';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const seedPath = path.join(__dirname, '..', '..', '..', 'scripts', 'data', 'oews-tx-seed.json');

// ---------------------------------------------------------------------------
// Harness helpers (mirrors billing-rls.integration.test.ts)
// ---------------------------------------------------------------------------

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
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

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[wage-references.integration] SKIPPED: "${name}" -- set JALE_TEST_DATABASE_URL to run PostgreSQL-backed tests. ` +
        `This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.`,
    );
  } else {
    describe(name, fn);
  }
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function rowCount(url: string, table: string): Promise<number> {
  return withClient(url, async (client) => {
    const r = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    return parseInt(r.rows[0].count, 10);
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let superuserUrl: string;
let adminUrl: string;
let whatsappUrl: string;
let publicJobsUrl: string;

maybeDescribe('wage_references / city_cbsa_crosswalk integration (migration 070)', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    superuserUrl = databaseUrl;
    await setServiceRolePasswords(superuserUrl);
    adminUrl = new URL(databaseUrl).username === 'jale_admin' ? databaseUrl : urlForRole(databaseUrl, 'jale_admin', 'test-admin-pw');
    whatsappUrl = urlForRole(databaseUrl, 'jale_whatsapp', 'test-whatsapp-pw');
    publicJobsUrl = urlForRole(databaseUrl, 'jale_public_jobs', 'test-publicjobs-pw');
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Schema shape (RLS flags, CHECK constraints) -- static SQL-catalog checks
  // ---------------------------------------------------------------------------
  describe('schema shape', () => {
    it('both tables have ENABLE + FORCE ROW LEVEL SECURITY', async () => {
      if (!databaseUrl) return;
      const rows = await withClient(superuserUrl, (client) =>
        client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
           WHERE relname IN ('wage_references', 'city_cbsa_crosswalk')`,
        ),
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it('wage_references has exactly one policy (SELECT, USING true, to jale_admin) outside a seed window', async () => {
      if (!databaseUrl) return;
      const rows = await withClient(superuserUrl, (client) =>
        client.query<{ policyname: string; cmd: string; roles: string[] }>(
          `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = 'wage_references'`,
        ),
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].policyname).toBe('wage_references_read_all');
      expect(rows.rows[0].cmd).toBe('SELECT');
      expect(rows.rows[0].roles).toEqual(['jale_admin']);
    });

    it('city_cbsa_crosswalk has exactly one policy (SELECT, USING true, to jale_admin) outside a seed window', async () => {
      if (!databaseUrl) return;
      const rows = await withClient(superuserUrl, (client) =>
        client.query<{ policyname: string; cmd: string; roles: string[] }>(
          `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = 'city_cbsa_crosswalk'`,
        ),
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].policyname).toBe('city_cbsa_crosswalk_read_all');
      expect(rows.rows[0].cmd).toBe('SELECT');
      expect(rows.rows[0].roles).toEqual(['jale_admin']);
    });
  });

  // ---------------------------------------------------------------------------
  // Boundary / CHECK-constraint probes (superuser, isolating the CHECK from RLS)
  // ---------------------------------------------------------------------------
  describe('boundary wages and CHECK constraints', () => {
    afterEach(async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(`DELETE FROM wage_references WHERE area_code = 'CHECK-TEST'`),
      );
    });

    it('accepts the boundary case p25 == p50 == p75', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `INSERT INTO wage_references
             (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
           VALUES ('electrician', 'CHECK-TEST', 'state', 'Boundary Test', 25.00, 25.00, 25.00, 'state', 'May 2025')`,
        ),
      );
      const result = await withClient(superuserUrl, (client) =>
        client.query(`SELECT * FROM wage_references WHERE area_code = 'CHECK-TEST'`),
      );
      expect(result.rows).toHaveLength(1);
    });

    it('rejects p25 > p50', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(superuserUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('electrician', 'CHECK-TEST', 'state', 'Boundary Test', 30.00, 25.00, 35.00, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('rejects p50 > p75', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(superuserUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('electrician', 'CHECK-TEST', 'state', 'Boundary Test', 20.00, 35.00, 30.00, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('rejects p25 <= 0', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(superuserUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('electrician', 'CHECK-TEST', 'state', 'Boundary Test', 0, 10, 20, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('rejects an invalid trade_category', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(superuserUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('welder', 'CHECK-TEST', 'state', 'Boundary Test', 10, 15, 20, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('rejects an invalid area_kind', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(superuserUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('electrician', 'CHECK-TEST', 'micropolitan', 'Boundary Test', 10, 15, 20, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/violates check constraint/i);
    });

    it('rejects a duplicate (trade_category, area_code) pair', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `INSERT INTO wage_references
             (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
           VALUES ('electrician', 'CHECK-TEST', 'state', 'Boundary Test', 20, 25, 30, 'state', 'May 2025')`,
        ),
      );
      await expect(
        withClient(superuserUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('electrician', 'CHECK-TEST', 'state', 'Boundary Test 2', 21, 26, 31, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/duplicate key/i);
    });
  });

  // ---------------------------------------------------------------------------
  // B-1: seed loader idempotency, using the REAL production loader functions
  // ---------------------------------------------------------------------------
  describe('B-1: seed loader idempotency (real loader code, real seed file)', () => {
    it('running the loader twice yields identical row counts (upsert, not duplicate insert)', async () => {
      if (!databaseUrl) return;
      const seed = loadSeed(seedPath);
      expect(seed.placeholder).toBe(false); // sanity: this is the real checked-in file

      const client = new Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await upsertWageReferences(client, seed.wage_references);
        await upsertCrosswalk(client, seed.city_cbsa_crosswalk);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }

      const wageCount1 = await rowCount(superuserUrl, 'wage_references');
      const crosswalkCount1 = await rowCount(superuserUrl, 'city_cbsa_crosswalk');
      expect(wageCount1).toBe(seed.wage_references.length);
      expect(crosswalkCount1).toBe(seed.city_cbsa_crosswalk.length);

      // Run it again -- must be a true upsert (same PK, updated values), not
      // a duplicate insert or a unique-constraint failure.
      const client2 = new Client({ connectionString: adminUrl });
      await client2.connect();
      try {
        await client2.query('BEGIN');
        await upsertWageReferences(client2, seed.wage_references);
        await upsertCrosswalk(client2, seed.city_cbsa_crosswalk);
        await client2.query('COMMIT');
      } finally {
        await client2.end();
      }

      const wageCount2 = await rowCount(superuserUrl, 'wage_references');
      const crosswalkCount2 = await rowCount(superuserUrl, 'city_cbsa_crosswalk');
      expect(wageCount2).toBe(wageCount1);
      expect(crosswalkCount2).toBe(crosswalkCount1);
    }, 60_000);

    it('a seeded row is readable through jale_admin\'s read-all policy', async () => {
      if (!databaseUrl) return;
      const result = await withClient(adminUrl, (client) =>
        client.query(
          `SELECT p25_hourly, p50_hourly, p75_hourly, source_tier FROM wage_references
           WHERE trade_category = 'electrician' AND area_code = '12420'`,
        ),
      );
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].p25_hourly)).toBeLessThanOrEqual(Number(result.rows[0].p50_hourly));
    });
  });

  // ---------------------------------------------------------------------------
  // B-3: RLS cross-role probes -- the loud/silent-zero asymmetry
  // ---------------------------------------------------------------------------
  describe('B-3: RLS -- jale_admin SELECT allowed, writes denied outside the seed window', () => {
    it('jale_admin can SELECT (read-all policy)', async () => {
      if (!databaseUrl) return;
      const result = await withClient(adminUrl, (client) => client.query(`SELECT count(*)::int AS count FROM wage_references`));
      expect(result.rows[0].count).toBeGreaterThan(0);
    });

    it('jale_admin INSERT outside the seed window fails LOUDLY (new row violates row-level security policy)', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(adminUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('electrician', 'RLS-DENY-TEST', 'state', 'Deny Test', 10, 15, 20, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('jale_admin UPDATE outside the seed window fails SILENTLY (0 rows affected, no error) -- documented asymmetry, not a bug', async () => {
      if (!databaseUrl) return;
      const result = await withClient(adminUrl, (client) =>
        client.query(`UPDATE wage_references SET p50_hourly = 999.99 WHERE trade_category = 'electrician' AND area_code = '12420'`),
      );
      expect(result.rowCount).toBe(0);
      // Prove the row genuinely wasn't touched (belt-and-suspenders on the silent-zero claim).
      const check = await withClient(superuserUrl, (client) =>
        client.query(`SELECT p50_hourly FROM wage_references WHERE trade_category = 'electrician' AND area_code = '12420'`),
      );
      expect(Number(check.rows[0].p50_hourly)).not.toBe(999.99);
    });

    it('jale_admin DELETE outside the seed window fails SILENTLY (0 rows affected, no error)', async () => {
      if (!databaseUrl) return;
      const result = await withClient(adminUrl, (client) =>
        client.query(`DELETE FROM wage_references WHERE trade_category = 'electrician' AND area_code = '12420'`),
      );
      expect(result.rowCount).toBe(0);
      const check = await rowCount(superuserUrl, 'wage_references');
      expect(check).toBeGreaterThan(0);
    });

    it('jale_admin INSERT into city_cbsa_crosswalk outside the seed window fails LOUDLY', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(adminUrl, (client) =>
          client.query(
            `INSERT INTO city_cbsa_crosswalk (city_key, county_fips, area_code, area_kind)
             VALUES ('rls-deny-test-tx', NULL, '12420', 'metro')`,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('jale_admin UPDATE on city_cbsa_crosswalk outside the seed window fails SILENTLY', async () => {
      if (!databaseUrl) return;
      const result = await withClient(adminUrl, (client) =>
        client.query(`UPDATE city_cbsa_crosswalk SET area_code = '00000' WHERE city_key = 'austin-tx'`),
      );
      expect(result.rowCount).toBe(0);
    });
  });

  describe('B-3: RLS -- jale_public_jobs and jale_whatsapp get no access at all', () => {
    it('jale_public_jobs SELECT on wage_references is denied loudly (no GRANT at all -- table privilege error, before RLS)', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(publicJobsUrl, (client) => client.query(`SELECT * FROM wage_references LIMIT 1`)),
      ).rejects.toThrow(/permission denied/i);
    });

    it('jale_whatsapp SELECT on wage_references is denied loudly', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(whatsappUrl, (client) => client.query(`SELECT * FROM wage_references LIMIT 1`)),
      ).rejects.toThrow(/permission denied/i);
    });

    it('jale_public_jobs SELECT on city_cbsa_crosswalk is denied loudly', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(publicJobsUrl, (client) => client.query(`SELECT * FROM city_cbsa_crosswalk LIMIT 1`)),
      ).rejects.toThrow(/permission denied/i);
    });

    it('jale_whatsapp SELECT on city_cbsa_crosswalk is denied loudly', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(whatsappUrl, (client) => client.query(`SELECT * FROM city_cbsa_crosswalk LIMIT 1`)),
      ).rejects.toThrow(/permission denied/i);
    });

    it('jale_public_jobs INSERT on wage_references is denied loudly', async () => {
      if (!databaseUrl) return;
      await expect(
        withClient(publicJobsUrl, (client) =>
          client.query(
            `INSERT INTO wage_references
               (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage)
             VALUES ('electrician', 'PUBLIC-JOBS-DENY', 'state', 'Deny', 10, 15, 20, 'state', 'May 2025')`,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Adversarial probes: hostile text as a city_key lookup input
  // ---------------------------------------------------------------------------
  describe('adversarial: hostile city_key lookup input', () => {
    it('a SQL-injection-shaped city_key is treated as an ordinary (non-matching) string via parameterized query', async () => {
      if (!databaseUrl) return;
      const hostile = "'; DROP TABLE city_cbsa_crosswalk; --";
      const result = await withClient(adminUrl, (client) =>
        client.query(`SELECT * FROM city_cbsa_crosswalk WHERE city_key = $1`, [hostile]),
      );
      expect(result.rows).toHaveLength(0);
      // Prove the table still exists and still has rows (the injection did not fire).
      const stillThere = await rowCount(superuserUrl, 'city_cbsa_crosswalk');
      expect(stillThere).toBeGreaterThan(0);
    });

    it('a very long city_key lookup returns zero rows without erroring', async () => {
      if (!databaseUrl) return;
      const long = 'a'.repeat(10_000);
      const result = await withClient(adminUrl, (client) =>
        client.query(`SELECT * FROM city_cbsa_crosswalk WHERE city_key = $1`, [long]),
      );
      expect(result.rows).toHaveLength(0);
    });

    it('a city_key containing an embedded NUL byte is rejected outright by Postgres, not silently truncated', async () => {
      if (!databaseUrl) return;
      // Postgres text columns reject embedded NUL (0x00) bytes outright --
      // this must surface as a loud error, not a silently-truncated match.
      const hostile = `austin${String.fromCharCode(0)}tx`;
      await expect(
        withClient(adminUrl, (client) =>
          client.query(`SELECT * FROM city_cbsa_crosswalk WHERE city_key = $1`, [hostile]),
        ),
      ).rejects.toThrow();
    });

    it('an HTML/script-shaped city_key is treated as inert text (no matching row, no error)', async () => {
      if (!databaseUrl) return;
      const hostile = '<script>alert(1)</script>-tx';
      const result = await withClient(adminUrl, (client) =>
        client.query(`SELECT * FROM city_cbsa_crosswalk WHERE city_key = $1`, [hostile]),
      );
      expect(result.rows).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// If DB is unavailable, emit a single top-level concern notice so CI captures it
// ---------------------------------------------------------------------------
if (!databaseUrl) {
  test('CONCERN: wage-references-integration PostgreSQL gate was not run -- JALE_TEST_DATABASE_URL not set', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[wage-references.integration] DONE_WITH_CONCERNS: The PostgreSQL gate for migration 070 was skipped ' +
        'because JALE_TEST_DATABASE_URL is not set in this environment. Run with a local Postgres 16 ' +
        'container (via infra/db/local/bootstrap-testbed.sh) to validate all wage-reference assertions.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}
