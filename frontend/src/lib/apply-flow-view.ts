// Pure state machine backing STAGE 1 -- the whole of applying, as of sprint
// 23.
//
// Applying is now one screen and one payload: the employer's
// `pre_application_prompts` and nothing else. So this module shrank to what
// that screen actually needs -- the answers the worker is typing, and which
// of them they have touched.
//
// EVERYTHING ELSE MOVED. The three-step wizard (`APPLY_STEP_IDS`,
// `stepIndex`/`maxVisitedIndex`, `canJumpToStep`), the answer draft, the
// skipped/prefilled sets, the certification claims, the eleven structural
// validators and `mergeDefaultsIntoDraft` now belong to
// `lib/application-requirements-flow.ts`: field answers, documents and
// certification claims are collected at STAGE 2, behind the employer's
// "request details", and that door is the only surface that still merges
// stored defaults into a draft.
//
// `touched` outlives the value it tracks on purpose. A prompt the worker
// typed into and then cleared is not the same as one they never opened, and
// only the first should be shown the "this can't be blank" hint -- the same
// reason the old flow kept its `attempted` flag sticky.

export type ApplyFlowState = {
  /** Keyed on `PreApplicationPrompt.id`, raw (untrimmed) as typed. */
  answers: Record<string, string>;
  /** Prompt ids the worker has typed into at least once. */
  touched: Set<string>;
};

export type ApplyFlowAction =
  | { type: 'set_prompt_answer'; promptId: string; text: string }
  | { type: 'reset' };

export function initialApplyFlowState(): ApplyFlowState {
  return { answers: {}, touched: new Set() };
}

/** Has the worker written anything worth not silently discarding? */
export function flowHasProgress(state: ApplyFlowState): boolean {
  return Object.values(state.answers).some((text) => text.trim().length > 0);
}

export function applyFlowReducer(state: ApplyFlowState, action: ApplyFlowAction): ApplyFlowState {
  switch (action.type) {
    case 'set_prompt_answer': {
      const touched = new Set(state.touched);
      touched.add(action.promptId);
      return {
        answers: { ...state.answers, [action.promptId]: action.text },
        touched,
      };
    }
    case 'reset':
      return initialApplyFlowState();
    default:
      return state;
  }
}

/**
 * The `prompt_answers` body for `applyToJob`, TRIMMED.
 *
 * Only ids the job actually asks about are included: a stale answer left in
 * the draft after the employer removed a prompt is dropped here rather than
 * sent as an unknown id, which the door rejects with
 * `invalid_prompt_answers`.
 */
export function promptAnswersPayload(
  prompts: readonly { id: string }[],
  state: ApplyFlowState,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const prompt of prompts) {
    const text = state.answers[prompt.id];
    if (text === undefined) continue;
    payload[prompt.id] = text.trim();
  }
  return payload;
}
