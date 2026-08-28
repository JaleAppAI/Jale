import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// infra/test/unit/scripts -> infra
const infraRoot = path.join(__dirname, '..', '..', '..');
const scriptPath = path.join(infraRoot, 'scripts', 'run-whatsapp-v2-db-tests.sh');

const SUITE_042 = 'test/unit/db/whatsapp-onboarding-042.integration.test.ts';
const SUITE_CONCURRENCY = 'test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts';
const SUITE_049 = 'test/unit/db/whatsapp-flow-049.integration.test.ts';
// worker_profiles/users CHECK-constraint suite (2026-07-26 saveLocation /
// chk_trade_other incident): real adapters against the real schema, plus the
// full remaining profile-flow SQL as jale_whatsapp.
const SUITE_PROFILE_CONSTRAINTS = 'test/unit/db/worker-profiles-constraints.integration.test.ts';
// migration 052 (2026-07-27 review): worker_skills DELETE reset + the
// trust-answer upsert-by-question_index fix, both against real Postgres.
const SUITE_052 = 'test/unit/db/whatsapp-onboarding-052.integration.test.ts';
// Reset CLI bind-list gate (2026-07-27): runReset shipped binding the full
// [userId, phone, phoneHash] list to every per-table statement, which real
// Postgres rejects on the first `user_id = $1` predicate. Only a real
// database enforces bind counts, so this suite is the regression gate.
const SUITE_RESET = 'test/unit/db/whatsapp-onboarding-reset.integration.test.ts';
const SUITE_RETRIGGER = 'test/unit/db/retrigger-sweep-definer.integration.test.ts';
// migration 080 (2026-08-20): WhatsApp application-fill DB contract --
// jale_whatsapp DELETE-then-INSERT on worker_documents under RLS, the 073
// application_answers column grant, the 022 guard's transaction-local GUC
// bypass, the 075/078 cert caps (both constraint names) under RLS including
// the RLS-scoped-COUNT footgun, and the snapshot-copy savepoint rollback.
const SUITE_080 = 'test/unit/db/whatsapp-application-fill-080.integration.test.ts';
// Sprint 22 R2-C6: the replacement for the deleted migration-053 suite. The
// web-worker bypass lane is gone, so what needs a real database now is the
// CROSSOVER -- a worker who starts (or finishes) onboarding on the web and
// then messages WhatsApp for the first time, through the real pre-auth ->
// OTP -> bind_verified_identity_and_start_workflow path.
const SUITE_CROSSOVER = 'test/unit/db/web-worker-whatsapp-crossover.integration.test.ts';

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
  it('invokes exactly the migration-042, concurrency, migration-049, profile-constraint and crossover suites in-band', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const suites = script.match(/test\/unit\/db\/[a-zA-Z0-9_.-]+\.integration\.test\.ts/g) ?? [];
    expect(suites).toEqual([SUITE_042, SUITE_CONCURRENCY, SUITE_049, SUITE_PROFILE_CONSTRAINTS, SUITE_052, SUITE_RESET, SUITE_RETRIGGER, SUITE_080, SUITE_CROSSOVER]);
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
