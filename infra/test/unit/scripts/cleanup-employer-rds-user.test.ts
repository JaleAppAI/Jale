import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandHereString, hereStringBody, hereStringVariables } from './helpers/powershell-strings';

const scriptPath = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'cleanup-employer-rds-user.ps1');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

/** The address check the script applies before anything else, read from the script. */
function emailRule(): RegExp {
  const pattern = /^if \(\$Email -notmatch '([^']+)'\) \{$/m.exec(readScript())?.[1];
  if (pattern === undefined) throw new Error('the script has no email check');
  // PowerShell's -notmatch is case-insensitive.
  return new RegExp(pattern, 'i');
}

/**
 * The bash script sent to the bastion for one address, built the way the
 * script builds it: the cleanup SQL with the address's quotes doubled, that
 * SQL base64-encoded, then the remote script's here-string, with CRLF made LF.
 */
function remoteScriptFor(email: string): string {
  const script = readScript();
  const sql = expandHereString(hereStringBody(script, 'sql'), { EmailSql: email.replace(/'/g, "''") });
  const sqlB64 = Buffer.from(sql, 'utf8').toString('base64');
  return expandHereString(hereStringBody(script, 'remoteScript'), {
    Region: 'us-east-2',
    dbSecretArn: 'test-database-secret',
    sqlB64,
    Email: email,
  }).replace(/\r\n/g, '\n');
}

interface RemoteRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** One line per time bash ran `id`. */
  idRuns: string[];
  /** The SQL psql was given. */
  sql: string;
}

/**
 * Runs the remote script under bash the way the bastion would, with fakes for
 * aws, jq and psql first on PATH and a recording stub named `id`: every time
 * bash runs `id`, the stub writes a line, and does nothing else.
 */
function runRemote(remote: string): RemoteRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-employer-cleanup-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const idLog = path.join(dir, 'id-runs.log');
    const sqlCopy = path.join(dir, 'psql-input.sql');
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    stub('id', `printf 'id ran\\n' >> '${idLog}'`);
    stub('aws', `printf '%s\\n' '{"host":"db.test.invalid","port":5432,"dbname":"jale","username":"test-admin","password":"test-pw"}'`);
    stub('jq', [
      'cat > /dev/null',
      'case "$2" in',
      '  .host) echo db.test.invalid ;;',
      '  .port) echo 5432 ;;',
      "  '.dbname // \"jale\"') echo jale ;;",
      '  .username) echo test-admin ;;',
      '  .password) echo test-pw ;;',
      '  *) exit 9 ;;',
      'esac',
    ].join('\n'));
    stub('psql', `while [[ $# -gt 0 ]]; do if [[ "$1" == -f ]]; then cp "$2" '${sqlCopy}'; fi; shift; done`);

    // The script's scratch file is a fixed path under /tmp; this harness moves
    // it into its own directory and changes nothing else.
    const scratch = '/tmp/jale-cleanup-employer-user.sql';
    expect(remote.split(scratch)).toHaveLength(2);
    const file = path.join(dir, 'remote.sh');
    fs.writeFileSync(file, remote.replace(scratch, path.join(dir, 'scratch.sql')));

    const run = spawnSync('/bin/bash', [file], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
      timeout: 30_000,
    });
    return {
      status: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      idRuns: fs.existsSync(idLog) ? fs.readFileSync(idLog, 'utf8').split('\n').filter(Boolean) : [],
      sql: fs.existsSync(sqlCopy) ? fs.readFileSync(sqlCopy, 'utf8') : '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Addresses that pass the script's check and carry shell syntax: a command
// substitution, and the same in backticks.
const SHELL_SHAPED_ADDRESSES = ['a$(id)@example.com', 'a`id`@example.com'];

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

  describe('the script sent to the bastion', () => {
    it('inserts only the region, the secret id and the encoded SQL, never an operator value', () => {
      const body = hereStringBody(readScript(), 'remoteScript');
      expect(hereStringVariables(body).sort()).toEqual(['Region', 'dbSecretArn', 'sqlB64']);
    });

    it.each(SHELL_SHAPED_ADDRESSES)('never runs shell syntax from the address %s, which the address check accepts', (email) => {
      expect(emailRule().test(email)).toBe(true);

      const run = runRemote(remoteScriptFor(email));

      expect(run.idRuns).toEqual([]);
      // The harness ran the whole script: psql got the cleanup SQL, and the
      // completion line, which is fixed text, came last.
      expect(run.status).toBe(0);
      expect(run.stdout.trim().split('\n').pop()).toBe('>> Employer RDS user cleanup completed.');
      // The address reaches the database only as a quoted literal.
      expect(run.sql).toContain(`lower(email) = lower('${email}')`);
    });
  });
});
