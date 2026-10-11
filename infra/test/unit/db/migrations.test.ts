import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderTriggers } from './helpers/audit-change-log';

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
      '092',
      '093',
      '094',
      '095',
      '096',
      '097',
      '098',
      '099',
      '100',
      '101',
      '102',
      '103',
      '104',
      '105',
      '106',
      '107',
      '108',
      '109',
      '110',
      '111',
      '112',
      '113',
      '114',
      '115',
      '117',
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

  it('098 adds hire counts and honest delivery failures without widening the console role', () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, '098_admin_analytics_hires_and_delivery.sql'),
      'utf8',
    );

    // Exactly the two changed definers, each hardened per 088/089. Line-anchored
    // so header prose cannot inflate the counts.
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(2);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(2);
    expect(sql.match(/^LANGUAGE plpgsql$/gm)).toHaveLength(2);
    expect(
      sql.match(/PERFORM set_config\('app\.admin_analytics_read', 'on', true\);/g),
    ).toHaveLength(2);
    expect(sql.match(/OWNER TO jale_admin;/g)).toHaveLength(2);
    expect(sql.match(/REVOKE ALL ON FUNCTION public\.admin_analytics_\w+\([^)]*\) FROM PUBLIC;/g)).toHaveLength(2);
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.admin_analytics_\w+\([^)]*\) TO jale_admin_console;/g)).toHaveLength(2);
    // Same escalation guard as 088/089: the two EXECUTE grants are the only
    // statements naming the console role as a grantee.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(2);

    // totals changes its return type, so it is the one drop; message_traffic
    // keeps its signature and is replaced in place.
    expect(sql.match(/DROP FUNCTION/g)).toHaveLength(1);
    expect(sql).toContain('DROP FUNCTION public.admin_analytics_totals();');
    expect(sql).toMatch(/hires_total\s+BIGINT/);
    expect(sql).toMatch(/jobs_with_hire\s+BIGINT/);
    expect(sql).toContain('hired_at IS NOT NULL');

    // The corrected failure and outbound definitions.
    expect(sql).toContain("o.status IN ('failed', 'send_unknown')");
    expect(sql).toContain("o.twilio_delivery_status IN ('failed', 'undelivered')");
    expect(sql).toContain("m.status IN ('failed', 'undelivered')");
    expect(sql).toContain("m.sender_type <> 'system'");

    // No new policies or table access: jobs, job_applications and
    // job_conversation_messages are already gated by 089.
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).not.toMatch(/GRANT\s+SELECT[\s\S]*?TO jale_admin_console/);
  });

  // 099–101 (roadmap sub-project 1d) share one shape: a FORCE-RLS, append-only
  // history table written only by a jale_admin-owned SECURITY DEFINER trigger,
  // readable only through 089's analytics gate. Returns the SQL so each test
  // can add its table-specific assertions.
  function expectHistoryCaptureMigration(file: string, table: string, fn: string, parent: string): string {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    // A stuck transaction holding the parent table's lock must not hang the
    // apply indefinitely; the lock_timeout is set before CREATE TABLE takes
    // the parent lock.
    const iBegin = sql.indexOf('BEGIN;');
    const iLock = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const iCreate = sql.indexOf('CREATE TABLE');
    expect(iBegin).toBeGreaterThanOrEqual(0);
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iCreate).toBeGreaterThan(iLock);

    // The backfill's own row-count comparison can't catch an 089-gate that
    // failed to open (both sides would read 0 and match); the precondition
    // DO block asserts the gate policy directly against pg_policy instead.
    expect(sql).toContain('missing or drifted; the backfill would read zero rows');

    expect(sql).toMatch(new RegExp(`CREATE TABLE public\\.${table} \\(`));
    expect(sql).toMatch(new RegExp(`REFERENCES public\\.${parent}\\(id\\) ON DELETE CASCADE`));
    expect(sql).toContain('id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(sql).toContain('is_backfill BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC;`);

    // Exactly two policies: the trigger's insert path and 089's gated read.
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(2);
    expect(sql).toMatch(new RegExp(
      `CREATE POLICY ${table}_capture_insert\\s+ON public\\.${table} FOR INSERT\\s+TO jale_admin\\s+WITH CHECK \\(true\\);`,
    ));
    expect(sql).toMatch(new RegExp(
      `CREATE POLICY ${table}_admin_analytics_read\\s+ON public\\.${table} FOR SELECT\\s+TO jale_admin\\s+USING \\(current_setting\\('app\\.admin_analytics_read', true\\) = 'on'\\);`,
    ));
    // Append-only for every session: no policy can rewrite history.
    expect(sql).not.toMatch(/FOR (UPDATE|DELETE|ALL)\b/);
    // No role but the owner gains anything.
    expect(sql).not.toMatch(/\bGRANT\b/);

    // One trigger function, hardened per 072/089; line-anchored so header prose
    // cannot inflate the counts.
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(1);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(1);
    expect(sql).toContain(`ALTER FUNCTION public.${fn}() OWNER TO jale_admin;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC;`);
    expect(sql.match(new RegExp(`EXECUTE FUNCTION public\\.${fn}\\(\\)`, 'g'))).toHaveLength(2);
    expect(sql).toMatch(new RegExp(`AFTER INSERT ON public\\.${parent}`));
    expect(sql).toMatch(new RegExp(`AFTER UPDATE OF [a-z_, ]+ ON public\\.${parent}`));

    // Backfill reads parents through 089's gate and flags its rows.
    expect(sql).toContain(`SELECT set_config('app.admin_analytics_read', 'on', true);`);
    expect(sql).toMatch(new RegExp(`INSERT INTO public\\.${table}\\s*\\([^)]*is_backfill\\)`));

    // Forward-only: never touches an earlier migration's objects.
    expect(sql).not.toMatch(/DROP (FUNCTION|TABLE|TRIGGER|POLICY)/);
    return sql;
  }

  it('099 records application status history through a definer trigger', () => {
    const sql = expectHistoryCaptureMigration(
      '099_job_application_status_events.sql',
      'job_application_status_events',
      'capture_job_application_status_event',
      'job_applications',
    );
    expect(sql).toContain('AFTER UPDATE OF status ON public.job_applications');
    expect(sql).toContain('WHEN (OLD.status IS DISTINCT FROM NEW.status)');
    // Hired rows backfill at their first hire (095), everything else at updated_at.
    expect(sql).toContain("WHEN a.status = 'hired' AND a.hired_at IS NOT NULL THEN a.hired_at");
  });

  it('100 records subscription status, plan, and cancellation history through a definer trigger', () => {
    const sql = expectHistoryCaptureMigration(
      '100_subscription_status_history.sql',
      'subscription_status_history',
      'capture_subscription_status_history',
      'subscriptions',
    );
    expect(sql).toContain('AFTER UPDATE OF status, plan_code, cancel_at_period_end ON public.subscriptions');
    expect(sql).toContain('OLD.status IS DISTINCT FROM NEW.status');
    expect(sql).toContain('OLD.plan_code IS DISTINCT FROM NEW.plan_code');
    expect(sql).toContain('OLD.cancel_at_period_end IS DISTINCT FROM NEW.cancel_at_period_end');
    // Terminal subscriptions backfill at updated_at so a cancellation is not
    // dated to the day the subscription started.
    expect(sql).toContain("WHEN s.status IN ('canceled', 'incomplete_expired') THEN s.updated_at ELSE s.created_at");
  });

  it('101 records phone-code challenge history without copying phone hashes', () => {
    const sql = expectHistoryCaptureMigration(
      '101_worker_identity_challenge_events.sql',
      'worker_identity_challenge_events',
      'capture_worker_identity_challenge_event',
      'worker_identity_challenges',
    );
    expect(sql).toContain('AFTER UPDATE OF status, attempts, locked_until ON public.worker_identity_challenges');
    expect(sql).toContain('OLD.attempts IS DISTINCT FROM NEW.attempts');
    expect(sql).toContain('OLD.locked_until IS DISTINCT FROM NEW.locked_until');
    // The unsalted phone hash stays only in the source table.
    const tableDef = sql.match(/CREATE TABLE public\.worker_identity_challenge_events \([\s\S]*?\n\);/)?.[0] ?? '';
    expect(tableDef).not.toBe('');
    expect(tableDef).not.toMatch(/phone_hash/);
    expect(sql).not.toMatch(/NEW\.phone_hash|c\.phone_hash/);
  });

  // Roadmap 1b: the lockout list is one gated definer plus an invoker masking
  // helper. On RDS there is no Jest, so the migration's own DO block is the
  // only runtime check; these literals pin that it exists and stays strict.
  it('102 lists phone-code lockouts through one gated definer without exposing phone hashes', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '102_admin_identity_lockouts.sql'), 'utf8');

    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);

    // CREATE POLICY locks whatsapp_conversations; fail fast rather than queue
    // every inbound message behind a stuck transaction (099–101's pattern).
    const iBegin = sql.indexOf('BEGIN;');
    const iLock = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const iPolicy = sql.indexOf('CREATE POLICY');
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iPolicy).toBeGreaterThan(iLock);

    // One definer (the list) and one invoker helper (masking); both pinned.
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(1);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(2);
    expect(sql).toContain('ALTER FUNCTION public.admin_identity_lockouts(INTEGER) OWNER TO jale_admin;');
    expect(sql).toContain('ALTER FUNCTION public.admin_mask_phone(TEXT) OWNER TO jale_admin;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.admin_identity_lockouts(INTEGER) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.admin_mask_phone(TEXT) FROM PUBLIC;');
    // The list's EXECUTE grant is the only statement naming the console role.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(1);
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.admin_identity_lockouts(INTEGER) TO jale_admin_console;');
    expect(sql).not.toMatch(/GRANT\s+SELECT/);

    // The window is validated BEFORE the gate opens, so a rejected call never
    // flips it (a runtime check cannot see this: the exception's rollback
    // would undo the flag either way).
    const iRaise = sql.indexOf("RAISE EXCEPTION 'admin_identity_lockouts_invalid_days'");
    const iGate = sql.indexOf("PERFORM set_config('app.admin_analytics_read', 'on', true);");
    expect(iRaise).toBeGreaterThan(0);
    expect(iGate).toBeGreaterThan(iRaise);
    expect(sql.match(/PERFORM set_config\('app\.admin_analytics_read', 'on', true\);/g)).toHaveLength(1);

    // Lockouts come from 101's history; the phone from the conversation hash.
    expect(sql).toContain('FROM public.worker_identity_challenge_events e');
    expect(sql).toContain("e.to_status = 'locked'");
    expect(sql).toContain("encode(sha256(convert_to(btrim(w.whatsapp_number), 'UTF8')), 'hex')");

    // What happened next lives on newer same-phone challenges (expired rows
    // are never reused).
    expect(sql).toContain('(n.created_at, n.id) > (c.created_at, c.id)');
    expect(sql).toContain("OR p.newer_verified THEN 'verified'");
    expect(sql).toContain('AND NOT nw.newer_progressed');
    // Only newer rows that reached the code step count, and only a recent
    // code or lock is a live retry.
    expect(sql).toContain("n.current_step_key = 'identity.verify_otp'");
    expect(sql).toContain('WHEN p.newer_live THEN');
    // Exactly the owner and the console may execute the list; the order is stable.
    expect(sql.match(/aclexplode\(/g)).toHaveLength(2);
    expect(sql).toContain('COALESCE(p.last_at, p.updated_at) DESC, p.id;');

    // Exactly one new policy: 089's gated read on whatsapp_conversations.
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(sql).toMatch(
      /CREATE POLICY whatsapp_conversations_admin_analytics_read\s+ON public\.whatsapp_conversations FOR SELECT\s+TO jale_admin\s+USING \(current_setting\('app\.admin_analytics_read', true\) = 'on'\);/,
    );

    // The result never carries the hash, user ids, the Cognito session,
    // context, or the raw number.
    const resultDef = sql.match(/CREATE FUNCTION public\.admin_identity_lockouts[\s\S]*?\)\nLANGUAGE plpgsql/)?.[0] ?? '';
    expect(resultDef).not.toBe('');
    expect(resultDef).not.toMatch(/phone_hash|user_id|provider_challenge_id|context|whatsapp_number/);

    // Self-check: fail closed on drifted policies, masking format, and the gate.
    expect(sql).toContain('missing or drifted; the lockout list would read zero challenges');
    expect(sql).toContain('missing or drifted; the lockout list would read zero lockouts');
    expect(sql).toContain("public.admin_mask_phone('+526641234567') IS DISTINCT FROM '+52 664 *** 4567'");
    expect(sql).toContain('migration 102: admin_identity_lockouts did not set the read flag');

    // Forward-only.
    expect(sql).not.toMatch(/DROP (FUNCTION|TABLE|TRIGGER|POLICY)/);
  });

  // Roadmap 2a: the onboarding funnel is four gated definers -- two new, two
  // recreated with one extra verified column. On RDS the migration's own DO
  // block is the only runtime check; these literals pin that it stays strict.
  it('113 adds the onboarding funnel definers without exposing workers', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '113_admin_onboarding_funnel.sql'), 'utf8');

    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);

    // Four definers, each hardened per 089/098.
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(4);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(4);
    expect(sql.match(/PERFORM set_config\('app\.admin_analytics_read', 'on', true\);/g)).toHaveLength(4);
    expect(sql.match(/OWNER TO jale_admin;/g)).toHaveLength(4);
    expect(sql.match(/REVOKE ALL ON FUNCTION public\.admin_analytics_\w+\([^)]*\) FROM PUBLIC;/g)).toHaveLength(4);
    expect(sql.match(/GRANT EXECUTE ON FUNCTION public\.admin_analytics_\w+\([^)]*\) TO jale_admin_console;/g)).toHaveLength(4);
    // The four EXECUTE grants are the only statements naming the console role.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(4);

    // Only the two return-type changes drop anything; nothing new is opened.
    expect(sql.match(/DROP FUNCTION/g)).toHaveLength(2);
    expect(sql).toContain('DROP FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT);');
    expect(sql).toContain('DROP FUNCTION public.admin_analytics_totals();');
    expect(sql).not.toMatch(/CREATE POLICY|CREATE INDEX|GRANT\s+SELECT/);

    // Each new function validates its input before the gate opens.
    for (const [fn, error] of [
      ['admin_analytics_onboarding_cohorts', 'admin_analytics_invalid_weeks'],
      ['admin_analytics_onboarding_stalled', 'admin_analytics_invalid_days'],
      ['admin_analytics_signups', 'admin_analytics_invalid_bucket'],
    ]) {
      const body = sql.match(new RegExp(`CREATE FUNCTION public\\.${fn}[\\s\\S]*?\\nEND \\$\\$;`))?.[0] ?? '';
      expect(body).not.toBe('');
      const iRaise = body.indexOf(`RAISE EXCEPTION '${error}'`);
      const iGate = body.indexOf("PERFORM set_config('app.admin_analytics_read', 'on', true);");
      expect(iRaise).toBeGreaterThan(0);
      expect(iGate).toBeGreaterThan(iRaise);
    }

    // Results carry counts and step keys only -- never a person.
    for (const fn of ['admin_analytics_onboarding_cohorts', 'admin_analytics_onboarding_stalled']) {
      const result = sql.match(new RegExp(`CREATE FUNCTION public\\.${fn}[\\s\\S]*?\\)\\nLANGUAGE plpgsql`))?.[0] ?? '';
      expect(result).not.toBe('');
      expect(result).not.toMatch(/phone|user_id|whatsapp_number|cognito/);
    }

    // The funnel definitions the spec pins.
    expect(sql).toContain("t.reason IN ('otp_verified', 'web_start')");
    expect(sql).toContain("t.reason = 'web_worker_bypass'");
    expect(sql).toContain('WHERE NOT a.dry_run');
    expect(sql).toContain("('trust.question.1', 13)");
    expect(sql).toContain("encode(sha256(convert_to(btrim(w.whatsapp_number), 'UTF8')), 'hex')");
    expect(sql).toMatch(/worker_signups_verified\s+BIGINT/);
    expect(sql).toMatch(/total_verified_workers\s+BIGINT/);

    // One person per human: an unlinked conversation joins the worker
    // account with the same phone (conversation-router.ts's rule).
    expect(sql).toContain('COALESCE(w.user_id, pm.id) AS user_id');
    expect(sql).toContain('ORDER BY CASE WHEN u.whatsapp_number = btrim(w.whatsapp_number) THEN 0 ELSE 1 END, u.created_at, u.id');
    // A number keeps one conversation row forever: one first written before
    // the launch week starts at its first challenge since then, and with none
    // it has no start at all (a returning pre-v2 contact is not a starter).
    expect(sql).toContain('CASE WHEN w.created_at >= v_launch_week THEN w.created_at ELSE fc.first_at END AS started_at');
    expect(sql).toContain('AND ch.created_at >= v_launch_week');
    expect(sql).toContain(') fc ON w.created_at < v_launch_week');
    // The stalled door is classified by presence: the creating transition and
    // a Terms skip share created_at, so ordering would be a coin flip.
    expect(sql).toContain("CASE WHEN bool_or(t.reason = 'otp_verified') THEN 'whatsapp'");
    expect(sql).toContain('WHERE p.last_progress <= now() - make_interval(days => p_days)');
    // Week arithmetic is TimeZone-independent; an empty database still plans the query.
    expect(sql).toContain("(date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC'");
    expect(sql).toContain("COALESCE(date_trunc('week', v_launch, 'UTC'), 'infinity'::TIMESTAMPTZ)");

    // Self-check: the seven policies it reads through, ACLs, exact result
    // shapes, the gate for every function, and input errors.
    expect(sql).toContain('missing or drifted; the funnel would read zero rows');
    for (const tuple of [
      "('public.worker_onboarding_state', 'worker_onboarding_state_definer', '*', 'true')",
      "('public.worker_workflow_runs', 'worker_workflow_runs_definer', '*', 'true')",
      "('public.worker_workflow_transitions', 'worker_workflow_transitions_definer', '*', 'true')",
      "('public.worker_identity_challenges', 'worker_identity_challenges_definer', '*', 'true')",
      "('public.worker_reset_audit', 'worker_reset_audit_admin_read', 'r', 'true')",
      "('public.users', 'users_admin_analytics_read', 'r', v_gate)",
      "('public.whatsapp_conversations', 'whatsapp_conversations_admin_analytics_read', 'r', v_gate)",
    ]) {
      expect(sql).toContain(tuple);
    }
    for (const fn of [
      'admin_analytics_onboarding_cohorts',
      'admin_analytics_onboarding_stalled',
      'admin_analytics_signups',
      'admin_analytics_totals',
    ]) {
      expect(sql).toContain(`migration 113: ${fn} did not set the read flag`);
    }
    expect(sql).toContain('migration 113: admin_analytics_signups result drifted');
    expect(sql).toContain('migration 113: admin_analytics_totals result drifted');
    expect(sql.match(/aclexplode\(/g)).toHaveLength(1);
    // A NULL proconfig (no pinned search_path) must fail the check, not skip it.
    expect(sql).toContain("NOT COALESCE(fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)");
  });

  // Roadmap 2b: employer health is three gated definers plus the one gated
  // read policy job_conversations was missing. On RDS the migration's own DO
  // block is the only runtime check; these literals pin that it stays strict.
  it('114 adds the employer health definers and the job_conversations gate without exposing people', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '114_admin_employer_health.sql'), 'utf8');
    // The code without comments, for what it may never read or return.
    const code = sql.replace(/--[^\n]*/g, '');

    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);

    // Exactly one new policy, 089's gate on job_conversations, created after
    // the lock timeout (099/102's pattern). Nothing else is opened or dropped.
    const iBegin = sql.indexOf('BEGIN;');
    const iLock = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const iPolicy = sql.indexOf('CREATE POLICY');
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iPolicy).toBeGreaterThan(iLock);
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(sql).toMatch(
      /CREATE POLICY job_conversations_admin_analytics_read\s+ON public\.job_conversations FOR SELECT\s+TO jale_admin\s+USING \(current_setting\('app\.admin_analytics_read', true\) = 'on'\);/,
    );
    expect(sql).not.toMatch(/CREATE INDEX|GRANT\s+SELECT|ALTER TABLE|DROP (FUNCTION|TABLE|TRIGGER|POLICY|INDEX)/);

    // Three definers with the signatures the console calls, each hardened per 089/098.
    for (const signature of [
      'admin_analytics_employer_weekly(p_weeks INTEGER)',
      'admin_analytics_slowest_employers(p_weeks INTEGER, p_limit INTEGER DEFAULT 10)',
      'admin_analytics_stale_jobs(p_days INTEGER DEFAULT 14)',
    ]) {
      expect(sql).toContain(`CREATE FUNCTION public.${signature}\nRETURNS TABLE (`);
    }
    expect(sql.match(/^CREATE FUNCTION/gm)).toHaveLength(3);
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(3);
    expect(sql.match(/^SET search_path = pg_catalog, pg_temp$/gm)).toHaveLength(3);
    expect(sql.match(/PERFORM set_config\('app\.admin_analytics_read', 'on', true\);/g)).toHaveLength(3);
    for (const fn of [
      'admin_analytics_employer_weekly(INTEGER)',
      'admin_analytics_slowest_employers(INTEGER, INTEGER)',
      'admin_analytics_stale_jobs(INTEGER)',
    ]) {
      expect(sql).toContain(`ALTER FUNCTION public.${fn} OWNER TO jale_admin;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO jale_admin_console;`);
    }
    // The three EXECUTE grants are the only statements naming the console role.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(3);

    // Each function validates every input before the gate opens.
    for (const [fn, errors] of [
      ['admin_analytics_employer_weekly', ['admin_analytics_invalid_weeks']],
      ['admin_analytics_slowest_employers', ['admin_analytics_invalid_weeks', 'admin_analytics_invalid_limit']],
      ['admin_analytics_stale_jobs', ['admin_analytics_invalid_days']],
    ] as const) {
      const body = sql.match(new RegExp(`CREATE FUNCTION public\\.${fn}[\\s\\S]*?\\nEND \\$\\$;`))?.[0] ?? '';
      expect(body).not.toBe('');
      const iGate = body.indexOf("PERFORM set_config('app.admin_analytics_read', 'on', true);");
      for (const error of errors) {
        const iRaise = body.indexOf(`RAISE EXCEPTION '${error}'`);
        expect(iRaise).toBeGreaterThan(0);
        expect(iGate).toBeGreaterThan(iRaise);
      }

      // Results carry counts, durations, week starts, job and employer ids,
      // titles and business names only -- never a person.
      const result = sql.match(new RegExp(`CREATE FUNCTION public\\.${fn}[\\s\\S]*?\\)\\nLANGUAGE plpgsql`))?.[0] ?? '';
      expect(result).not.toBe('');
      expect(result).not.toMatch(/full_name|email|phone|worker_id|application_id|body|cognito/);
    }
    expect(sql.match(/IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN/g)).toHaveLength(2);
    expect(sql).toContain('IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN');
    expect(sql).toContain('IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN');
    // The honest denominators sit right after the counts they divide.
    expect(sql).toMatch(/unanswered_7d\s+BIGINT,\n\s+applications_due\s+BIGINT,\n\s+first_response_p50_hours\s+NUMERIC,/);
    expect(sql).toMatch(/turns_unanswered_7d\s+BIGINT,\n\s+turns_due\s+BIGINT,\n\s+reply_p50_hours\s+NUMERIC,/);
    expect(code).toContain("count(*) FILTER (WHERE f.applied_at <= now() - interval '7 days') AS n_due");
    expect(code).toContain("count(*) FILTER (WHERE t.turn_at <= now() - interval '7 days') AS n_due");

    // Names come only from employer_display_name(); the email column appears
    // only in the test-account filter, which is NULL-safe (most employers
    // have no email) and used in WHERE, never selected.
    expect(code).not.toMatch(/full_name|phone|\.body\b|worker_id/);
    expect(code.match(/public\.employer_display_name\([rs]\.emp\)/g)).toHaveLength(2);
    expect(code.match(/email/g)).toHaveLength(3);
    expect(code.match(/AND NOT COALESCE\(u\.email LIKE '%@jale\.test' OR u\.cognito_sub LIKE 'seed-%', false\)/g)).toHaveLength(3);

    // The employer action set, the same in all three functions, found by
    // per-application LATERAL index lookups (a join to an all-time aggregate
    // became a quadratic nested loop), and nothing that worker activity,
    // triggers, Twilio or an open thread can move.
    expect(code).not.toMatch(/GROUP BY x\.application_id|FROM actions/);
    expect(code.match(/LEFT JOIN LATERAL \(/g)).toHaveLength(4);
    expect(code.match(/WHERE c\.application_id = ap\.id\n {15}AND m\.sender_type = 'employer'\n {12}UNION ALL\n {12}SELECT ap\.details_requested_at\n {12}UNION ALL\n {12}SELECT ap\.hired_at WHERE NOT ap\.hire_approx\n/g)).toHaveLength(2);
    expect(code).toContain("WHERE c.application_id = a.id\n               AND m.sender_type = 'employer'\n            UNION ALL\n            SELECT a.details_requested_at\n");
    expect(code.match(/WHERE ev\.application_id = (ap|a)\.id\n {15}AND NOT ev\.is_backfill\n {15}AND ev\.to_status IN \('contacted', 'details_requested', 'hired', 'not_interested'\)/g)).toHaveLength(3);
    // A 095-backfilled hire time (hired_at = hired_seen_at = hired_ack_at) is
    // not an action time; the hire still counts, flagged approximate.
    expect(code.match(/COALESCE\(a\.hired_at = a\.hired_seen_at AND a\.hired_at = a\.hired_ack_at, false\)/g)).toHaveLength(4);
    expect(code).toContain('SELECT a.hired_at WHERE NOT COALESCE(a.hired_at = a.hired_seen_at AND a.hired_at = a.hired_ack_at, false)');
    expect(code).toContain('COALESCE(a.hired_at = a.hired_seen_at AND a.hired_at = a.hired_ack_at, false) AS approx');
    expect(code).not.toMatch(/updated_at|last_message_at|last_worker_message_at|closed_at|accepted_at|sent_at|delivered_at|employer_last_read_at/);

    // First response: the earliest action; any status but pending is answered.
    expect(code.match(/SELECT min\(x\.at\) AS first_at/g)).toHaveLength(2);
    expect(code).toContain("count(*) FILTER (WHERE f.first_at IS NOT NULL OR f.status <> 'pending') AS n_answered");
    expect(code).toContain("count(*) FILTER (WHERE f.first_at IS NULL AND f.status <> 'pending') AS n_untimed");
    // Turns: system rows ignored, (created_at, id) order for both the turn
    // start and its reply, closed-before-reply left out.
    expect(code).toContain("WHERE m.sender_type <> 'system'");
    expect(code).toContain('lag(m.sender_type) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_sender');
    expect(code).toContain('AND (m.created_at, m.id) > (t.created_at, t.id)');
    expect(code).toContain("AND t.prev_sender IS DISTINCT FROM 'worker'");
    expect(code).toContain("WHERE t.reply_at IS NOT NULL OR t.conv_status <> 'closed'");

    // Weeks: a TimeZone-independent window, and each row set grouped by its
    // own UTC Monday (application, turn, hire), each with its own GROUPING
    // SETS joined to every week (NULL = the whole window).
    expect(code.match(/v_from := \(date_trunc\('week', now\(\) AT TIME ZONE 'UTC'\) - make_interval\(weeks => p_weeks - 1\)\) AT TIME ZONE 'UTC';/g)).toHaveLength(2);
    expect(code).toContain('FROM generate_series(0, p_weeks - 1) AS g(n)');
    for (const key of ['ap.applied_at', 't.created_at', 'a.hired_at']) {
      expect(code).toContain(`date_trunc('week', ${key}, 'UTC') AS wk`);
    }
    expect(code.match(/GROUP BY GROUPING SETS \(\([fth]\.wk\), \(\)\)/g)).toHaveLength(3);
    expect(code.match(/LEFT JOIN (fr|rt|hr) ON \1\.wk IS NOT DISTINCT FROM w\.wk/g)).toHaveLength(3);
    expect(code).toContain('CASE WHEN w.wk IS NULL THEN (');
    // Slowest: 3+ applications, the spec's order (no timed answer last), the limit applied last.
    expect(code).toContain('HAVING count(*) >= 3');
    expect(code).toContain('ORDER BY r.n_unanswered DESC, r.p50 DESC NULLS LAST, r.emp\n   LIMIT p_limit;');
    // Stale: posting is the first action, idle time in whole days, p_days inclusive.
    expect(code).toContain('greatest(l.created_at, max(la.last_at)) AS last_at');
    expect(code).toContain('floor(extract(epoch FROM now() - i.last_at) / 86400)::INTEGER AS idle_days');
    expect(code).toContain('WHERE s.idle_days >= p_days\n   ORDER BY s.idle_days DESC, s.id;');

    // Self-check: the six policies it reads through, no restrictive policy,
    // the name helper's grant, the new policy, ACLs, the gate for every
    // function, and input errors.
    expect(sql).toContain('missing or drifted; the employer health page would read zero rows');
    for (const tuple of [
      "('public.users', 'users_admin_analytics_read', 'r', v_gate)",
      "('public.jobs', 'jobs_admin_analytics_read', 'r', v_gate)",
      "('public.job_applications', 'job_applications_admin_analytics_read', 'r', v_gate)",
      "('public.job_conversation_messages', 'job_conversation_messages_admin_analytics_read', 'r', v_gate)",
      "('public.job_application_status_events', 'job_application_status_events_admin_analytics_read', 'r', v_gate)",
      "('public.employer_profiles', 'employer_profiles_name_lookup', 'r', v_name)",
    ]) {
      expect(sql).toContain(tuple);
    }
    expect(sql).toContain("v_name CONSTANT TEXT := $q$(current_setting('app.employer_name_lookup'::text, true) = 'on'::text)$q$;");
    expect(code).toContain('AND NOT p.polpermissive');
    expect(code).toContain("AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles))");
    for (const table of ['users', 'jobs', 'job_applications', 'job_conversations', 'job_conversation_messages', 'job_application_status_events', 'employer_profiles']) {
      expect(code).toContain(`'public.${table}'::regclass`);
    }
    expect(sql).toContain('migration 114: a restrictive policy for jale_admin or PUBLIC');
    expect(code).toContain("IF NOT has_function_privilege('jale_admin', 'public.employer_display_name(uuid)', 'EXECUTE') THEN");
    expect(sql).toContain('migration 114: policy job_conversations_admin_analytics_read missing or drifted');
    for (const fn of ['admin_analytics_employer_weekly', 'admin_analytics_slowest_employers', 'admin_analytics_stale_jobs']) {
      expect(sql).toContain(`migration 114: ${fn} did not set the read flag`);
    }
    expect(sql.match(/aclexplode\(/g)).toHaveLength(1);
    // A NULL proconfig (no pinned search_path) must fail the check, not skip it.
    expect(sql).toContain("NOT COALESCE(fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)");
    expect(sql).toContain('FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP');
    expect(sql).toContain('FOREACH v_arg IN ARRAY ARRAY[0, 101] LOOP');
    expect(sql).toContain('FOREACH v_arg IN ARRAY ARRAY[0, 366] LOOP');
  });

  // Roadmap 2c: ops health is one column the AI writer fills, four gated
  // read policies and six gated definers. On RDS the migration's own DO
  // blocks are the only runtime check; these literals pin that they stay strict.
  it('115 adds the ops health definers, the failure cause and four gated reads without exposing people or messages', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '115_admin_ops_health.sql'), 'utf8');
    // The code without comments, for what it may never read or return.
    const code = sql.replace(/--[^\n]*/g, '');

    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);

    // Lock timeout first, then the preconditions, then the one column, then
    // exactly four policies -- 089's gate, verbatim, SELECT-only, jale_admin.
    const iBegin = sql.indexOf('BEGIN;');
    const iLock = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const iPre = sql.indexOf('DO $$');
    const iAlter = sql.indexOf('ALTER TABLE');
    const iPolicy = sql.indexOf('CREATE POLICY');
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iPre).toBeGreaterThan(iLock);
    expect(iAlter).toBeGreaterThan(iPre);
    expect(iPolicy).toBeGreaterThan(iAlter);
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(4);
    for (const table of ['job_message_outbox', 'worker_profile_ai_extractions', 'worker_trust_extractions', 'billing_webhook_events']) {
      expect(sql).toMatch(new RegExp(
        `CREATE POLICY ${table}_admin_analytics_read\\s+ON public\\.${table} FOR SELECT\\s+TO jale_admin\\s+`
        + `USING \\(current_setting\\('app\\.admin_analytics_read', true\\) = 'on'\\);`,
      ));
    }
    // No policy on whatsapp_outbox: its owner reads it (ENABLE, not FORCE).
    expect(sql).not.toMatch(/CREATE POLICY \w+\s+ON public\.whatsapp_outbox/);
    expect(sql).not.toMatch(/CREATE INDEX|GRANT\s+(SELECT|INSERT|UPDATE|ALL)|DROP (FUNCTION|TABLE|TRIGGER|POLICY|INDEX|COLUMN|CONSTRAINT)|FORCE ROW LEVEL SECURITY;/);

    // The one column the AI writer fills: nullable, no default, its CHECK verbatim.
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(sql).toContain(
      'ALTER TABLE public.worker_profile_ai_extractions\n'
      + '  ADD COLUMN failure_kind TEXT,\n'
      + '  ADD CONSTRAINT worker_profile_ai_extractions_failure_kind_check CHECK (\n'
      + '    failure_kind IS NULL OR (\n'
      + "      status = 'failed' AND failure_kind IN ('transcribe', 'empty_transcript',\n"
      + "        'audio_read', 'model_call', 'bad_json', 'bad_shape', 'pipeline_error')));\n",
    );

    // Six definers with the signatures the console calls, each hardened per 089/098.
    const fns = [
      ['admin_analytics_message_backlog', '()', '()'],
      ['admin_analytics_message_failures', '(p_weeks INTEGER)', '(INTEGER)'],
      ['admin_analytics_voice_extraction', '(p_weeks INTEGER)', '(INTEGER)'],
      ['admin_analytics_trust_extraction', '(p_weeks INTEGER)', '(INTEGER)'],
      ['admin_analytics_billing_inbox', '(p_weeks INTEGER)', '(INTEGER)'],
      ['admin_analytics_billing_inbox_now', '()', '()'],
    ] as const;
    for (const [fn, params, args] of fns) {
      expect(sql).toContain(`CREATE FUNCTION public.${fn}${params}\nRETURNS TABLE (`);
      expect(sql).toContain(`ALTER FUNCTION public.${fn}${args} OWNER TO jale_admin;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}${args} FROM PUBLIC;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}${args} TO jale_admin_console;`);
    }
    expect(sql.match(/^CREATE FUNCTION/gm)).toHaveLength(6);
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(6);
    expect(sql.match(/^SET search_path = pg_catalog, pg_temp$/gm)).toHaveLength(6);
    expect(sql.match(/PERFORM set_config\('app\.admin_analytics_read', 'on', true\);/g)).toHaveLength(6);
    // The six EXECUTE grants are the only statements naming the console role.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(6);

    // Results carry counts, shares, week starts, lane ids, model ids,
    // extractor versions, event types and listed timestamps only.
    const never = /whatsapp_number|\bbody\b|content_variables|content_template|last_error|twilio_error_message|twilio_message_sid|inbound_message_sid|source_id|idempotency_key|conversation_id|message_id|transcript_text|extracted_fields|confidence_scores|user_id|assessment_id|summary_en|summary_es|\berror\b|stripe_event_id|stripe_object_id|last_error_code/;
    for (const [fn] of fns) {
      const body = sql.match(new RegExp(`CREATE FUNCTION public\\.${fn}\\([\\s\\S]*?\\nEND \\$\\$;`))?.[0] ?? '';
      expect(body).not.toBe('');
      const result = body.match(/RETURNS TABLE \(([\s\S]*?)\)\nLANGUAGE plpgsql/)?.[1] ?? '';
      expect(result).not.toBe('');
      expect(result).not.toMatch(never);
      // The gate opens before the query, and after every input check.
      const iGate = body.indexOf("PERFORM set_config('app.admin_analytics_read', 'on', true);");
      expect(iGate).toBeGreaterThan(0);
      expect(iGate).toBeLessThan(body.indexOf('RETURN QUERY'));
      const iRaise = body.indexOf("RAISE EXCEPTION 'admin_analytics_invalid_weeks'");
      if (fn === 'admin_analytics_message_backlog' || fn === 'admin_analytics_billing_inbox_now') {
        expect(iRaise).toBe(-1);
        expect(body).toContain("BEGIN\n  -- No arguments to validate.\n  PERFORM set_config('app.admin_analytics_read', 'on', true);");
      } else {
        expect(iRaise).toBeGreaterThan(0);
        expect(iGate).toBeGreaterThan(iRaise);
      }
    }
    expect(sql.match(/IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN/g)).toHaveLength(4);
    // Nothing personal is read at all, except the voice JSON, which leaves
    // only as found-field names and a main_trade = 'other' flag.
    expect(code).not.toMatch(/whatsapp_number|\.body\b|content_variables|content_template|last_error|twilio_error|twilio_message_sid|inbound_message_sid|source_id|idempotency_key|conversation_id|message_id|transcript_text|user_id|assessment_id|summary_e[ns]|\.error\b|stripe_event_id|stripe_object_id/);
    expect(code.match(/extracted_fields/g)).toHaveLength(2);
    expect(code.match(/confidence_scores/g)).toHaveLength(2);
    expect(code).toContain('x.extracted_fields AS f,\n           x.confidence_scores AS c,');
    expect(code).toContain("s.f ->> 'main_trade' = 'other' AS other_trade");
    expect(code).toContain('ARRAY(\n             SELECT k.name\n');
    expect(code.match(/t\.extracted\b/g)).toHaveLength(2);

    // Weeks: a TimeZone-independent window, every row set grouped by its own
    // UTC Monday, every week zero-filled.
    expect(code.match(/v_from := \(date_trunc\('week', now\(\) AT TIME ZONE 'UTC'\) - make_interval\(weeks => p_weeks - 1\)\) AT TIME ZONE 'UTC';/g)).toHaveLength(4);
    expect(code.match(/FROM generate_series\(0, p_weeks - 1\) AS g\(n\)/g)).toHaveLength(4);
    for (const key of ['o.created_at', 'x.created_at', 't.created_at', 'b.received_at']) {
      expect(code).toContain(`date_trunc('week', ${key}, 'UTC') AS wk`);
    }
    expect(code).toContain("SELECT date_trunc('week', m.created_at, 'UTC'),");
    expect(code.match(/date_trunc\('week', [a-z]\.(created|received)_at\)/g)).toBeNull();

    // Lanes, in display order, and their retry windows.
    expect(code).toContain(
      "VALUES ('reply',               1, interval '30 minutes', true),\n"
      + "           ('admin',               2, interval '10 minutes', true),\n"
      + "           ('worker_notification', 3, interval '24 hours',   true),\n"
      + "           ('employer_invite',     4, interval '30 minutes', true),\n"
      + "           ('employer_freeform',   5, interval '30 minutes', true),\n"
      + "           ('job_alert',           6, interval '30 minutes', false)",
    );
    expect(code).toContain(
      "VALUES ('reply', 1, true), ('admin', 2, true), ('worker_notification', 3, true),\n"
      + "           ('employer_invite', 4, true), ('employer_freeform', 5, true), ('job_alert', 6, false)",
    );
    expect(code.match(/CASE WHEN o\.source_type IS NULL THEN 'reply'\n {16}WHEN o\.source_type = 'admin_case' THEN 'admin'\n {16}WHEN o\.source_type = 'worker_intent' THEN 'worker_notification'\n {16}WHEN o\.source_type = 'job_alert' THEN 'job_alert'\n/g)).toHaveLength(2);
    expect(code.match(/CASE m\.send_kind WHEN 'template' THEN 'employer_invite' WHEN 'freeform' THEN 'employer_freeform' END/g)).toHaveLength(2);
    // No lane CASE falls through: an unknown source maps to no lane and is
    // dropped before grouping (it could otherwise add a second all-lanes row).
    expect(code).not.toMatch(/ELSE '(reply|admin|worker_notification|employer_invite|employer_freeform|job_alert)'/);
    expect(code.match(/WHERE x\.lane_id IS NOT NULL\n/g)).toHaveLength(2);
    // Open = still being retried and created less than 48 h ago; a failed
    // worker notification is never retried (093's 48-hour ceiling).
    expect(code).toContain(
      "WHERE o.created_at > now() - interval '48 hours'\n"
      + "       AND (o.status = 'pending'\n"
      + "            OR (o.status = 'failed' AND o.attempt_count < 5\n"
      + "                AND o.source_type IS DISTINCT FROM 'worker_intent')\n"
      + "            OR (o.status = 'send_unknown' AND o.source_type IS NOT DISTINCT FROM 'worker_intent'\n"
      + '                AND COALESCE(o.worker_intent_leased_until > now(), false)))',
    );
    expect(code).toContain(
      "WHERE m.created_at > now() - interval '48 hours'\n"
      + "       AND (m.status = 'pending'\n"
      + "            OR (m.status = 'failed' AND m.attempt_count < 5 AND m.sent_at IS NULL))",
    );
    expect(code).toContain("count(*) FILTER (WHERE x.created_at > now() - interval '1 hour') AS n_under_1h");
    expect(code).toContain("count(*) FILTER (WHERE x.created_at <= now() - interval '24 hours') AS n_24_48h");
    expect(code).toContain('count(*) FILTER (WHERE x.created_at < now() - l.retry) AS n_stuck');
    expect(code).toContain('min(x.created_at) FILTER (WHERE x.created_at < now() - l.retry) AS oldest_stuck');
    expect(code).toContain('WHERE l.always_shown OR a.lane_id IS NOT NULL');
    // Failures: the same "still being retried" rule; gave up = unsent and
    // not open; delivery failures are disjoint from both.
    expect(code).toContain(
      "o.status IN ('pending', 'failed', 'send_unknown') AS is_unsent,\n"
      + "           o.status = 'pending'\n"
      + "             OR (o.status = 'failed' AND o.attempt_count < 5\n"
      + "                 AND o.source_type IS DISTINCT FROM 'worker_intent')\n"
      + "             OR (o.status = 'send_unknown' AND o.source_type IS NOT DISTINCT FROM 'worker_intent'\n"
      + '                 AND COALESCE(o.worker_intent_leased_until > now(), false)) AS is_retrying,',
    );
    expect(code).toContain("o.status = 'sent' AND COALESCE(o.twilio_delivery_status IN ('failed', 'undelivered'), false) AS is_delivery_failed");
    expect(code).toContain(
      "m.status IN ('pending', 'send_unknown') OR (m.status = 'failed' AND m.sent_at IS NULL),\n"
      + "           m.status = 'pending' OR (m.status = 'failed' AND m.attempt_count < 5 AND m.sent_at IS NULL),\n"
      + "           m.status = 'failed' AND m.sent_at IS NOT NULL\n",
    );
    expect(code).toContain(
      'count(*) FILTER (WHERE x.is_unsent\n'
      + "                              AND NOT (x.is_retrying AND x.created_at > now() - interval '48 hours')) AS n_gave_up",
    );
    // The 48-hour horizon is the messages': backlog (2), failures (1). Billing
    // has its own one-hour boundary (the processor dead-letters an event after
    // about 20 minutes): the backlog's two age edges plus billing right now (4:
    // stuck, failed, the unresolved range's lower edge and the oldest). The
    // billing dead-letter queue keeps a message 14 days, so the 14-day age cap
    // appears once: on the unresolved count.
    expect(code.match(/interval '48 hours'/g)).toHaveLength(3);
    expect(code.match(/interval '1 hour'/g)).toHaveLength(6);
    expect(code.match(/interval '14 days'/g)).toHaveLength(1);
    expect(code).toContain('GROUP BY GROUPING SETS ((x.wk, x.lane_id), (x.lane_id), ())');
    expect(code).toContain("SELECT a.wk, a.lane_id FROM agg a WHERE a.lane_id = 'job_alert'");

    // Voice: test profiles out, every cause, wrong-shape completed rows,
    // the inclusive 0.75 gate on JSON numbers, blank strings not found,
    // main_trade_other only with main_trade = 'other', model attribution.
    expect(code).toContain('AND NOT x.ai_test_profile');
    expect(code).toContain(
      "COALESCE(jsonb_typeof(x.extracted_fields) = 'object'\n"
      + "                    AND jsonb_typeof(x.confidence_scores) = 'object', false) AS is_object",
    );
    expect(code).toContain(
      "CASE WHEN s.status = 'failed' THEN COALESCE(s.failure_kind, 'unrecorded')\n"
      + "                WHEN s.status = 'completed' AND NOT s.is_object THEN 'bad_shape'\n",
    );
    expect(code).toContain(
      "FROM unnest(ARRAY['full_name', 'city', 'main_trade', 'main_trade_other',\n"
      + "                                 'years_experience', 'has_transportation', 'availability']) AS k(name)",
    );
    expect(code).toContain("WHEN 'string' THEN (s.f ->> k.name) ~ '[^[:space:]]'\n                      WHEN 'null' THEN false\n");
    expect(code).toContain(
      "CASE WHEN jsonb_typeof(s.c -> k.name) = 'number'\n"
      + '                      THEN (s.c -> k.name)::NUMERIC >= 0.75\n'
      + '                      ELSE false\n',
    );
    expect(code).toContain("count(*) FILTER (WHERE a.is_usable AND a.other_trade AND 'main_trade_other' = ANY (a.found)) AS n_other");
    expect(code).toContain(
      "CASE WHEN f.is_usable OR f.cause IN ('model_call', 'bad_json', 'bad_shape')\n"
      + '                THEN f.bedrock_model_id END AS model_id',
    );
    expect(code).toContain('GROUPING(a.model_id) = 1 AS every_row');
    expect(code).toContain('GROUP BY GROUPING SETS ((a.wk), (), (a.wk, a.model_id), (a.model_id))');
    for (const cause of ['transcribe', 'empty_transcript', 'audio_read', 'model_call', 'bad_json', 'bad_shape', 'pipeline_error', 'unrecorded']) {
      expect(code).toContain(`count(*) FILTER (WHERE a.cause = '${cause}') AS n_${cause}`);
    }

    // Trust: in-flight rows out; not enough detail = completed without a
    // model; sections = non-empty arrays among the five, averaged over
    // completed rows with a model, one decimal.
    expect(code).toContain("AND t.status IN ('completed', 'failed')");
    expect(code).toContain("FROM unnest(ARRAY['skills', 'tools', 'experience_signals', 'safety', 'notable']) AS k(name)");
    expect(code).toContain("WHERE jsonb_typeof(t.extracted -> k.name) = 'array'\n               AND t.extracted -> k.name <> '[]'::JSONB) AS sections");
    expect(code).toContain("count(*) FILTER (WHERE f.status = 'completed' AND NOT f.with_model) AS n_not_enough");
    expect(code).toContain("round(avg(f.sections) FILTER (WHERE f.status = 'completed' AND f.with_model), 1) AS avg_sections");

    // Billing: weeks by received_at; retried = more than one attempt; stuck
    // = received with no live lease (the processor's re-claim predicate);
    // right now, stuck and failed only within one hour (the processor
    // dead-letters an event after about 20 minutes: 3 SQS receives, 6 minutes
    // apart), those received an hour to 14 days ago unresolved (dead-lettered
    // within the queue's 14-day retention, so they can be redriven; older ones
    // have left the queue), the oldest over the within-one-hour stuck and
    // failed events.
    expect(code).toContain('count(*) FILTER (WHERE f.attempt_count > 1) AS n_retried');
    expect(code).toContain("count(*) FILTER (WHERE f.type = 'invoice.payment_failed') AS n_payment_failed");
    expect(code).toContain(
      "SELECT count(*) FILTER (WHERE b.processing_status = 'received'\n"
      + "                            AND b.received_at > now() - interval '1 hour'),\n"
      + "         count(*) FILTER (WHERE b.processing_status = 'failed'\n"
      + "                            AND b.received_at > now() - interval '1 hour'),\n"
      + "         count(*) FILTER (WHERE b.received_at <= now() - interval '1 hour'\n"
      + "                            AND b.received_at > now() - interval '14 days'),\n"
      + "         min(b.received_at) FILTER (WHERE b.received_at > now() - interval '1 hour')\n"
      + '    FROM public.billing_webhook_events b\n',
    );
    // The comments say so too: no billing comment keeps the 48-hour retry
    // story, each says the processor dead-letters after about 20 minutes, and
    // each says the queue keeps a dead letter 14 days: those can be redriven
    // from the queue, older events must be resent from Stripe.
    const billingComments = [
      sql.match(/-- \(6\) admin_analytics_billing_inbox_now\(\)[\s\S]*?\n--\n/)?.[0] ?? '',
      sql.match(/-- BILLING \(billing_webhook_events\)[\s\S]*?\n--\n/)?.[0] ?? '',
      sql.match(/CREATE FUNCTION public\.admin_analytics_billing_inbox_now\(\)[\s\S]*?\nEND \$\$;/)?.[0] ?? '',
    ];
    for (const comment of billingComments) {
      expect(comment).not.toBe('');
      expect(comment).not.toMatch(/48/);
      const flat = comment.replace(/\s*\n\s*--\s*/g, ' '); // the comment's wrapped lines, joined
      expect(flat).toContain('about 20 minutes');
      expect(flat).toContain('14 days');
      expect(flat).toContain('redriven from the queue');
      expect(flat).toContain('resent from Stripe');
      expect(flat).not.toMatch(/manual redrive/);
    }
    expect(billingComments[2]).toContain('(3 SQS\n  -- receives, 6 minutes apart');
    // whatsapp_outbox does have created_at indexes (004, 027, 040: partial,
    // for pending / failed rows); the full scan comes from the send_unknown
    // branch and the all-status weekly window.
    expect(sql).not.toContain('no created_at index');
    expect(sql).toContain('whatsapp_outbox has only partial created_at indexes');
    expect(code).toContain(
      "WHERE (b.processing_status = 'received'\n"
      + '          AND (b.lease_expires_at IS NULL OR b.lease_expires_at < now()))\n'
      + "      OR b.processing_status = 'failed';",
    );
    expect(code.match(/GROUP BY GROUPING SETS \(\(f\.wk\), \(\), \(f\.wk, f\.(version|type)\), \(f\.\1\)\)/g)).toHaveLength(2);

    // Self-check: whatsapp_outbox stays unforced and owned by jale_admin; no
    // restrictive policy that applies to jale_admin; the writer can insert the cause; the column, its
    // CHECK and the four policies; per function the result shape, owner,
    // definer, pinned search_path, console-only EXECUTE and the gate; bad
    // weeks rejected.
    expect(code).toContain("WHERE c.oid = 'public.whatsapp_outbox'::regclass\n       AND NOT c.relforcerowsecurity\n       AND c.relowner = 'jale_admin'::regrole::oid");
    expect(sql).toContain('migration 115: whatsapp_outbox is FORCE ROW LEVEL SECURITY or not owned by jale_admin');
    // Only a SELECT or ALL policy can hide rows from a read; a RESTRICTIVE
    // INSERT / UPDATE / DELETE policy (043's, for jale_whatsapp) never does.
    expect(code).toContain("AND NOT p.polpermissive\n       AND p.polcmd IN ('r', '*')\n");
    // ... for jale_admin, PUBLIC, or any role whose privileges jale_admin has
    // (has_privs_of_role, the test RLS itself applies).
    expect(code).toContain(
      "AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles)\n"
      + '            OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(role_oid)\n'
      + "                        WHERE r.role_oid <> 0 AND pg_has_role('jale_admin', r.role_oid, 'USAGE')))",
    );
    for (const table of ['whatsapp_outbox', 'job_message_outbox', 'worker_profile_ai_extractions', 'worker_trust_extractions', 'billing_webhook_events']) {
      expect(code).toContain(`'public.${table}'::regclass`);
    }
    expect(sql).toContain('migration 115: a restrictive policy for jale_admin, a role it inherits, or PUBLIC');
    expect(code).toContain("IF NOT has_column_privilege('jale_whatsapp', 'public.worker_profile_ai_extractions', 'failure_kind', 'INSERT') THEN");
    expect(code).toContain("AND a.atttypid = 'text'::regtype\n       AND NOT a.attnotnull\n       AND NOT a.atthasdef");
    expect(sql).toContain("v_check  CONSTANT TEXT := $q$CHECK (((failure_kind IS NULL) OR ((status = 'failed'::text) AND (failure_kind = ANY (ARRAY['transcribe'::text, 'empty_transcript'::text, 'audio_read'::text, 'model_call'::text, 'bad_json'::text, 'bad_shape'::text, 'pipeline_error'::text])))))$q$;");
    expect(code).toContain('AND con.convalidated\n       AND pg_get_constraintdef(con.oid) = v_check');
    expect(sql).toContain("v_gate   CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;");
    for (const table of ['job_message_outbox', 'worker_profile_ai_extractions', 'worker_trust_extractions', 'billing_webhook_events']) {
      expect(sql).toContain(`('public.${table}', '${table}_admin_analytics_read')`);
    }
    expect(code).toContain("AND p.polroles = ARRAY['jale_admin'::regrole::oid]\n         AND pg_get_expr(p.polqual, p.polrelid) = v_gate");
    expect(code.match(/'TABLE\(/g)).toHaveLength(6);
    expect(sql).toContain('result drifted');
    expect(sql.match(/aclexplode\(/g)).toHaveLength(1);
    // A NULL proconfig (no pinned search_path) must fail the check, not skip it.
    expect(sql).toContain("AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)");
    for (const [fn] of fns) {
      expect(sql).toContain(`migration 115: ${fn} did not set the read flag`);
    }
    expect(sql.match(/PERFORM set_config\('app\.admin_analytics_read', '', true\);/g)).toHaveLength(6);
    expect(sql).toContain('FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP');
    expect(sql).toContain("v_raised := SQLERRM = 'admin_analytics_invalid_weeks';");
  });

  // Roadmap 2d: case status timing (one column, two triggers, a one-time
  // backfill), one gated read policy and four gated definers. On RDS the
  // migration's own DO blocks are the only runtime check; these literals pin
  // that they stay strict.
  it('117 adds case status timing, the restart, reset and digest definers and one gated read without exposing people', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '117_admin_queues.sql'), 'utf8');
    // The code without comments, for what it may never read or return.
    const code = sql.replace(/--[^\n]*/g, '');

    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    // The code is ASCII only: the arrow and the mask bullets are U& escapes,
    // so no client encoding can mangle them.
    expect(code).toMatch(/^[\x00-\x7F]*$/);

    // Lock timeout first, then the preconditions, then the column, its
    // backfill, its default and NOT NULL, then the triggers.
    const iBegin = sql.indexOf('BEGIN;');
    const iLock = sql.indexOf("SET LOCAL lock_timeout = '5s';");
    const iPre = sql.indexOf('DO $$');
    const iAdd = sql.indexOf('ALTER TABLE public.admin_cases ADD COLUMN status_changed_at TIMESTAMPTZ;');
    const iFill = sql.indexOf('-- BEGIN status_changed_at backfill');
    const iNotNull = sql.indexOf('  ALTER COLUMN status_changed_at SET NOT NULL;');
    const iTrigger = sql.indexOf('CREATE TRIGGER');
    const iPolicy = sql.indexOf('CREATE POLICY');
    expect(iLock).toBeGreaterThan(iBegin);
    expect(iPre).toBeGreaterThan(iLock);
    expect(iAdd).toBeGreaterThan(iPre);
    expect(iFill).toBeGreaterThan(iAdd);
    expect(iNotNull).toBeGreaterThan(iFill);
    expect(iTrigger).toBeGreaterThan(iNotNull);
    expect(iPolicy).toBeGreaterThan(iLock);

    // Exactly one policy -- 089's gate, verbatim, SELECT-only, jale_admin --
    // and no grant, index, drop or FORCE.
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(sql).toMatch(new RegExp(
      'CREATE POLICY employer_digest_settings_admin_analytics_read\\s+ON public\\.employer_digest_settings FOR SELECT\\s+TO jale_admin\\s+'
      + "USING \\(current_setting\\('app\\.admin_analytics_read', true\\) = 'on'\\);",
    ));
    expect(sql).not.toMatch(/CREATE INDEX|GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)|DROP (FUNCTION|TABLE|TRIGGER|POLICY|INDEX|COLUMN|CONSTRAINT)|FORCE ROW LEVEL SECURITY;/);

    // The column: added bare, backfilled, then DEFAULT now() and NOT NULL.
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(2);
    expect(sql).toContain(
      'ALTER TABLE public.admin_cases\n'
      + '  ALTER COLUMN status_changed_at SET DEFAULT now(),\n'
      + '  ALTER COLUMN status_changed_at SET NOT NULL;\n',
    );
    // The backfill: one statement between the markers (the integration suite
    // runs exactly this text), never earlier than created_at. Its evidence is
    // the case's own timeline: the dashboard action records are append-only
    // audit storage the migration login does not read.
    const backfill = sql.match(/\n-- BEGIN status_changed_at backfill\n([\s\S]*?)-- END status_changed_at backfill\n/)?.[1];
    expect(backfill).toBe(
      'UPDATE public.admin_cases c\n'
      + '   SET status_changed_at = greatest(c.created_at, CASE\n'
      + "         WHEN c.status IN ('resolved', 'dismissed') THEN COALESCE(c.resolved_at, c.created_at)\n"
      + "         WHEN c.status = 'pending_worker' THEN COALESCE((\n"
      + '           SELECT min(e.created_at)\n'
      + '             FROM public.admin_case_events e\n'
      + '            WHERE e.case_id = c.id\n'
      + "              AND e.event_type = 'admin_reply_queued'\n"
      + '         ), c.created_at)\n'
      + '         ELSE c.created_at\n'
      + '       END);\n',
    );

    // Both triggers: timing, UPDATE OF status, FOR EACH ROW, the WHEN clause.
    expect(sql.match(/^CREATE TRIGGER/gm)).toHaveLength(2);
    expect(sql).toContain(
      'CREATE TRIGGER admin_cases_stamp_status_change\n'
      + '  BEFORE UPDATE OF status ON public.admin_cases\n'
      + '  FOR EACH ROW\n'
      + '  WHEN (OLD.status IS DISTINCT FROM NEW.status)\n'
      + '  EXECUTE FUNCTION public.admin_cases_stamp_status_change();\n',
    );
    expect(sql).toContain(
      'CREATE TRIGGER admin_cases_record_status_change\n'
      + '  AFTER UPDATE OF status ON public.admin_cases\n'
      + '  FOR EACH ROW\n'
      + '  WHEN (OLD.status IS DISTINCT FROM NEW.status)\n'
      + '  EXECUTE FUNCTION public.admin_cases_record_status_change();\n',
    );
    // The stamp reads nothing and is no definer; the timeline writer is one,
    // catches nothing, and writes the event verbatim.
    const stamp = sql.match(/CREATE FUNCTION public\.admin_cases_stamp_status_change\(\)[\s\S]*?\nEND \$\$;/)?.[0] ?? '';
    expect(stamp).toBe(
      'CREATE FUNCTION public.admin_cases_stamp_status_change()\n'
      + 'RETURNS TRIGGER\n'
      + 'LANGUAGE plpgsql\n'
      + 'SET search_path = pg_catalog, pg_temp\n'
      + 'AS $$\n'
      + 'BEGIN\n'
      + '  NEW.status_changed_at := now();\n'
      + '  RETURN NEW;\n'
      + 'END $$;',
    );
    const record = sql.match(/CREATE FUNCTION public\.admin_cases_record_status_change\(\)[\s\S]*?\nEND \$\$;/)?.[0] ?? '';
    expect(record).toContain('RETURNS TRIGGER\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = pg_catalog, pg_temp\n');
    expect(record).not.toMatch(/EXCEPTION|PERFORM|SELECT/);
    expect(record).toContain(
      '  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload)\n'
      + '  VALUES (\n'
      + '    NEW.id,\n'
      + "    'status_changed',\n"
      + "    CASE WHEN session_user = 'jale_admin_console' THEN 'admin' ELSE 'system' END,\n"
      + '    NULL,\n'
      + '    jsonb_build_object(\n'
      + "      'title', 'Status changed',\n",
    );
    for (const side of ['OLD', 'NEW']) {
      expect(record).toMatch(new RegExp(
        `CASE ${side}\\.status WHEN 'open' THEN 'Open'\\s+WHEN 'pending_worker' THEN 'Pending worker'\\s+`
        + "WHEN 'pending_admin' THEN 'Pending admin'\\s+WHEN 'resolved' THEN 'Resolved'\\s+"
        + `WHEN 'dismissed' THEN 'Dismissed'\\s+ELSE ${side}\\.status END`,
      ));
    }
    expect(record).toContain("|| U&' \\2192 '\n");
    expect(record).toContain("      'from', OLD.status,\n      'to', NEW.status));\n  RETURN NULL;\n");

    // Four read definers with the signatures the console calls and two
    // trigger functions; every one owned by jale_admin, PUBLIC revoked; only
    // the four are granted, and only to the console.
    const fns = [
      ['admin_analytics_onboarding_restarts', '(p_weeks INTEGER)', '(INTEGER)'],
      ['admin_analytics_operator_resets', '(p_weeks INTEGER)', '(INTEGER)'],
      ['admin_analytics_digest_adoption', '()', '()'],
      ['admin_analytics_digest_sends', '(p_weeks INTEGER)', '(INTEGER)'],
    ] as const;
    for (const [fn, params, args] of fns) {
      expect(sql).toContain(`CREATE FUNCTION public.${fn}${params}\nRETURNS TABLE (`);
      expect(sql).toContain(`ALTER FUNCTION public.${fn}${args} OWNER TO jale_admin;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}${args} FROM PUBLIC;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}${args} TO jale_admin_console;`);
    }
    for (const fn of ['admin_cases_stamp_status_change', 'admin_cases_record_status_change']) {
      expect(sql).toContain(`ALTER FUNCTION public.${fn}() OWNER TO jale_admin;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC;`);
      expect(sql).not.toContain(`GRANT EXECUTE ON FUNCTION public.${fn}()`);
    }
    expect(sql.match(/^CREATE FUNCTION/gm)).toHaveLength(6);
    expect(sql.match(/^SECURITY DEFINER$/gm)).toHaveLength(5);
    expect(sql.match(/^SET search_path = pg_catalog, pg_temp$/gm)).toHaveLength(6);
    expect(sql.match(/PERFORM set_config\('app\.admin_analytics_read', 'on', true\);/g)).toHaveLength(4);
    // The four EXECUTE grants are the only statements granting to the console.
    expect(sql.match(/TO jale_admin_console/g)).toHaveLength(4);

    // Results carry counts, week starts, door ids, step keys, masked reasons,
    // booleans and the listed timestamps only.
    const never = /user_id|run_id|phone_hash|\boperator\b|table_counts|inbound_message_sid|metadata|recipient_email|subject|body_text|body_html|last_error|idempotency_key|headers|source_id|ses_message_id|\bemail\b|cognito_sub|full_name|\bphone\b|employer_id/;
    for (const [fn] of fns) {
      const body = sql.match(new RegExp(`CREATE FUNCTION public\\.${fn}\\([\\s\\S]*?\\nEND \\$\\$;`))?.[0] ?? '';
      expect(body).not.toBe('');
      const result = body.match(/RETURNS TABLE \(([\s\S]*?)\)\nLANGUAGE plpgsql/)?.[1] ?? '';
      expect(result).not.toBe('');
      expect(result).not.toMatch(never);
      // The gate opens before the query, and after every input check.
      const iGate = body.indexOf("PERFORM set_config('app.admin_analytics_read', 'on', true);");
      expect(iGate).toBeGreaterThan(0);
      expect(iGate).toBeLessThan(body.indexOf('RETURN QUERY'));
      const iRaise = body.indexOf("RAISE EXCEPTION 'admin_analytics_invalid_weeks'");
      if (fn === 'admin_analytics_digest_adoption') {
        expect(iRaise).toBe(-1);
        expect(body).toContain("BEGIN\n  -- No arguments to validate.\n  PERFORM set_config('app.admin_analytics_read', 'on', true);");
      } else {
        expect(iRaise).toBeGreaterThan(0);
        expect(iGate).toBeGreaterThan(iRaise);
      }
    }
    expect(sql.match(/IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN/g)).toHaveLength(3);
    // Nothing personal or operational is read at all; user ids, the employer
    // key, emails and subs are read only to count, join or filter.
    expect(code).not.toMatch(/phone_hash|\boperator\b|table_counts|inbound_message_sid|metadata|recipient_email|subject|body_text|body_html|last_error|idempotency_key|headers|ses_message_id|full_name|\bphone\b/);
    expect(code.match(/source_id/g)).toHaveLength(2);
    expect(code).toContain('o.source_id AS employer,');
    expect(code).toContain('WHERE u.id = o.source_id\n');

    // Weeks: a TimeZone-independent window, every row grouped by its UTC
    // Monday, the digest weeks zero-filled.
    expect(code.match(/v_from := \(date_trunc\('week', now\(\) AT TIME ZONE 'UTC'\) - make_interval\(weeks => p_weeks - 1\)\) AT TIME ZONE 'UTC';/g)).toHaveLength(3);
    expect(code.match(/FROM generate_series\(0, p_weeks - 1\) AS g\(n\)/g)).toHaveLength(1);
    expect(code).toContain("SELECT date_trunc('week', t.created_at, 'UTC') AS wk,");
    expect(code).toContain("SELECT date_trunc('week', m.created_at, 'UTC') AS wk,");
    expect(code).toContain("SELECT date_trunc('week', min(b.created_at), 'UTC'),");
    expect(code).toContain("SELECT date_trunc('week', o.created_at, 'UTC') AS wk,");
    expect(code.match(/date_trunc\('week', [a-z]\.created_at\)/g)).toBeNull();
    expect(code).toContain('WHERE t.created_at >= v_from\n');
    expect(code).toContain('AND m.created_at >= v_from\n');
    expect(code).toContain('WHERE b.created_at >= v_from\n');
    expect(code).toContain('AND o.created_at >= v_from\n');

    // Restarts: 113's 17 steps in its order; the door by presence over all
    // of a run's rows; bypass workers out; the three worker reasons by the
    // step left; voice retry loops out; reached = every worker at the step
    // (arrived or pressed); 'all' once per worker; all-steps rows (step
    // NULL) distinct across steps, first in their group.
    expect(code).toContain(
      "VALUES ('start.choose_language', 1), ('identity.verify_otp', 2), ('legal.review', 3),\n"
      + "           ('profile.voice_choice', 4), ('profile.voice_processing', 5), ('profile.name', 6),\n"
      + "           ('profile.location', 7), ('profile.trade', 8), ('profile.custom_trade', 9),\n"
      + "           ('profile.experience', 10), ('profile.transportation', 11), ('profile.availability', 12),\n"
      + "           ('trust.question.1', 13), ('trust.question.2', 14), ('trust.question.3', 15),\n"
      + "           ('profile.photo', 16), ('profile.photo_type', 17)",
    );
    expect(code).toContain("VALUES ('all', 1), ('whatsapp', 2), ('web', 3)");
    expect(code).toContain(
      "CASE WHEN bool_or(t.reason = 'otp_verified') THEN 'whatsapp' ELSE 'web' END AS d\n"
      + '      FROM public.worker_workflow_transitions t\n'
      + "     WHERE t.reason IN ('otp_verified', 'web_start')\n"
      + '     GROUP BY t.run_id',
    );
    expect(code).toContain("WHERE t.reason = 'web_worker_bypass'");
    // A run with no door transition (adopted) still counts under 'all'.
    expect(code).toContain('     WHERE d.door IS NOT NULL\n       AND r.user_id NOT IN (SELECT b.user_id FROM bypass_users b)\n');
    expect(code).toContain(
      "CASE WHEN t.reason = 'worker_restart' THEN 'restart'\n"
      + "                WHEN t.reason IN ('worker_back', 'worker_back_web') THEN 'back'\n"
      + "                ELSE 'arrived'\n",
    );
    expect(code).toContain(
      "CASE WHEN t.reason IN ('worker_restart', 'worker_back', 'worker_back_web') THEN t.from_step_key\n"
      + '                ELSE t.to_step_key\n',
    );
    expect(code).toContain("AND t.reason !~ '_retry_offered$'");
    expect(code).toContain('JOIN steps s ON s.step_key = m.step');
    expect(code).toContain("CROSS JOIN LATERAL (VALUES ('all'), (rd.d)) AS d(door)");
    expect(code).toContain('count(DISTINCT f.user_id) AS n_reached,');
    expect(code).toContain("count(DISTINCT f.user_id) FILTER (WHERE f.kind = 'restart') AS n_restart_workers");
    expect(code).toContain("count(*) FILTER (WHERE f.kind = 'restart') AS n_restart_presses");
    expect(code).toContain("count(DISTINCT f.user_id) FILTER (WHERE f.kind = 'back') AS n_back_workers");
    expect(code).toContain("count(*) FILTER (WHERE f.kind = 'back') AS n_back_presses");
    expect(code).toContain('GROUP BY GROUPING SETS ((f.wk, f.door, f.step), (f.door, f.step), (f.wk, f.door), (f.door))');
    expect(code).toContain('LEFT JOIN steps s ON s.step_key = a.step\n   ORDER BY a.wk NULLS LAST, d.ord, s.ord NULLS FIRST;');

    // Resets: real resets only; the mask (trim, then in this order email-like
    // tokens, UUID-shaped tokens, phone-like runs (separators include / and
    // _), any other 4+ digit run; 80 characters with no trailing space;
    // '(no reason)'); bulk = 10+ distinct workers of one raw reason in a
    // span of at most an hour that contains the reset; runs split at an
    // hour; only in-window resets counted; non-bulk rows first.
    expect(code).toContain('WHERE NOT a.dry_run');
    const bullets = "U&'\\2022\\2022\\2022\\2022'";
    const hex = (n: number): string => `[0-9A-Fa-f]{${n}}`;
    // (whitespace collapsed: line breaks and indentation inside the call are layout)
    expect(code.replace(/\s+/g, ' ').replace(/\( /g, '(')).toContain(
      'COALESCE(NULLIF(rtrim(left('
      + 'regexp_replace(regexp_replace(regexp_replace(regexp_replace(btrim(a.reason), '
      + `'[^[:space:]]+@[^[:space:]]+', ${bullets}, 'g'), `
      + `'${[hex(8), hex(4), hex(4), hex(4), hex(12)].join('-')}', ${bullets}, 'g'), `
      + `'\\+?[0-9][0-9 ()./_-]{5,}[0-9]', ${bullets}, 'g'), `
      + `'[0-9]{4,}', ${bullets}, 'g'), 80)), ''), `
      + "'(no reason)') AS shown,",
    );
    expect(code.match(/regexp_replace\(/g)).toHaveLength(4);
    // The old two-step mask (phone-like runs without / and _, no email or ID) is gone.
    expect(code).not.toContain("'\\+?[0-9][0-9 ().-]{5,}[0-9]'");
    expect(code).toContain('lag(a.created_at) OVER (PARTITION BY a.reason, a.user_id ORDER BY a.created_at, a.id) AS prev_at');
    expect(code).toContain("WHERE x.prev_at >= x.created_at - interval '1 hour'");
    expect(code).toContain(
      'count(*) OVER (PARTITION BY x.raw ORDER BY x.created_at\n'
      + "                          RANGE BETWEEN CURRENT ROW AND interval '1 hour' FOLLOWING) AS span_rows",
    );
    // Distinct workers per span: the resets minus the repeats inside it,
    // found by a join on the reason (no correlated probe per reset).
    expect(code).toContain(
      'JOIN repeats p ON p.raw = st.raw\n'
      + '                    AND p.prev_at >= st.created_at\n'
      + '                    AND p.created_at >= st.created_at\n'
      + "                    AND p.created_at <= st.created_at + interval '1 hour'",
    );
    expect(code).toContain('st.span_rows - COALESCE(d.n, 0) AS span_workers');
    expect(code).not.toMatch(/FROM repeats p\s+WHERE/);
    expect(code).toContain('max(sp.created_at) FILTER (WHERE sp.span_workers >= 10)');
    expect(code).toContain('RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)');
    expect(code).toContain(">= sp.created_at - interval '1 hour', false) AS is_bulk");
    expect(code).toContain("> m.created_at - interval '1 hour'\n                    THEN 0 ELSE 1 END AS new_run");
    expect(code).toContain('GROUP BY b.raw, b.shown, b.run_no');
    expect(code).toContain('ORDER BY o.is_bulk, o.wk, o.started, o.shown COLLATE "C";');

    // Digest: 114's test-account filter verbatim, the producer's email check
    // verbatim, a missing settings row is off, employers by index probe, the
    // email outcomes, distinct employers reached.
    expect(code.match(/AND NOT COALESCE\(u\.email LIKE '%@jale\.test' OR u\.cognito_sub LIKE 'seed-%', false\)/g)).toHaveLength(2);
    expect(code).toContain("u.email IS NOT NULL AND length(u.email) BETWEEN 3 AND 320 AND position('@' IN u.email) > 1");
    expect(code).toContain('WHERE s.employer_id = u.id\n       LIMIT 1\n    ) d ON true');
    expect(code).toContain("count(*) FILTER (WHERE d.enabled),");
    expect(code.match(/LIMIT 1\n/g)).toHaveLength(2);
    expect(code).toContain("WHERE o.source_type = 'employer_digest'");
    expect(code).toContain("count(*) FILTER (WHERE f.status = 'failed' AND f.attempt_count >= 5) AS n_failed");
    expect(code).toContain("count(*) FILTER (WHERE f.status = 'send_unknown') AS n_unknown");
    expect(code).toContain("count(*) FILTER (WHERE f.status = 'pending' OR (f.status = 'failed' AND f.attempt_count < 5)) AS n_in_progress");
    expect(code).toContain("count(DISTINCT f.employer) FILTER (WHERE f.status = 'sent') AS n_reached");
    expect(code).toContain('GROUP BY GROUPING SETS ((f.wk), ())');

    // Preconditions: 042's definer and admin-read policies, 037's admin
    // select, 089's users gate, 026's admin_cases / admin_case_events
    // access; jale_admin may insert events; no restrictive policy
    // that applies to jale_admin hides a read (or fails the event insert).
    for (const row of [
      "('public.worker_workflow_runs', 'worker_workflow_runs_definer', '*', 'true', 'true')",
      "('public.worker_workflow_transitions', 'worker_workflow_transitions_definer', '*', 'true', 'true')",
      "('public.worker_reset_audit', 'worker_reset_audit_admin_read', 'r', 'true', NULL)",
      "('public.email_outbox', 'email_outbox_admin_select', 'r', 'true', NULL)",
      "('public.users', 'users_admin_analytics_read', 'r', v_gate, NULL)",
      "('public.admin_cases', 'admin_cases_service_all', '*', 'true', 'true')",
      "('public.admin_case_events', 'admin_case_events_service_all', '*', 'true', 'true')",
    ]) {
      expect(code).toContain(row);
    }
    expect(code).toContain('AND pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM pol.chk');
    // The audit storage is neither read nor checked.
    expect(code).not.toContain('admin_audit_log');
    expect(code).toContain("IF NOT has_table_privilege('jale_admin', 'public.admin_case_events', 'INSERT') THEN");
    for (const table of ['users', 'worker_workflow_runs', 'worker_workflow_transitions', 'worker_reset_audit',
      'email_outbox', 'employer_digest_settings', 'admin_cases']) {
      expect(code).toContain(`'public.${table}'::regclass`);
    }
    expect(code).toContain("AND p.polcmd IN ('r', '*'))\n            OR (p.polrelid = 'public.admin_case_events'::regclass AND p.polcmd IN ('r', 'a', '*')))");
    expect(code).toContain(
      "AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles)\n"
      + '            OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(role_oid)\n'
      + "                        WHERE r.role_oid <> 0 AND pg_has_role('jale_admin', r.role_oid, 'USAGE')))",
    );
    expect(sql).toContain('migration 117: a restrictive policy for jale_admin, a role it inherits, or PUBLIC');

    // Self-check: schema-qualified catalog output; the column; both triggers
    // via pg_get_triggerdef; the policy; per function the result, owner,
    // definer flag, pinned search_path and exact EXECUTE grantees; the gate;
    // bad weeks rejected; the triggers smoke-tested in a rolled-back sub-block.
    expect(code).toContain('SET LOCAL search_path = pg_catalog, pg_temp;');
    expect(code).toContain(
      "AND a.atttypid = 'timestamptz'::regtype\n       AND a.attnotnull\n       AND NOT a.attisdropped\n"
      + "       AND pg_get_expr(d.adbin, d.adrelid) = 'now()'",
    );
    expect(sql).toContain('v_stamp    CONSTANT TEXT := $q$CREATE TRIGGER admin_cases_stamp_status_change BEFORE UPDATE OF status ON public.admin_cases FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.admin_cases_stamp_status_change()$q$;');
    expect(sql).toContain('v_record   CONSTANT TEXT := $q$CREATE TRIGGER admin_cases_record_status_change AFTER UPDATE OF status ON public.admin_cases FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.admin_cases_record_status_change()$q$;');
    expect(code.match(/AND t\.tgenabled = 'O'\n {7}AND pg_get_triggerdef\(t\.oid\) = v_(stamp|record)/g)).toHaveLength(2);
    expect(sql).toContain("v_gate     CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;");
    expect(code).toContain(
      "AND p.polroles = ARRAY['jale_admin'::regrole::oid]\n"
      + '       AND pg_get_expr(p.polqual, p.polrelid) = v_gate\n'
      + '       AND p.polwithcheck IS NULL',
    );
    expect(code.match(/'TABLE\(/g)).toHaveLength(4);
    expect(code.match(/'trigger', (true|false), false\)/g)).toHaveLength(2);
    expect(sql).toContain('result drifted');
    expect(sql.match(/aclexplode\(/g)).toHaveLength(1);
    expect(code).toContain('AND p.prosecdef = fn.definer\n');
    expect(code).toContain("AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)");
    expect(code).toContain("AND NOT (fn.console AND a.grantee = 'jale_admin_console'::regrole::oid)");
    for (const [fn] of fns) {
      expect(sql).toContain(`migration 117: ${fn} did not set the read flag`);
    }
    expect(sql.match(/PERFORM set_config\('app\.admin_analytics_read', '', true\);/g)).toHaveLength(4);
    expect(sql).toContain('FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP');
    expect(sql).toContain("v_raised := SQLERRM = 'admin_analytics_invalid_weeks';");
    expect(code).toContain("UPDATE public.admin_cases SET status = 'open' WHERE id = v_case;");
    expect(code).toContain("UPDATE public.admin_cases SET status = 'pending_worker' WHERE id = v_case;");
    expect(code).toContain(
      "AND e.payload = jsonb_build_object('title', 'Status changed', 'detail', U&'Open \\2192 Pending worker',\n"
      + "                                            'from', 'open', 'to', 'pending_worker')",
    );
    expect(code).toContain(
      '    RAISE EXCEPTION USING MESSAGE = v_sentinel;\n'
      + '  EXCEPTION WHEN raise_exception THEN\n'
      + '    IF SQLERRM IS DISTINCT FROM v_sentinel THEN\n'
      + '      RAISE;\n'
      + '    END IF;\n'
      + '  END;\n',
    );
    expect(sql).toContain('migration 117: the trigger smoke test did not run or left rows behind');
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

  // 092 is a DROP-only migration, which makes a content test unusually
  // load-bearing: the difference between a correct line and a catastrophic
  // one is a single pair of parentheses (`REVOKE SELECT (email)` vs `REVOKE
  // SELECT`) or a single keyword (`CASCADE`). Neither mistake fails any
  // typecheck, and on a testbed whose only WhatsApp traffic is the suites
  // that run AFTER it, a widened revoke can even look green. So the shape of
  // every destructive statement is pinned here, and the negatives matter as
  // much as the positives.
  it('092 drops exactly the dead onboarding objects, without CASCADE, and keeps itself self-verifying', () => {
    const sql = fs.readFileSync(path.join(migrationsDir, '092_onboarding_cleanup_drops.sql'), 'utf8');

    // One transaction, as jale_admin.
    expect(sql).toContain('Connect as: jale_admin (NOT the RDS master user)');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);

    // DEPLOY ORDER: the OPPOSITE of 090/091. Code first, then apply. This is
    // the one fact an operator must not get wrong, so it is pinned verbatim.
    expect(sql).toContain('APPLY THIS MIGRATION *AFTER* DEPLOYING THE CODE');
    expect(sql).toContain('1. deploy the code that stops referencing these objects');
    expect(sql).toContain('2. apply THIS file');

    // ── (a) the pg_depend pre-flight, BEFORE any drop ──
    // Ordering is the point: a post-hoc audit cannot see what a CASCADE
    // would have eaten, so the probe must precede the first DROP.
    expect(sql).toContain('pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)');
    expect(sql).toContain("AND d.deptype = 'n'");
    expect(sql).toContain('migration 092 pre-flight: users columns still carry dependents');
    expect(sql).toContain('migration 092 pre-flight: functions still carry dependents');
    expect(sql.indexOf('pre-flight')).toBeLessThan(sql.indexOf('DROP FUNCTION'));

    // NO CASCADE in any STATEMENT. A drop that finds a live dependent must
    // fail loud (2BP01), never take the dependent with it. The header
    // discusses CASCADE in prose (it is the decision this file is built
    // around), so the check runs over the SQL with `--` comment lines
    // stripped -- 088's line-anchoring technique, applied to a word that
    // legitimately appears in commentary.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    // The keyword only ever appears in DDL as the last token of a clause, so
    // it is the punctuation that distinguishes `DROP COLUMN x CASCADE,` /
    // `... CASCADE;` from the two RAISE messages that say the word.
    expect(statements).not.toMatch(/\bCASCADE\s*[;,)]/i);
    // ...and the prose that explains why is not allowed to disappear either.
    expect(sql).toContain('Nothing here is CASCADE');

    // ── (b) 053, in full ──
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS public.bypass_onboarding_for_web_worker(UUID, UUID, TEXT, TEXT, TEXT)',
    );
    expect(sql).toContain('DROP POLICY IF EXISTS users_web_worker_bypass_definer ON public.users');
    // COLUMN-SCOPED revoke. The bare form would take 004's fourteen-column
    // lookup grant, 041's tos_accepted_at and 049's privacy_accepted_at with
    // it and break every WhatsApp inbound turn.
    expect(sql).toContain('REVOKE SELECT (email) ON public.users FROM jale_whatsapp');
    // Over the comment-stripped text: the header names the dangerous bare
    // form in prose precisely so a future editor knows why the parentheses
    // are there.
    expect(statements).not.toMatch(/REVOKE\s+SELECT\s+ON\s+(public\.)?users/i);
    expect(statements).not.toMatch(/REVOKE\s+ALL[^;]*ON\s+(public\.)?users/i);
    expect(sql).toContain('A bare `REVOKE SELECT ON users FROM jale_whatsapp`');

    // ── (c) 052's first half only ──
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.stage_worker_pending_name(TEXT, TEXT)');
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.promote_worker_pending_name(TEXT)');
    expect(sql).toContain('DROP COLUMN IF EXISTS pending_full_name');
    expect(sql).toContain('DROP COLUMN IF EXISTS pending_full_name_set_at');
    // 052's SECOND half is live and must not be touched here.
    expect(sql).not.toMatch(/REVOKE[^;]*worker_skills/i);
    expect(sql).not.toMatch(/DROP POLICY[^;]*worker_skills_whatsapp_delete/i);

    // ── (d) 006's v1 trust columns, with BOTH grantee roles named ──
    // REVOKE has no IF EXISTS and a column-scoped REVOKE naming a dropped
    // column is a hard 42703, so these two must be guarded by a column
    // existence check or the SECOND apply of this file fails.
    expect(sql).toContain("REVOKE SELECT (trust_signals, trust_signals_completed_at),");
    expect(sql).toContain("UPDATE (trust_signals, trust_signals_completed_at)");
    expect(sql).toContain("ON public.users FROM jale_matching");
    expect(sql).toContain("column_name = 'trust_signals'\n  ) THEN");
    expect(sql).toContain('DROP COLUMN IF EXISTS trust_signals');
    expect(sql).toContain('DROP COLUMN IF EXISTS trust_signals_completed_at');

    // ── (e) the 022/080 guard function -- and NOT 091's hire gate ──
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.enforce_job_application_required_docs()');
    expect(sql).not.toMatch(/DROP FUNCTION[^;]*enforce_job_application_hire_requirements/);
    expect(sql).not.toMatch(/DROP TRIGGER[^;]*job_applications_hire_requirements_guard/);

    // Nothing outside the four groups. This migration creates nothing,
    // grants nothing, deletes no rows and drops no table.
    expect(sql).not.toMatch(/^CREATE (TABLE|POLICY|TRIGGER|INDEX)/m);
    expect(sql).not.toMatch(/^GRANT/m);
    expect(sql).not.toMatch(/^DELETE FROM/m);
    expect(sql).not.toMatch(/DROP TABLE/);
    // The only DROP FUNCTION statements are the four named above.
    expect(sql.match(/^DROP FUNCTION/gm)).toHaveLength(4);
    expect(sql.match(/^DROP POLICY/gm)).toHaveLength(1);

    // ── (f) the self-audit's own error strings: absent, then still-present ──
    expect(sql).toContain('migration 092: bypass_onboarding_for_web_worker still exists');
    expect(sql).toContain('migration 092: policy users_web_worker_bypass_definer still exists on users');
    expect(sql).toContain('migration 092: jale_whatsapp still holds SELECT on users.email');
    // The email absence check MUST pin privilege_type: column_privileges
    // expands 004's table-level INSERT across every column, so an unscoped
    // EXISTS fails a correct migration on a row this file never touches.
    expect(sql).toContain("AND privilege_type = 'SELECT'");
    expect(sql).toContain('migration 092: stage_worker_pending_name still exists');
    expect(sql).toContain('migration 092: promote_worker_pending_name still exists');
    expect(sql).toContain('migration 092: users.% still exists');
    expect(sql).toContain('migration 092: enforce_job_application_required_docs() still exists');
    expect(sql).toContain('migration 092: job_applications_required_docs_guard trigger is back');
    // The half that catches a revoke or a drop that took too much. Asserting
    // absence is easy; these are what make the audit worth having.
    expect(sql).toContain('migration 092: users must keep RLS ENABLE + FORCE');
    expect(sql).toContain(
      'migration 092: a REVOKE took more than users.email/trust_signals -- jale_whatsapp lost: %',
    );
    expect(sql).toContain('migration 092: jale_whatsapp unexpectedly has broad SELECT on users');
    expect(sql).toContain('migration 092: the jale_matching revoke took users.% as well');
    expect(sql).toContain('migration 092: policy % disappeared from users');
    expect(sql).toContain('migration 092: jale_whatsapp lost DELETE on worker_skills (052 half two is kept)');
    expect(sql).toContain('migration 092: worker_skills_whatsapp_delete policy disappeared');
    expect(sql).toContain('migration 092: % must still exist');
    expect(sql).toContain('migration 092: 091 hire gate trigger is missing -- the wrong guard was dropped');
    // The three users columns 010 granted jale_matching that must survive,
    // and the two 004/041/049 lists, are enumerated in the audit itself.
    expect(sql).toContain("FOREACH col IN ARRAY ARRAY['id', 'user_type', 'main_trade']");
    expect(sql).toContain("'tos_accepted_at',\n                             'privacy_accepted_at']");
    expect(sql).toContain("'public.enforce_job_application_hire_requirements()',");
  });

  // 093 adds ONE function to 043's fenced worker-intent transport. Its whole
  // reason to exist is a distinction 043 cannot express: a retry that must
  // NOT consume the five-attempt budget, because the reason for the failure
  // (a WhatsApp template Meta has not approved yet) is not the row's fault
  // and no number of attempts fixes it. Two facts in it are load-bearing and
  // invisible to a typecheck, so they are pinned here:
  //   * attempt_count is REFUNDED on the pending branch. 043 charges the
  //     attempt at LEASE time, so a defer that merely declines to increment
  //     still leaves the +1 on the row and 043's own
  //     `pending AND attempt_count >= 5` sweep ends it after ~5 hourly
  //     retries -- the 48h ceiling would never be reached and the function
  //     would be a slow spelling of fail_worker_intent_outbox;
  //   * BOTH lease columns are nulled on BOTH branches, or 043's
  //     whatsapp_outbox_worker_intent_lease_consistency CHECK fires (it
  //     permits a set token only together with a set deadline AND
  //     status = 'send_unknown').
  it('093 adds a defer-without-counting RPC to 043 transport, fenced and budget-neutral', () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, '093_worker_intent_outbox_defer.sql'), 'utf8',
    );

    expect(sql).toContain('Connect as jale_admin');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);

    // The signature the drain calls by name and arity.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.defer_worker_intent_outbox(');
    expect(sql).toContain('p_id UUID, p_lease_token UUID, p_error TEXT, p_delay_seconds INTEGER');
    expect(sql).toContain('RETURNS BOOLEAN');
    expect(sql).toContain('LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp');

    // 043's fence, in FULL: the token equality AND the un-expired deadline.
    // Token-only would let a row whose lease already lapsed (and whose
    // delivery state is therefore unknown) be pushed back to 'pending'.
    expect(sql).toContain('AND worker_intent_lease_token = p_lease_token');
    expect(sql).toContain('AND worker_intent_leased_until > pg_catalog.now()');
    expect(sql).toContain("AND status = 'send_unknown'");
    expect(sql).toContain("AND source_type = 'worker_intent'");

    // The 48h ceiling, and the delay the caller asks for.
    expect(sql).toContain("interval '48 hours'");
    expect(sql).toContain('make_interval(secs => p_delay_seconds)');

    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    const body = statements.slice(
      statements.indexOf('CREATE OR REPLACE FUNCTION public.defer_worker_intent_outbox('),
      statements.indexOf('ALTER FUNCTION public.defer_worker_intent_outbox'),
    );
    expect(body.length).toBeGreaterThan(0);

    // The refund, and its clamp. `GREATEST(attempt_count - 1, 0)` undoes the
    // increment 043's lease just charged; the clamp keeps a hand-edited or
    // legacy row off a negative counter (attempt_count carries no CHECK).
    expect(body).toContain('GREATEST(attempt_count - 1, 0)');
    // It must never go UP. An increment here is fail_worker_intent_outbox
    // with extra steps, and `+ 1` is the one-character version of that bug.
    expect(body).not.toMatch(/attempt_count\s*\+\s*1/);
    // ...and the terminal branch keeps the attempt as evidence, so the
    // assignment is a CASE on the same 48h predicate as status/next_attempt_at
    // rather than an unconditional rewind.
    expect(body).toMatch(/attempt_count\s*=\s*CASE/);
    expect(body.match(/interval '48 hours'/g) ?? []).toHaveLength(3);

    // Both lease columns nulled on both branches (043's CHECK).
    expect(body).toContain('worker_intent_lease_token = NULL');
    expect(body).toContain('worker_intent_leased_until = NULL');

    // Least privilege, mirroring every other 043 definer.
    expect(sql).toContain(
      'ALTER FUNCTION public.defer_worker_intent_outbox(UUID, UUID, TEXT, INTEGER) OWNER TO jale_admin',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.defer_worker_intent_outbox(UUID, UUID, TEXT, INTEGER) FROM PUBLIC',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.defer_worker_intent_outbox(UUID, UUID, TEXT, INTEGER) TO jale_whatsapp',
    );
    // No table grant is widened: the whole point of a definer is that
    // jale_whatsapp still cannot UPDATE a worker_intent row directly.
    expect(statements).not.toMatch(/GRANT[^;]*ON\s+(public\.)?whatsapp_outbox/i);

    // Self-verifying, like 082/091/092: the file proves its own end state.
    expect(sql).toContain('migration 093: defer_worker_intent_outbox is missing');
    expect(sql).toContain('migration 093: defer_worker_intent_outbox must be SECURITY DEFINER');
    expect(sql).toContain('migration 093: jale_whatsapp cannot execute defer_worker_intent_outbox');
    // 043's three RPCs must all still be there -- this file adds, never replaces.
    expect(sql).toContain('migration 093: 043 RPC % disappeared');
  });
  // 094 is the sprint-24 DATA migration, and the first file in the chain that
  // both WRITES rows on a FORCE-RLS table and ASSERTS what it wrote. Several
  // of its facts are invisible to a typecheck, to a mocked pool, and even to a
  // superuser-applied integration test, so they are pinned here.
  describe('094 backfills per-application answers and canonical trades under FORCE RLS', () => {
    const sql = () => fs.readFileSync(
      path.join(migrationsDir, '094_sprint24_data_backfills.sql'), 'utf8',
    );

    // The four `per_application` members of FIELD_REUSE_POLICY (job-fields.ts).
    // These are the keys the 2026-09-04 incident leaked across employers.
    const PER_APPLICATION = [
      'date_available', 'desired_pay', 'worked_here_before', 'emergency_contact',
    ];
    // TRADE_KEYS minus 'other' (worker-vocab.ts), which is also exactly the
    // 004_whatsapp.sql main_trade CHECK list minus 'other'. Kept as a literal
    // here for the same reason the rest of this file is fs-only: a migration
    // assertion must not depend on the Lambda code compiling.
    const STANDARD_CATEGORIES = [
      'electrician', 'plumber', 'carpenter', 'concrete', 'painting',
    ];

    it('runs as jale_admin in ONE transaction and creates no schema', () => {
      const text = sql();
      expect(text).toContain('Connect as jale_admin');
      expect(text.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(text.match(/^COMMIT;$/gm)).toHaveLength(1);
      // A data migration must not smuggle schema in: no table is created,
      // dropped or re-typed here, and no temp object is introduced (no
      // migration in 001-093 uses one, and TEMP is a database privilege this
      // chain has never depended on).
      expect(text).not.toMatch(/^\s*(CREATE|DROP)\s+(TEMP\s+|TEMPORARY\s+)?TABLE/mi);
      expect(text).not.toMatch(/^\s*CREATE\s+(OR REPLACE\s+)?FUNCTION/mi);
    });

    it('un-forces, backfills and re-forces exactly the two tables it writes (028 pattern)', () => {
      const text = sql();
      for (const table of ['users', 'worker_application_defaults']) {
        expect(text).toContain(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
        expect(text).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        // The un-force must come FIRST. Reversed, the backfill runs under the
        // owner-obeys-policies rule and updates zero rows.
        expect(text.indexOf(`ALTER TABLE ${table} NO FORCE`))
          .toBeLessThan(text.indexOf(`ALTER TABLE ${table} FORCE`));
      }
      // No OTHER table's RLS posture is touched, and every un-force is
      // reversed one for one: an un-force this file forgets to reverse is a
      // silent, permanent hole in a tenant boundary.
      const statements = text.match(/ALTER TABLE (\w+) (?:NO )?FORCE ROW LEVEL SECURITY/g) ?? [];
      const tables = new Set(statements.map((s) => s.match(/ALTER TABLE (\w+)/)![1]));
      expect([...tables].sort()).toEqual(['users', 'worker_application_defaults']);
      expect(text.match(/ALTER TABLE \w+ NO FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
      expect(text.match(/ALTER TABLE \w+ FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    });

    // THE trap this file exists around. jale_admin OWNS both tables, so once
    // FORCE is back on, its own SELECTs obey `users_isolation_select`
    // (002_rls_policies.sql) and `worker_application_defaults_self` (079) --
    // both keyed on an unset `app.current_user_id`, which is NULL, which
    // matches nothing. A data assertion placed after the re-force therefore
    // reads ZERO rows and can never fail, however broken the backfill was.
    // (Measured on the sprint-24 testbed: 1 row visible un-forced, 0 forced.)
    // So: data assertions while un-forced, catalog assertions after.
    it('asserts its DATA while RLS is still un-forced, and only its CATALOG state after', () => {
      const text = sql();
      const lastNoForce = Math.max(
        text.lastIndexOf('ALTER TABLE users NO FORCE'),
        text.lastIndexOf('ALTER TABLE worker_application_defaults NO FORCE'),
      );
      const firstReForce = Math.min(
        ...['ALTER TABLE users FORCE', 'ALTER TABLE worker_application_defaults FORCE']
          .map((s) => text.indexOf(s)),
      );
      expect(lastNoForce).toBeGreaterThan(-1);
      expect(firstReForce).toBeGreaterThan(lastNoForce);

      const unforcedWindow = text.slice(lastNoForce, firstReForce);
      const afterReForce = text.slice(firstReForce);

      // Both data checks live inside the un-forced window...
      expect(unforcedWindow).toContain('migration 094: worker_application_defaults still holds');
      expect(unforcedWindow).toContain('migration 094: users rows still resolve');
      // ...and nowhere after it.
      expect(afterReForce).not.toContain('migration 094: worker_application_defaults still holds');
      expect(afterReForce).not.toContain('migration 094: users rows still resolve');

      // The catalog check is the reverse: relforcerowsecurity comes from
      // pg_class, which RLS does not filter, so it belongs after the re-force
      // (and asserting it before would assert the wrong value).
      expect(afterReForce).toContain('relforcerowsecurity');
      expect(afterReForce).toContain('migration 094: ');
      expect(unforcedWindow).not.toContain('relforcerowsecurity');
    });

    it('strips exactly the four per_application answer keys, and only from an object', () => {
      const text = sql();
      for (const key of PER_APPLICATION) {
        // The jsonb `-` operator REMOVES the key. Setting it to null would
        // still read as answered through hasOwnProperty.
        expect(text).toContain(`- '${key}'`);
      }
      // `?|` makes step A self-idempotent: a second apply matches no row.
      expect(text).toContain(
        "answers ?| array['date_available','desired_pay','worked_here_before','emergency_contact']",
      );
      expect(text).toContain("jsonb_typeof(answers) = 'object'");
      expect(text).toContain('updated_at = now()');
      // No `stable` key is ever removed -- those are the legitimately
      // reusable half of the same blob.
      for (const key of ['work_authorization', 'date_of_birth', 'home_address',
        'education', 'military_service', 'work_history', 'references']) {
        expect(text).not.toContain(`- '${key}'`);
      }
    });

    // normalizeProfession() in SQL. The single most breakable line in the
    // file: translate() pairs its two arguments POSITIONALLY and silently
    // ignores the overflow, so an off-by-one in the FROM set shifts every
    // later character onto the wrong target. The brief for this migration
    // carried exactly that bug (21 sources, 22 targets, which mapped
    // 'a-circumflex' to 'u'), and no alias in 060 contains a circumflex -- so
    // parity over the seeded aliases alone would NOT have caught it.
    it('mirrors normalizeProfession with a LENGTH-MATCHED translate() pair', () => {
      const text = sql();
      const calls = [...text.matchAll(/translate\(lower\([^)]*\),\s*'([^']*)',\s*'([^']*)'\)/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const [, from, to] of calls) {
        expect([...from].length).toBe([...to].length);
      }
      // The rest of normalizeProfession's contract.
      expect(text).toContain("'[-./]', ' ', 'g'");
      expect(text).toContain("'\\s+', ' ', 'g'");
      expect(text).toContain('btrim(');
    });

    // The normalizer + alias-resolution expression is written out twice on
    // purpose (the UPDATE and the self-check), because a data assertion that
    // re-derives the rule differently proves nothing. They must stay
    // byte-identical, which is what this pins -- no edit may introduce a
    // third, divergent spelling.
    it('resolves against trade_aliases identically in the UPDATE and in the self-check', () => {
      const text = sql();
      const norms = text.match(/translate\(lower\([^)]*\),\s*'[^']*',\s*'[^']*'\)/g) ?? [];
      expect(norms.length).toBe(2);
      expect(norms[0]).toBe(norms[1]);

      // resolveTradeAlias's two lookups: trade_key or a pre-normalized alias,
      // then ONE retry with a trailing plural 's' stripped.
      expect((text.match(/= ANY\(a\.aliases\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(text).toContain('length(c.norm) > 3');
      expect(text).toContain("c.norm LIKE '%s'");
      expect(text).toContain('left(c.norm, -1)');
      // A direct hit must outrank the singular retry, as the two sequential
      // TS lookups do -- and DISTINCT ON makes the choice deterministic when
      // alias-generator.ts has inserted a row colliding with a 060 seed.
      expect(text).toContain('DISTINCT ON (c.id)');
    });

    it('maps a standard trade_category to the enum key and everything else to canonical_es', () => {
      const text = sql();
      // Exactly TRADE_KEYS minus 'other'. 'drywall' and 'general_labor' are
      // real jobs.trade_category values with NO main_trade counterpart, so
      // writing either would trip the 004 CHECK.
      expect(text).toMatch(/IN \('electrician','plumber','carpenter','concrete','painting'\)/);
      for (const key of STANDARD_CATEGORIES) expect(text).toContain(`'${key}'`);
      expect(text).not.toMatch(/'(drywall|general_labor)'/);

      // chk_trade_other (004): main_trade='other' never gets a NULL or blank
      // main_trade_other. canonical_es is NOT NULL but not non-blank, so the
      // fallback is the row's current text, mirroring `canonical || tidied`.
      expect(text).toContain("nullif(btrim(r.canonical_es), '')");
      // A resolved standard trade clears the free-text column so no stale
      // spelling survives beside the enum key.
      expect(text).toMatch(/THEN\s+NULL/);
    });

    it('is re-appliable: the trade UPDATE touches no row whose pair is already correct', () => {
      const text = sql();
      // Two explicit IS DISTINCT FROM clauses, not a row-wise comparison.
      // This is what makes a second apply report 0 rows AND what gives exact
      // parity with classifyBackfillRow's `changed` flag in
      // scripts/backfill-trade-canonical.ts.
      expect(text).toContain('u.main_trade IS DISTINCT FROM t.new_main_trade');
      expect(text).toContain('u.main_trade_other IS DISTINCT FROM t.new_main_trade_other');
      // The same candidate filter the script's SELECT_DISTINCT_TRADES uses.
      expect(text).toContain("u.main_trade = 'other'");
      expect(text).toContain("btrim(coalesce(u.main_trade_other, '')) <> ''");
    });

    it('reports counts, and only counts', () => {
      const text = sql();
      const notices = text.match(/RAISE NOTICE[^;]*;/g) ?? [];
      expect(notices.length).toBeGreaterThanOrEqual(2);
      // No trade text, no worker id, no name, no phone reaches a log line --
      // the same posture backfill-trade-canonical.ts's report holds.
      for (const notice of notices) {
        expect(notice).not.toMatch(/cognito_sub|\bphone\b|full_name|\bemail\b|main_trade_other/);
      }
      expect(text).toContain('GET DIAGNOSTICS');
    });

    it('documents its deploy order and its lock window', () => {
      const text = sql();
      expect(text).toMatch(/AFTER 093/);
      // Independent of the code deploy, unlike 090/091 (before) and 092 (after).
      expect(text).toMatch(/independent of the code deploy/i);
      // ALTER TABLE ... FORCE takes ACCESS EXCLUSIVE on both tables until COMMIT.
      expect(text).toMatch(/ACCESS EXCLUSIVE/);
    });
  });
  // 095 is the sprint-24 hotfix migration behind the worker hire celebration.
  // It is the first file that ADDS COLUMNS to job_applications and then
  // BACKFILLS them, so it inherits 094's trap: jale_admin owns the table and
  // 003 FORCEs RLS on it, so the backfill sees ZERO rows -- and reports
  // success -- unless the file un-forces first. Everything pinned here is
  // invisible to a typecheck and to a mocked pool.
  describe('095 adds the hire acknowledgement columns and backfills them under FORCE RLS', () => {
    const sql = () => fs.readFileSync(
      path.join(migrationsDir, '095_application_hire_ack.sql'), 'utf8',
    );
    /** The three columns the celebration is built on. */
    const COLUMNS = ['hired_at', 'hired_seen_at', 'hired_ack_at'];
    /** The two the WORKER's own API may write. hired_at is NOT one of them. */
    const WORKER_WRITABLE = ['hired_seen_at', 'hired_ack_at'];

    it('runs as jale_admin in ONE transaction and adds the three columns replay-safely', () => {
      const text = sql();
      expect(text).toContain('Connect as jale_admin');
      expect(text.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(text.match(/^COMMIT;$/gm)).toHaveLength(1);
      // IF NOT EXISTS on every ADD COLUMN (the convention 017/077/090/091
      // follow) is what makes a hand re-apply through the bastion, and the
      // suite's own re-application, safe.
      for (const col of COLUMNS) {
        expect(text).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\s+TIMESTAMPTZ`, 'i'));
      }
      // Nullable, with no default: a NULL hired_at is what distinguishes
      // "never hired" from "hired", and a DEFAULT now() would have stamped
      // every pending row.
      expect(text).not.toMatch(/hired_(at|seen_at|ack_at)\s+TIMESTAMPTZ[^,;]*(NOT NULL|DEFAULT)/i);
    });

    it('un-forces, backfills and re-forces exactly job_applications (028/094 pattern)', () => {
      const text = sql();
      expect(text).toContain('ALTER TABLE job_applications NO FORCE ROW LEVEL SECURITY;');
      expect(text).toContain('ALTER TABLE job_applications FORCE ROW LEVEL SECURITY;');
      // Reversed, the UPDATE runs under the owner-obeys-policies rule and
      // rewrites nothing at all.
      expect(text.indexOf('ALTER TABLE job_applications NO FORCE'))
        .toBeLessThan(text.indexOf('ALTER TABLE job_applications FORCE'));
      // No OTHER table's RLS posture is touched, and the un-force is reversed
      // one for one -- an un-force left in place is a permanent, silent hole
      // in a tenant boundary.
      const statements = text.match(/ALTER TABLE (\w+) (?:NO )?FORCE ROW LEVEL SECURITY/g) ?? [];
      const tables = new Set(statements.map((s) => s.match(/ALTER TABLE (\w+)/)![1]));
      expect([...tables]).toEqual(['job_applications']);
      expect(text.match(/ALTER TABLE \w+ NO FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
      expect(text.match(/ALTER TABLE \w+ FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
    });

    // 094's lesson, restated for this file: once FORCE is back on, jale_admin's
    // own SELECTs obey applications_worker_select / applications_employer_select
    // (003) -- both keyed on an unset app.current_user_id, which is NULL, which
    // matches nothing. A data assertion after the re-force reads zero rows and
    // can never fail, however broken the backfill was.
    it('asserts its DATA while RLS is still un-forced, and only its CATALOG state after', () => {
      const text = sql();
      const noForce = text.indexOf('ALTER TABLE job_applications NO FORCE');
      const reForce = text.indexOf('ALTER TABLE job_applications FORCE');
      expect(noForce).toBeGreaterThan(-1);
      expect(reForce).toBeGreaterThan(noForce);

      const unforcedWindow = text.slice(noForce, reForce);
      const afterReForce = text.slice(reForce);

      // The data check -- no hired row left without a hired_at -- lives inside
      // the un-forced window and nowhere after it.
      expect(unforcedWindow).toContain('migration 095: % hired application(s) still carry a NULL hired_at');
      expect(afterReForce).not.toContain('still carry a NULL hired_at');
      // The un-forced window opens by PROVING the un-force took effect. Under
      // FORCE RLS jale_admin's UPDATE is a zero-row no-op and the count check
      // above sees zero rows too, so without this precondition a deleted or
      // failed NO FORCE would pass every data check while stamping nothing.
      expect(unforcedWindow).toContain('migration 095: job_applications is still FORCE RLS');
      expect(unforcedWindow.indexOf('is still FORCE RLS')).toBeLessThan(unforcedWindow.indexOf('UPDATE job_applications'));
      // The "FORCE is back" assertion is the reverse: only after the re-force,
      // where asserting it inside the window would assert the wrong value.
      expect(afterReForce).toContain('migration 095: job_applications lost RLS ENABLE + FORCE');
      expect(unforcedWindow).not.toContain('lost RLS ENABLE + FORCE');
      // The privilege checks read the planner's own function; the role-filtered
      // information_schema view is deliberately not consulted.
      expect(afterReForce).toContain("has_column_privilege('jale_admin', 'public.job_applications', 'hired_at', 'UPDATE')");
      expect(afterReForce).not.toContain('FROM information_schema.column_privileges');
    });

    it('stamps every pre-existing hired row from updated_at, and only those', () => {
      const text = sql();
      // All three columns, from the row's own updated_at -- the closest thing
      // the schema has to "when this became hired". Stamping seen/ack too is
      // what suppresses a retroactive celebration for a worker hired weeks ago.
      expect(text).toMatch(/SET\s+hired_at\s*=\s*updated_at/);
      expect(text).toMatch(/hired_seen_at\s*=\s*updated_at/);
      expect(text).toMatch(/hired_ack_at\s*=\s*updated_at/);
      // Only hired rows, and only ones not already stamped: this is what makes
      // a replay a no-op and what keeps a pending application's columns NULL.
      expect(text).toMatch(/WHERE\s+status\s*=\s*'hired'\s+AND\s+hired_at\s+IS\s+NULL/);
      // `status` must NOT be in the UPDATE's SET list: 091's
      // job_applications_hire_requirements_guard and 023's
      // job_applications_hired_count_sync are both `UPDATE OF status`
      // triggers, so naming it would re-run the hire gate and re-sync
      // jobs.workers_hired for every historical hire.
      const update = text.slice(text.indexOf('UPDATE job_applications'));
      expect(update.slice(0, update.indexOf('WHERE'))).not.toMatch(/\bstatus\s*=/);
      expect(text).toContain('GET DIAGNOSTICS');
    });

    it('grants jale_whatsapp UPDATE on exactly the two acknowledgement columns', () => {
      const text = sql();
      // The worker's own door runs as jale_whatsapp (028's
      // jobapp_whatsapp_update is the only worker-scoped UPDATE policy on this
      // table), and PostgreSQL column privileges are what stop that role
      // rewriting the hire itself.
      expect(text).toContain(
        'GRANT UPDATE (hired_seen_at, hired_ack_at) ON job_applications TO jale_whatsapp;',
      );
      // hired_at is deliberately absent: only the EMPLOYER's status update may
      // set it. A grant on it would let a worker forge their own hire date.
      expect(text).not.toMatch(/GRANT UPDATE[^;]*hired_at[^;]*jale_whatsapp/);
      // 004 grants jale_whatsapp table-wide SELECT on job_applications, which
      // covers columns added later -- so no SELECT grant belongs here, and the
      // file says so rather than leaving a reviewer to re-litigate it.
      expect(text).toMatch(/table-wide SELECT/i);
      expect(text).not.toMatch(/GRANT SELECT[^;]*ON job_applications/);
      // ...and the grant proves itself, after the re-force.
      const afterReForce = text.slice(text.indexOf('ALTER TABLE job_applications FORCE'));
      for (const col of WORKER_WRITABLE) expect(afterReForce).toContain(col);
      expect(afterReForce).toContain(
        'migration 095: jale_whatsapp missing UPDATE grant on job_applications.%',
      );
      expect(afterReForce).toMatch(/has_column_privilege|column_privileges/);
    });

    it('documents its deploy order and its lock window', () => {
      const text = sql();
      expect(text).toMatch(/AFTER 094/);
      // The list endpoint SELECTs all three columns, so the schema has to be
      // there first: this one is BEFORE the code deploy, unlike 094.
      expect(text).toMatch(/BEFORE the code deploy/i);
      // ALTER TABLE ... [NO] FORCE takes ACCESS EXCLUSIVE until COMMIT.
      expect(text).toMatch(/ACCESS EXCLUSIVE/);
      // The 003 set_updated_at trigger fires on the backfill and moves
      // updated_at -- a side effect the header must name, not hide.
      expect(text).toMatch(/set_updated_at/);
    });
  });

  // 096 is sprint 26's backfill behind the employer unread badge. It adds NO
  // schema: job_conversations.employer_last_read_at has existed since 028:37
  // and nothing ever wrote it, so every row carries NULL and the badge would
  // light up EVERY thread a worker has ever replied to on the day it ships.
  // The file's whole job is to stamp that history, and it inherits the same
  // trap 094/095 do -- jale_admin owns job_conversations, 025 FORCEs RLS on
  // it, and both policies are GUC-keyed, so the backfill rewrites ZERO rows
  // and reports success unless the file un-forces first.
  describe('096 backfills employer_last_read_at under FORCE RLS', () => {
    const sql = () => fs.readFileSync(
      path.join(migrationsDir, '096_job_conversations_employer_read_backfill.sql'), 'utf8',
    );

    it('runs as jale_admin in ONE transaction and adds no schema', () => {
      const text = sql();
      expect(text).toContain('Connect as jale_admin');
      expect(text.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(text.match(/^COMMIT;$/gm)).toHaveLength(1);
      // The column is 028's. A file that re-adds it would be claiming
      // provenance it does not have.
      expect(text).not.toMatch(/ADD COLUMN/i);
      expect(text).toMatch(/028/);
    });

    it('un-forces, backfills and re-forces exactly job_conversations (028/094/095 pattern)', () => {
      const text = sql();
      const noForce = text.indexOf('ALTER TABLE job_conversations NO FORCE ROW LEVEL SECURITY');
      const update = text.indexOf('UPDATE job_conversations');
      const reForce = text.indexOf('ALTER TABLE job_conversations FORCE ROW LEVEL SECURITY');
      expect(noForce).toBeGreaterThan(-1);
      expect(update).toBeGreaterThan(noForce);
      expect(reForce).toBeGreaterThan(update);
      // Exactly one un-force and one re-force, and on no other table.
      expect(text.match(/NO FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
      expect(text.match(/ALTER TABLE \w+ FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
      // And job_conversation_messages is not OPERATED ON at all -- not
      // un-forced, not written. Reading it would have meant a second FORCE-RLS
      // bracket and a second ACCESS EXCLUSIVE lock on the larger table, which
      // was judged too much for an informational count (see the file's "WHY NO
      // STILL UNREAD COUNT IS REPORTED" section). Mentions in COMMENTS are
      // fine and expected, so this checks statements, not the whole text.
      expect(text.match(/ALTER TABLE job_conversation_messages/g)).toBeNull();
      expect(text.match(/UPDATE job_conversation_messages/g)).toBeNull();
      expect(text.match(/FROM job_conversation_messages/g)).toBeNull();
      // `row_security = off` is a no-op for a FORCEd owner -- the trap this
      // repo has hit before. It must not appear as the mechanism.
      expect(text).not.toMatch(/SET\s+row_security\s*=\s*off/i);
    });

    it('gates the backfill on NULL so a replay updates zero rows', () => {
      const text = sql();
      expect(text).toMatch(/WHERE employer_last_read_at IS NULL/);
      // created_at is NOT NULL (025:14), which is what makes the stamp
      // expression total and the zero-NULLs self-check assertable.
      expect(text).toMatch(/GREATEST\(/);
      expect(text).toMatch(/COALESCE\(last_message_at, created_at\)/);
      expect(text).toMatch(/COALESCE\(last_worker_message_at, created_at\)/);
      expect(text).toMatch(/GET DIAGNOSTICS/);
      expect(text).toMatch(/RAISE NOTICE 'migration 096: conversations stamped/);
    });

    // 094's lesson, restated: once FORCE is back on, jale_admin's own SELECTs
    // obey the same GUC-keyed policies and return zero rows, so a data check
    // placed after the re-force can never fail however broken the backfill was.
    it('puts the DATA self-check inside the un-forced window and the CATALOG check after it', () => {
      const text = sql();
      const noForce = text.indexOf('NO FORCE ROW LEVEL SECURITY');
      const reForce = text.indexOf('ALTER TABLE job_conversations FORCE ROW LEVEL SECURITY');
      const unforcedWindow = text.slice(noForce, reForce);
      const afterReForce = text.slice(reForce);

      expect(unforcedWindow).toContain('migration 096: % conversation(s) still carry a NULL employer_last_read_at');
      // The precondition that catches a deleted/failed NO FORCE, which the
      // NULL count alone reads as a perfect success.
      expect(unforcedWindow).toContain('migration 096: job_conversations is still FORCE RLS');
      expect(afterReForce).toContain('migration 096: job_conversations lost RLS ENABLE + FORCE');
      expect(afterReForce).not.toContain('still carry a NULL employer_last_read_at');
    });

    // The residual-unread count is REPORTED, never asserted: on a replay after
    // the badge ships it is legitimately non-zero, and an assertion would make
    // --force-replay fail on perfectly correct data.
    // The file reports how many rows it STAMPED, and nothing else. It used to
    // also report how many still read as unread, by the pre-round-2
    // last_worker_message_at rule -- which over-counted by exactly the
    // opened-but-never-wrote population (openWorkerConversation stamps that
    // column with no message row), so an operator would read a false non-zero
    // as "the backfill failed". Re-stating it in the badge's real terms means
    // reading job_conversation_messages, and that needs its own FORCE-RLS
    // bracket; not worth it for a number nothing acts on. Absent, and
    // explained in the header, is the settled answer -- these assertions stop
    // either version coming back by accident.
    it('reports the rows it stamped, and does NOT report a residual unread count', () => {
      const text = sql();
      expect(text).toMatch(/RAISE NOTICE 'migration 096: conversations stamped/);
      expect(text).not.toMatch(/RAISE NOTICE[^;]*still reading as unread/);
      // Specifically not by the superseded rule, which is the version that
      // would mislead rather than merely go quiet.
      expect(text).not.toMatch(/last_worker_message_at > employer_last_read_at\s*\)?\s*;/);
      // The header has to say WHY it is missing, or the next reader adds it
      // back and re-discovers the FORCE-RLS trap the hard way.
      expect(text).toMatch(/WHY NO "STILL UNREAD" COUNT IS REPORTED/);
      expect(text).toMatch(/sees ZERO message rows/i);
    });

    it('issues no GRANT, and proves the table-level one it relies on', () => {
      const text = sql();
      // 025:78's table-level grant already covers the column; a GRANT here
      // would imply the mark-read endpoint needed a new privilege.
      expect(text).not.toMatch(/^GRANT /m);
      expect(text).toContain("has_column_privilege('jale_admin', 'public.job_conversations', 'employer_last_read_at', 'UPDATE')");
      expect(text).toContain("has_column_privilege('jale_admin', 'public.job_conversations', 'employer_last_read_at', 'SELECT')");
    });

    it('documents the rule the badge actually uses', () => {
      const text = sql();
      // The file's rationale must name the rule it is protecting, or the next
      // reader "fixes" the backfill to match a formula that no longer ships.
      expect(text).toMatch(/last_inbound_message_at > employer_last_read_at/);
      expect(text).toMatch(/openWorkerConversation/);
      // ...including WHY a column-derived stamp is sound against a
      // message-derived rule: one transaction writes both.
      expect(text).toMatch(/SAME TRANSACTION/i);
    });

    it('documents its deploy order, its lock window and the trigger side effect', () => {
      const text = sql();
      expect(text).toMatch(/AFTER 095/);
      // Order-free for the schema, but employer-visible: applied after the
      // code deploy, every employer sees the wall of stale badges.
      expect(text).toMatch(/BEFORE the code deploy/i);
      expect(text).toMatch(/ACCESS EXCLUSIVE/);
      // 025:74-76's unconditional trigger moves updated_at on every row the
      // backfill touches -- named, not hidden.
      expect(text).toMatch(/set_updated_at/);
      // The replay-after-ship hazard is the one thing a reader must not miss.
      expect(text).toMatch(/force-replay/);
    });
  });
  // 097 is the sprint-26 hotfix behind WhatsAppStatusCallbackUnknownSid. An
  // employer -> worker invite is a TEMPLATE send: job-messaging.ts writes the
  // Twilio SID to job_message_outbox.twilio_message_sid ONLY, because the
  // job_conversation_messages row has to stay 'waiting_worker_reply' until the
  // worker replies. 040's unified callback only knew whatsapp_outbox and
  // job_conversation_messages, so every such callback came back unmatched and
  // the Lambda returned a retryable 503 that paged an alarm. 097 adds a third
  // correlation branch -- and, because the callback function is owned by the
  // NOLOGIN jale_twilio_callback helper and jale_admin holds it with
  // SET FALSE / INHERIT FALSE, the file must re-borrow the role exactly the
  // way 042 and 043 do or the CREATE OR REPLACE cannot run at all.
  describe('097 correlates Twilio callbacks through job_message_outbox', () => {
    const sql = () => fs.readFileSync(
      path.join(migrationsDir, '097_twilio_callback_job_message_outbox.sql'), 'utf8',
    );

    it('runs as jale_admin in ONE transaction and explains the bug', () => {
      const text = sql();
      expect(text).toContain('Connect as: jale_admin');
      expect(text.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(text.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(text).toMatch(/WhatsAppStatusCallbackUnknownSid/);
      expect(text).toMatch(/job-messaging\.ts/);
      expect(text).toMatch(/503/);
    });

    it('adds the SID correlation index on job_message_outbox', () => {
      expect(sql()).toContain(
        'CREATE INDEX IF NOT EXISTS idx_job_message_outbox_twilio_message_sid\n'
        + '  ON public.job_message_outbox (twilio_message_sid)\n'
        + '  WHERE twilio_message_sid IS NOT NULL;',
      );
    });

    it('grants the helper role column-scoped access only, with its own policies', () => {
      const text = sql();
      // REVOKE first, or a re-apply cannot converge on the exact ACL the
      // self-audit at the bottom of the file asserts.
      expect(text).toContain('REVOKE ALL ON public.job_message_outbox FROM jale_twilio_callback;');
      expect(text).toContain(
        'GRANT SELECT (id, message_id, send_kind, status, twilio_message_sid, last_error),\n'
        + '      UPDATE (status, last_error)\n'
        + '  ON public.job_message_outbox TO jale_twilio_callback;',
      );
      // A whole-table grant would hand the helper the employer's message body
      // and content_variables.
      expect(text).not.toMatch(/GRANT SELECT ON public\.job_message_outbox/);
      expect(text).toContain('DROP POLICY IF EXISTS job_outbox_twilio_callback_select ON public.job_message_outbox;');
      expect(text).toContain('DROP POLICY IF EXISTS job_outbox_twilio_callback_update ON public.job_message_outbox;');
      expect(text).toMatch(
        /CREATE POLICY job_outbox_twilio_callback_select ON public\.job_message_outbox\s+FOR SELECT TO jale_twilio_callback USING \(true\);/,
      );
      expect(text).toMatch(
        /CREATE POLICY job_outbox_twilio_callback_update ON public\.job_message_outbox\s+FOR UPDATE TO jale_twilio_callback USING \(true\) WITH CHECK \(true\);/,
      );
    });

    it('re-borrows the helper role to replace the locked callback, then gives it back', () => {
      const text = sql();
      const borrow = text.indexOf("GRANT jale_twilio_callback TO %I WITH SET TRUE, INHERIT FALSE");
      const setRole = text.indexOf('SET LOCAL ROLE jale_twilio_callback;');
      const replace = text.indexOf('CREATE OR REPLACE FUNCTION jale_twilio_callback.record_twilio_delivery_status');
      const reset = text.indexOf('RESET ROLE;');
      const giveBack = text.indexOf("GRANT jale_twilio_callback TO %I WITH SET FALSE, INHERIT FALSE");
      expect(borrow).toBeGreaterThan(-1);
      expect(setRole).toBeGreaterThan(borrow);
      expect(replace).toBeGreaterThan(setRole);
      expect(reset).toBeGreaterThan(replace);
      expect(giveBack).toBeGreaterThan(reset);
      // 040's self-audit demands exactly one membership row afterwards.
      expect(text).toContain("REVOKE jale_twilio_callback FROM %I GRANTED BY %I");
    });

    it('keeps the locked function hardened and the signature identical', () => {
      const text = sql();
      expect(text).toMatch(/RETURNS TABLE \(matched BOOLEAN, changed BOOLEAN, source TEXT\)/);
      expect(text).toContain('SET search_path = pg_catalog, pg_temp');
      expect(text).toContain('SECURITY DEFINER');
      expect(text).toContain(
        'ALTER FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)\n'
        + '  OWNER TO jale_twilio_callback;',
      );
      expect(text).toContain(
        'REVOKE ALL ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)',
      );
      expect(text).toContain(
        'GRANT EXECUTE ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)\n'
        + '  TO jale_whatsapp;',
      );
      // Relation names stay fully qualified: the catalog-only search_path is
      // the whole point of the locked schema.
      expect(text).toContain('FROM public.job_message_outbox o');
      expect(text).toContain('UPDATE public.job_message_outbox');
      expect(text).toContain('UPDATE public.job_conversation_messages');
    });

    it('keeps the first two branches intact and only falls through when both miss', () => {
      const text = sql();
      const whatsapp = text.indexOf("RETURN QUERY SELECT true, v_whatsapp.changed, 'whatsapp_outbox'::TEXT;");
      const branch2 = text.indexOf("RETURN QUERY SELECT true, v_job_changed, 'job_message_outbox'::TEXT;");
      const branch3 = text.indexOf('FROM public.job_message_outbox o');
      expect(whatsapp).toBeGreaterThan(-1);
      expect(branch2).toBeGreaterThan(whatsapp);
      expect(branch3).toBeGreaterThan(branch2);
      // Branch 3 only changes state on a terminal failure landing on a row
      // still believed 'sent'; message_id is nullable (025 ON DELETE SET NULL).
      expect(text).toMatch(/IF v_status IN \('failed', 'undelivered'\) AND v_outbox_status = 'sent' THEN/);
      expect(text).toMatch(/IF v_outbox_message_id IS NOT NULL THEN/);
      expect(text).toMatch(/AND status IN \('queued', 'waiting_worker_reply'\)/);
      expect(text).toMatch(/COALESCE\(\s*NULLIF\(CONCAT_WS\(' '/);
      // The unknown SID must still report unmatched so the Lambda can 503.
      expect(text).toContain('RETURN QUERY SELECT false, false, NULL::TEXT;');
    });

    it('fails closed on ownership, hardening, policy and ACL drift', () => {
      const text = sql();
      expect(text).toMatch(/migration 097: unified callback must be owned by jale_twilio_callback, SECURITY DEFINER/);
      expect(text).toMatch(/migration 097: job_message_outbox SID correlation index is missing/);
      expect(text).toMatch(/migration 097: job_message_outbox Twilio callback RLS policies missing/);
      expect(text).toMatch(/migration 097: jale_twilio_callback must hold column-scoped privileges only/);
      expect(text).toMatch(/migration 097: jale_twilio_callback holds unexpected job_message_outbox column privileges/);
      expect(text).toMatch(/migration 097: unified callback execute ACL drift/);
      expect(text).toContain('information_schema.column_privileges');
      expect(text).toMatch(/proconfig @> ARRAY\['search_path=pg_catalog, pg_temp'\]/);
      expect(text).toMatch(/prosecdef/);
    });
  });

  // 103 is sprint 27's referred-jobs list: one row per (worker, job) the
  // worker came to Jale for, read by the feed pin and the web Done screen.
  // Like 094-096 it backfills from FORCE RLS tables, so the
  // un-force bracket and where each self-check sits are pinned here; the
  // worker-referred-jobs-103 DB suite proves them on real PostgreSQL.
  describe('103 creates worker_referred_jobs and backfills it under FORCE RLS', () => {
    const sql = () => fs.readFileSync(
      path.join(migrationsDir, '103_worker_referred_jobs.sql'), 'utf8',
    );
    // The header names tables, roles and DELETE in prose; statement
    // assertions read the SQL only (the 071 approach).
    const statements = () => sql().replace(/--.*$/gm, '');

    it('runs as jale_admin in ONE transaction', () => {
      const text = sql();
      expect(text).toMatch(/Run manually AFTER 102_admin_identity_lockouts\.sql/);
      expect(text).toContain('connected as jale_admin.');
      expect(text).toContain('Forward-only (ADR-005)');
      expect(text.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(text.match(/^COMMIT;$/gm)).toHaveLength(1);
    });

    it('creates the table replay-safely, with CASCADE foreign keys and the recency index', () => {
      const text = statements();
      expect(text).toContain('CREATE TABLE IF NOT EXISTS worker_referred_jobs (');
      expect(text).toMatch(/worker_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE,/);
      expect(text).toMatch(/job_id\s+UUID NOT NULL REFERENCES jobs\(id\) ON DELETE CASCADE,/);
      expect(text).toContain("('share_link', 'job_page', 'whatsapp_token', 'typed_code', 'backfill')");
      expect(text).toContain('PRIMARY KEY (worker_id, job_id)');
      expect(text).toMatch(
        /CREATE INDEX IF NOT EXISTS \w+\s+ON worker_referred_jobs \(worker_id, last_seen_at DESC\);/,
      );
      // Employers hard-delete jobs: RESTRICT would turn every delete into an error.
      expect(text).not.toMatch(/RESTRICT/);
      // The table has no share-code column.
      const table = text.slice(
        text.indexOf('CREATE TABLE IF NOT EXISTS worker_referred_jobs ('),
        text.indexOf('CREATE INDEX IF NOT EXISTS'),
      );
      expect(table).toContain('PRIMARY KEY (worker_id, job_id)');
      expect(table).not.toMatch(/share_code/);
    });

    // Decided 2026-10-01: two referral-schema bugs found while building 103 are
    // folded into it. (1) 056's first-touch trigger rejected the UPDATE that
    // first_job_id's ON DELETE SET NULL performs, so no employer could
    // hard-delete a job that was any worker's first-touch referral. (2)
    // claimed_worker_id's SET NULL left claimed_at behind, which the coherence
    // CHECK rejects, so no worker who had claimed a referral could be deleted.
    // The DB suite proves both through the real delete paths.
    it('lets a deleted job leave first_job_id, and only that first-touch change', () => {
      const text = statements();
      expect(text).toContain(
        'CREATE OR REPLACE FUNCTION worker_attribution_reject_first_touch_change()',
      );
      // CREATE OR REPLACE keeps 056's trigger binding: the trigger itself is
      // never dropped or re-created here.
      expect(text).not.toMatch(/(DROP|CREATE) TRIGGER/);
      const body = text.slice(
        text.indexOf('CREATE OR REPLACE FUNCTION worker_attribution_reject_first_touch_change()'),
      ).replace(/\s+/g, ' ');
      expect(body).toContain(
        'OR (NEW.first_job_id IS DISTINCT FROM OLD.first_job_id '
        + 'AND NOT (OLD.first_job_id IS NOT NULL AND NEW.first_job_id IS NULL))',
      );
      // 063's unconditional first_job_id comparison is gone...
      expect(body).not.toMatch(/OR NEW\.first_job_id\s+IS DISTINCT FROM OLD\.first_job_id OR/);
      // ...and every other first_* column is still compared as 063 did.
      for (const column of [
        'first_share_code', 'first_channel', 'first_referrer_worker_id',
        'first_referrer_employer_id', 'first_seen_at',
      ]) {
        expect(body).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
      }
      expect(body).toContain("USING ERRCODE = 'restrict_violation'");
    });

    it("re-creates claimed_worker_id's foreign key as ON DELETE CASCADE, by its catalog name, keeping the CHECK", () => {
      const text = statements();
      const drop = text.indexOf(
        'ALTER TABLE referral_pending_claims\n'
        + '    DROP CONSTRAINT IF EXISTS referral_pending_claims_claimed_worker_id_fkey;',
      );
      const add = text.indexOf(
        'ALTER TABLE referral_pending_claims\n'
        + '    ADD CONSTRAINT referral_pending_claims_claimed_worker_id_fkey\n'
        + '    FOREIGN KEY (claimed_worker_id) REFERENCES users(id) ON DELETE CASCADE;',
      );
      expect(drop).toBeGreaterThan(-1);
      expect(add).toBeGreaterThan(drop);
      // The swap takes ACCESS EXCLUSIVE on users (the FK's RI triggers live
      // there), so it comes first: users is never lock-upgraded mid-transaction.
      expect(drop).toBeLessThan(text.indexOf('CREATE TABLE IF NOT EXISTS worker_referred_jobs ('));
      // The coherence CHECK is what made SET NULL fail; it stays.
      expect(text).not.toMatch(/DROP CONSTRAINT[^;]*claimed_coherent/);
      expect(text.match(/DROP CONSTRAINT/g)).toHaveLength(1);
    });

    it('fails closed if either repair is missing or drifts', () => {
      const text = sql();
      expect(text).toContain(
        'migration 103: worker_attribution_reject_first_touch_change must allow only first_job_id -> NULL',
      );
      expect(text).toContain('migration 103: worker_attribution_first_touch_immutable trigger is not bound as BEFORE UPDATE FOR EACH ROW');
      expect(text).toContain(
        'migration 103: referral_pending_claims.claimed_worker_id must have exactly one foreign key, to users ON DELETE CASCADE',
      );
      expect(text).toContain('migration 103: referral_pending_claims_claimed_coherent is missing');
      expect(text).toContain("confdeltype = 'c'");
    });

    // Every job parked on a phone before sign-in is kept until the claim: the
    // jobs a later code replaced ride on the claim row, beside the current job.
    it('adds the parked-job set to referral_pending_claims replay-safely, after the claim key swap, and checks it', () => {
      const text = statements();
      const add = text.indexOf(
        'ALTER TABLE referral_pending_claims\n'
        + "    ADD COLUMN IF NOT EXISTS earlier_job_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];",
      );
      expect(add).toBeGreaterThan(-1);
      // Same lock as the swap before it, so referral_pending_claims is never
      // lock-upgraded later in the transaction.
      expect(add).toBeGreaterThan(text.indexOf('FOREIGN KEY (claimed_worker_id) REFERENCES users(id) ON DELETE CASCADE;'));
      expect(add).toBeLessThan(text.indexOf('CREATE TABLE IF NOT EXISTS worker_referred_jobs ('));
      expect(text.match(/ADD COLUMN/g)).toHaveLength(1);
      // The backfill never reads the set: it names jobs only, with no key to jobs.
      const backfill = text.slice(text.indexOf('INSERT INTO worker_referred_jobs'), text.indexOf('GET DIAGNOSTICS'));
      expect(backfill).not.toContain('earlier_job_ids');
      expect(sql()).toContain('migration 103: referral_pending_claims.earlier_job_ids must be a NOT NULL uuid[] defaulting to empty');
    });

    it('grants SELECT, INSERT, UPDATE to both roles and DELETE to nobody', () => {
      const text = statements();
      expect(text.match(/^GRANT /gm)).toHaveLength(1);
      expect(text).toContain(
        'GRANT SELECT, INSERT, UPDATE ON worker_referred_jobs TO jale_admin, jale_whatsapp;',
      );
      expect(text).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b/);
      // ...and does not take the OWNER's DELETE away either: an ON DELETE
      // CASCADE runs as the referencing table's owner, so that revoke would
      // make every job hard-delete and every account delete a 42501.
      expect(text).not.toMatch(/REVOKE/);
    });

    it('names its role with TO on both policies and reads neither jobs nor job_applications in them', () => {
      const text = statements();
      expect(text).toContain('ALTER TABLE worker_referred_jobs ENABLE ROW LEVEL SECURITY;');
      expect(text.match(/DROP POLICY IF EXISTS \w+ ON worker_referred_jobs;/g)).toHaveLength(2);

      const policies = text.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
      expect(policies).toHaveLength(2);
      for (const policy of policies) {
        expect(policy).toMatch(/\bFOR ALL TO (jale_admin|jale_whatsapp)\b/);
        // The 038 recursion class.
        expect(policy).not.toMatch(/\bjobs\b|\bjob_applications\b/);
      }

      const admin = policies.find((policy) => /TO jale_admin\b/.test(policy))!;
      expect(admin).toMatch(/^CREATE POLICY worker_referred_jobs_owner ON worker_referred_jobs\b/);
      expect(admin.match(
        /worker_id = \(SELECT id FROM users\s+WHERE cognito_sub = current_setting\('app\.current_user_id', true\)\)/g,
      )).toHaveLength(2);

      const whatsapp = policies.find((policy) => /TO jale_whatsapp\b/.test(policy))!;
      expect(whatsapp).toMatch(/^CREATE POLICY worker_referred_jobs_whatsapp ON worker_referred_jobs\b/);
      // ::text, so the empty string a warm pooled connection carries is a
      // non-match rather than a 22P02.
      expect(whatsapp.match(
        /worker_id::text = current_setting\('app\.current_internal_user_id', true\)/g,
      )).toHaveLength(2);
    });

    it('un-forces, backfills and re-forces both sources and the new table (096 pattern)', () => {
      const text = statements();
      const insert = text.indexOf('INSERT INTO worker_referred_jobs');
      expect(insert).toBeGreaterThan(-1);
      for (const table of ['worker_attribution', 'referral_pending_claims', 'worker_referred_jobs']) {
        const noForce = text.indexOf(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
        const reForce = text.indexOf(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        expect(noForce).toBeGreaterThan(-1);
        expect(insert).toBeGreaterThan(noForce);
        expect(reForce).toBeGreaterThan(insert);
      }
      // Exactly those three, each once.
      expect(text.match(/NO FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
      expect(text.match(/ALTER TABLE \w+ FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
      // `row_security = off` lifts no policy; it makes an affected query fail.
      expect(text).not.toMatch(/row_security/);
    });

    it('backfills from both sources without reading jobs, one row per pair', () => {
      const text = statements();
      // The foreign keys guarantee existence.
      expect(text).not.toMatch(/\b(FROM|JOIN)\s+(public\.)?jobs\b/);
      expect(text).toMatch(/FROM worker_attribution wa\s+WHERE wa\.first_job_id IS NOT NULL/);
      expect(text).toMatch(/FROM worker_attribution wa\s+WHERE wa\.latest_job_id IS NOT NULL/);
      expect(text).toMatch(/FROM referral_pending_claims rpc\s+WHERE rpc\.claimed_worker_id IS NOT NULL/);
      expect(text).toMatch(/SELECT src\.worker_id, src\.job_id, 'backfill', min\(src\.seen_at\), max\(src\.seen_at\)/);
      // One INSERT ... ON CONFLICT DO UPDATE cannot touch a row twice (21000),
      // and first_job_id = latest_job_id is the common case.
      expect(text).toContain('GROUP BY src.worker_id, src.job_id');
      expect(text).toContain('ON CONFLICT (worker_id, job_id) DO UPDATE');
      expect(text).toContain(
        'SET first_seen_at = LEAST(worker_referred_jobs.first_seen_at, EXCLUDED.first_seen_at)',
      );
      expect(text).toContain(
        'last_seen_at  = GREATEST(worker_referred_jobs.last_seen_at, EXCLUDED.last_seen_at)',
      );
      // A conflict widens the window and nothing else: the source a door
      // recorded is never rewritten to 'backfill'.
      const doUpdate = text.slice(text.indexOf('DO UPDATE'), text.indexOf('GET DIAGNOSTICS'));
      expect(doUpdate).not.toMatch(/\bsource\b/);
      expect(text).toMatch(/GET DIAGNOSTICS v_rows = ROW_COUNT;/);
      expect(text).toMatch(/RAISE NOTICE 'migration 103: /);
    });

    // 094's lesson: on the bed, once FORCE is back on, the migration
    // connection's reads come back empty, so a data check after the re-force
    // could never fail.
    it('asserts its DATA inside the un-forced window and its CATALOG state after it', () => {
      const text = sql();
      const window = text.slice(
        text.indexOf('ALTER TABLE worker_attribution NO FORCE ROW LEVEL SECURITY;'),
        text.indexOf('ALTER TABLE worker_attribution FORCE ROW LEVEL SECURITY;'),
      );
      const after = text.slice(text.indexOf('ALTER TABLE worker_attribution FORCE ROW LEVEL SECURITY;'));

      expect(window).toContain('migration 103: % is still FORCE RLS');
      expect(window).toContain('migration 103: % referred (worker, job) pair(s) are missing');
      expect(window.indexOf('migration 103: % is still FORCE RLS'))
        .toBeLessThan(window.indexOf('INSERT INTO worker_referred_jobs'));
      expect(after).toContain('migration 103: % lost RLS ENABLE + FORCE');
      expect(after).not.toContain('pair(s) are missing');
    });

    it('fails closed on RLS, privilege, ownership and policy drift', () => {
      const text = sql();
      expect(text).toContain("ARRAY['worker_attribution', 'referral_pending_claims', 'worker_referred_jobs']");
      expect(text).toContain('relrowsecurity AND rel.relforcerowsecurity');
      expect(text).toContain("ARRAY['jale_admin', 'jale_whatsapp']");
      expect(text).toContain("ARRAY['SELECT', 'INSERT', 'UPDATE']");
      expect(text).toContain('migration 103: % lacks % on worker_referred_jobs');
      expect(text).toContain('migration 103: worker_referred_jobs must be owned by jale_admin');
      expect(text).toContain("has_table_privilege('jale_whatsapp', 'public.worker_referred_jobs', 'DELETE')");
      expect(text).toContain('aclexplode');
      expect(text).toContain('migration 103: a role other than the owner holds DELETE or TRUNCATE');
      expect(text).toContain('migration 103: worker_referred_jobs must carry both of its policies');
      expect(text).toContain('migration 103: worker_referred_jobs carries a policy other than its two and their reviewed copies');
      // A later migration's reviewed copies of the two policies are accepted
      // by exact name only, never by a pattern on the name.
      for (const copy of ['worker_referred_jobs_owner__api', 'worker_referred_jobs_owner__dg',
                          'worker_referred_jobs_whatsapp__api', 'worker_referred_jobs_whatsapp__dg']) {
        expect(text).toContain(`'${copy}'`);
      }
      expect(text).not.toMatch(/polname\s+(NOT\s+)?(I?LIKE|SIMILAR\s+TO|~)/i);
      expect(text).toContain('migration 103: worker_referred_jobs_owner must be FOR ALL TO jale_admin');
      expect(text).toContain('migration 103: worker_referred_jobs_whatsapp must be FOR ALL TO jale_whatsapp');
      expect(text).toMatch(/polroles = ARRAY\[\(SELECT oid FROM pg_catalog\.pg_roles WHERE rolname = 'jale_admin'\)\]/);
      expect(text).toMatch(/polroles = ARRAY\[\(SELECT oid FROM pg_catalog\.pg_roles WHERE rolname = 'jale_whatsapp'\)\]/);
    });

    it('documents its deploy order, its lock window and why the new table is un-forced too', () => {
      const text = sql();
      expect(text).toMatch(/DEPLOY ORDER: apply this migration BEFORE the code deploy/);
      expect(text).toMatch(/bastion runbook/);
      expect(text).toMatch(/ACCESS EXCLUSIVE/);
      expect(text).toMatch(/SHARE ROW EXCLUSIVE/);
      // A replay finds the new table FORCEd by the first apply.
      expect(text).toMatch(/replay finds it FORCEd/);
      expect(text).toMatch(/21000/);
      // Dropping the claim FK locks users itself, reads included.
      expect(text).toMatch(/ACCESS EXCLUSIVE on users/);
      // The first-touch credit outlives the job.
      expect(text).toMatch(/credit survives/i);
    });
  });

  // 104-106 are sprint 27's least-privilege database access: dedicated
  // logins (104), capability functions (105) and the manifest-generated
  // access rights (106). The manifest (infra/db/access/manifest.json) is the
  // reviewed source of truth for the logins, owners and functions, so these
  // text checks read their expectations from it rather than restating them.
  describe('104-105 least-privilege logins and capability functions', () => {
    const manifest = () => JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'db', 'access', 'manifest.json'), 'utf8',
    )) as {
      master: string;
      logins: Record<string, { kind: string; connection_limit: number; created_by: string; settings?: Record<string, string> }>;
      capability_owners: Record<string, { reason: string }>;
      groups: Record<string, { reason: string }>;
      functions: Record<string, { owner: string; security: string; execute: string[]; created_by?: string }>;
    };
    const read = (name: string) => fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    // Statement assertions read the SQL only: the headers explain roles,
    // passwords and SET ROLE in prose.
    const sqlOnly = (text: string) => text.replace(/--.*$/gm, '');
    const newLogins = () => Object.entries(manifest().logins).filter(([, l]) => l.created_by === '104');
    const capFunctions = () => Object.entries(manifest().functions).filter(([, f]) => f.created_by === '105');

    describe('104_least_privilege_logins.sql', () => {
      const text = () => read('104_least_privilege_logins.sql');

      it('runs after 103 as jale_admin in ONE transaction with a lock timeout', () => {
        const t = text();
        expect(t).toMatch(/Run manually AFTER 103_worker_referred_jobs\.sql/);
        expect(t).toContain('connected as jale_admin.');
        expect(t).toContain('Forward-only (ADR-005)');
        expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
        expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
        expect(t.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(t.indexOf('BEGIN;'));
      });

      it('describes in its header the logins it creates, and the deploy order', () => {
        const t = text();
        expect(t).toContain("The logins this file creates are the workloads' own; none owns a table.");
        expect(t).not.toContain('NOT the RDS master user');
        expect(t).toMatch(/DEPLOY ORDER: apply this migration BEFORE the release deploy/);
      });

      it('creates every new login with the least-privilege attributes, its connection limit and no password', () => {
        const t = sqlOnly(text());
        const logins = newLogins();
        expect(logins.map(([name]) => name).sort()).toEqual([
          'jale_api', 'jale_api_public', 'jale_job_digest', 'jale_job_email_sender',
          'jale_job_retention', 'jale_job_ses_feedback', 'jale_job_visibility_drain', 'jale_posture',
        ]);
        expect(t).toContain('LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT');
        for (const [name, login] of logins) {
          expect(t).toMatch(new RegExp(`\\('${name}',\\s*${login.connection_limit}\\)`));
        }
        // No password ever reaches a migration: logins cannot sign in until
        // credential preparation sets a SCRAM verifier out of band.
        expect(t).not.toMatch(/PASSWORD/i);
        // Upper-case keyword only: rolbypassrls/rolinherit are catalog columns.
        expect(t).not.toMatch(/(?<!NO)BYPASSRLS/);
        // Existing roles are validated and refused, never altered: the only
        // ALTER ROLE statements set the idle-transaction timeout.
        expect(t.replace(/^ALTER ROLE \w+ SET idle_in_transaction_session_timeout = '60s';$/gm, ''))
          .not.toMatch(/\bALTER\s+ROLE\b/i);
        expect(t).toContain('migration 104: existing login % has unexpected attributes');
        expect(t).toContain('migration 104: login % must not be a member of any role');
      });

      it('ends idle-in-transaction sessions after 60s on every login the manifest marks, and on no other', () => {
        const t = sqlOnly(text());
        const marked = newLogins()
          .filter(([, login]) => login.settings?.idle_in_transaction_session_timeout === '60s')
          .map(([name]) => name)
          .sort();
        expect(marked).toEqual([
          'jale_api', 'jale_api_public', 'jale_job_digest', 'jale_job_email_sender',
          'jale_job_retention', 'jale_job_ses_feedback', 'jale_job_visibility_drain',
        ]);
        for (const name of marked) {
          expect(t).toContain(`ALTER ROLE ${name} SET idle_in_transaction_session_timeout = '60s';`);
        }
        expect(t.match(/^ALTER ROLE \w+ SET /gm)).toHaveLength(marked.length);
        expect(t).toContain('migration 104: login % does not carry its role settings');
      });

      it('creates the capability owners and the operator group as NOLOGIN roles', () => {
        const t = sqlOnly(text());
        const owners = Object.keys(manifest().capability_owners).sort();
        expect(owners).toEqual([
          'jale_cap_hired_counts', 'jale_cap_job_messaging', 'jale_cap_retention', 'jale_cap_ses_feedback',
          'jale_cap_share_links', 'jale_cap_stale_outbox', 'jale_cap_upload_tokens', 'jale_cap_worker_lane',
        ]);
        expect(Object.keys(manifest().groups)).toEqual(['jale_ops_readonly']);
        expect(t).toContain('NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
        for (const role of [...owners, 'jale_ops_readonly']) expect(t).toContain(`'${role}'`);
        expect(t).toContain('migration 104: existing role % has unsafe attributes');
        expect(t).toContain('migration 104: role % has unsafe memberships');
      });

      it('creates jale_cap owned by jale_admin, closed to PUBLIC, and grants CONNECT by database name lookup', () => {
        const t = sqlOnly(text());
        expect(t).toContain('CREATE SCHEMA jale_cap AUTHORIZATION jale_admin');
        expect(t).toContain('REVOKE ALL ON SCHEMA jale_cap FROM PUBLIC;');
        expect(t).toContain("GRANT CONNECT ON DATABASE %I TO %I', current_database()");
        expect(t).not.toMatch(/ON DATABASE jale\b/);
        expect(t).toContain('migration 104: jale_cap must be owned by jale_admin and closed to PUBLIC');
      });

      it('pins the eight unpinned definers, revokes the trigger function from PUBLIC and drops the SET membership', () => {
        const t = sqlOnly(text());
        for (const fn of [
          'assign_worker_thread_number(uuid)', 'enqueue_job_visibility_event(uuid, text, text)',
          'list_jobs_missing_geo()', 'list_stale_job_outbox_workers(interval)', 'public_job_company(uuid)',
          'public_referrer_context(text, text)', 'set_job_geo(uuid, text, text)', 'sync_job_hired_counts()',
        ]) expect(t).toContain(`'public.${fn}'`);
        expect(t).toContain("SET search_path = pg_catalog, public, pg_temp");
        expect(t).toContain('REVOKE EXECUTE ON FUNCTION public.sync_job_hired_counts() FROM PUBLIC');
        expect(t).toContain('REVOKE jale_location_backfill FROM %I GRANTED BY %I');
        expect(t).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE jale_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;');
        expect(t).toContain('migration 104: definer % still lacks a search_path ending in pg_temp');
        expect(t).toContain('migration 104: jale_admin still holds a SET membership in jale_location_backfill');
        expect(t).toContain('migration 104: new functions would still be executable by PUBLIC');
      });

      it('revokes TEMPORARY on the database from PUBLIC, and proves no new login keeps it', () => {
        const t = sqlOnly(text());
        expect(t).toContain("EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());");
        expect(t).not.toMatch(/GRANT\s+(TEMP|TEMPORARY|ALL)\b[^;]*ON DATABASE/i);
        expect(t).toContain('migration 104: PUBLIC still holds TEMPORARY on the database');
        expect(t).toContain('migration 104: login % holds TEMPORARY on the database');
        expect(text()).toContain('The master keeps TEMPORARY as the database owner');
      });

      it('never switches role', () => {
        const t = sqlOnly(text());
        expect(t).not.toMatch(/\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i);
        expect(t).not.toMatch(/\bRESET\s+ROLE\b/i);
      });
    });

    describe('106_least_privilege_access_rights.sql', () => {
      const text = () => read('106_least_privilege_access_rights.sql');
      const createPolicies = () => sqlOnly(text()).split('CREATE POLICY ').slice(1)
        .map((block) => block.slice(0, block.indexOf(';')));

      it('runs after 105 as jale_admin in ONE transaction, generated from the manifest', () => {
        const t = text();
        expect(t).toMatch(/Run manually AFTER 105_least_privilege_capability_functions\.sql/);
        expect(t).toContain('connected as jale_admin.');
        expect(t).toContain('GENERATED by infra/db/access/generate.ts');
        expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
        expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
        expect(t.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(t.indexOf('BEGIN;'));
        expect(t).toContain('migration 106: apply 105 first');
        expect(t).toContain('migration 106: apply 104 first');
      });

      it('has no unrestricted policy outside the reference-data allow-list and the job logins\' drains', () => {
        const open = createPolicies().filter((block) => /USING \(true\)|WITH CHECK \(true\)/.test(block));
        expect(open.map((block) => block.split(' ')[0]).sort()).toEqual([
          'billing_plans_read_all__api',
          'city_cbsa_crosswalk_read_all__api',
          'email_outbox_sender_select',
          'email_outbox_sender_update',
          'job_visibility_events_drain_job_select',
          'job_visibility_events_drain_job_update',
          'wage_references_read_all__api',
        ]);
        for (const block of open.filter((b) => !b.split(' ')[0].endsWith('__api'))) {
          expect(block).toMatch(/ TO jale_job_(email_sender|visibility_drain)\n/);
        }
      });

      it('names every copy <source>__api or <source>__dg and applies it to that one login', () => {
        for (const block of createPolicies()) {
          const name = block.split(' ')[0];
          if (name.endsWith('__api')) expect(block).toMatch(/ TO jale_api\n/);
          if (name.endsWith('__dg')) expect(block).toMatch(/ TO jale_job_digest\n/);
          expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(63);
        }
      });

      it('grants no TRUNCATE, REFERENCES, TRIGGER or CREATE, and never switches role', () => {
        const t = sqlOnly(text());
        expect(t).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|CREATE)\b/);
        expect(t).not.toMatch(/\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i);
        expect(t).not.toMatch(/\bRESET\s+ROLE\b/i);
      });

      it('opens each helper window INHERIT-only and closes it before the audit', () => {
        const t = sqlOnly(text());
        const opens = t.match(/WITH INHERIT TRUE, SET FALSE', '([a-z_]+)'/g) ?? [];
        const closes = t.match(/REVOKE %I FROM %I GRANTED BY %I', '([a-z_]+)'/g) ?? [];
        expect(opens.length).toBeGreaterThan(0);
        expect(closes).toHaveLength(opens.length);
        expect(t).toContain('migration 106: a membership window on a helper owner is still open');
      });

      it('audits per-login counts and copy fidelity, and refuses a source that changed since the snapshot', () => {
        const t = text();
        expect(t).toContain('migration 106: % holds % policies, % table, % column, % sequence, % EXECUTE and % schema privileges');
        expect(t).toContain('migration 106: copy % on % differs from its source %');
        expect(t).toContain('migration 106: source policy % on % changed since the catalog snapshot; regenerate');
      });
    });

    describe('105_least_privilege_capability_functions.sql', () => {
      const text = () => read('105_least_privilege_capability_functions.sql');

      it('makes job-scoped documents and upload tokens cascade from their job, NOT VALID then validated', () => {
        const t = sqlOnly(read('105_least_privilege_capability_functions.sql'));
        for (const [table, constraint] of [
          ['worker_documents', 'worker_documents_job_id_fkey'],
          ['document_upload_tokens', 'document_upload_tokens_job_id_fkey'],
        ]) {
          expect(t).toContain(
            `ALTER TABLE public.${table}\n  DROP CONSTRAINT ${constraint},\n  ADD CONSTRAINT ${constraint}\n`
            + '    FOREIGN KEY (job_id) REFERENCES public.jobs (id) ON DELETE CASCADE NOT VALID;',
          );
          expect(t).toContain(`ALTER TABLE public.${table} VALIDATE CONSTRAINT ${constraint};`);
        }
        expect(t).toContain('migration 105: the job-scoped document foreign keys must be validated and cascade on delete');
      });

      it('runs after 104 as jale_admin in ONE transaction and refuses a replay', () => {
        const t = text();
        expect(t).toMatch(/Run manually AFTER 104_least_privilege_logins\.sql/);
        expect(t).toContain('connected as jale_admin.');
        expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
        expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
        expect(t.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(t.indexOf('BEGIN;'));
        expect(t).toContain('migration 105: already applied');
        expect(t).toContain('migration 105: apply 104 first');
      });

      it('creates every capability function as a hardened definer, closed to PUBLIC, executable by its caller only', () => {
        const t = sqlOnly(text());
        const fns = capFunctions();
        expect(fns.length).toBeGreaterThan(0);
        for (const [signature, fn] of fns) {
          const name = signature.slice(0, signature.indexOf('('));
          expect(fn.security).toBe('definer');
          // The re-owned trigger function is moved into jale_cap and replaced
          // there (its trigger is bound by OID); every other one is created.
          expect(t).toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name.replace('.', '\\.')}\\(`));
          expect(t).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
          for (const caller of fn.execute) expect(t).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO ${caller};`);
          expect(t).toContain(`ALTER FUNCTION ${signature} OWNER TO ${fn.owner};`);
        }
        // Every function the file creates revokes PUBLIC, whatever the manifest says.
        const created = [...t.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (jale_cap\.\w+)\(/g)].map((m) => m[1]);
        expect(created.length).toBe(fns.length);
        for (const name of created) {
          expect(t).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${name.replace('.', '\\.')}\\([^)]*\\) FROM PUBLIC;`));
        }
        expect(t.match(/SECURITY DEFINER/g)?.length).toBe(fns.length);
        expect(t.match(/SET search_path = pg_catalog, pg_temp/g)?.length).toBe(fns.length);
      });

      it('transfers ownership inside a SET-only window that it closes again', () => {
        const t = sqlOnly(text());
        const open = t.indexOf("GRANT %I TO %I WITH SET TRUE, INHERIT FALSE");
        const transfer = t.indexOf('OWNER TO jale_cap_');
        const close = t.indexOf("GRANT %I TO %I WITH SET FALSE, INHERIT FALSE");
        const revoke = t.indexOf('REVOKE %I FROM %I GRANTED BY %I');
        expect(open).toBeGreaterThan(-1);
        expect(transfer).toBeGreaterThan(open);
        expect(close).toBeGreaterThan(transfer);
        expect(revoke).toBeGreaterThan(close);
        expect(t).toContain('migration 105: a role still holds SET or INHERIT on capability owner %');
      });

      it('re-owns the two master-owned definers: a public invoker wrapper and a moved trigger function', () => {
        const t = sqlOnly(text());
        expect(t).toContain('CREATE FUNCTION jale_cap.list_stale_job_outbox_workers(');
        expect(t).toMatch(/CREATE OR REPLACE FUNCTION public\.list_stale_job_outbox_workers\(\s*p_min_age INTERVAL DEFAULT INTERVAL '5 minutes'\s*\)[\s\S]*?SECURITY INVOKER\s*AS/);
        expect(t).toContain('GRANT EXECUTE ON FUNCTION public.list_stale_job_outbox_workers(interval) TO jale_whatsapp;');
        expect(t).toContain('ALTER FUNCTION public.sync_job_hired_counts() SET SCHEMA jale_cap;');
        expect(t.indexOf('ALTER FUNCTION public.sync_job_hired_counts() SET SCHEMA jale_cap;'))
          .toBeLessThan(t.indexOf('CREATE OR REPLACE FUNCTION jale_cap.sync_job_hired_counts()'));
        expect(t).toContain('migration 105: the hired-count trigger must fire jale_cap.sync_job_hired_counts()');
        expect(t).toContain("ALTER FUNCTION public.enforce_certification_document_limit() SET search_path = pg_catalog, public, pg_temp;");
      });

      it('gives each capability owner policies TO that owner only, and the manifest records every one', () => {
        const t = sqlOnly(text());
        const owners = Object.keys(manifest().capability_owners);
        const created = [...t.matchAll(/CREATE POLICY (\w+) ON (public\.\w+)\s+AS PERMISSIVE FOR (\w+) TO (\w+)/g)]
          .map(([, name, table, command, role]) => ({ key: `${table}.${name}`, command, role }));
        expect(created.length).toBeGreaterThan(0);
        // Every CREATE POLICY in the file has the explicit shape matched above.
        expect(created).toHaveLength((t.match(/CREATE POLICY /g) ?? []).length);
        const policies = (manifest() as unknown as { policies: Record<string, { command: string; to: string[] }> }).policies;
        for (const { key, command, role } of created) {
          expect(owners).toContain(role);
          expect([key, policies[key]?.command, policies[key]?.to]).toEqual([key, command, [role]]);
        }
        const recorded = Object.entries(policies).filter(([, p]) => p.to.every((r) => owners.includes(r))).map(([k]) => k).sort();
        expect(recorded).toEqual(created.map((c) => c.key).sort());
        expect(t).toContain('migration 105: capability owner % does not hold exactly its % policies');
        expect(t).toContain('migration 105: capability owner % must not hold CREATE on public');
      });

      it('gives jale_cap USAGE to the callers and fails closed on ACL drift', () => {
        const t = sqlOnly(text());
        const callers = [...new Set(capFunctions().flatMap(([, fn]) => fn.execute))].sort();
        for (const caller of callers) expect(t).toContain(`GRANT USAGE ON SCHEMA jale_cap TO ${caller};`);
        expect(t).toContain('migration 105: % has the wrong owner, security, search_path or language');
        expect(t).toContain('migration 105: % is executable by a role other than its owner and callers');
      });

      it('never switches role', () => {
        const t = sqlOnly(text());
        expect(t).not.toMatch(/\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i);
        expect(t).not.toMatch(/\bRESET\s+ROLE\b/i);
      });
    });
  });

  // 107-108 are sprint 27's report-a-problem storage: the report tables, the
  // two dedicated logins and the three capability owners (107), and the
  // jale_cap functions that are the only way to read or write a report (108).
  // Every object is listed in the access manifest fragment
  // infra/db/access/manifest.d/reports.json, so these text checks read their
  // expectations from it rather than restating them.
  describe('107-108 problem reports', () => {
    interface ReportsFragment {
      logins: Record<string, {
        kind: string; connection_limit: number; created_by: string; prepare_secret?: boolean; settings?: Record<string, string>;
      }>;
      capability_owners: Record<string, { created_by: string; reason: string }>;
      tables: Record<string, { classification: string; rls: { enabled: boolean; forced: boolean }; created_by?: string }>;
      functions: Record<string, {
        owner: string; security: string; search_path: string | null; execute: string[]; created_by?: string;
      }>;
      policies: Record<string, { command: string; permissive: boolean; to: string[]; origin: string }>;
      table_additions: Record<string, { policies?: Record<string, { command: string; to: string[]; origin: string }> }>;
    }
    const fragment = () => JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'db', 'access', 'manifest.d', 'reports.json'), 'utf8',
    )) as ReportsFragment;
    const read = (name: string) => fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    // Statement assertions read the SQL only: the headers explain roles,
    // passwords and policies in prose.
    const sqlOnly = (text: string) => text.replace(/--.*$/gm, '');
    const SCHEMA = '107_problem_reports_schema.sql';
    const FUNCTIONS = '108_problem_reports_functions.sql';
    const OWNERS = ['jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup'];
    const fnName = (signature: string) => signature.slice(0, signature.indexOf('('));

    describe.each([SCHEMA, FUNCTIONS])('%s', (file) => {
      it('runs right after its predecessor, as jale_admin, in ONE transaction with a lock timeout', () => {
        const t = read(file);
        const files = migrationFiles();
        expect(files).toContain(file);
        expect(t).toContain(`Run manually AFTER ${files[files.indexOf(file) - 1]},`);
        expect(t).toContain('connected as jale_admin.');
        expect(t).toContain('Forward-only (ADR-005)');
        expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
        expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
        expect(t.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(t.indexOf('BEGIN;'));
      });

      it('sets no password, never switches role and writes no unrestricted policy', () => {
        const t = sqlOnly(read(file));
        expect(t).not.toMatch(/PASSWORD/i);
        expect(t).not.toMatch(/\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i);
        expect(t).not.toMatch(/\bRESET\s+ROLE\b/i);
        // The only ALTER ROLE statements set the idle-transaction timeout.
        expect(t.replace(/^ALTER ROLE \w+ SET idle_in_transaction_session_timeout = '60s';$/gm, ''))
          .not.toMatch(/\bALTER\s+ROLE\b/i);
        // Upper-case keyword only: rolbypassrls is a catalog column.
        expect(t).not.toMatch(/(?<!NO)BYPASSRLS/);
        expect(t).not.toMatch(/USING\s*\(\s*true\s*\)/i);
        expect(t).not.toMatch(/WITH\s+CHECK\s*\(\s*true\s*\)/i);
      });

      it('scopes every policy it creates TO exactly one capability owner', () => {
        const t = sqlOnly(read(file));
        for (const [, name, body] of t.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+[\w.]+([\s\S]*?);/g)) {
          const to = body.match(/\bTO\s+([\w, ]+?)\s+(?:USING|WITH)\b/);
          expect({ name, to: to?.[1] }).toEqual({ name, to: expect.stringMatching(/^jale_cap_\w+$/) });
          expect(OWNERS).toContain(to?.[1]);
          expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
        }
      });

      it('revokes PUBLIC from every function it creates, and creates functions only in jale_cap', () => {
        const t = sqlOnly(read(file));
        const created = [...t.matchAll(/CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(/g)].map((m) => m[1]);
        for (const name of created) {
          expect(name).toMatch(/^jale_cap\.problem_report_\w+$/);
          expect(t).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${name.replace('.', '\\.')}\\([^)]*\\) FROM PUBLIC;`));
        }
      });

      it('carries no address, hostname or URL literal', () => {
        const t = sqlOnly(read(file));
        expect(t).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/i);
        expect(t).not.toMatch(/https?:\/\/[a-z0-9]/i);
      });
    });

    describe(SCHEMA, () => {
      it('creates the four report tables, excluded from every runtime login, with row-level security enabled and forced', () => {
        const t = sqlOnly(read(SCHEMA));
        const tables = Object.keys(fragment().tables).sort();
        expect(tables).toEqual([
          'public.problem_report_contents', 'public.problem_report_rate_buckets',
          'public.problem_report_settings', 'public.problem_reports',
        ]);
        for (const table of tables) {
          expect(fragment().tables[table]).toMatchObject({ classification: 'excluded', rls: { enabled: true, forced: true } });
          expect(t).toMatch(new RegExp(`CREATE TABLE ${table.replace('.', '\\.')}\\s*\\(`));
          expect(t).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
          expect(t).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        }
        expect(t).toMatch(/CREATE SEQUENCE public\.problem_report_number_seq\b[^;]*\bSTART WITH 1000\b/);
        expect(t).toMatch(/DEFAULT nextval\('public\.problem_report_number_seq'\)/);
        // Personal content leaves with its report, and with its account.
        expect(t).toMatch(/REFERENCES public\.problem_reports \(id\) ON DELETE CASCADE/);
        expect(t).toMatch(/REFERENCES public\.users \(id\) ON DELETE CASCADE/);
      });

      it('seeds the settings row with no recipient and no dashboard address', () => {
        const t = sqlOnly(read(SCHEMA));
        expect(t).toContain('INSERT INTO public.problem_report_settings (id) VALUES (true);');
        expect(t).toMatch(/team_recipient\s+TEXT\s+CHECK/);
        expect(t).toMatch(/admin_base_url\s+TEXT\s+CHECK/);
        // The seed runs before row-level security is switched on.
        expect(t.indexOf('INSERT INTO public.problem_report_settings')).toBeLessThan(
          t.indexOf('ALTER TABLE public.problem_report_settings ENABLE ROW LEVEL SECURITY;'),
        );
      });

      it('creates both logins with the least-privilege attributes and their connection limits', () => {
        const t = sqlOnly(read(SCHEMA));
        const logins = fragment().logins;
        expect(Object.keys(logins).sort()).toEqual(['jale_api_public_reports', 'jale_job_report_cleanup']);
        expect(logins.jale_api_public_reports).toMatchObject({ kind: 'public', connection_limit: 10, created_by: '107', prepare_secret: true });
        expect(logins.jale_job_report_cleanup).toMatchObject({ kind: 'job', connection_limit: 5, created_by: '107', prepare_secret: true });
        expect(t).toContain('LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT');
        for (const [name, login] of Object.entries(logins)) {
          expect(t).toMatch(new RegExp(`\\('${name}',\\s*${login.connection_limit}\\)`));
        }
        expect(t).toContain("GRANT CONNECT ON DATABASE %I TO %I', current_database()");
        expect(t).not.toMatch(/ON DATABASE jale\b/);
        expect(t).not.toMatch(/GRANT USAGE ON SCHEMA public TO jale_(?:api_public_reports|job_report_cleanup)/);
      });

      it('creates the three capability owners as NOLOGIN roles with CREATE on jale_cap and none on public', () => {
        const t = sqlOnly(read(SCHEMA));
        expect(Object.keys(fragment().capability_owners).sort()).toEqual(OWNERS);
        for (const owner of OWNERS) {
          expect(fragment().capability_owners[owner].created_by).toBe('107');
          expect(t).toContain(`'${owner}'`);
        }
        expect(t).toContain('NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
        expect(t).toContain(`GRANT CREATE ON SCHEMA jale_cap TO ${OWNERS.join(', ')};`);
        expect(t).not.toMatch(/GRANT CREATE ON SCHEMA public/i);
      });

      it('ends an idle transaction after 60 seconds on both logins, as the fragment records', () => {
        const t = sqlOnly(read(SCHEMA));
        for (const [name, login] of Object.entries(fragment().logins)) {
          expect(t).toContain(`ALTER ROLE ${name} SET idle_in_transaction_session_timeout = '60s';`);
          expect(login.settings).toEqual({ idle_in_transaction_session_timeout: '60s' });
        }
        expect(t.match(/^ALTER ROLE /gm)).toHaveLength(2);
      });

      it('gives the owners no read right on the words, the typed contact, the context or the note', () => {
        const t = sqlOnly(read(SCHEMA)).replace(/\s+/g, ' ');
        const selectLists = [...t.matchAll(/GRANT SELECT \(([^)]*)\) ON public\.problem_report_contents TO (\w+);/g)];
        expect(selectLists.map((m) => m[2]).sort()).toEqual(['jale_cap_problem_reports', 'jale_cap_report_cleanup']);
        for (const [, columns] of selectLists) {
          for (const content of ['description', 'typed_contact', 'context', 'internal_note']) {
            expect(columns.split(',').map((c) => c.trim())).not.toContain(content);
          }
        }
        // The clean-up owner reads keys and dates only, and no mail content.
        expect(t).toContain('GRANT SELECT (report_id, created_at, image_key, pending_upload_key, upload_issued_at) ON public.problem_report_contents TO jale_cap_report_cleanup;');
        expect(t).toContain('GRANT SELECT (id, source_type, status, attempt_count, created_at) ON public.email_outbox TO jale_cap_report_cleanup;');
        // The console owner never reads users.full_name.
        expect(t).toContain('GRANT SELECT (id, cognito_sub, user_type, email, phone) ON public.users TO jale_cap_problem_reports_admin;');
        expect(t).toContain('GRANT EXECUTE ON FUNCTION public.admin_mask_phone(text) TO jale_cap_problem_reports_admin;');
        expect(t).toContain('GRANT USAGE ON SCHEMA jale_cap TO jale_cap_problem_reports, jale_cap_problem_reports_admin;');
        expect(t).toContain('GRANT USAGE ON SEQUENCE public.problem_report_number_seq TO jale_cap_problem_reports;');
        // Nothing for a runtime login.
        expect(t).not.toMatch(/GRANT [^;]* TO jale_(?:api|api_public|api_public_reports|job_report_cleanup|admin_console)\b[^;]*;/);
      });

      it('gives every upload its own image key: images/<report>/<upload>.<ext>', () => {
        const t = sqlOnly(read(SCHEMA));
        expect(t).toContain("image_key            TEXT        CHECK (image_key ~ '^images/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(jpg|png|webp)$')");
      });

      it('creates exactly the policies the fragment lists, 23 on its own tables and 5 on users and email_outbox', () => {
        const t = sqlOnly(read(SCHEMA));
        const created = [...t.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)\s+FOR (\w+) TO (\w+)/g)]
          .map(([, name, table, command, role]) => `public.${table}.${name} ${command} ${role}`).sort();
        const own = Object.entries(fragment().policies).map(([key, p]) => {
          expect(p).toMatchObject({ permissive: true, origin: 'existing' });
          return `${key} ${p.command} ${p.to.join(',')}`;
        });
        const added = Object.entries(fragment().table_additions).flatMap(([table, addition]) =>
          Object.entries(addition.policies ?? {}).map(([name, p]) => `${table}.${name} ${p.command} ${p.to.join(',')}`));
        expect(own).toHaveLength(23);
        expect(added.sort()).toEqual([
          'public.email_outbox.email_outbox_problem_report_cleanup_delete DELETE jale_cap_report_cleanup',
          'public.email_outbox.email_outbox_problem_report_cleanup_read SELECT jale_cap_report_cleanup',
          'public.email_outbox.email_outbox_problem_report_insert INSERT jale_cap_problem_reports',
          'public.users.users_problem_reports_admin_read SELECT jale_cap_problem_reports_admin',
          'public.users.users_problem_reports_intake_read SELECT jale_cap_problem_reports',
        ]);
        expect(created).toEqual([...own, ...added].sort());
        // The intake owner's working window, and the sender's retry rule kept.
        expect(t.match(/created_at > now\(\) - interval '24 hours'/g)).toHaveLength(6);
        expect(t.match(/NOT \(status IN \('pending', 'failed'\) AND attempt_count < 5\)/g)).toHaveLength(2);
      });

      it('refuses a replay and self-audits its tables, logins, owners, rights and policies', () => {
        const t = read(SCHEMA);
        for (const message of [
          'migration 107: already applied',
          'migration 107: apply the least-privilege migrations first',
          'migration 107: % is missing, or its row-level security is not enabled and forced',
          'migration 107: the settings row is missing or carries a recipient or dashboard address',
          'migration 107: existing login % has unexpected attributes; refusing to adopt it',
          'migration 107: role % has unsafe memberships',
          'migration 107: capability owner % must hold CREATE on jale_cap and not on public',
          'migration 107: login % does not carry its role settings',
          'migration 107: % does not hold exactly its reviewed rights on %',
          'migration 107: the report policies differ from the reviewed set (%)',
        ]) expect(t).toContain(message);
      });
    });

    describe(FUNCTIONS, () => {
      it('creates every report function as a hardened definer, executable by its listed callers only', () => {
        const t = sqlOnly(read(FUNCTIONS));
        const fns = Object.entries(fragment().functions);
        expect(fns).toHaveLength(18);
        for (const [signature, fn] of fns) {
          const name = fnName(signature);
          expect(fn).toMatchObject({ security: 'definer', search_path: 'pg_catalog, pg_temp', created_by: '108' });
          expect(OWNERS).toContain(fn.owner);
          expect(t).toContain(`CREATE FUNCTION ${name}(`);
          expect(t).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
          for (const caller of fn.execute) expect(t).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO ${caller};`);
          expect(t).toContain(`ALTER FUNCTION ${signature} OWNER TO ${fn.owner};`);
        }
        const created = [...t.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (jale_cap\.\w+)\(/g)].map((m) => m[1]);
        expect(created.sort()).toEqual(fns.map(([signature]) => fnName(signature)).sort());
        expect(t.match(/SECURITY DEFINER/g)?.length).toBe(fns.length);
        expect(t.match(/SET search_path = pg_catalog, pg_temp/g)?.length).toBe(fns.length);
        expect(t.match(/GRANT EXECUTE ON FUNCTION/g)?.length).toBe(fns.reduce((n, [, fn]) => n + fn.execute.length, 0));
      });

      it('gives each caller exactly its expected functions, and the two helpers to nobody', () => {
        const fns = Object.entries(fragment().functions);
        const reachable = (login: string) => fns
          .filter(([, fn]) => fn.execute.includes(login))
          .map(([signature]) => fnName(signature).replace('jale_cap.', ''))
          .sort();
        expect(reachable('jale_api_public_reports')).toEqual([
          'problem_report_attach', 'problem_report_config', 'problem_report_create_unverified',
          'problem_report_pending_upload', 'problem_report_upload_grant',
        ]);
        expect(reachable('jale_api')).toEqual([
          'problem_report_attach', 'problem_report_create_verified', 'problem_report_pending_upload',
          'problem_report_upload_grant',
        ]);
        expect(reachable('jale_admin_console')).toEqual([
          'problem_report_counts', 'problem_report_detail', 'problem_report_image', 'problem_report_inbox',
          'problem_report_reveal_contact', 'problem_report_set_note', 'problem_report_set_status',
          'problem_report_settings_get', 'problem_report_settings_set',
        ]);
        expect(reachable('jale_job_report_cleanup')).toEqual(['problem_report_cleanup']);
        expect(fns.filter(([, fn]) => fn.execute.length === 0).map(([signature]) => fnName(signature)).sort()).toEqual([
          'jale_cap.problem_report_enqueue_team_email', 'jale_cap.problem_report_mask_email',
        ]);
        const callers = [...new Set(fns.flatMap(([, fn]) => fn.execute))].sort();
        expect(callers).toEqual(['jale_admin_console', 'jale_api', 'jale_api_public_reports', 'jale_job_report_cleanup']);
        const t = sqlOnly(read(FUNCTIONS));
        for (const caller of callers) expect(t).toContain(`GRANT USAGE ON SCHEMA jale_cap TO ${caller};`);
      });

      it('transfers ownership inside a SET-only window that it closes again', () => {
        const t = sqlOnly(read(FUNCTIONS));
        const open = t.indexOf('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE');
        const transfer = t.indexOf('OWNER TO jale_cap_');
        const close = t.indexOf('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE');
        const revoke = t.indexOf('REVOKE %I FROM %I GRANTED BY %I');
        expect(open).toBeGreaterThan(-1);
        expect(transfer).toBeGreaterThan(open);
        expect(close).toBeGreaterThan(transfer);
        expect(revoke).toBeGreaterThan(close);
      });

      it('refuses a replay and self-audits its functions and the report tables', () => {
        const t = read(FUNCTIONS);
        for (const message of [
          'migration 108: already applied',
          'migration 108: apply 107 first',
          'migration 108: % has the wrong owner, security, search_path or language',
          'migration 108: % is executable by a role other than its owner and callers',
          'migration 108: % is not executable by %',
          'migration 108: % lacks USAGE on jale_cap',
          'migration 108: a role still holds SET or INHERIT on capability owner %',
          'migration 108: a login holds a privilege on report object %',
        ]) expect(t).toContain(message);
      });
    });
  });

  // 109-112 are sprint 27's audit storage: append-only access and change
  // records owned by a NOLOGIN role (109), the freeze of the dashboard's
  // action records (110), the change-log triggers (111) and the operator
  // functions (112). The
  // access-manifest fragment (infra/db/access/manifest.d/audit.json) is the
  // reviewed list of what they create; the audit-* DB suites prove it.
  describe('109 audit storage', () => {
    const text = () => fs.readFileSync(path.join(migrationsDir, '109_audit_storage.sql'), 'utf8');
    // Statement assertions read the SQL only: the header explains roles and
    // the ownership window in prose.
    const sqlOnly = (t: string) => t.replace(/--.*$/gm, '');

    it('runs after the least-privilege migrations as jale_admin, in ONE transaction with a lock timeout', () => {
      const t = text();
      expect(t).toMatch(/Run manually AFTER 108_problem_reports_functions\.sql/);
      expect(t).toContain('connected as jale_admin.');
      expect(t).toContain('Forward-only (ADR-005)');
      expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(t).toContain("SET LOCAL lock_timeout = '5s';");
    });

    it('describes the work neutrally', () => {
      // Role attribute names (NOBYPASSRLS, rolbypassrls) are not prose.
      expect(text()).not.toMatch(/\b(bypass|exempt)\w*/i);
    });

    it('creates the owners without LOGIN or a password, and never an extension', () => {
      const t = sqlOnly(text());
      expect(t).toContain("'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'");
      expect(t).not.toMatch(/\bPASSWORD\b/i);
      expect(t).not.toMatch(/CREATE\s+EXTENSION/i);
    });

    it('creates objects as the owner inside a SET window that it closes again', () => {
      const t = sqlOnly(text());
      const open = t.indexOf('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE');
      const switchRole = t.indexOf('SET LOCAL ROLE jale_audit_owner;');
      const reset = t.lastIndexOf('RESET ROLE;');
      const close = t.indexOf('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE');
      const revoke = t.indexOf('REVOKE %I FROM %I GRANTED BY %I');
      expect(open).toBeGreaterThan(-1);
      expect(switchRole).toBeGreaterThan(open);
      expect(reset).toBeGreaterThan(switchRole);
      expect(close).toBeGreaterThan(reset);
      expect(revoke).toBeGreaterThan(close);
      expect(t).toContain('migration 109: a role still holds SET or INHERIT on owner %');
    });

    it('grants nothing on any jale_audit table and declares no foreign key', () => {
      const t = sqlOnly(text());
      expect(t).not.toMatch(/GRANT[^;]*\bON\s+(TABLE\s+)?jale_audit\./i);
      expect(t).not.toMatch(/GRANT[^;]*\bON\s+ALL\s+TABLES/i);
      expect(t).not.toMatch(/\bREFERENCES\s+[a-z_.]+\s*\(/i);
      expect(t).not.toMatch(/\bFOREIGN\s+KEY\s*\(/i);
      expect(t).not.toMatch(/ROW\s+LEVEL\s+SECURITY/i);
    });

    it('closes every function it creates to PUBLIC', () => {
      const t = sqlOnly(text());
      const created = [...t.matchAll(/CREATE FUNCTION (jale_audit\.[a-z_]+)\(/g)].map((m) => m[1]);
      expect(created.length).toBeGreaterThan(0);
      for (const fn of created) {
        expect(t).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn.replace('.', '\\.')}\\([^)]*\\) FROM PUBLIC;`));
      }
    });

    it('fails closed when an object drifts from its expected owner, attributes or grants', () => {
      const t = text();
      expect(t).toContain('migration 109: apply the least-privilege logins (104) first');
      expect(t).toContain('migration 109: existing role % has unsafe attributes');
      expect(t).toContain('migration 109: % must be owned by its owner role and closed to PUBLIC');
      expect(t).toContain('migration 109: a role other than the owner holds a privilege on %');
      expect(t).toContain('migration 109: % has the wrong owner, security or search_path');
      expect(t).toContain('migration 109: % is executable by a role outside its callers');
    });
  });

  describe('110 dashboard action records', () => {
    const text = () => fs.readFileSync(path.join(migrationsDir, '110_admin_audit_log_freeze.sql'), 'utf8');
    const sqlOnly = (t: string) => t.replace(/--.*$/gm, '');

    it('runs after 109 as jale_admin, in ONE transaction with a lock timeout', () => {
      const t = text();
      expect(t).toMatch(/Run manually AFTER 109_audit_storage\.sql/);
      expect(t).toContain('connected as jale_admin.');
      expect(t).toContain('Forward-only (ADR-005)');
      expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(t).toContain("SET LOCAL lock_timeout = '5s';");
      expect(t).toContain('migration 110: apply the audit storage (109) first');
      expect(t).toContain('migration 110: already applied (admin_audit_log.xact exists); it is not re-runnable');
    });

    it('describes the work neutrally', () => {
      expect(text()).not.toMatch(/\b(bypass|exempt)\w*/i);
    });

    it('scrubs once and on every insert through the same transform, before binding the guard', () => {
      const t = sqlOnly(text());
      const update = t.indexOf('SET metadata = jale_audit.scrub_legacy_metadata(l.metadata, l.actor_role, l.action, l.target_type)');
      const trigger = t.indexOf('NEW.metadata := jale_audit.scrub_legacy_metadata(NEW.metadata, NEW.actor_role, NEW.action, NEW.target_type)');
      const guard = t.indexOf('EXECUTE FUNCTION jale_audit.reject_change()');
      expect(update).toBeGreaterThan(-1);
      expect(trigger).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(update);
      expect(t).toContain('BEFORE INSERT ON public.admin_audit_log');
    });

    it('re-owns inside a window it closes, and gives back CREATE on public', () => {
      const t = sqlOnly(text());
      const open = t.indexOf("GRANT jale_audit_owner TO %I WITH SET TRUE, INHERIT FALSE");
      const create = t.indexOf('GRANT CREATE ON SCHEMA public TO jale_audit_owner;');
      const reown = t.indexOf('ALTER TABLE public.admin_audit_log OWNER TO jale_audit_owner;');
      const revokeCreate = t.indexOf('REVOKE CREATE ON SCHEMA public FROM jale_audit_owner;');
      const close = t.indexOf("REVOKE jale_audit_owner FROM %I GRANTED BY %I");
      expect(open).toBeGreaterThan(-1);
      expect(create).toBeGreaterThan(open);
      expect(reown).toBeGreaterThan(create);
      expect(revokeCreate).toBeGreaterThan(reown);
      expect(close).toBeGreaterThan(revokeCreate);
      expect(t).not.toMatch(/GRANT[^;]*ON\s+public\.admin_audit_log\s+TO\s+jale_admin\s*;/i);
      expect(t).not.toMatch(/\bPASSWORD\b/i);
      expect(t).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE)\b[^;]*ON\s+public\.admin_audit_log/i);
    });

    it('prints counts only', () => {
      const notices = [...sqlOnly(text()).matchAll(/RAISE NOTICE '([^']*)'/g)].map((m) => m[1]);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toMatch(/^migration 110: % dashboard action records; /);
      expect(notices[1]).toBe('migration 110: % admin ids filled from a unique email match; % records left without an admin id');
    });

    it('closes every function it creates to PUBLIC', () => {
      const t = sqlOnly(text());
      const created = [...t.matchAll(/CREATE FUNCTION (jale_audit\.[a-z_]+)\(/g)].map((m) => m[1]);
      expect(created).toHaveLength(6);
      for (const fn of created) {
        expect(t).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn.replace('.', '\\.')}\\([^)]*\\) FROM PUBLIC;`));
      }
    });
  });

  describe('111 change records', () => {
    const text = () => fs.readFileSync(path.join(migrationsDir, '111_audit_change_log.sql'), 'utf8');
    const sqlOnly = (t: string) => t.replace(/--.*$/gm, '');
    const BEGIN_MARK = '-- BEGIN GENERATED: change-record triggers (infra/db/access/audit-change-log.json)\n';
    const END_MARK = '\n-- END GENERATED: change-record triggers';

    it('runs after 110 as jale_admin, in ONE transaction with a lock timeout', () => {
      const t = text();
      expect(t).toMatch(/Run manually AFTER 110_admin_audit_log_freeze\.sql/);
      expect(t).toContain('connected as jale_admin.');
      expect(t).toContain('Forward-only (ADR-005)');
      expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(t).toContain("SET LOCAL lock_timeout = '5s';");
      expect(sqlOnly(t).indexOf("SET LOCAL lock_timeout = '5s';")).toBeLessThan(sqlOnly(t).indexOf('CREATE TRIGGER '));
      expect(t).toContain('migration 111: apply the audit storage (109) first');
      expect(t).toContain('migration 111: already applied (jale_audit.capture_change exists); it is not re-runnable');
    });

    it('describes the work neutrally', () => {
      expect(text()).not.toMatch(/\b(bypass|exempt)\w*/i);
    });

    it('carries exactly the triggers audit-change-log.json implies, between its GENERATED markers', () => {
      const t = text();
      const start = t.indexOf(BEGIN_MARK);
      const end = t.indexOf(END_MARK);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(t.slice(start + BEGIN_MARK.length, end)).toBe(renderTriggers());
      // No change-record trigger outside the block.
      const outside = sqlOnly(t.slice(0, start) + t.slice(end));
      expect(outside).not.toMatch(/CREATE TRIGGER/);
    });

    it('creates one definer closed to PUBLIC, lends EXECUTE to the migration login only while the triggers are created', () => {
      const t = sqlOnly(text());
      expect([...t.matchAll(/CREATE FUNCTION (jale_audit\.[a-z_]+)\(/g)].map((m) => m[1])).toEqual(['jale_audit.capture_change']);
      expect(t).toContain('SECURITY DEFINER');
      expect(t).toContain('SET search_path = pg_catalog, pg_temp');
      expect(t).toContain('REVOKE ALL ON FUNCTION jale_audit.capture_change() FROM PUBLIC;');
      const lend = t.indexOf("GRANT EXECUTE ON FUNCTION jale_audit.capture_change() TO %I', session_user");
      const firstTrigger = t.indexOf('CREATE TRIGGER ');
      const takeBack = t.indexOf("REVOKE EXECUTE ON FUNCTION jale_audit.capture_change() FROM %I', session_user");
      const close = t.indexOf('REVOKE jale_audit_owner FROM %I GRANTED BY %I');
      expect(lend).toBeGreaterThan(-1);
      expect(firstTrigger).toBeGreaterThan(lend);
      expect(takeBack).toBeGreaterThan(t.lastIndexOf('CREATE TRIGGER '));
      expect(close).toBeGreaterThan(takeBack);
      expect(t).not.toMatch(/GRANT[^;]*\bON\s+(TABLE\s+)?jale_audit\./i);
      expect(t).not.toMatch(/\bPASSWORD\b/i);
    });

    it('records the login and never fails a write on the audit context', () => {
      const t = sqlOnly(text());
      // db_login, db_pid, xact and occurred_at come from the column defaults (session_user, ...).
      const insert = t.slice(t.indexOf('INSERT INTO jale_audit.changes'));
      expect(insert.slice(0, insert.indexOf(';'))).not.toMatch(/db_login|db_pid|xact|occurred_at/);
      expect(t).toMatch(/EXCEPTION WHEN OTHERS THEN\s+v_status := 'invalid';/);
      for (const name of ['app.audit_actor_kind', 'app.audit_actor_id', 'app.audit_channel', 'app.audit_surface', 'app.audit_request_id']) {
        expect(t).toContain(`current_setting('${name}', true)`);
      }
    });

    it('fails closed when the result drifts', () => {
      const t = text();
      expect(t).toContain('migration 111: capture_change has the wrong owner, security, search_path or grants');
      expect(t).toContain('migration 111: the ownership window is still open');
      expect(t).toContain('migration 111: change-record triggers with the wrong shape: %');
      expect(t).toContain('migration 111: tables without exactly one change-record trigger per event: %');
    });
  });

  describe('112 operator functions', () => {
    const text = () => fs.readFileSync(path.join(migrationsDir, '112_audit_operator_functions.sql'), 'utf8');
    const sqlOnly = (t: string) => t.replace(/--.*$/gm, '');
    const PERSON_START = '-- ── 5. Personal operator logins';
    const PERSON_END = '-- ── 6. Close the SET window';

    it('runs after 111 as jale_admin, in ONE transaction with a lock timeout', () => {
      const t = text();
      expect(t).toMatch(/Run manually AFTER 111_audit_change_log\.sql/);
      expect(t).toContain('connected as jale_admin.');
      expect(t).toContain('Forward-only (ADR-005)');
      expect(t.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(t.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(t).toContain("SET LOCAL lock_timeout = '5s';");
      expect(sqlOnly(t).indexOf("SET LOCAL lock_timeout = '5s';")).toBeLessThan(sqlOnly(t).indexOf('CREATE POLICY '));
      expect(t).toContain('migration 112: apply the audit storage (109) first');
      expect(t).toContain('migration 112: apply the change records (111) first');
      expect(t).toContain('migration 112: already applied (jale_ops holds functions); it is not re-runnable');
    });

    it('describes the work neutrally', () => {
      expect(text()).not.toMatch(/\b(bypass|exempt)\w*/i);
    });

    it('creates the nine operator functions, the two audit counts and the held-row listing as definers closed to PUBLIC', () => {
      const t = sqlOnly(text());
      expect([...t.matchAll(/CREATE FUNCTION ([a-z_]+\.[a-z_]+)\(/g)].map((m) => m[1]).sort()).toEqual([
        'jale_audit.event_counts', 'jale_audit.export_status', 'jale_audit.list_holds', 'jale_audit.value_span_kind',
        'jale_ops.audit_event_counts', 'jale_ops.audit_export_status', 'jale_ops.delivery_status', 'jale_ops.find_user',
        'jale_ops.migration_ledger', 'jale_ops.onboarding_status', 'jale_ops.outbox_status',
        'jale_ops.trust_assessment_status', 'jale_ops.user_status',
      ]);
      expect(t.match(/SECURITY DEFINER/g)).toHaveLength(12);
      expect(t.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(16);
      expect(t).toContain('GRANT EXECUTE ON FUNCTION jale_audit.list_holds() TO jale_admin;');
      expect(t).not.toMatch(/GRANT[^;]*\bON\s+(TABLE\s+)?jale_audit\./i);
      // The ledger grant is conditional on the ledger existing.
      expect(t).toMatch(/IF pg_catalog\.to_regclass\('public\.schema_migrations'\) IS NOT NULL THEN\s+GRANT SELECT \(filename, applied_at, checksum, applied_by\) ON public\.schema_migrations TO jale_ops_owner;/);
    });

    it('names value kinds with exactly the value-span patterns of migration 110', () => {
      // Each pattern and its flags, as the regexp_replace calls carry them.
      const pairs = (body: string) => [...body.matchAll(/'((?:[^']|'')*)',\s*'\[removed\]',\s*'(g|gi)'/g)]
        .map((m) => `${m[2]} ${m[1]}`).sort();
      const fnBody = (sql: string, name: string) => {
        const start = sql.indexOf(`CREATE FUNCTION ${name}(`);
        expect(start).toBeGreaterThan(-1);
        return sql.slice(start, sql.indexOf('$fn$;', start));
      };
      const redaction = pairs(fnBody(fs.readFileSync(path.join(migrationsDir, '110_admin_audit_log_freeze.sql'), 'utf8'), 'jale_audit.redact_value_spans'));
      expect(redaction).toHaveLength(5);
      expect(pairs(fnBody(text(), 'jale_audit.value_span_kind'))).toEqual(redaction);
    });

    it('keeps the personal-login procedures in their own section, which nothing else uses', () => {
      const t = text();
      const start = t.indexOf(PERSON_START);
      const end = t.indexOf(PERSON_END);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const inside = sqlOnly(t.slice(start, end));
      const outside = sqlOnly(t.slice(0, start) + t.slice(end));
      expect([...inside.matchAll(/CREATE PROCEDURE (jale_ops\.[a-z_]+)\(/g)].map((m) => m[1]))
        .toEqual(['jale_ops.provision_person', 'jale_ops.renew_person', 'jale_ops.remove_person']);
      expect(inside).not.toMatch(/SECURITY DEFINER/);
      expect(inside.match(/SECURITY INVOKER/g)).toHaveLength(3);
      // Outside the section only its own self-audit names the procedures.
      const selfAudit = outside.slice(outside.indexOf("('jale_ops.provision_person(text, text, integer)')"));
      expect(outside.slice(0, outside.length - selfAudit.length)).not.toMatch(/provision_person|renew_person|remove_person|CREATE ROLE|PASSWORD/);
      // The procedures never print the verifier.
      expect(inside).not.toMatch(/RAISE[^;]*p_verifier/);
    });

    it('fails closed when the result drifts', () => {
      const t = text();
      expect(t).toContain('migration 112: the ownership window is still open');
      expect(t).toContain('migration 112: % has the wrong owner, security, search_path or grants');
      expect(t).toContain('migration 112: % has the wrong owner, kind, security, search_path or grants');
      expect(t).toContain('migration 112: jale_ops grants are % instead of USAGE for the operator group and jale_admin');
      expect(t).toContain('migration 112: tables the operator owner reads without exactly one read policy: %');
    });
  });
});
