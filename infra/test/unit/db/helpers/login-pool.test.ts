import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadManifest } from '../../../../db/access/access-manifest';
import {
  currentDbProfile,
  itInProfiles,
  loginUrl,
  profileMode,
  testPasswordFor,
  TEST_LOGINS,
} from './login-pool';

// Unit checks for the shared test-bed login helper. No database: everything
// here is string handling plus a cross-check that the bootstrap script and
// the helper agree on every login's test password.

const infraRoot = path.join(__dirname, '..', '..', '..', '..');
const bootstrapPath = path.join(infraRoot, 'db', 'local', 'bootstrap-testbed.sh');
const passwordsHelper = path.join(infraRoot, 'db', 'local', 'testbed-login-passwords.mjs');
const shippedAccessDir = path.join(infraRoot, 'db', 'access');

/** Runs the step-8 helper on a manifest directory; returns [login, password] rows. */
function helperRows(dir: string): string[][] {
  const sql = execFileSync(process.execPath, [passwordsHelper, dir], { encoding: 'utf8' });
  return [...sql.matchAll(/\('(jale_[a-z_]+)',\s*'([^']+)'\)/g)].map((m) => [m[1], m[2]]);
}

/** A copy of the shipped manifest directory plus the given fragments. */
function accessDirWith(fragments: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-login-pool-'));
  fs.copyFileSync(path.join(shippedAccessDir, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.mkdirSync(path.join(dir, 'manifest.d'));
  const shippedFragments = path.join(shippedAccessDir, 'manifest.d');
  if (fs.existsSync(shippedFragments)) {
    for (const name of fs.readdirSync(shippedFragments)) {
      fs.copyFileSync(path.join(shippedFragments, name), path.join(dir, 'manifest.d', name));
    }
  }
  for (const [name, body] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(dir, 'manifest.d', name), JSON.stringify(body));
  }
  return dir;
}

const fragmentLogin = {
  kind: 'job',
  created_by: '107',
  connection_limit: 5,
  prepare_secret: true,
  workloads: 'A fragment-defined job.',
  reason: 'Fixture login added by a fragment.',
};

const BED_URL = 'postgres://postgres:test@127.0.0.1:55471/jale';

describe('login-pool helper', () => {
  it('derives the test password from the login name the way the existing suites do', () => {
    expect(testPasswordFor('jale_admin')).toBe('test-admin-pw');
    expect(testPasswordFor('jale_admin_console')).toBe('test-adminconsole-pw');
    expect(testPasswordFor('jale_public_jobs')).toBe('test-publicjobs-pw');
    expect(testPasswordFor('jale_whatsapp')).toBe('test-whatsapp-pw');
    expect(testPasswordFor('jale_api')).toBe('test-api-pw');
    expect(testPasswordFor('jale_api_public')).toBe('test-apipublic-pw');
    expect(testPasswordFor('jale_job_email_sender')).toBe('test-jobemailsender-pw');
  });

  it('refuses anything that is not a jale_ login name', () => {
    expect(() => testPasswordFor('postgres')).toThrow(/not a test-bed login/);
    expect(() => testPasswordFor('jale_api; DROP')).toThrow(/not a test-bed login/);
    expect(() => testPasswordFor('JALE_API')).toThrow(/not a test-bed login/);
  });

  it('step 8 of bootstrap-testbed.sh lists no login of its own: it reads the merged access manifest', () => {
    const script = fs.readFileSync(bootstrapPath, 'utf8');
    const step8 = script.slice(script.indexOf('# 8. '), script.indexOf('# 8b. '));
    expect(step8).toContain('testbed-login-passwords.mjs');
    expect(step8).toContain('infra/db/access');
    expect(step8).not.toMatch(/\('jale_[a-z_]+',\s*'test-/);
  });

  it('the step-8 helper gives every login of the merged manifest its test password, and nothing else', () => {
    const rows = helperRows(shippedAccessDir);
    expect(rows.map(([login]) => login)).toEqual([...TEST_LOGINS].sort());
    for (const [login, password] of rows) {
      expect([login, password]).toEqual([login, testPasswordFor(login)]);
    }
  });

  it('the step-8 helper includes a login that a fragment adds', () => {
    const dir = accessDirWith({ 'zz-fixture.json': { logins: { jale_job_fragment_fixture: fragmentLogin } } });
    try {
      expect(helperRows(dir)).toContainEqual(['jale_job_fragment_fixture', 'test-jobfragmentfixture-pw']);
      expect(helperRows(dir)).toHaveLength(TEST_LOGINS.length + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the step-8 helper refuses a dot-named fragment, as the manifest loader does', () => {
    const dir = accessDirWith({ '.zz-hidden.json': { logins: { jale_job_fragment_fixture: fragmentLogin } } });
    try {
      const hidden = spawnSync(process.execPath, [passwordsHelper, dir], { encoding: 'utf8' });
      expect(hidden.status).not.toBe(0);
      expect(hidden.stderr).toContain('manifest.d holds dot-named files (.zz-hidden.json)');
      expect(hidden.stdout).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the step-8 helper refuses a login name the password rule cannot map, and a missing manifest', () => {
    const dir = accessDirWith({ 'zz-fixture.json': { logins: { jale_job_export2: fragmentLogin } } });
    try {
      const bad = spawnSync(process.execPath, [passwordsHelper, dir], { encoding: 'utf8' });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain('jale_job_export2 is not a test-bed login name');
      expect(bad.stdout).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const missing = spawnSync(process.execPath, [passwordsHelper, path.join(os.tmpdir(), 'jale-no-such-dir')], { encoding: 'utf8' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('manifest.json is missing');
  });

  it('covers every login the merged access manifest declares, fragments included', () => {
    const manifest = loadManifest();
    expect([...TEST_LOGINS].sort()).toEqual(Object.keys(manifest.logins).sort());
    // The master's test password comes from the bootstrap's own admin step.
    expect(TEST_LOGINS).not.toContain(manifest.master);
  });

  it('builds a URL for a named login on the same local test bed, never echoing the superuser password', () => {
    const url = new URL(loginUrl('jale_api', BED_URL));
    expect(url.username).toBe('jale_api');
    expect(url.password).toBe('test-api-pw');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('55471');
    expect(url.pathname).toBe('/jale');
    expect(url.toString()).not.toContain(':test@');
  });

  it('refuses a base URL that is not a local test bed, and a missing one', () => {
    expect(() => loginUrl('jale_api', 'postgres://postgres:test@db.example.internal:5432/jale'))
      .toThrow(/local test bed/);
    // The base URL defaults to JALE_TEST_DATABASE_URL, which a run on a bed
    // exports; remove it for this one call so the missing-URL case is real.
    const exported = process.env.JALE_TEST_DATABASE_URL;
    delete process.env.JALE_TEST_DATABASE_URL;
    try {
      expect(() => loginUrl('jale_api')).toThrow(/JALE_TEST_DATABASE_URL/);
    } finally {
      if (exported !== undefined) process.env.JALE_TEST_DATABASE_URL = exported;
    }
  });

  it('reads the profile from JALE_TEST_DB_PROFILE, defaulting to standard and rejecting unknown values', () => {
    expect(currentDbProfile({})).toBe('standard');
    expect(currentDbProfile({ JALE_TEST_DB_PROFILE: '' })).toBe('standard');
    expect(currentDbProfile({ JALE_TEST_DB_PROFILE: 'standard' })).toBe('standard');
    expect(currentDbProfile({ JALE_TEST_DB_PROFILE: 'request' })).toBe('request');
    expect(currentDbProfile({ JALE_TEST_DB_PROFILE: 'owner-unrestricted' })).toBe('owner-unrestricted');
    expect(() => currentDbProfile({ JALE_TEST_DB_PROFILE: 'production' })).toThrow(/unknown test-bed profile/);
  });

  it('decides whether a profile-scoped suite or test runs, is not applicable, or skips for want of a database', () => {
    const bed = { JALE_TEST_DATABASE_URL: BED_URL };
    expect(profileMode(['standard', 'request'], {})).toBe('skip');
    expect(profileMode(['standard', 'request'], bed)).toBe('run');
    expect(profileMode(['standard', 'request'], { ...bed, JALE_TEST_DB_PROFILE: 'request' })).toBe('run');
    expect(profileMode(['standard', 'request'], { ...bed, JALE_TEST_DB_PROFILE: 'owner-unrestricted' })).toBe('not-applicable');
    expect(profileMode(['owner-unrestricted'], { ...bed, JALE_TEST_DB_PROFILE: 'owner-unrestricted' })).toBe('run');
  });

});

describe('itInProfiles', () => {
  // Registration reads the profile, so the environment is set only while the
  // two tests below are registered, then restored.
  const saved = { url: process.env.JALE_TEST_DATABASE_URL, profile: process.env.JALE_TEST_DB_PROFILE };
  process.env.JALE_TEST_DATABASE_URL = BED_URL;
  process.env.JALE_TEST_DB_PROFILE = 'owner-unrestricted';
  const ran: string[] = [];
  itInProfiles(['owner-unrestricted'], 'runs in a listed profile', () => { ran.push('listed'); });
  itInProfiles(['standard', 'request'], 'records a passing test in any other profile', () => { ran.push('unlisted'); });
  if (saved.url === undefined) delete process.env.JALE_TEST_DATABASE_URL; else process.env.JALE_TEST_DATABASE_URL = saved.url;
  if (saved.profile === undefined) delete process.env.JALE_TEST_DB_PROFILE; else process.env.JALE_TEST_DB_PROFILE = saved.profile;

  it('ran the listed test and only recorded the other one', () => {
    expect(ran).toEqual(['listed']);
  });
});
