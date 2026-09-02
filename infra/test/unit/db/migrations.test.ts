import * as fs from 'node:fs';
import * as path from 'node:path';

const migrationsDir = path.join(__dirname, '..', '..', '..', 'db', 'migrations');

function migrationFiles(): string[] {
  return fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function migrationSql(): string {
  return migrationFiles()
    .map((name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
    .join('\n');
}

describe('database migrations', () => {
  // 020b_rls_relationship_recursion_prevention.sql is the one deliberate
  // exception to "one file per numbered slot": it must apply between 020 and
  // 021 on a fresh cluster (see its header comment for the full "why"), but
  // 001-033 are immutable and 023 cannot be renumbered, so it cannot claim a
  // bare three-digit slot of its own without colliding with 020 or 023. This
  // allowlist keeps the invariant meaningful (still catches any *other*
  // numbering mistake) while permitting exactly this one insertion.
  const INSERTED_NON_CONTIGUOUS_FILES = ['020b_rls_relationship_recursion_prevention.sql'];

  it('use one contiguous lexical sequence (plus the one documented insertion)', () => {
    const files = migrationFiles().filter((name) => !INSERTED_NON_CONTIGUOUS_FILES.includes(name));
    const numbers = files.map((name) => name.match(/^(\d{3})_/)?.[1]);

    expect(numbers).not.toContain(undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
      '011',
      '012',
      '013',
      '014',
      '015',
      '016',
      '017',
      '018',
      '019',
      '020',
      '021',
      '022',
      '023',
      '024',
      '025',
      '026',
      '027',
      '028',
      '029',
      '030',
      '031',
      '032',
      '033',
      '034',
      '035',
      '036',
      '037',
      '038',
      '039',
      '040',
      '041',
      '042',
      '043',
      '044',
      '045',
      '046',
      '047',
      '048',
      '049',
      '050',
      '051',
      '052',
      '053',
      '054',
      '055',
      '056',
      '057',
      '058',
      '059',
      '060',
      '061',
      '062',
      '063',
      '064',
      '065',
      '066',
      '067',
      '068',
      '069',
      '070',
      '071',
      '072',
      '073',
      '074',
      '075',
      '076',
      '077',
      '078',
      '079',
      '080',
      '081',
      '082',
      '083',
      '084',
      '085',
      '086',
      '087',
      '088',
      '089',
      '090',
      '091',
    ]);

    // The insertion must sort strictly between 020 and 021 under plain
    // lexical/byte ordering (what Node's Array.prototype.sort() and the
    // migration runner both use) so the fresh-cluster apply order is
    // deterministic regardless of shell locale.
    const allFiles = migrationFiles();
    const idx020 = allFiles.indexOf('020_worker_pii_rls_hardening.sql');
    const idx020b = allFiles.indexOf('020b_rls_relationship_recursion_prevention.sql');
    const idx021 = allFiles.indexOf('021_whatsapp_required_docs_apply_support.sql');
    expect(idx020).toBeGreaterThanOrEqual(0);
    expect(idx020b).toBe(idx020 + 1);
    expect(idx021).toBe(idx020b + 1);
  });

  it('define canonical jobs and applications only once', () => {
    const sql = migrationSql();
    const applicationsTable = sql.match(/CREATE TABLE(?: IF NOT EXISTS)? job_applications\s*\([\s\S]*?\n\);/i)?.[0] ?? '';

    expect(sql.match(/CREATE TABLE(?: IF NOT EXISTS)? jobs\s*\(/gi)).toHaveLength(1);
    expect(sql.match(/CREATE TABLE(?: IF NOT EXISTS)? job_applications\s*\(/gi)).toHaveLength(1);
    expect(applicationsTable).toContain('worker_id  UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT');
    expect(applicationsTable).toContain("DEFAULT 'pending'");
    expect(applicationsTable).toContain("CHECK (status IN ('pending', 'reviewed', 'hired', 'rejected'))");
    expect(applicationsTable).not.toMatch(/\buser_id\b/i);
  });

  it('defines employer profiles for web account creation', () => {
    const sql = migrationSql();
    const employerProfilesTable = sql.match(/CREATE TABLE(?: IF NOT EXISTS)? employer_profiles\s*\([\s\S]*?\n\);/i)?.[0] ?? '';

    expect(sql.match(/CREATE TABLE(?: IF NOT EXISTS)? employer_profiles\s*\(/gi)).toHaveLength(1);
    expect(employerProfilesTable).toContain('user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE');
    expect(employerProfilesTable).toContain('hiring_trades       TEXT[] NOT NULL DEFAULT');
    expect(employerProfilesTable).toContain('typical_job_types   TEXT[] NOT NULL DEFAULT');
    expect(sql).toContain('CREATE POLICY employer_profiles_self');
  });

  it('keeps identity contexts unambiguous', () => {
    const initial = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.sql'), 'utf8');
    const docs = fs.readFileSync(path.join(migrationsDir, '005_document_vault.sql'), 'utf8');

    expect(initial).toContain('REFERENCES users(id) ON DELETE RESTRICT');
    expect(docs).toContain('app.current_internal_user_id');
    expect(docs).not.toMatch(/worker_id::text = current_setting\('app\.current_user_id'/);
  });

  it('adds billing foundation tables, org scaffolding, and jale_billing role in migration 034', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '034_billing_foundation.sql'), 'utf8');

    // Org-ready scaffolding
    expect(migration).toContain('CREATE TABLE organizations');
    expect(migration).toContain('ALTER TABLE organizations FORCE  ROW LEVEL SECURITY');
    expect(migration).toContain('ADD CONSTRAINT users_tenant_id_fkey');
    expect(migration).toContain('FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE RESTRICT');

    // Core billing tables
    expect(migration).toContain('CREATE TABLE billing_plans');
    expect(migration).toContain('CREATE TABLE billing_customers');
    expect(migration).toContain('CREATE TABLE subscriptions');
    expect(migration).toContain('CREATE TABLE billing_operations');
    expect(migration).toContain('CREATE TABLE billing_webhook_events');

    // Seed rows
    expect(migration).toContain("'employer_free'");
    expect(migration).toContain("'employer_pro'");
    expect(migration).toContain("'worker_free'");
    expect(migration).toContain('2000');

    // Partial index for one-active-sub-per-user
    expect(migration).toContain('subscriptions_one_current_per_user');
    expect(migration).toContain("WHERE status NOT IN ('canceled', 'incomplete_expired')");

    // Idempotency constraint
    expect(migration).toContain('UNIQUE (actor_user_id, operation_type, client_idempotency_key)');

    // RLS + FORCE
    expect(migration).toContain('ALTER TABLE billing_plans          FORCE  ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE billing_webhook_events FORCE  ROW LEVEL SECURITY');

    // jale_billing service role
    expect(migration).toContain("rolname = 'jale_billing'");
    expect(migration).toContain('CREATE ROLE jale_billing WITH LOGIN');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE         ON subscriptions          TO jale_billing');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE         ON billing_webhook_events TO jale_billing');

    // jale_admin grants (no webhook events)
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON billing_customers  TO jale_admin');
    expect(migration).toContain('GRANT SELECT                 ON subscriptions      TO jale_admin');
    expect(migration).not.toContain('GRANT SELECT, INSERT, UPDATE ON billing_webhook_events TO jale_admin');
  });

  it('adds least-privilege job-limit enforcement in migration 036', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '036_billing_job_limit_enforcement.sql'), 'utf8');
    expect(migration).toContain('CREATE ROLE jale_billing_job_enforcer');
    expect(migration).toContain('CREATE SCHEMA jale_billing_internal AUTHORIZATION jale_billing_job_enforcer');
    expect(migration).toContain('CREATE FUNCTION jale_billing_internal.billing_pause_over_limit_jobs');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(migration).toContain('ORDER BY j.created_at ASC, j.id ASC');
    expect(migration).toContain("AND j.status = 'active'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs');
    expect(migration).toContain(
      'WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
    );
    expect(migration).toContain(
      'WITH SET TRUE, INHERIT FALSE',
    );
    expect(migration).toContain(
      'WITH SET FALSE, INHERIT FALSE',
    );
    expect(migration).toContain(
      'REVOKE jale_billing_job_enforcer FROM jale_admin GRANTED BY jale_admin',
    );
    expect(migration).toContain('NOT membership.set_option');
    expect(migration).toContain('jale_billing_job_enforcer column privilege invariant failed');
    expect(migration).toContain('Billing enforcer schema/function invariant failed');
    expect(migration).toContain('Billing enforcer ACL invariant failed');
    expect(migration).toContain(
      "acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'jale_admin')",
    );
    expect(migration).toContain("acl.privilege_type = 'USAGE'");
    expect(migration).not.toContain(
      "has_schema_privilege('jale_admin', 'jale_billing_internal', 'USAGE')",
    );
    expect(migration).not.toContain(
      "has_function_privilege('jale_admin', enforcer_function.function_oid, 'EXECUTE')",
    );
    expect(migration).not.toContain('ALTER ROLE jale_billing_job_enforcer');
  });

  it('adds a bounded default-deny generic email outbox in migration 037', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '037_email_outbox.sql'), 'utf8');
    expect(migration).toContain('CREATE TABLE email_outbox');
    expect(migration).toContain('recipient_email');
    expect(migration).toContain('source_id         UUID NOT NULL');
    expect(migration).toContain('next_attempt_at   TIMESTAMPTZ');
    expect(migration).toContain('next_attempt_at ASC NULLS FIRST');
    expect(migration).toContain("status IN ('pending', 'sent', 'failed', 'send_unknown')");
    expect(migration).toContain('email_outbox_idempotency_unique');
    expect(migration).toContain('ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("WITH CHECK (source_type = 'billing_pause')");
    expect(migration).not.toContain('GRANT DELETE');
  });

  it('repairs relationship RLS recursion with a narrow NOLOGIN helper in migration 038', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '038_rls_relationship_recursion_repair.sql'), 'utf8');
    expect(migration).toContain('CREATE ROLE jale_rls_relationship_reader');
    expect(migration).toContain('NOLOGIN NOSUPERUSER');
    expect(migration).toContain('NOBYPASSRLS');
    expect(migration).toContain('ALTER POLICY jobs_worker_read_active    ON jobs             TO jale_admin');
    expect(migration.match(/ALTER POLICY/g)).toHaveLength(8);
    expect(migration).toContain('GRANT SELECT (worker_id, job_id) ON job_applications');
    expect(migration).toContain('GRANT SELECT (id, employer_id) ON jobs');
    expect(migration).toContain('GRANT USAGE ON SCHEMA public TO jale_rls_relationship_reader');
    expect(migration).toContain('CREATE SCHEMA jale_internal AUTHORIZATION jale_rls_relationship_reader');
    expect(migration).toContain('REVOKE ALL ON SCHEMA jale_internal FROM PUBLIC');
    expect(migration).toContain('CREATE FUNCTION jale_internal.employer_has_applicant_relationship');
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(migration).toContain('GRANT USAGE ON SCHEMA jale_internal TO jale_admin');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION jale_internal.employer_has_applicant_relationship');
    expect(migration).toContain('Existing jale_internal schema has unexpected owner');
    expect(migration).toContain('Existing jale_rls_relationship_reader role has unsafe memberships');
    expect(migration).toContain('jale_rls_relationship_reader creator membership invariant failed');
    expect(migration).toContain('Relationship predicate definition invariant failed');
    expect(migration).toContain('jale_internal PUBLIC privilege invariant failed');
    expect(migration).toContain(
      "acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'jale_admin')",
    );
    expect(migration).not.toContain(
      "has_schema_privilege('jale_admin', 'jale_internal', 'CREATE')",
    );
    expect(migration).toContain('policy.polroles = ARRAY[');
    expect(migration).toContain('NOT membership.set_option');
    expect(migration).toContain(
      'WITH ADMIN TRUE, INHERIT FALSE, SET FALSE',
    );
    expect(migration).toContain(
      'WITH SET TRUE, INHERIT FALSE',
    );
    expect(migration).toContain(
      'WITH SET FALSE, INHERIT FALSE',
    );
    expect(migration).toContain(
      'REVOKE jale_rls_relationship_reader FROM jale_admin GRANTED BY jale_admin',
    );
    expect(migration).not.toContain('ALTER ROLE jale_rls_relationship_reader');
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(migration).not.toMatch(/\sBYPASSRLS(?:\s|;)/);
  });

  it('adds a least-privilege idempotent WhatsApp support-case function in migration 039', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '039_whatsapp_support_cases.sql'), 'utf8');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION create_admin_support_case');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain("c.case_type = 'help_request'");
    expect(migration).toContain("c.status IN ('open', 'pending_worker', 'pending_admin')");
    expect(migration).toContain("'case_created'");
    expect(migration).toContain("'title', 'Worker requested help'");
    expect(migration).toContain("'detail', LEFT(v_summary, 500)");
    expect(migration).toContain("'help_request',\n    'open',\n    70");
    expect(migration).toContain('wc.user_id IS NULL');
    expect(migration).toContain('wc.whatsapp_number = u.whatsapp_number');
    expect(migration).toContain('wc.whatsapp_number = u.phone');
    expect(migration).not.toContain('GRANT SELECT ON whatsapp_conversations TO jale_admin');
    expect(migration).toContain('REVOKE ALL ON FUNCTION create_admin_support_case(UUID, UUID, TEXT, TEXT) FROM PUBLIC');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION create_admin_support_case(UUID, UUID, TEXT, TEXT) TO jale_whatsapp');
    expect(migration).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\s+ON\s+admin_cases\s+TO\s+jale_whatsapp/i);
  });

  it('adds durable monotonic Twilio delivery correlation in migration 040', () => {
    const migration = fs.readFileSync(
      path.join(migrationsDir, '040_whatsapp_delivery_status.sql'),
      'utf8',
    );
    expect(migration).toContain('record_whatsapp_delivery_status');
    expect(migration).toContain(
      'GRANT SELECT (id, twilio_message_sid, status, sent_at, delivered_at),\n' +
      '      UPDATE (twilio_message_sid, status, sent_at, delivered_at)\n' +
      '  ON public.job_conversation_messages TO jale_twilio_callback;',
    );
    expect(migration).toContain('record_twilio_delivery_status');
    expect(migration).toContain("source_type IN ('admin_case', 'job_alert', 'worker_intent')");
    expect(migration).toContain('FROM public.job_conversation_messages');
    // Review-1 correction: the privileged implementation lives in the
    // locked jale_twilio_callback schema (fully qualified, catalog-only
    // search_path); public.record_twilio_status is now a narrow wrapper.
    expect(migration).toContain('jale_twilio_callback.record_twilio_status(p_sid, p_status, p_at)');
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION jale_twilio_callback.record_twilio_delivery_status',
    );
    expect(migration).toContain('NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT');
    expect(migration).toContain(
      "'GRANT jale_twilio_callback TO %I WITH ADMIN TRUE, SET FALSE, INHERIT FALSE'",
    );
    expect(migration).toContain(
      "'GRANT jale_twilio_callback TO %I WITH SET TRUE, INHERIT FALSE'",
    );
    expect(migration).toContain(
      "'GRANT jale_twilio_callback TO %I WITH SET FALSE, INHERIT FALSE'",
    );
    expect(migration).toContain(
      "'REVOKE jale_twilio_callback FROM %I GRANTED BY %I'",
    );
    expect(migration).toContain('AND grantor.rolsuper');
    expect(migration).toContain("function.proargtypes = '25 25 25 25'::pg_catalog.oidvector");
    expect(migration).toContain(
      "has_function_privilege('jale_whatsapp', v_unified_callback, 'EXECUTE')",
    );
    expect(migration).toContain('OWNER TO jale_twilio_callback');
    expect(migration).toContain('REVOKE CREATE ON SCHEMA public FROM jale_twilio_callback');
    expect(migration).toContain('callback wrapper execute ACL drift');
    expect(migration).toContain('idx_whatsapp_outbox_twilio_message_sid');
    // Review-1 correction: no unconditional ALTER ROLE against production;
    // rerun validates existing role attributes instead.
    expect(migration).not.toMatch(/^ALTER ROLE jale_twilio_callback\b/m);
    expect(migration).toContain('jale_twilio_callback role already exists with unsafe attributes');
    // Review-1 correction: DB-level bounds on error fields.
    expect(migration).toContain('whatsapp_outbox_twilio_error_code_check');
    expect(migration).toContain('whatsapp_outbox_twilio_error_message_check');
  });

  it('keeps the Bash migration runner pointed at the current files', () => {
    const expectedFiles = migrationFiles();
    const scriptPaths = [
      path.join(__dirname, '..', '..', '..', '..', 'scripts', 'run-migrations.sh'),
    ];

    for (const scriptPath of scriptPaths) {
      const script = fs.readFileSync(scriptPath, 'utf8');
      for (const file of expectedFiles) {
        expect(script).toContain(file);
      }
      expect(script).toContain("starts_with(LogicalResourceId, 'JaleDatabaseStackDatabaseSecret')");
      expect(script).toContain("starts_with(LogicalResourceId, 'MatchingDbSecret')");
      expect(script).toContain('ALTER ROLE jale_matching WITH PASSWORD');
      expect(script).toContain("starts_with(LogicalResourceId, 'BillingDbSecret')");
      expect(script).toContain('ALTER ROLE jale_billing WITH PASSWORD');
      expect(script).toContain("starts_with(LogicalResourceId, 'ReferralsDbSecret')");
      expect(script).toContain('ALTER ROLE jale_public_jobs WITH PASSWORD');
      expect(script).not.toContain('003_whatsapp.sql');
      expect(script).not.toContain('004_jobs.sql');
      expect(script).not.toContain('005_job_applications.sql');
      expect(script).not.toContain('006_whatsapp_reliability.sql');
      expect(script).not.toContain('007_trust_signal_layer.sql');
    }
  });

  it('keeps the PowerShell migration runner pointed at the current files', () => {
    const expectedFiles = migrationFiles();
    const ps1 = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'scripts', 'run-migrations.ps1'), 'utf8',
    );
    for (const file of expectedFiles) {
      expect(ps1).toContain(file);
    }
  });

  it('widens job_message_outbox.status to a terminal send_unknown in migration 044', () => {
    const migration = fs.readFileSync(
      path.join(migrationsDir, '044_job_message_outbox_send_unknown.sql'), 'utf8',
    );
    expect(migration).toContain("CHECK (status IN ('pending', 'sent', 'failed', 'send_unknown'))");
  });

  it('idempotently restores applications_employer_update in migration 045', () => {
    const migration = fs.readFileSync(
      path.join(migrationsDir, '045_applications_employer_update_repair.sql'), 'utf8',
    );
    expect(migration).toContain('CREATE POLICY applications_employer_update');
    expect(migration).toContain('IF NOT EXISTS');
  });

  it('keeps WhatsApp template outbox migration independent from matching materialization tables', () => {
    const sql013 = fs.readFileSync(path.join(migrationsDir, '013_whatsapp_template_outbox.sql'), 'utf8');

    expect(sql013).toContain('content_template');
    expect(sql013).toContain('content_variables');
    expect(sql013).toContain("to_regclass('public.job_candidates')");
    expect(sql013).toContain('whatsapp_read_ranked_jobs');
  });

  it('adds hardened tokenized document upload slots in migration 017', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '017_document_upload_token_hardening.sql'), 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS s3_version_id TEXT');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS document_upload_token_slots');
    expect(migration).toContain('PRIMARY KEY (token_hash, doc_type)');
    expect(migration).toContain('UNIQUE (issued_s3_key)');
    expect(migration).toContain('worker_documents_worker_update');
  });

  it('hardens document vault RLS in migration 018', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '018_document_vault_rls_hardening.sql'), 'utf8');

    expect(migration).toContain('ALTER TABLE worker_documents ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE worker_documents FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON worker_documents TO jale_admin');
    expect(migration).toContain('worker_documents_worker_delete');
    expect(migration).toContain('worker_documents_worker_update');
    expect(migration).toContain('DROP POLICY IF EXISTS worker_documents_employer_select ON worker_documents');
    expect(migration).toContain('CREATE POLICY worker_documents_employer_select ON worker_documents');
    expect(migration).toContain('worker_documents.job_id IS NOT NULL');
    expect(migration).toContain('FROM job_applications ja');
    expect(migration).toContain('ja.worker_id = worker_documents.worker_id');
    expect(migration).toContain('ja.job_id = worker_documents.job_id');
  });

  it('repairs live application status constraints in migration 019', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '019_application_status_constraint_repair.sql'), 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ');
    expect(migration).toContain('pg_get_constraintdef(con.oid) ILIKE');
    expect(migration).toContain('ALTER TABLE job_applications DROP CONSTRAINT %I');
    expect(migration).toContain("WHEN 'viewed' THEN 'reviewed'");
    expect(migration).toContain("WHEN 'contacted' THEN 'reviewed'");
    expect(migration).toContain("CHECK (status IN ('pending', 'reviewed', 'hired', 'rejected'))");
    expect(migration).toContain('DROP TRIGGER IF EXISTS job_applications_updated_at');
  });

  it('hardens worker PII RLS in migration 020', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '020_worker_pii_rls_hardening.sql'), 'utf8');

    expect(migration).toContain('DROP POLICY IF EXISTS worker_profiles_employer_read');
    expect(migration).toContain('DROP POLICY IF EXISTS worker_skills_employer_read');
    expect(migration).toContain('CREATE POLICY users_employer_applicant_read');
    expect(migration).toContain("current_setting('app.current_internal_user_id', true)");
    expect(migration).toContain('FROM job_applications ja');
    expect(migration).toContain('j.employer_id::text');
    expect(migration).not.toContain("user_type = 'employer'");
    expect(migration).not.toContain('job_candidates');
    expect(migration).not.toContain('employer_candidate_rankings');
    expect(migration).toContain('REVOKE SELECT ON worker_profiles FROM jale_matching');
    expect(migration).toContain('REVOKE SELECT ON worker_skills FROM jale_matching');
    expect(migration).toContain('REVOKE SELECT ON worker_documents FROM jale_matching');
    expect(migration).toContain('information_schema.columns');
    expect(migration).toContain('matching_profile_columns');
    expect(migration).toContain('DROP POLICY IF EXISTS worker_documents_matching_read');
  });

  it('prevents the users<->jobs/job_applications RLS recursion before a fresh cluster reaches migration 023', () => {
    const migration = fs.readFileSync(
      path.join(migrationsDir, '020b_rls_relationship_recursion_prevention.sql'),
      'utf8',
    );

    // Same repair 038 performs, carried earlier so a fresh cluster's first
    // pass through the chain never hits 023's 42P17 abort.
    expect(migration).toContain('CREATE ROLE jale_rls_relationship_reader');
    expect(migration).toContain('NOLOGIN NOSUPERUSER');
    expect(migration).toContain('NOBYPASSRLS');
    expect(migration).toContain('ALTER POLICY jobs_worker_read_active    ON jobs             TO jale_admin');
    expect(migration.match(/ALTER POLICY/g)).toHaveLength(8);
    expect(migration).toContain('GRANT SELECT (worker_id, job_id) ON job_applications');
    expect(migration).toContain('GRANT SELECT (id, employer_id) ON jobs');
    expect(migration).toContain('CREATE SCHEMA jale_internal AUTHORIZATION jale_rls_relationship_reader');
    expect(migration).toContain('CREATE FUNCTION jale_internal.employer_has_applicant_relationship');
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(migration).toContain('jale_rls_relationship_reader creator membership invariant failed');
    expect(migration).toContain('Relationship predicate definition invariant failed');
    expect(migration).toContain(
      "acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'jale_admin')",
    );
    expect(migration).not.toContain(
      "has_schema_privilege('jale_admin', 'jale_internal', 'CREATE')",
    );
    expect(migration).toContain('WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
    expect(migration).toContain('WITH SET TRUE, INHERIT FALSE');
    expect(migration).toContain('WITH SET FALSE, INHERIT FALSE');
    expect(migration).toContain(
      'REVOKE jale_rls_relationship_reader FROM jale_admin GRANTED BY jale_admin',
    );
    expect(migration).not.toContain('ALTER ROLE jale_rls_relationship_reader');
  });

  it('adds WhatsApp document access support in migration 021', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '021_whatsapp_required_docs_apply_support.sql'), 'utf8');

    expect(migration).toContain('GRANT SELECT, INSERT ON worker_documents TO jale_whatsapp');
    expect(migration).not.toContain('UPDATE ON worker_documents TO jale_whatsapp');
    expect(migration).not.toContain('DELETE ON worker_documents TO jale_whatsapp');
  });

  it('guards direct application inserts in migration 022', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '022_job_application_required_docs_guard.sql'), 'utf8');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION enforce_job_application_required_docs');
    expect(migration).toContain('FROM worker_documents wd');
    expect(migration).toContain('wd.job_id IS NULL OR wd.job_id = NEW.job_id');
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).toContain('CREATE TRIGGER job_applications_required_docs_guard');
  });

  it('adds MVP job fields and lifecycle statuses in migration 023', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '023_job_fields_and_statuses_mvp.sql'), 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS pay_min INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS pay_max INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS number_of_workers_needed INTEGER NOT NULL DEFAULT 1');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS workers_hired INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain("CHECK (status IN ('active', 'paused', 'filled', 'closed'))");
    expect(migration).toContain("WHEN 'reviewed' THEN 'contacted'");
    expect(migration).toContain("WHEN 'rejected' THEN 'not_interested'");
    expect(migration).toContain("CHECK (status IN ('pending', 'contacted', 'talking', 'hired', 'not_interested'))");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sync_job_hired_counts');
    expect(migration).toContain("IF TG_OP = 'DELETE' THEN");
    expect(migration).toContain('target_job_id := OLD.job_id');
    expect(migration).toContain('target_job_id := NEW.job_id');
    expect(migration).toContain('CREATE TRIGGER job_applications_hired_count_sync');
  });

  it('hardens Sprint 11 hiring flow fields in migration 024', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '024_sprint11_hiring_flow_hardening.sql'), 'utf8');

    expect(migration).toContain('sprint11_unexpected_application_status');
    expect(migration).toContain('DISABLE TRIGGER job_applications_hired_count_sync');
    expect(migration).toContain('ENABLE TRIGGER job_applications_hired_count_sync');
    expect(migration).toContain("CHECK (status IN ('pending', 'contacted', 'talking', 'hired', 'not_interested'))");
    expect(migration).toContain('NOT VALID');
    expect(migration).toContain('VALIDATE CONSTRAINT job_applications_status_check');
    expect(migration).toContain('idx_job_applications_status_talking');
    expect(migration).toContain('idx_job_applications_status_hired');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS jobs_pay_range_check');
    expect(migration).toContain('jobs_pay_bounds_check');
    expect(migration).toContain('VALIDATE CONSTRAINT jobs_pay_bounds_check');
    expect(migration).toContain('pay_min <= 9999');
    expect(migration).toContain('pay_max <= 9999');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS jobs_headcount_check');
    expect(migration).toContain('jobs_headcount_bounds_check');
    expect(migration).toContain('VALIDATE CONSTRAINT jobs_headcount_bounds_check');
    expect(migration).toContain('number_of_workers_needed BETWEEN 1 AND 500');
    expect(migration).toContain('workers_hired <= number_of_workers_needed');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS jobs_required_experience_check');
    expect(migration).toContain('jobs_required_experience_years_bounds_check');
    expect(migration).toContain('VALIDATE CONSTRAINT jobs_required_experience_years_bounds_check');
    expect(migration).toContain('required_experience_years BETWEEN 0 AND 80');
  });

  it('adds applicant-scoped job messaging in migration 025', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '025_job_messaging.sql'), 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS job_conversations');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS job_conversation_messages');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS job_message_outbox');
    expect(migration).toContain('job_conversations_open_unique');
    expect(migration).toContain("CHECK (sender_type IN ('employer', 'worker', 'system'))");
    expect(migration).toContain("CHECK (send_kind IN ('template', 'freeform'))");
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON job_conversations TO jale_admin');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON job_conversations TO jale_whatsapp');
    expect(migration).toContain('ALTER TABLE job_conversations FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('app.current_internal_user_id', true)");
    expect(migration).toContain('job_conversations_employer_all');
    expect(migration).toContain('job_conversations_worker_all');
  });

  it('adds an append-only audited admin panel schema in migration 026', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '026_admin_panel.sql'), 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS admin_users');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS admin_cases');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS admin_case_events');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS admin_audit_log');
    expect(migration).toContain("CHECK (role IN ('admin_readonly', 'admin_ops', 'admin_superadmin'))");
    expect(migration).toContain("CHECK (case_type IN ('help_request', 'verification_blocker', 'outbound_failure', 'conversation_stuck'))");
    expect(migration).toContain('ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT SELECT, INSERT ON admin_audit_log TO jale_admin');
    expect(migration).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON admin_audit_log TO jale_admin');
  });

  it('adds revocable admin sessions and a durable admin reply outbox in migration 027', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '027_admin_security_hardening.sql'), 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS admin_sessions');
    expect(migration).toContain('token_hash CHAR(64) NOT NULL UNIQUE');
    expect(migration).toContain('idx_whatsapp_outbox_idempotency');
    expect(migration).toContain("CHECK (status IN ('pending', 'sent', 'failed', 'send_unknown'))");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION record_admin_whatsapp_delivery');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) TO jale_whatsapp');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION reconcile_worker_signup');
    expect(migration).toContain('pg_advisory_xact_lock');
  });

  it('hardens job messaging with thread numbers, status callbacks, and outbox sweeper in migration 028', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '028_job_messaging_hardening.sql'), 'utf8');

    expect(migration).toContain('GRANT UPDATE (status, updated_at) ON job_applications TO jale_whatsapp');
    expect(migration).toContain('DROP POLICY IF EXISTS jobapp_whatsapp_all ON job_applications');
    expect(migration).toContain('CREATE POLICY jobapp_whatsapp_select ON job_applications');
    expect(migration).toContain('CREATE POLICY jobapp_whatsapp_insert ON job_applications');
    expect(migration).toContain('CREATE POLICY jobapp_whatsapp_update ON job_applications');
    expect(migration).toContain('ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ');
    expect(migration).toContain('ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS employer_last_read_at TIMESTAMPTZ');
    expect(migration).toContain('ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS worker_thread_number INTEGER');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_thread_counters');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION assign_worker_thread_number');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('ALTER TABLE whatsapp_conversations');
    expect(migration).toContain('focused_job_conversation_id');
    expect(migration).toContain('ALTER TABLE job_conversation_messages');
    expect(migration).toContain("CHECK (status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered',");
    expect(migration).toContain('ALTER TABLE job_conversation_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ');
    expect(migration).toContain('idx_job_messages_twilio_sid');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION record_twilio_status');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION list_stale_job_outbox_workers');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION assign_worker_thread_number');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION record_twilio_status');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION list_stale_job_outbox_workers');
  });

  it('makes sync_job_hired_counts SECURITY DEFINER in migration 029 so jale_whatsapp replies do not hit permission denied on jobs', () => {
    const migration = fs.readFileSync(
      path.join(migrationsDir, '029_hired_count_trigger_security_definer.sql'),
      'utf8',
    );

    expect(migration).toContain('CREATE OR REPLACE FUNCTION sync_job_hired_counts()');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public');
    // Trigger binding is preserved via CREATE OR REPLACE — must NOT recreate it.
    expect(migration).not.toContain('CREATE TRIGGER');
  });

  it('adds read-only wage reference tables with no write policy in migration 070', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '071_wage_references.sql'), 'utf8');

    expect(migration).toContain('CREATE TABLE wage_references');
    expect(migration).toContain('CREATE TABLE city_cbsa_crosswalk');
    expect(migration).toContain('ALTER TABLE wage_references FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE city_cbsa_crosswalk FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('wage_references_read_all');
    expect(migration).toContain('city_cbsa_crosswalk_read_all');
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });

  // These are literal-string invariants in the same spirit as the 036/038/020b
  // assertions above, and they exist for one specific reason: on RDS there is
  // no Jest. migration 082's own terminal DO block is the ONLY thing that
  // verifies its role machinery in production, so if someone deletes those
  // in-file invariants (as an earlier revision of 080 in fact did), no
  // PostgreSQL-backed suite can catch it -- the database would simply be
  // unverified rather than wrong. Pinning the error strings here means the
  // deletion fails a test that runs everywhere, with no database at all.
  it('keeps migration 082 self-verifying: the in-file invariants that are the only RDS-side check', () => {
    const migration = fs.readFileSync(
      path.join(migrationsDir, '082_employer_digest_settings.sql'),
      'utf8',
    );

    // The creator-membership end state (036:281-300 shape). A surviving
    // membership row with set_option would let jale_admin SET ROLE to the
    // enumerator and read every employer's settings cross-tenant.
    expect(migration).toContain('jale_digest_enumerator creator membership invariant failed');
    expect(migration).toContain('NOT membership.set_option');
    expect(migration).toContain('NOT membership.inherit_option');
    expect(migration).toContain('grantor.rolsuper');

    // The 036 role-membership dance itself.
    expect(migration).toContain('WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
    expect(migration).toContain('WITH SET TRUE, INHERIT FALSE');
    expect(migration).toContain('WITH SET FALSE, INHERIT FALSE');
    expect(migration).toContain('REVOKE jale_digest_enumerator FROM jale_admin GRANTED BY jale_admin');

    // Definer-function invariants: owner + prosecdef + pinned search_path.
    expect(migration).toContain(
      'definer invariant failed (owner/SECURITY DEFINER/search_path)',
    );
    expect(migration).toContain("ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]");
    expect(migration).toContain('functions, expected exactly 2');

    // PUBLIC-ACL negatives on the private schema and both functions.
    expect(migration).toContain('jale_digest_internal is reachable by PUBLIC');
    expect(migration).toContain('is EXECUTE-able by PUBLIC');
    expect(migration).toContain('acl.grantee = 0');

    // Exact column-grant arrays, not spot probes.
    expect(migration).toContain('exact users SELECT column grants changed');
    expect(migration).toContain('exact employer_digest_settings UPDATE column grants changed');
    expect(migration).toContain('holds unexpected privilege kinds');
    expect(migration).toContain("ARRAY['cognito_sub', 'email', 'id', 'user_type']::TEXT[]");
    expect(migration).toContain("ARRAY['enabled']::TEXT[]");

    // Policy shape (cmd + roles), not merely policy names.
    expect(migration).toContain('missing or wrong shape (expected cmd=%, role=%)');
    expect(migration).toContain('p.polcmd::TEXT = expected_policy.polcmd');
    expect(migration).toContain('p.polroles = ARRAY[(');
  });

  it('keeps migration 082 resilient to a stored timezone leaving tzdata', () => {
    const migration = fs.readFileSync(
      path.join(migrationsDir, '082_employer_digest_settings.sql'),
      'utf8',
    );

    // `AT TIME ZONE <unlisted zone>` RAISES rather than returning NULL, so
    // without this fence one unusable row aborts the whole set-returning query
    // and every employer misses their digest. MATERIALIZED is load-bearing: a
    // plain CTE lets the planner hoist the date_part predicate ahead of the
    // join and raise anyway (verified on PostgreSQL 16.14).
    expect(migration).toContain('WITH listed AS MATERIALIZED (');
    expect(migration).toContain('JOIN pg_catalog.pg_timezone_names tz ON tz.name = s.timezone');

    // The producer mints the unsubscribe token from (employer_id, version), so
    // the sanctioned cross-tenant read has to return the version too.
    expect(migration).toContain('unsubscribe_token_version smallint');

    // The guard trigger, and the short-circuit that keeps a row with a
    // since-delisted zone updatable.
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF timezone ON employer_digest_settings');
    expect(migration).toContain(
      "IF TG_OP = 'UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN",
    );
    expect(migration).toContain("name NOT IN ('localtime', 'posixrules', 'Factory')");

    // A subquery CHECK is parse-rejected (0A000) and `AT TIME ZONE` accepts
    // POSIX-style garbage, so neither may be used as the validator.
    expect(migration).not.toMatch(/CHECK\s*\([^)]*SELECT\s+name\s+FROM\s+pg_timezone_names/i);
  });

  it('admin analytics definer functions are locked to the console role', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '088_admin_analytics.sql'), 'utf8');

    // Five definer functions, each hardened per the migration-072 pattern.
    // Line-anchored so prose in a comment mentioning "SECURITY DEFINER" can't
    // inflate the count (the actual clauses each stand alone on their line).
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(5);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(5);
    expect(sql.match(/OWNER TO jale_admin;/g)).toHaveLength(5);
    expect(sql.match(/REVOKE ALL ON FUNCTION public\.admin_analytics_\w+\([^)]*\) FROM PUBLIC;/g)).toHaveLength(5);
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.admin_analytics_\w+\([^)]*\) TO jale_admin_console;/g)).toHaveLength(5);
    // Exactly five mentions of the grantee total, so an extra GRANT ALL,
    // role-membership grant, or default-privileges escalation to the console
    // role can't slip in alongside the five reviewed EXECUTE grants.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(5);

    // The console role must gain no table access from this migration.
    expect(sql).not.toMatch(/GRANT\s+SELECT[\s\S]*?TO jale_admin_console/);
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]*?jale_admin_console/);
  });

  it('087 repairs the analytics definers without widening the console role', () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, '089_admin_analytics_rls_repair.sql'),
      'utf8',
    );

    // 087 re-declares all five definers (086's RLS defect could not be fixed by
    // policies alone — each body must also flip the gate flag), so it carries
    // the same hardening counts 086 does.
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(5);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(5);
    expect(sql.match(/OWNER TO jale_admin;/g)).toHaveLength(5);
    expect(sql.match(/REVOKE ALL ON FUNCTION public\.admin_analytics_\w+\([^)]*\) FROM PUBLIC;/g)).toHaveLength(5);
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.admin_analytics_\w+\([^)]*\) TO jale_admin_console;/g)).toHaveLength(5);
    // Exactly five mentions of the grantee total — same escalation guard as 086.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(5);

    // Every function must convert to plpgsql and open the gate itself; a body
    // that forgot the set_config would silently read zero rows again.
    expect(sql.match(/^LANGUAGE plpgsql$/gm)).toHaveLength(5);
    expect(
      sql.match(/PERFORM set_config\('app\.admin_analytics_read', 'on', true\);/g),
    ).toHaveLength(5);

    // Exactly five gated policies, and EVERY CREATE POLICY in this file is
    // scoped TO jale_admin (the definer owner) — never to the console role.
    const policies = sql.match(/CREATE POLICY/g);
    expect(policies).toHaveLength(5);
    expect(
      sql.match(
        /CREATE POLICY \w+_admin_analytics_read\s+ON public\.\w+ FOR SELECT\s+TO jale_admin\s+USING \(current_setting\('app\.admin_analytics_read', true\) = 'on'\);/g,
      ),
    ).toHaveLength(5);

    // The console role must gain no table access from this migration either.
    expect(sql).not.toMatch(/GRANT\s+SELECT[\s\S]*?TO jale_admin_console/);
    // Scoped per-statement, not across the file: 087 legitimately contains both
    // CREATE POLICY statements and (later) the five EXECUTE grants, so 086's
    // whole-file `CREATE POLICY[\s\S]*?jale_admin_console` form would match the
    // span between two unrelated statements. Policy bodies contain no
    // semicolons, so `[^;]*;` isolates one statement at a time.
    for (const stmt of sql.match(/CREATE POLICY[^;]*;/g) ?? []) {
      expect(stmt).not.toMatch(/jale_admin_console/);
    }

    // Forward-only: 087 must not try to edit or drop 086's objects.
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  // Same reason as the 082/088/089 blocks above: on RDS there is no Jest, so
  // 091's own terminal DO block is the ONLY thing that verifies it in
  // production. Pinning its literal strings here means deleting or weakening
  // that block fails a test that runs everywhere, with no database at all.
  // The CHECK string and the object names are pinned as literals because the
  // whole point of 091 is WHICH statuses/columns/grants exist -- a paraphrase
  // would pass while the schema was wrong.
  it('091 adds the application-stage vocabulary and keeps itself self-verifying', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '091_application_stages.sql'), 'utf8');

    // ── One transaction, forward-only, migrate-before-deploy ──
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain('APPLY THIS MIGRATION *BEFORE* DEPLOYING THE CODE');
    // 024 needed NOT VALID because it NARROWED the domain; a widened CHECK
    // must not copy that shape.
    expect(sql).not.toMatch(/NOT VALID/);
    expect(sql).not.toMatch(/VALIDATE CONSTRAINT/);

    // (a) The widened status domain, as the exact literal the app layer's
    // APPLICATION_STATUSES mirrors -- details_requested sits between talking
    // and hired.
    expect(sql).toContain(
      "CHECK (status IN ('pending', 'contacted', 'talking', 'details_requested', 'hired', 'not_interested'))",
    );
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_job_applications_status_details_requested');
    expect(sql).toContain("WHERE status = 'details_requested'");

    // (b) Stage timestamps, nullable with no default.
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS details_requested_at TIMESTAMPTZ');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS details_completed_at TIMESTAMPTZ');

    // (c) jobs.pre_application_prompts + the IMMUTABLE STRICT validator and
    // its exact bounds (the app layer hand-syncs these three numbers).
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS pre_application_prompts JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.pre_application_prompts_valid(p JSONB)');
    expect(sql).toMatch(/^IMMUTABLE$/m);
    expect(sql).toMatch(/^STRICT$/m);
    expect(sql).toContain('WHEN jsonb_array_length(p) > 10 THEN false');
    expect(sql).toContain("'^[A-Za-z0-9_-]{1,40}$'");
    expect(sql).toContain("char_length(e.value ->> 'text') > 500");
    expect(sql).toContain("(SELECT count(*) FROM jsonb_object_keys(e.value) AS k) <> 2");
    expect(sql).toContain("count(DISTINCT x.value ->> 'id')");
    expect(sql).toContain('ADD CONSTRAINT jobs_pre_application_prompts_valid');
    expect(sql).toContain('CHECK (public.pre_application_prompts_valid(pre_application_prompts))');
    // 077's precedent: jale_public_jobs is the one column-scoped reader on
    // jobs, and public-job.ts enumerates columns.
    expect(sql).toContain('GRANT SELECT (pre_application_prompts) ON jobs TO jale_public_jobs');
    // A pure invoker-rights validator evaluated inside a CHECK must keep its
    // default PUBLIC EXECUTE, unlike the definer functions in 072/088/089.
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.pre_application_prompts_valid/);

    // (d) prompt_answers as its own column (not a reserved application_answers
    // key), object-shaped, byte-capped under the 16384 answers cap.
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS prompt_answers JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(sql).toContain('ADD CONSTRAINT job_applications_prompt_answers_valid');
    expect(sql).toContain("jsonb_typeof(prompt_answers) = 'object'");
    // 16384 BYTES -- the same number and measure as MAX_ANSWERS_JSON_LENGTH
    // for application_answers, NOT a byte cap derived from the app's 10 x
    // 1000-CHARACTER bound (which a CJK/emoji answer set legitimately blows
    // past at 3-4 bytes per character).
    expect(sql).toContain('octet_length(prompt_answers::text) <= 16384');
    expect(sql).not.toContain('12288');

    // (e) The hire gate: invoker rights, WHEN-clause-scoped, fail-closed, and
    // job-scoped docs only.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.enforce_job_application_hire_requirements()');
    // Line-anchored, 088's technique: the header and the audit block both
    // discuss SECURITY DEFINER in prose, but an actual clause always stands
    // alone on its own line. There must be none in this file.
    expect(sql).not.toMatch(/^SECURITY DEFINER$/m);
    expect(sql).toContain('BEFORE UPDATE OF status ON job_applications');
    expect(sql).toContain("WHEN (NEW.status = 'hired' AND OLD.status IS DISTINCT FROM 'hired')");
    expect(sql).toContain('CREATE TRIGGER job_applications_hire_requirements_guard');
    expect(sql).toContain("CONSTRAINT = 'job_applications_hire_requirements_check'");
    expect(sql).toContain("ERRCODE = '23514'");
    expect(sql).toContain('"reason": "job_unreadable"');
    expect(sql).toContain("'fields',         to_jsonb(v_missing_fields)");
    expect(sql).toContain("'docs',           to_jsonb(v_missing_docs)");
    expect(sql).toContain("'certifications', to_jsonb(v_missing_certs)");
    // Legacy 'ssn' can no longer be supplied by any worker (032/073), so it
    // must never block a hire.
    expect(sql).toContain("WHERE d <> 'ssn'");
    // 018 hides vault rows from an employer session entirely -- the gate must
    // count job-scoped snapshots ONLY, the opposite of 022's predicate.
    expect(sql).toContain('AND wd.job_id = NEW.job_id');
    expect(sql).not.toContain('wd.job_id IS NULL OR wd.job_id = NEW.job_id');
    // Required tier only, has=true, proof via non-empty doc_ids.
    expect(sql).toContain("AND req.tier = 'required'");
    expect(sql).toContain("AND c.value ->> 'has' = 'true'");
    expect(sql).toContain("jsonb_array_length(c.value -> 'doc_ids') > 0");

    // (e) 022/080's INSERT guard trigger goes; its FUNCTION deliberately
    // stays until 092 so a revert is one CREATE TRIGGER.
    expect(sql).toContain('DROP TRIGGER IF EXISTS job_applications_required_docs_guard ON job_applications');
    expect(sql).not.toMatch(/DROP FUNCTION[\s\S]*enforce_job_application_required_docs/);

    // (f) Grants: the two worker-writable columns, and NOT the employer-only
    // details_requested_at.
    expect(sql).toContain(
      'GRANT UPDATE (prompt_answers, details_completed_at) ON job_applications TO jale_whatsapp',
    );
    expect(sql).not.toMatch(/GRANT UPDATE \([^)]*details_requested_at/);
    // 081's deferred write-back, lifted with a row-scoped policy alongside
    // (the grant alone reaches zero rows under 079's FORCE RLS).
    expect(sql).toContain('GRANT INSERT, UPDATE ON worker_application_defaults TO jale_whatsapp');
    expect(sql).toContain(
      'DROP POLICY IF EXISTS worker_application_defaults_whatsapp_write ON worker_application_defaults',
    );
    expect(sql).toContain('CREATE POLICY worker_application_defaults_whatsapp_write');
    expect(sql).toContain('ON worker_application_defaults FOR ALL TO jale_whatsapp');
    expect(sql).toContain(
      "USING (worker_id::text = current_setting('app.current_internal_user_id', true))",
    );
    expect(sql).toContain(
      "WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true))",
    );
    // Forward-only: 079's and 081's policies are committed and must not be
    // edited or undone from here.
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS worker_application_defaults_self/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS worker_application_defaults_whatsapp_read/);
    expect(sql).not.toMatch(/^REVOKE/m);
    // No DELETE was ever granted on the defaults table (079/081's posture).
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*ON worker_application_defaults/);

    // (g) The Nova -> Claude Haiku 4.5 trade_questions cache purge, and the
    // deploy-order exception it carries (the Haiku generator PR must be
    // deployed BEFORE this file is applied, or the purge is simply wasted).
    expect(sql).toContain('1. deploy the Haiku question-generator PR');
    expect(sql).toContain('2. apply THIS file');
    expect(sql).toContain('3. deploy the application-stages code');
    expect(sql).toContain(
      "DELETE FROM public.trade_questions\n   WHERE is_seeded = false AND model_id LIKE '%nova%';",
    );
    expect(sql).toContain(
      "RAISE NOTICE 'migration 091: purged % Nova-generated trade_questions cache row(s)', v_deleted;",
    );
    // The end state IS checked (086 Part 4 checked nothing), but as a WARNING:
    // a surviving Nova row means the ordering rule was violated and the purge
    // accomplished nothing, which the operator must hear -- yet aborting would
    // roll back the status CHECK, the columns and the hire gate over one AI
    // cache row that self-corrects on the next miss. Pinning RAISE WARNING
    // keeps a later edit from promoting it to RAISE EXCEPTION.
    expect(sql).toContain(
      "SELECT count(*) INTO v_remaining\n    FROM public.trade_questions\n   WHERE is_seeded = false AND model_id LIKE '%nova%';",
    );
    expect(sql).toMatch(
      /RAISE WARNING 'migration 091: % Nova-generated trade_questions row\(s\) survived the purge/,
    );
    expect(sql).not.toMatch(/RAISE EXCEPTION[^;]*trade_questions/);
    // The five SEEDED standard trades must never be touched: no unqualified
    // purge (086 Part 4's wider predicate), and nothing that names
    // is_seeded = true or TRUNCATEs the table.
    expect(sql).not.toMatch(/DELETE FROM public\.trade_questions\s+WHERE is_seeded = false;/);
    expect(sql).not.toMatch(/DELETE FROM[^;]*trade_questions[^;]*is_seeded = true/);
    expect(sql).not.toMatch(/TRUNCATE/);
    // trade_questions is the only table this migration deletes rows from.
    expect(sql.match(/^\s*DELETE FROM/gm)).toHaveLength(1);

    // (h) The terminal self-audit block's own error strings -- the only
    // RDS-side verification of everything above.
    expect(sql).toContain('job_applications_status_check missing or not widened with details_requested');
    expect(sql).toContain('idx_job_applications_status_details_requested missing or has no details_requested predicate');
    expect(sql).toContain('missing, not timestamptz, or unexpectedly NOT NULL');
    expect(sql).toContain('jobs.pre_application_prompts missing, nullable, not jsonb, or missing its empty-array default');
    expect(sql).toContain('pre_application_prompts_valid is not IMMUTABLE (provolatile = %)');
    expect(sql).toContain('pre_application_prompts_valid is not STRICT');
    expect(sql).toContain('pre_application_prompts_valid smoke test failed');
    expect(sql).toContain(
      'SELECT public.pre_application_prompts_valid(\'[{"id": "a", "text": "x"}]\')',
    );
    expect(sql).toContain('AND NOT public.pre_application_prompts_valid(\'[{"id": "a"}]\')');
    expect(sql).toContain('job_applications_prompt_answers_valid CHECK missing or malformed');
    expect(sql).toContain('job_applications_hire_requirements_guard trigger missing on job_applications');
    expect(sql).toContain('has no WHEN clause (hired -> hired would re-run the gate)');
    expect(sql).toContain('must NOT be SECURITY DEFINER');
    expect(sql).toContain('no longer raises under the job_applications_hire_requirements_check constraint name');
    expect(sql).toContain('lost its fail-closed job_unreadable branch');
    expect(sql).toContain('is still present -- stage 1 cannot create incomplete applications while it lives');
    expect(sql).toContain('jale_whatsapp missing UPDATE grant on job_applications.%');
    expect(sql).toContain(
      'jale_whatsapp unexpectedly has UPDATE on job_applications.details_requested_at',
    );
    expect(sql).toContain('jale_public_jobs missing SELECT grant on jobs.pre_application_prompts');
    expect(sql).toContain('worker_application_defaults must keep RLS ENABLE + FORCE');
    expect(sql).toContain('worker_application_defaults must carry all three policies');
    expect(sql).toContain('worker_application_defaults_whatsapp_write missing or wrong shape');
    expect(sql).toContain('jale_whatsapp missing INSERT/UPDATE on worker_application_defaults');
    expect(sql).toContain('jale_whatsapp unexpectedly has DELETE on worker_application_defaults');
    // The audit block asserts the trigger's WHEN via tgqual and the index via
    // its predicate expression -- name-only checks would pass on a drifted
    // object.
    expect(sql).toContain('t.tgqual IS NOT NULL');
    expect(sql).toContain('pg_get_expr(i.indpred, i.indrelid)');
    expect(sql).toContain("provolatile <> 'i'");
  });
});
