import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'run-migration-034.ps1');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

describe('run-migration-034.ps1', () => {
  it('applies migration 034 only, never the full chain', () => {
    const script = readScript();

    const migrationMatch = script.match(/\$MigrationFiles = @\(([\s\S]*?)\)/);
    expect(migrationMatch).not.toBeNull();
    const migrationBlock = migrationMatch![1];

    const referencedMigrations = migrationBlock.match(/\d{3}_[a-zA-Z0-9_]+\.sql/g) ?? [];
    expect(referencedMigrations).toEqual(['034_billing_foundation.sql']);

    // No other numbered migration file should appear anywhere in the array literal.
    expect(migrationBlock).not.toMatch(/033_/);
    expect(migrationBlock).not.toMatch(/001_/);
  });

  it('never echoes or prints password variables', () => {
    const script = readScript();

    // Forbidden: directly echoing/printing the raw password variables.
    expect(script).not.toMatch(/echo\s+"?\$BILLING_PW"?\s*$/m);
    expect(script).not.toMatch(/Write-Host\s+\$BILLING_PW/);

    // Password material must be unset on the bastion after use.
    expect(script).toMatch(/unset[^\n]*BILLING_PW/);
    expect(script).toMatch(/unset[^\n]*PGPASSWORD/);
  });

  it('resolves BillingDbSecret for the jale_billing role password sync', () => {
    const script = readScript();

    expect(script).toContain('BillingDbSecret');
    expect(script).toContain('jale_billing');
    expect(script).toContain("ALTER ROLE jale_billing WITH PASSWORD");
  });

  it('pre-checks that migration 034 is absent before applying, and aborts if present', () => {
    const script = readScript();

    expect(script).toContain("to_regclass('public.billing_plans')");
    expect(script).toMatch(/PRE-CHECK/);
    expect(script).toMatch(/ABORT/);
    expect(script).toMatch(/forward-only/i);
  });

  it('supports a -VerifyOnly switch that skips apply and password sync', () => {
    const script = readScript();

    expect(script).toContain('[switch]$VerifyOnly');
    expect(script).toContain('VERIFY-ONLY');
    // Verify-only path must not resolve or use the billing secret.
    expect(script).toMatch(/if \(-not \$VerifyOnly\) \{[\s\S]*?BillingDbSecret/);
  });

  it('never creates or overwrites the jale/billing/db secret (CDK-managed)', () => {
    const script = readScript();

    expect(script).not.toContain('create-secret');
    expect(script).not.toContain('put-secret-value');
  });

  it('warns operators away from the full-chain migration scripts', () => {
    const script = readScript();

    expect(script).toMatch(/run-migrations\.ps1/);
    expect(script).toMatch(/DO NOT use/i);
  });

  it('proves the jale_billing role can connect after the password sync', () => {
    const script = readScript();

    expect(script).toContain('-U jale_billing');
    expect(script).toMatch(/SELECT 1/);
  });

  it('runs the read-only post-verification suite covering RLS and grants', () => {
    const script = readScript();

    for (const table of [
      'organizations',
      'billing_plans',
      'billing_customers',
      'subscriptions',
      'billing_operations',
      'billing_webhook_events',
    ]) {
      expect(script).toContain(table);
    }

    expect(script).toContain('relrowsecurity');
    expect(script).toContain('relforcerowsecurity');
    expect(script).toContain("has_table_privilege('jale_billing','public.users'");
    expect(script).toContain("has_table_privilege('jale_billing','public.billing_operations'");
    expect(script).toContain('employer_free');
    expect(script).toContain('employer_pro');
    expect(script).toContain('worker_free');
    expect(script).toContain('"1"');
    expect(script).toContain('"10"');
    expect(script).toContain('"2000"');
  });
});
