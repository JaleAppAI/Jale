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
// 2. `hydrate` vs `syncServer`. Both replace the server snapshot (the
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

/** Below this, "Next" stays disabled. Matches the WhatsApp engine's floor. */
export const MIN_ANSWER_CHARS = 15;

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
 *   profile.voice_*        — WhatsApp-only voice intake; `about` is the first
 *                            screen that can supply the data it collects.
 *   profile.photo_type     — a sub-step of the photo prompt.
 */
export const STEP_SCREEN: Readonly<Record<string, ScreenKey>> = {
  'start.choose_language': 'terms',
  'identity.verify_otp': 'terms',
  'legal.review': 'terms',
  'profile.voice_choice': 'about',
  'profile.voice_processing': 'about',
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
  'profile.photo': 'photo',
  'profile.photo_type': 'photo',
};

/** Unknown keys (a workflow version we predate) land on the first screen. */
export function screenForStepKey(stepKey: string): ScreenKey {
  return STEP_SCREEN[stepKey] ?? 'terms';
}

/**
 * Where a run stands. `lifecycle === 'ready'` wins over any step key: it is the
 * engine saying onboarding is over, whatever cursor it left behind.
 */
export function screenForState(state: OnboardingState, completed = false): ScreenKey {
  if (completed) return 'done';
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

export function answersForScreen(screen: ScreenKey, draft: OnboardingDraft): OnboardingAnswerItem[] {
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
      // v1 is skip-only — see `PhotoStep`.
      return [{ stepKey: 'profile.photo', value: { skip: true } }];
    case 'done':
      return [];
  }
}

/** The location-confirm prompt owns its own Yes/No buttons, not the Next button. */
export function locationConfirmAnswer(accept: boolean): OnboardingAnswerItem[] {
  return [{ stepKey: 'profile.location', value: { kind: 'confirm', accept } }];
}

export function answerLongEnough(text: string): boolean {
  return text.trim().length >= MIN_ANSWER_CHARS;
}

export function canContinue(screen: ScreenKey, draft: OnboardingDraft): boolean {
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
      return draft.trade !== null && (draft.trade !== 'other' || draft.customTrade.trim().length > 0);
    case 'work':
      return draft.experience !== null && draft.transportation !== null && draft.availability !== null;
    case 'q1':
    case 'q2':
    case 'q3': {
      const index = trustQuestionIndex(screen);
      return index !== null && answerLongEnough(draft.answers[index - 1]);
    }
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type OnboardingFlowState = {
  server: OnboardingState;
  draft: OnboardingDraft;
  /** Set once `profile.photo` is accepted: Done renders even while the run's own lifecycle lags. */
  completed: boolean;
  /**
   * "Improve my answers" re-enters the three questions from the Done screen.
   * A local sub-mode, not a server rewind: the run has already moved past
   * them, so Next/Back here walk q1→q2→q3→done without touching `/back`.
   */
  improving: TrustScreen | null;
  saving: boolean;
  /** 422: shown against the field that owns `stepKey`. */
  rejection: { stepKey: string; reason: string } | null;
  /** Anything else that failed — rendered as one translated sentence. */
  errorKind: ErrorKind | null;
};

export type OnboardingFlowAction =
  | { type: 'hydrate'; server: OnboardingState }
  | { type: 'sync_server'; server: OnboardingState }
  | { type: 'set_draft'; patch: Partial<OnboardingDraft> }
  | { type: 'set_answer'; index: 1 | 2 | 3; text: string }
  | { type: 'saving' }
  | { type: 'save_failed'; errorKind: ErrorKind }
  | { type: 'step_rejected'; stepKey: string; reason: string; server: OnboardingState }
  | { type: 'completed'; server: OnboardingState }
  | { type: 'improve_start' }
  | { type: 'improve_next' }
  | { type: 'improve_back' }
  | { type: 'clear_error' };

export function initFlowState(server: OnboardingState): OnboardingFlowState {
  return {
    server,
    draft: draftFromState(server),
    completed: false,
    improving: null,
    saving: false,
    rejection: null,
    errorKind: null,
  };
}

/** The one place that answers "which screen is on screen right now". */
export function currentScreen(state: OnboardingFlowState): ScreenKey {
  return state.improving ?? screenForState(state.server, state.completed);
}

const IMPROVE_ORDER = TRUST_SCREENS;

function nextImprove(screen: TrustScreen): TrustScreen | null {
  const i = IMPROVE_ORDER.indexOf(screen);
  return i >= 0 && i + 1 < IMPROVE_ORDER.length ? IMPROVE_ORDER[i + 1] : null;
}

function previousImprove(screen: TrustScreen): TrustScreen | null {
  const i = IMPROVE_ORDER.indexOf(screen);
  return i > 0 ? IMPROVE_ORDER[i - 1] : null;
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
        saving: false,
        rejection: null,
        errorKind: null,
      };
    case 'sync_server':
      // Draft untouched on purpose — see this file's header.
      return { ...state, server: action.server };
    case 'set_draft':
      return { ...state, draft: { ...state.draft, ...action.patch }, rejection: null, errorKind: null };
    case 'set_answer': {
      const answers: [string, string, string] = [...state.draft.answers];
      answers[action.index - 1] = action.text;
      return { ...state, draft: { ...state.draft, answers }, rejection: null, errorKind: null };
    }
    case 'saving':
      return { ...state, saving: true, rejection: null, errorKind: null };
    case 'save_failed':
      return { ...state, saving: false, errorKind: action.errorKind };
    case 'step_rejected':
      return {
        ...state,
        server: action.server,
        saving: false,
        rejection: { stepKey: action.stepKey, reason: action.reason },
        errorKind: null,
      };
    case 'completed':
      return {
        ...state,
        server: action.server,
        draft: draftFromState(action.server),
        completed: true,
        improving: null,
        saving: false,
        rejection: null,
        errorKind: null,
      };
    case 'improve_start':
      return { ...state, improving: 'q1', rejection: null, errorKind: null };
    case 'improve_next':
      return state.improving
        ? { ...state, improving: nextImprove(state.improving), saving: false, rejection: null, errorKind: null }
        : state;
    case 'improve_back':
      return state.improving
        ? { ...state, improving: previousImprove(state.improving), rejection: null, errorKind: null }
        : state;
    case 'clear_error':
      return { ...state, rejection: null, errorKind: null };
  }
}
