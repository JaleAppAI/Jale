import { describe, expect, it } from 'vitest';
import {
  applyFlowReducer,
  flowHasProgress,
  initialApplyFlowState,
  promptAnswersPayload,
  type ApplyFlowState,
} from '@/lib/apply-flow-view';

const PROMPTS = [
  { id: 'p1', text: 'Tell me about the biggest concrete pour you have finished.' },
  { id: 'p2', text: 'What tools do you bring to a job?' },
];

function answered(entries: Record<string, string>): ApplyFlowState {
  let state = initialApplyFlowState();
  for (const [promptId, text] of Object.entries(entries)) {
    state = applyFlowReducer(state, { type: 'set_prompt_answer', promptId, text });
  }
  return state;
}

describe('initialApplyFlowState', () => {
  it('starts with no answers and nothing touched', () => {
    const state = initialApplyFlowState();
    expect(state.answers).toEqual({});
    expect(state.touched.size).toBe(0);
  });
});

describe('applyFlowReducer: set_prompt_answer', () => {
  it('stores the raw text and marks the prompt touched', () => {
    const state = answered({ p1: '  poured a slab  ' });
    expect(state.answers.p1).toBe('  poured a slab  ');
    expect(state.touched.has('p1')).toBe(true);
  });

  it('keeps a prompt touched after the worker clears it back to empty', () => {
    let state = answered({ p1: 'something' });
    state = applyFlowReducer(state, { type: 'set_prompt_answer', promptId: 'p1', text: '' });
    expect(state.answers.p1).toBe('');
    // The whole point of `touched`: a cleared answer earns the "this can't be
    // blank" hint, an untouched one does not.
    expect(state.touched.has('p1')).toBe(true);
  });

  it('never mutates the previous state object', () => {
    const before = answered({ p1: 'a' });
    const snapshot = { ...before.answers };
    applyFlowReducer(before, { type: 'set_prompt_answer', promptId: 'p2', text: 'b' });
    expect(before.answers).toEqual(snapshot);
    expect(before.touched.has('p2')).toBe(false);
  });
});

describe('flowHasProgress', () => {
  it('is false for a fresh state', () => {
    expect(flowHasProgress(initialApplyFlowState())).toBe(false);
  });

  it('is false when every answer is whitespace only', () => {
    expect(flowHasProgress(answered({ p1: '   ' }))).toBe(false);
  });

  it('is true once any answer has real text', () => {
    expect(flowHasProgress(answered({ p1: '   ', p2: 'yes' }))).toBe(true);
  });
});

describe('applyFlowReducer: reset', () => {
  it('returns a fresh initial state', () => {
    const state = applyFlowReducer(answered({ p1: 'a', p2: 'b' }), { type: 'reset' });
    expect(state).toEqual(initialApplyFlowState());
  });
});

describe('promptAnswersPayload', () => {
  it('trims every answer', () => {
    expect(promptAnswersPayload(PROMPTS, answered({ p1: '  a  ', p2: 'b' })))
      .toEqual({ p1: 'a', p2: 'b' });
  });

  it('omits a prompt the worker never opened rather than sending an empty string', () => {
    expect(promptAnswersPayload(PROMPTS, answered({ p1: 'a' }))).toEqual({ p1: 'a' });
  });

  it('drops an answer whose prompt the employer has since removed', () => {
    // An unknown id is a 400 `invalid_prompt_answers`; a stale draft entry must
    // never become one.
    const state = answered({ p1: 'a', gone: 'stale' });
    expect(promptAnswersPayload(PROMPTS, state)).toEqual({ p1: 'a' });
  });

  it('is {} for a job that asks nothing -- the one-tap apply body', () => {
    expect(promptAnswersPayload([], answered({ p1: 'a' }))).toEqual({});
  });
});
