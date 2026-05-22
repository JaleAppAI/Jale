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
});
