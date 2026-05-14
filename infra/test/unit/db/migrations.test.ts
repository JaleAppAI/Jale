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
      expect(script).not.toContain('003_whatsapp.sql');
      expect(script).not.toContain('004_jobs.sql');
      expect(script).not.toContain('005_job_applications.sql');
      expect(script).not.toContain('006_whatsapp_reliability.sql');
      expect(script).not.toContain('007_trust_signal_layer.sql');
    }
  });
});
