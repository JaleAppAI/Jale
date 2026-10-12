import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

// infra/test/unit/scripts -> infra
const infraRoot = path.join(__dirname, '..', '..', '..');
const scriptPath = path.join(infraRoot, 'scripts', 'run-whatsapp-v2-db-tests.sh');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

/**
 * The runner's SUITES=( ... ) array, in order. Parsed from that block alone, so
 * a suite path mentioned in a comment elsewhere in the script is never read
 * as a registration.
 */
function registeredSuites(script = readScript()): string[] {
  const block = /^SUITES=\(\n([\s\S]*?)^\)$/m.exec(script);
  if (!block) throw new Error('run-whatsapp-v2-db-tests.sh has no SUITES=( ... ) block');
  return block[1]
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

function testFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...testFilesUnder(full));
    else if (entry.name.endsWith('.test.ts')) files.push(path.relative(infraRoot, full).split(path.sep).join('/'));
  }
  return files;
}

// A test reaches a database when it reads a test-database URL from the
// environment (JALE_TEST_DATABASE_URL, JALE_TEST_UPGRADE_DATABASE_URL, ...).
const READS_A_TEST_DATABASE_URL = /process\.env\.JALE_TEST_[A-Z_]*DATABASE_URL/;

/**
 * Every database suite on disk, relative to infra/: each *.integration.test.ts
 * under test/unit/db, and any other test under test/unit that reads a
 * test-database URL, whatever it is named.
 */
function databaseSuitesOnDisk(): string[] {
  return testFilesUnder(path.join(infraRoot, 'test', 'unit'))
    .filter((file) =>
      (file.startsWith('test/unit/db/') && file.endsWith('.integration.test.ts'))
      || READS_A_TEST_DATABASE_URL.test(fs.readFileSync(path.join(infraRoot, file), 'utf8')))
    .sort();
}

/**
 * Database suites the default run does not include, each with the reason. Every
 * other database suite must be registered in SUITES.
 */
const EXCLUDED: Readonly<Record<string, string>> = {
  'test/unit/db/migrations/apply-order.test.ts':
    'It applies the migration chain itself as jale_admin, so it needs a virgin cluster '
    + '(bootstrap-testbed.sh --empty) rather than the migrated bed the registered suites share. '
    + "The database job's standard leg runs it alone with --suite.",
  'test/unit/db/migrations/billing-034-upgrade.test.ts':
    'It creates jale_admin itself and reads JALE_TEST_UPGRADE_DATABASE_URL, so it needs a bare '
    + 'cluster (bootstrap-testbed.sh --bare) rather than the migrated bed. '
    + "The database job's standard leg runs it alone with --suite.",
  'test/unit/db/helpers/login-pool.test.ts':
    'Not a database suite: unit tests of helpers/login-pool.ts. It sets the URL variable to a '
    + 'fake loopback value to exercise the helper and never connects, so it runs with the other '
    + 'unit tests in the infra job.',
};

// The order rules the SUITES list carries (the runner's sequencer runs it
// exactly as listed). Catalog-only suites first, before any fixture exists;
// then 043, whose global lease must find only its own row; and last the tail.
const CATALOG_FIRST = [
  'test/unit/db/least-privilege-coverage.integration.test.ts',
  'test/unit/db/least-privilege-posture.integration.test.ts',
  'test/unit/db/least-privilege-cap-functions.integration.test.ts',
];
const SUITE_LEASE_043 = 'test/unit/db/whatsapp-worker-intent-043.integration.test.ts';
// 093 leases worker_intent rows globally and advances the attempt count of
// every row it leases, so it follows every suite that could own one. After it
// come the suites that re-apply their migration file as jale_admin, in
// migration order: a replay takes ACCESS EXCLUSIVE locks and backfills every
// matching row on the bed.
const TAIL = [
  'test/unit/db/worker-intent-defer-093.integration.test.ts',
  'test/unit/db/sprint24-data-backfills-094.integration.test.ts',
  'test/unit/db/application-hire-ack-095.integration.test.ts',
  'test/unit/db/employer-conversation-read.integration.test.ts',
  'test/unit/db/worker-referred-jobs-103.integration.test.ts',
  'test/unit/db/access-manifest-alignment-114b.integration.test.ts',
];

/**
 * Runs the script with a scrubbed environment: no database URL and no profile
 * unless the overrides set one. The final verification battery runs with
 * JALE_TEST_DATABASE_URL exported, and jest inherits process.env, so these
 * children must not depend on it being absent.
 */
function runScript(args: string[], overrides: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JALE_TEST_DATABASE_URL;
  delete env.JALE_TEST_UPGRADE_DATABASE_URL;
  delete env.JALE_TEST_DB_PROFILE;
  delete env.JALE_DB_TEST_RESULTS;
  delete env.JALE_DB_TEST_PR_HEAD;
  delete env.GITHUB_STEP_SUMMARY;
  Object.assign(env, overrides);
  return spawnSync('bash', [scriptPath, ...args], { env, encoding: 'utf8' });
}

function output(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

// ---------------------------------------------------------------------------
// Jest JSON results fixtures. The shape is jest 30's --json output (field for
// field what `jest --json --outputFile` writes), built per suite so a test can
// make exactly one thing wrong.
// ---------------------------------------------------------------------------
type Status = 'passed' | 'failed' | 'pending' | 'todo' | 'skipped' | 'disabled' | 'focused';

interface SuiteSpec {
  file: string;
  statuses?: Status[];
  start?: number;
  suiteStatus?: string;
}

const realInfraRoot = fs.realpathSync(infraRoot);

function suiteResult(spec: SuiteSpec, index: number) {
  const statuses = spec.statuses ?? ['passed', 'passed'];
  const startTime = spec.start ?? 1_790_000_000_000 + index * 1_000;
  const assertionResults = statuses.map((status, n) => ({
    ancestorTitles: [`suite ${index}`],
    duration: status === 'passed' || status === 'failed' ? 4 : null,
    failing: false,
    failureDetails: [],
    failureMessages: status === 'failed' ? ['Error: expected 0, received 1'] : [],
    fullName: `suite ${index} case ${n}`,
    invocations: 1,
    location: null,
    numPassingAsserts: status === 'passed' ? 1 : 0,
    retryMessages: [],
    retryReasons: [],
    status,
    title: `case ${n}`,
    startAt: startTime + n,
  }));
  const failing = statuses.includes('failed');
  const allRan = statuses.every((status) => status === 'passed' || status === 'failed');
  return {
    assertionResults,
    endTime: startTime + 400,
    message: failing ? '  ● suite case failed' : '',
    name: path.join(realInfraRoot, spec.file),
    startTime,
    status: spec.suiteStatus ?? (failing ? 'failed' : allRan ? 'passed' : 'focused'),
    summary: '',
  };
}

function jestResults(specs: SuiteSpec[]) {
  const testResults = specs.map(suiteResult);
  const all = testResults.flatMap((suite) => suite.assertionResults);
  const count = (...statuses: Status[]) => all.filter((test) => statuses.includes(test.status)).length;
  const failedSuites = testResults.filter((suite) => suite.status === 'failed').length;
  return {
    numFailedTestSuites: failedSuites,
    numFailedTests: count('failed'),
    numPassedTestSuites: testResults.filter((suite) => suite.status !== 'failed').length,
    numPassedTests: count('passed'),
    numPendingTestSuites: testResults.filter((suite) => suite.status === 'skipped').length,
    numPendingTests: count('pending', 'skipped', 'disabled'),
    numRuntimeErrorTestSuites: 0,
    numTodoTests: count('todo'),
    numTotalTestSuites: testResults.length,
    numTotalTests: all.length,
    openHandles: [],
    snapshot: {
      added: 0, didUpdate: false, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [],
      filesUnmatched: 0, filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [],
      unmatched: 0, updated: 0,
    },
    startTime: 1_789_999_999_000,
    // Jest reports success with pending tests: only failures clear it.
    success: failedSuites === 0,
    testResults,
    wasInterrupted: false,
  };
}

/** Every registered suite, once, in order, every test passing. */
function cleanSpecs(): SuiteSpec[] {
  return registeredSuites().map((file) => ({ file }));
}

let scratch: string;
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'run-db-tests-'));
});
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

let fixtureCount = 0;
function checkResults(results: unknown, overrides: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  fixtureCount += 1;
  const file = path.join(scratch, `results-${fixtureCount}.json`);
  fs.writeFileSync(file, typeof results === 'string' ? results : JSON.stringify(results));
  return runScript(['--check-results', file], overrides);
}

describe('run-whatsapp-v2-db-tests.sh registers every database suite', () => {
  it('registers every database suite on disk, or excuses it with a reason', () => {
    const registered = new Set(registeredSuites());
    const unaccounted = databaseSuitesOnDisk().filter((file) => !registered.has(file) && !(file in EXCLUDED));
    expect(unaccounted).toEqual([]);
  });

  it('registers each suite once, only database suites that exist, and nothing it also excuses', () => {
    const suites = registeredSuites();
    const onDisk = new Set(databaseSuitesOnDisk());
    expect(suites.filter((file, index) => suites.indexOf(file) !== index)).toEqual([]);
    expect(suites.filter((file) => !onDisk.has(file))).toEqual([]);
    expect(suites.filter((file) => file in EXCLUDED)).toEqual([]);
  });

  it('excuses only database suites that exist, each with a reason', () => {
    const onDisk = new Set(databaseSuitesOnDisk());
    for (const [file, reason] of Object.entries(EXCLUDED)) {
      expect({ file, onDisk: onDisk.has(file) }).toEqual({ file, onDisk: true });
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('runs the catalog-only suites first, then 043, and ends with the 093 lease and the migration re-apply tail', () => {
    const suites = registeredSuites();
    expect(suites.slice(0, CATALOG_FIRST.length + 1)).toEqual([...CATALOG_FIRST, SUITE_LEASE_043]);
    expect(suites.slice(-TAIL.length)).toEqual(TAIL);
  });

  it('runs jest in band, by exact path, in the declared order, and checks the JSON it writes', () => {
    const script = readScript();
    expect(script).toContain('--runInBand');
    expect(script).toContain('--runTestsByPath');
    expect(script).toContain('--testSequencer');
    expect(script).toMatch(/--json --outputFile/);
    // jest must not replace the shell: the results check runs after it.
    expect(script).not.toMatch(/\bexec\s+npx\s+jest/);
  });
});

describe('run-whatsapp-v2-db-tests.sh results check (--check-results)', () => {
  it('accepts results in which every registered suite ran once, in order, with every test passing', () => {
    const result = checkResults(jestResults(cleanSpecs()));
    expect({ status: result.status, out: output(result) }).toMatchObject({ status: 0 });
    for (const file of registeredSuites()) {
      expect(result.stdout).toContain(file);
    }
  });

  it('fails on a single pending test, naming its suite and the test', () => {
    const specs = cleanSpecs();
    specs[2] = { ...specs[2], statuses: ['passed', 'pending'] };
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`${specs[2].file} › suite 2 case 1: pending`);
  });

  it('fails on a todo test', () => {
    const specs = cleanSpecs();
    specs[0] = { ...specs[0], statuses: ['passed', 'todo'] };
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`${specs[0].file} › suite 0 case 1: todo`);
  });

  it('fails on a suite jest skipped as a whole', () => {
    const specs = cleanSpecs();
    specs[1] = { ...specs[1], statuses: ['pending', 'pending'], suiteStatus: 'skipped' };
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`${specs[1].file}: suite status skipped`);
  });

  it('fails on a failed test even when everything else passed', () => {
    const specs = cleanSpecs();
    specs[3] = { ...specs[3], statuses: ['passed', 'failed'] };
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`${specs[3].file} › suite 3 case 1: failed`);
  });

  it('fails when a registered suite did not run', () => {
    const specs = cleanSpecs();
    const [missing] = specs.splice(4, 1);
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`${missing.file}: did not run`);
  });

  it('fails when a suite ran twice, or a suite that is not registered ran', () => {
    const specs = cleanSpecs();
    const twice = specs[5].file;
    specs.push({ file: twice, start: 1_790_100_000_000 });
    specs.push({ file: 'test/unit/db/helpers/login-pool.test.ts', start: 1_790_100_001_000 });
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`${twice}: ran 2 times`);
    expect(output(result)).toContain('test/unit/db/helpers/login-pool.test.ts: ran, but is not registered');
  });

  it('fails when the suites ran out of the declared order', () => {
    const specs = cleanSpecs();
    const first = specs[0].file;
    const second = specs[1].file;
    specs[0] = { file: first, start: 1_790_000_001_500 };
    specs[1] = { file: second, start: 1_789_999_999_500 };
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`did not run in the declared order: position 1 should be ${first}, ran ${second}`);
  });

  it('fails on a suite that ran no tests', () => {
    const specs = cleanSpecs();
    specs[6] = { ...specs[6], statuses: [] };
    const result = checkResults(jestResults(specs));
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain(`${specs[6].file}: ran no tests`);
  });

  it('fails when the results file is missing or is not JSON', () => {
    const missing = runScript(['--check-results', path.join(scratch, 'no-such-results.json')]);
    expect(missing.status).not.toBe(0);
    expect(output(missing)).toContain('no readable jest results');
    const garbled = checkResults('{"testResults": [');
    expect(garbled.status).not.toBe(0);
    expect(output(garbled)).toContain('no readable jest results');
  });

  it('writes the commit, the profile and per-suite counts to the step summary', () => {
    const summary = path.join(scratch, 'step-summary.md');
    fs.writeFileSync(summary, '');
    const specs = cleanSpecs();
    specs[0] = { ...specs[0], statuses: ['passed', 'passed', 'passed'] };
    const result = checkResults(jestResults(specs), {
      GITHUB_STEP_SUMMARY: summary,
      JALE_TEST_DB_PROFILE: 'owner-unrestricted',
      JALE_DB_TEST_PR_HEAD: 'f'.repeat(40),
    });
    expect(result.status).toBe(0);
    const head = spawnSync('git', ['-C', infraRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const markdown = fs.readFileSync(summary, 'utf8');
    expect(markdown).toContain('owner-unrestricted');
    expect(markdown).toContain(head);
    expect(markdown).toContain('f'.repeat(40));
    expect(markdown).toContain(`| ${specs[0].file} | 3 | 3 | 0 | 0 | 0 |`);
    for (const file of registeredSuites()) {
      expect(markdown).toContain(`| ${file} |`);
    }
  });
});

describe('run-whatsapp-v2-db-tests.sh profile pass-through', () => {
  it('rejects an unknown JALE_TEST_DB_PROFILE before doing anything else', () => {
    const result = checkResults(jestResults(cleanSpecs()), { JALE_TEST_DB_PROFILE: 'production' });
    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/JALE_TEST_DB_PROFILE must be standard, request or owner-unrestricted/);
  });

  it('defaults the profile to standard and exports it to the suites', () => {
    const summary = path.join(scratch, 'default-profile.md');
    fs.writeFileSync(summary, '');
    const result = checkResults(jestResults(cleanSpecs()), { GITHUB_STEP_SUMMARY: summary });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(summary, 'utf8')).toContain('standard profile');
    // Exported, so every suite reads the same validated value. The runner
    // never filters suites by profile: a suite that applies to some profiles
    // declares it (describeInProfiles / itInProfiles in
    // test/unit/db/helpers/login-pool.ts), and the results check fails any
    // registered suite that did not run.
    expect(readScript()).toMatch(/^export JALE_TEST_DB_PROFILE=/m);
  });
});

describe('run-whatsapp-v2-db-tests.sh fail-closed URL guard', () => {
  it('never dereferences the URL value in an echo/printf (no credential leak)', () => {
    const script = readScript();
    // The variable NAME may appear as literal message text; its VALUE
    // (`$JALE_TEST_DATABASE_URL` / `${JALE_TEST_DATABASE_URL...}`) must never be
    // printed.
    expect(script).not.toMatch(/(echo|printf)[^\n]*\$\{?JALE_TEST_DATABASE_URL/);
  });

  it('exits non-zero with a clear message when JALE_TEST_DATABASE_URL is unset', () => {
    const result = runScript([]);
    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/JALE_TEST_DATABASE_URL/);
    // Nothing that looks like a connection URL is ever emitted.
    expect(output(result)).not.toMatch(/:\/\//);
  });

  it('exits non-zero when JALE_TEST_DATABASE_URL is empty', () => {
    const result = runScript([], { JALE_TEST_DATABASE_URL: '' });
    expect(result.status).not.toBe(0);
  });

  it('fails closed when a suite run alone with --suite skips for want of a database', () => {
    // A real jest run of one database suite with no URL: it registers pending
    // tests and jest itself exits 0, so only the results check can fail it.
    const result = runScript(['--suite', 'test/unit/db/billing-job-limit.integration.test.ts']);
    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('test/unit/db/billing-job-limit.integration.test.ts › ');
    expect(output(result)).toContain(': pending');
  }, 120_000);
});
