import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// infra/test/unit/scripts -> infra
const infraRoot = path.join(__dirname, '..', '..', '..');
const scriptPath = path.join(infraRoot, 'scripts', 'run-whatsapp-v2-db-tests.sh');

const SUITE_042 = 'test/unit/db/whatsapp-onboarding-042.integration.test.ts';
const SUITE_CONCURRENCY = 'test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts';

// The guard must fail closed regardless of the ambient environment. The final
// verification battery exports JALE_TEST_DATABASE_URL to run the guarded
// command against the real testbed, and jest inherits process.env — so the
// missing/empty-URL child processes below scrub the variable explicitly rather
// than relying on it being absent.
function runGuard(overrides: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JALE_TEST_DATABASE_URL;
  Object.assign(env, overrides);
  return spawnSync('bash', [scriptPath], { env, encoding: 'utf8' });
}

describe('test:whatsapp-v2-db fail-closed URL guard', () => {
  it('invokes exactly the migration-042 and concurrency suites in-band', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const suites = script.match(/test\/unit\/db\/[a-zA-Z0-9_.-]+\.integration\.test\.ts/g) ?? [];
    expect(suites).toEqual([SUITE_042, SUITE_CONCURRENCY]);
    expect(script).toContain('--runInBand');
    // No other db integration suite leaks into this focused command.
    expect(script).not.toMatch(
      /whatsapp-delivery-040|whatsapp-support-039|billing-|entitlement-concurrency|apply-order|rls-relationship/,
    );
  });

  it('never dereferences the URL value in an echo/printf (no credential leak)', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    // The variable NAME may appear as literal message text; its VALUE
    // (`$JALE_TEST_DATABASE_URL` / `${JALE_TEST_DATABASE_URL...}`) must never be
    // printed.
    expect(script).not.toMatch(/(echo|printf)[^\n]*\$\{?JALE_TEST_DATABASE_URL/);
  });

  it('exits non-zero with a clear message when JALE_TEST_DATABASE_URL is unset', () => {
    const result = runGuard({});
    expect(result.status).not.toBe(0);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).toMatch(/JALE_TEST_DATABASE_URL/);
    // Nothing that looks like a connection URL is ever emitted.
    expect(output).not.toMatch(/:\/\//);
  });

  it('exits non-zero when JALE_TEST_DATABASE_URL is empty', () => {
    const result = runGuard({ JALE_TEST_DATABASE_URL: '' });
    expect(result.status).not.toBe(0);
  });
});
