/**
 * pay-reference-lookup.integration.test.ts
 *
 * PostgreSQL-backed suite for T-B2's lookupPayReference() (lambda/lib/pay-reference.ts)
 * against migration 071's real tables (wage_references, city_cbsa_crosswalk),
 * seeded from the real checked-in infra/scripts/data/oews-tx-seed.json via
 * T-B1's real loader functions (scripts/seed-oews-wages.ts) -- same harness
 * shape as infra/test/unit/db/wage-references.integration.test.ts, which this
 * mirrors (maybeDescribe skip pattern, withClient helper, jale_admin role
 * password setup).
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with the
 * full migration chain (001->070) already applied, connected as a superuser
 * (e.g. `postgres`) so this suite can set the jale_admin role password. When
 * absent, every test in this file is explicitly skipped and the concern is
 * logged (no silent skip).
 *
 * This suite seeds the tables itself (idempotent upsert, via the real loader)
 * rather than assuming another suite already populated them -- the wage
 * tables start empty on a fresh testbed apply, and this suite must not depend
 * on test execution order or on wage-references.integration.test.ts having
 * run first in the same jest process.
 *
 * Example (after running the Docker gate):
 *   JALE_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/jale npx jest pay-reference-lookup
 */

import { Client } from 'pg';
import * as path from 'path';
import { loadSeed, upsertWageReferences, upsertCrosswalk, type WageReferenceRow } from '../../../scripts/seed-oews-wages';
import { lookupPayReference, STATE_AREA_CODE } from '../../../lambda/lib/pay-reference';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const seedPath = path.join(__dirname, '..', '..', '..', 'scripts', 'data', 'oews-tx-seed.json');

// ---------------------------------------------------------------------------
// Harness helpers (mirrors wage-references.integration.test.ts)
// ---------------------------------------------------------------------------

async function setAdminRolePassword(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
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
      `[pay-reference-lookup.integration] SKIPPED: "${name}" -- set JALE_TEST_DATABASE_URL to run PostgreSQL-backed tests. ` +
        `This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.`,
    );
  } else {
    describe(name, fn);
  }
}

// ---------------------------------------------------------------------------
// Seed cross-reference helpers -- assert against the REAL seed file contents
// rather than hardcoded numbers, so a future reseed can't silently make this
// suite pass against stale expectations.
// ---------------------------------------------------------------------------

const seed = loadSeed(seedPath);

function seedWageRow(trade: string, areaCode: string): WageReferenceRow {
  const row = seed.wage_references.find((r) => r.trade_category === trade && r.area_code === areaCode);
  if (!row) throw new Error(`test setup error: no seed wage_references row for ${trade}/${areaCode}`);
  return row;
}

function seedCrosswalkAreaCode(cityKey: string): string | undefined {
  return seed.city_cbsa_crosswalk.find((r) => r.city_key === cityKey)?.area_code;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let superuserUrl: string;
let adminUrl: string;
let adminClient: Client;

maybeDescribe('lookupPayReference against real Postgres (migration 071, T-B1 seed)', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    superuserUrl = databaseUrl;
    await setAdminRolePassword(superuserUrl);
    adminUrl = new URL(databaseUrl).username === 'jale_admin' ? databaseUrl : urlForRole(databaseUrl, 'jale_admin', 'test-admin-pw');

    expect(seed.placeholder).toBe(false); // sanity: this is the real checked-in file, not a placeholder

    // Seed via the real production loader (idempotent upsert) so this suite
    // never depends on execution order relative to
    // wage-references.integration.test.ts, and works even on a testbed whose
    // wage tables start empty.
    const seedClient = new Client({ connectionString: adminUrl });
    await seedClient.connect();
    try {
      await seedClient.query('BEGIN');
      await upsertWageReferences(seedClient, seed.wage_references);
      await upsertCrosswalk(seedClient, seed.city_cbsa_crosswalk);
      await seedClient.query('COMMIT');
    } finally {
      await seedClient.end();
    }

    adminClient = new Client({ connectionString: adminUrl });
    await adminClient.connect();
  }, 60_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await adminClient.end();
  });

  it('austin-tx / electrician resolves to the Austin metro row, exactly as seeded (B-2)', async () => {
    if (!databaseUrl) return;
    const areaCode = seedCrosswalkAreaCode('austin-tx');
    expect(areaCode).toBeDefined();
    const expected = seedWageRow('electrician', areaCode!);
    expect(expected.area_kind).toBe('metro');

    const result = await lookupPayReference(adminClient, 'electrician', 'austin-tx');

    expect(result).toEqual({
      trade_category: 'electrician',
      p25_hourly: expected.p25_hourly,
      p50_hourly: expected.p50_hourly,
      p75_hourly: expected.p75_hourly,
      area_kind: 'metro',
      area_label: expected.area_label,
      source_tier: 'metro',
      data_vintage: expected.data_vintage,
    });
    expect(typeof result?.p25_hourly).toBe('number');
    expect(typeof result?.p50_hourly).toBe('number');
    expect(typeof result?.p75_hourly).toBe('number');
  });

  it('dallas-tx (a real, distinct crosswalk city) resolves to its own Dallas-Fort Worth metro row, not Austin\'s', async () => {
    if (!databaseUrl) return;
    const areaCode = seedCrosswalkAreaCode('dallas-tx');
    expect(areaCode).toBeDefined();
    expect(areaCode).not.toBe(seedCrosswalkAreaCode('austin-tx'));
    const expected = seedWageRow('electrician', areaCode!);

    const result = await lookupPayReference(adminClient, 'electrician', 'dallas-tx');

    expect(result).toEqual({
      trade_category: 'electrician',
      p25_hourly: expected.p25_hourly,
      p50_hourly: expected.p50_hourly,
      p75_hourly: expected.p75_hourly,
      area_kind: 'metro',
      area_label: expected.area_label,
      source_tier: 'metro',
      data_vintage: expected.data_vintage,
    });
    expect(result?.area_label).toBe('Dallas-Fort Worth');
  });

  it('a city absent from the crosswalk falls back to the state row, exactly as seeded (B-2)', async () => {
    if (!databaseUrl) return;
    const fakeCity = 'nonexistent-fake-city-tx';
    expect(seedCrosswalkAreaCode(fakeCity)).toBeUndefined();
    const expected = seedWageRow('electrician', STATE_AREA_CODE);
    expect(expected.area_kind).toBe('state');
    expect(STATE_AREA_CODE).toBe('TX');

    const result = await lookupPayReference(adminClient, 'electrician', fakeCity);

    expect(result).toEqual({
      trade_category: 'electrician',
      p25_hourly: expected.p25_hourly,
      p50_hourly: expected.p50_hourly,
      p75_hourly: expected.p75_hourly,
      area_kind: 'state',
      area_label: expected.area_label,
      source_tier: 'state',
      data_vintage: expected.data_vintage,
    });
  });

  it('a crosswalk hit whose resolved area_code has no matching wage_references row falls back to state', async () => {
    if (!databaseUrl) return;
    // Every real crosswalk row in the seed resolves to an area_code that DOES
    // have a wage_references row for all 7 wage-bearing trades (84 rows = 7
    // trades x (5 metro + 6 nonmetro + 1 state), no gaps) -- so this branch
    // never naturally fires against the checked-in seed today. It still
    // exists defensively for a future partial/suppressed reseed, and is
    // tested here by inserting a throwaway crosswalk row that resolves to an
    // area_code with genuinely zero wage_references rows (not a real metro
    // OR nonmetro code -- using a real nonmetro code like '4800001' would NOT
    // exercise this branch, since wage_references does have rows there; see
    // the migration 071 header, "unreachable by city_key" describes the
    // crosswalk never POINTING there in production, not the lookup skipping
    // nonmetro rows it finds).
    const throwawayCityKey = 'throwaway-crosswalk-hit-no-wage-row-tx';
    const throwawayAreaCode = 'TEST-AREA-WITH-NO-WAGE-ROW';
    await adminClient.query(
      `CREATE POLICY throwaway_seed_insert ON city_cbsa_crosswalk FOR INSERT TO jale_admin WITH CHECK (true)`,
    );
    try {
      await adminClient.query(
        `INSERT INTO city_cbsa_crosswalk (city_key, county_fips, area_code, area_kind) VALUES ($1, NULL, $2, 'metro')`,
        [throwawayCityKey, throwawayAreaCode],
      );
    } finally {
      await adminClient.query(`DROP POLICY throwaway_seed_insert ON city_cbsa_crosswalk`);
    }

    try {
      // Confirm the fixture is actually a "hit with no wage row" case, not an
      // accidental duplicate of a real area_code.
      const noRow = await adminClient.query(
        `SELECT 1 FROM wage_references WHERE trade_category = 'electrician' AND area_code = $1`,
        [throwawayAreaCode],
      );
      expect(noRow.rows).toHaveLength(0);

      const expected = seedWageRow('electrician', STATE_AREA_CODE);
      const result = await lookupPayReference(adminClient, 'electrician', throwawayCityKey);
      expect(result?.area_kind).toBe('state');
      expect(result?.p50_hourly).toBe(expected.p50_hourly);
    } finally {
      await adminClient.query(
        `CREATE POLICY throwaway_seed_delete ON city_cbsa_crosswalk FOR DELETE TO jale_admin USING (true)`,
      );
      await adminClient.query(`DELETE FROM city_cbsa_crosswalk WHERE city_key = $1`, [throwawayCityKey]);
      await adminClient.query(`DROP POLICY throwaway_seed_delete ON city_cbsa_crosswalk`);
    }
  });

  it("trade 'other' has no benchmark at any tier, by design -- the seed contains zero rows for it", async () => {
    if (!databaseUrl) return;
    expect(seed.wage_references.some((r) => r.trade_category === 'other')).toBe(false);

    const result = await lookupPayReference(adminClient, 'other', 'austin-tx');
    expect(result).toBeNull();
  });

  it('a SQL-injection-shaped city_key is treated as an ordinary non-matching string (parameterized query), falling back to state', async () => {
    if (!databaseUrl) return;
    const hostile = "'; DROP TABLE city_cbsa_crosswalk; --";
    const result = await lookupPayReference(adminClient, 'electrician', hostile);
    expect(result?.area_kind).toBe('state');

    // Prove the table still exists and still has rows (the injection did not fire).
    const stillThere = await adminClient.query(`SELECT count(*)::int AS count FROM city_cbsa_crosswalk`);
    expect(stillThere.rows[0].count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// If DB is unavailable, emit a single top-level concern notice so CI captures it
// ---------------------------------------------------------------------------
if (!databaseUrl) {
  test('CONCERN: pay-reference-lookup-integration PostgreSQL gate was not run -- JALE_TEST_DATABASE_URL not set', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[pay-reference-lookup.integration] DONE_WITH_CONCERNS: The PostgreSQL gate for T-B2 lookupPayReference() was ' +
        'skipped because JALE_TEST_DATABASE_URL is not set in this environment. Run with a local Postgres 16 container ' +
        '(via infra/db/local/bootstrap-testbed.sh) to validate all pay-reference lookup assertions.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}
