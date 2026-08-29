/**
 * web-onboarding-door-spike.integration.test.ts
 *
 * Sprint 22 R2-C0 SPIKE. Answers one question against REAL PostgreSQL 16
 * with migrations 001-086 applied:
 *
 *   Can a Lambda connected as `jale_whatsapp` -- the WhatsApp processor's
 *   role -- drive the WhatsApp v2 onboarding engine for a WEB worker (no
 *   Twilio message, no `whatsapp_conversations` row) from
 *   `start_web_onboarding_workflow` through `legal.review`, every
 *   `profile.*` step and `trust.question.1..3` to `completeOnboarding`,
 *   with every DB write succeeding under RLS/grants exactly as 086 leaves
 *   them?
 *
 * WHAT IS REAL AND WHAT IS STUBBED
 *   REAL: the router entry point `routeOnboardingV2` (so the command gate,
 *   `loadWorkerGate`'s `FOR UPDATE OF s`, and the real bound-step dispatch
 *   all run), every `lib/onboarding-repository.ts` function, the production
 *   `createOnboardingV2Adapters` location / trustQuestions / profile
 *   adapters (including the REAL `createTrustQuestionGenerator`, which hits
 *   `trade_questions` as jale_whatsapp), `recordCanonicalWhatsAppConsent`,
 *   and `hashNormalizedPhone`.
 *   STUBBED: only the CHANNEL. `enqueueWorkerMessage` captures into an
 *   array; `enqueuePreAuthPrompt` / `enqueuePreAuthText` /
 *   `adapters.identity` / `voiceIntake.*` all THROW, so a run that falls
 *   through to a WhatsApp-only path fails loudly instead of passing
 *   quietly. `voiceIntake.enabled` is false: a web door has no voice notes.
 *
 * TRANSACTION SHAPE
 *   `webTurn` runs ONE transaction per inbound value, exactly as a web
 *   Lambda would: connect -> BEGIN -> routeOnboardingV2 (which sets
 *   `app.current_internal_user_id` itself via `setInternalUserRlsContext`)
 *   -> COMMIT -> release. `session.state_context` is JSON round-tripped
 *   after every turn, mirroring the processor's per-message write-back --
 *   the web door has NO `whatsapp_conversations` row to persist it into, so
 *   this suite is also the proof that it must carry that bag itself.
 *
 * CONNECTION
 *   Set JALE_TEST_DATABASE_URL to a SUPERUSER connection string for a
 *   disposable PostgreSQL 16 database with 001-086 applied (see
 *   db/local/bootstrap-testbed.sh). Fixture setup and verification reads use
 *   that superuser connection; every ENGINE call goes through a separate
 *   pool authenticated as `jale_whatsapp` (test-whatsapp-pw), and the
 *   extraction fixture in the last group is written as `jale_ai`
 *   (test-ai-pw) -- the only role 086 lets write one.
 *
 * ORDERING CONTRACT -- this suite is NOT order-independent.
 *   The `3-6.` group drives ONE worker across many `test()` blocks, sharing
 *   `mainRun` (run id + session + the `state_context` bag), and later groups
 *   (`9.` especially) assert on the state that drive leaves behind. Jest's
 *   default in-file sequential execution is therefore load-bearing:
 *   `-t`/`--testNamePattern` filtering and `--randomize` are NOT supported
 *   and will fail with confusing mid-run assertions rather than skips. Run
 *   the whole file, `--runInBand`.
 *
 * Set JALE_SPIKE_TRANSCRIPT to a file path to dump the per-step
 * value -> message -> captured-prompt transcript the spike report is built
 * from. Optional; the suite asserts the same facts either way.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';

import {
  routeOnboardingV2,
  type OnboardingV2Deps,
  type OnboardingV2InboundMessage,
  type OnboardingV2Session,
  type RouteResult,
} from '../../../lambda/whatsapp/onboarding-v2';
import {
  createOnboardingV2Adapters,
  type IdentityAdapter,
} from '../../../lambda/whatsapp/lib/onboarding-adapters';
import {
  advanceWorkflow,
  appendTransition,
  clearProfileAnswers,
  completeOnboarding,
  findPreviousStepKey,
  loadWorkerGate,
  reactivateDeclinedLegalRun,
  resetPendingTrustAssessmentAndSkills,
  setRunPreferredLanguage,
  type WorkerGate,
} from '../../../lambda/whatsapp/lib/onboarding-repository';
import { buildPromptForStep } from '../../../lambda/whatsapp/onboarding/prompts';
import { V2_FALLBACK_TRUST_QUESTIONS } from '../../../lambda/whatsapp/lib/interactive-templates';
import { recordCanonicalWhatsAppConsent } from '../../../lambda/whatsapp/lib/legal-consent';
import { hashNormalizedPhone } from '../../../lambda/whatsapp/lib/runtime-controls';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';
import { slugCityKey } from '../../../lambda/lib/city-fields';
import type {
  PreferredLanguage,
  WorkerMessageIntentInput,
  WorkflowStepKey,
} from '../../../lambda/whatsapp/lib/onboarding-types';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: the web onboarding door spike was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[web-onboarding-door-spike] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 superuser URL with migrations 001-086 applied to run ' +
        'the real-PostgreSQL web-onboarding-door spike.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

// ---------------------------------------------------------------------------
// Harness helpers (mirrors media-board-rls / referrals-rls / billing-rls)
// ---------------------------------------------------------------------------

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The engine's workflow version, read out of processor.ts rather than
 * duplicated: `WHATSAPP_V2_WORKFLOW_VERSION` is a module-private const, and a
 * hardcoded copy here would silently drift the day it is bumped.
 */
function engineWorkflowVersion(): number {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'lambda', 'whatsapp', 'processor.ts'),
    'utf8',
  );
  const match = /const WHATSAPP_V2_WORKFLOW_VERSION = (\d+);/.exec(source);
  if (!match) throw new Error('WHATSAPP_V2_WORKFLOW_VERSION not found in processor.ts');
  return Number(match[1]);
}

const THROWS = (what: string) => () => {
  throw new Error(`web door must never reach ${what}`);
};

maybeDescribe('R2-C0 spike: the web onboarding door under jale_whatsapp', () => {
  const su = new Client({ connectionString: databaseUrl });
  let pool: Pool;
  let deps: OnboardingV2Deps;
  let workflowVersion: number;

  /** Every prompt/reply the engine handed the (stubbed) channel this turn. */
  let captured: WorkerMessageIntentInput[] = [];

  /** Mutable, injected clock — never the wall clock (Rule: no fake timers). */
  const clockRef = { now: new Date('2026-08-28T15:00:00.000Z') };

  /** Report material: one entry per driven turn. */
  const transcript: Array<{
    step: string;
    msg: { body?: string; interactivePayload?: string };
    landedOn: string;
    lockVersion: number | null;
    sent: Array<{ sourceType: string; payload: unknown }>;
    stateContextKeys: string[];
  }> = [];

  // Fixture identities.
  const ids: Record<string, string> = {};
  const subs: Record<string, string> = {};
  const phones: Record<string, string> = {};

  const WORKER_KEYS = ['main', 'zip', 'city', 'custom', 'lock', 'photo', 'referral'] as const;

  /** Referral fixture (group 12) — an employer and one job to hang a
   * pending claim off; `referral_pending_claims.job_id` is NOT NULL. */
  let employerId = '';
  let referralJobId = '';

  /**
   * The three carpenter questions AS STORED, read out of `trade_questions`
   * in beforeAll. Every trust-question expectation compares against THIS,
   * never against a literal duplicated from 086 -- a duplicated literal
   * would keep passing after someone reworded the migration.
   */
  let carpenterQuestions: Array<{ q_en: string; q_es: string }> = [];

  // ── deps assembly ──────────────────────────────────────────────────────

  function buildDeps(): OnboardingV2Deps {
    const clock = { now: () => clockRef.now };
    const production = createOnboardingV2Adapters({
      clock,
      // Never invoked: `adapters.identity` is replaced below and both the
      // Cognito client and reconcileUserRow belong to the OTP lane only.
      reconcileUserRow: THROWS('reconcileUserRow (OTP lane)') as never,
      cognitoClient: { send: THROWS('Cognito (OTP lane)') },
      userPoolId: 'spike-unused',
      clientId: 'spike-unused',
    });

    const throwingIdentity: IdentityAdapter = {
      issueChallenge: THROWS('adapters.identity.issueChallenge') as never,
      verifyChallenge: THROWS('adapters.identity.verifyChallenge') as never,
    };

    return {
      adapters: {
        clock,
        identity: throwingIdentity,
        // REAL, unmodified production adapters — the whole point of the spike.
        location: production.location,
        trustQuestions: production.trustQuestions,
        profile: production.profile,
      },
      repo: {
        setInternalUserRlsContext,
        loadPreAuthStateForUpdate: THROWS('repo.loadPreAuthStateForUpdate (pre-auth lane)') as never,
        savePreAuthState: THROWS('repo.savePreAuthState (pre-auth lane)') as never,
        bindVerifiedIdentityAndStartWorkflow:
          THROWS('repo.bindVerifiedIdentityAndStartWorkflow (WhatsApp bind)') as never,
        loadWorkerGate,
        advanceWorkflow: advanceWorkflow as OnboardingV2Deps['repo']['advanceWorkflow'],
        setRunPreferredLanguage,
        reactivateDeclinedLegalRun,
        appendTransition,
        clearProfileAnswers,
        resetPendingTrustAssessmentAndSkills,
        findPreviousStepKey,
        completeOnboarding,
      },
      enqueueWorkerMessage: async (_client, input) => {
        captured.push(input);
        return { intentId: randomUUID(), decision: { decision: 'release' }, outboxMaterialized: true };
      },
      // A web worker has a `users` row from signup, so NOTHING may travel the
      // phone/inbound-keyed pre-auth gateway. Both throw on purpose.
      enqueuePreAuthPrompt: THROWS('enqueuePreAuthPrompt (no Twilio inbound sid exists)') as never,
      enqueuePreAuthText: THROWS('enqueuePreAuthText (no Twilio inbound sid exists)') as never,
      hashNormalizedPhone,
      tosUrl: 'https://jaleapp.ai/legal/terms',
      privacyUrl: 'https://jaleapp.ai/legal/privacy',
      workflowVersion,
      requiredLegalVersion: '1.0',
      recordLegalAcceptance: recordCanonicalWhatsAppConsent,
      voiceIntake: {
        enabled: false,
        startTrustTranscription: THROWS('voiceIntake.startTrustTranscription') as never,
        ingestProfileVoiceNote: THROWS('voiceIntake.ingestProfileVoiceNote') as never,
      },
    };
  }

  // ── the web driver ─────────────────────────────────────────────────────

  function webSession(key: string, language: PreferredLanguage = 'en'): OnboardingV2Session {
    return {
      // No `whatsapp_conversations` row exists; the web door invents a
      // request-scoped id. Only the PRE-AUTH handlers ever read `session.id`.
      id: `web-request:${randomUUID()}`,
      user_id: ids[key],
      // A web worker's only phone value is `users.phone`.
      whatsapp_number: phones[key],
      language,
      conversation_state: 'onboarding',
      state_context: {},
    };
  }

  function webMsg(
    key: string,
    fields: { body?: string; interactivePayload?: string },
  ): OnboardingV2InboundMessage {
    return {
      from: phones[key],
      body: fields.body ?? '',
      // Synthetic, web-origin message id. `worker_workflow_transitions.
      // inbound_message_sid` is plain TEXT, so nothing rejects it.
      messageSid: `web:${randomUUID()}`,
      interactivePayload: fields.interactivePayload,
    };
  }

  /** One inbound value = one transaction, exactly as a web Lambda would run. */
  async function webTurn(
    session: OnboardingV2Session,
    msg: OnboardingV2InboundMessage,
  ): Promise<{ result: RouteResult; sent: WorkerMessageIntentInput[] }> {
    captured = [];
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await routeOnboardingV2(client, session, msg, deps);
      await client.query('COMMIT');
      // The processor persists state_context in the same transaction and
      // reloads it next turn; the web door has no row to persist into, so it
      // must carry the bag. Round-tripping proves nothing here depends on
      // in-memory object identity.
      session.state_context = roundTrip(session.state_context);
      clockRef.now = new Date(clockRef.now.getTime() + 60_000);
      return { result, sent: captured };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs `fn` as jale_whatsapp inside one transaction with the RLS context set. */
  async function asWhatsapp<T>(
    workerId: string | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      if (workerId) await setInternalUserRlsContext(client, workerId);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function runRow(runId: string): Promise<{
    current_step_key: WorkflowStepKey;
    lock_version: number;
    status: string;
    context: Record<string, unknown>;
  }> {
    const r = await su.query(
      `SELECT current_step_key, lock_version, status, context
         FROM worker_workflow_runs WHERE id = $1`,
      [runId],
    );
    return r.rows[0];
  }

  function record(
    label: string,
    msg: OnboardingV2InboundMessage,
    result: RouteResult,
    sent: WorkerMessageIntentInput[],
    lockVersion: number | null,
    session: OnboardingV2Session,
  ): void {
    transcript.push({
      step: label,
      msg: { body: msg.body || undefined, interactivePayload: msg.interactivePayload },
      landedOn: result.stepKey,
      lockVersion,
      sent: sent.map((s) => ({ sourceType: s.sourceType, payload: s.payload })),
      stateContextKeys: Object.keys(session.state_context).sort(),
    });
  }

  /** The `{...prompt, lang}` payload `sendStepPrompt` builds for a step. */
  function expectedPromptPayload(
    stepKey: string,
    lang: PreferredLanguage,
    stateContext: Record<string, unknown>,
  ): Record<string, unknown> {
    const prompt = buildPromptForStep(stepKey, lang, deps, stateContext);
    return {
      templateName: prompt.templateName,
      variables: prompt.variables,
      fallbackBody: prompt.fallbackBody,
      lang,
    };
  }

  // ── fixtures ───────────────────────────────────────────────────────────

  beforeAll(async () => {
    workflowVersion = engineWorkflowVersion();

    await su.connect();

    // JALE_TEST_DATABASE_URL must be a GENUINE superuser: FORCE ROW LEVEL
    // SECURITY applies even to jale_admin as table owner, so fixture setup
    // and the verification reads below need BYPASSRLS, not just ownership.
    // Asserting it here rather than trusting the caller is what stops a
    // mis-pointed URL from turning this suite's negative controls green for
    // the wrong reason.
    const suRole = await su.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(suRole.rows[0].rolsuper).toBe(true);

    // Same shape as media-board-rls.integration.test.ts's guard: never reset
    // the password of the role this connection is itself authenticated as.
    // A superuser URL is never one of these, so in practice both run.
    const suUser = new URL(databaseUrl as string).username;
    if (suUser !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }
    if (suUser !== 'jale_ai') {
      await su.query(`ALTER ROLE jale_ai WITH PASSWORD 'test-ai-pw'`);
    }

    pool = new Pool({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
      max: 4,
    });

    const tag = randomUUID().slice(0, 8);
    for (const key of WORKER_KEYS) {
      subs[key] = `r2c0-${key}-${tag}`;
      phones[key] = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
      const inserted = await su.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, phone, email)
         VALUES ($1, 'worker', $2, $3) RETURNING id`,
        [subs[key], phones[key], `r2c0-${key}-${tag}@example.com`],
      );
      ids[key] = inserted.rows[0].id;
    }

    const employer = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email)
       VALUES ($1, 'employer', $2) RETURNING id`,
      [`r2c0-employer-${tag}`, `r2c0-employer-${tag}@example.com`],
    );
    employerId = employer.rows[0].id;
    const job = await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'R2-C0 referral fixture', 'El Paso, TX', 'full-time', 'active')
       RETURNING id`,
      [employerId],
    );
    referralJobId = job.rows[0].id;

    const tq = await su.query<{ questions: Array<{ q_en: string; q_es: string }> }>(
      `SELECT questions FROM trade_questions
        WHERE profession_key = 'carpenter' AND is_seeded = true`,
    );
    carpenterQuestions = tq.rows[0].questions;
    expect(carpenterQuestions).toHaveLength(3);

    deps = buildDeps();
  }, 60_000);

  afterAll(async () => {
    const out = process.env.JALE_SPIKE_TRANSCRIPT;
    if (out) fs.writeFileSync(out, JSON.stringify(transcript, null, 2));
    await pool?.end();

    // MANDATORY cleanup, not tidiness. This suite is the only DB suite that
    // drives a run all the way to `completeOnboarding`, so it leaves two
    // PENDING `worker_domain_outbox` rows per completed worker. Left behind,
    // they change what `lease_worker_domain_events` returns to a concurrent
    // caller and break
    // `whatsapp-onboarding-concurrency.integration.test.ts` scenarios 4 and 5
    // (two leases each claim a DIFFERENT event instead of contending for the
    // same one). `worker_domain_outbox.aggregate_id` is ON DELETE CASCADE
    // (048), as are the workflow/state/assessment/profile children, so
    // deleting the fixture users clears everything except
    // `legal_consent_log`, whose FK is plain RESTRICT.
    const fixtureIds = [...Object.values(ids), employerId].filter(Boolean);
    if (fixtureIds.length > 0) {
      // Order matters, and not only for FK reasons. `referral_pending_claims.
      // claimed_worker_id` is ON DELETE SET NULL, but the row also carries
      // `referral_pending_claims_claimed_coherent`
      // (`(claimed_at IS NULL) = (claimed_worker_id IS NULL)`) -- so deleting a
      // worker who CLAIMED a referral nulls half the pair and the CHECK
      // rejects the delete outright (a real 23514, seen the first time group 12
      // ran). The claim rows have to go first, explicitly.
      await su.query(
        `DELETE FROM worker_attribution WHERE worker_id = ANY($1::uuid[])`, [fixtureIds],
      );
      await su.query(
        `DELETE FROM referral_pending_claims
          WHERE claimed_worker_id = ANY($1::uuid[]) OR job_id = $2`,
        [fixtureIds, referralJobId || null],
      );
      await su.query(`DELETE FROM legal_consent_log WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      // `jobs.employer_id` cascades, so the fixture job goes with the employer.
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [fixtureIds]);
    }
    await su.end();
  });

  // =========================================================================
  // 1. start_web_onboarding_workflow + loadWorkerGate
  // =========================================================================

  const mainRun: { id: string; session: OnboardingV2Session | null } = { id: '', session: null };

  describe('0. the pool really is jale_whatsapp (control for every negative below)', () => {
    test('not a superuser, no BYPASSRLS, not a member of jale_admin', async () => {
      // Without this, a JALE_TEST_DATABASE_URL that happened to point the
      // "role" pool at a superuser would turn every negative control in this
      // file (null gate, cross-tenant read, RLS-scoped writes) into a false
      // green: a BYPASSRLS role sees everything and a superuser skips grant
      // checks entirely.
      const who = await asWhatsapp(null, async (client) => {
        const r = await client.query<{
          current_user: string; rolsuper: boolean; rolbypassrls: boolean;
        }>(
          `SELECT current_user,
                  r.rolsuper,
                  r.rolbypassrls
             FROM pg_roles r WHERE r.rolname = current_user`,
        );
        const member = await client.query<{ is_member: boolean }>(
          `SELECT pg_has_role(current_user, 'jale_admin', 'USAGE') AS is_member`,
        );
        return { ...r.rows[0], isAdminMember: member.rows[0].is_member };
      });
      expect(who.current_user).toBe('jale_whatsapp');
      expect(who.rolsuper).toBe(false);
      expect(who.rolbypassrls).toBe(false);
      expect(who.isAdminMember).toBe(false);
    });
  });

  describe('1-2. the door opens: start_web_onboarding_workflow, then loadWorkerGate', () => {
    test('resolve_worker_internal_id is the door\'s first call: sub -> internal uuid', async () => {
      // `start_web_onboarding_workflow` returns no user_id, and every RLS
      // policy the engine relies on keys on `app.current_internal_user_id`.
      // So the web door's real entry sequence is: resolve the sub, THEN start.
      const resolved = await asWhatsapp(null, async (client) => {
        const known = await client.query<{ id: string | null }>(
          `SELECT public.resolve_worker_internal_id($1) AS id`, [subs.main],
        );
        const unknown = await client.query<{ id: string | null }>(
          `SELECT public.resolve_worker_internal_id($1) AS id`, [`r2c0-nobody-${randomUUID()}`],
        );
        return { known: known.rows[0].id, unknown: unknown.rows[0].id };
      });
      expect(resolved.known).toBe(ids.main);
      // "no such worker" and "exists but is an employer" are indistinguishable.
      expect(resolved.unknown).toBeNull();
    });

    test('jale_whatsapp starts a run for a web worker named only by Cognito sub', async () => {
      const row = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs.main, 'en', workflowVersion],
        );
        return r.rows[0];
      });

      expect(row.created).toBe(true);
      expect(row.current_step_key).toBe('legal.review');
      expect(row.preferred_language).toBe('en');
      expect(row.workflow_version).toBe(workflowVersion);
      expect(row.lifecycle).toBe('onboarding');
      expect(row.run_id).toEqual(expect.any(String));
      expect(row.onboarding_state_id).toEqual(expect.any(String));

      mainRun.id = row.run_id;

      // The definer restores every GUC it pinned.
      const leaked = await asWhatsapp(null, async (client) => {
        await client.query(`SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`, [
          subs.main, 'en', workflowVersion,
        ]);
        const r = await client.query(
          `SELECT current_setting('app.onboarding_bind_user_id', true) AS bind,
                  current_setting('app.worker_reconcile_sub', true) AS sub`,
        );
        return r.rows[0];
      });
      expect(leaked.bind === '' || leaked.bind === null).toBe(true);
      expect(leaked.sub === '' || leaked.sub === null).toBe(true);
    });

    test('setInternalUserRlsContext + loadWorkerGate return the run to jale_whatsapp', async () => {
      const gate = await asWhatsapp(ids.main, async (client) =>
        loadWorkerGate(client, ids.main),
      );
      expect(gate).not.toBeNull();
      const g = gate as WorkerGate;
      expect(g.userId).toBe(ids.main);
      expect(g.lifecycle).toBe('onboarding');
      expect(g.runId).toBe(mainRun.id);
      expect(g.currentStepKey).toBe('legal.review');
      expect(g.status).toBe('active');
      expect(g.preferredLanguage).toBe('en');
      expect(g.lockVersion).toBe(0);
    });

    test('WITHOUT the RLS context, jale_whatsapp sees no gate at all', async () => {
      const gate = await asWhatsapp(null, async (client) => loadWorkerGate(client, ids.main));
      expect(gate).toBeNull();
    });
  });

  // =========================================================================
  // 3-6. the full drive to lifecycle=ready
  // =========================================================================

  describe('3-6. driving legal -> profile -> trust -> complete, one transaction per value', () => {
    test('legal.review accepts a plain "accept" and lands on profile.name', async () => {
      mainRun.session = webSession('main');
      const session = mainRun.session;
      const msg = webMsg('main', { body: 'accept' });
      const { result, sent } = await webTurn(session, msg);

      expect(result).toEqual({ handled: true, workerId: ids.main, stepKey: 'profile.name' });
      const row = await runRow(mainRun.id);
      expect(row.current_step_key).toBe('profile.name');
      expect(row.lock_version).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toEqual(expectedPromptPayload('profile.name', 'en', session.state_context));
      expect(sent[0].sourceType).toBe('onboarding_v2:profile.name');
      // LITERAL pin. `expectedPromptPayload` calls the same
      // `buildPromptForStep` the code under test calls, so on its own it only
      // proves the router routed -- it can never catch a copy change. The
      // literals below are what a web client would actually have to render.
      expect(sent[0].payload).toMatchObject({
        templateName: '',
        fallbackBody: 'What is your name? Send your full name.',
      });

      // recordCanonicalWhatsAppConsent really wrote, as jale_whatsapp.
      const consent = await su.query(
        `SELECT tos_version, privacy_version FROM users WHERE id = $1`, [ids.main],
      );
      expect(consent.rows[0]).toEqual({ tos_version: '1.0', privacy_version: '1.0' });
      const log = await su.query(
        `SELECT document_type FROM legal_consent_log WHERE user_id = $1 ORDER BY document_type`,
        [ids.main],
      );
      expect(log.rows.map((r) => r.document_type)).toEqual(['privacy', 'tos']);

      record('legal.review', msg, result, sent, row.lock_version, session);
    });

    test('profile.name takes free text', async () => {
      const session = mainRun.session as OnboardingV2Session;
      const msg = webMsg('main', { body: 'Ana Torres' });
      const { result, sent } = await webTurn(session, msg);

      expect(result.stepKey).toBe('profile.location');
      const row = await runRow(mainRun.id);
      expect(row.current_step_key).toBe('profile.location');
      expect(row.lock_version).toBe(2);
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toEqual(expectedPromptPayload('profile.location', 'en', session.state_context));
      expect(sent[0].payload).toMatchObject({
        templateName: '',
        fallbackBody: 'Where do you work? Send your ZIP code or City, ST.',
      });
      record('profile.name', msg, result, sent, row.lock_version, session);
    });

    test('profile.location takes "City, ST" and seeds worker_preferred_cities', async () => {
      const session = mainRun.session as OnboardingV2Session;
      const msg = webMsg('main', { body: 'El Paso, TX' });
      const { result, sent } = await webTurn(session, msg);

      expect(result.stepKey).toBe('profile.trade');
      const row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(3);
      expect(row.context.locationSource).toBe('city_state');
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toEqual(expectedPromptPayload('profile.trade', 'en', session.state_context));
      // `onboarding_trade_en` is a TWILIO content template. A web client has
      // no such thing and must ignore templateName in favour of fallbackBody
      // (or its own renderer) -- pinned so that coupling stays visible.
      expect(sent[0].payload).toMatchObject({
        templateName: 'onboarding_trade_en',
        fallbackBody:
          'What is your main trade?\n1. Electrician\n2. Plumber\n3. Carpenter\n'
          + '4. Concrete\n5. Painting\n6. Other\nReply with the number.',
      });

      const city = await su.query(
        `SELECT city_key, city, state FROM worker_preferred_cities WHERE user_id = $1`, [ids.main],
      );
      expect(city.rows).toEqual([
        { city_key: slugCityKey('El Paso', 'TX'), city: 'El Paso', state: 'TX' },
      ]);
      const profile = await su.query(
        `SELECT location, phone FROM worker_profiles WHERE user_id = $1`, [ids.main],
      );
      expect(profile.rows[0].location).toBe('El Paso, TX');
      // No whatsapp_number: the projection falls back to users.phone.
      expect(profile.rows[0].phone).toBe(phones.main);

      record('profile.location', msg, result, sent, row.lock_version, session);
    });

    test('a SECOND start_web_onboarding_workflow mid-run adopts the live run', async () => {
      const row = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs.main, 'es', workflowVersion + 5],
        );
        return r.rows[0];
      });
      expect(row.created).toBe(false);
      expect(row.run_id).toBe(mainRun.id);
      // The live run's own values win: the second call's language/version are
      // ignored, and the CURRENT step comes back so the web door can resume.
      expect(row.current_step_key).toBe('profile.trade');
      expect(row.preferred_language).toBe('en');
      expect(row.workflow_version).toBe(workflowVersion);
    });

    test('profile.trade takes the V1 interactive payload and seeds REAL trust questions', async () => {
      const session = mainRun.session as OnboardingV2Session;
      const msg = webMsg('main', { interactivePayload: 'profile:main_trade:carpenter' });
      const { result, sent } = await webTurn(session, msg);

      expect(result.stepKey).toBe('profile.experience');
      const row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(4);
      expect(row.context.trade).toBe('carpenter');

      // The REAL createTrustQuestionGenerator hit the 086-reworded
      // `trade_questions` cache row as jale_whatsapp. `seedTrustQuestions`
      // swallows every failure into the fallback set, so this provenance
      // assertion is the ONLY thing that can distinguish a working generator
      // from a silently-denied one.
      expect(row.context.trustQuestionSource).toBe('generated');
      expect(session.state_context.v2TrustSource).toBe('generated');
      expect(session.state_context.v2ProfileTrade).toBe('carpenter');
      expect(session.state_context.v2QuestionSetVersion).toBe('v2-trust-questions-2');
      expect(session.state_context.v2RubricVersion).toBe('v2-trust-rubric-1');
      // Compared against the `trade_questions` row AS STORED, not against a
      // literal copied out of 086 -- a copied literal would keep passing
      // after someone reworded the migration.
      const questions = session.state_context.v2TrustQuestions as Array<{ en: string; es: string }>;
      expect(questions.map((q) => q.en)).toEqual(carpenterQuestions.map((q) => q.q_en));
      expect(questions.map((q) => q.es)).toEqual(carpenterQuestions.map((q) => q.q_es));
      expect(questions[0].en).not.toMatch(/reply with the number/i);

      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toEqual(expectedPromptPayload('profile.experience', 'en', session.state_context));
      expect(sent[0].payload).toMatchObject({ templateName: 'onboarding_experience_en' });

      // FLIPPED by R2-C23, as the C0 comment here asked: the v2* bag is ADDED
      // to this exact key set, never traded for a weaker subset test.
      //
      // C0 found the question SET living ONLY in `state_context` -- which is
      // exactly why a web door that drops the bag between HTTP requests would
      // render the FALLBACK questions on the next step while `saveTrustAnswer`
      // recorded whatever q_en happened to be in scope. R2-C23 fixed that in
      // the ENGINE (`onboarding/durable-context.ts`), so the bag is now
      // mirrored into `worker_workflow_runs.context` after every bound step,
      // for BOTH doors. That is what lets a run started on one channel
      // continue on the other with the same three questions.
      expect(row.context.v2TrustQuestions).toEqual(questions);
      expect(row.context.v2ProfileTrade).toBe('carpenter');
      expect(row.context.v2TrustSource).toBe('generated');
      expect(row.context.v2QuestionSetVersion).toBe('v2-trust-questions-2');
      expect(row.context.v2RubricVersion).toBe('v2-trust-rubric-1');
      // The five step `contextPatch` keys this run has applied so far
      // (legal.ts's `legalAcceptedAt`, profile.ts's `nameSetAt` /
      // `locationSource` / `{ trade, trustQuestionSource }`) PLUS the eight
      // durable v2* keys -- and nothing else. The bag is written full-width
      // with explicit nulls for the keys the session does not hold, which is
      // what makes RESTART's deletions observable through `context || patch`.
      // Nothing channel-scoped is here: no `v2LastPromptAt:*` reprompt
      // cooldown, no voice execution ARN.
      expect(Object.keys(row.context).sort()).toEqual([
        'legalAcceptedAt',
        'locationSource',
        'nameSetAt',
        'trade',
        'trustQuestionSource',
        'v2CustomTradeText',
        'v2LocationPendingConfirm',
        'v2PreferredLanguageOverride',
        'v2ProfileTrade',
        'v2QuestionSetVersion',
        'v2RubricVersion',
        'v2TrustQuestions',
        'v2TrustSource',
      ]);

      record('profile.trade', msg, result, sent, row.lock_version, session);
    });

    test('profile.experience / transportation / availability take profile:<field>:<value>', async () => {
      const session = mainRun.session as OnboardingV2Session;

      const expMsg = webMsg('main', { interactivePayload: 'profile:years_experience:2-4' });
      const exp = await webTurn(session, expMsg);
      expect(exp.result.stepKey).toBe('profile.transportation');
      let row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(5);
      expect(exp.sent).toHaveLength(1);
      expect(exp.sent[0].payload).toEqual(
        expectedPromptPayload('profile.transportation', 'en', session.state_context),
      );
      expect(exp.sent[0].payload).toMatchObject({ templateName: 'onboarding_transportation_en' });
      record('profile.experience', expMsg, exp.result, exp.sent, row.lock_version, session);

      const transMsg = webMsg('main', { interactivePayload: 'profile:has_transportation:true' });
      const trans = await webTurn(session, transMsg);
      expect(trans.result.stepKey).toBe('profile.availability');
      row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(6);
      expect(trans.sent).toHaveLength(1);
      expect(trans.sent[0].payload).toEqual(
        expectedPromptPayload('profile.availability', 'en', session.state_context),
      );
      expect(trans.sent[0].payload).toMatchObject({ templateName: 'onboarding_availability_en' });
      record('profile.transportation', transMsg, trans.result, trans.sent, row.lock_version, session);

      // availability is the LAST profile field, so this turn also runs
      // syncProfileForTrustHandoff (worker_profiles + worker_skills) and
      // hands off to trust.question.1. A fail-closed sync would leave the run
      // parked on profile.availability with handled:true — hence the step-key
      // assertion rather than a truthiness check.
      const availMsg = webMsg('main', { interactivePayload: 'profile:availability:full_time' });
      const avail = await webTurn(session, availMsg);
      expect(avail.result.stepKey).toBe('trust.question.1');
      row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(7);
      expect(avail.sent).toHaveLength(1);
      expect(avail.sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.1', 'en', session.state_context),
      );
      // Pinned against the DB row, closing the tautology: the prompt the
      // worker sees IS `trade_questions.questions->0->>'q_en'`, verbatim.
      expect(avail.sent[0].payload).toEqual({
        templateName: '',
        variables: {},
        fallbackBody: carpenterQuestions[0].q_en,
        lang: 'en',
      });
      record('profile.availability', availMsg, avail.result, avail.sent, row.lock_version, session);

      const skills = await su.query(
        `SELECT skill FROM worker_skills WHERE worker_id = $1`, [ids.main],
      );
      expect(skills.rows.map((r) => r.skill)).toEqual(['carpenter']);
    });

    test('trust.question.1 records a typed answer', async () => {
      const session = mainRun.session as OnboardingV2Session;
      const msg = webMsg('main', {
        body: 'I frame houses and hang interior doors; last job was a full remodel in Socorro.',
      });
      const { result, sent } = await webTurn(session, msg);
      expect(result.stepKey).toBe('trust.question.2');
      const row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(8);
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.2', 'en', session.state_context),
      );
      expect((sent[0].payload as { fallbackBody: string }).fallbackBody)
        .toBe(carpenterQuestions[1].q_en);
      record('trust.question.1', msg, result, sent, row.lock_version, session);
    });

    test('BACK at trust.question.2 rewinds via findPreviousStepKey + advanceWorkflow', async () => {
      const session = mainRun.session as OnboardingV2Session;

      // What the gate itself resolves.
      const prev = await asWhatsapp(ids.main, async (client) =>
        findPreviousStepKey(client, mainRun.id, 'trust.question.2'),
      );
      expect(prev).toBe('trust.question.1');

      const backMsg = webMsg('main', { body: 'BACK' });
      const back = await webTurn(session, backMsg);
      expect(back.result.stepKey).toBe('trust.question.1');
      let row = await runRow(mainRun.id);
      expect(row.current_step_key).toBe('trust.question.1');
      expect(row.lock_version).toBe(9);
      expect(back.sent).toHaveLength(1);
      expect(back.sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.1', 'en', session.state_context),
      );
      expect((back.sent[0].payload as { fallbackBody: string }).fallbackBody)
        .toBe(carpenterQuestions[0].q_en);
      record('gate:BACK', backMsg, back.result, back.sent, row.lock_version, session);

      const redoMsg = webMsg('main', {
        body: 'Correction: I specialize in finish trim and cabinets, plus framing when needed.',
      });
      const redo = await webTurn(session, redoMsg);
      expect(redo.result.stepKey).toBe('trust.question.2');
      row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(10);
      expect(redo.sent).toHaveLength(1);
      record('trust.question.1 (re-answer)', redoMsg, redo.result, redo.sent, row.lock_version, session);

      // Filter-then-append: exactly one entry per question_index, and it is
      // the corrected text.
      const assessment = await su.query<{ answers: Array<Record<string, unknown>> }>(
        `SELECT answers FROM worker_trust_assessments WHERE user_id = $1 AND profession_key = 'carpenter'`,
        [ids.main],
      );
      const answers = assessment.rows[0].answers;
      expect(answers).toHaveLength(1);
      expect(answers.map((a) => a.question_index)).toEqual([0]);
      expect(answers[0].answer_text).toMatch(/^Correction:/);
    });

    test('trust.question.2 and .3 complete onboarding on the third answer', async () => {
      const session = mainRun.session as OnboardingV2Session;

      const q2Msg = webMsg('main', {
        body: 'I walk the whole space first, check the plans against what is actually framed.',
      });
      const q2 = await webTurn(session, q2Msg);
      expect(q2.result.stepKey).toBe('trust.question.3');
      let row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(11);
      expect(q2.sent).toHaveLength(1);
      expect(q2.sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.3', 'en', session.state_context),
      );
      expect((q2.sent[0].payload as { fallbackBody: string }).fallbackBody)
        .toBe(carpenterQuestions[2].q_en);
      record('trust.question.2', q2Msg, q2.result, q2.sent, row.lock_version, session);

      const q3Msg = webMsg('main', {
        body: 'A door jamb came in warped once; I re-ordered it and shimmed the opening square meanwhile.',
      });
      const q3 = await webTurn(session, q3Msg);
      // The third answer completes IN THE SAME CALL — no separate
      // completeOnboarding request, and the router sends NOTHING (the ready
      // confirmation belongs to the worker.ready release lane).
      expect(q3.result).toEqual({ handled: true, workerId: ids.main, stepKey: 'trust.question.3' });
      expect(q3.sent).toHaveLength(0);
      row = await runRow(mainRun.id);
      expect(row.status).toBe('completed');
      expect(row.current_step_key).toBe('trust.question.3');
      expect(row.lock_version).toBe(12);
      record('trust.question.3', q3Msg, q3.result, q3.sent, row.lock_version, session);
    });

    test('end state: lifecycle ready, three text answers, users columns, both domain events', async () => {
      const state = await su.query(
        `SELECT lifecycle, ready_at IS NOT NULL AS has_ready_at
           FROM worker_onboarding_state WHERE user_id = $1`, [ids.main],
      );
      expect(state.rows[0]).toEqual({ lifecycle: 'ready', has_ready_at: true });

      const assessment = await su.query<{
        status: string; profession_key: string; rubric_version: string | null;
        answers: Array<Record<string, unknown>>;
      }>(
        `SELECT status, profession_key, rubric_version, answers
           FROM worker_trust_assessments WHERE user_id = $1`, [ids.main],
      );
      expect(assessment.rows).toHaveLength(1);
      expect(assessment.rows[0].status).toBe('pending');
      expect(assessment.rows[0].profession_key).toBe('carpenter');
      expect(assessment.rows[0].rubric_version).toBe('v2-trust-rubric-1');
      const answers = assessment.rows[0].answers;
      expect(answers).toHaveLength(3);
      expect(answers.map((a) => a.question_index)).toEqual([0, 1, 2]);
      expect(answers.map((a) => a.answer_source)).toEqual(['text', 'text', 'text']);
      // Each stored answer carries the question AS STORED in trade_questions
      // (the trust scorer reads `{ q_en, answer_text }`), compared against the
      // DB row rather than a duplicated literal.
      expect(answers.map((a) => a.q_en)).toEqual(carpenterQuestions.map((q) => q.q_en));
      expect(answers.map((a) => a.q_es)).toEqual(carpenterQuestions.map((q) => q.q_es));

      // The FINAL exact context key set, flipped by R2-C23 the same way as
      // the one at profile.trade: the ten step `contextPatch` keys PLUS the
      // eight durable v2* keys, and still nothing channel-scoped. The bag is
      // re-written on the completing turn too -- `persistDurableStateContext`
      // runs after `completeOnboarding`, which is why a completed run carries
      // the questions it actually asked rather than losing them at the finish
      // line.
      const finalRun = await runRow(mainRun.id);
      expect(Object.keys(finalRun.context).sort()).toEqual([
        'availability',
        'hasTransportation',
        'legalAcceptedAt',
        'locationSource',
        'nameSetAt',
        'trade',
        'trustAnswer1At',
        'trustAnswer2At',
        'trustQuestionSource',
        'v2CustomTradeText',
        'v2LocationPendingConfirm',
        'v2PreferredLanguageOverride',
        'v2ProfileTrade',
        'v2QuestionSetVersion',
        'v2RubricVersion',
        'v2TrustQuestions',
        'v2TrustSource',
        'yearsExperience',
      ]);
      // The questions survive completion verbatim -- this is what the
      // employer-facing panel and the extractor read back.
      expect(finalRun.context.v2TrustQuestions).toEqual(
        carpenterQuestions.map((q) => ({ en: q.q_en, es: q.q_es })),
      );

      const user = await su.query(
        `SELECT full_name, city, main_trade, main_trade_other, years_experience,
                has_transportation, availability
           FROM users WHERE id = $1`, [ids.main],
      );
      expect(user.rows[0]).toEqual({
        full_name: 'Ana Torres',
        city: 'El Paso',
        main_trade: 'carpenter',
        main_trade_other: null,
        years_experience: '2-4',
        has_transportation: true,
        availability: 'full_time',
      });

      const events = await su.query<{ event_type: string; event_key: string }>(
        `SELECT event_type, event_key FROM worker_domain_outbox
          WHERE aggregate_id = $1 ORDER BY event_type`, [ids.main],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(['assessment.requested', 'worker.ready']);
      expect(events.rows.map((r) => r.event_key)).toEqual([
        `assessment.requested:${ids.main}:${mainRun.id}`,
        `worker.ready:${ids.main}:${mainRun.id}`,
      ]);
      const provenance = await su.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM worker_domain_outbox
          WHERE aggregate_id = $1 AND event_type = 'assessment.requested'`, [ids.main],
      );
      expect(provenance.rows[0].payload).toEqual({
        trade: 'carpenter',
        professionKey: 'carpenter',
        source: 'generated',
        questionSetVersion: 'v2-trust-questions-2',
        rubricVersion: 'v2-trust-rubric-1',
      });
    });

    test('a completed run is idle: the entry point hands off instead of routing', async () => {
      const session = mainRun.session as OnboardingV2Session;
      const msg = webMsg('main', { body: 'hello?' });
      const { result, sent } = await webTurn(session, msg);
      expect(result).toEqual({ handled: false, handoff: 'ready', workerId: ids.main, stepKey: 'ready' });
      expect(sent).toHaveLength(0);
    });
  });

  // =========================================================================
  // 7. optimistic-lock conflict
  // =========================================================================

  describe('7. advanceWorkflow with a stale expectedLockVersion', () => {
    test('rejects with workflow_lock_conflict and leaves the transaction usable', async () => {
      const started = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs.lock, 'en', workflowVersion],
        );
        return r.rows[0];
      });
      expect(started.created).toBe(true);

      await asWhatsapp(ids.lock, async (client) => {
        await expect(
          advanceWorkflow(client, {
            runId: started.run_id,
            expectedLockVersion: 99,
            fromStepKey: 'legal.review',
            toStepKey: 'profile.name',
            contextPatch: {},
            inboundMessageSid: `web:${randomUUID()}`,
            reason: 'spike_stale_lock',
          }),
        ).rejects.toThrow('workflow_lock_conflict');

        // A zero-row UPDATE is a SQL SUCCESS, so the transaction is NOT
        // aborted — the web door can catch this, reload the gate and retry
        // without a savepoint.
        const still = await client.query(
          `SELECT current_step_key, lock_version FROM worker_workflow_runs WHERE id = $1`,
          [started.run_id],
        );
        expect(still.rows[0]).toEqual({ current_step_key: 'legal.review', lock_version: 0 });
      });
    });
  });

  // =========================================================================
  // 7b. write-side RLS negatives (the read-side null gate has a twin)
  // =========================================================================

  describe('7b. jale_whatsapp cannot write ANOTHER worker\'s run', () => {
    test('wrong GUC and unset GUC both match zero rows on worker B\'s run', async () => {
      // Group 7 left worker `lock`'s run active at legal.review, lock 0.
      const target = await su.query<{ id: string; lock_version: number }>(
        `SELECT id, lock_version FROM worker_workflow_runs
          WHERE user_id = $1 AND status = 'active'`, [ids.lock],
      );
      const runId = target.rows[0].id;
      expect(target.rows[0].lock_version).toBe(0);

      // (a) GUC pinned to worker A (`zip`), writing worker B's (`lock`) run.
      //     `worker_workflow_runs_worker` scopes USING to the GUC, so the
      //     UPDATE simply sees no row -- indistinguishable from a stale lock,
      //     which is exactly why the read-side null gate matters too.
      await asWhatsapp(ids.zip, async (client) => {
        const raw = await client.query(
          `UPDATE worker_workflow_runs SET current_step_key = 'profile.name',
                  lock_version = lock_version + 1
            WHERE id = $1 AND lock_version = 0`, [runId],
        );
        expect(raw.rowCount).toBe(0);

        await expect(
          advanceWorkflow(client, {
            runId,
            expectedLockVersion: 0,
            fromStepKey: 'legal.review',
            toStepKey: 'profile.name',
            contextPatch: {},
            inboundMessageSid: `web:${randomUUID()}`,
            reason: 'spike_cross_tenant_write',
          }),
        ).rejects.toThrow('workflow_lock_conflict');
      });

      // (b) No GUC at all -- the door forgetting setInternalUserRlsContext.
      await asWhatsapp(null, async (client) => {
        const raw = await client.query(
          `UPDATE worker_workflow_runs SET current_step_key = 'profile.name'
            WHERE id = $1`, [runId],
        );
        expect(raw.rowCount).toBe(0);
      });

      // Untouched by either attempt.
      const after = await su.query<{ current_step_key: string; lock_version: number }>(
        `SELECT current_step_key, lock_version FROM worker_workflow_runs WHERE id = $1`,
        [runId],
      );
      expect(after.rows[0]).toEqual({ current_step_key: 'legal.review', lock_version: 0 });
    });
  });

  // =========================================================================
  // 9. a ready worker: start returns the completed run; extraction read
  // =========================================================================

  describe('9. a lifecycle=ready worker at the door', () => {
    test('start_web_onboarding_workflow returns the COMPLETED run, created=false', async () => {
      const row = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs.main, 'en', workflowVersion],
        );
        return r.rows[0];
      });
      expect(row.created).toBe(false);
      expect(row.run_id).toBe(mainRun.id);
      expect(row.lifecycle).toBe('ready');
      expect(row.current_step_key).toBe('trust.question.3');
    });

    test('the web door reads the extraction row under wte_worker_own_internal', async () => {
      const assessment = await su.query<{ id: string }>(
        `SELECT id FROM worker_trust_assessments WHERE user_id = $1`, [ids.main],
      );
      const assessmentId = assessment.rows[0].id;

      // Only jale_ai may write an extraction (086 Part 1).
      const ai = new Client({
        connectionString: urlForRole(databaseUrl as string, 'jale_ai', 'test-ai-pw'),
      });
      await ai.connect();
      try {
        await ai.query(
          `INSERT INTO worker_trust_extractions
             (assessment_id, user_id, status, extracted, summary_en, extractor_version, model_id)
           VALUES ($1, $2, 'completed', $3::jsonb, $4, 'v086-spike', 'spike-model')`,
          [
            assessmentId, ids.main,
            JSON.stringify({ skills: [{ label_en: 'finish carpentry', label_es: 'carpinteria de acabados', source: [0] }] }),
            'Finish carpenter with framing experience.',
          ],
        );
      } finally {
        await ai.end();
      }

      const read = await asWhatsapp(ids.main, async (client) => {
        const r = await client.query(
          `SELECT id, assessment_id, user_id, status, extracted, summary_en, summary_es,
                  extractor_version, created_at, updated_at
             FROM worker_trust_extractions WHERE user_id = $1`,
          [ids.main],
        );
        return r.rows;
      });
      expect(read).toHaveLength(1);
      expect(read[0].assessment_id).toBe(assessmentId);
      expect(read[0].status).toBe('completed');
      expect(read[0].extracted.skills[0].label_en).toBe('finish carpentry');

      // The reader grant is column-scoped: SELECT * is a hard 42501.
      await expect(
        asWhatsapp(ids.main, async (client) =>
          client.query(`SELECT * FROM worker_trust_extractions WHERE user_id = $1`, [ids.main]),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // ...and another worker's row is invisible even with the grant.
      const foreign = await asWhatsapp(ids.zip, async (client) => {
        const r = await client.query(
          `SELECT id FROM worker_trust_extractions WHERE user_id = $1`, [ids.main],
        );
        return r.rowCount;
      });
      expect(foreign).toBe(0);
    });
  });

  // =========================================================================
  // 10. the other two location dialects (each needs its own run)
  // =========================================================================

  describe('10. profile.location dialects', () => {
    /** Drives a fresh worker to `profile.location` and returns its run id too,
     * so each dialect below can assert the REAL lock ladder rather than
     * recording a placeholder. */
    async function driveToLocation(
      key: string,
    ): Promise<{ session: OnboardingV2Session; runId: string }> {
      const started = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs[key], 'en', workflowVersion],
        );
        return r.rows[0];
      });
      const session = webSession(key);
      const legal = await webTurn(session, webMsg(key, { body: 'accept' }));
      expect(legal.result.stepKey).toBe('profile.name');
      expect(legal.sent).toHaveLength(1);
      expect((await runRow(started.run_id)).lock_version).toBe(1);
      const name = await webTurn(session, webMsg(key, { body: 'Beto Rivera' }));
      expect(name.result.stepKey).toBe('profile.location');
      expect(name.sent).toHaveLength(1);
      expect((await runRow(started.run_id)).lock_version).toBe(2);
      return { session, runId: started.run_id };
    }

    test('a bare ZIP resolves with source=zip and seeds NO preferred city', async () => {
      const { session, runId } = await driveToLocation('zip');
      const msg = webMsg('zip', { body: '79901' });
      const { result, sent } = await webTurn(session, msg);
      expect(result.stepKey).toBe('profile.trade');

      // The ZIP turn DOES enqueue the next step's prompt -- an earlier
      // revision recorded a literal `[]` here and the transcript lied.
      const row = await runRow(runId);
      expect(row.lock_version).toBe(3);
      expect(row.context.locationSource).toBe('zip');
      expect(sent).toHaveLength(1);
      expect(sent[0].sourceType).toBe('onboarding_v2:profile.trade');
      expect(sent[0].payload).toMatchObject({ templateName: 'onboarding_trade_en' });

      const user = await su.query(`SELECT city FROM users WHERE id = $1`, [ids.zip]);
      // NOTE: `saveLocation` writes `location.city ?? locationText`, and a ZIP
      // answer carries no city — so users.city holds the raw ZIP.
      expect(user.rows[0].city).toBe('79901');
      const profile = await su.query(
        `SELECT location FROM worker_profiles WHERE user_id = $1`, [ids.zip],
      );
      expect(profile.rows[0].location).toBe('79901');
      const cities = await su.query(
        `SELECT 1 FROM worker_preferred_cities WHERE user_id = $1`, [ids.zip],
      );
      expect(cities.rowCount).toBe(0);
      record('profile.location (zip)', msg, result, sent, row.lock_version, session);
    });

    test('a bare city asks for confirmation and "1" accepts it', async () => {
      const { session, runId } = await driveToLocation('city');

      const askMsg = webMsg('city', { body: 'El Paso' });
      const ask = await webTurn(session, askMsg);
      expect(ask.result.stepKey).toBe('profile.location');
      expect(session.state_context.v2LocationPendingConfirm).toEqual({ city: 'El Paso', state: 'TX' });
      // The pending confirm is ALSO mirrored into the run's own context, so a
      // web driver that lost state_context could rehydrate this one key.
      const parked = await su.query<{ context: Record<string, unknown> }>(
        `SELECT context FROM worker_workflow_runs WHERE user_id = $1 AND status = 'active'`,
        [ids.city],
      );
      expect(parked.rows[0].context.v2LocationPendingConfirm).toEqual({ city: 'El Paso', state: 'TX' });
      // A same-step advance: the lock ladder moves even though the step key
      // does not.
      const askRow = await runRow(runId);
      expect(askRow.lock_version).toBe(3);
      expect(ask.sent).toHaveLength(1);
      expect(ask.sent[0].sourceType).toBe('onboarding_v2:v2_location_confirm');
      expect(ask.sent[0].payload).toEqual({
        body: 'Did you mean El Paso, TX?\n1. Yes\n2. No\nReply with 1 or 2.',
        lang: 'en',
      });
      record('profile.location (bare city ask)', askMsg, ask.result, ask.sent, askRow.lock_version, session);

      const yesMsg = webMsg('city', { body: '1' });
      const yes = await webTurn(session, yesMsg);
      expect(yes.result.stepKey).toBe('profile.trade');
      expect(session.state_context.v2LocationPendingConfirm).toBeNull();
      const user = await su.query(`SELECT city FROM users WHERE id = $1`, [ids.city]);
      expect(user.rows[0].city).toBe('El Paso');
      const cities = await su.query(
        `SELECT city_key FROM worker_preferred_cities WHERE user_id = $1`, [ids.city],
      );
      expect(cities.rows.map((r) => r.city_key)).toEqual([slugCityKey('El Paso', 'TX')]);
      const yesRow = await runRow(runId);
      expect(yesRow.lock_version).toBe(4);
      expect(yes.sent).toHaveLength(1);
      expect(yes.sent[0].sourceType).toBe('onboarding_v2:profile.trade');
      record('profile.location (bare city confirm)', yesMsg, yes.result, yes.sent, yesRow.lock_version, session);
    });
  });

  // =========================================================================
  // 10b. the custom-trade branch: the trust generator's CACHE-MISS lane
  // =========================================================================

  describe("10b. profile.trade = other -> profile.custom_trade", () => {
    test('a custom trade misses the cache and SILENTLY falls back to the generic set', async () => {
      const started = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs.custom, 'en', workflowVersion],
        );
        return r.rows[0];
      });
      const runId: string = started.run_id;
      const session = webSession('custom');
      for (const [body, expected, lock] of [
        ['accept', 'profile.name', 1],
        ['Carla Nunez', 'profile.location', 2],
        ['Laredo, TX', 'profile.trade', 3],
      ] as Array<[string, string, number]>) {
        const turn = await webTurn(session, webMsg('custom', { body }));
        expect(turn.result.stepKey).toBe(expected);
        expect(turn.sent).toHaveLength(1);
        expect((await runRow(runId)).lock_version).toBe(lock);
      }

      // 'other' must NOT write users.main_trade on its own -- chk_trade_other
      // (004) requires main_trade_other alongside it.
      const otherMsg = webMsg('custom', { interactivePayload: 'profile:main_trade:other' });
      const other = await webTurn(session, otherMsg);
      expect(other.result.stepKey).toBe('profile.custom_trade');
      const afterOther = await su.query(
        `SELECT main_trade, main_trade_other FROM users WHERE id = $1`, [ids.custom],
      );
      expect(afterOther.rows[0]).toEqual({ main_trade: null, main_trade_other: null });
      const otherRow = await runRow(runId);
      expect(otherRow.lock_version).toBe(4);
      expect(otherRow.context.selectedTrade).toBe('other');
      expect(other.sent).toHaveLength(1);
      expect(other.sent[0].sourceType).toBe('onboarding_v2:profile.custom_trade');
      expect(other.sent[0].payload).toMatchObject({
        templateName: '',
        fallbackBody: 'What is your trade? Describe it in a few words.',
      });
      record('profile.trade (other)', otherMsg, other.result, other.sent, otherRow.lock_version, session);

      const customMsg = webMsg('custom', { body: 'welder' });
      const custom = await webTurn(session, customMsg);
      expect(custom.result.stepKey).toBe('profile.experience');
      const customRow = await runRow(runId);
      expect(customRow.lock_version).toBe(5);
      expect(customRow.context.customTrade).toBe('welder');
      expect(customRow.context.trustQuestionSource).toBe('fallback');
      expect(custom.sent).toHaveLength(1);

      // `trade_questions` has no 'welder' row (086 Part 4 purged every
      // non-seeded cache row), so loadOrGenerateQuestions falls through to the
      // question-generator Lambda. With no QUESTION_GENERATOR_ARN it throws,
      // createTrustQuestionGenerator swallows it and returns null, and
      // seedTrustQuestions silently seeds V2_FALLBACK_TRUST_QUESTIONS. The run
      // continues either way -- the ONLY visible difference is provenance.
      expect(session.state_context.v2TrustSource).toBe('fallback');
      expect(session.state_context.v2QuestionSetVersion).toBe('v2-trust-fallback-1');
      expect(session.state_context.v2ProfileTrade).toBe('welder');
      expect(session.state_context.v2CustomTradeText).toBe('welder');
      // Not "does not mention welder" -- it is EXACTLY the reviewed generic
      // set, which is what makes the degradation invisible to a worker.
      const questions = session.state_context.v2TrustQuestions as Array<{ en: string; es: string }>;
      expect(questions).toEqual(V2_FALLBACK_TRUST_QUESTIONS.map((q) => ({ en: q.en, es: q.es })));

      const user = await su.query(
        `SELECT main_trade, main_trade_other FROM users WHERE id = $1`, [ids.custom],
      );
      expect(user.rows[0]).toEqual({ main_trade: 'other', main_trade_other: 'welder' });
      record('profile.custom_trade', customMsg, custom.result, custom.sent, customRow.lock_version, session);
    });
  });

  // =========================================================================
  // 11. photo steps: unreachable AND unskippable
  // =========================================================================

  describe('11. profile.photo / profile.photo_type are a dead end', () => {
    test('no profile answer can route there, and a parked run cannot escape', async () => {
      const started = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs.photo, 'en', workflowVersion],
        );
        return r.rows[0];
      });

      // Nothing in the engine routes here (PROFILE_FIELD_TO_STEP has no photo
      // entry), so the run has to be parked by hand — 050 widened the CHECK.
      await asWhatsapp(ids.photo, async (client) =>
        advanceWorkflow(client, {
          runId: started.run_id,
          expectedLockVersion: 0,
          fromStepKey: 'legal.review',
          toStepKey: 'profile.photo',
          contextPatch: {},
          inboundMessageSid: `web:${randomUUID()}`,
          reason: 'spike_park_photo',
        }),
      );

      const session = webSession('photo');
      for (const msg of [
        webMsg('photo', { body: 'skip' }),
        webMsg('photo', { interactivePayload: 'media:photo:skip' }),
      ]) {
        const { result, sent } = await webTurn(session, msg);
        expect(result.stepKey).toBe('profile.photo');
        // gate-blocked notice + the step's own (also gate-blocked) prompt.
        expect(sent.map((s) => s.sourceType)).toEqual([
          'onboarding_v2:v2_gate_blocked',
          'onboarding_v2:profile.photo',
        ]);
        const row = await runRow(started.run_id);
        expect(row.current_step_key).toBe('profile.photo');
        expect(row.lock_version).toBe(1);
        record('profile.photo (dead end)', msg, result, sent, row.lock_version, session);
        // Second pass must clear the reprompt cooldown.
        clockRef.now = new Date(clockRef.now.getTime() + 3_600_000);
      }
    });
  });

  // =========================================================================
  // 12. the referral park/claim question, actually answered
  // =========================================================================

  describe('12. a claim parked under the web phone hash IS claimed at completion', () => {
    test('completeOnboarding claims it, and the hash is byte-sensitive', async () => {
      // `completeOnboarding` -> `claimPendingReferral` keys on
      // `hashNormalizedPhone(session.whatsapp_number)`, which for a web worker
      // is `users.phone`. Park a claim under exactly that hash and drive a
      // real web run to completion: does the WEB-origin completion pick it up?
      const webHash = hashNormalizedPhone(phones.referral);
      await su.query(
        `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`,
        [webHash, referralJobId],
      );

      const started = await asWhatsapp(null, async (client) => {
        const r = await client.query(
          `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
          [subs.referral, 'en', workflowVersion],
        );
        return r.rows[0];
      });
      const session = webSession('referral');
      const script: Array<Partial<{ body: string; interactivePayload: string }>> = [
        { body: 'accept' },
        { body: 'Dani Solis' },
        { body: 'Laredo, TX' },
        { interactivePayload: 'profile:main_trade:plumber' },
        { interactivePayload: 'profile:years_experience:5-9' },
        { interactivePayload: 'profile:has_transportation:false' },
        { interactivePayload: 'profile:availability:flexible' },
        { body: 'I run supply lines and set fixtures on residential remodels.' },
        { body: 'I find the shutoff and the cleanout before I touch anything else.' },
        { body: 'A compression fitting wept overnight once; I cut it out and sweated a joint.' },
      ];
      let last: RouteResult | null = null;
      for (const fields of script) {
        const turn = await webTurn(session, webMsg('referral', fields));
        last = turn.result;
      }
      expect(last).toEqual({
        handled: true, workerId: ids.referral, stepKey: 'trust.question.3',
      });
      expect((await runRow(started.run_id)).status).toBe('completed');

      // OBSERVED: yes. The web-origin completion claims it, because
      // `users.phone` and `whatsapp_conversations.whatsapp_number` hold the
      // same normalized E.164 string (conversation-router.ts strips the
      // 'whatsapp:' prefix before storing).
      const claim = await su.query<{ claimed_worker_id: string | null }>(
        `SELECT claimed_worker_id FROM referral_pending_claims WHERE phone_hash = $1`,
        [webHash],
      );
      expect(claim.rows[0].claimed_worker_id).toBe(ids.referral);
      const attribution = await su.query<{ first_job_id: string }>(
        `SELECT first_job_id FROM worker_attribution WHERE worker_id = $1`,
        [ids.referral],
      );
      expect(attribution.rowCount).toBe(1);
      expect(attribution.rows[0].first_job_id).toBe(referralJobId);

      // ...but `hashNormalizedPhone` only `.trim()`s, so the match is
      // BYTE-sensitive. Any formatting difference between what the web door
      // passes as `session.whatsapp_number` and what parked the claim loses it
      // silently -- no error, no metric, just an unattributed worker. THIS is
      // the open WS3 contract question: web signup must park/claim on the same
      // byte string the WhatsApp lane uses.
      expect(hashNormalizedPhone(`whatsapp:${phones.referral}`)).not.toBe(webHash);
      expect(hashNormalizedPhone(phones.referral.replace('+', ''))).not.toBe(webHash);
      expect(hashNormalizedPhone(`  ${phones.referral}  `)).toBe(webHash);
    });
  });
});
