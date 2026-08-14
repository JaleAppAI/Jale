import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptPath = path.join(__dirname, '..', '..', '..', 'scripts', 'seed-oews-wages.ts');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

describe('seed-oews-wages.ts', () => {
  it('connects like the other operator seed scripts (env-driven pg.Client, optional SSL via rds-ca-bundle.pem)', () => {
    const script = readScript();
    expect(script).toContain("host: process.env.DB_HOST ?? 'localhost'");
    expect(script).toContain("user: process.env.DB_USER ?? 'jale_admin'");
    expect(script).toContain('rds-ca-bundle.pem');
  });

  it('supports --dry-run without connecting to a database', () => {
    const script = readScript();
    expect(script).toContain("args.includes('--dry-run')");
    expect(script).toContain('not connecting to a database');
  });

  it('supports --file to override the default seed path', () => {
    const script = readScript();
    expect(script).toContain("args.indexOf('--file')");
    expect(script).toContain("'data', 'oews-tx-seed.json'");
  });

  it('idempotently upserts both tables via ON CONFLICT DO UPDATE', () => {
    const script = readScript();
    expect(script).toContain('ON CONFLICT (trade_category, area_code) DO UPDATE SET');
    expect(script).toContain('ON CONFLICT (city_key) DO UPDATE SET');
  });

  it('opens a temporary INSERT+UPDATE policy scoped to jale_admin per table, and always drops it before the row-count check throws', () => {
    const script = readScript();
    expect(script).toContain('FOR INSERT TO jale_admin WITH CHECK (true)');
    expect(script).toContain('FOR UPDATE TO jale_admin USING (true) WITH CHECK (true)');
    expect(script).toContain('DROP POLICY ${insertPolicy} ON ${table}');
    expect(script).toContain('DROP POLICY ${updatePolicy} ON ${table}');
    // The policies are dropped BEFORE the loud row-count check (not after),
    // so even a failed seed leaves no dangling write policy -- the whole
    // transaction (including the CREATE POLICY DDL) still rolls back on
    // throw, but this ordering means a *successful* upsert that still
    // somehow mismatches row counts does not leave the policy open either.
    const dropIdx = script.indexOf('DROP POLICY ${insertPolicy}');
    const checkIdx = script.indexOf('affected !== expectedRowCount');
    expect(dropIdx).toBeGreaterThan(0);
    expect(checkIdx).toBeGreaterThan(dropIdx);
  });

  it('raises loudly (never a silent no-op) if the upserted row count does not match the seed file', () => {
    const script = readScript();
    expect(script).toContain('affected !== expectedRowCount');
    expect(script).toContain('seed failed: expected to upsert');
  });

  it('rolls back the whole transaction on any failure', () => {
    const script = readScript();
    expect(script).toContain("await client.query('ROLLBACK')");
  });

  it('warns loudly (but does not silently refuse) when loading a placeholder-flagged seed file', () => {
    const script = readScript();
    expect(script).toContain('seed.placeholder');
    expect(script).toContain('PLACEHOLDER DATA -- THIS IS NOT REAL BLS OEWS WAGE DATA');
  });
});
