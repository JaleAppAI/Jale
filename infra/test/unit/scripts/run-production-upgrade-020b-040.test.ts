import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'run-production-upgrade-020b-040.sh');
const runbookPath = path.join(repoRoot, 'docs', 'production-upgrade-020b-040.md');
const migration041Path = path.join(
  repoRoot,
  'infra',
  'db',
  'migrations',
  '041_whatsapp_web_worker_lookup_grant.sql',
);

describe('production upgrade 020b/035-046 operator tooling', () => {
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
      '041_whatsapp_web_worker_lookup_grant.sql',
      '042_whatsapp_onboarding_gate.sql',
      '043_whatsapp_worker_intent_transport.sql',
      '046_whatsapp_active_workflow_rebind.sql',
    ]);
    expect(block).not.toMatch(/001_|002_|003_|034_/);
    expect(script).toContain('046_*)');
    expect(script).toContain("strpos(function.prosrc,'v_created_run BOOLEAN := false') > 0");
    expect(script).toContain("strpos(function.prosrc,'IF v_run IS NULL THEN') > 0");
    expect(script).toContain("strpos(function.prosrc,'IF v_created_run THEN') > 0");
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
    const migration041 = fs.readFileSync(migration041Path, 'utf8');

    for (const marker of [
      'jale_internal.employer_has_applicant_relationship',
      'jobs_employer_delete',
      'billing_pause_over_limit_jobs',
      'public.email_outbox',
      'create_admin_support_case',
      'twilio_delivery_status',
      'idx_whatsapp_outbox_twilio_message_sid',
      'record_whatsapp_delivery_status',
      'tos_accepted_at',
      'worker_onboarding_state',
      'bind_verified_identity_and_start_workflow',
      'worker_intent_lease_token',
      'lease_worker_intent_outbox',
      'whatsapp_outbox_worker_intent_delivery_state',
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
    expect(script).toContain(
      "namespace.nspname='jale_billing_internal' AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='jale_admin') AND acl.privilege_type='USAGE'",
    );
    expect(script).not.toContain(
      "has_schema_privilege('jale_admin','jale_billing_internal','USAGE')",
    );
    expect(script).not.toContain("record_whatsapp_delivery_status(character varying,text,text,text)");
    expect(script).toContain("policyname='wa_users_read'");
    expect(script).toContain('table_class.relrowsecurity AND table_class.relforcerowsecurity');
    expect(script).toContain("qual='(user_type = ''worker''::text)'");
    expect(migration041).toContain('GRANT SELECT (tos_accepted_at) ON users TO jale_whatsapp;');
    expect(migration041).not.toMatch(/GRANT\s+SELECT\s+ON\s+users\s+TO\s+jale_whatsapp/i);
    expect(script).toContain('# COMPLETE_042_BEGIN');
    expect(script).toContain('# COMPLETE_043_BEGIN');
    expect(script).toContain("owner.rolname='jale_admin'");
    expect(script).toContain("owner.rolname='jale_twilio_callback'");
    expect(script).toContain("NOT has_function_privilege('public',function.oid,'EXECUTE')");
    expect(script).toContain("NOT has_column_privilege('jale_whatsapp','public.whatsapp_outbox','worker_intent_lease_token','UPDATE')");
    expect(script).toContain("NOT has_column_privilege('jale_whatsapp','public.whatsapp_outbox','worker_intent_leased_until','UPDATE')");
    expect(script).toContain("member.rolname='jale_admin'");
    expect(script).not.toContain('member.rolname=current_user');
    expect(script).toContain("policy.permissive='RESTRICTIVE'");
    expect(script).toContain("trigger.tgname='whatsapp_outbox_worker_intent_delivery_state'");
  });

  it('requires no runtime-control row that a later migration in the chain deletes', () => {
    // A completion predicate is checked against whatever schema the database
    // has reached, so it may rely only on seed rows that later migrations keep.
    // Migration 054 deletes 042's 'onboarding_v2_enabled' row by design.
    const script = fs.readFileSync(scriptPath, 'utf8');
    const migrationsDir = path.join(repoRoot, 'infra', 'db', 'migrations');
    const deletedKeys = new Set<string>();
    for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      for (const m of sql.matchAll(/DELETE\s+FROM\s+(?:public\.)?whatsapp_runtime_controls\s+WHERE\s+control_key\s*=\s*'([a-z0-9_]+)'/gi)) {
        deletedKeys.add(m[1]);
      }
    }
    expect([...deletedKeys]).toContain('onboarding_v2_enabled');

    const requiredKeys = new Set<string>();
    for (const clause of script.matchAll(/FROM public\.whatsapp_runtime_controls\s+WHERE control_key(?:\s+IN\s*\(([^)]*)\)|\s*=\s*('[^']*'))/g)) {
      for (const key of (clause[1] ?? clause[2]).matchAll(/'([a-z0-9_]+)'/g)) requiredKeys.add(key[1]);
    }
    expect([...requiredKeys]).toContain('deferred_delivery_enabled');
    expect([...requiredKeys].filter((key) => deletedKeys.has(key))).toEqual([]);
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
    for (const migration of ['040', '042', '043']) {
      const predicate = script.match(
        new RegExp(
          `# COMPLETE_${migration}_BEGIN[\\s\\S]*?complete=\\$\\(cat <<'SQL'\\n([\\s\\S]*?)\\nSQL\\n\\)[\\s\\S]*?# COMPLETE_${migration}_END`,
        ),
      )?.[1];
      expect(predicate).toBeDefined();
      predicates.push(predicate!);
    }
    expect(predicates).toHaveLength(9);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // Predicate 2 is 036's: it names billing_pause_over_limit_jobs, which
      // migration 133 dropped (128's company pair replaced it). On the fully
      // migrated schema it is false for that reason alone: the rest of what
      // 036 left (role, schema, policies, grants) still holds, which a
      // rolled-back stand-in for the function proves below.
      const PREDICATE_036 = 2;
      for (const [predicateIndex, predicate] of predicates.entries()) {
        const result = await client.query<{ complete: boolean }>(
          `SELECT (${predicate}) AS complete`,
        );
        if (predicateIndex === PREDICATE_036) {
          expect(result.rows).toEqual([{ complete: false }]);
          continue;
        }
        if (result.rows[0]?.complete !== true) {
          throw new Error(`completion predicate ${predicateIndex} was false`);
        }
        expect(result.rows).toEqual([{ complete: true }]);
      }

      await client.query('BEGIN');
      try {
        await client.query(`CREATE FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(uuid, integer)
          RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT'`);
        await client.query('ALTER FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(uuid, integer) OWNER TO jale_billing_job_enforcer');
        await client.query('REVOKE ALL ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(uuid, integer) FROM PUBLIC');
        await client.query('GRANT EXECUTE ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(uuid, integer) TO jale_billing');
        const standIn = await client.query<{ complete: boolean }>(
          `SELECT (${predicates[PREDICATE_036]}) AS complete`,
        );
        expect(standIn.rows).toEqual([{ complete: true }]);
      } finally {
        await client.query('ROLLBACK');
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
        `SELECT (${predicates[6]}) AS complete`,
      );
      expect(callbackDrift.rows).toEqual([{ complete: false }]);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query('ALTER TABLE worker_onboarding_state NO FORCE ROW LEVEL SECURITY');
      const onboardingDrift = await client.query<{ complete: boolean }>(
        `SELECT (${predicates[7]}) AS complete`,
      );
      expect(onboardingDrift.rows).toEqual([{ complete: false }]);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(
        'DROP POLICY whatsapp_outbox_worker_intent_rpc_only ON whatsapp_outbox',
      );
      const transportDrift = await client.query<{ complete: boolean }>(
        `SELECT (${predicates[8]}) AS complete`,
      );
      expect(transportDrift.rows).toEqual([{ complete: false }]);
      await client.query('ROLLBACK');

      // 042's durable seed row is what the runtime-control clause requires.
      await client.query('BEGIN');
      await client.query(
        "DELETE FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'",
      );
      const seedDrift = await client.query<{ complete: boolean }>(
        `SELECT (${predicates[7]}) AS complete`,
      );
      expect(seedDrift.rows).toEqual([{ complete: false }]);
      await client.query('ROLLBACK');

      // A database where 042 never ran: neither marker the script checks first
      // exists and the completion predicate is false, so 042 reads as absent
      // (pending), never as complete.
      const present042 = script.match(/042_\*\)\n\s+present="([^"]+)"/)?.[1];
      expect(present042).toBeDefined();
      await client.query('BEGIN');
      await client.query('DROP TABLE public.worker_onboarding_state CASCADE');
      await client.query(
        'DROP FUNCTION IF EXISTS public.bind_verified_identity_and_start_workflow(text,uuid,uuid,integer,text,text,jsonb) CASCADE',
      );
      const neverApplied = await client.query<{ present: boolean; complete: boolean }>(
        `SELECT (${present042}) AS present, (${predicates[7]}) AS complete`,
      );
      expect(neverApplied.rows).toEqual([{ present: false, complete: false }]);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});
