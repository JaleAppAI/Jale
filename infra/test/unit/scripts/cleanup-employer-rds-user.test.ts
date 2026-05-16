import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'cleanup-employer-rds-user.ps1');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

describe('cleanup-employer-rds-user.ps1', () => {
  it('deletes employer-owned rows before users', () => {
    const script = readScript();

    for (const tableName of [
      'document_upload_tokens',
      'worker_documents',
      'employer_candidate_rankings',
      'job_candidates',
      'worker_job_impressions',
      'worker_match_log',
      'job_applications',
      'jobs',
      'employer_profiles',
      'legal_consent_log',
      'users',
    ]) {
      expect(script).toContain(tableName);
    }

    expect(script.indexOf('DELETE FROM users')).toBeGreaterThan(script.indexOf('DELETE FROM jobs'));
    expect(script.indexOf('DELETE FROM users')).toBeGreaterThan(script.indexOf('legal_consent_log'));
  });

  it('deletes the employer Cognito user by email after the database cleanup succeeds', () => {
    const script = readScript();

    expect(script).toContain('[string]$EmployerPoolId');
    expect(script).toContain('jale-employer-pool');
    expect(script).toContain('admin-delete-user');
    expect(script).toContain('--username $Email');
    expect(script.indexOf('admin-delete-user')).toBeGreaterThan(script.indexOf('Final bastion stdout'));
    expect(script).toMatch(/UserNotFoundException/);
  });

  it('resolves the admin database secret instead of service-role secrets', () => {
    const script = readScript();

    expect(script).toContain("contains(LogicalResourceId, 'DatabaseSecret')");
    expect(script).not.toContain("--query \"StackResources[?ResourceType=='AWS::SecretsManager::Secret'].PhysicalResourceId\"");
  });
});
