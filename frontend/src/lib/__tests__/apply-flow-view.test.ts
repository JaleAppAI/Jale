import { describe, expect, it } from 'vitest';
import { emptyAnswerDraft } from '@/lib/application-answers-form';
import {
  APPLY_STEP_IDS,
  initialApplyFlowState,
  applyFlowReducer,
  canJumpToStep,
  flowHasProgress,
  mergeDefaultsIntoDraft,
  type ApplyFlowState,
} from '@/lib/apply-flow-view';

const CERT_NAMES = ['OSHA 10', 'CPR'];

function freshState(): ApplyFlowState {
  return initialApplyFlowState(CERT_NAMES);
}

describe('initialApplyFlowState', () => {
  it('starts at step 0 with an empty draft and unanswered cert claims', () => {
    const state = freshState();
    expect(state.stepIndex).toBe(0);
    expect(state.maxVisitedIndex).toBe(0);
    expect(state.draft).toEqual(emptyAnswerDraft());
    expect(state.skipped.size).toBe(0);
    expect(state.touched.size).toBe(0);
    expect(state.prefilledKeys.size).toBe(0);
    expect(state.certClaims).toEqual({ 'OSHA 10': { has: null }, CPR: { has: null } });
  });
});

describe('canJumpToStep', () => {
  it('allows any index at or below maxVisited', () => {
    expect(canJumpToStep(0, 2)).toBe(true);
    expect(canJumpToStep(2, 2)).toBe(true);
  });

  it('blocks an index beyond maxVisited', () => {
    expect(canJumpToStep(2, 1)).toBe(false);
  });

  it('blocks a negative index even when maxVisited is high', () => {
    expect(canJumpToStep(-1, 2)).toBe(false);
  });

  it('blocks an index beyond the last step', () => {
    expect(canJumpToStep(APPLY_STEP_IDS.length, APPLY_STEP_IDS.length)).toBe(false);
  });
});

describe('flowHasProgress', () => {
  it('is false for a fresh state', () => {
    expect(flowHasProgress(freshState())).toBe(false);
  });

  it('is true once a field has been touched', () => {
    const state = applyFlowReducer(freshState(), { type: 'update_field', key: 'date_available', value: '2026-09-01' });
    expect(flowHasProgress(state)).toBe(true);
  });

  it('is true after navigating forward (maxVisitedIndex>0)', () => {
    const state = applyFlowReducer(freshState(), { type: 'next' });
    expect(flowHasProgress(state)).toBe(true);
  });

  it('is true once any cert claim is answered', () => {
    const state = applyFlowReducer(freshState(), { type: 'set_cert_claim', name: 'OSHA 10', has: true });
    expect(flowHasProgress(state)).toBe(true);
  });

  it('is true after toggling a skip (a deliberate user action)', () => {
    const state = applyFlowReducer(freshState(), { type: 'toggle_skip', key: 'education' });
    expect(flowHasProgress(state)).toBe(true);
  });
});

describe('applyFlowReducer: navigation', () => {
  it('next advances stepIndex and raises maxVisitedIndex', () => {
    const s1 = applyFlowReducer(freshState(), { type: 'next' });
    expect(s1.stepIndex).toBe(1);
    expect(s1.maxVisitedIndex).toBe(1);
  });

  it('next stays clamped at the last step', () => {
    let state = freshState();
    for (let i = 0; i < 5; i += 1) state = applyFlowReducer(state, { type: 'next' });
    expect(state.stepIndex).toBe(APPLY_STEP_IDS.length - 1);
  });

  it('back never goes below 0 and never lowers maxVisitedIndex', () => {
    let state = freshState();
    state = applyFlowReducer(state, { type: 'next' });
    state = applyFlowReducer(state, { type: 'next' });
    const maxVisited = state.maxVisitedIndex;
    state = applyFlowReducer(state, { type: 'back' });
    expect(state.stepIndex).toBe(1);
    expect(state.maxVisitedIndex).toBe(maxVisited);
    state = applyFlowReducer(state, { type: 'back' });
    state = applyFlowReducer(state, { type: 'back' });
    expect(state.stepIndex).toBe(0);
    expect(state.maxVisitedIndex).toBe(maxVisited);
  });

  it('goto clamps out-of-range indices into bounds', () => {
    const high = applyFlowReducer(freshState(), { type: 'goto', index: 99 });
    expect(high.stepIndex).toBe(APPLY_STEP_IDS.length - 1);
    const low = applyFlowReducer(freshState(), { type: 'goto', index: -1 });
    expect(low.stepIndex).toBe(0);
  });

  it('goto raises maxVisitedIndex but never lowers it', () => {
    let state = applyFlowReducer(freshState(), { type: 'goto', index: 2 });
    expect(state.maxVisitedIndex).toBe(2);
    state = applyFlowReducer(state, { type: 'goto', index: 0 });
    expect(state.stepIndex).toBe(0);
    expect(state.maxVisitedIndex).toBe(2);
  });

  it('ANTI-PATTERN GUARD: goto index 0 does not clear the draft or cert claims', () => {
    let state = freshState();
    state = applyFlowReducer(state, { type: 'update_field', key: 'date_available', value: '2026-09-01' });
    state = applyFlowReducer(state, { type: 'set_cert_claim', name: 'OSHA 10', has: true });
    state = applyFlowReducer(state, { type: 'next' });
    state = applyFlowReducer(state, { type: 'goto', index: 0 });
    expect(state.draft.date_available).toBe('2026-09-01');
    expect(state.certClaims['OSHA 10']).toEqual({ has: true });
    expect(state.stepIndex).toBe(0);
  });

  it('ANTI-PATTERN GUARD: back to step 0 does not clear the draft either', () => {
    let state = freshState();
    state = applyFlowReducer(state, { type: 'update_field', key: 'date_available', value: '2026-09-01' });
    state = applyFlowReducer(state, { type: 'next' });
    state = applyFlowReducer(state, { type: 'back' });
    expect(state.draft.date_available).toBe('2026-09-01');
  });
});

describe('applyFlowReducer: update_field / toggle_skip / set_cert_claim', () => {
  it('update_field sets the value and marks the key touched', () => {
    const state = applyFlowReducer(freshState(), { type: 'update_field', key: 'date_available', value: '2026-09-01' });
    expect(state.draft.date_available).toBe('2026-09-01');
    expect(state.touched.has('date_available')).toBe(true);
  });

  it('toggle_skip adds then removes a key from skipped, and marks it touched', () => {
    let state = applyFlowReducer(freshState(), { type: 'toggle_skip', key: 'education' });
    expect(state.skipped.has('education')).toBe(true);
    expect(state.touched.has('education')).toBe(true);
    state = applyFlowReducer(state, { type: 'toggle_skip', key: 'education' });
    expect(state.skipped.has('education')).toBe(false);
    // Un-skipping still leaves the key touched -- a skip-then-unskip is a
    // deliberate interaction with the field, not a no-op, so a stored
    // default must not silently prefill it afterward.
    expect(state.touched.has('education')).toBe(true);
  });

  it('set_cert_claim records a yes/no answer for a named cert', () => {
    const state = applyFlowReducer(freshState(), { type: 'set_cert_claim', name: 'OSHA 10', has: false });
    expect(state.certClaims['OSHA 10']).toEqual({ has: false });
  });

  it('set_cert_claim works for a cert name absent from the initial list', () => {
    const state = applyFlowReducer(freshState(), { type: 'set_cert_claim', name: 'Welding', has: true });
    expect(state.certClaims.Welding).toEqual({ has: true });
  });
});

describe('applyFlowReducer: apply_defaults', () => {
  it('fills untouched keys and records them as prefilled', () => {
    const state = applyFlowReducer(freshState(), {
      type: 'apply_defaults', defaults: { date_available: '2026-09-01' },
    });
    expect(state.draft.date_available).toBe('2026-09-01');
    expect(state.prefilledKeys.has('date_available')).toBe(true);
    expect(state.touched.has('date_available')).toBe(false);
  });

  it('never overwrites a touched key', () => {
    let state = applyFlowReducer(freshState(), {
      type: 'update_field', key: 'date_available', value: '2026-08-01',
    });
    state = applyFlowReducer(state, {
      type: 'apply_defaults', defaults: { date_available: '2026-09-01' },
    });
    expect(state.draft.date_available).toBe('2026-08-01');
    expect(state.prefilledKeys.has('date_available')).toBe(false);
  });

  it('a skipped (and therefore touched) key is not repopulated by apply_defaults', () => {
    let state = applyFlowReducer(freshState(), { type: 'toggle_skip', key: 'education' });
    state = applyFlowReducer(state, {
      type: 'apply_defaults', defaults: { education: { level: 'college', graduated: true } },
    });
    expect(state.draft.education).toEqual(emptyAnswerDraft().education);
    expect(state.prefilledKeys.has('education')).toBe(false);
  });

  it('skips a malformed default rather than crashing', () => {
    const state = applyFlowReducer(freshState(), {
      type: 'apply_defaults', defaults: { desired_pay: 'not-an-object' },
    });
    expect(state.draft.desired_pay).toEqual(emptyAnswerDraft().desired_pay);
    expect(state.prefilledKeys.has('desired_pay')).toBe(false);
  });

  it('unions prefilledKeys across repeated apply_defaults calls', () => {
    let state = applyFlowReducer(freshState(), {
      type: 'apply_defaults', defaults: { date_available: '2026-09-01' },
    });
    state = applyFlowReducer(state, {
      type: 'apply_defaults', defaults: { date_of_birth: '1990-01-01' },
    });
    expect(state.prefilledKeys.has('date_available')).toBe(true);
    expect(state.prefilledKeys.has('date_of_birth')).toBe(true);
  });
});

describe('applyFlowReducer: reset', () => {
  it('returns a fresh initial state rebuilt from the given cert names', () => {
    let state = freshState();
    state = applyFlowReducer(state, { type: 'update_field', key: 'date_available', value: '2026-09-01' });
    state = applyFlowReducer(state, { type: 'next' });
    state = applyFlowReducer(state, { type: 'set_cert_claim', name: 'OSHA 10', has: true });
    state = applyFlowReducer(state, { type: 'reset', certNames: ['Welding'] });
    expect(state).toEqual(initialApplyFlowState(['Welding']));
  });
});

describe('mergeDefaultsIntoDraft', () => {
  it('fills a key not in touched and reports it in prefilledKeys', () => {
    const draft = emptyAnswerDraft();
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(draft, { date_available: '2026-09-01' }, new Set());
    expect(next.date_available).toBe('2026-09-01');
    expect(prefilledKeys.has('date_available')).toBe(true);
  });

  it('does not fill a touched key', () => {
    const draft = { ...emptyAnswerDraft(), date_available: '2026-08-01' };
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(
      draft, { date_available: '2026-09-01' }, new Set(['date_available']),
    );
    expect(next.date_available).toBe('2026-08-01');
    expect(prefilledKeys.has('date_available')).toBe(false);
  });

  it('validates desired_pay structurally: correct shape applies, an unknown interval is rejected', () => {
    const draft = emptyAnswerDraft();
    const ok = mergeDefaultsIntoDraft(draft, { desired_pay: { amount: '25', interval: 'hourly' } }, new Set());
    expect(ok.draft.desired_pay).toEqual({ amount: '25', interval: 'hourly' });

    const bad = mergeDefaultsIntoDraft(draft, { desired_pay: { amount: '25', interval: 'fortnightly' } }, new Set());
    expect(bad.draft.desired_pay).toEqual(draft.desired_pay);
    expect(bad.prefilledKeys.size).toBe(0);
  });

  it('applies a structurally valid but incomplete home_address (completeness is the submit gate\'s job, not this one)', () => {
    const draft = emptyAnswerDraft();
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(
      draft, { home_address: { street: '1 Main', apartment: '', city: '', state: '', zip: '' } }, new Set(),
    );
    expect(next.home_address).toEqual({ street: '1 Main', apartment: '', city: '', state: '', zip: '' });
    expect(prefilledKeys.has('home_address')).toBe(true);
  });

  it('rejects a references default longer than MAX_REPEATING_ENTRIES rather than truncating it', () => {
    const draft = emptyAnswerDraft();
    const tooMany = [1, 2, 3, 4].map((n) => ({ name: `R${n}`, relationship: 'x', company: '', phone: '' }));
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(draft, { references: tooMany }, new Set());
    expect(next.references).toEqual([]);
    expect(prefilledKeys.has('references')).toBe(false);
  });

  it('rejects a malformed entry inside an otherwise well-formed references array', () => {
    const draft = emptyAnswerDraft();
    const bad = [
      { name: 'Jo', relationship: 'Boss', company: '', phone: '555-0000' },
      { name: 42 },
    ];
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(draft, { references: bad }, new Set());
    expect(next.references).toEqual([]);
    expect(prefilledKeys.has('references')).toBe(false);
  });

  it('ignores a key that is not part of AnswerDraft', () => {
    const draft = emptyAnswerDraft();
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(draft, { not_a_real_field: 'x' }, new Set());
    expect(next).toEqual(draft);
    expect(prefilledKeys.size).toBe(0);
  });

  it('validates work_authorization as boolean only', () => {
    const draft = emptyAnswerDraft();
    const ok = mergeDefaultsIntoDraft(draft, { work_authorization: true }, new Set());
    expect(ok.draft.work_authorization).toBe(true);

    const bad = mergeDefaultsIntoDraft(draft, { work_authorization: 'yes' }, new Set());
    expect(bad.draft.work_authorization).toBeUndefined();
    expect(bad.prefilledKeys.size).toBe(0);
  });

  it('validates education.level against the known enum, allowing the blank sentinel', () => {
    const draft = emptyAnswerDraft();
    const ok = mergeDefaultsIntoDraft(draft, { education: { level: 'college', graduated: true } }, new Set());
    expect(ok.draft.education).toEqual({ level: 'college', graduated: true });

    const bad = mergeDefaultsIntoDraft(draft, { education: { level: 'phd', graduated: true } }, new Set());
    expect(bad.draft.education).toEqual(draft.education);
  });

  it('applies a well-formed work_history entry and reports it prefilled', () => {
    const draft = emptyAnswerDraft();
    const entry = {
      company: 'Acme', title: 'Roofer', from: '2020', to: '2022',
      responsibilities: 'Shingles', reason_for_leaving: 'Relocated', may_contact: true,
    };
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(draft, { work_history: [entry] }, new Set());
    expect(next.work_history).toEqual([entry]);
    expect(prefilledKeys.has('work_history')).toBe(true);
  });

  it('rejects a military_service default whose served flag is not boolean/null', () => {
    const draft = emptyAnswerDraft();
    const bad = {
      served: 'yes', branch: 'Army', from: '2010', to: '2014',
      rank_at_discharge: 'Sergeant', discharge_type: 'Honorable',
    };
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(draft, { military_service: bad }, new Set());
    expect(next.military_service).toEqual(draft.military_service);
    expect(prefilledKeys.has('military_service')).toBe(false);
  });

  it('applies a well-formed military_service default', () => {
    const draft = emptyAnswerDraft();
    const good = {
      served: true, branch: 'Army', from: '2010', to: '2014',
      rank_at_discharge: 'Sergeant', discharge_type: 'Honorable',
    };
    const { draft: next, prefilledKeys } = mergeDefaultsIntoDraft(draft, { military_service: good }, new Set());
    expect(next.military_service).toEqual(good);
    expect(prefilledKeys.has('military_service')).toBe(true);
  });

  it('never mutates the input draft', () => {
    const draft = emptyAnswerDraft();
    const frozenCopy = JSON.parse(JSON.stringify(draft));
    mergeDefaultsIntoDraft(draft, { date_available: '2026-09-01' }, new Set());
    expect(draft).toEqual(frozenCopy);
  });
});
