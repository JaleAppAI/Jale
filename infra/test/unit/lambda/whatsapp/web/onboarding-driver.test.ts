/**
 * The web door's driver, against the SAME fakes the WhatsApp router is tested
 * with (`test/helpers/whatsapp-v2-harness.ts`).
 *
 * That shared harness is the point. The web door is a SECOND caller of one
 * state machine, and the failure this suite exists to prevent is drift: a web
 * value shape that stops matching what the step handler parses, a rejection
 * the browser stops being told about, a command string that starts being
 * swallowed instead of stored. Every test below drives the real handlers.
 *
 * The real-PostgreSQL proof (grants, RLS, cross-door resume, the outbox) lives
 * in `test/unit/db/web-onboarding-door.integration.test.ts`.
 */

import { createWhatsAppV2Harness, HARNESS_CLIENT, type WhatsAppV2Harness } from '../../../../helpers/whatsapp-v2-harness';
import {
  MAX_ANSWERS_PER_BATCH,
  TRUST_ANSWER_MAX_CHARS,
  TRUST_ANSWER_MIN_CHARS,
  WEB_BACK_REASON,
  applyAnswerBatch,
  applyBack,
  createWebSession,
  mapAnswerToEngineMessage,
  setPreferredLanguage,
  type WebAnswerItem,
} from '../../../../../lambda/whatsapp/web/onboarding-driver';
import type { WorkerGate } from '../../../../../lambda/whatsapp/lib/onboarding-repository';

// ── The value -> engine message table ────────────────────────────────────

describe('mapAnswerToEngineMessage', () => {
  const noConfirm = { pendingLocationConfirm: false };

  test.each([
    ['legal.review', 'accept', { body: 'accept' }],
    ['profile.name', 'Ana Torres', { body: 'Ana Torres' }],
    ['profile.location', { kind: 'zip', zip: '79901' }, { body: '79901' }],
    ['profile.custom_trade', 'welder', { body: 'welder' }],
    ['profile.trade', 'carpenter', { interactivePayload: 'profile:main_trade:carpenter' }],
    ['profile.trade', 'other', { interactivePayload: 'profile:main_trade:other' }],
    ['profile.experience', '2-4', { interactivePayload: 'profile:years_experience:2-4' }],
    ['profile.availability', 'full_time', { interactivePayload: 'profile:availability:full_time' }],
    ['profile.transportation', true, { interactivePayload: 'profile:has_transportation:true' }],
    ['profile.transportation', false, { interactivePayload: 'profile:has_transportation:false' }],
  ])('%s translates to the dialect the handler already parses', (stepKey, value, expected) => {
    expect(mapAnswerToEngineMessage(stepKey as string, value, noConfirm)).toEqual({ ok: true, fields: expected });
  });

  test('a city+state location becomes the "City, ST" string the resolver reads', () => {
    expect(
      mapAnswerToEngineMessage('profile.location', { kind: 'city_state', city: 'El Paso', state: 'TX' }, noConfirm),
    ).toEqual({ ok: true, fields: { body: 'El Paso, TX' } });
  });

  test('a location confirmation becomes 1/2, but ONLY while one is parked', () => {
    const parked = { pendingLocationConfirm: true };
    expect(mapAnswerToEngineMessage('profile.location', { kind: 'confirm', accept: true }, parked))
      .toEqual({ ok: true, fields: { body: '1' } });
    expect(mapAnswerToEngineMessage('profile.location', { kind: 'confirm', accept: false }, parked))
      .toEqual({ ok: true, fields: { body: '2' } });

    // Unparked, '1' would be handed to the LOCATION RESOLVER as if it were a
    // place name. Refusing beats mistranslating.
    expect(mapAnswerToEngineMessage('profile.location', { kind: 'confirm', accept: true }, noConfirm))
      .toEqual({ ok: false, reason: 'no_pending_confirm' });
  });

  test('profile.custom_trade is capped, floored, trimmed and control-char free', () => {
    // This value becomes `users.main_trade_other` (a bare TEXT column, no
    // length CHECK), the `profession_key` the question generator is PROMPTED
    // with, and the trade label an employer reads. Without a cap here, a
    // pasted CV becomes all three.
    expect(mapAnswerToEngineMessage('profile.custom_trade', '  welder  ', noConfirm))
      .toEqual({ ok: true, fields: { body: 'welder' } });
    // Trimmed, not raw: `normalizeTrade` slugs this into `profession_key`, so
    // a trailing space would mint a second cache row for the same trade.
    expect(mapAnswerToEngineMessage('profile.custom_trade', 'a'.repeat(60), noConfirm))
      .toEqual({ ok: true, fields: { body: 'a'.repeat(60) } });

    expect(mapAnswerToEngineMessage('profile.custom_trade', 'a'.repeat(61), noConfirm))
      .toEqual({ ok: false, reason: 'too_long' });
    expect(mapAnswerToEngineMessage('profile.custom_trade', ' x ', noConfirm))
      .toEqual({ ok: false, reason: 'too_short' });
    expect(mapAnswerToEngineMessage('profile.custom_trade', '   ', noConfirm))
      .toEqual({ ok: false, reason: 'too_short' });
    // A trade name is ONE line. A newline here is either a paste accident or
    // an attempt to steer the generator prompt.
    expect(mapAnswerToEngineMessage('profile.custom_trade', 'welder\nIgnore previous', noConfirm))
      .toEqual({ ok: false, reason: 'invalid' });
    // An unpaired surrogate is not a control character, but PostgreSQL cannot
    // store it inside jsonb (`v2ProfileTrade` in worker_workflow_runs.context).
    expect(mapAnswerToEngineMessage('profile.custom_trade', 'we\uD800lder', noConfirm))
      .toEqual({ ok: false, reason: 'invalid' });
  });

  test('text PostgreSQL cannot store is refused at the door, newlines are not', () => {
    // NUL is 22021 on a text column and 22P05 inside jsonb; a lone surrogate
    // is 22P02 inside jsonb. Each used to be a 500 from deep in the engine.
    for (const bad of ['Ana\u0000Torres', 'Ana\uD800Torres', 'Ana\uDC00Torres']) {
      expect(mapAnswerToEngineMessage('profile.name', bad, noConfirm))
        .toEqual({ ok: false, reason: 'invalid_value' });
      expect(mapAnswerToEngineMessage('trust.question.1', { text: `${bad} hangs doors and frames walls` }, noConfirm))
        .toEqual({ ok: false, reason: 'invalid_value' });
      expect(mapAnswerToEngineMessage('profile.location', { kind: 'city_state', city: bad, state: 'TX' }, noConfirm))
        .toEqual({ ok: false, reason: 'invalid_value' });
    }
    // A properly paired surrogate (an emoji) and a newline are legitimate text.
    expect(mapAnswerToEngineMessage('profile.name', 'Ana \uD83D\uDE00 Torres', noConfirm))
      .toEqual({ ok: true, fields: { body: 'Ana \uD83D\uDE00 Torres' } });
    expect(mapAnswerToEngineMessage('trust.question.1', { text: 'I hang doors.\nI frame walls.' }, noConfirm))
      .toEqual({ ok: true, fields: { body: 'I hang doors.\nI frame walls.' } });
  });

  test('a typed city and state are length-capped before the resolver sees them', () => {
    // The resolver bounds the charset, not the length, and the resolved text
    // lands verbatim in users.city, worker_preferred_cities and
    // worker_profiles.location — 8000 bytes per column without this.
    expect(mapAnswerToEngineMessage('profile.location', { kind: 'city_state', city: 'Ab'.repeat(4000), state: 'TX' }, noConfirm))
      .toEqual({ ok: false, reason: 'too_long' });
    expect(mapAnswerToEngineMessage('profile.location', { kind: 'city_state', city: 'Austin', state: 'T'.repeat(41) }, noConfirm))
      .toEqual({ ok: false, reason: 'too_long' });
    expect(mapAnswerToEngineMessage('profile.location', { kind: 'city_state', city: 'Rancho Santa Margarita', state: 'California' }, noConfirm))
      .toEqual({ ok: true, fields: { body: 'Rancho Santa Margarita, California' } });
  });

  test('a ZIP answer is five digits only, never a city_state smuggled through the comma', () => {
    // `resolve()` splits on the last comma, so an unguarded zip value is a
    // second, uncapped city_state channel (and a prototype-key smuggler into
    // inferCityState). Only /^\d{5}$/ passes.
    expect(mapAnswerToEngineMessage('profile.location', { kind: 'zip', zip: '79901' }, noConfirm))
      .toEqual({ ok: true, fields: { body: '79901' } });
    for (const bad of ['Ab'.repeat(4000) + ', TX', '__proto__', 'constructor', '7990', '799011', '7990a', '79901, TX', '79901\u0000', ' 79901 ']) {
      expect(mapAnswerToEngineMessage('profile.location', { kind: 'zip', zip: bad }, noConfirm))
        .toEqual({ ok: false, reason: 'invalid_value' });
    }
  });

  test('an unknown vocabulary key is a rejection, never a passed-through payload', () => {
    expect(mapAnswerToEngineMessage('profile.trade', 'astronaut', noConfirm)).toEqual({ ok: false, reason: 'invalid_choice' });
    expect(mapAnswerToEngineMessage('profile.experience', '20+', noConfirm)).toEqual({ ok: false, reason: 'invalid_choice' });
    expect(mapAnswerToEngineMessage('profile.availability', 'sometimes', noConfirm)).toEqual({ ok: false, reason: 'invalid_choice' });
    // A string 'true' is not a boolean: the engine's own parser distinguishes
    // them, and so must the translator.
    expect(mapAnswerToEngineMessage('profile.transportation', 'true', noConfirm)).toEqual({ ok: false, reason: 'invalid_choice' });
  });

  test('legal.review takes acceptance only — decline would strand the web worker', () => {
    // `decline` parks the run at status='declined', whose only exit is the
    // WhatsApp REVIEW TERMS command. The web flow has no screen for that.
    expect(mapAnswerToEngineMessage('legal.review', 'decline', noConfirm)).toEqual({ ok: false, reason: 'invalid_value' });
  });

  test('the photo keys are not answerable steps', () => {
    for (const step of ['profile.photo', 'profile.photo_type']) {
      expect(mapAnswerToEngineMessage(step, { skip: true }, noConfirm)).toEqual({ ok: false, reason: 'unknown_step' });
    }
  });

  describe('trust answers', () => {
    const long = 'I frame houses and hang interior doors on remodels.';

    test('accept the {text} wrapper the client sends', () => {
      expect(mapAnswerToEngineMessage('trust.question.1', { text: long }, noConfirm))
        .toEqual({ ok: true, fields: { body: long } });
    });

    test('enforce a floor the WhatsApp door deliberately does not have', () => {
      const short = 'x'.repeat(TRUST_ANSWER_MIN_CHARS - 1);
      expect(mapAnswerToEngineMessage('trust.question.2', { text: short }, noConfirm))
        .toEqual({ ok: false, reason: 'too_short' });
      // Exactly at the floor is accepted — an off-by-one here silently
      // disagrees with the client's own Next-button rule.
      const atFloor = 'y'.repeat(TRUST_ANSWER_MIN_CHARS);
      expect(mapAnswerToEngineMessage('trust.question.2', { text: atFloor }, noConfirm))
        .toEqual({ ok: true, fields: { body: atFloor } });
    });

    test('measure length AFTER trimming, and store the trimmed text', () => {
      const padded = `   ${'z'.repeat(TRUST_ANSWER_MIN_CHARS)}   `;
      expect(mapAnswerToEngineMessage('trust.question.1', { text: padded }, noConfirm))
        .toEqual({ ok: true, fields: { body: 'z'.repeat(TRUST_ANSWER_MIN_CHARS) } });
      expect(mapAnswerToEngineMessage('trust.question.1', { text: '        ' }, noConfirm))
        .toEqual({ ok: false, reason: 'too_short' });
    });

    test('cap the ceiling', () => {
      expect(mapAnswerToEngineMessage('trust.question.3', { text: 'q'.repeat(TRUST_ANSWER_MAX_CHARS + 1) }, noConfirm))
        .toEqual({ ok: false, reason: 'too_long' });
    });
  });
});

// ── Driving the real handlers ────────────────────────────────────────────

describe('applyAnswerBatch', () => {
  let harness: WhatsAppV2Harness;
  let workerId: string;

  async function gate(): Promise<WorkerGate> {
    const g = await harness.gateFor();
    if (!g) throw new Error('no gate');
    return g;
  }

  async function apply(answers: WebAnswerItem[]) {
    const g = await gate();
    return applyAnswerBatch(HARNESS_CLIENT, harness.deps, {
      workerId,
      session: createWebSession({ workerId, phone: '+15550001111', language: g.preferredLanguage }),
      gate: g,
      answers,
      now: harness.now(),
    });
  }

  beforeEach(async () => {
    harness = createWhatsAppV2Harness();
    // The bound run itself is minted by the OTP lane here; on the real web
    // door `start_web_onboarding_workflow` mints the identical row. What is
    // under test is everything AFTER the run exists.
    await harness.driveToStep('legal.review');
    workerId = harness.boundWorkerId();
  });

  test('a whole screen applies in one batch, in order', async () => {
    expect(await apply([{ stepKey: 'legal.review', value: 'accept' }])).toEqual({ rejection: null, completed: false });
    expect((await gate()).currentStepKey).toBe('profile.name');

    // The "about" screen posts name + location together.
    const about = await apply([
      { stepKey: 'profile.name', value: 'Ana Torres' },
      { stepKey: 'profile.location', value: { kind: 'zip', zip: '79901' } },
    ]);
    expect(about).toEqual({ rejection: null, completed: false });
    expect((await gate()).currentStepKey).toBe('profile.trade');
  });

  test('stops at the FIRST rejection and names the step that failed', async () => {
    await apply([{ stepKey: 'legal.review', value: 'accept' }]);

    // profile.name requires 2..100 characters; the engine reprompts rather
    // than throwing, so this is the structural-refusal path.
    const result = await apply([
      { stepKey: 'profile.name', value: 'A' },
      { stepKey: 'profile.location', value: { kind: 'zip', zip: '79901' } },
    ]);
    expect(result.rejection).toEqual({ code: 'step_rejected', stepKey: 'profile.name', reason: 'rejected' });
    // The run did NOT advance past the refused step, so the second item was
    // never attempted.
    expect((await gate()).currentStepKey).toBe('profile.name');
  });

  test('keeps the progress made BEFORE the rejection', async () => {
    await apply([{ stepKey: 'legal.review', value: 'accept' }]);
    const result = await apply([
      { stepKey: 'profile.name', value: 'Ana Torres' },
      // 'astronaut' is not a trade, and this step is not even current — the
      // step_mismatch guard fires first, which is itself the point: item one
      // still landed.
      { stepKey: 'profile.trade', value: 'astronaut' },
    ]);
    expect(result.rejection?.code).toBe('step_mismatch');
    expect((await gate()).currentStepKey).toBe('profile.location');
  });

  test('an item for a step the run is not on is step_mismatch, and says where the run is', async () => {
    const result = await apply([{ stepKey: 'profile.name', value: 'Ana Torres' }]);
    expect(result.rejection).toEqual({
      code: 'step_mismatch',
      stepKey: 'profile.name',
      reason: 'expected:legal.review',
    });
  });

  test('a photo step key is unknown_step, never a silent no-op', async () => {
    const result = await apply([{ stepKey: 'profile.photo', value: { skip: true } }]);
    expect(result.rejection).toEqual({ code: 'unknown_step', stepKey: 'profile.photo', reason: 'unknown_step' });
  });

  test('reports completion so the caller can poke the domain-outbox drain', async () => {
    await harness.driveToStep('trust.question.3', { trade: 'carpenter' });
    const answer = 'A door jamb came in warped; I re-ordered it and shimmed the opening square.';
    const result = await apply([{ stepKey: 'trust.question.3', value: { text: answer } }]);
    expect(result).toEqual({ rejection: null, completed: true });
  });

  test('MAX_ANSWERS_PER_BATCH is wide enough for the widest screen', () => {
    // The "work" screen posts experience + transportation + availability.
    expect(MAX_ANSWERS_PER_BATCH).toBeGreaterThanOrEqual(3);
  });
});

// ── The command gate is NOT in the web door's path ───────────────────────

describe('commands are values on the web, not commands', () => {
  let harness: WhatsAppV2Harness;
  let workerId: string;

  beforeEach(async () => {
    harness = createWhatsAppV2Harness();
    await harness.driveToStep('profile.custom_trade', { trade: 'other' });
    workerId = harness.boundWorkerId();
  });

  async function apply(answers: WebAnswerItem[]) {
    const g = await harness.gateFor();
    return applyAnswerBatch(HARNESS_CLIENT, harness.deps, {
      workerId,
      session: createWebSession({ workerId, phone: '+15550001111', language: 'en' }),
      gate: g as WorkerGate,
      answers,
      now: harness.now(),
    });
  }

  // Each of these is intercepted by `applyGate` on WhatsApp. On the web they
  // are what the worker typed into a text box, and losing them would be
  // silent data loss, not a helpful command.
  test.each(['back', 'atras', 'restart', 'jobs', 'trabajos', 'chats', 'perfil', 'hola', 'ayuda', 'idioma', 'resend'])(
    'a custom trade of %p is stored, not swallowed',
    async (word) => {
      const result = await apply([{ stepKey: 'profile.custom_trade', value: word }]);
      expect(result.rejection).toBeNull();
      // It advanced, which is only possible if `handleCustomTrade` actually
      // ran and saved it.
      expect((await harness.gateFor())?.currentStepKey).not.toBe('profile.custom_trade');
    },
  );
});

// ── BACK ─────────────────────────────────────────────────────────────────

describe('applyBack', () => {
  let harness: WhatsAppV2Harness;

  beforeEach(async () => {
    harness = createWhatsAppV2Harness();
  });

  test('steps the run back one, per the transition history', async () => {
    await harness.driveToStep('trust.question.2', { trade: 'carpenter' });
    const before = (await harness.gateFor()) as WorkerGate;
    const result = await applyBack(HARNESS_CLIENT, harness.deps, { gate: before, now: harness.now() });
    expect(result).toMatchObject({ moved: true });
    expect((await harness.gateFor())?.currentStepKey).toBe('trust.question.1');
  });

  test('pressing back TWICE walks backwards twice — it does not bounce forward', async () => {
    // This is the whole reason the reason string is `worker_back_web` and not
    // `web_back`. `findPreviousStepKey` excludes `reason LIKE 'worker\\_%'`;
    // a reason outside that pattern makes the FIRST back's own transition row
    // the most recent one landing on the step, so the second press would find
    // `trust.question.2` as "the step before trust.question.1" and walk the
    // run forward again.
    expect(WEB_BACK_REASON.startsWith('worker_')).toBe(true);

    await harness.driveToStep('trust.question.2', { trade: 'carpenter' });
    await applyBack(HARNESS_CLIENT, harness.deps, { gate: (await harness.gateFor()) as WorkerGate, now: harness.now() });
    expect((await harness.gateFor())?.currentStepKey).toBe('trust.question.1');

    await applyBack(HARNESS_CLIENT, harness.deps, { gate: (await harness.gateFor()) as WorkerGate, now: harness.now() });
    expect((await harness.gateFor())?.currentStepKey).toBe('profile.availability');
  });

  test('refuses at the first profile step, where there is nowhere to go', async () => {
    await harness.driveToStep('profile.name');
    const result = await applyBack(HARNESS_CLIENT, harness.deps, {
      gate: (await harness.gateFor()) as WorkerGate,
      now: harness.now(),
    });
    expect(result).toEqual({ moved: false, reason: 'nothing_to_go_back_to' });
  });

  test('refuses at legal.review — a legal decision is not an answer to redo', async () => {
    await harness.driveToStep('legal.review');
    const result = await applyBack(HARNESS_CLIENT, harness.deps, {
      gate: (await harness.gateFor()) as WorkerGate,
      now: harness.now(),
    });
    expect(result).toEqual({ moved: false, reason: 'nothing_to_go_back_to' });
  });
});

// ── Language ─────────────────────────────────────────────────────────────

describe('setPreferredLanguage', () => {
  test('persists the run column AND the durable override, exactly as IDIOMA does', async () => {
    const harness = createWhatsAppV2Harness();
    await harness.driveToStep('profile.name');
    const workerId = harness.boundWorkerId();
    const session = createWebSession({ workerId, phone: '+15550001111', language: 'en' });

    const updated = await setPreferredLanguage(HARNESS_CLIENT, harness.deps, {
      gate: (await harness.gateFor()) as WorkerGate,
      session,
      preferredLanguage: 'es',
    });

    // The column is what the worker.ready release renderer reads...
    expect(updated.preferredLanguage).toBe('es');
    // ...and the override is what every subsequent prompt in this run reads.
    expect(session.state_context.v2PreferredLanguageOverride).toBe('es');
  });

  test('is a no-op, not a 409, once the run is no longer active', async () => {
    // `setRunPreferredLanguage` has `AND status = 'active'`, so on a completed
    // run it matches zero rows and throws `workflow_lock_conflict`. A ready
    // worker whose language toggle is still on screen must not 409 forever.
    const harness = createWhatsAppV2Harness();
    await harness.driveToStep('trust.question.3', { trade: 'carpenter' });
    await harness.sendText('A door jamb came in warped; I re-ordered it and shimmed the opening.');

    const workerId = harness.boundWorkerId();
    const completed = (await harness.gateFor()) as WorkerGate;
    expect(completed.status).toBe('completed');

    const session = createWebSession({ workerId, phone: '+15550001111', language: 'en' });
    await expect(
      setPreferredLanguage(HARNESS_CLIENT, harness.deps, { gate: completed, session, preferredLanguage: 'es' }),
    ).resolves.toBe(completed);
  });
});
