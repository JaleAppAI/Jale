import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const infraRoot = path.join(__dirname, '..', '..', '..', '..');
const repoRoot = path.join(infraRoot, '..');
const migrationsDir = path.join(infraRoot, 'db', 'migrations');
const architecturePath = path.join(repoRoot, 'docs', 'ARCHITECTURE.md');

const expectedBaselineMigrations = [
  '001_initial_schema.sql',
  '002_rls_policies.sql',
  '003_jobs_and_applications.sql',
  '004_whatsapp.sql',
  '005_document_vault.sql',
  '006_trust_signal_layer.sql',
  '007_worker_marketplace.sql',
  '008_worker_skills.sql',
  '009_location_foundation.sql',
  '010_matching_write_semantics.sql',
  '011_ai_profile_media.sql',
  '012_ai_trust_assessment.sql',
  '013_whatsapp_template_outbox.sql',
  '014_employer_candidate_rankings.sql',
  '015_application_status_alignment.sql',
  '016_employer_profiles.sql',
  '017_document_upload_token_hardening.sql',
  '018_document_vault_rls_hardening.sql',
  '019_application_status_constraint_repair.sql',
  '020_worker_pii_rls_hardening.sql',
  '021_whatsapp_required_docs_apply_support.sql',
  '022_job_application_required_docs_guard.sql',
  '023_job_fields_and_statuses_mvp.sql',
  '024_sprint11_hiring_flow_hardening.sql',
  '025_job_messaging.sql',
  '026_admin_panel.sql',
  '027_admin_security_hardening.sql',
  '028_job_messaging_hardening.sql',
  '029_hired_count_trigger_security_definer.sql',
  '030_whatsapp_worker_skills_seed.sql',
  '031_employer_display_name.sql',
  '032_work_authorization_required.sql',
  '033_pay_interval_experience_months_worker_certifications.sql',
  '034_billing_foundation.sql',
  '035_whatsapp_support_cases.sql',
  '036_whatsapp_delivery_status.sql',
  '037_billing_job_limit_enforcement.sql',
  '038_email_outbox.sql',
  '039_rls_relationship_recursion_repair.sql',
];

function migrationFiles(): string[] {
  return fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

function readAllMigrations(): string {
  return expectedBaselineMigrations.map(readMigration).join('\n');
}

function expectTable(sql: string, tableName: string): void {
  expect(sql).toMatch(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${tableName}\\s*\\(`, 'i'));
}

async function applyMigrationsAndReadColumns(databaseUrl: string): Promise<Map<string, Map<string, string>>> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of expectedBaselineMigrations) {
      await client.query(readMigration(file));
    }

    const result = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
    }>(`
      SELECT table_name, column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    const columns = new Map<string, Map<string, string>>();
    for (const row of result.rows) {
      const tableColumns = columns.get(row.table_name) ?? new Map<string, string>();
      tableColumns.set(row.column_name, row.data_type === 'ARRAY' ? row.udt_name : row.data_type);
      columns.set(row.table_name, tableColumns);
    }
    return columns;
  } finally {
    await client.end();
  }
}

describe('migration apply order baseline', () => {
  it('locks the integrated migration baseline order', () => {
    expect(migrationFiles()).toEqual(expectedBaselineMigrations);
  });

  it('defines all baseline readiness tables and spot-check columns', () => {
    const sql = readAllMigrations();

    for (const tableName of [
      'users',
      'worker_profiles',
      'jobs',
      'job_applications',
      'worker_documents',
      'whatsapp_conversations',
      'whatsapp_processed_messages',
      'whatsapp_outbox',
      'document_upload_tokens',
      'document_upload_token_slots',
      'job_conversations',
      'job_conversation_messages',
      'job_message_outbox',
    ]) {
      expectTable(sql, tableName);
    }

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS trust_signals JSONB NOT NULL DEFAULT '\{\}'/i);
    expect(readMigration('003_jobs_and_applications.sql')).toMatch(/years_experience INTEGER CHECK/i);
    expect(readMigration('005_document_vault.sql')).toMatch(/ADD COLUMN IF NOT EXISTS required_docs TEXT\[\] NOT NULL DEFAULT '\{\}'/i);
  });

  it('normalizes worker skills in migration 008', () => {
    const migration = readMigration('008_worker_skills.sql');

    expectTable(migration, 'worker_skills');
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    expect(migration).toContain('worker_skills_skill_gin');
    expect(migration).toContain('ALTER TABLE worker_skills ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE worker_skills FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY worker_skills_self');
    expect(migration).toContain('CREATE POLICY worker_skills_employer_read');
    expect(migration).toContain('CREATE POLICY worker_skills_whatsapp_read');
    expect(migration).toContain('ALTER TABLE worker_profiles DROP COLUMN skills');
  });

  it('adds coordinate foundation columns and completeness checks in migration 009', () => {
    const migration = readMigration('009_location_foundation.sql');

    expect(migration).toContain('ADD COLUMN latitude NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90)');
    expect(migration).toContain('ADD COLUMN longitude NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180)');
    expect(migration).toContain('location_source TEXT CHECK (location_source IN');
    expect(migration).toContain('location_confidence SMALLINT CHECK (location_confidence BETWEEN 0 AND 100)');
    expect(migration).toContain('worker_profiles_location_complete');
    expect(migration).toContain('jobs_location_complete');
  });

  it('adds matching role, tables, RLS, and idempotency constraints in migration 010', () => {
    const migration = readMigration('010_matching_write_semantics.sql');

    expect(migration).toContain('CREATE ROLE jale_matching LOGIN');
    expect(migration).toContain('GRANT SELECT (id, user_type, main_trade, trust_signals, trust_signals_completed_at) ON users TO jale_matching');
    expectTable(migration, 'job_candidates');
    expectTable(migration, 'worker_job_impressions');
    expectTable(migration, 'worker_match_log');
    expect(migration).toContain('job_candidates_job_rank_unique');
    expect(migration).toContain('worker_job_impressions_unique_window');
    expect(migration).toContain('worker_match_log_event_key_unique');
    expect(migration).toContain('ALTER TABLE job_candidates FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE worker_job_impressions FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE worker_match_log FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY matching_write_candidates');
  });

  it('adds AI trust assessment tables, role, RLS, and denormalized score in migration 012', () => {
    const migration = readMigration('012_ai_trust_assessment.sql');

    expect(migration).toContain('CREATE ROLE jale_ai LOGIN');
    expectTable(migration, 'trade_questions');
    expectTable(migration, 'worker_trust_assessments');
    expect(migration).toContain('idx_worker_trust_assessments_active');
    expect(migration).toContain('ALTER TABLE worker_trust_assessments FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY wta_ai_service_rows');
    expect(migration).toContain('GRANT SELECT (id, user_id, profession_key, answers, status, created_at)');
    expect(migration).toContain('ADD COLUMN trade_competency_score INTEGER');
    expect(migration).toContain('CREATE POLICY users_ai_select');
    expect(migration).toContain('CREATE POLICY users_ai_score_update');
  });

  it('aligns application statuses in migration 015', () => {
    const migration = readMigration('015_application_status_alignment.sql');
    const oldConstraintDropIndex = migration.indexOf('pg_get_constraintdef(con.oid) LIKE \'%submitted%\'');
    const namedConstraintDropIndex = migration.indexOf('DROP CONSTRAINT IF EXISTS job_applications_status_check');
    const statusUpdateIndex = migration.indexOf('UPDATE job_applications');

    expect(migration).toContain("WHEN 'submitted' THEN 'pending'");
    expect(migration).toContain("WHEN 'viewed' THEN 'reviewed'");
    expect(migration).toContain("WHEN 'contacted' THEN 'reviewed'");
    expect(oldConstraintDropIndex).toBeGreaterThanOrEqual(0);
    expect(namedConstraintDropIndex).toBeGreaterThanOrEqual(0);
    expect(statusUpdateIndex).toBeGreaterThan(namedConstraintDropIndex);
    expect(migration).toContain("ALTER COLUMN status SET DEFAULT 'pending'");
    expect(migration).toContain('idx_job_applications_status_pending');
    expect(migration).toContain("CHECK (status IN ('pending', 'reviewed', 'hired', 'rejected'))");
    expect(migration).toContain('CREATE POLICY applications_employer_update');
  });

  it('adds employer candidate ranking cache with matching writes and employer-scoped reads in migration 014', () => {
    const migration = readMigration('014_employer_candidate_rankings.sql');

    expectTable(migration, 'employer_candidate_rankings');
    expect(migration).toContain('source_hash TEXT NOT NULL');
    expect(migration).toContain('employer_candidate_rankings_job_rank_idx');
    expect(migration).toContain('employer_candidate_rankings_job_hash_idx');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON employer_candidate_rankings TO jale_matching');
    expect(migration).toContain('GRANT SELECT ON employer_candidate_rankings TO jale_admin');
    expect(migration).toContain('ALTER TABLE employer_candidate_rankings FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY employer_candidate_rankings_matching_all');
    expect(migration).toContain('CREATE POLICY employer_candidate_rankings_employer_read');
  });

  it('adds employer profiles in migration 016', () => {
    const migration = readMigration('016_employer_profiles.sql');

    expectTable(migration, 'employer_profiles');
    expect(migration).toContain('company_name');
    expect(migration).toContain('contact_name');
    expect(migration).toContain('hiring_trades');
    expect(migration).toContain('typical_job_types');
    expect(migration).toContain('company_size');
    expect(migration).toContain('ALTER TABLE employer_profiles FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY employer_profiles_self');
  });

  it('adds hardened tokenized document upload slots in migration 017', () => {
    const migration = readMigration('017_document_upload_token_hardening.sql');

    expectTable(migration, 'document_upload_token_slots');
    expect(migration).toContain('used_at TIMESTAMPTZ');
    expect(migration).toContain('s3_version_id TEXT');
    expect(migration).toContain('PRIMARY KEY (token_hash, doc_type)');
    expect(migration).toContain('UNIQUE (issued_s3_key)');
    expect(migration).toContain('worker_documents_worker_update');
  });

  // docs/ is local-only (untracked since "stop tracking docs/"), so the
  // architecture guide is absent on fresh checkouts including CI. Run the
  // doc-content check only where the file exists; skip loudly otherwise.
  const architectureExists = fs.existsSync(architecturePath);
  if (!architectureExists) {
    // eslint-disable-next-line no-console
    console.warn(
      '[apply-order] SKIPPED: docs/ARCHITECTURE.md is absent (docs/ is local-only, untracked). ' +
        'Architecture-guide content assertions only run on machines that have the local doc.',
    );
  }
  const maybeItArchitecture = architectureExists ? it : it.skip;

  maybeItArchitecture('documents canonical matching source fields in the architecture guide', () => {
    const architecture = fs.readFileSync(architecturePath, 'utf8');

    expect(architecture).toContain('### Canonical Matching Inputs');
    expect(architecture).toContain('worker_skills');
    expect(architecture).toContain('users.trust_signals JSONB');
    expect(architecture).toContain('worker_profiles.years_experience INTEGER');
    expect(architecture).toContain('jobs.required_docs TEXT[]');
    expect(architecture).toContain('worker_profiles.availability is the canonical matching source');
    expect(architecture).toContain('users.availability is legacy/display data');
  });

  const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
  const maybeIt = databaseUrl ? it : it.skip;

  it('hardens document vault RLS in migration 018', () => {
    const migration = readMigration('018_document_vault_rls_hardening.sql');

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
    const migration = readMigration('019_application_status_constraint_repair.sql');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ');
    expect(migration).toContain('pg_get_constraintdef(con.oid) ILIKE');
    expect(migration).toContain('ALTER TABLE job_applications DROP CONSTRAINT %I');
    expect(migration).toContain("WHEN 'viewed' THEN 'reviewed'");
    expect(migration).toContain("WHEN 'contacted' THEN 'reviewed'");
    expect(migration).toContain("CHECK (status IN ('pending', 'reviewed', 'hired', 'rejected'))");
    expect(migration).toContain('DROP TRIGGER IF EXISTS job_applications_updated_at');
  });

  it('hardens worker PII RLS in migration 020', () => {
    const migration = readMigration('020_worker_pii_rls_hardening.sql');

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
    const migration = readMigration('021_whatsapp_required_docs_apply_support.sql');

    expect(migration).toContain('GRANT SELECT, INSERT ON worker_documents TO jale_whatsapp');
    expect(migration).not.toContain('UPDATE ON worker_documents TO jale_whatsapp');
    expect(migration).not.toContain('DELETE ON worker_documents TO jale_whatsapp');
  });

  it('guards direct application inserts in migration 022', () => {
    const migration = readMigration('022_job_application_required_docs_guard.sql');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION enforce_job_application_required_docs');
    expect(migration).toContain('FROM worker_documents wd');
    expect(migration).toContain('wd.job_id IS NULL OR wd.job_id = NEW.job_id');
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).toContain('CREATE TRIGGER job_applications_required_docs_guard');
  });

  it('adds MVP job fields and lifecycle statuses in migration 023', () => {
    const migration = readMigration('023_job_fields_and_statuses_mvp.sql');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS pay_min INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS number_of_workers_needed INTEGER NOT NULL DEFAULT 1');
    expect(migration).toContain("CHECK (status IN ('active', 'paused', 'filled', 'closed'))");
    expect(migration).toContain("WHEN 'reviewed' THEN 'contacted'");
    expect(migration).toContain("CHECK (status IN ('pending', 'contacted', 'talking', 'hired', 'not_interested'))");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sync_job_hired_counts');
    expect(migration).toContain("IF TG_OP = 'DELETE' THEN");
    expect(migration).toContain('target_job_id := OLD.job_id');
    expect(migration).toContain('target_job_id := NEW.job_id');
  });

  it('hardens Sprint 11 hiring flow fields in migration 024', () => {
    const migration = readMigration('024_sprint11_hiring_flow_hardening.sql');

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
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS jobs_headcount_check');
    expect(migration).toContain('jobs_headcount_bounds_check');
    expect(migration).toContain('VALIDATE CONSTRAINT jobs_headcount_bounds_check');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS jobs_required_experience_check');
    expect(migration).toContain('jobs_required_experience_years_bounds_check');
    expect(migration).toContain('VALIDATE CONSTRAINT jobs_required_experience_years_bounds_check');
  });

  it('adds applicant-scoped job messaging in migration 025', () => {
    const migration = readMigration('025_job_messaging.sql');

    expectTable(migration, 'job_conversations');
    expectTable(migration, 'job_conversation_messages');
    expectTable(migration, 'job_message_outbox');
    expect(migration).toContain('job_conversations_open_unique');
    expect(migration).toContain("CHECK (status IN ('open', 'closed'))");
    expect(migration).toContain("CHECK (status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered', 'failed', 'received'))");
    expect(migration).toContain('job_conversations_employer_all');
    expect(migration).toContain('job_conversations_worker_all');
  });

  it('hardens job messaging with thread numbers, status callbacks, and outbox sweeper in migration 028', () => {
    const migration = readMigration('028_job_messaging_hardening.sql');

    expect(migration).toContain('GRANT UPDATE (status, updated_at) ON job_applications TO jale_whatsapp');
    expect(migration).toContain('DROP POLICY IF EXISTS jobapp_whatsapp_all ON job_applications');
    expect(migration).toContain('CREATE POLICY jobapp_whatsapp_update ON job_applications');
    expect(migration).toContain('ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ');
    expect(migration).toContain('ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS worker_thread_number INTEGER');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_thread_counters');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION assign_worker_thread_number');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('focused_job_conversation_id');
    expect(migration).toContain("CHECK (status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered',");
    expect(migration).toContain('idx_job_messages_twilio_sid');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION record_twilio_status');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION list_stale_job_outbox_workers');
  });

  it('recreates sync_job_hired_counts as SECURITY DEFINER in migration 029 (worker-reply jobs-cascade fix)', () => {
    const migration = readMigration('029_hired_count_trigger_security_definer.sql');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION sync_job_hired_counts()');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public');
    expect(migration).not.toContain('CREATE TRIGGER');
  });

  it('adds work_authorization_required column to jobs in migration 032', () => {
    const migration = readMigration('032_work_authorization_required.sql');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS work_authorization_required BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toContain('SSN is intentionally kept in jobs_required_docs_valid CHECK');
  });

  it('adds pay interval, experience months, and worker certifications in migration 033', () => {
    const migration = readMigration('033_pay_interval_experience_months_worker_certifications.sql');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS pay_interval TEXT');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS required_experience_months INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS experience_months INTEGER');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS certifications TEXT[] NOT NULL DEFAULT '{}'::text[]");
    expect(migration).toContain('jobs_pay_interval_check');
    expect(migration).toContain('jobs_required_experience_months_check');
    expect(migration).toContain('worker_profiles_experience_months_check');
    expect(migration).toContain('worker_profiles_certifications_count_check');
    // Both year→month backfills must clamp the years value to 80 BEFORE the *12
    // so a legacy row with years > 80 cannot violate the new BETWEEN 0 AND 960
    // CHECK (abort) nor overflow int4 in the multiplication on extreme values.
    expect(migration).toMatch(/LEAST\(required_experience_years, 80\) \* 12/);
    expect(migration).toMatch(/LEAST\(years_experience, 80\) \* 12/);
  });

  it('adds billing foundation tables, org scaffolding, and jale_billing role in migration 034', () => {
    const migration = readMigration('034_billing_foundation.sql');

    // Org-ready scaffolding
    expectTable(migration, 'organizations');
    expect(migration).toContain('ALTER TABLE organizations FORCE  ROW LEVEL SECURITY');
    expect(migration).toContain('ADD CONSTRAINT users_tenant_id_fkey');
    expect(migration).toContain('FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE RESTRICT');

    // Billing tables
    expectTable(migration, 'billing_plans');
    expectTable(migration, 'billing_customers');
    expectTable(migration, 'subscriptions');
    expectTable(migration, 'billing_operations');
    expectTable(migration, 'billing_webhook_events');

    // Seed rows present
    expect(migration).toContain("'employer_pro'");
    expect(migration).toContain('2000');

    // Partial uniqueness index
    expect(migration).toContain('subscriptions_one_current_per_user');
    expect(migration).toContain("WHERE status NOT IN ('canceled', 'incomplete_expired')");

    // Idempotency UNIQUE constraint
    expect(migration).toContain('UNIQUE (actor_user_id, operation_type, client_idempotency_key)');

    // RLS FORCE on all billing tables
    expect(migration).toContain('ALTER TABLE billing_plans          FORCE  ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE billing_webhook_events FORCE  ROW LEVEL SECURITY');

    // jale_billing service role
    expect(migration).toContain("rolname = 'jale_billing'");
    expect(migration).toContain('CREATE ROLE jale_billing WITH LOGIN');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE         ON billing_webhook_events TO jale_billing');

    // jale_admin does NOT get billing_webhook_events write grant
    expect(migration).not.toContain('GRANT SELECT, INSERT, UPDATE ON billing_webhook_events TO jale_admin');
  });

  maybeIt('applies migrations 001-034 against a local Postgres database', async () => {
    const columns = await applyMigrationsAndReadColumns(databaseUrl!);

    expect(columns.get('users')?.get('trust_signals')).toBe('jsonb');
    expect(columns.get('worker_profiles')?.get('years_experience')).toBe('integer');
    expect(columns.get('jobs')?.get('required_docs')).toBe('_text');
    expect(columns.get('jobs')?.get('pay_min')).toBe('integer');
    expect(columns.get('jobs')?.get('language_preference')).toBe('_text');
    expect(columns.get('document_upload_tokens')?.get('used_at')).toBe('timestamp with time zone');
    expect(columns.get('document_upload_token_slots')?.get('issued_s3_key')).toBe('text');
    expect(columns.get('job_conversations')?.get('last_worker_message_at')).toBe('timestamp with time zone');
    expect(columns.get('job_message_outbox')?.get('send_kind')).toBe('text');
    // Billing tables (migration 034)
    expect(columns.get('billing_plans')?.get('code')).toBe('text');
    expect(columns.get('billing_customers')?.get('provider_customer_id')).toBe('text');
    expect(columns.get('subscriptions')?.get('status')).toBe('text');
    expect(columns.get('billing_operations')?.get('client_idempotency_key')).toBe('uuid');
    expect(columns.get('billing_webhook_events')?.get('stripe_event_id')).toBe('text');
    expect(columns.get('billing_webhook_events')?.get('lease_expires_at')).toBe('timestamp with time zone');
    expect(columns.get('organizations')?.get('id')).toBe('uuid');
  });
});
