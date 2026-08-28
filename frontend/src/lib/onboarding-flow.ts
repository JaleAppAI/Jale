// ---------------------------------------------------------------------------
// Web worker onboarding — pure flow model.
//
// Everything here is framework-free and side-effect-free: the screen the worker
// should be looking at, the draft they are typing into, what a screen posts,
// and whether its Next button is allowed to be pressed. `OnboardingFlow.tsx`
// owns the network and the rendering; this file owns the rules, so they can be
// exercised without a DOM.
//
// TWO IDEAS DO THE HEAVY LIFTING:
//
// 1. The SERVER decides where we are. `run.stepKey` is the engine's cursor and
//    the UI maps it onto a screen — that is what makes "resume": a worker who
//    answered two questions on WhatsApp opens the web and lands on question 3
//    with no client-side memory involved at all.
//
// 2. THE PHOTO SCREEN IS NOT AN ENGINE STEP. The state machine completes on
//    the third trust answer (that response already carries
//    `lifecycle: 'ready'`), and `profile.photo*` is a step key no handler can
//    advance -- the API answers 422 `unknown_step` for it. So the photo prompt
//    is shown once, client-side, out of `photoPending`, and skipping it is a
//    local transition with no request behind it.
//
// 3. A BATCH IS A CONTIGUOUS RUN FORWARD FROM THE CURSOR. The engine applies
//    the items in order and refuses any whose `stepKey` is not the step it is
//    on at that moment (422 `step_mismatch`) -- it does NOT skip items behind
//    itself. A screen that covers three steps therefore posts only the ones at
//    or after `run.stepKey`: a worker resuming at `profile.availability` sends
//    availability alone, not the two answers the engine already has.
//
// 4. `hydrate` vs `syncServer`. Both replace the server snapshot (the
//    `lockVersion` advances on EVERY mutation, including `back` and the
//    language PATCH, so a stale one 409s the next write). Only `hydrate`
//    rebuilds the draft from it. A 409 refetch uses `syncServer` precisely
//    because the retry is about to re-post the draft the worker just typed —
//    rebuilding it from a snapshot that predates their edit would wipe it.
// ---------------------------------------------------------------------------

import type {
  OnboardingAnswerItem,
  OnboardingState,
} from './api/worker';
import type { ErrorKind } from './api/errors';
import {
  isAvailabilityKey,
  isExperienceKey,
  isTradeKey,
  type AvailabilityKey,
  type ExperienceKey,
  type TradeKey,
} from './worker-vocab';

export type ScreenKey = 'terms' | 'about' | 'trade' | 'work' | 'q1' | 'q2' | 'q3' | 'photo' | 'done';

/**
 * The eight progress segments, in order. `done` is deliberately absent: the
 * bar is a measure of what is LEFT, and on the summary screen nothing is.
 */
export const PROGRESS_SEGMENTS = ['terms', 'about', 'trade', 'work', 'q1', 'q2', 'q3', 'photo'] as const;
export type ProgressSegment = (typeof PROGRESS_SEGMENTS)[number];

/** The three segments painted teal rather than blue — the answers employers read. */
export const TRUST_SCREENS = ['q1', 'q2', 'q3'] as const;
export type TrustScreen = (typeof TRUST_SCREENS)[number];

export function isTrustScreen(screen: ScreenKey): screen is TrustScreen {
  return (TRUST_SCREENS as readonly string[]).includes(screen);
}

/**
 * The server's own bounds for a trust answer, mirrored client-side so the
 * worker is stopped by a disabled button and a sentence rather than by a 422.
 * Both are measured on the TRIMMED text, exactly as the API measures them.
 */
export const MIN_ANSWER_CHARS = 15;
export const MAX_ANSWER_CHARS = 2000;

/**
 * The server's bounds for a typed-in trade, mirrored for the same reason:
 * `profile.custom_trade` is validated (trimmed, 2..60, no control characters)
 * and answers 422 `step_rejected` with `too_short`, `too_long` or `invalid`.
 *
 * Only the LENGTH is mirrored. "No control characters" is not a rule a worker
 * can break by typing into a single-line box, and guessing at the server's
 * exact character class here would either reject something it accepts or
 * promise something it does not -- so `invalid` stays a server verdict with a
 * sentence of its own.
 */
export const MIN_CUSTOM_TRADE_CHARS = 2;
export const MAX_CUSTOM_TRADE_CHARS = 60;

/** Measured on the trimmed text, exactly as the API measures it. */
export function customTradeAcceptable(text: string): boolean {
  const length = text.trim().length;
  return length >= MIN_CUSTOM_TRADE_CHARS && length <= MAX_CUSTOM_TRADE_CHARS;
}

/**
 * EVERY engine step key IN THE ORDER THE ENGINE WALKS THEM.
 *
 * Separate from `STEP_SCREEN` on purpose, and longer than it: this list has to
 * include the steps this door cannot ANSWER (the voice pair) because it exists
 * to answer a different question -- "is this item behind the cursor?" -- and a
 * gap in it would mis-sort every item after the gap.
 *
 * The order is the engine's, not the screens': `profile.custom_trade` sits
 * straight after `profile.trade` because that is where the engine goes when
 * the answer is `other`, even though both belong to one screen here.
 */
export const ENGINE_STEP_ORDER = [
  'start.choose_language',
  'identity.verify_otp',
  'legal.review',
  'profile.voice_choice',
  'profile.voice_processing',
  'profile.name',
  'profile.location',
  'profile.trade',
  'profile.custom_trade',
  'profile.experience',
  'profile.transportation',
  'profile.availability',
  'trust.question.1',
  'trust.question.2',
  'trust.question.3',
] as const;

/** Position in the engine's walk, or -1 for a key we do not know. */
export function engineStepIndex(stepKey: string): number {
  return (ENGINE_STEP_ORDER as readonly string[]).indexOf(stepKey);
}

/**
 * Drop the items the engine is already past.
 *
 * The engine applies a batch in order and refuses any item that is not the
 * step it is currently on, so an item BEHIND the cursor does not get skipped
 * -- it fails the whole save with `step_mismatch`. A worker who answered name
 * and location on WhatsApp and opens the web at `profile.location` must send
 * the location alone.
 *
 * An unknown cursor returns the items untouched: we cannot say what is behind
 * a step we have never heard of, and `OnboardingFlow` has already refused to
 * render a screen for it (`isAnswerableStepKey`), so nothing reaches here.
 */
export function itemsFromCursor(items: OnboardingAnswerItem[], stepKey: string): OnboardingAnswerItem[] {
  const cursor = engineStepIndex(stepKey);
  if (cursor < 0) return items;
  return items.filter((item) => engineStepIndex(item.stepKey) >= cursor);
}

/**
 * EVERY engine step key, mapped onto the screen that can answer it.
 *
 * A flat table on purpose. Inferring a screen from how much profile data is
 * filled in reads cleverer and is worse: an unmappable step would still come
 * back unmapped after the post it triggered was rejected, so the inference
 * only changes WHICH wrong screen the worker is stuck on.
 *
 *   start.choose_language  — the web door never shows it (language is a header
 *                            toggle, not a step), so send it to the first screen.
 *   identity.verify_otp    — already done by `WorkerAuthForm` before we mount.
 *
 * THREE FAMILIES OF KEY ARE DELIBERATELY ABSENT, and absence is what drives
 * the exit panel (`isAnswerableStepKey`):
 *
 *   profile.voice_choice / profile.voice_processing — WhatsApp-only voice
 *     intake. `about` used to be mapped here, and that was wrong under the
 *     batch contract: the engine is waiting for a voice decision, so About's
 *     `profile.name` is a step it is not on and the whole batch 422s. A run
 *     mid-voice-intake has to finish that step on WhatsApp.
 *   profile.photo / profile.photo_type — dead keys; no handler advances them
 *     and the API answers `unknown_step`.
 *   anything a later workflow version invents.
 */
export const STEP_SCREEN: Readonly<Record<string, ScreenKey>> = {
  'start.choose_language': 'terms',
  'identity.verify_otp': 'terms',
  'legal.review': 'terms',
  'profile.name': 'about',
  'profile.location': 'about',
  'profile.trade': 'trade',
  'profile.custom_trade': 'trade',
  'profile.experience': 'work',
  'profile.transportation': 'work',
  'profile.availability': 'work',
  'trust.question.1': 'q1',
  'trust.question.2': 'q2',
  'trust.question.3': 'q3',
};

/**
 * Whether this flow can actually ANSWER the step the run is parked on.
 *
 * False for the two dead photo keys and for any key a later workflow version
 * invents. It matters because the fallback below is a total function — it has
 * to return something — and a screen whose Continue posts a step the engine
 * will refuse is a dead end with one button on it. `OnboardingFlow` checks
 * this first and shows a way OUT instead.
 */
export function isAnswerableStepKey(stepKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(STEP_SCREEN, stepKey);
}

/** Unknown keys (a workflow version we predate) land on the first screen. */
export function screenForStepKey(stepKey: string): ScreenKey {
  return STEP_SCREEN[stepKey] ?? 'terms';
}

/**
 * Where a run stands. `lifecycle === 'ready'` wins over any step key: it is the
 * engine saying onboarding is over, whatever cursor it left behind — and it is
 * what the third trust answer's own response comes back with.
 *
 * A finished run therefore resumes straight to the summary. The photo prompt
 * is not re-offered on a reload: it is optional, it was already declined or
 * shown once, and asking again would just be nagging.
 */
export function screenForState(state: OnboardingState): ScreenKey {
  if (state.lifecycle === 'ready') return 'done';
  return screenForStepKey(state.run.stepKey);
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

/**
 * What the location field holds. `text` is what is in the box; `city`/`state`/
 * `zip` are only set once a suggestion was actually chosen, which is what
 * separates "typed three letters" from "picked El Paso".
 */
export type LocationDraft = {
  text: string;
  city: string | null;
  state: string | null;
  zip: string | null;
};

export const EMPTY_LOCATION_DRAFT: LocationDraft = { text: '', city: null, state: null, zip: null };

export type OnboardingDraft = {
  firstName: string;
  lastName: string;
  location: LocationDraft;
  trade: TradeKey | null;
  customTrade: string;
  experience: ExperienceKey | null;
  transportation: boolean | null;
  availability: AvailabilityKey | null;
  /** Indexed 0..2 for questions 1..3. */
  answers: [string, string, string];
};

const ZIP = /^\d{5}$/;

/**
 * One space, and only one: the two name fields are joined for `profile.name`
 * and split back apart on resume. A worker whose stored name is a single word
 * gets it in the first field and an empty surname, never a stray space.
 */
export function joinName(firstName: string, lastName: string): string {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(' ');
}

export function splitFullName(fullName: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  // Everything after the first token is the surname: "Ana Maria de la Cruz"
  // must survive a round trip, and only the FIRST space is a field boundary.
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function locationLabel(location: OnboardingState['profile']['location']): string {
  if (!location) return '';
  if (location.city && location.state) return `${location.city}, ${location.state}`;
  return location.zip ?? '';
}

export function draftFromState(state: OnboardingState): OnboardingDraft {
  const { firstName, lastName } = splitFullName(state.profile.fullName);
  const answers: [string, string, string] = ['', '', ''];
  for (const answer of state.trust.answers) {
    if (answer.index >= 1 && answer.index <= 3) answers[answer.index - 1] = answer.text;
  }
  const tradeKey = state.profile.trade?.key;
  return {
    firstName,
    lastName,
    location: {
      text: locationLabel(state.profile.location),
      city: state.profile.location?.city ?? null,
      state: state.profile.location?.state ?? null,
      zip: state.profile.location?.zip ?? null,
    },
    trade: isTradeKey(tradeKey) ? tradeKey : null,
    customTrade: state.profile.trade?.other ?? '',
    experience: isExperienceKey(state.profile.yearsExperience) ? state.profile.yearsExperience : null,
    transportation: state.profile.hasTransportation,
    availability: isAvailabilityKey(state.profile.availability) ? state.profile.availability : null,
    answers,
  };
}

export type LocationStepValue =
  | { kind: 'zip'; zip: string }
  | { kind: 'city_state'; city: string; state: string };

/**
 * A chosen city+state beats a typed ZIP: it is the richer of the two and the
 * dataset hands both back when a ZIP query is used to pick a place. A bare
 * 5-digit box the worker never picked from is still accepted as a ZIP — that
 * is the shortcut the copy promises.
 */
export function locationStepValue(location: LocationDraft): LocationStepValue | null {
  if (location.city && location.state) {
    return { kind: 'city_state', city: location.city, state: location.state };
  }
  const typed = location.text.trim();
  if (ZIP.test(typed)) return { kind: 'zip', zip: typed };
  if (location.zip && ZIP.test(location.zip)) return { kind: 'zip', zip: location.zip };
  return null;
}

/** True when the resolved value is a ZIP — drives the chip's "· ZIP" suffix. */
export function isZipLocation(location: LocationDraft): boolean {
  return locationStepValue(location)?.kind === 'zip';
}

export function trustQuestionIndex(screen: ScreenKey): 1 | 2 | 3 | null {
  if (screen === 'q1') return 1;
  if (screen === 'q2') return 2;
  if (screen === 'q3') return 3;
  return null;
}

export function questionText(state: OnboardingState, index: number, locale: string): string {
  const question = state.trust.questions.find((q) => q.index === index);
  if (!question) return '';
  return locale === 'es' ? question.q_es : question.q_en;
}

// ---------------------------------------------------------------------------
// What a screen posts, and whether it may
// ---------------------------------------------------------------------------

/** What a screen hands to the flow when its CTA is pressed. */
export type OnboardingAnswerBatch = OnboardingAnswerItem[];

/**
 * What this screen would post from a standing start, before the cursor has its
 * say. Private: every caller wants the filtered version below.
 */
function fullBatchForScreen(screen: ScreenKey, draft: OnboardingDraft): OnboardingAnswerItem[] {
  switch (screen) {
    case 'terms':
      return [{ stepKey: 'legal.review', value: 'accept' }];
    case 'about': {
      const location = locationStepValue(draft.location);
      return [
        { stepKey: 'profile.name', value: joinName(draft.firstName, draft.lastName) },
        ...(location ? [{ stepKey: 'profile.location', value: location }] : []),
      ];
    }
    case 'trade':
      return draft.trade === 'other'
        ? [
            { stepKey: 'profile.trade', value: 'other' },
            { stepKey: 'profile.custom_trade', value: draft.customTrade.trim() },
          ]
        : draft.trade
          ? [{ stepKey: 'profile.trade', value: draft.trade }]
          : [];
    case 'work':
      return [
        { stepKey: 'profile.experience', value: draft.experience },
        { stepKey: 'profile.transportation', value: draft.transportation },
        { stepKey: 'profile.availability', value: draft.availability },
      ];
    case 'q1':
    case 'q2':
    case 'q3': {
      const index = trustQuestionIndex(screen);
      return index === null
        ? []
        : [{ stepKey: `trust.question.${index}`, value: { text: draft.answers[index - 1].trim() } }];
    }
    case 'photo':
    case 'done':
      // Neither screen answers an engine step: the run is already complete by
      // the time either is on screen, and `profile.photo` is not a step the
      // API accepts. See this file's header.
      return [];
  }
}

/**
 * What this screen actually posts, given where the engine's cursor is.
 *
 * The screens are wider than the engine's steps -- "Your work" asks three
 * questions the engine asks in three turns -- so a resumed run routinely lands
 * a worker on a screen whose first step or two the engine already has. Those
 * items are dropped rather than re-sent: see `itemsFromCursor`.
 */
export function answersForScreen(
  screen: ScreenKey,
  draft: OnboardingDraft,
  stepKey: string,
): OnboardingAnswerItem[] {
  return itemsFromCursor(fullBatchForScreen(screen, draft), stepKey);
}

/** The location-confirm prompt owns its own Yes/No buttons, not the Next button. */
export function locationConfirmAnswer(accept: boolean): OnboardingAnswerItem[] {
  return [{ stepKey: 'profile.location', value: { kind: 'confirm', accept } }];
}

export function answerLongEnough(text: string): boolean {
  return text.trim().length >= MIN_ANSWER_CHARS;
}

export function answerTooLong(text: string): boolean {
  return text.trim().length > MAX_ANSWER_CHARS;
}

/** Both bounds at once — what the Next button on a question screen turns on. */
export function answerAcceptable(text: string): boolean {
  return answerLongEnough(text) && !answerTooLong(text);
}

/**
 * Whether the worker has filled in enough of THIS screen. Says nothing about
 * where the engine is -- `canContinue` adds that.
 */
function draftComplete(screen: ScreenKey, draft: OnboardingDraft): boolean {
  switch (screen) {
    case 'terms':
    case 'photo':
    case 'done':
      return true;
    case 'about':
      return Boolean(draft.firstName.trim())
        && Boolean(draft.lastName.trim())
        && locationStepValue(draft.location) !== null;
    case 'trade':
      return draft.trade !== null && (draft.trade !== 'other' || customTradeAcceptable(draft.customTrade));
    case 'work':
      return draft.experience !== null && draft.transportation !== null && draft.availability !== null;
    case 'q1':
    case 'q2':
    case 'q3': {
      const index = trustQuestionIndex(screen);
      return index !== null && answerAcceptable(draft.answers[index - 1]);
    }
  }
}

/**
 * Whether Continue may be pressed: the screen is filled in AND it has
 * something the engine is actually waiting for.
 *
 * The second half only ever bites in one place. A run parked on
 * `profile.custom_trade` (they answered "Other" on WhatsApp) whose worker then
 * picks a standard trade here produces a batch of one `profile.trade` item --
 * behind the cursor, so filtered to nothing. Posting an empty batch would be a
 * Continue that does nothing at all; the honest control is the Back button
 * already on that screen, which walks the engine off `custom_trade` and lets
 * the trade be re-picked for real.
 */
export function canContinue(screen: ScreenKey, draft: OnboardingDraft, stepKey: string): boolean {
  if (!draftComplete(screen, draft)) return false;
  if (screen === 'photo' || screen === 'done') return true;
  return answersForScreen(screen, draft, stepKey).length > 0;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type OnboardingBlock = 'suspended' | 'not_onboardable';

export type OnboardingFlowState = {
  server: OnboardingState;
  draft: OnboardingDraft;
  /**
   * The photo prompt is waiting to be shown. Set only by `finished` — the
   * third trust answer's response — and cleared by skipping it, so it appears
   * exactly once per completion and never on a reload of a finished run.
   */
  photoPending: boolean;
  /** The engine refuses to onboard this worker at all; the flow stops. */
  blocked: OnboardingBlock | null;
  saving: boolean;
  /** 422 `step_rejected`: shown against the field that owns `stepKey`. */
  rejection: { stepKey: string; reason: string } | null;
  /** Anything else that failed — rendered as one translated sentence. */
  errorKind: ErrorKind | null;
  /**
   * Consecutive failed saves. Two in a row is the flow admitting it may not be
   * a blip: the exit appears beside the retry, because everything answered so
   * far is already on the server.
   */
  failures: number;
  /**
   * A standing message that is not an error: the run moved underneath us and
   * the worker is now looking at a screen they did not ask for. It outlives
   * typing (checking the step IS the response to it) and clears on the next
   * save.
   */
  notice: OnboardingNotice | null;
};

/** Non-error messages the flow can be showing. */
export type OnboardingNotice = 'step_mismatch';

export type OnboardingFlowAction =
  | { type: 'hydrate'; server: OnboardingState }
  | { type: 'sync_server'; server: OnboardingState }
  /**
   * The engine was somewhere else by the time our save landed. `sameScreen`
   * decides the draft's fate, and it is the caller's to compute because only
   * it knows which screen was on the page.
   */
  | { type: 'step_mismatch'; server: OnboardingState; sameScreen: boolean }
  /** The last question landed and the run completed: offer the photo prompt. */
  | { type: 'finished'; server: OnboardingState }
  | { type: 'photo_skipped' }
  | { type: 'set_draft'; patch: Partial<OnboardingDraft> }
  | { type: 'set_answer'; index: 1 | 2 | 3; text: string }
  | { type: 'saving' }
  | { type: 'save_failed'; errorKind: ErrorKind }
  | { type: 'step_rejected'; stepKey: string; reason: string; server: OnboardingState }
  | { type: 'blocked'; reason: OnboardingBlock }
  | { type: 'clear_error' };

export function initFlowState(server: OnboardingState): OnboardingFlowState {
  return {
    server,
    draft: draftFromState(server),
    photoPending: false,
    blocked: server.lifecycle === 'suspended' ? 'suspended' : null,
    saving: false,
    rejection: null,
    errorKind: null,
    failures: 0,
    notice: null,
  };
}

/** The one place that answers "which screen is on screen right now". */
export function currentScreen(state: OnboardingFlowState): ScreenKey {
  if (state.photoPending) return 'photo';
  return screenForState(state.server);
}

export function onboardingFlowReducer(
  state: OnboardingFlowState,
  action: OnboardingFlowAction,
): OnboardingFlowState {
  switch (action.type) {
    case 'hydrate':
      return {
        ...state,
        server: action.server,
        draft: draftFromState(action.server),
        blocked: action.server.lifecycle === 'suspended' ? 'suspended' : state.blocked,
        saving: false,
        rejection: null,
        errorKind: null,
        failures: 0,
        notice: null,
      };
    case 'sync_server':
      // Draft untouched on purpose — see this file's header. So is `saving`:
      // the 409 retry lands here mid-flight and is about to post again, and
      // re-enabling the button under a worker's finger would let them send the
      // same answer twice.
      return { ...state, server: action.server };
    case 'step_mismatch':
      return {
        ...state,
        server: action.server,
        // Rebuilding the draft when the screen has NOT changed would delete
        // the worker's half-typed answer in front of them, to replace it with
        // a snapshot that does not have it. Only a move to another screen
        // makes the draft stale.
        draft: action.sameScreen ? state.draft : draftFromState(action.server),
        saving: false,
        rejection: null,
        errorKind: null,
        failures: 0,
        notice: 'step_mismatch',
      };
    case 'finished':
      return {
        ...state,
        server: action.server,
        draft: draftFromState(action.server),
        photoPending: true,
        saving: false,
        rejection: null,
        errorKind: null,
        failures: 0,
        notice: null,
      };
    case 'photo_skipped':
      return { ...state, photoPending: false };
    case 'set_draft':
      return { ...state, draft: { ...state.draft, ...action.patch }, rejection: null, errorKind: null };
    case 'set_answer': {
      const answers: [string, string, string] = [...state.draft.answers];
      answers[action.index - 1] = action.text;
      return { ...state, draft: { ...state.draft, answers }, rejection: null, errorKind: null };
    }
    case 'saving':
      return { ...state, saving: true, rejection: null, errorKind: null, notice: null };
    case 'save_failed':
      return { ...state, saving: false, errorKind: action.errorKind, failures: state.failures + 1 };
    case 'step_rejected':
      return {
        ...state,
        server: action.server,
        saving: false,
        rejection: { stepKey: action.stepKey, reason: action.reason },
        errorKind: null,
        // The engine answered, so the connection is fine: this is not the
        // kind of failure the exit is for.
        failures: 0,
      };
    case 'blocked':
      return { ...state, saving: false, blocked: action.reason };
    case 'clear_error':
      return { ...state, rejection: null, errorKind: null, failures: 0 };
  }
}
