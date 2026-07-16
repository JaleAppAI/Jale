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
  it('use one contiguous lexical sequence', () => {
    const files = migrationFiles();
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
      '037',
      '038',
      '039',
    ]);
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

  it('adds least-privilege job-limit enforcement in migration 037', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '037_billing_job_limit_enforcement.sql'), 'utf8');
    expect(migration).toContain('CREATE ROLE jale_billing_job_enforcer');
    expect(migration).toContain('CREATE SCHEMA jale_billing_internal AUTHORIZATION jale_billing_job_enforcer');
    expect(migration).toContain('CREATE FUNCTION jale_billing_internal.billing_pause_over_limit_jobs');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp');
    expect(migration).toContain('ORDER BY j.created_at ASC, j.id ASC');
    expect(migration).toContain("AND j.status = 'active'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs');
    expect(migration).toContain('REVOKE jale_billing_job_enforcer FROM jale_admin');
    expect(migration).toContain('NOT membership.set_option');
    expect(migration).toContain('jale_billing_job_enforcer column privilege invariant failed');
    expect(migration).toContain('Billing enforcer schema/function invariant failed');
    expect(migration).toContain('Billing enforcer ACL invariant failed');
    expect(migration).not.toContain('ALTER ROLE jale_billing_job_enforcer');
  });

  it('adds a bounded default-deny generic email outbox in migration 038', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '038_email_outbox.sql'), 'utf8');
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

  it('repairs relationship RLS recursion with a narrow NOLOGIN helper in migration 039', () => {
    const migration = fs.readFileSync(path.join(migrationsDir, '039_rls_relationship_recursion_repair.sql'), 'utf8');
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
    expect(migration).toContain('policy.polroles = ARRAY[');
    expect(migration).toContain('NOT membership.set_option');
    expect(migration).toContain('REVOKE jale_rls_relationship_reader FROM jale_admin');
    expect(migration).not.toContain('ALTER ROLE jale_rls_relationship_reader');
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(migration).not.toMatch(/\sBYPASSRLS(?:\s|;)/);
  });

  it('keeps migration runner scripts pointed at the current files', () => {
    const expectedFiles = migrationFiles();
    const scriptPaths = [
      path.join(__dirname, '..', '..', '..', '..', 'scripts', 'run-migrations.ps1'),
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
      expect(script).not.toContain('003_whatsapp.sql');
      expect(script).not.toContain('004_jobs.sql');
      expect(script).not.toContain('005_job_applications.sql');
      expect(script).not.toContain('006_whatsapp_reliability.sql');
      expect(script).not.toContain('007_trust_signal_layer.sql');
    }
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
});
