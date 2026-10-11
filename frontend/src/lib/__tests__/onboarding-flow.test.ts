import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWER_CHARS,
  MAX_CUSTOM_TRADE_CHARS,
  MIN_ANSWER_CHARS,
  MIN_CUSTOM_TRADE_CHARS,
  PROGRESS_SEGMENTS,
  STEP_SCREEN,
  answerLongEnough,
  answerTooLong,
  answersForScreen,
  canContinue,
  currentScreen,
  customTradeAcceptable,
  draftFromState,
  initFlowState,
  isTrustScreen,
  isZipLocation,
  joinName,
  locationConfirmAnswer,
  locationStepValue,
  onboardingFlowReducer,
  questionText,
  screenForState,
  ENGINE_STEP_ORDER,
  engineStepIndex,
  isAnswerableStepKey,
  itemsFromCursor,
  screenForStepKey,
  splitFullName,
  type OnboardingDraft,
} from '@/lib/onboarding-flow';
import type { OnboardingState } from '@/lib/api/worker';

/**
 * The flow model is where "resume" lives: every rule about which screen a
 * worker sees, what that screen posts, and what happens to their half-typed
 * draft when the server answers is decided here rather than in a component, so
 * it can be pinned without a DOM.
 */

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    lifecycle: 'onboarding',
    run: { id: 'run-1', stepKey: 'legal.review', lockVersion: 3, preferredLanguage: 'en', workflowVersion: 2 },
    profile: {
      fullName: null,
      location: null,
      trade: null,
      yearsExperience: null,
      hasTransportation: null,
      availability: null,
    },
    trust: { questions: [], answers: [] },
    pendingLocationConfirm: null,
    extraction: null,
    ...overrides,
  };
}

const emptyDraft: OnboardingDraft = {
  firstName: '',
  lastName: '',
  location: { text: '', city: null, state: null, zip: null },
  trade: null,
  customTrade: '',
  experience: null,
  transportation: null,
  availability: null,
  answers: ['', '', ''],
};

describe('step key → screen mapping', () => {
  it('knows every engine step key the workflow union declares, in order', () => {
    // Mirrors infra/lambda/whatsapp/lib/onboarding-types.ts's WorkflowStepKey,
    // minus the two dead photo keys — see below. ENGINE_STEP_ORDER is the list
    // that must be COMPLETE (a gap mis-sorts everything after it); STEP_SCREEN
    // is deliberately smaller.
    const engineSteps = [
      'start.choose_language', 'identity.verify_otp', 'legal.review',
      'profile.voice_choice', 'profile.voice_processing',
      'profile.name', 'profile.location', 'profile.trade', 'profile.custom_trade',
      'profile.experience', 'profile.transportation', 'profile.availability',
      'trust.question.1', 'trust.question.2', 'trust.question.3',
    ];
    expect([...ENGINE_STEP_ORDER]).toEqual(engineSteps);
    for (const step of engineSteps) {
      expect(engineStepIndex(step), `not ordered: ${step}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives the dead photo step keys no screen of their own', () => {
    // No handler advances them and the API answers `unknown_step`, so a screen
    // whose Continue posts one would be a trap. They take the safe default.
    expect(STEP_SCREEN['profile.photo']).toBeUndefined();
    expect(STEP_SCREEN['profile.photo_type']).toBeUndefined();
    expect(screenForStepKey('profile.photo')).toBe('terms');
  });

  it('flags the steps whose screen is only a fallback, so the flow can offer an exit', () => {
    // `screenForStepKey` is total by design -- it always names a screen. That
    // makes it useless for telling "the run is here" from "we had to guess",
    // and the difference matters: the guess is the FIRST screen, whose
    // Continue posts `legal.review` and which has no Back. Runs really are
    // parked on the retired photo steps, so this is the flag that gets them
    // out instead of leaving them on a button that can only 422.
    expect(isAnswerableStepKey('profile.photo')).toBe(false);
    expect(isAnswerableStepKey('profile.photo_type')).toBe(false);
    expect(isAnswerableStepKey('some.future.step')).toBe(false);
    expect(isAnswerableStepKey('')).toBe(false);
    // The voice pair is IN the engine's order but not answerable here: the
    // engine is waiting for a voice decision, and every step this door could
    // post is behind it. That run has to be finished on WhatsApp.
    expect(engineStepIndex('profile.voice_choice')).toBeGreaterThan(0);
    expect(isAnswerableStepKey('profile.voice_choice')).toBe(false);
    expect(isAnswerableStepKey('profile.voice_processing')).toBe(false);
    expect(isAnswerableStepKey('legal.review')).toBe(true);
    expect(isAnswerableStepKey('trust.question.3')).toBe(true);
    // Not fooled by what every object inherits.
    expect(isAnswerableStepKey('toString')).toBe(false);
    expect(isAnswerableStepKey('constructor')).toBe(false);
  });

  it('sends the three profile screens their own steps', () => {
    expect(screenForStepKey('legal.review')).toBe('terms');
    expect(screenForStepKey('profile.name')).toBe('about');
    expect(screenForStepKey('profile.location')).toBe('about');
    expect(screenForStepKey('profile.trade')).toBe('trade');
    expect(screenForStepKey('profile.custom_trade')).toBe('trade');
    expect(screenForStepKey('profile.experience')).toBe('work');
    expect(screenForStepKey('profile.transportation')).toBe('work');
    expect(screenForStepKey('profile.availability')).toBe('work');
    expect(screenForStepKey('trust.question.2')).toBe('q2');
  });

  it('lands an unknown or WhatsApp-only step on a safe screen instead of crashing', () => {
    expect(screenForStepKey('profile.voice_choice')).toBe('terms');
    expect(screenForStepKey('start.choose_language')).toBe('terms');
    expect(screenForStepKey('identity.verify_otp')).toBe('terms');
    expect(screenForStepKey('some.future.step')).toBe('terms');
    expect(screenForStepKey('')).toBe('terms');
  });

  it('lets lifecycle "ready" override whatever cursor the engine left behind', () => {
    expect(screenForState(state({ lifecycle: 'ready' }))).toBe('done');
    expect(screenForState(state({ lifecycle: 'ready', run: { ...state().run, stepKey: 'trust.question.1' } })))
      .toBe('done');
  });

  it('keeps the progress bar to the eight pre-summary screens, questions marked as trust', () => {
    expect(PROGRESS_SEGMENTS).toEqual(['terms', 'about', 'trade', 'work', 'q1', 'q2', 'q3', 'photo']);
    expect(PROGRESS_SEGMENTS.filter(isTrustScreen)).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('name join/split', () => {
  it('joins with exactly one space and trims', () => {
    expect(joinName('  David ', ' Castellanos ')).toBe('David Castellanos');
    expect(joinName('David', '')).toBe('David');
  });

  it('splits at the FIRST space so a compound surname survives a round trip', () => {
    expect(splitFullName('Ana Maria de la Cruz')).toEqual({ firstName: 'Ana', lastName: 'Maria de la Cruz' });
    expect(splitFullName('David')).toEqual({ firstName: 'David', lastName: '' });
    expect(splitFullName(null)).toEqual({ firstName: '', lastName: '' });
    expect(splitFullName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('location value', () => {
  it('prefers a picked city+state over anything typed', () => {
    expect(locationStepValue({ text: 'San Antonio, Texas', city: 'San Antonio', state: 'Texas', zip: '78201' }))
      .toEqual({ kind: 'city_state', city: 'San Antonio', state: 'Texas' });
  });

  it('accepts a bare 5-digit box as a ZIP', () => {
    expect(locationStepValue({ text: ' 79901 ', city: null, state: null, zip: null }))
      .toEqual({ kind: 'zip', zip: '79901' });
    expect(isZipLocation({ text: '79901', city: null, state: null, zip: null })).toBe(true);
  });

  it('rejects a half-typed box', () => {
    expect(locationStepValue({ text: 'El Pas', city: null, state: null, zip: null })).toBeNull();
    expect(locationStepValue({ text: '799', city: null, state: null, zip: null })).toBeNull();
    expect(locationStepValue({ text: '', city: null, state: null, zip: null })).toBeNull();
  });
});

describe('what each screen posts', () => {
  it('terms accepts', () => {
    expect(answersForScreen('terms', emptyDraft, 'legal.review')).toEqual([{ stepKey: 'legal.review', value: 'accept' }]);
  });

  it('about posts name and location as ONE batch', () => {
    const draft = {
      ...emptyDraft,
      firstName: 'David',
      lastName: 'Castellanos',
      location: { text: 'San Antonio, Texas', city: 'San Antonio', state: 'Texas', zip: null },
    };
    expect(answersForScreen('about', draft, 'profile.name')).toEqual([
      { stepKey: 'profile.name', value: 'David Castellanos' },
      { stepKey: 'profile.location', value: { kind: 'city_state', city: 'San Antonio', state: 'Texas' } },
    ]);
  });

  it('trade posts one step, or two when the worker typed their own', () => {
    expect(answersForScreen('trade', { ...emptyDraft, trade: 'carpenter' }, 'profile.trade'))
      .toEqual([{ stepKey: 'profile.trade', value: 'carpenter' }]);
    expect(answersForScreen('trade', { ...emptyDraft, trade: 'other', customTrade: ' welder ' }, 'profile.trade'))
      .toEqual([
        { stepKey: 'profile.trade', value: 'other' },
        { stepKey: 'profile.custom_trade', value: 'welder' },
      ]);
  });

  it('work posts all three answers from the one screen', () => {
    const draft = { ...emptyDraft, experience: '2-4' as const, transportation: true, availability: 'full_time' as const };
    expect(answersForScreen('work', draft, 'profile.experience')).toEqual([
      { stepKey: 'profile.experience', value: '2-4' },
      { stepKey: 'profile.transportation', value: true },
      { stepKey: 'profile.availability', value: 'full_time' },
    ]);
  });

  it('a question posts its own trust step with trimmed text', () => {
    const draft = { ...emptyDraft, answers: ['a', ' I frame houses all day long ', 'c'] as [string, string, string] };
    expect(answersForScreen('q2', draft, 'trust.question.2'))
      .toEqual([{ stepKey: 'trust.question.2', value: { text: 'I frame houses all day long' } }]);
  });

  it('photo posts NOTHING — it is a client-side prompt, not an engine step', () => {
    expect(answersForScreen('photo', emptyDraft, 'trust.question.3')).toEqual([]);
    expect(answersForScreen('done', emptyDraft, 'trust.question.3')).toEqual([]);
  });

  it('the location confirm prompt posts its own step', () => {
    expect(locationConfirmAnswer(true)).toEqual([{ stepKey: 'profile.location', value: { kind: 'confirm', accept: true } }]);
    expect(locationConfirmAnswer(false)).toEqual([{ stepKey: 'profile.location', value: { kind: 'confirm', accept: false } }]);
  });
});

describe('a batch never reaches back behind the engine', () => {
  // The engine applies a batch item by item and refuses any item that is not
  // the step it is on at that moment -- it does not skip the ones it has
  // already answered. Every one of these is a real resume: the worker did part
  // of the screen on WhatsApp and is finishing it here.

  const filled = {
    ...emptyDraft,
    firstName: 'David',
    lastName: 'Castellanos',
    location: { text: '79901', city: null, state: null, zip: null },
    trade: 'carpenter' as const,
    experience: '2-4' as const,
    transportation: true,
    availability: 'full_time' as const,
  };

  it('sends the location alone when the name is already answered', () => {
    expect(answersForScreen('about', filled, 'profile.location')).toEqual([
      { stepKey: 'profile.location', value: { kind: 'zip', zip: '79901' } },
    ]);
  });

  it('sends the custom trade alone when the run is already past the trade', () => {
    const other = { ...filled, trade: 'other' as const, customTrade: 'welder' };
    expect(answersForScreen('trade', other, 'profile.custom_trade')).toEqual([
      { stepKey: 'profile.custom_trade', value: 'welder' },
    ]);
  });

  it('sends availability alone when the other two work answers are in', () => {
    expect(answersForScreen('work', filled, 'profile.availability')).toEqual([
      { stepKey: 'profile.availability', value: 'full_time' },
    ]);
  });

  it('sends the tail of the work screen, not just its last item', () => {
    expect(answersForScreen('work', filled, 'profile.transportation')).toEqual([
      { stepKey: 'profile.transportation', value: true },
      { stepKey: 'profile.availability', value: 'full_time' },
    ]);
  });

  it('keeps the whole batch when the cursor is at the front of the screen', () => {
    expect(answersForScreen('work', filled, 'profile.experience')).toHaveLength(3);
    expect(answersForScreen('about', filled, 'profile.name')).toHaveLength(2);
  });

  it('leaves items alone when the cursor is a step we have never heard of', () => {
    // Nothing should reach here -- `isAnswerableStepKey` has already sent that
    // run to the exit panel -- but silently emptying the batch would turn a
    // bug into a button that does nothing.
    const items = [{ stepKey: 'profile.name', value: 'David' }];
    expect(itemsFromCursor(items, 'profile.some_new_step')).toEqual(items);
  });

  it('drops everything when the whole screen is behind the cursor', () => {
    // Picked Other on WhatsApp, then picked a standard trade here.
    expect(answersForScreen('trade', filled, 'profile.custom_trade')).toEqual([]);
  });
});

describe('when Next is allowed', () => {
  it('gates About on both names and a resolved location', () => {
    expect(canContinue('about', emptyDraft, 'profile.name')).toBe(false);
    expect(canContinue('about', { ...emptyDraft, firstName: 'David', lastName: 'C' }, 'profile.name')).toBe(false);
    expect(canContinue('about', {
      ...emptyDraft, firstName: 'David', lastName: 'C',
      location: { text: '79901', city: null, state: null, zip: null },
    }, 'profile.name')).toBe(true);
  });

  it('gates the typed-in trade on the server\'s own 2..60, measured trimmed', () => {
    expect(MIN_CUSTOM_TRADE_CHARS).toBe(2);
    expect(MAX_CUSTOM_TRADE_CHARS).toBe(60);
    expect(customTradeAcceptable('w')).toBe(false);
    expect(customTradeAcceptable(' w ')).toBe(false);
    expect(customTradeAcceptable('  ')).toBe(false);
    expect(customTradeAcceptable('welder')).toBe(true);
    expect(customTradeAcceptable('x'.repeat(MAX_CUSTOM_TRADE_CHARS))).toBe(true);
    expect(customTradeAcceptable('x'.repeat(MAX_CUSTOM_TRADE_CHARS + 1))).toBe(false);
    // Trimmed, exactly as the API measures it.
    expect(customTradeAcceptable(` ${'x'.repeat(MAX_CUSTOM_TRADE_CHARS)} `)).toBe(true);

    // And Continue follows it, so a one-letter trade never reaches a 422.
    expect(canContinue('trade', { ...emptyDraft, trade: 'other', customTrade: 'w' }, 'profile.trade')).toBe(false);
    expect(canContinue('trade', { ...emptyDraft, trade: 'other', customTrade: 'welder' }, 'profile.trade')).toBe(true);
  });

  it('gates Trade on the free-text box when Other is picked', () => {
    expect(canContinue('trade', { ...emptyDraft, trade: 'other' }, 'profile.trade')).toBe(false);
    expect(canContinue('trade', { ...emptyDraft, trade: 'other', customTrade: 'welder' }, 'profile.trade')).toBe(true);
    expect(canContinue('trade', { ...emptyDraft, trade: 'plumber' }, 'profile.trade')).toBe(true);
  });

  it('gates Your work on all three answers, including a FALSE transportation', () => {
    expect(canContinue('work', { ...emptyDraft, experience: '0-1', availability: 'flexible' }, 'profile.experience')).toBe(false);
    expect(canContinue('work', {
      ...emptyDraft, experience: '0-1', availability: 'flexible', transportation: false,
    }, 'profile.experience')).toBe(true);
  });

  it('gates a question at 15 characters of real text', () => {
    expect(MIN_ANSWER_CHARS).toBe(15);
    expect(answerLongEnough('too short')).toBe(false);
    expect(answerLongEnough('               ')).toBe(false);
    expect(answerLongEnough('I frame houses.')).toBe(true);
    expect(canContinue('q1', { ...emptyDraft, answers: ['I frame houses.', '', ''] }, 'trust.question.1')).toBe(true);
    expect(canContinue('q3', { ...emptyDraft, answers: ['I frame houses.', '', ''] }, 'trust.question.3')).toBe(false);
  });

  it('mirrors the server ceiling too, so 2001 characters never reach a 422', () => {
    expect(MAX_ANSWER_CHARS).toBe(2000);
    const tooLong = 'x'.repeat(MAX_ANSWER_CHARS + 1);
    expect(answerTooLong(tooLong)).toBe(true);
    // Measured on the TRIMMED text, exactly as the API measures it.
    expect(answerTooLong(` ${'x'.repeat(MAX_ANSWER_CHARS)} `)).toBe(false);
    expect(canContinue('q1', { ...emptyDraft, answers: [tooLong, '', ''] }, 'trust.question.1')).toBe(false);
  });

  it('goes quiet when the screen has nothing the engine is still waiting for', () => {
    // Same case as the batch test above: a run on `profile.custom_trade` whose
    // worker switches to a standard trade can only be expressed by walking the
    // engine back, so Continue must not offer a save that posts nothing.
    const standard = { ...emptyDraft, trade: 'plumber' as const };
    expect(canContinue('trade', standard, 'profile.trade')).toBe(true);
    expect(canContinue('trade', standard, 'profile.custom_trade')).toBe(false);
    // Answering it as Other, which is what the engine is actually asking for,
    // turns it straight back on.
    expect(canContinue('trade', { ...emptyDraft, trade: 'other', customTrade: 'welder' }, 'profile.custom_trade')).toBe(true);
  });

  it('never blocks terms, photo or done', () => {
    expect(canContinue('terms', emptyDraft, 'legal.review')).toBe(true);
    expect(canContinue('photo', emptyDraft, 'trust.question.3')).toBe(true);
    expect(canContinue('done', emptyDraft, 'trust.question.3')).toBe(true);
  });
});

describe('draft hydration from the server', () => {
  it('rebuilds every field a resumed run already knows', () => {
    const draft = draftFromState(state({
      profile: {
        fullName: 'David Castellanos',
        location: { city: 'San Antonio', state: 'Texas', zip: null },
        trade: { key: 'carpenter', other: null },
        yearsExperience: '2-4',
        hasTransportation: true,
        availability: 'full_time',
      },
      trust: {
        questions: [{ index: 1, q_en: 'What?', q_es: '¿Qué?' }],
        answers: [{ index: 1, text: 'I frame houses all day', source: 'voice' }],
      },
    }));
    expect(draft.firstName).toBe('David');
    expect(draft.lastName).toBe('Castellanos');
    expect(draft.location.text).toBe('San Antonio, Texas');
    expect(draft.trade).toBe('carpenter');
    expect(draft.experience).toBe('2-4');
    expect(draft.transportation).toBe(true);
    expect(draft.availability).toBe('full_time');
    expect(draft.answers).toEqual(['I frame houses all day', '', '']);
  });

  it('drops values outside the shared vocabulary rather than trusting them', () => {
    const draft = draftFromState(state({
      profile: {
        fullName: null, location: null,
        trade: { key: 'astronaut', other: null },
        yearsExperience: '25-30', hasTransportation: null, availability: 'sometimes',
      },
    }));
    expect(draft.trade).toBeNull();
    expect(draft.experience).toBeNull();
    expect(draft.availability).toBeNull();
  });

  it('reads a question in the active locale', () => {
    const s = state({ trust: { questions: [{ index: 2, q_en: 'What tools?', q_es: '¿Qué herramientas?' }], answers: [] } });
    expect(questionText(s, 2, 'en')).toBe('What tools?');
    expect(questionText(s, 2, 'es')).toBe('¿Qué herramientas?');
    expect(questionText(s, 3, 'en')).toBe('');
  });
});

describe('reducer', () => {
  it('starts on the screen the server says, with the server draft', () => {
    const flow = initFlowState(state({ run: { ...state().run, stepKey: 'trust.question.2' } }));
    expect(currentScreen(flow)).toBe('q2');
    expect(flow.saving).toBe(false);
    expect(flow.photoPending).toBe(false);
  });

  it('hydrate advances the screen, refreshes the lock and rebuilds the draft', () => {
    let flow = initFlowState(state());
    flow = onboardingFlowReducer(flow, { type: 'set_draft', patch: { firstName: 'Stale' } });
    flow = onboardingFlowReducer(flow, {
      type: 'hydrate',
      server: state({
        run: { ...state().run, stepKey: 'profile.trade', lockVersion: 4 },
        profile: { ...state().profile, fullName: 'David Castellanos' },
      }),
    });
    expect(currentScreen(flow)).toBe('trade');
    expect(flow.server.run.lockVersion).toBe(4);
    expect(flow.draft.firstName).toBe('David');
  });

  it('sync_server refreshes the lock WITHOUT wiping what the worker is typing', () => {
    let flow = initFlowState(state({ run: { ...state().run, stepKey: 'profile.name' } }));
    flow = onboardingFlowReducer(flow, { type: 'set_draft', patch: { firstName: 'David', lastName: 'C' } });
    flow = onboardingFlowReducer(flow, {
      type: 'sync_server',
      server: state({ run: { ...state().run, stepKey: 'profile.name', lockVersion: 9 } }),
    });
    expect(flow.server.run.lockVersion).toBe(9);
    expect(flow.draft.firstName).toBe('David');
    expect(flow.draft.lastName).toBe('C');
  });

  it('carries a notice on a sync, and typing does not dismiss it', () => {
    // The notice says "the run moved, check this step". Checking the step IS
    // typing in it, so an edit must not wipe the explanation for why the
    // screen changed under them.
    let flow = initFlowState(state({ run: { ...state().run, stepKey: 'profile.name' } }));
    flow = onboardingFlowReducer(flow, { type: 'set_draft', patch: { firstName: 'David' } });
    flow = onboardingFlowReducer(flow, {
      type: 'step_mismatch', server: state(), sameScreen: true,
    });
    expect(flow.notice).toBe('step_mismatch');
    expect(flow.draft.firstName).toBe('David');
    // And the save is OVER: the button must not stay in its loading state.
    expect(flow.saving).toBe(false);

    flow = onboardingFlowReducer(flow, { type: 'set_draft', patch: { lastName: 'C' } });
    expect(flow.notice).toBe('step_mismatch');

    // The next save is the worker responding to it: from there it is stale.
    flow = onboardingFlowReducer(flow, { type: 'saving' });
    expect(flow.notice).toBeNull();
  });

  it('leaves a standing notice alone when a poll lands', () => {
    let flow = initFlowState(state());
    flow = onboardingFlowReducer(flow, { type: 'step_mismatch', server: state(), sameScreen: true });
    flow = onboardingFlowReducer(flow, { type: 'sync_server', server: state() });
    expect(flow.notice).toBe('step_mismatch');
  });

  it('rebuilds the draft on a mismatch that moved the worker to another screen', () => {
    let flow = initFlowState(state({ run: { ...state().run, stepKey: 'profile.name' } }));
    flow = onboardingFlowReducer(flow, { type: 'set_draft', patch: { firstName: 'David' } });
    flow = onboardingFlowReducer(flow, {
      type: 'step_mismatch',
      server: state({ run: { ...state().run, stepKey: 'profile.trade' } }),
      sameScreen: false,
    });
    expect(flow.draft.firstName).toBe('');
    expect(flow.notice).toBe('step_mismatch');
  });

  it('counts consecutive failures and forgets them the moment a save lands', () => {
    let flow = initFlowState(state());
    expect(flow.failures).toBe(0);
    flow = onboardingFlowReducer(flow, { type: 'save_failed', errorKind: 'offline' });
    expect(flow.failures).toBe(1);
    flow = onboardingFlowReducer(flow, { type: 'save_failed', errorKind: 'offline' });
    expect(flow.failures).toBe(2);

    flow = onboardingFlowReducer(flow, { type: 'hydrate', server: state() });
    expect(flow.failures).toBe(0);
  });

  it('does not count a rejection as a failure — the engine answered', () => {
    let flow = initFlowState(state());
    flow = onboardingFlowReducer(flow, { type: 'save_failed', errorKind: 'offline' });
    flow = onboardingFlowReducer(flow, {
      type: 'step_rejected', stepKey: 'profile.location', reason: 'unknown_city', server: state(),
    });
    expect(flow.failures).toBe(0);
  });

  it('records a rejection against its own step and clears it on the next edit', () => {
    let flow = initFlowState(state());
    flow = onboardingFlowReducer(flow, { type: 'saving' });
    flow = onboardingFlowReducer(flow, {
      type: 'step_rejected', stepKey: 'profile.location', reason: 'unknown_city', server: state(),
    });
    expect(flow.saving).toBe(false);
    expect(flow.rejection).toEqual({ stepKey: 'profile.location', reason: 'unknown_city' });
    flow = onboardingFlowReducer(flow, { type: 'set_draft', patch: { firstName: 'D' } });
    expect(flow.rejection).toBeNull();
  });

  it('offers the photo prompt once when the last answer completes the run', () => {
    let flow = initFlowState(state({ run: { ...state().run, stepKey: 'trust.question.3' } }));
    flow = onboardingFlowReducer(flow, { type: 'finished', server: state({ lifecycle: 'ready' }) });
    expect(flow.photoPending).toBe(true);
    expect(currentScreen(flow)).toBe('photo');

    flow = onboardingFlowReducer(flow, { type: 'photo_skipped' });
    expect(currentScreen(flow)).toBe('done');
  });

  it('does not re-offer the photo prompt when a finished run is reloaded', () => {
    const flow = initFlowState(state({ lifecycle: 'ready' }));
    expect(flow.photoPending).toBe(false);
    expect(currentScreen(flow)).toBe('done');
  });

  it('stops the flow for a worker the engine will not onboard', () => {
    let flow = initFlowState(state());
    expect(flow.blocked).toBeNull();
    flow = onboardingFlowReducer(flow, { type: 'blocked', reason: 'not_onboardable' });
    expect(flow.blocked).toBe('not_onboardable');
    expect(flow.saving).toBe(false);
  });

  it('treats a suspended lifecycle as blocked from the very first render', () => {
    expect(initFlowState(state({ lifecycle: 'suspended' })).blocked).toBe('suspended');
  });

  it('surfaces a generic failure as an error kind, not a raw message', () => {
    let flow = initFlowState(state());
    flow = onboardingFlowReducer(flow, { type: 'save_failed', errorKind: 'offline' });
    expect(flow.errorKind).toBe('offline');
    expect(flow.saving).toBe(false);
    flow = onboardingFlowReducer(flow, { type: 'clear_error' });
    expect(flow.errorKind).toBeNull();
  });
});
