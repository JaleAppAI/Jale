import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'run-production-upgrade-020b-040.sh');
const runbookPath = path.join(repoRoot, 'docs', 'production-upgrade-020b-040.md');

describe('production upgrade 020b/035-040 operator tooling', () => {
  it('allows only the reviewed forward-upgrade files in exact order', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const block = script.match(/MIGRATION_FILES=\(([\s\S]*?)\)/)?.[1] ?? '';
    const files = block.match(/(?:\d{3}b?|\d{3})_[a-zA-Z0-9_]+\.sql/g) ?? [];

    expect(files).toEqual([
      '020b_rls_relationship_recursion_prevention.sql',
      '035_job_delete_grants.sql',
      '036_billing_job_limit_enforcement.sql',
      '037_email_outbox.sql',
      '038_rls_relationship_recursion_repair.sql',
      '039_whatsapp_support_cases.sql',
      '040_whatsapp_delivery_status.sql',
    ]);
    expect(block).not.toMatch(/001_|002_|003_|034_/);
  });

  it('is verify-only by default and requires an explicit --apply flag to mutate', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');

    expect(script).toContain('--apply');
    expect(script).toContain('APPLY=0');
    expect(script).toMatch(/if \[\[ "\$APPLY" == '1' \]\][\s\S]*APPLY/);
    expect(script).toContain('No migrations were applied');
  });

  it('is valid Bash and does not require PowerShell', () => {
    const parsed = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    expect(parsed.stderr).toBe('');
    expect(fs.readFileSync(runbookPath, 'utf8')).not.toContain('pwsh');
  });

  it('fails closed on the wrong AWS account, region, baseline, or partial state', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');

    expect(script).toContain('--expected-account-id');
    expect(script).toContain('aws sts get-caller-identity');
    expect(script).toContain('EXPECTED_ACCOUNT_MISMATCH');
    expect(script).toContain('us-east-2');
    expect(script).toContain("to_regclass('public.billing_plans')");
    expect(script).toContain('UNSUPPORTED_BASELINE');
    expect(script).toContain('PARTIAL_STATE');
    expect(script).toContain('SSM_COMMAND_POLL_TIMEOUT');
    expect(script).toContain('MAX_POLLS=192');
    expect(script).toContain('DELIVERY_TIMEOUT_SECONDS=60');
    expect(script).toContain('REMOTE_EXECUTION_TIMEOUT_SECONDS=840');
    expect(script).toContain('executionTimeout: [$execution_timeout]');
    expect(script).toContain('--timeout-seconds "$DELIVERY_TIMEOUT_SECONDS"');
  });

  it('verifies a durable invariant for every migration before skipping it', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');

    for (const marker of [
      'jale_internal.employer_has_applicant_relationship',
      'jobs_employer_delete',
      'billing_pause_over_limit_jobs',
      'public.email_outbox',
      'create_admin_support_case',
      'twilio_delivery_status',
      'idx_whatsapp_outbox_twilio_message_sid',
      'record_whatsapp_delivery_status',
    ]) {
      expect(script).toContain(marker);
    }
    expect(script).toContain('POSTFLIGHT_FAILED');
    expect(script).toContain("function.proname IN ('record_twilio_status'");
    expect(script).toContain("function.proargtypes='25 25 25 25'::oidvector");
    expect(script).toContain(
      "acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='jale_admin') AND acl.privilege_type='CREATE'",
    );
    expect(script).not.toContain(
      "has_schema_privilege('jale_admin','jale_internal','CREATE')",
    );
    expect(script).not.toContain("record_whatsapp_delivery_status(character varying,text,text,text)");
  });

  it('keeps credentials on the bastion and does not rotate service passwords', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');

    expect(script).toContain('aws ssm send-command');
    expect(script).toContain('JaleDatabaseStackDatabaseSecret');
    expect(script).not.toContain('ALTER ROLE jale_billing WITH PASSWORD');
    expect(script).not.toContain('ALTER ROLE jale_whatsapp WITH PASSWORD');
    expect(script).not.toContain('create-secret');
    expect(script).not.toContain('put-secret-value');
    expect(script).toMatch(/unset[^\n]*PGPASSWORD/);
  });

  it('documents snapshot, preflight, apply, postflight, deployment, and cleanup', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');

    expect(runbook).toContain('create-db-snapshot');
    expect(runbook).toContain('db-snapshot-available');
    expect(runbook).toContain('--expected-account-id');
    expect(runbook).toContain('--apply');
    expect(runbook).toContain('deploy_scope=all');
    expect(runbook).toContain('destroy JaleBastionStack');
    expect(runbook).toContain('-c environment=production destroy JaleBastionStack');
    expect(runbook).toContain('WHATSAPP_ALARM_TOPIC_ARN');
    expect(runbook).toContain('EMAIL_FROM_ADDRESS');
    expect(runbook).toContain('SES_VERIFIED_IDENTITY_ARN');
  });

  const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
  const maybeIt = databaseUrl ? it : it.skip;

  maybeIt('executes every completion predicate against the fully migrated schema', async () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const predicates = [...script.matchAll(/^\s+complete="([^"]+)"$/gm)].map((match) => match[1]);
    const callbackPredicate = script.match(
      /# COMPLETE_040_BEGIN[\s\S]*?complete=\$\(cat <<'SQL'\n([\s\S]*?)\nSQL\n\)[\s\S]*?# COMPLETE_040_END/,
    )?.[1];
    expect(callbackPredicate).toBeDefined();
    predicates.push(callbackPredicate!);
    expect(predicates).toHaveLength(6);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      for (const predicate of predicates) {
        const result = await client.query<{ complete: boolean }>(
          `SELECT (${predicate}) AS complete`,
        );
        expect(result.rows).toEqual([{ complete: true }]);
      }

      await client.query('BEGIN');
      await client.query('ALTER POLICY jobs_employer_select ON jobs TO PUBLIC');
      const relationshipDrift = await client.query<{ complete: boolean }>(
        `SELECT (${predicates[0]}) AS complete`,
      );
      expect(relationshipDrift.rows).toEqual([{ complete: false }]);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('DROP POLICY admin_cases_twilio_callback_update ON admin_cases');
      const callbackDrift = await client.query<{ complete: boolean }>(
        `SELECT (${predicates[5]}) AS complete`,
      );
      expect(callbackDrift.rows).toEqual([{ complete: false }]);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});
