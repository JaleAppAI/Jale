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

  const WORKER_KEYS = ['main', 'zip', 'city', 'custom', 'lock', 'photo'] as const;

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
    if (new URL(databaseUrl as string).username !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }
    await su.query(`ALTER ROLE jale_ai WITH PASSWORD 'test-ai-pw'`);

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
    const fixtureIds = Object.values(ids);
    if (fixtureIds.length > 0) {
      await su.query(`DELETE FROM legal_consent_log WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [fixtureIds]);
    }
    await su.end();
  });

  // =========================================================================
  // 1. start_web_onboarding_workflow + loadWorkerGate
  // =========================================================================

  const mainRun: { id: string; session: OnboardingV2Session | null } = { id: '', session: null };

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
      expect(sent[0].payload).toEqual(expectedPromptPayload('profile.location', 'en', session.state_context));
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
      expect(sent[0].payload).toEqual(expectedPromptPayload('profile.trade', 'en', session.state_context));

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
      const questions = session.state_context.v2TrustQuestions as Array<{ en: string; es: string }>;
      expect(questions).toHaveLength(3);
      expect(questions[0].en).toBe(
        'What kind of carpentry do you specialize in, and what did you build on your last job: '
        + 'framing, doors, cabinets, finish trim?',
      );
      expect(questions[0].en).not.toMatch(/reply with the number/i);

      expect(sent[0].payload).toEqual(expectedPromptPayload('profile.experience', 'en', session.state_context));

      // The question SET itself is NOT mirrored into the run's durable
      // context -- only `state_context` holds it. This single fact is what
      // WS3's storage decision hangs on: a web door that drops state_context
      // between requests renders the FALLBACK questions on the next step
      // while `saveTrustAnswer` records whatever q_en is in scope.
      expect(row.context.v2TrustQuestions).toBeUndefined();
      expect(row.context.v2ProfileTrade).toBeUndefined();

      record('profile.trade', msg, result, sent, row.lock_version, session);
    });

    test('profile.experience / transportation / availability take profile:<field>:<value>', async () => {
      const session = mainRun.session as OnboardingV2Session;

      const expMsg = webMsg('main', { interactivePayload: 'profile:years_experience:2-4' });
      const exp = await webTurn(session, expMsg);
      expect(exp.result.stepKey).toBe('profile.transportation');
      let row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(5);
      expect(exp.sent[0].payload).toEqual(
        expectedPromptPayload('profile.transportation', 'en', session.state_context),
      );
      record('profile.experience', expMsg, exp.result, exp.sent, row.lock_version, session);

      const transMsg = webMsg('main', { interactivePayload: 'profile:has_transportation:true' });
      const trans = await webTurn(session, transMsg);
      expect(trans.result.stepKey).toBe('profile.availability');
      row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(6);
      expect(trans.sent[0].payload).toEqual(
        expectedPromptPayload('profile.availability', 'en', session.state_context),
      );
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
      expect(avail.sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.1', 'en', session.state_context),
      );
      expect((avail.sent[0].payload as { fallbackBody: string }).fallbackBody)
        .toBe((session.state_context.v2TrustQuestions as Array<{ en: string }>)[0].en);
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
      expect(sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.2', 'en', session.state_context),
      );
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
      expect(back.sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.1', 'en', session.state_context),
      );
      record('gate:BACK', backMsg, back.result, back.sent, row.lock_version, session);

      const redoMsg = webMsg('main', {
        body: 'Correction: I specialize in finish trim and cabinets, plus framing when needed.',
      });
      const redo = await webTurn(session, redoMsg);
      expect(redo.result.stepKey).toBe('trust.question.2');
      row = await runRow(mainRun.id);
      expect(row.lock_version).toBe(10);
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
      expect(q2.sent[0].payload).toEqual(
        expectedPromptPayload('trust.question.3', 'en', session.state_context),
      );
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
      expect(answers.every((a) => typeof a.q_en === 'string' && (a.q_en as string).length > 0)).toBe(true);
      expect(answers[0].q_en).toBe(
        'What kind of carpentry do you specialize in, and what did you build on your last job: '
        + 'framing, doors, cabinets, finish trim?',
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

    test('completion parked no referral claim: the web phone hash simply matched nothing', async () => {
      // `completeOnboarding` hashes `session.whatsapp_number` unconditionally.
      // For a web worker that value is `users.phone`; with no parked claim the
      // call is a silent no-op and lifecycle completion is unaffected.
      const attribution = await su.query(
        `SELECT 1 FROM worker_attribution WHERE worker_id = $1`, [ids.main],
      );
      expect(attribution.rowCount).toBe(0);
      expect(hashNormalizedPhone(phones.main)).toMatch(/^[0-9a-f]{64}$/);
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
  // 8/9. a ready worker: start returns the completed run; extraction read
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
    async function driveToLocation(key: string): Promise<OnboardingV2Session> {
      await asWhatsapp(null, async (client) =>
        client.query(`SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`, [
          subs[key], 'en', workflowVersion,
        ]),
      );
      const session = webSession(key);
      const legal = await webTurn(session, webMsg(key, { body: 'accept' }));
      expect(legal.result.stepKey).toBe('profile.name');
      const name = await webTurn(session, webMsg(key, { body: 'Beto Rivera' }));
      expect(name.result.stepKey).toBe('profile.location');
      return session;
    }

    test('a bare ZIP resolves with source=zip and seeds NO preferred city', async () => {
      const session = await driveToLocation('zip');
      const msg = webMsg('zip', { body: '79901' });
      const { result } = await webTurn(session, msg);
      expect(result.stepKey).toBe('profile.trade');

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
      record('profile.location (zip)', msg, result, [], null, session);
    });

    test('a bare city asks for confirmation and "1" accepts it', async () => {
      const session = await driveToLocation('city');

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
      expect(ask.sent[0].sourceType).toBe('onboarding_v2:v2_location_confirm');
      record('profile.location (bare city ask)', askMsg, ask.result, ask.sent, null, session);

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
      record('profile.location (bare city confirm)', yesMsg, yes.result, yes.sent, null, session);
    });
  });

  // =========================================================================
  // 10b. the custom-trade branch: the trust generator's CACHE-MISS lane
  // =========================================================================

  describe("10b. profile.trade = other -> profile.custom_trade", () => {
    test('a custom trade misses the cache and SILENTLY falls back to the generic set', async () => {
      await asWhatsapp(null, async (client) =>
        client.query(`SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`, [
          subs.custom, 'en', workflowVersion,
        ]),
      );
      const session = webSession('custom');
      expect((await webTurn(session, webMsg('custom', { body: 'accept' }))).result.stepKey)
        .toBe('profile.name');
      expect((await webTurn(session, webMsg('custom', { body: 'Carla Nunez' }))).result.stepKey)
        .toBe('profile.location');
      expect((await webTurn(session, webMsg('custom', { body: 'Laredo, TX' }))).result.stepKey)
        .toBe('profile.trade');

      // 'other' must NOT write users.main_trade on its own -- chk_trade_other
      // (004) requires main_trade_other alongside it.
      const otherMsg = webMsg('custom', { interactivePayload: 'profile:main_trade:other' });
      const other = await webTurn(session, otherMsg);
      expect(other.result.stepKey).toBe('profile.custom_trade');
      const afterOther = await su.query(
        `SELECT main_trade, main_trade_other FROM users WHERE id = $1`, [ids.custom],
      );
      expect(afterOther.rows[0]).toEqual({ main_trade: null, main_trade_other: null });
      record('profile.trade (other)', otherMsg, other.result, other.sent, null, session);

      const customMsg = webMsg('custom', { body: 'welder' });
      const custom = await webTurn(session, customMsg);
      expect(custom.result.stepKey).toBe('profile.experience');

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
      const questions = session.state_context.v2TrustQuestions as Array<{ en: string }>;
      expect(questions).toHaveLength(3);
      expect(questions[0].en).not.toMatch(/welder/i);

      const user = await su.query(
        `SELECT main_trade, main_trade_other FROM users WHERE id = $1`, [ids.custom],
      );
      expect(user.rows[0]).toEqual({ main_trade: 'other', main_trade_other: 'welder' });
      record('profile.custom_trade', customMsg, custom.result, custom.sent, null, session);
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
});
