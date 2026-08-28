/**
 * web-worker-whatsapp-crossover.integration.test.ts
 *
 * Sprint 22 R2-C6/C4/087 gate against REAL PostgreSQL 16 with migrations
 * 001-087 applied. Group C REQUIRES 087: on a 001-086 database it fails
 * with two runs and lifecycle='onboarding', which is the exact regression
 * 087 removes.
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
 *   The fake returns exactly that id.
 *
 * CONNECTION
 *   Set JALE_TEST_DATABASE_URL to a SUPERUSER connection string for a
 *   disposable PostgreSQL 16 database with 001-087 applied (see
 *   db/local/bootstrap-testbed.sh). Fixtures and verification reads use the
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
import { setInternalUserRlsContext } from '../../../lambda/lib/db';
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

  /** Worker fixtures. `signup` exercises group A only. */
  const WORKER_KEYS = ['signup', 'resume', 'ready', 'referral', 'orphan'] as const;

  let employerId = '';
  let jobId = '';

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
      async verifyChallenge() {
        if (!identityScript.verifiedWorkerId) {
          throw new Error('identity adapter reached with no scripted verified worker');
        }
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

  /** One inbound value = one transaction, exactly as either Lambda runs it. */
  async function turn(
    session: OnboardingV2Session,
    msg: OnboardingV2InboundMessage,
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
  ): Promise<{ result: RouteResult; sent: WorkerMessageIntentInput[] }> {
    identityScript.verifiedWorkerId = ids[key];
    identityScript.session = `cognito-session-${key}-${randomUUID().slice(0, 8)}`;

    const hello = await turn(session, msgFor(key, { body: 'Hola' }, 'wa'));
    expect(hello.result).toEqual({
      handled: true, workerId: null, stepKey: 'start.choose_language',
    });

    const chose = await turn(session, msgFor(key, { interactivePayload: 'start:lang:en' }, 'wa'));
    expect(chose.result).toEqual({
      handled: true, workerId: null, stepKey: 'identity.verify_otp',
    });

    return turn(session, msgFor(key, { body: '123456' }, 'wa'));
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
    for (const key of ['resume', 'ready', 'referral', 'orphan'] as const) {
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
        full_name: string | null; pending_full_name: string | null; email: string | null;
      }>(
        `SELECT cognito_sub, phone, user_type, full_name, pending_full_name, email
           FROM users WHERE cognito_sub = $1`,
        [subs.signup],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].user_type).toBe('worker');
      expect(row.rows[0].phone).toBe(phones.signup);
      // R2 web signup is PHONE ONLY: no fullName is sent, nothing is staged
      // for promote_worker_pending_name, and no email exists at all. The
      // name is collected inside the flow, at `profile.name`.
      expect(row.rows[0].full_name).toBeNull();
      expect(row.rows[0].pending_full_name).toBeNull();
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

      // KNOWN GAP, deliberately asserted rather than wished away. What the
      // worker is SENT on this turn is decided by `handleOtpStep`
      // (onboarding/steps/otp.ts:84-86), which does
      //   `const stepKey = gate.currentStepKey ?? 'legal.review'` and
      //   prompts it — without ever consulting `gate.lifecycle`.
      // So a finished worker gets their last onboarding step re-prompted on
      // the OTP turn. 087 cannot fix that: the run it correctly adopts still
      // HAS a `current_step_key`, and the lifecycle check that should
      // suppress the prompt lives in TypeScript. No data is harmed (the very
      // next message takes the ready handoff — see the test below, and
      // `handleTrustQuestion` is never reached), but the copy is wrong.
      // Fix belongs in otp.ts, which R2-C6/087 does not own; reported as a
      // follow-up.
      expect(bind.result).toEqual({
        handled: true, workerId: ids.ready, stepKey: 'trust.question.3',
      });
      expect(bind.sent).toHaveLength(1);
      expect(bind.sent[0].sourceType).toBe('onboarding_v2:trust.question.3');
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
});
