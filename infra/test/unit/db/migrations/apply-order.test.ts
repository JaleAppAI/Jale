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
  '020b_rls_relationship_recursion_prevention.sql',
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
  '035_job_delete_grants.sql',
  '036_billing_job_limit_enforcement.sql',
  '037_email_outbox.sql',
  '038_rls_relationship_recursion_repair.sql',
  '039_whatsapp_support_cases.sql',
  '040_whatsapp_delivery_status.sql',
  '041_whatsapp_web_worker_lookup_grant.sql',
  '042_whatsapp_onboarding_gate.sql',
  '043_whatsapp_worker_intent_transport.sql',
  '044_job_message_outbox_send_unknown.sql',
  '045_applications_employer_update_repair.sql',
  '046_whatsapp_active_workflow_rebind.sql',
  '047_whatsapp_identity_challenge_delete_hardening.sql',
  '048_worker_domain_outbox_user_fk.sql',
  '049_whatsapp_v2_flow_privilege_repair.sql',
  '050_whatsapp_v2_profile_steps.sql',
  '051_whatsapp_voice_intake_control.sql',
  '052_worker_pending_name_and_skills_reset.sql',
  '053_whatsapp_web_worker_bypass.sql',
  '054_remove_onboarding_v2_control.sql',
  '055_job_conversations_application_index.sql',
  '056_job_referrals.sql',
  '057_job_public_listing_opt_in.sql',
  '058_referral_open_dedupe_grant.sql',
  '059_share_link_claim_read.sql',
  '060_trade_aliases.sql',
  '061_job_geo_and_seo_grants.sql',
  '062_job_visibility_outbox.sql',
  '063_employer_referral_links.sql',
  '064_public_job_context_functions.sql',
  '065_city_keys_and_preferred_cities.sql',
  '066_preferred_cities_whatsapp_read.sql',
  '067_city_key_backfill_repair.sql',
  '068_preferred_city_centroids.sql',
  '069_employer_job_templates.sql',
  '070_worker_applied_job_visibility.sql',
  '071_wage_references.sql',
  '072_whatsapp_retrigger_sweep_definer.sql',
  '073_job_application_requirements.sql',
  '074_job_optional_requirements.sql',
  '075_worker_documents_multi_certification.sql',
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

  it('adds the WhatsApp onboarding v2 model and MM callback support in migration 042', () => {
    const migration = readMigration('042_whatsapp_onboarding_gate.sql');

    for (const tableName of [
      'worker_onboarding_state', 'worker_workflow_runs', 'worker_workflow_transitions',
      'worker_identity_challenges', 'worker_message_intents', 'worker_domain_outbox',
      'whatsapp_runtime_controls', 'worker_reset_audit',
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tableName}\\s*\\(`, 'i'));
    }

    for (const check of [
      "CHECK (lifecycle IN ('onboarding', 'ready', 'suspended'))",
      "CHECK (status IN ('active', 'completed', 'declined', 'cancelled', 'failed'))",
      "CHECK (status IN ('pending', 'verified', 'expired', 'locked', 'superseded'))",
      "CHECK (status IN ('deferred', 'eligible', 'leased', 'released', 'delivered',\n                  'expired', 'superseded', 'rejected', 'failed'))",
      "CHECK (category IN ('onboarding', 'security', 'account', 'job_alert', 'employer_chat'))",
      "CHECK (owner_service IN ('onboarding-v2', 'identity', 'job-alert', 'job-messaging', 'account'))",
      "CHECK (status IN ('pending', 'processing', 'completed', 'failed'))",
      "CHECK (event_type IN ('assessment.requested', 'worker.ready'))",
      "CHECK (current_step_key IN ('start.choose_language', 'identity.verify_otp'))",
      "CHECK (current_step_key IN ('start.choose_language', 'identity.verify_otp', 'legal.review', 'profile.name', 'profile.location', 'profile.trade', 'profile.custom_trade', 'trust.question.1', 'trust.question.2', 'trust.question.3'))",
      "CHECK (preferred_language IN ('en', 'es'))",
    ]) expect(migration).toContain(check);

    for (const name of [
      'worker_workflow_one_active', 'worker_message_intent_dedupe',
      'worker_domain_outbox_event_key', 'worker_message_intents_release_sequence_unique',
    ]) expect(migration).toContain(name);

    for (const tableName of [
      'worker_onboarding_state', 'worker_workflow_runs', 'worker_workflow_transitions',
      'worker_identity_challenges', 'worker_message_intents', 'worker_domain_outbox',
      'worker_reset_audit', 'whatsapp_runtime_controls',
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${tableName} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE public.${tableName} FORCE ROW LEVEL SECURITY`);
    }

    expect(migration).not.toMatch(/GRANT\s+SELECT\s+ON\s+(?:public\.)?worker_/i);
    expect(migration).toContain("p_event_type IS NULL OR p_limit IS NULL");
    expect(migration).not.toContain("attempts = e.attempts + 1");
    expect(migration).toContain("pre-auth status transition");
    expect(migration).not.toMatch(/GRANT SELECT \([^;]+\)\s+ON public\.worker_identity_challenges/s);
    expect(migration).toContain("pg_catalog.pg_constraint");
    expect(migration).toContain("pg_catalog.pg_index");
    expect(migration).toContain("pg_catalog.pg_get_constraintdef");
    expect(migration).toContain("pg_catalog.pg_get_expr");
    expect(migration).toContain("pg_catalog.pg_get_constraintdef(con.oid) = expected.definition");
    expect(migration).toContain("pg_catalog.pg_get_expr(idx.indpred, idx.indrelid) = expected.predicate");
    expect(migration).toContain("source_type IN ('admin_case', 'job_alert', 'worker_intent')");
    expect(migration).toContain("has_any_column_privilege");
    expect(migration).toContain("'^(SM|MM)[0-9A-Fa-f]{32}$'");
    expect(migration).toContain('lease_worker_domain_events');
    expect(migration).toContain('is_worker_ready_for_v2_delivery');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.is_worker_ready_for_v2_delivery(UUID) FROM PUBLIC',
    );
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

  it('carries the 038 recursion repair forward to 020b so a fresh cluster never hits 023\'s 42P17', () => {
    const migration = readMigration('020b_rls_relationship_recursion_prevention.sql');

    expect(migration).toContain('CREATE ROLE jale_rls_relationship_reader');
    expect(migration).toContain("policyname = 'applications_employer_update'");
    expect(migration).toContain('CREATE POLICY applications_employer_update');
    expect(migration.match(/ALTER POLICY/g)).toHaveLength(8);
    expect(migration).toContain('CREATE SCHEMA jale_internal AUTHORIZATION jale_rls_relationship_reader');
    expect(migration).toContain('CREATE FUNCTION jale_internal.employer_has_applicant_relationship');
    expect(migration).toContain('CREATE POLICY users_employer_applicant_read');
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

  it('re-runs the 065 backfills under a USING(true) helper role in migration 067', () => {
    const sql = readMigration('067_city_key_backfill_repair.sql');
    expect(sql).toContain('CREATE ROLE jale_location_backfill');
    expect(sql).toContain('GRANT jale_location_backfill TO jale_admin WITH SET TRUE, INHERIT FALSE');
    expect(sql).toContain('SET ROLE jale_location_backfill');
    expect(sql).toContain('RESET ROLE');
    expect(sql).toContain('WHERE city_key IS NULL');
    expect(sql).toContain("WHERE location_source = 'map_pin'");
    // The write policies are one-shot: created before the backfill, dropped after.
    expect(sql).toContain('DROP POLICY IF EXISTS jobs_location_backfill_update ON jobs;');
    // The SELECT policy on jobs survives for the ops monitoring query.
    expect(sql).toContain('jobs_location_backfill_select');
  });

  it('adds range-checked centroid columns to worker_preferred_cities in migration 068', () => {
    const sql = readMigration('068_preferred_city_centroids.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9,6)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6)');
    expect(sql).toContain('worker_preferred_cities_coords_complete');
    expect(sql).toContain('(latitude IS NULL) = (longitude IS NULL)');
  });

  it('adds the employer job templates table with entitlement seeds in migration 069', () => {
    const sql = readMigration('069_employer_job_templates.sql');
    expect(sql).toContain('CREATE TABLE employer_job_templates');
    expect(sql).toContain('UNIQUE (employer_id, name)');
    expect(sql).toContain('ALTER TABLE employer_job_templates FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('employer_job_templates_self');
    expect(sql).toContain(`'{"template_limit": 2}'`);
    expect(sql).toContain(`'{"template_limit": 20}'`);
    // The seed must run under a temporary write policy (billing_plans is
    // FORCE RLS, SELECT-only) and must fail loudly if it touched 0 rows.
    expect(sql).toContain('billing_plans_template_seed');
    expect(sql).toContain('template_limit seed failed');
  });

  it('adds worker applied-job visibility in migration 070', () => {
    const sql = readMigration('070_worker_applied_job_visibility.sql');
    expect(sql).toContain('jale_internal.worker_has_application');
    expect(sql).toContain('jobs_worker_read_applied');
    expect(sql).toContain('FOR SELECT TO jale_admin');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, pg_temp');
    // TEXT param compared as ::TEXT — a UUID param would 22P02 on the
    // empty-string GUC left behind on warm pooled connections.
    expect(sql).toContain('p_worker_internal_id TEXT');
    expect(sql).toContain('ja.worker_id::TEXT = p_worker_internal_id');
    // The SET TRUE / SET FALSE + revoke choreography must restore the
    // exactly-one-membership invariant that 020b/038 assert on rerun.
    expect(sql).toContain('REVOKE jale_rls_relationship_reader FROM jale_admin GRANTED BY jale_admin');
  });

  it('adds wage_references and city_cbsa_crosswalk as FORCE-RLS, read-only-to-jale_admin reference tables in migration 071', () => {
    const sql = readMigration('071_wage_references.sql');

    // wage_references shape
    expect(sql).toContain('CREATE TABLE wage_references');
    expect(sql).toContain('PRIMARY KEY (trade_category, area_code)');
    expect(sql).toContain("CHECK (trade_category IN (");
    for (const trade of [
      'electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'drywall', 'general_labor', 'other',
    ]) {
      expect(sql).toContain(`'${trade}'`);
    }
    expect(sql).toContain("CHECK (area_kind IN ('metro', 'nonmetro', 'state'))");
    expect(sql).toContain("CHECK (source_tier IN ('metro', 'nonmetro', 'state'))");
    expect(sql).toContain('CHECK (p25_hourly > 0 AND p25_hourly <= p50_hourly AND p50_hourly <= p75_hourly)');

    // city_cbsa_crosswalk shape
    expect(sql).toContain('CREATE TABLE city_cbsa_crosswalk');
    expect(sql).toContain('city_key    TEXT PRIMARY KEY');
    expect(sql).toContain("CHECK (area_kind IN ('metro', 'nonmetro'))");

    // RLS: ENABLE + FORCE on both, read-all SELECT-only for jale_admin, no write policy at all
    expect(sql).toContain('ALTER TABLE wage_references ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE wage_references FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE city_cbsa_crosswalk ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE city_cbsa_crosswalk FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY wage_references_read_all');
    expect(sql).toContain('CREATE POLICY city_cbsa_crosswalk_read_all');
    expect(sql).toContain('GRANT SELECT ON wage_references TO jale_admin');
    expect(sql).toContain('GRANT SELECT ON city_cbsa_crosswalk TO jale_admin');

    // No write policy or write grant of any kind for anyone -- the seed
    // script opens its own temporary policy at runtime (069's pattern).
    expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR\s+(INSERT|UPDATE|DELETE|ALL)/i);
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);

    // Explicitly no grant or policy naming jale_public_jobs or jale_whatsapp
    // (the migration's header comment mentions both by name to explain the
    // exclusion, so strip SQL line-comments before searching for actual
    // GRANT/POLICY statements rather than doing a blanket string search).
    const sqlNoComments = sql.replace(/--.*$/gm, '');
    expect(sqlNoComments).not.toMatch(/GRANT[^;]*jale_public_jobs/i);
    expect(sqlNoComments).not.toMatch(/GRANT[^;]*jale_whatsapp/i);
    expect(sqlNoComments).not.toMatch(/CREATE POLICY[^;]*TO jale_public_jobs/i);
    expect(sqlNoComments).not.toMatch(/CREATE POLICY[^;]*TO jale_whatsapp/i);

    // No rows seeded by the migration itself -- population is the loader's job.
    expect(sql).not.toMatch(/INSERT INTO wage_references/i);
    expect(sql).not.toMatch(/INSERT INTO city_cbsa_crosswalk/i);
  });

  it('adds the deferred-retrigger sweep definer in migration 072', () => {
    const sql = readMigration('072_whatsapp_retrigger_sweep_definer.sql');
    expect(sql).toContain('retrigger_deferred_ready_workers');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, pg_temp');
    expect(sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(sql).toContain("'worker.ready:sweep:'");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.retrigger_deferred_ready_workers(TEXT, INTEGER) FROM PUBLIC');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.retrigger_deferred_ready_workers(TEXT, INTEGER) TO jale_whatsapp');
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
