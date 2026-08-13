/**
 * seed-oews-wages.ts
 *
 * Operator loader: idempotently upserts infra/scripts/data/oews-tx-seed.json
 * into wage_references / city_cbsa_crosswalk (migration 070). Re-run this
 * roughly annually after regenerating the seed file (see
 * generate-oews-seed.ts) with the new OEWS release.
 *
 * Usage:
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx ts-node scripts/seed-oews-wages.ts [--file <path>] [--dry-run]
 *
 * Both tables are ENABLE + FORCE RLS with only a SELECT policy for
 * jale_admin (migration 070) -- no INSERT/UPDATE/DELETE policy exists
 * anywhere else. This script is "the seed path" migration 070's header
 * refers to: it opens a temporary write policy scoped to jale_admin inside
 * its own transaction, performs the upserts, verifies the row count
 * matches what was expected, drops the policy, and commits -- exactly the
 * pattern migration 069 used to update billing_plans.entitlements. If the
 * script is interrupted before COMMIT, the whole transaction (including the
 * temporary policies) rolls back -- no dangling write policy is left
 * behind.
 */

/* eslint-disable no-console */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export interface WageReferenceRow {
  trade_category: string;
  area_code: string;
  area_kind: 'metro' | 'nonmetro' | 'state';
  area_label: string;
  p25_hourly: number;
  p50_hourly: number;
  p75_hourly: number;
  source_tier: 'metro' | 'nonmetro' | 'state';
  data_vintage: string;
}

export interface CrosswalkRow {
  city_key: string;
  city: string;
  state: string;
  county_fips: string | null;
  area_code: string;
  area_kind: 'metro' | 'nonmetro';
}

export interface SeedFile {
  placeholder: boolean;
  data_vintage: string;
  generated_at?: string;
  provenance?: Record<string, unknown>;
  wage_references: WageReferenceRow[];
  city_cbsa_crosswalk: CrosswalkRow[];
}

export function loadSeed(filePath: string): SeedFile {
  const raw = fs.readFileSync(filePath, 'utf8');
  const seed = JSON.parse(raw) as SeedFile;
  if (!Array.isArray(seed.wage_references) || !Array.isArray(seed.city_cbsa_crosswalk)) {
    throw new Error(`${filePath} does not look like a valid oews-tx-seed.json (missing arrays)`);
  }
  return seed;
}

function printPlaceholderBannerIfNeeded(seed: SeedFile): void {
  if (seed.placeholder) {
    console.warn('');
    console.warn('#############################################################');
    console.warn('### PLACEHOLDER DATA -- THIS IS NOT REAL BLS OEWS WAGE DATA ##');
    console.warn('#############################################################');
    console.warn('The seed file being loaded has "placeholder": true. Every wage_references');
    console.warn('row it contains is a synthetic, flat number, NOT a real BLS figure. Do not');
    console.warn('load this into a production database as real wage data. Re-run');
    console.warn('generate-oews-seed.ts with network access to bls.gov before seeding prod.');
    console.warn('#############################################################');
    console.warn('');
  }
}

async function upsertWithTemporaryPolicy(
  client: Client,
  table: 'wage_references' | 'city_cbsa_crosswalk',
  upsert: () => Promise<number>,
  expectedRowCount: number,
): Promise<void> {
  const insertPolicy = `${table}_seed_insert`;
  const updatePolicy = `${table}_seed_update`;

  // Scoped strictly to jale_admin and dropped before COMMIT -- the window
  // where a raw write is possible on this table exists only inside this
  // function, inside one transaction. See migration 070's header and
  // migration 069's precedent for why this is the correct shape under
  // FORCE RLS with no persistent write policy.
  await client.query(`CREATE POLICY ${insertPolicy} ON ${table} FOR INSERT TO jale_admin WITH CHECK (true)`);
  await client.query(`CREATE POLICY ${updatePolicy} ON ${table} FOR UPDATE TO jale_admin USING (true) WITH CHECK (true)`);

  const affected = await upsert();

  await client.query(`DROP POLICY ${insertPolicy} ON ${table}`);
  await client.query(`DROP POLICY ${updatePolicy} ON ${table}`);

  // Loud verification before COMMIT -- a silent 0-row upsert here would be
  // a platform-wide "recommended pay never shows up" outage, the same
  // failure class migration 069's billing_plans_template_seed guards
  // against.
  if (affected !== expectedRowCount) {
    throw new Error(
      `${table} seed failed: expected to upsert ${expectedRowCount} rows, but ${affected} rows were affected. ` +
        `Rolling back -- check the seed file and RLS policies before retrying.`,
    );
  }
}

export async function upsertWageReferences(client: Client, rows: WageReferenceRow[]): Promise<void> {
  let affected = 0;
  await upsertWithTemporaryPolicy(
    client,
    'wage_references',
    async () => {
      for (const row of rows) {
        const result = await client.query(
          `INSERT INTO wage_references
             (trade_category, area_code, area_kind, area_label, p25_hourly, p50_hourly, p75_hourly, source_tier, data_vintage, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (trade_category, area_code) DO UPDATE SET
             area_kind    = EXCLUDED.area_kind,
             area_label   = EXCLUDED.area_label,
             p25_hourly   = EXCLUDED.p25_hourly,
             p50_hourly   = EXCLUDED.p50_hourly,
             p75_hourly   = EXCLUDED.p75_hourly,
             source_tier  = EXCLUDED.source_tier,
             data_vintage = EXCLUDED.data_vintage,
             updated_at   = now()`,
          [
            row.trade_category,
            row.area_code,
            row.area_kind,
            row.area_label,
            row.p25_hourly,
            row.p50_hourly,
            row.p75_hourly,
            row.source_tier,
            row.data_vintage,
          ],
        );
        affected += result.rowCount ?? 0;
      }
      return affected;
    },
    rows.length,
  );
}

export async function upsertCrosswalk(client: Client, rows: CrosswalkRow[]): Promise<void> {
  let affected = 0;
  await upsertWithTemporaryPolicy(
    client,
    'city_cbsa_crosswalk',
    async () => {
      for (const row of rows) {
        const result = await client.query(
          `INSERT INTO city_cbsa_crosswalk (city_key, county_fips, area_code, area_kind)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (city_key) DO UPDATE SET
             county_fips = EXCLUDED.county_fips,
             area_code   = EXCLUDED.area_code,
             area_kind   = EXCLUDED.area_kind`,
          [row.city_key, row.county_fips, row.area_code, row.area_kind],
        );
        affected += result.rowCount ?? 0;
      }
      return affected;
    },
    rows.length,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileIdx = args.indexOf('--file');
  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : path.join(__dirname, 'data', 'oews-tx-seed.json');

  const seed = loadSeed(filePath);
  console.log(`Loaded ${filePath}`);
  console.log(`  data_vintage: ${seed.data_vintage}`);
  console.log(`  wage_references: ${seed.wage_references.length} rows`);
  console.log(`  city_cbsa_crosswalk: ${seed.city_cbsa_crosswalk.length} rows`);
  printPlaceholderBannerIfNeeded(seed);

  if (dryRun) {
    console.log('\n--dry-run: not connecting to a database. Seed file is structurally valid.');
    return;
  }

  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'jale',
    user: process.env.DB_USER ?? 'jale_admin',
    password: process.env.DB_PASSWORD,
    ssl:
      process.env.DB_SSL === 'true'
        ? {
            rejectUnauthorized: true,
            ca: fs.readFileSync(path.join(__dirname, '../lambda/lib/rds-ca-bundle.pem'), 'utf-8'),
          }
        : false,
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    await upsertWageReferences(client, seed.wage_references);
    await upsertCrosswalk(client, seed.city_cbsa_crosswalk);
    await client.query('COMMIT');
    console.log(
      `\nSeed complete. Upserted ${seed.wage_references.length} wage_references rows and ` +
        `${seed.city_cbsa_crosswalk.length} city_cbsa_crosswalk rows.`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Seed failed (rolled back):', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
