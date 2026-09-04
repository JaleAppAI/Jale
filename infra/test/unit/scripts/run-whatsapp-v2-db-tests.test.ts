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
// The migration-052 entry that used to sit here is GONE. Migration 092
// dropped 052's pending-name half (both definers and both users columns), so
// its five staging cases had nothing left to exercise. Its other four cases
// covered objects 092 deliberately KEEPS -- 052's worker_skills DELETE grant
// and policy, saveTrustAnswer's upsert-by-question_index, and
// findPreviousStepKey -- and those moved verbatim into the 092 suite rather
// than being deleted with the file. Deregistering a suite must never be a
// quiet way to lose coverage.
// Reset CLI bind-list gate (2026-07-27): runReset shipped binding the full
// [userId, phone, phoneHash] list to every per-table statement, which real
// Postgres rejects on the first `user_id = $1` predicate. Only a real
// database enforces bind counts, so this suite is the regression gate.
const SUITE_RESET = 'test/unit/db/whatsapp-onboarding-reset.integration.test.ts';
const SUITE_RETRIGGER = 'test/unit/db/retrigger-sweep-definer.integration.test.ts';
// migration 080 (2026-08-20): WhatsApp application-fill DB contract --
// jale_whatsapp DELETE-then-INSERT on worker_documents under RLS, the 073
// application_answers column grant, the 075/078 cert caps (both constraint
// names) under RLS including the RLS-scoped-COUNT footgun, and the
// snapshot-copy savepoint rollback. Migration 091 retired the 022 INSERT
// guard this suite used to exercise through its GUC bypass, so its two GUC
// cases became one absence assertion (the doc-less INSERT now succeeds with
// no GUC, and the GUC is inert).
const SUITE_080 = 'test/unit/db/whatsapp-application-fill-080.integration.test.ts';
// S22 R2-C0 / R2-C23 (2026-08-28): the WEB door onto the v2 onboarding
// engine. The spike proves `jale_whatsapp` can drive the state machine for a
// web-origin worker at all (migration 086's SECURITY DEFINER entry points,
// the run.context durable bag, cross-tenant negatives); the door suite drives
// the four HTTP routes through the real handler against the real role. Both
// exist only because column-scoped grants and RLS are invisible to a mocked
// pool -- a `SELECT *` this role cannot run is a 42501 nothing else catches.
const SUITE_WEB_SPIKE = 'test/unit/db/web-onboarding-door-spike.integration.test.ts';
const SUITE_WEB_DOOR = 'test/unit/db/web-onboarding-door.integration.test.ts';
// Sprint 22 R2-C6: the replacement for the deleted migration-053 suite. The
// web-worker bypass lane is gone, so what needs a real database now is the
// CROSSOVER -- a worker who starts (or finishes) onboarding on the web and
// then messages WhatsApp for the first time, through the real pre-auth ->
// OTP -> bind_verified_identity_and_start_workflow path.
const SUITE_CROSSOVER = 'test/unit/db/web-worker-whatsapp-crossover.integration.test.ts';
// Sprint 22 R2-POLISH: the 086 EMPLOYER side, which had no fail-closed home
// until now. The extraction suite covers worker_trust_extractions' FORCE RLS
// and its four read lanes plus the two SECURITY DEFINER entry points; the
// reads suite executes the two employer applicant queries as their EXPORTED
// query text (not a copy) against the real policies. Both are here for the
// reason the whole list exists: a mocked pool has no planner and no policies,
// so the ambiguous `id` that 500'd every employer documents request -- and any
// 42501 on a column these roles are not granted -- is invisible without one.
const SUITE_EXTRACTIONS_086 = 'test/unit/db/trust-extractions-086.integration.test.ts';
const SUITE_EMPLOYER_READS = 'test/unit/db/employer-worker-reads.integration.test.ts';
// The R2 hostile-input battery: SQL/encoding/boundary/envelope/lock/RLS probes
// driven through the real web-door handler against the real policies.
const SUITE_HOSTILE_INPUTS = 'test/unit/db/web-onboarding-hostile-inputs.integration.test.ts';
// Sprint 23 L2.1: the migration-091 application-stages contract. The hire
// trigger is deliberately NOT security definer -- it reads jobs and
// worker_documents under the CALLER's RLS and fails closed when the job row
// is invisible -- so its entire behavior (including the vault-only doc that
// must NOT satisfy it) exists only where real policies do. Same for the
// column-scoped jale_whatsapp grants: details_requested_at is withheld on
// purpose, and a mocked pool would let that write through.
const SUITE_STAGES_091 = 'test/unit/db/application-stages-091.integration.test.ts';
// Sprint 23 L2.4: the WEB stage-2 details door. Belongs here for the same
// reason as its neighbours -- `jobapp_whatsapp_select` is USING (true), so the
// door's own `worker_id = $2` is the ONLY cross-tenant boundary, and
// `jobapp_whatsapp_update` keys on a GUC whose absence is a zero-row UPDATE
// (a SQL SUCCESS a mocked pool renders as a green 200 over a write that never
// happened). It also drives 091's BEFORE-UPDATE hire gate to a PASS, which
// nothing else in the repo does.
const SUITE_APPLICATION_DETAILS = 'test/unit/db/worker-application-details.integration.test.ts';
// Sprint 23 L2.5: the employer stage notification. It belongs here for the
// same reason as the two above -- the whole feature turns on
// `users_employer_applicant_read` (020b:261-269) seeing the EMPLOYER's users.id
// in app.current_internal_user_id. Under a mocked pool every variant passes;
// against the real policies the wrong GUC silently drops every notification.
// Sprint 23 L3: the WhatsApp lane's two NEW statements -- the `aplicaciones`
// listing and the continue-other offer filter. Both belong here for the same
// reason as their neighbours: `jobapp_whatsapp_select` is USING (true), so
// the listing's own `worker_id = $1` is the ONLY thing keeping one worker out
// of another's applications, and a mocked pool proves nothing about that. The
// listing also resolves the company through `employer_display_name` (031), a
// SECURITY DEFINER path jale_whatsapp can only reach because it holds no
// grant on employer_profiles at all.
const SUITE_APPLICATIONS_COMMAND = 'test/unit/db/whatsapp-applications-command.integration.test.ts';
const SUITE_STAGE_NOTIFY = 'test/unit/db/application-stage-notify.integration.test.ts';
// Sprint 23 L8: the migration-092 cleanup contract. Every assertion in it is
// a catalog or ACL fact, which is exactly the class a mocked pool cannot
// hold: that five dead objects are ABSENT, that the two column-scoped
// REVOKEs took nothing else with them (the failure mode is a bare
// `REVOKE SELECT ON users`, which type-checks fine and breaks every inbound
// WhatsApp turn), and that the web onboarding door and the WhatsApp bind
// path still complete for a web-registered worker without 053's bypass
// definer. It also carries the four surviving cases from the deleted 052
// suite.
const SUITE_CLEANUP_092 = 'test/unit/db/onboarding-cleanup-092.integration.test.ts';
// Sprint 24 L3: the cross-job answer-reuse boundary, after the 2026-09-04
// incident (an employer saw answers the worker gave to another company).
// Here rather than in a mocked suite because worker_application_defaults is
// RLS ENABLE + FORCE (079) and 091's write policy keys on
// app.current_internal_user_id -- a write-back with no GUC is a zero-row
// no-op that reads as success -- and because two of its assertions are
// PostgreSQL facts, not app-level ones: that the jsonb `-` operator REMOVES
// an answer key (a stored null would still read as answered), and that
// `ON CONFLICT DO NOTHING` suppresses the snapshot copy's new
// `RETURNING doc_type` on the idempotent re-call the engine makes every turn.
const SUITE_FIELD_REUSE = 'test/unit/db/application-field-reuse.integration.test.ts';

// Sprint 24 L4: migration 093's defer_worker_intent_outbox -- the third
// outcome for a leased worker_intent row, which reschedules WITHOUT spending
// an attempt. It is here for three facts a mocked pool cannot hold: 043's
// whatsapp_outbox_worker_intent_lease_consistency CHECK (a defer that
// releases one of the two lease columns, or moves to 'pending' with both
// still set, is a 23514 that type-checks fine), the two-condition lease fence
// (token equality AND an un-expired deadline -- dropping either is a
// zero-row-vs-one-row difference), and attempt_count, whose non-advance is
// the entire reason the function exists. It is LAST because 043's lease RPC
// is global by design: leasing advances the attempt_count of any fixture row
// an earlier suite left behind, so it must not run before one.
const SUITE_DEFER_093 = 'test/unit/db/worker-intent-defer-093.integration.test.ts';

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
  it('invokes exactly the migration-042, concurrency, migration-049, profile-constraint, web-door, crossover and 086 employer-read suites in-band', () => {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const suites = script.match(/test\/unit\/db\/[a-zA-Z0-9_.-]+\.integration\.test\.ts/g) ?? [];
    // Order is load-bearing only as a convention: the list reads
    // chronologically by migration/feature, so a new suite is APPENDED rather
    // than slotted alphabetically.
    expect(suites).toEqual([
      SUITE_042, SUITE_CONCURRENCY, SUITE_049, SUITE_PROFILE_CONSTRAINTS,
      SUITE_RESET, SUITE_RETRIGGER, SUITE_080, SUITE_WEB_SPIKE, SUITE_WEB_DOOR, SUITE_CROSSOVER,
      SUITE_EXTRACTIONS_086, SUITE_EMPLOYER_READS, SUITE_HOSTILE_INPUTS,
      SUITE_STAGES_091,
      SUITE_APPLICATION_DETAILS,
      SUITE_APPLICATIONS_COMMAND,
      SUITE_CLEANUP_092,
      SUITE_FIELD_REUSE,
      SUITE_STAGE_NOTIFY,
      SUITE_DEFER_093,
    ]);
    // The deregistered migration-052 suite must be gone from the script
    // entirely -- including from any tombstone comment, which this file's own
    // extraction regex would read back as a live list entry.
    expect(script).not.toContain('whatsapp-onboarding-052');
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
