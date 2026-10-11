/**
 * web-worker-whatsapp-crossover.integration.test.ts
 *
 * The web/WhatsApp crossover gate against REAL PostgreSQL 16 with every
 * migration on disk applied. Group C REQUIRES 087: on a database stopped at
 * 086 it fails with two runs and lifecycle='onboarding', which is the exact
 * regression 087 removes.
 *
 * WHY THIS SUITE EXISTS
 *   Migration 053 added `bypass_onboarding_for_web_worker`, and
 *   `processor.ts` used it to shunt a worker who had signed up on the WEB
 *   (flat email/password form) straight to `lifecycle='ready'` on their
 *   first WhatsApp message — the v2 engine never ran for them. R2 deletes
 *   that lane: web signup now DRIVES the same engine through
 *   `start_web_onboarding_workflow` (086), so a web worker's phone already
 *   has a real `worker_workflow_runs` row and the ordinary pre-auth ->
 *   OTP -> `bind_verified_identity_and_start_workflow` (047) path must
 *   RESUME it rather than start a second one.
 *
 *   This suite is the proof of that replacement path, in both directions:
 *     A. `reconcile_worker_signup` (027) + `resolve_worker_internal_id`
 *        (086) — the phone-only web signup door still produces a `users`
 *        row the engine can resolve (C4-backend).
 *     B. mid-onboarding on the web -> first WhatsApp message: the bind
 *        ADOPTS the live run, no `worker_workflow_one_active` violation,
 *        no second run, and the next message routes at the run's own step.
 *     C. finished on the web (`lifecycle='ready'`) -> first WhatsApp
 *        message: migration 087's two changes — the completed run is
 *        adopted, `lifecycle='ready'` survives, no `otp_verified`
 *        transition is appended, and the `ready`-with-no-run anomaly is
 *        refused with 55000 instead of restarted.
 *     D. the referral park/claim hash agreement across the two doors.
 *
 * WHAT IS REAL AND WHAT IS STUBBED
 *   Same contract as `web-onboarding-door-spike.integration.test.ts`
 *   (R2-C0), which this suite deliberately mirrors: the router entry point
 *   `routeOnboardingV2`, every `lib/onboarding-repository.ts` function
 *   (including the pre-auth trio `loadPreAuthStateForUpdate` /
 *   `savePreAuthState` / `bindVerifiedIdentityAndStartWorkflow`), and the
 *   production location / trustQuestions / profile adapters all run for
 *   real against Postgres. Only the CHANNEL and COGNITO are stubbed:
 *   `enqueueWorkerMessage` / `enqueuePreAuthPrompt` / `enqueuePreAuthText`
 *   capture into arrays, and the `identity` adapter is a scripted fake
 *   standing in for `RespondToAuthChallenge` + `reconcileUserRow`.
 *
 *   That stub is faithful for the case under test: `worker-web-signup.ts`
 *   creates the Cognito account with `Username: <phone>` in the SAME
 *   `WORKER_POOL_ID` the WhatsApp identity adapter authenticates against
 *   (`lib/onboarding-adapters.ts:755`), so the OTP resolves to the same
 *   `sub`, and `reconcileUserRow`'s "Case B/C: real-sub row exists" branch
 *   returns the EXISTING web worker's internal id — never a placeholder.
 *   The fake returns exactly that id, and makes that branch's one write:
 *   it links the row's `users.whatsapp_number` (read as "linked" since sprint 27).
 *
 * CONNECTION
 *   Set JALE_TEST_DATABASE_URL to a SUPERUSER connection string for a
 *   disposable PostgreSQL 16 database with every migration on disk applied
 *   (see db/local/bootstrap-testbed.sh). Fixtures and verification reads use the
 *   superuser connection; every ENGINE call goes through a separate pool
 *   authenticated as `jale_whatsapp` (test-whatsapp-pw).
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
  bindVerifiedIdentityAndStartWorkflow,
  clearProfileAnswers,
  completeOnboarding,
  findPreviousStepKey,
  loadPreAuthStateForUpdate,
  loadWorkerGate,
  reactivateDeclinedLegalRun,
  resetPendingTrustAssessmentAndSkills,
  savePreAuthState,
  setRunPreferredLanguage,
  type WorkerGate,
} from '../../../lambda/whatsapp/lib/onboarding-repository';
import { recordCanonicalWhatsAppConsent } from '../../../lambda/whatsapp/lib/legal-consent';
import { hashNormalizedPhone } from '../../../lambda/whatsapp/lib/runtime-controls';
import { formatApplyToken, hashToken } from '../../../lambda/lib/referral-codes';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';
import { recordReferredJob } from '../../../lambda/lib/referred-jobs';
import {
  claimPendingReferral,
  findUnclaimedParkedJobId,
  isOpenUnappliedJob,
  loadActiveJobLabel,
  parkPendingClaim,
} from '../../../lambda/whatsapp/lib/referral-claims';
import { isWithinSessionWindow } from '../../../lambda/whatsapp/lib/session-window';
import { releaseWorkerReady } from '../../../lambda/whatsapp/worker-ready-release';
import { createReleaseRenderer } from '../../../lambda/whatsapp/lib/onboarding-renderers';
import { t } from '../../../lambda/whatsapp/lib/templates';
// The processor's two sprint 27 steps, exported narrowly so this suite can
// run them as the real jale_whatsapp role (the processor itself needs Twilio).
import { queueReferredJobCard, recordTypedCodeReferredJob } from '../../../lambda/whatsapp/processor';
import type { ConversationRow } from '../../../lambda/whatsapp/lib/conversation-router';
import type {
  PreferredLanguage,
  WorkerMessageIntentInput,
  WorkflowStepKey,
} from '../../../lambda/whatsapp/lib/onboarding-types';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: the web/WhatsApp crossover gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[web-worker-whatsapp-crossover] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 superuser URL with migrations 001-086 applied to run the ' +
        'real-PostgreSQL web/WhatsApp crossover gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

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
 * duplicated: `WHATSAPP_V2_WORKFLOW_VERSION` is a module-private const and a
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
  throw new Error(`this door must never reach ${what}`);
};

maybeDescribe('R2-C6/087: a web-started worker continues on WhatsApp', () => {
  const su = new Client({ connectionString: databaseUrl });
  let pool: Pool;
  let deps: OnboardingV2Deps;
  let workflowVersion: number;

  /** Bound-step sends (`enqueueWorkerMessage`) captured this turn. */
  let captured: WorkerMessageIntentInput[] = [];
  /** Pre-auth sends (`enqueuePreAuthPrompt` / `enqueuePreAuthText`) this turn. */
  let capturedPreAuth: Array<{ kind: 'prompt' | 'text'; to: string; payload: unknown }> = [];

  /** Mutable, injected clock — never the wall clock (Rule: no fake timers). */
  const clockRef = { now: new Date('2026-08-28T15:00:00.000Z') };

  /**
   * What the scripted identity adapter resolves the next verified OTP to.
   * `null` makes verifyChallenge throw, so an unexpected OTP lane is loud.
   */
  const identityScript: { verifiedWorkerId: string | null; session: string } = {
    verifiedWorkerId: null,
    session: 'cognito-session-unset',
  };

  const ids: Record<string, string> = {};
  const subs: Record<string, string> = {};
  const phones: Record<string, string> = {};
  const convIds: Record<string, string> = {};

  /** Worker fixtures. `signup` exercises group A only; `tokenwa`, `bound`
   * and `typed` belong to the sprint 27 groups F-K. */
  const WORKER_KEYS = [
    'signup', 'resume', 'ready', 'referral', 'readyref', 'orphan', 'tokenwa', 'bound', 'typed',
    // Group L: two job links before sign-in.
    'twootp', 'twostart',
  ] as const;

  let employerId = '';
  let shareCode = '';
  let applyTokenRaw = '';
  let jobId = '';
  // Sprint 27 fixtures (groups F-K).
  let roofJobId = '';
  let closedJobId = '';
  let employerShareCode = '';
  let employerTokenRaw = '';
  let boundTokenRaw = '';
  /** Group L: two tokens per worker. Each first token is for `jobId` through
   * the worker's share link, each second one for `roofJobId` through the
   * employer's, so the credit tells the two codes apart. */
  const twoLinkTokens = {
    otpFirst: 'NPQRSTVA',
    otpSecond: 'PQRSTVWB',
    startFirst: 'QRSTVWXC',
    startSecond: 'RSTVWXYD',
  } as const;
  /** whatsapp_processed_messages rows this suite inserts, deleted in afterAll. */
  const inboundSids: string[] = [];

  // ── deps assembly ──────────────────────────────────────────────────────

  function buildDeps(): OnboardingV2Deps {
    const clock = { now: () => clockRef.now };
    const production = createOnboardingV2Adapters({
      clock,
      // Never invoked: `identity` is replaced below, and both the Cognito
      // client and reconcileUserRow belong exclusively to that adapter.
      reconcileUserRow: THROWS('reconcileUserRow (replaced by the scripted identity adapter)') as never,
      cognitoClient: { send: THROWS('Cognito (replaced by the scripted identity adapter)') },
      userPoolId: 'crossover-unused',
      clientId: 'crossover-unused',
    });

    // Stands in for Cognito's CUSTOM_AUTH round trip plus `reconcileUserRow`.
    // See the header: the real pair resolves a web worker's FIRST WhatsApp
    // OTP to their EXISTING users.id, which is what this returns.
    const scriptedIdentity: IdentityAdapter = {
      async issueChallenge() {
        return {
          status: 'sent',
          challengeId: identityScript.session,
          // The ONE value here that must come off the wall clock, not the
          // injected one: `save_worker_pre_auth` stores it and 047's
          // challenge lookup compares it against `pg_catalog.now()`. Derived
          // from the frozen clock it silently becomes "expired" the moment
          // real time passes the fixture's start instant, and the bind fails
          // with `no bindable identity challenge` — a wall-clock-dependent
          // green. Every other time value in this suite stays on `clockRef`.
          expiresAt: new Date(Date.now() + 10 * 60_000),
        };
      },
      async verifyChallenge(client, { whatsappNumber }) {
        if (!identityScript.verifiedWorkerId) {
          throw new Error('identity adapter reached with no scripted verified worker');
        }
        // reconcileUserRow's Case B/C write (processor.ts), in the same
        // transaction and as the same role: the existing worker row is LINKED
        // to the number the code was verified from. The release reads
        // users.whatsapp_number as "linked", so the stand-in performs it too.
        await client.query(
          `UPDATE users
              SET whatsapp_number = $1,
                  whatsapp_linked_at = now()
            WHERE id = $2 AND user_type = 'worker'`,
          [whatsappNumber, identityScript.verifiedWorkerId],
        );
        return { status: 'verified', workerId: identityScript.verifiedWorkerId };
      },
    };

    return {
      adapters: {
        clock,
        identity: scriptedIdentity,
        location: production.location,
        trustQuestions: production.trustQuestions,
        profile: production.profile,
      },
      repo: {
        setInternalUserRlsContext,
        // REAL pre-auth trio — the whole point of the crossover proof.
        loadPreAuthStateForUpdate,
        savePreAuthState,
        bindVerifiedIdentityAndStartWorkflow,
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
      enqueuePreAuthPrompt: async (_client, _sid, to, payload) => {
        capturedPreAuth.push({ kind: 'prompt', to, payload });
      },
      enqueuePreAuthText: async (_client, _sid, to, payload) => {
        capturedPreAuth.push({ kind: 'text', to, payload });
      },
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

  // ── the two doors ──────────────────────────────────────────────────────

  /** A web request: no `whatsapp_conversations` row exists. */
  function webSession(key: string, language: PreferredLanguage = 'en'): OnboardingV2Session {
    return {
      id: `web-request:${randomUUID()}`,
      user_id: ids[key],
      whatsapp_number: phones[key],
      language,
      conversation_state: 'onboarding',
      state_context: {},
    };
  }

  /** A WhatsApp turn: a REAL `whatsapp_conversations` row, initially unbound. */
  function waSession(key: string, language: PreferredLanguage = 'es'): OnboardingV2Session {
    return {
      id: convIds[key],
      user_id: null,
      whatsapp_number: phones[key],
      language,
      conversation_state: 'new',
      state_context: {},
    };
  }

  function msgFor(
    key: string,
    fields: { body?: string; interactivePayload?: string },
    prefix = 'web',
  ): OnboardingV2InboundMessage {
    return {
      from: phones[key],
      body: fields.body ?? '',
      messageSid: `${prefix}:${randomUUID()}`,
      interactivePayload: fields.interactivePayload,
    };
  }

  /**
   * One inbound value = one transaction, exactly as either Lambda runs it.
   * `after` runs inside that same transaction once the router has returned
   * -- where the processor's own post-routing steps run.
   */
  async function turn(
    session: OnboardingV2Session,
    msg: OnboardingV2InboundMessage,
    after?: (client: PoolClient, result: RouteResult) => Promise<void>,
  ): Promise<{
    result: RouteResult;
    sent: WorkerMessageIntentInput[];
    preAuth: Array<{ kind: 'prompt' | 'text'; to: string; payload: unknown }>;
  }> {
    captured = [];
    capturedPreAuth = [];
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await routeOnboardingV2(client, session, msg, deps);
      if (after) await after(client, result);
      await client.query('COMMIT');
      session.state_context = roundTrip(session.state_context);
      clockRef.now = new Date(clockRef.now.getTime() + 60_000);
      return { result, sent: captured, preAuth: capturedPreAuth };
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

  async function startWebRun(key: string, language: PreferredLanguage = 'en'): Promise<{
    run_id: string;
    created: boolean;
    current_step_key: WorkflowStepKey;
    lifecycle: string;
  }> {
    return asWhatsapp(null, async (client) => {
      const r = await client.query(
        `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
        [subs[key], language, workflowVersion],
      );
      return r.rows[0];
    });
  }

  async function runsFor(workerId: string): Promise<Array<{
    id: string;
    current_step_key: string;
    status: string;
    lock_version: number;
  }>> {
    const r = await su.query(
      `SELECT id, current_step_key, status, lock_version
         FROM worker_workflow_runs WHERE user_id = $1 ORDER BY created_at, id`,
      [workerId],
    );
    return r.rows;
  }

  async function lifecycleOf(workerId: string): Promise<{ lifecycle: string; has_ready_at: boolean }> {
    const r = await su.query(
      `SELECT lifecycle, ready_at IS NOT NULL AS has_ready_at
         FROM worker_onboarding_state WHERE user_id = $1`,
      [workerId],
    );
    return r.rows[0];
  }

  /**
   * The WhatsApp door's first three turns for a phone with no bound
   * conversation: greeting -> language choice (issues the OTP) -> the code
   * itself (binds). Returns the bind turn's result.
   */
  async function whatsappOtpArrival(
    key: string,
    session: OnboardingV2Session,
    // The FIRST inbound body. Defaults to a plain greeting; group E sends a
    // referral code here, which is the only message `handleStartStep` ever
    // parks one from.
    firstBody = 'Hola',
    // Runs inside the code turn's transaction (see `turn`).
    afterCode?: (client: PoolClient, result: RouteResult, msg: OnboardingV2InboundMessage) => Promise<void>,
  ): Promise<{ result: RouteResult; sent: WorkerMessageIntentInput[]; preAuth: Array<{ kind: 'prompt' | 'text'; to: string; payload: unknown }>; firstPreAuth: Array<{ kind: 'prompt' | 'text'; to: string; payload: unknown }> }> {
    identityScript.verifiedWorkerId = ids[key];
    identityScript.session = `cognito-session-${key}-${randomUUID().slice(0, 8)}`;

    const hello = await turn(session, msgFor(key, { body: firstBody }, 'wa'));
    expect(hello.result).toEqual({
      handled: true, workerId: null, stepKey: 'start.choose_language',
    });

    const chose = await turn(session, msgFor(key, { interactivePayload: 'start:lang:en' }, 'wa'));
    expect(chose.result).toEqual({
      handled: true, workerId: null, stepKey: 'identity.verify_otp',
    });

    const code = msgFor(key, { body: '123456' }, 'wa');
    const bound = await turn(session, code, afterCode ? (client, result) => afterCode(client, result, code) : undefined);
    return { ...bound, firstPreAuth: hello.preAuth };
  }

  /**
   * Drives a BOUND WhatsApp worker from legal.review to completion, one
   * transaction per answer, exactly as group C does on the web.
   */
  async function whatsappOnboardToReady(key: string, session: OnboardingV2Session): Promise<void> {
    expect((await turn(session, msgFor(key, { body: 'accept' }, 'wa'))).result.stepKey).toBe('profile.name');
    expect((await turn(session, msgFor(key, { body: 'Rosa Medina' }, 'wa'))).result.stepKey).toBe('profile.location');
    expect((await turn(session, msgFor(key, { body: 'El Paso, TX' }, 'wa'))).result.stepKey).toBe('profile.trade');
    expect((await turn(session, msgFor(key, { interactivePayload: 'profile:main_trade:carpenter' }, 'wa'))).result.stepKey).toBe('profile.experience');
    expect((await turn(session, msgFor(key, { interactivePayload: 'profile:years_experience:2-4' }, 'wa'))).result.stepKey).toBe('profile.transportation');
    expect((await turn(session, msgFor(key, { interactivePayload: 'profile:has_transportation:true' }, 'wa'))).result.stepKey).toBe('profile.availability');
    expect((await turn(session, msgFor(key, { interactivePayload: 'profile:availability:full_time' }, 'wa'))).result.stepKey).toBe('trust.question.1');
    await turn(session, msgFor(key, { body: 'Roofing and framing, ten years.' }, 'wa'));
    await turn(session, msgFor(key, { body: 'I check the pitch and the weather first.' }, 'wa'));
    await turn(session, msgFor(key, { body: 'A leak once; I traced it to the flashing.' }, 'wa'));
    expect(await lifecycleOf(ids[key])).toEqual({ lifecycle: 'ready', has_ready_at: true });
  }

  /** The worker's referred-jobs list, read past RLS. */
  async function referredJobsOf(workerId: string): Promise<Array<{ job_id: string; source: string }>> {
    const r = await su.query<{ job_id: string; source: string }>(
      `SELECT job_id, source FROM worker_referred_jobs WHERE worker_id = $1 ORDER BY last_seen_at DESC, job_id`,
      [workerId],
    );
    return r.rows;
  }

  /** An inbound message the worker sent, as the processor's claim logs it. */
  async function logInbound(phone: string, sid = `r2c6-inbound-${randomUUID()}`): Promise<string> {
    inboundSids.push(sid);
    await su.query(
      `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status) VALUES ($1, $2, 'completed')`,
      [sid, phone],
    );
    return sid;
  }

  /**
   * Releases the worker.ready event `completeOnboarding` left PENDING, as
   * the drain does: lease it (here, the lease function's end state set
   * directly -- this suite runs no competing drain), then `releaseWorkerReady`
   * as jale_whatsapp with the worker's internal setting.
   */
  async function releaseReady(workerId: string): Promise<{ released: number; expired: number; superseded: number; failed: number }> {
    const event = await su.query<{ event_key: string }>(
      `SELECT event_key FROM worker_domain_outbox
        WHERE aggregate_id = $1 AND event_type = 'worker.ready' AND status = 'pending'`,
      [workerId],
    );
    expect(event.rows).toHaveLength(1);
    await su.query(
      `UPDATE worker_domain_outbox
          SET status = 'processing', leased_until = now() + interval '5 minutes', lease_token = gen_random_uuid()
        WHERE event_key = $1`,
      [event.rows[0].event_key],
    );
    return asWhatsapp(workerId, (client) => releaseWorkerReady(client, event.rows[0].event_key, {
      renderer: createReleaseRenderer(),
      now: () => clockRef.now,
    }));
  }

  /** The release's intents and outbox rows for one worker, read past RLS. */
  async function releaseStateOf(workerId: string): Promise<{
    intents: Array<{ source_type: string; source_id: string; status: string; decision_reason: string | null }>;
    outbox: Array<{ body: string | null; content_template: string | null; content_variables: Record<string, string> | null }>;
  }> {
    const intents = await su.query(
      `SELECT source_type, source_id, status, decision_reason
         FROM worker_message_intents
        WHERE user_id = $1 AND category = 'onboarding'
        ORDER BY priority, source_id`,
      [workerId],
    );
    const outbox = await su.query(
      `SELECT o.body, o.content_template, o.content_variables
         FROM whatsapp_outbox o
         JOIN worker_message_intents i ON i.outbox_id = o.id
        WHERE i.user_id = $1
        ORDER BY i.release_sequence`,
      [workerId],
    );
    return { intents: intents.rows, outbox: outbox.rows };
  }

  // ── fixtures ───────────────────────────────────────────────────────────

  beforeAll(async () => {
    workflowVersion = engineWorkflowVersion();

    await su.connect();
    if (new URL(databaseUrl as string).username !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }

    pool = new Pool({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
      max: 4,
    });

    const tag = randomUUID().slice(0, 8);
    for (const key of WORKER_KEYS) {
      subs[key] = `r2c6-${key}-${tag}`;
      phones[key] = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    }

    // Group A creates `signup` through the real signup definer; the other
    // three are created the same way, because that IS the web door now.
    for (const key of WORKER_KEYS) {
      await asWhatsapp(null, async (client) =>
        client.query(`SELECT reconcile_worker_signup($1, $2, $3)`, [subs[key], phones[key], '']),
      );
      const r = await su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub = $1`, [subs[key]]);
      ids[key] = r.rows[0].id;
    }

    // One `whatsapp_conversations` row per crossover worker — what the
    // processor's `getOrCreateConversation` would have inserted on their
    // first inbound message. Deliberately UNBOUND (`user_id IS NULL`).
    for (const key of ['resume', 'ready', 'referral', 'readyref', 'orphan', 'tokenwa', 'bound', 'twootp', 'twostart'] as const) {
      const r = await su.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (whatsapp_number, language, conversation_state)
         VALUES ($1, 'es', 'new') RETURNING id`,
        [phones[key]],
      );
      convIds[key] = r.rows[0].id;
    }

    // Referral fixture (group D): an employer + one job to attribute to.
    const emp = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email)
       VALUES ($1, 'employer', $2) RETURNING id`,
      [`r2c6-emp-${tag}`, `r2c6-emp-${tag}@example.com`],
    );
    employerId = emp.rows[0].id;
    const job = await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, city, state)
       VALUES ($1, 'Finish Carpenter', 'El Paso, TX', 'full-time', 'El Paso', 'TX')
       RETURNING id`,
      [employerId],
    );
    jobId = job.rows[0].id;

    // Group E: a REAL apply token behind a real share link, so the referral
    // arrives the way it actually does -- as a code in the worker's first
    // WhatsApp message -- instead of being hand-seeded as a pending claim.
    shareCode = 'R2C6ABCD';
    await su.query(
      `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
       VALUES ($1, $2, $3, 'facebook')`,
      [shareCode, jobId, ids.referral],
    );
    applyTokenRaw = 'JMNPQRST';
    await su.query(
      `INSERT INTO referral_apply_tokens (token_hash, job_id, share_code, expires_at)
       VALUES ($1, $2, $3, now() + INTERVAL '1 day')`,
      [hashToken(applyTokenRaw), jobId, shareCode],
    );

    // Sprint 27 (groups F-K). A second job, shared by an EMPLOYER link
    // (063): group F's token credits the employer referrer that the parked
    // claim never carried. And a closed job, for the predicate checks.
    const roof = await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, company, location, job_type, city, state)
       VALUES ($1, 'Roofer', 'NB Construction', 'El Paso, TX', 'full-time', 'El Paso', 'TX')
       RETURNING id`,
      [employerId],
    );
    roofJobId = roof.rows[0].id;
    const closed = await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, city, state, status)
       VALUES ($1, 'Painter', 'El Paso, TX', 'full-time', 'El Paso', 'TX', 'closed')
       RETURNING id`,
      [employerId],
    );
    closedJobId = closed.rows[0].id;
    employerShareCode = 'R2C6EMPW';
    await su.query(
      `INSERT INTO job_share_links (code, job_id, referrer_employer_id, channel)
       VALUES ($1, $2, $3, 'whatsapp')`,
      [employerShareCode, roofJobId, employerId],
    );
    employerTokenRaw = 'KMNPQRSV';
    await su.query(
      `INSERT INTO referral_apply_tokens (token_hash, job_id, share_code, expires_at)
       VALUES ($1, $2, $3, now() + INTERVAL '1 day')`,
      [hashToken(employerTokenRaw), roofJobId, employerShareCode],
    );
    boundTokenRaw = 'MNPQRSVW';
    await su.query(
      `INSERT INTO referral_apply_tokens (token_hash, job_id, share_code, expires_at)
       VALUES ($1, $2, NULL, now() + INTERVAL '1 day')`,
      [hashToken(boundTokenRaw), jobId],
    );
    for (const [token, job, code] of [
      [twoLinkTokens.otpFirst, jobId, shareCode],
      [twoLinkTokens.otpSecond, roofJobId, employerShareCode],
      [twoLinkTokens.startFirst, jobId, shareCode],
      [twoLinkTokens.startSecond, roofJobId, employerShareCode],
    ]) {
      await su.query(
        `INSERT INTO referral_apply_tokens (token_hash, job_id, share_code, expires_at)
         VALUES ($1, $2, $3, now() + INTERVAL '1 day')`,
        [hashToken(token), job, code],
      );
    }

    deps = buildDeps();
  }, 90_000);

  afterAll(async () => {
    await pool?.end();

    // MANDATORY cleanup, not tidiness: this suite drives runs all the way to
    // `completeOnboarding`, which leaves PENDING `worker_domain_outbox` rows.
    // Left behind they change what `lease_worker_domain_events` returns and
    // break `whatsapp-onboarding-concurrency.integration.test.ts` scenarios 4
    // and 5 for whoever runs next. `worker_domain_outbox.aggregate_id` is ON
    // DELETE CASCADE (048), as are the workflow/state/assessment/profile
    // children, so deleting the fixture users clears everything except
    // `legal_consent_log` (plain RESTRICT) and the phone-keyed referral rows
    // (no FK to users at all).
    const fixtureIds = Object.values(ids).filter(Boolean);
    const fixturePhoneHashes = Object.values(phones).filter(Boolean).map(hashNormalizedPhone);
    // Sprint 27: the inbound-log rows this suite wrote (their inbound card
    // rows go with them -- whatsapp_outbox.inbound_message_sid is ON DELETE
    // CASCADE) and the release's authorized rows, which name the fixture
    // phones and no fixture id.
    if (inboundSids.length > 0) {
      await su.query(`DELETE FROM whatsapp_processed_messages WHERE message_sid = ANY($1::text[])`, [inboundSids]);
    }
    const fixturePhones = Object.values(phones).filter(Boolean);
    if (fixturePhones.length > 0) {
      await su.query(`DELETE FROM whatsapp_outbox WHERE whatsapp_number = ANY($1::text[])`, [fixturePhones]);
    }
    if (fixturePhoneHashes.length > 0) {
      await su.query(`DELETE FROM referral_pending_claims WHERE phone_hash = ANY($1::text[])`, [
        fixturePhoneHashes,
      ]);
      // `worker_identity_challenges` is keyed by phone hash and its user FKs
      // are ON DELETE SET NULL (047), so a verified challenge SURVIVES the
      // fixture-user delete below. Left behind it is exactly the orphaned
      // row 047's self-heal exists for — harmless, but this suite should not
      // be the thing that manufactures them for the next runner.
      await su.query(`DELETE FROM worker_identity_challenges WHERE phone_hash = ANY($1::text[])`, [
        fixturePhoneHashes,
      ]);
    }
    if (fixtureIds.length > 0) {
      await su.query(`DELETE FROM legal_consent_log WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM whatsapp_conversations WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [fixtureIds]);
    }
    const strayConvIds = Object.values(convIds).filter(Boolean);
    if (strayConvIds.length > 0) {
      await su.query(`DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])`, [strayConvIds]);
    }
    if (employerId) await su.query(`DELETE FROM users WHERE id = $1`, [employerId]);
    await su.end();
  });

  // =========================================================================
  // A. C4-backend: the phone-only web signup door
  // =========================================================================

  describe('A. phone-only web signup: reconcile_worker_signup -> resolve_worker_internal_id', () => {
    test('reconcile_worker_signup creates the users row with cognito_sub + phone and NO name', async () => {
      const row = await su.query<{
        cognito_sub: string; phone: string; user_type: string;
        full_name: string | null; email: string | null;
      }>(
        `SELECT cognito_sub, phone, user_type, full_name, email
           FROM users WHERE cognito_sub = $1`,
        [subs.signup],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].user_type).toBe('worker');
      expect(row.rows[0].phone).toBe(phones.signup);
      // R2 web signup is PHONE ONLY: no fullName is sent, nothing is staged,
      // and no email exists at all. The name is collected inside the flow, at
      // `profile.name`.
      //
      // `pending_full_name` was read here as well until migration 092 DROPPED
      // it along with stage_worker_pending_name / promote_worker_pending_name
      // -- the staging lane this assertion proved was unused no longer exists
      // to be unused, so naming the column here is now a 42703.
      expect(row.rows[0].full_name).toBeNull();
      expect(row.rows[0].email).toBeNull();
    });

    test('resolve_worker_internal_id turns that sub into the internal uuid for jale_whatsapp', async () => {
      const resolved = await asWhatsapp(null, async (client) => {
        const known = await client.query<{ id: string | null }>(
          `SELECT public.resolve_worker_internal_id($1) AS id`, [subs.signup],
        );
        const unknown = await client.query<{ id: string | null }>(
          `SELECT public.resolve_worker_internal_id($1) AS id`, [`r2c6-nobody-${randomUUID()}`],
        );
        return { known: known.rows[0].id, unknown: unknown.rows[0].id };
      });
      expect(resolved.known).toBe(ids.signup);
      expect(resolved.unknown).toBeNull();
    });

    test('and the engine door opens on that row: start_web_onboarding_workflow', async () => {
      const row = await startWebRun('signup');
      expect(row.created).toBe(true);
      expect(row.current_step_key).toBe('legal.review');
      expect(row.lifecycle).toBe('onboarding');
    });
  });

  // =========================================================================
  // B. mid-onboarding on the web, then the first WhatsApp message
  // =========================================================================

  describe('B. a web worker mid-run: the first WhatsApp message ADOPTS the live run', () => {
    const web: { runId: string; session: OnboardingV2Session | null } = { runId: '', session: null };

    test('the web door drives legal.review -> profile.name -> profile.location -> profile.trade', async () => {
      const started = await startWebRun('resume');
      expect(started.created).toBe(true);
      web.runId = started.run_id;

      const session = webSession('resume');
      web.session = session;

      const legal = await turn(session, msgFor('resume', { body: 'accept' }));
      expect(legal.result.stepKey).toBe('profile.name');
      const name = await turn(session, msgFor('resume', { body: 'Ana Torres' }));
      expect(name.result.stepKey).toBe('profile.location');
      const loc = await turn(session, msgFor('resume', { body: 'El Paso, TX' }));
      expect(loc.result.stepKey).toBe('profile.trade');

      const runs = await runsFor(ids.resume);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: web.runId, current_step_key: 'profile.trade', status: 'active', lock_version: 3,
      });
    });

    test('the WhatsApp door has no bound conversation, so it starts at pre-auth', async () => {
      const conv = await su.query<{ user_id: string | null }>(
        `SELECT user_id FROM whatsapp_conversations WHERE id = $1`, [convIds.resume],
      );
      expect(conv.rows[0].user_id).toBeNull();

      // routeOnboardingV2 keys the gate off session.user_id, which the
      // processor takes from `whatsapp_conversations.user_id`. Unbound means
      // no gate is even loaded — the web run is invisible until the bind.
      const gate = await asWhatsapp(ids.resume, async (client) => loadWorkerGate(client, ids.resume));
      expect((gate as WorkerGate).runId).toBe(web.runId);
    });

    test('OTP bind ADOPTS the live web run: same run id, no second run, step preserved', async () => {
      const session = waSession('resume');
      const bind = await whatsappOtpArrival('resume', session);

      // 047's `SELECT ... WHERE user_id = $ AND status = 'active'` found the
      // web-started run, so `v_run` was non-null and NOTHING was inserted.
      const runs = await runsFor(ids.resume);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(web.runId);
      expect(runs[0].status).toBe('active');
      // The bind does not touch the run at all — no step reset to
      // legal.review, no lock bump.
      expect(runs[0].current_step_key).toBe('profile.trade');
      expect(runs[0].lock_version).toBe(3);

      // ...and the worker is answered AT that step, not re-asked to accept
      // the ToS. (Pre-R2 this whole lane was skipped by
      // bypass_onboarding_for_web_worker, which slammed them to `ready`.)
      expect(bind.result).toEqual({
        handled: true, workerId: ids.resume, stepKey: 'profile.trade',
      });
      expect(bind.sent).toHaveLength(1);
      expect(bind.sent[0].sourceType).toBe('onboarding_v2:profile.trade');

      // The conversation is now bound, and lifecycle is untouched.
      const conv = await su.query<{ user_id: string | null }>(
        `SELECT user_id FROM whatsapp_conversations WHERE id = $1`, [convIds.resume],
      );
      expect(conv.rows[0].user_id).toBe(ids.resume);
      expect(await lifecycleOf(ids.resume)).toEqual({ lifecycle: 'onboarding', has_ready_at: false });

      // No spurious `otp_verified` transition was appended for an adopted
      // run — 047 gates that INSERT on `v_created_run`.
      const transitions = await su.query<{ reason: string }>(
        `SELECT reason FROM worker_workflow_transitions WHERE run_id = $1 AND reason = 'otp_verified'`,
        [web.runId],
      );
      expect(transitions.rowCount).toBe(0);
    });

    test('the NEXT WhatsApp message routes at the run\'s own step and advances it', async () => {
      // The processor writes the bind's user_id back onto the conversation
      // row, so the next turn's session carries it.
      const session = waSession('resume');
      session.user_id = ids.resume;
      session.conversation_state = 'onboarding_v2';

      const trade = await turn(session, msgFor('resume', {
        interactivePayload: 'profile:main_trade:carpenter',
      }, 'wa'));
      expect(trade.result.stepKey).toBe('profile.experience');

      const runs = await runsFor(ids.resume);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(web.runId);
      expect(runs[0].lock_version).toBe(4);

      // The work the WEB door already did is still there — this is one
      // continuous run, not a restart.
      const user = await su.query<{ full_name: string | null; city: string | null }>(
        `SELECT full_name, city FROM users WHERE id = $1`, [ids.resume],
      );
      expect(user.rows[0]).toEqual({ full_name: 'Ana Torres', city: 'El Paso' });
    });
  });

  // =========================================================================
  // C. finished on the web, then the first WhatsApp message
  //
  // This is what MIGRATION 087 fixes. Through 047 the bind did two things
  // that are correct for a net-new worker and wrong for a finished one:
  //   1. `INSERT INTO worker_onboarding_state ... ON CONFLICT (user_id)
  //      DO UPDATE SET lifecycle = 'onboarding'` was UNCONDITIONAL, so
  //      `ready` was overwritten (while `ready_at` stayed set);
  //   2. the run lookup filters `status = 'active'`, which a COMPLETED run
  //      is not — so it inserted a brand-new active run at `legal.review`.
  //      (`worker_workflow_one_active` is partial on `status = 'active'`,
  //      so there was no unique violation to stop it.)
  // Net effect: a worker who finished onboarding on the web was thrown back
  // to "accept the terms" on their first WhatsApp message.
  //
  // 087 preserves a terminal lifecycle in the upsert and, when no ACTIVE run
  // exists under `lifecycle='ready'`, adopts the latest COMPLETED run. These
  // tests are the gate on both halves, plus the `ready`-with-no-run anomaly
  // 087 deliberately refuses (mirroring 086's identical guard).
  //
  // THIS SUITE REQUIRES 087 APPLIED. Against a 001-086 database the first
  // test below fails with two runs and `lifecycle='onboarding'`.
  // =========================================================================

  describe('C. a lifecycle=ready web worker at the WhatsApp door', () => {
    const web: { runId: string } = { runId: '' };

    test('the web door drives a worker all the way to lifecycle=ready', async () => {
      const started = await startWebRun('ready');
      web.runId = started.run_id;

      const session = webSession('ready');
      expect((await turn(session, msgFor('ready', { body: 'accept' }))).result.stepKey).toBe('profile.name');
      expect((await turn(session, msgFor('ready', { body: 'Beto Rivera' }))).result.stepKey).toBe('profile.location');
      expect((await turn(session, msgFor('ready', { body: 'El Paso, TX' }))).result.stepKey).toBe('profile.trade');
      expect((await turn(session, msgFor('ready', { interactivePayload: 'profile:main_trade:carpenter' }))).result.stepKey).toBe('profile.experience');
      expect((await turn(session, msgFor('ready', { interactivePayload: 'profile:years_experience:2-4' }))).result.stepKey).toBe('profile.transportation');
      expect((await turn(session, msgFor('ready', { interactivePayload: 'profile:has_transportation:true' }))).result.stepKey).toBe('profile.availability');
      expect((await turn(session, msgFor('ready', { interactivePayload: 'profile:availability:full_time' }))).result.stepKey).toBe('trust.question.1');
      expect((await turn(session, msgFor('ready', { body: 'I hang doors and run finish trim.' }))).result.stepKey).toBe('trust.question.2');
      expect((await turn(session, msgFor('ready', { body: 'I walk the space and check the plans first.' }))).result.stepKey).toBe('trust.question.3');
      const last = await turn(session, msgFor('ready', { body: 'A warped jamb once; I re-ordered and shimmed meanwhile.' }));
      expect(last.result).toEqual({ handled: true, workerId: ids.ready, stepKey: 'trust.question.3' });

      expect(await lifecycleOf(ids.ready)).toEqual({ lifecycle: 'ready', has_ready_at: true });
      const runs = await runsFor(ids.ready);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: web.runId, status: 'completed' });
    });

    test('087: the bind ADOPTS the completed run, keeps lifecycle=ready, and hands off', async () => {
      const session = waSession('ready');
      const bind = await whatsappOtpArrival('ready', session);

      // 087 change 1: the terminal lifecycle survives the state upsert, with
      // its original lifecycle_changed_at and ready_at.
      expect(await lifecycleOf(ids.ready)).toEqual({ lifecycle: 'ready', has_ready_at: true });

      // 087 change 2: no ACTIVE run exists, so the completed one is adopted
      // rather than a second run being minted at legal.review.
      const runs = await runsFor(ids.ready);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: web.runId, status: 'completed' });

      // The conversation is bound by the definer exactly as on any other
      // bind — 087 changed which run is returned, not whether the bind runs.
      const conv = await su.query<{ user_id: string | null }>(
        `SELECT user_id FROM whatsapp_conversations WHERE id = $1`, [convIds.ready],
      );
      expect(conv.rows[0].user_id).toBe(ids.ready);

      // GAP CLOSED (R2-C23). This assertion used to pin the defect: the OTP
      // turn re-prompted `gate.currentStepKey ?? 'legal.review'` without ever
      // consulting `gate.lifecycle`, so a worker who finished on the web was
      // asked their last trust question again the moment they verified their
      // number. 087 could not fix it from SQL — the run it correctly adopts
      // still HAS a `current_step_key`, and the check belongs in TypeScript.
      //
      // `handleOtpStep` now takes the SAME ready handoff the router takes for
      // every later message (see the test below). Sprint 27 adds one
      // marker the later turns never carry, `consumedAsOtp`: this body WAS
      // the code, so the processor must not route it as a command (it used to
      // reach idle_help, or an open employer chat). Nothing was parked for
      // this phone, so there is no referred job to deliver.
      expect(bind.result).toEqual({
        handled: false, handoff: 'ready', workerId: ids.ready, stepKey: 'ready', consumedAsOtp: true,
      });
      expect(bind.sent).toHaveLength(0);
    });

    test('087: the NEXT WhatsApp message IS the ready handoff, not a restart', async () => {
      // The processor writes the bind's user_id back onto the conversation
      // row, so from here on `routeOnboardingV2` loads a gate. Pre-087 that
      // gate was the freshly minted ACTIVE run at legal.review and this
      // message would have been routed as onboarding; with the completed run
      // adopted it is `lifecycle='ready' + status='completed'`, so the entry
      // point's ready-handoff branch fires and nothing is sent (the ready
      // confirmation belongs to the worker.ready release lane).
      const session = waSession('ready');
      session.user_id = ids.ready;
      session.conversation_state = 'idle';

      const next = await turn(session, msgFor('ready', { body: 'hello?' }, 'wa'));
      expect(next.result).toEqual({
        handled: false, handoff: 'ready', workerId: ids.ready, stepKey: 'ready',
      });
      expect(next.sent).toHaveLength(0);

      // Still exactly one run, still completed, still ready.
      const runs = await runsFor(ids.ready);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: web.runId, status: 'completed' });
      expect(await lifecycleOf(ids.ready)).toEqual({ lifecycle: 'ready', has_ready_at: true });
    });

    test('087: adoption appends NO otp_verified transition to the completed run', async () => {
      // The transition INSERT is gated on `v_created_run`, which stays false
      // on both adoption paths. A spurious row here would make the run's
      // transition history claim it restarted at legal.review.
      const transitions = await su.query<{ reason: string }>(
        `SELECT reason FROM worker_workflow_transitions
          WHERE run_id = $1 AND reason = 'otp_verified'`,
        [web.runId],
      );
      expect(transitions.rowCount).toBe(0);

      // ...and the run's own step/lock are untouched by the bind.
      const runs = await runsFor(ids.ready);
      expect(runs[0].current_step_key).toBe('trust.question.3');
    });

    test('087: lifecycle=ready with NO completed run is refused (55000), not restarted', async () => {
      // A data anomaly: both this bind and `start_web_onboarding_workflow`
      // (086) create the run alongside the state, so `ready` with no run
      // cannot arise from either code path. 087 mirrors 086's decision —
      // refuse with the identical message rather than mint a fresh
      // onboarding run, which would silently un-finish a finished worker.
      await su.query(
        `INSERT INTO worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at, ready_at)
         VALUES ($1, 'ready', now(), now())`,
        [ids.orphan],
      );
      expect(await runsFor(ids.orphan)).toHaveLength(0);

      const session = waSession('orphan');
      await expect(whatsappOtpArrival('orphan', session)).rejects.toThrow(
        'worker is lifecycle=ready with no completed workflow run',
      );

      // The refusal is total: the failed turn rolled back, so no run was
      // created and the anomalous state is left exactly as an operator will
      // find it.
      expect(await runsFor(ids.orphan)).toHaveLength(0);
      expect(await lifecycleOf(ids.orphan)).toEqual({ lifecycle: 'ready', has_ready_at: true });
      const conv = await su.query<{ user_id: string | null }>(
        `SELECT user_id FROM whatsapp_conversations WHERE id = $1`, [convIds.orphan],
      );
      expect(conv.rows[0].user_id).toBeNull();
    });
  });

  // =========================================================================
  // D. referral parking across the two doors
  // =========================================================================

  describe('D. a referral parked on the WhatsApp phone hash, claimed by a web completion', () => {
    test('completeOnboarding at the WEB door claims a claim parked under the same phone', async () => {
      // `parkPendingClaim` (onboarding/steps/start.ts:56) keys on
      // `hashNormalizedPhone(conv.whatsapp_number)`; the only claim site
      // left after C6 is `completeOnboarding` -> `claimPendingReferral`,
      // which the WEB door feeds `hashNormalizedPhone(session.whatsapp_
      // number)` = `hashNormalizedPhone(users.phone)`. `hashNormalizedPhone`
      // only trims, so the two agree iff the two phone strings are
      // byte-identical. They are: the processor strips the `whatsapp:`
      // prefix and stores E.164, and web signup stores E.164 in users.phone.
      // This test is that agreement, executed.
      const phoneHash = hashNormalizedPhone(phones.referral);
      await su.query(
        `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at)
         VALUES ($1, $2, now() + INTERVAL '30 days')`,
        [phoneHash, jobId],
      );

      await startWebRun('referral');
      const session = webSession('referral');
      expect((await turn(session, msgFor('referral', { body: 'accept' }))).result.stepKey).toBe('profile.name');
      expect((await turn(session, msgFor('referral', { body: 'Carla Nunez' }))).result.stepKey).toBe('profile.location');
      expect((await turn(session, msgFor('referral', { body: 'El Paso, TX' }))).result.stepKey).toBe('profile.trade');
      expect((await turn(session, msgFor('referral', { interactivePayload: 'profile:main_trade:carpenter' }))).result.stepKey).toBe('profile.experience');
      expect((await turn(session, msgFor('referral', { interactivePayload: 'profile:years_experience:2-4' }))).result.stepKey).toBe('profile.transportation');
      expect((await turn(session, msgFor('referral', { interactivePayload: 'profile:has_transportation:true' }))).result.stepKey).toBe('profile.availability');
      expect((await turn(session, msgFor('referral', { interactivePayload: 'profile:availability:full_time' }))).result.stepKey).toBe('trust.question.1');
      await turn(session, msgFor('referral', { body: 'Framing and trim.' }));
      await turn(session, msgFor('referral', { body: 'I check the plans first.' }));
      await turn(session, msgFor('referral', { body: 'Re-ordered a warped jamb once.' }));

      expect(await lifecycleOf(ids.referral)).toEqual({ lifecycle: 'ready', has_ready_at: true });

      const claim = await su.query<{ claimed_worker_id: string | null }>(
        `SELECT claimed_worker_id FROM referral_pending_claims WHERE phone_hash = $1`, [phoneHash],
      );
      expect(claim.rows[0].claimed_worker_id).toBe(ids.referral);

      const attribution = await su.query<{ first_job_id: string; latest_job_id: string }>(
        `SELECT first_job_id, latest_job_id FROM worker_attribution WHERE worker_id = $1`,
        [ids.referral],
      );
      expect(attribution.rows).toHaveLength(1);
      expect(attribution.rows[0].first_job_id).toBe(jobId);
    });
  });

  // =========================================================================
  // E. R2-C23: the referral a READY web worker carries in on WhatsApp
  // =========================================================================

  describe('E. a ready web worker whose first WhatsApp message carries a referral code', () => {
    test('the OTP turn claims the parked referral and writes attribution', async () => {
      // THE GAP THIS CLOSES. `handleStartStep` parks the code on arrival, and
      // the ONLY claim site is `completeOnboarding` -> `claimPendingReferral`.
      // This worker already completed -- on the web, before ever texting -- so
      // that moment is behind them and never comes again on WhatsApp. Without
      // a claim in the ready handoff the parked claim sits forever and the
      // referrer is never credited, which is precisely the person a referral
      // link sends to the website in the first place.
      await startWebRun('readyref');
      const web = webSession('readyref');
      expect((await turn(web, msgFor('readyref', { body: 'accept' }))).result.stepKey).toBe('profile.name');
      expect((await turn(web, msgFor('readyref', { body: 'Nora Salas' }))).result.stepKey).toBe('profile.location');
      expect((await turn(web, msgFor('readyref', { body: 'El Paso, TX' }))).result.stepKey).toBe('profile.trade');
      expect((await turn(web, msgFor('readyref', { interactivePayload: 'profile:main_trade:carpenter' }))).result.stepKey).toBe('profile.experience');
      expect((await turn(web, msgFor('readyref', { interactivePayload: 'profile:years_experience:2-4' }))).result.stepKey).toBe('profile.transportation');
      expect((await turn(web, msgFor('readyref', { interactivePayload: 'profile:has_transportation:true' }))).result.stepKey).toBe('profile.availability');
      expect((await turn(web, msgFor('readyref', { interactivePayload: 'profile:availability:full_time' }))).result.stepKey).toBe('trust.question.1');
      await turn(web, msgFor('readyref', { body: 'Framing and finish trim.' }));
      await turn(web, msgFor('readyref', { body: 'I walk the space and read the plans.' }));
      await turn(web, msgFor('readyref', { body: 'A warped jamb once; re-ordered and shimmed.' }));
      expect(await lifecycleOf(ids.readyref)).toEqual({ lifecycle: 'ready', has_ready_at: true });

      // Nothing is claimed yet: the web completion hashes `users.phone`, and
      // this worker's referral has not been parked at all until they text.
      const phoneHash = hashNormalizedPhone(phones.readyref);
      expect((await su.query(
        `SELECT 1 FROM referral_pending_claims WHERE phone_hash = $1`, [phoneHash],
      )).rowCount).toBe(0);

      // Now the first WhatsApp message, carrying the code. The code turn runs
      // the processor's own job-card step in the same transaction, after routing:
      // the referred job goes out as the tappable job card.
      const wa = waSession('readyref');
      let cardSid = '';
      let cardQueued = false;
      const bind = await whatsappOtpArrival(
        'readyref', wa, `Hola, quiero este trabajo ${formatApplyToken(applyTokenRaw)}`,
        async (client, result, code) => {
          if (result.handled || !result.consumedAsOtp || !result.referredJobId) return;
          // The processor claimed this inbound message at the top of its turn.
          cardSid = await logInbound(phones.readyref, code.messageSid);
          cardQueued = await queueReferredJobCard(
            client,
            { id: convIds.readyref, language: wa.language, state_context: {} as ConversationRow['state_context'] },
            { messageSid: code.messageSid, from: phones.readyref },
            result.referredJobId,
          );
        },
      );

      // Still the ready handoff and still silent ON THE ROUTER: the code was
      // consumed, and the claimed job -- open, not applied to -- rides on it.
      expect(bind.result).toEqual({
        handled: false, handoff: 'ready', workerId: ids.readyref, stepKey: 'ready',
        consumedAsOtp: true, referredJobId: jobId,
      });
      expect(bind.sent).toHaveLength(0);

      // The first reply named the job before the invitation.
      expect(bind.firstPreAuth.map((s) => s.kind)).toEqual(['text', 'prompt']);
      expect(bind.firstPreAuth[0].payload).toBe(t('v2_referral_ack', 'es', { title: 'Finish Carpenter', company: 'Jale' }));

      // The claim recorded the job on the worker's list -- as
      // jale_whatsapp, under the internal setting the OTP bind set for THIS
      // worker. A missing setting would have been refused by migration 103's policy.
      expect(await referredJobsOf(ids.readyref)).toEqual([{ job_id: jobId, source: 'whatsapp_token' }]);

      // The card, as an inbound reply to the code message.
      expect(cardQueued).toBe(true);
      const card = await su.query<{
        whatsapp_number: string; body: string | null; content_template: string | null;
        content_variables: Record<string, string> | null;
      }>(
        `SELECT whatsapp_number, body, content_template, content_variables
           FROM whatsapp_outbox WHERE inbound_message_sid = $1`,
        [cardSid],
      );
      expect(card.rows).toHaveLength(1);
      expect(card.rows[0].whatsapp_number).toBe(phones.readyref);
      expect(card.rows[0].body).toBeNull();
      expect(card.rows[0].content_template).toBe('job_alert_en');
      expect(card.rows[0].content_variables).toMatchObject({
        '1': 'Finish Carpenter', '2': 'Jale', '3': 'El Paso, TX', '5': `job-${jobId}`,
      });
      expect(card.rows[0].content_variables!.__fallback_body).toContain('Finish Carpenter');
      // "1 interested" resolves against recent_jobs, so the job is there.
      const conv = await su.query<{ state_context: { recent_jobs?: string[] } }>(
        `SELECT state_context FROM whatsapp_conversations WHERE id = $1`, [convIds.readyref],
      );
      expect(conv.rows[0].state_context.recent_jobs).toEqual([jobId]);

      // Parked by the start step, then CLAIMED by the ready handoff.
      const claim = await su.query<{ claimed_worker_id: string | null; job_id: string }>(
        `SELECT claimed_worker_id, job_id FROM referral_pending_claims WHERE phone_hash = $1`,
        [phoneHash],
      );
      expect(claim.rows).toHaveLength(1);
      expect(claim.rows[0].claimed_worker_id).toBe(ids.readyref);
      expect(claim.rows[0].job_id).toBe(jobId);

      // And the attribution row credits the share link's OWN channel, not the
      // WhatsApp transport the person happened to arrive on.
      const attribution = await su.query<{ first_job_id: string; first_channel: string }>(
        `SELECT first_job_id, first_channel FROM worker_attribution WHERE worker_id = $1`,
        [ids.readyref],
      );
      expect(attribution.rows).toHaveLength(1);
      expect(attribution.rows[0].first_job_id).toBe(jobId);
      expect(attribution.rows[0].first_channel).toBe('facebook');
    });
  });

  // =========================================================================
  // F-K. The WhatsApp door names the job, keeps it, and
  // delivers it as a card. Every write runs as the bed's jale_whatsapp role,
  // with and without the worker's internal setting; migration 103's policy is
  // keyed on that setting, which the original bug left unset.
  // =========================================================================

  describe('F. a token in the FIRST WhatsApp message, then onboarding finished on WhatsApp', () => {
    test('completion records the job on the worker list and credits the EMPLOYER referrer', async () => {
      const wa = waSession('tokenwa');
      const bind = await whatsappOtpArrival(
        'tokenwa', wa, `Quiero postularme a este trabajo: ${formatApplyToken(employerTokenRaw)}`,
      );
      // A WhatsApp-native worker: no web run, so the bind starts one.
      expect(bind.result).toEqual({ handled: true, workerId: ids.tokenwa, stepKey: 'legal.review' });
      // The first reply named the job.
      expect(bind.firstPreAuth[0]).toMatchObject({
        kind: 'text', payload: t('v2_referral_ack', 'es', { title: 'Roofer', company: 'NB Construction' }),
      });

      wa.user_id = ids.tokenwa;
      wa.conversation_state = 'onboarding_v2';
      await whatsappOnboardToReady('tokenwa', wa);

      // The claim's own record, written at completion as jale_whatsapp.
      expect(await referredJobsOf(ids.tokenwa)).toEqual([{ job_id: roofJobId, source: 'whatsapp_token' }]);

      // ...and the referrer the link names. Before sprint 27 the employer was dropped
      // (the parked claim only ever carried a worker referrer).
      const attribution = await su.query(
        `SELECT first_job_id, first_channel, first_share_code, first_referrer_worker_id, first_referrer_employer_id
           FROM worker_attribution WHERE worker_id = $1`,
        [ids.tokenwa],
      );
      expect(attribution.rows).toEqual([{
        first_job_id: roofJobId,
        first_channel: 'whatsapp',
        first_share_code: employerShareCode,
        first_referrer_worker_id: null,
        first_referrer_employer_id: employerId,
      }]);
    });
  });

  describe('G. a token from a BOUND worker mid-onboarding', () => {
    test('is recorded and parked, never stored as the name, and the question is asked again', async () => {
      const wa = waSession('bound');
      const bind = await whatsappOtpArrival('bound', wa);
      expect(bind.result.stepKey).toBe('legal.review');
      wa.user_id = ids.bound;
      wa.conversation_state = 'onboarding_v2';
      expect((await turn(wa, msgFor('bound', { body: 'accept' }, 'wa'))).result.stepKey).toBe('profile.name');

      const token = await turn(wa, msgFor('bound', {
        body: `Quiero postularme a este trabajo: ${formatApplyToken(boundTokenRaw)}`,
      }, 'wa'));

      expect(token.result).toEqual({ handled: true, workerId: ids.bound, stepKey: 'profile.name' });
      const user = await su.query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [ids.bound]);
      expect(user.rows[0].full_name).toBeNull();
      // Recorded as jale_whatsapp under the setting the router set for this
      // bound worker...
      expect(await referredJobsOf(ids.bound)).toEqual([{ job_id: jobId, source: 'whatsapp_token' }]);
      // ...and parked under this phone, for the referrer's credit at completion.
      const claim = await su.query<{ job_id: string; claimed_at: Date | null }>(
        `SELECT job_id, claimed_at FROM referral_pending_claims WHERE phone_hash = $1`,
        [hashNormalizedPhone(phones.bound)],
      );
      expect(claim.rows).toEqual([{ job_id: jobId, claimed_at: null }]);
      // The job named back, then the same question again.
      expect(token.sent.map((m) => m.sourceType)).toEqual([
        'onboarding_v2:v2_referral_ack_bound',
        'onboarding_v2:profile.name',
      ]);

      // The NEXT message is still the name.
      const name = await turn(wa, msgFor('bound', { body: 'Lupe Garza' }, 'wa'));
      expect(name.result.stepKey).toBe('profile.location');
    });
  });

  describe('H. a worker who finished on the WEB with no linked WhatsApp', () => {
    test('the release writes NO outbox row; the welcome and the referred job carry whatsapp_not_linked', async () => {
      // `referral` completed on the web in group D; its parked claim was
      // claimed there and recorded on the list. It never bound
      // WhatsApp, so users.whatsapp_number is empty while users.phone is set.
      expect(await referredJobsOf(ids.referral)).toEqual([{ job_id: jobId, source: 'whatsapp_token' }]);
      const user = await su.query<{ whatsapp_number: string | null; phone: string | null }>(
        `SELECT whatsapp_number, phone FROM users WHERE id = $1`, [ids.referral],
      );
      expect(user.rows[0].whatsapp_number ?? '').toBe('');
      expect(user.rows[0].phone).toBe(phones.referral);

      const result = await releaseReady(ids.referral);

      expect(result).toEqual({ released: 0, expired: 0, superseded: 2, failed: 0 });
      const state = await releaseStateOf(ids.referral);
      expect(state.outbox).toEqual([]);
      expect(state.intents).toEqual([
        { source_type: 'onboarding_complete', source_id: ids.referral, status: 'superseded', decision_reason: 'whatsapp_not_linked' },
        { source_type: 'referred_job', source_id: jobId, status: 'superseded', decision_reason: 'whatsapp_not_linked' },
      ]);
    });
  });

  describe('I. the completion release inside and outside the 24h window', () => {
    test('INSIDE: the welcome says a job follows, and the job follows as a card', async () => {
      // `tokenwa` finished on WhatsApp in group F: its last answer is minutes old.
      await logInbound(phones.tokenwa);

      const result = await releaseReady(ids.tokenwa);

      expect(result).toEqual({ released: 2, expired: 0, superseded: 0, failed: 0 });
      const { outbox } = await releaseStateOf(ids.tokenwa);
      expect(outbox).toHaveLength(2);
      expect(outbox[0]).toMatchObject({ body: t('v2_ready_jobs_one', 'en'), content_template: null });
      expect(outbox[1]).toMatchObject({ body: null, content_template: 'job_alert_en' });
      expect(outbox[1].content_variables).toMatchObject({
        '1': 'Roofer', '2': 'NB Construction', '5': `job-${roofJobId}`,
      });
    });

    test('OUTSIDE: the free-form welcome is superseded, the card is still written -- and a bot-side # row does not count', async () => {
      // `ready` finished on the web (group C) and bound WhatsApp, so it is
      // linked -- but it has never written to us. A `#err` row on its number
      // is OURS (a failure record), not the worker's.
      await su.query(
        `INSERT INTO worker_referred_jobs (worker_id, job_id, source) VALUES ($1, $2, 'job_page')`,
        [ids.ready, roofJobId],
      );
      await logInbound(phones.ready, `r2c6-${randomUUID().slice(0, 8)}#err`);

      const result = await releaseReady(ids.ready);

      expect(result).toEqual({ released: 1, expired: 0, superseded: 1, failed: 0 });
      const state = await releaseStateOf(ids.ready);
      expect(state.intents.find((i) => i.source_type === 'onboarding_complete')).toMatchObject({
        status: 'superseded', decision_reason: 'outside_session_window',
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]).toMatchObject({ body: null, content_template: 'job_alert_en' });
    });
  });

  describe('K. a TYPED code from a ready worker', () => {
    test('the processor records it as jale_whatsapp, setting the internal setting itself', async () => {
      // No setting at all on this transaction: the step sets its own.
      await asWhatsapp(null, (client) => recordTypedCodeReferredJob(client, ids.typed, roofJobId));
      expect(await referredJobsOf(ids.typed)).toEqual([{ job_id: roofJobId, source: 'typed_code' }]);
    });

    test('CONTROL: the same write WITHOUT the setting is refused by the policy on worker_referred_jobs', async () => {
      await expect(asWhatsapp(null, (client) => recordReferredJob(client, {
        workerId: ids.typed, jobId, source: 'typed_code',
      }))).rejects.toThrow(/row-level security/);
      expect(await referredJobsOf(ids.typed)).toEqual([{ job_id: roofJobId, source: 'typed_code' }]);
    });
  });

  describe('J. the new statements carry their own predicates (run as the superuser, whom RLS filters for nothing)', () => {
    /** One superuser transaction, always rolled back. */
    async function asSuperuser<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        return await fn(client as unknown as PoolClient);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    }

    test("loadActiveJobLabel: status = 'active' is in the statement, with the feed's company default", async () => {
      const labels = await asSuperuser(async (c) => ({
        open: await loadActiveJobLabel(c, jobId),
        closed: await loadActiveJobLabel(c, closedJobId),
      }));
      expect(labels).toEqual({ open: { title: 'Finish Carpenter', company: 'Jale' }, closed: null });
    });

    test('findUnclaimedParkedJobId: keyed by THIS phone, and only while unclaimed', async () => {
      // phone_hash carries a CHECK on its shape, so these are real hashes.
      const mine = hashNormalizedPhone(`+1555${Math.floor(1000000 + Math.random() * 8999999)}`);
      const theirs = hashNormalizedPhone(`+1555${Math.floor(1000000 + Math.random() * 8999999)}`);
      const found = await asSuperuser(async (c) => {
        await c.query(
          `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
          [theirs, roofJobId],
        );
        const nothingYet = await findUnclaimedParkedJobId(c, mine);
        await c.query(
          `INSERT INTO referral_pending_claims (phone_hash, job_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
          [mine, jobId],
        );
        const parked = await findUnclaimedParkedJobId(c, mine);
        await c.query(
          `UPDATE referral_pending_claims SET claimed_at = now(), claimed_worker_id = $2 WHERE phone_hash = $1`,
          [mine, ids.typed],
        );
        const claimed = await findUnclaimedParkedJobId(c, mine);
        return { nothingYet, parked, claimed };
      });
      expect(found).toEqual({ nothingYet: null, parked: jobId, claimed: null });
    });

    test("isOpenUnappliedJob: another worker's application never hides the job; this worker's does; a closed job is never open", async () => {
      const verdicts = await asSuperuser(async (c) => {
        await c.query(`INSERT INTO job_applications (job_id, worker_id) VALUES ($1, $2)`, [roofJobId, ids.signup]);
        const othersApplied = await isOpenUnappliedJob(c, roofJobId, ids.typed);
        await c.query(`INSERT INTO job_applications (job_id, worker_id) VALUES ($1, $2)`, [roofJobId, ids.typed]);
        const iApplied = await isOpenUnappliedJob(c, roofJobId, ids.typed);
        const closed = await isOpenUnappliedJob(c, closedJobId, ids.typed);
        return { othersApplied, iApplied, closed };
      });
      expect(verdicts).toEqual({ othersApplied: true, iApplied: false, closed: false });
    });

    test("isWithinSessionWindow: the recipient's own rows only, never a # row, on the database clock", async () => {
      const number = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
      const other = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
      const windows = await asSuperuser(async (c) => {
        await c.query(
          `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status) VALUES ($1, $2, 'completed')`,
          [`r2c6-${randomUUID().slice(0, 8)}`, other],
        );
        await c.query(
          `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status) VALUES ($1, $2, 'failed')`,
          [`r2c6-${randomUUID().slice(0, 8)}#err`, number],
        );
        const onlyNoise = await isWithinSessionWindow(c, number);
        await c.query(
          `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, first_seen_at)
           VALUES ($1, $2, 'completed', now() - interval '2 days')`,
          [`r2c6-${randomUUID().slice(0, 8)}`, number],
        );
        const stale = await isWithinSessionWindow(c, number);
        await c.query(
          `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status) VALUES ($1, $2, 'completed')`,
          [`r2c6-${randomUUID().slice(0, 8)}`, number],
        );
        const fresh = await isWithinSessionWindow(c, number);
        return { onlyNoise, stale, fresh };
      });
      expect(windows).toEqual({ onlyNoise: false, stale: false, fresh: true });
    });

    test("claimPendingReferral: a REVOKED link credits nobody -- the statement's own revoked_at predicate", async () => {
      const attribution = await asSuperuser(async (c) => {
        const code = 'R2C6RVKD';
        await c.query(
          `INSERT INTO job_share_links (code, job_id, referrer_employer_id, channel, revoked_at)
           VALUES ($1, $2, $3, 'sms', now())`,
          [code, closedJobId, employerId],
        );
        const phoneHash = hashNormalizedPhone(`+1555${Math.floor(1000000 + Math.random() * 8999999)}`);
        await c.query(
          `INSERT INTO referral_pending_claims (phone_hash, job_id, share_code, expires_at)
           VALUES ($1, $2, $3, now() + interval '1 day')`,
          [phoneHash, closedJobId, code],
        );
        const claim = await claimPendingReferral(c, phoneHash, ids.typed, new Date());
        const row = await c.query(
          `SELECT first_channel, first_share_code, first_referrer_employer_id FROM worker_attribution WHERE worker_id = $1`,
          [ids.typed],
        );
        return { claim, row: row.rows[0] };
      });
      expect(attribution.claim).toEqual({ claimed: true, jobId: closedJobId });
      expect(attribution.row).toEqual({ first_channel: 'unknown', first_share_code: null, first_referrer_employer_id: null });
    });
  });

  // =========================================================================
  // L. Two job links before sign-in: every job parked on the phone is kept
  // until the claim, and the credit stays with the last code
  // =========================================================================

  describe('L. two job links before sign-in', () => {
    const FIRST_JOB = { title: 'Finish Carpenter', company: 'Jale' };
    const SECOND_JOB = { title: 'Roofer', company: 'NB Construction' };
    const prefill = (token: string, lang: 'es' | 'en' = 'es') => (lang === 'es'
      ? `Quiero postularme a este trabajo: ${formatApplyToken(token)}`
      : `I want to apply for this job: ${formatApplyToken(token)}`);

    function scriptIdentity(key: 'twootp' | 'twostart'): void {
      identityScript.verifiedWorkerId = ids[key];
      identityScript.session = `cognito-session-${key}-${randomUUID().slice(0, 8)}`;
    }

    /** The code, the bind, then every onboarding answer up to ready. */
    async function verifyAndComplete(key: 'twootp' | 'twostart', wa: OnboardingV2Session): Promise<void> {
      const code = await turn(wa, msgFor(key, { body: '123456' }, 'wa'));
      expect(code.result).toEqual({ handled: true, workerId: ids[key], stepKey: 'legal.review' });
      wa.user_id = ids[key];
      wa.conversation_state = 'onboarding_v2';
      await whatsappOnboardToReady(key, wa);
    }

    /** Both jobs on the list, the last code's newest, and the last code's link credited. */
    async function expectBothJobsAndLastCodeCredit(workerId: string): Promise<void> {
      expect(await referredJobsOf(workerId)).toEqual([
        { job_id: roofJobId, source: 'whatsapp_token' },
        { job_id: jobId, source: 'whatsapp_token' },
      ]);
      const attribution = await su.query(
        `SELECT first_job_id, first_share_code, first_referrer_worker_id, first_referrer_employer_id
           FROM worker_attribution WHERE worker_id = $1`,
        [workerId],
      );
      expect(attribution.rows).toEqual([{
        first_job_id: roofJobId,
        first_share_code: employerShareCode,
        first_referrer_worker_id: null,
        first_referrer_employer_id: employerId,
      }]);
    }

    /** The completion release: the welcome, then one card per job, the last code's first. */
    async function expectWelcomeAndTwoCards(workerId: string, phone: string): Promise<void> {
      await logInbound(phone);
      expect(await releaseReady(workerId)).toEqual({ released: 3, expired: 0, superseded: 0, failed: 0 });
      const { outbox } = await releaseStateOf(workerId);
      expect(outbox.map((row) => row.content_template)).toEqual([null, 'job_alert_en', 'job_alert_en']);
      expect(outbox[0].body).toBe(t('v2_ready_jobs_many', 'en'));
      expect(outbox.slice(1).map((row) => row.content_variables?.['5'])).toEqual([`job-${roofJobId}`, `job-${jobId}`]);
    }

    test('a token at the start, then another while the code is pending: both jobs are kept and both cards are sent', async () => {
      const key = 'twootp';
      const wa = waSession(key);
      scriptIdentity(key);

      const first = await turn(wa, msgFor(key, { body: prefill(twoLinkTokens.otpFirst) }, 'wa'));
      expect(first.result).toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });
      expect(first.preAuth.map((s) => s.kind)).toEqual(['text', 'prompt']);
      expect(first.preAuth[0].payload).toBe(t('v2_referral_ack', 'es', FIRST_JOB));

      const chose = await turn(wa, msgFor(key, { interactivePayload: 'start:lang:en' }, 'wa'));
      expect(chose.result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });

      // The second job's link while the code is pending: parked and named,
      // never checked as a code.
      const second = await turn(wa, msgFor(key, { body: prefill(twoLinkTokens.otpSecond, 'en') }, 'wa'));
      expect(second.result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });
      expect(second.preAuth.map((s) => s.kind)).toEqual(['text']);
      expect(second.preAuth[0].payload).toBe(t('v2_referral_ack_otp', 'en', SECOND_JOB));

      await verifyAndComplete(key, wa);
      await expectBothJobsAndLastCodeCredit(ids[key]);
      await expectWelcomeAndTwoCards(ids[key], phones[key]);
    });

    test('two tokens at the start, the second inside the start cooldown: both jobs are kept and both cards are sent', async () => {
      const key = 'twostart';
      const wa = waSession(key);
      scriptIdentity(key);

      const first = await turn(wa, msgFor(key, { body: prefill(twoLinkTokens.startFirst) }, 'wa'));
      expect(first.preAuth.map((s) => s.kind)).toEqual(['text', 'prompt']);
      expect(first.preAuth[0].payload).toBe(t('v2_referral_ack', 'es', FIRST_JOB));

      // A minute later: the cooldown holds the reply back, and the second job
      // is parked all the same.
      const second = await turn(wa, msgFor(key, { body: prefill(twoLinkTokens.startSecond) }, 'wa'));
      expect(second.result).toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });
      expect(second.preAuth).toEqual([]);

      const chose = await turn(wa, msgFor(key, { interactivePayload: 'start:lang:en' }, 'wa'));
      expect(chose.result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });

      await verifyAndComplete(key, wa);
      await expectBothJobsAndLastCodeCredit(ids[key]);
      await expectWelcomeAndTwoCards(ids[key], phones[key]);
    });

    test('a replaced job is kept once and the current one never twice; a claimed phone starts a new set', async () => {
      // Superuser, one transaction, rolled back: the park and claim statements
      // themselves, with tokens for no share link.
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const c = client as unknown as PoolClient;
      const phoneHash = hashNormalizedPhone(`+1555${Math.floor(1000000 + Math.random() * 8999999)}`);
      const start = Date.now();
      let step = 0;
      const at = () => new Date(start + 1000 * (step += 1));
      const tokens = ['SVWXYZ0A', 'TVWXYZ0B', 'VWXYZ01C', 'WXYZ012D'];
      try {
        await c.query('BEGIN');
        for (const [token, job] of [[tokens[0], jobId], [tokens[1], roofJobId], [tokens[2], jobId], [tokens[3], roofJobId]]) {
          await c.query(
            `INSERT INTO referral_apply_tokens (token_hash, job_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
            [hashToken(token), job],
          );
        }
        const workers: string[] = [];
        for (const label of ['first', 'second']) {
          const w = await c.query<{ id: string }>(
            `INSERT INTO users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`,
            [`r2c6-parked-${label}-${randomUUID().slice(0, 8)}`],
          );
          workers.push(w.rows[0].id);
        }
        const listOf = async (workerId: string) => (await c.query<{ job_id: string }>(
          `SELECT job_id FROM worker_referred_jobs WHERE worker_id = $1 ORDER BY last_seen_at DESC, job_id`,
          [workerId],
        )).rows.map((r) => r.job_id);

        // The first job, the second, then the first again: the claim keeps
        // both, once each, the current code's job newest.
        await parkPendingClaim(c, phoneHash, tokens[0], at());
        await parkPendingClaim(c, phoneHash, tokens[1], at());
        await parkPendingClaim(c, phoneHash, tokens[2], at());
        expect(await claimPendingReferral(c, phoneHash, workers[0], at())).toEqual({ claimed: true, jobId });
        expect(await listOf(workers[0])).toEqual([jobId, roofJobId]);

        // A new code on the claimed phone is a new pending claim: nothing
        // from the claimed set comes back.
        await parkPendingClaim(c, phoneHash, tokens[3], at());
        expect(await claimPendingReferral(c, phoneHash, workers[1], at())).toEqual({ claimed: true, jobId: roofJobId });
        expect(await listOf(workers[1])).toEqual([roofJobId]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    });

    /** Resolves once `pid` waits on a lock that `blockerPid` holds; fails after `boundMs`. */
    async function waitUntilBlockedBy(pid: number, blockerPid: number, boundMs = 15_000): Promise<void> {
      const deadline = Date.now() + boundMs;
      for (;;) {
        const r = await su.query<{ blocked: boolean }>(
          `SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`,
          [pid, blockerPid],
        );
        if (r.rows[0].blocked) return;
        if (Date.now() > deadline) throw new Error('the claim never waited on the uncommitted delete');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    test('an earlier job its employer deletes while the claim records it costs neither the claim nor the claimed job', async () => {
      // Committed before either transaction below opens: a job of this test's
      // own (the shared fixture jobs stay), a worker, and a phone with two
      // parked claims, that job first and then the roofing job.
      const phoneHash = hashNormalizedPhone(`+1555${Math.floor(1000000 + Math.random() * 8999999)}`);
      const tokens = ['XYZ0123E', 'YZ01234F'];
      const earlierJobId = (await su.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, city, state)
         VALUES ($1, 'Drywall Hanger', 'El Paso, TX', 'full-time', 'El Paso', 'TX') RETURNING id`,
        [employerId],
      )).rows[0].id;
      const workerId = (await su.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`,
        [`r2c6-race-${randomUUID().slice(0, 8)}`],
      )).rows[0].id;
      const employer = new Client({ connectionString: databaseUrl });
      let employerConnected = false;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        for (const [token, job] of [[tokens[0], earlierJobId], [tokens[1], roofJobId]]) {
          await su.query(
            `INSERT INTO referral_apply_tokens (token_hash, job_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
            [hashToken(token), job],
          );
        }
        await asWhatsapp(null, async (client) => {
          await parkPendingClaim(client, phoneHash, tokens[0], new Date(Date.now() - 2000));
          await parkPendingClaim(client, phoneHash, tokens[1], new Date(Date.now() - 1000));
        });

        // The employer deletes the earlier job, and has not committed yet.
        await employer.connect();
        employerConnected = true;
        const employerPid = (await employer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await employer.query('BEGIN');
        await employer.query('DELETE FROM jobs WHERE id = $1', [earlierJobId]);

        const result = await asWhatsapp(workerId, async (client) => {
          const claimPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await client.query(`SET LOCAL lock_timeout = '20s'`);
          const claiming = claimPendingReferral(client, phoneHash, workerId, new Date());
          claiming.catch(() => undefined);
          try {
            // The claim's record of the earlier job waits on the employer's
            // delete; then the delete commits under it.
            await waitUntilBlockedBy(claimPid, employerPid);
            await employer.query('COMMIT');
          } catch (error) {
            await employer.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
          return claiming;
        });

        expect(result).toEqual({ claimed: true, jobId: roofJobId });
        // The race happened: the earlier job is gone, and its record failed.
        expect((await su.query(`SELECT 1 FROM jobs WHERE id = $1`, [earlierJobId])).rowCount).toBe(0);
        expect(errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain('ReferredJobRecordFailed');
        // The claimed job is still on the worker's list, and the claim is the worker's.
        expect(await referredJobsOf(workerId)).toEqual([{ job_id: roofJobId, source: 'whatsapp_token' }]);
        const claimRow = await su.query(`SELECT claimed_worker_id FROM referral_pending_claims WHERE phone_hash = $1`, [phoneHash]);
        expect(claimRow.rows).toEqual([{ claimed_worker_id: workerId }]);
      } finally {
        errorSpy.mockRestore();
        if (employerConnected) {
          await employer.query('ROLLBACK').catch(() => undefined);
          await employer.end().catch(() => undefined);
        }
        await su.query(`DELETE FROM referral_pending_claims WHERE phone_hash = $1`, [phoneHash]);
        await su.query(`DELETE FROM referral_apply_tokens WHERE token_hash = ANY($1::text[])`, [tokens.map((token) => hashToken(token))]);
        await su.query(`DELETE FROM users WHERE id = $1`, [workerId]);
        await su.query(`DELETE FROM jobs WHERE id = $1`, [earlierJobId]);
      }
    }, 60_000);
  });
});
