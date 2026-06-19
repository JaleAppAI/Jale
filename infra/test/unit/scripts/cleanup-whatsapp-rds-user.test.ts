import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'cleanup-whatsapp-rds-user.ps1');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

describe('cleanup-whatsapp-rds-user.ps1', () => {
  it('deletes rows from every worker-owned cleanup table before users', () => {
    const script = readScript();

    for (const tableName of [
      'whatsapp_outbox',
      'whatsapp_processed_messages',
      'whatsapp_conversations',
      'document_upload_tokens',
      'worker_documents',
      'job_conversations',
      'job_applications',
      'legal_consent_log',
      'worker_profile_ai_extractions',
      'worker_profile_media',
      'worker_trust_assessments',
      'worker_skills',
      'job_candidates',
      'worker_job_impressions',
      'worker_match_log',
      'worker_profiles',
      'users',
    ]) {
      expect(script).toContain(tableName);
    }

    expect(script.indexOf("DELETE FROM job_conversations")).toBeGreaterThan(
      script.indexOf("worker_match_log"),
    );
    expect(script.indexOf("DELETE FROM job_applications")).toBeGreaterThan(
      script.indexOf("DELETE FROM job_conversations"),
    );
    expect(script.indexOf("DELETE FROM users")).toBeGreaterThan(script.indexOf("worker_trust_assessments"));
    expect(script.indexOf("DELETE FROM users")).toBeGreaterThan(script.indexOf("worker_match_log"));
  });

  it('deletes the worker Cognito user by phone after the database cleanup succeeds', () => {
    const script = readScript();

    expect(script).toContain('[string]$WorkerPoolId');
    expect(script).toContain('jale-worker-pool');
    expect(script).toContain('list-users');
    expect(script).toContain('Get-CognitoWorkerUsersByPhone');
    expect(script).toContain('--pagination-token');
    expect(script).toContain("Name -eq 'phone_number'");
    expect(script).toContain('admin-delete-user');
    expect(script).toContain('--username $cognitoUsername');
    expect(script).toContain('Cognito worker cleanup verified');
    expect(script.indexOf('admin-delete-user')).toBeGreaterThan(script.indexOf('Final bastion stdout'));
    expect(script).toMatch(/UserNotFoundException/);
  });

  it('resolves the admin database secret instead of service-role secrets', () => {
    const script = readScript();

    expect(script).toContain("contains(LogicalResourceId, 'DatabaseSecret')");
    expect(script).not.toContain("--query \"StackResources[?ResourceType=='AWS::SecretsManager::Secret'].PhysicalResourceId\"");
  });
});
