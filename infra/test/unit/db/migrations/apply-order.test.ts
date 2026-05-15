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
  it('locks the 001-016 readiness baseline order', () => {
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

  it('documents canonical matching source fields in the architecture guide', () => {
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

  maybeIt('applies migrations 001-016 against a local Postgres database', async () => {
    const columns = await applyMigrationsAndReadColumns(databaseUrl!);

    expect(columns.get('users')?.get('trust_signals')).toBe('jsonb');
    expect(columns.get('worker_profiles')?.get('years_experience')).toBe('integer');
    expect(columns.get('jobs')?.get('required_docs')).toBe('_text');
  });
});
