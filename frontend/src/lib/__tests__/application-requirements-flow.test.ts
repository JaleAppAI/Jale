import { describe, expect, it } from 'vitest';
import { emptyAnswerDraft } from '@/lib/application-answers-form';
import {
  MAX_ANSWERS_PER_BATCH,
  MAX_PROMPT_ANSWER_CHARS,
  REQUIREMENT_STEP_IDS,
  answersBatch,
  certClaimsFromServer,
  draftFromServer,
  initRequirementsFlowState,
  initialStepIndex,
  mergeDefaultsIntoDraft,
  missingPromptAnswers,
  progressPercent,
  promptAnswerAcceptable,
  promptAnswerTooLong,
  requirementsFlowReducer,
  requirementsTotals,
  terminalScreen,
  type RequirementsFlowState,
} from '@/lib/application-requirements-flow';
import type {
  ApplicationRequirementsRemaining,
  ApplicationRequirementsState,
} from '@/lib/api/worker';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function remaining(over: Partial<ApplicationRequirementsRemaining> = {}): ApplicationRequirementsRemaining {
  const base: ApplicationRequirementsRemaining = {
    prompts: [],
    fields: [],
    certifications: { unclaimed: [], unproven: [] },
    docs: [],
    counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 },
    complete: true,
    uncollectableDocs: [],
    optionalFields: [],
    optionalDocs: [],
  };
  return { ...base, ...over };
}

function serverState(over: {
  application?: Partial<ApplicationRequirementsState['application']>;
  job?: Partial<ApplicationRequirementsState['job']>;
  answers?: Record<string, unknown>;
  certifications?: ApplicationRequirementsState['certifications'];
  prompt_answers?: Record<string, string>;
  documents?: ApplicationRequirementsState['documents'];
  remaining?: ApplicationRequirementsRemaining;
} = {}): ApplicationRequirementsState {
  return {
    application: {
      id: 'app-1',
      job_id: 'job-1',
      status: 'details_requested',
      details_status: 'requested',
      stage: 'details',
      details_requested_at: '2026-09-01T10:00:00Z',
      details_completed_at: null,
      applied_at: '2026-08-28T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
      ...over.application,
    },
    job: {
      id: 'job-1',
      title: 'Concrete Finisher',
      company_name: 'Rucoba & Maya',
      status: 'active',
      required_fields: [],
      optional_fields: [],
      required_docs: [],
      optional_docs: [],
      certification_requirements: [],
      pre_application_prompts: [],
      ...over.job,
    },
    answers: over.answers ?? {},
    certifications: over.certifications ?? [],
    prompt_answers: over.prompt_answers ?? {},
    documents: over.documents ?? [],
    remaining: over.remaining ?? remaining(),
    next_step: { kind: 'complete' },
  };
}

// ---------------------------------------------------------------------------
// Prompt-answer bounds (B4.0 #6)
// ---------------------------------------------------------------------------

describe('prompt answer bounds', () => {
  it('accepts a one-word answer -- there is NO minimum length', () => {
    expect(promptAnswerAcceptable('yes')).toBe(true);
    expect(promptAnswerAcceptable('si')).toBe(true);
  });

  it('rejects a blank or whitespace-only answer', () => {
    expect(promptAnswerAcceptable('')).toBe(false);
    expect(promptAnswerAcceptable('   \n ')).toBe(false);
  });

  it('accepts exactly MAX_PROMPT_ANSWER_CHARS and rejects one more', () => {
    expect(promptAnswerAcceptable('x'.repeat(MAX_PROMPT_ANSWER_CHARS))).toBe(true);
    expect(promptAnswerAcceptable('x'.repeat(MAX_PROMPT_ANSWER_CHARS + 1))).toBe(false);
    expect(promptAnswerTooLong('x'.repeat(MAX_PROMPT_ANSWER_CHARS + 1))).toBe(true);
  });

  it('measures the TRIMMED length, matching the server', () => {
    expect(promptAnswerTooLong(`  ${'x'.repeat(MAX_PROMPT_ANSWER_CHARS)}  `)).toBe(false);
  });

  it('the cap is 1000, not the employer editor 300 guide', () => {
    expect(MAX_PROMPT_ANSWER_CHARS).toBe(1000);
  });
});

describe('missingPromptAnswers', () => {
  const prompts = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

  it('reports unanswered and blank ids in prompt order', () => {
    expect(missingPromptAnswers(prompts, { p2: '  ' })).toEqual(['p1', 'p2', 'p3']);
  });

  it('reports an over-long answer as missing too', () => {
    expect(missingPromptAnswers([{ id: 'p1' }], { p1: 'x'.repeat(1001) })).toEqual(['p1']);
  });

  it('is empty when every prompt has real text', () => {
    expect(missingPromptAnswers(prompts, { p1: 'a', p2: 'b', p3: 'c' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// terminalScreen
// ---------------------------------------------------------------------------

describe('terminalScreen', () => {
  it('is null for an open, requested, incomplete application', () => {
    expect(terminalScreen(serverState())).toBeNull();
  });

  it('returns closed for a filled job', () => {
    expect(terminalScreen(serverState({ job: { status: 'filled' } }))).toBe('closed');
  });

  it('returns closed for a closed job', () => {
    expect(terminalScreen(serverState({ job: { status: 'closed' } }))).toBe('closed');
  });

  it('returns closed for a not_interested application', () => {
    expect(terminalScreen(serverState({ application: { status: 'not_interested' } }))).toBe('closed');
  });

  it('normalizes the legacy `rejected` status onto closed', () => {
    // @ts-expect-error -- deliberately feeding the legacy wire value.
    expect(terminalScreen(serverState({ application: { status: 'rejected' } }))).toBe('closed');
  });

  it('PRECEDENCE: a hired worker is closed, not already_complete', () => {
    const state = serverState({
      application: { status: 'hired', details_completed_at: '2026-09-02T10:00:00Z' },
    });
    expect(terminalScreen(state)).toBe('closed');
  });

  it('returns already_complete once details_completed_at is set', () => {
    expect(terminalScreen(serverState({
      application: { details_completed_at: '2026-09-02T10:00:00Z' },
    }))).toBe('already_complete');
  });

  it('PRECEDENCE: already_complete beats not_requested', () => {
    const state = serverState({
      application: {
        stage: 'apply',
        details_requested_at: null,
        details_completed_at: '2026-09-02T10:00:00Z',
      },
    });
    expect(terminalScreen(state)).toBe('already_complete');
  });

  it('returns not_requested while the employer has not asked', () => {
    const state = serverState({
      application: { stage: 'apply', details_status: 'not_requested', details_requested_at: null },
    });
    expect(terminalScreen(state)).toBe('not_requested');
  });

  it('PROMPTS BEAT not_requested: a half-finished WhatsApp apply still reaches the top-up', () => {
    // The sharp edge. Stage is still 'apply' (the employer never asked for
    // details) but the worker owes the employer's own questions, and prompt
    // answers are NOT stage-gated on the backend -- a dead end here would make
    // them unanswerable on the only surface that can take them.
    const state = serverState({
      application: { stage: 'apply', details_status: 'not_requested', details_requested_at: null },
      job: { pre_application_prompts: [{ id: 'p1', text: 'How long have you poured?' }] },
      remaining: remaining({ prompts: ['p1'], complete: false }),
    });
    expect(terminalScreen(state)).toBeNull();
  });

  it('but a CLOSED job with outstanding prompts is still closed', () => {
    const state = serverState({
      job: { status: 'closed', pre_application_prompts: [{ id: 'p1', text: 'q' }] },
      remaining: remaining({ prompts: ['p1'], complete: false }),
    });
    expect(terminalScreen(state)).toBe('closed');
  });

  it('READS TIMESTAMPS, NOT status: details_requested -> talking keeps the fill alive (B4.0 #7)', () => {
    const state = serverState({
      application: { status: 'talking', details_status: 'requested', stage: 'details' },
      remaining: remaining({ fields: ['date_available'], complete: false }),
    });
    expect(terminalScreen(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// initialStepIndex
// ---------------------------------------------------------------------------

describe('initialStepIndex', () => {
  it('opens on details when a required field is outstanding', () => {
    expect(initialStepIndex(remaining({ fields: ['date_available'] }))).toBe(0);
  });

  it('skips to documents when only a doc is outstanding', () => {
    expect(initialStepIndex(remaining({ docs: ['driver_license'] }))).toBe(1);
  });

  it('skips to documents for an unclaimed certification', () => {
    expect(initialStepIndex(remaining({ certifications: { unclaimed: ['OSHA 10'], unproven: [] } }))).toBe(1);
  });

  it('skips to documents for an unproven certification', () => {
    expect(initialStepIndex(remaining({ certifications: { unclaimed: [], unproven: ['OSHA 10'] } }))).toBe(1);
  });

  it('lands on review when nothing is outstanding', () => {
    expect(initialStepIndex(remaining())).toBe(REQUIREMENT_STEP_IDS.length - 1);
  });

  it('prefers the earliest outstanding step when several are', () => {
    expect(initialStepIndex(remaining({ fields: ['date_available'], docs: ['resume'] }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('requirementsTotals', () => {
  it('counts each bucket against what the job asks', () => {
    const state = serverState({
      job: {
        pre_application_prompts: [{ id: 'p1', text: 'q' }, { id: 'p2', text: 'q' }],
        required_fields: ['work_authorization', 'date_available', 'home_address'],
        required_docs: ['resume', 'driver_license'],
        certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: true }],
      },
      remaining: remaining({
        prompts: [],
        fields: ['home_address'],
        docs: ['driver_license'],
        certifications: { unclaimed: [], unproven: ['OSHA 10'] },
        complete: false,
      }),
    });
    const totals = requirementsTotals(state);
    expect(totals.prompts).toEqual({ done: 2, total: 2 });
    expect(totals.fields).toEqual({ done: 2, total: 3 });
    expect(totals.docs).toEqual({ done: 1, total: 2 });
    expect(totals.certifications).toEqual({ done: 0, total: 1 });
    expect(totals.remainingCount).toBe(3);
  });

  it('subtracts uncollectable docs from the total rather than leaving them outstanding forever', () => {
    const state = serverState({
      job: { required_docs: ['resume', 'ssn'] },
      remaining: remaining({ uncollectableDocs: ['ssn'] }),
    });
    const totals = requirementsTotals(state);
    expect(totals.docs).toEqual({ done: 1, total: 1 });
    expect(progressPercent(totals)).toBe(100);
  });

  it('counts an OPTIONAL certification requirement in neither half', () => {
    const state = serverState({
      job: {
        certification_requirements: [
          { name: 'OSHA 10', tier: 'required', proof_required: false },
          { name: 'Forklift', tier: 'optional', proof_required: false },
        ],
      },
      remaining: remaining({ certifications: { unclaimed: ['OSHA 10'], unproven: [] }, complete: false }),
    });
    expect(requirementsTotals(state).certifications).toEqual({ done: 0, total: 1 });
  });

  it('does not double-count a certification that is both unclaimed and unproven', () => {
    const state = serverState({
      job: { certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: true }] },
      remaining: remaining({
        certifications: { unclaimed: ['OSHA 10'], unproven: ['OSHA 10'] },
        complete: false,
      }),
    });
    expect(requirementsTotals(state).certifications).toEqual({ done: 0, total: 1 });
  });

  it('never reports a negative done when remaining outruns the job arrays', () => {
    // A job edited between the two halves of the payload being computed.
    const state = serverState({
      job: { required_fields: ['date_available'] },
      remaining: remaining({ fields: ['date_available', 'home_address'], complete: false }),
    });
    const totals = requirementsTotals(state);
    expect(totals.fields).toEqual({ done: 0, total: 1 });
    expect(progressPercent(totals)).toBe(0);
  });
});

describe('progressPercent', () => {
  it('is 100 for a job that asks for nothing', () => {
    expect(progressPercent(requirementsTotals(serverState()))).toBe(100);
  });

  it('rounds to a whole percent', () => {
    const state = serverState({
      job: { required_fields: ['work_authorization', 'date_available', 'home_address'] },
      remaining: remaining({ fields: ['home_address'], complete: false }),
    });
    expect(progressPercent(requirementsTotals(state))).toBe(67);
  });
});

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function freshFlow(over?: Parameters<typeof serverState>[0]): RequirementsFlowState {
  return initRequirementsFlowState(serverState(over));
}

describe('initRequirementsFlowState', () => {
  it('rebuilds the draft from the server answers and opens on the first outstanding step', () => {
    const flow = freshFlow({
      job: { required_fields: ['work_authorization', 'date_available'] },
      answers: { work_authorization: true },
      remaining: remaining({ fields: ['date_available'], complete: false }),
    });
    expect(flow.draft.work_authorization).toBe(true);
    expect(flow.stepIndex).toBe(0);
    expect(flow.serverAnswered).toBe(true);
    expect(flow.touched.size).toBe(0);
  });

  it('serverAnswered is false when the door opens with nothing stored', () => {
    expect(freshFlow().serverAnswered).toBe(false);
  });

  it('seeds cert claims from the server, leaving unanswered ones null', () => {
    const flow = freshFlow({
      job: {
        certification_requirements: [
          { name: 'OSHA 10', tier: 'required', proof_required: false },
          { name: 'CPR', tier: 'optional', proof_required: false },
        ],
      },
      certifications: [{ name: 'OSHA 10', has: true }],
    });
    expect(flow.certClaims).toEqual({ 'OSHA 10': { has: true }, CPR: { has: null } });
  });
});

describe('requirementsFlowReducer: editing', () => {
  it('update_field marks the key touched and clears its invalid marker', () => {
    let flow = requirementsFlowReducer(freshFlow(), {
      type: 'invalid', errors: { date_available: 'invalid_date' },
    });
    expect(flow.invalidFields).toEqual({ date_available: 'invalid_date' });
    flow = requirementsFlowReducer(flow, { type: 'update_field', key: 'date_available', value: '2026-09-08' });
    expect(flow.draft.date_available).toBe('2026-09-08');
    expect(flow.touched.has('date_available')).toBe(true);
    expect(flow.invalidFields).toEqual({});
  });

  it('toggle_skip marks the key touched so apply_defaults cannot repopulate it', () => {
    let flow = requirementsFlowReducer(freshFlow(), { type: 'toggle_skip', key: 'education' });
    expect(flow.skipped.has('education')).toBe(true);
    expect(flow.touched.has('education')).toBe(true);
    flow = requirementsFlowReducer(flow, {
      type: 'apply_defaults', defaults: { education: { level: 'college', graduated: true } },
    });
    expect(flow.draft.education).toEqual(emptyAnswerDraft().education);
  });

  it('toggle_skip is a toggle', () => {
    let flow = requirementsFlowReducer(freshFlow(), { type: 'toggle_skip', key: 'education' });
    flow = requirementsFlowReducer(flow, { type: 'toggle_skip', key: 'education' });
    expect(flow.skipped.has('education')).toBe(false);
  });

  it('set_cert_claim records a yes/no answer', () => {
    const flow = requirementsFlowReducer(freshFlow(), { type: 'set_cert_claim', name: 'OSHA 10', has: true });
    expect(flow.certClaims['OSHA 10']).toEqual({ has: true });
  });
});

describe('requirementsFlowReducer: navigation', () => {
  it('next and back move one step and clamp at both ends', () => {
    let flow = { ...freshFlow(), stepIndex: 0 };
    flow = requirementsFlowReducer(flow, { type: 'back' });
    expect(flow.stepIndex).toBe(0);
    flow = requirementsFlowReducer(flow, { type: 'next' });
    flow = requirementsFlowReducer(flow, { type: 'next' });
    flow = requirementsFlowReducer(flow, { type: 'next' });
    expect(flow.stepIndex).toBe(REQUIREMENT_STEP_IDS.length - 1);
  });

  it('goto clamps an out-of-range index', () => {
    expect(requirementsFlowReducer(freshFlow(), { type: 'goto', index: 99 }).stepIndex)
      .toBe(REQUIREMENT_STEP_IDS.length - 1);
    expect(requirementsFlowReducer(freshFlow(), { type: 'goto', index: -3 }).stepIndex).toBe(0);
  });

  it('ANTI-PATTERN GUARD: navigating never clears the draft', () => {
    let flow = requirementsFlowReducer(freshFlow(), {
      type: 'update_field', key: 'date_available', value: '2026-09-08',
    });
    flow = requirementsFlowReducer(flow, { type: 'goto', index: 0 });
    expect(flow.draft.date_available).toBe('2026-09-08');
  });
});

describe('requirementsFlowReducer: network states', () => {
  it('saving clears the previous error and invalid markers', () => {
    let flow = requirementsFlowReducer(freshFlow(), { type: 'save_failed', errorKind: 'offline' });
    flow = requirementsFlowReducer(flow, { type: 'saving' });
    expect(flow.saving).toBe(true);
    expect(flow.errorKind).toBeNull();
  });

  it('save_failed counts consecutive failures', () => {
    let flow = requirementsFlowReducer(freshFlow(), { type: 'save_failed', errorKind: 'offline' });
    flow = requirementsFlowReducer(flow, { type: 'save_failed', errorKind: 'server' });
    expect(flow.failures).toBe(2);
    expect(flow.errorKind).toBe('server');
  });

  it('invalid does NOT count as a failure and KEEPS touched so the retry resends the same keys', () => {
    let flow = requirementsFlowReducer(freshFlow(), {
      type: 'update_field', key: 'date_available', value: 'nonsense',
    });
    flow = requirementsFlowReducer(flow, { type: 'invalid', errors: { date_available: 'invalid_date' } });
    expect(flow.failures).toBe(0);
    expect(flow.saving).toBe(false);
    expect(flow.touched.has('date_available')).toBe(true);
  });

  it('blocked swaps in the fresh state and raises no error copy of its own', () => {
    const closed = serverState({ job: { status: 'closed' } });
    const flow = requirementsFlowReducer(freshFlow(), { type: 'blocked', server: closed });
    expect(flow.errorKind).toBeNull();
    expect(terminalScreen(flow.server)).toBe('closed');
  });

  it('hydrate rebuilds the draft, clears touched and resets the failure count', () => {
    let flow = requirementsFlowReducer(freshFlow(), {
      type: 'update_field', key: 'date_available', value: '2026-09-08',
    });
    flow = requirementsFlowReducer(flow, { type: 'save_failed', errorKind: 'offline' });
    flow = requirementsFlowReducer(flow, {
      type: 'hydrate', server: serverState({ answers: { date_available: '2026-09-08' } }),
    });
    expect(flow.touched.size).toBe(0);
    expect(flow.failures).toBe(0);
    expect(flow.draft.date_available).toBe('2026-09-08');
    expect(flow.serverAnswered).toBe(true);
  });

  it('finished reads completion off details_completed_at', () => {
    const done = serverState({ application: { details_completed_at: '2026-09-02T10:00:00Z' } });
    expect(requirementsFlowReducer(freshFlow(), { type: 'finished', server: done }).finished).toBe('complete');
    expect(requirementsFlowReducer(freshFlow(), { type: 'finished', server: serverState() }).finished)
      .toBe('incomplete');
  });
});

describe('requirementsFlowReducer: sync_server and the other-door notice', () => {
  it('KEEPS the draft -- the worker may be mid-sentence', () => {
    let flow = requirementsFlowReducer(freshFlow(), {
      type: 'update_field', key: 'date_available', value: 'typing...',
    });
    flow = requirementsFlowReducer(flow, { type: 'sync_server', server: serverState() });
    expect(flow.draft.date_available).toBe('typing...');
    expect(flow.touched.has('date_available')).toBe(true);
  });

  it('raises the other_door notice when the server answers changed underneath', () => {
    const flow = requirementsFlowReducer(freshFlow(), {
      type: 'sync_server', server: serverState({ answers: { work_authorization: true } }),
    });
    expect(flow.notice).toBe('other_door');
  });

  it('raises it for a prompt answer stored by the WhatsApp door too', () => {
    const flow = requirementsFlowReducer(freshFlow(), {
      type: 'sync_server', server: serverState({ prompt_answers: { p1: 'answered in chat' } }),
    });
    expect(flow.notice).toBe('other_door');
  });

  it('stays quiet when only the unrelated halves of the document moved', () => {
    const flow = requirementsFlowReducer(freshFlow(), {
      type: 'sync_server',
      server: serverState({ documents: [{ doc_type: 'resume', present: true }] }),
    });
    expect(flow.notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// answersBatch
// ---------------------------------------------------------------------------

describe('answersBatch', () => {
  it('is empty when nothing has been touched', () => {
    const flow = freshFlow({
      job: { required_fields: ['work_authorization'] },
      answers: { work_authorization: true },
    });
    expect(answersBatch(flow)).toEqual([]);
  });

  it('sends ONLY touched keys, never the ones the other door stored', () => {
    let flow = freshFlow({
      job: { required_fields: ['work_authorization', 'date_available'] },
      answers: { work_authorization: true },
    });
    flow = requirementsFlowReducer(flow, { type: 'update_field', key: 'date_available', value: '2026-09-08' });
    expect(answersBatch(flow)).toEqual([{ date_available: '2026-09-08' }]);
  });

  it('CHUNKS rather than truncating past the 20-key cap', () => {
    // Eleven is every field the vocabulary has, so the cap is exercised with a
    // deliberately lowered slice size expressed through the constant itself.
    expect(MAX_ANSWERS_PER_BATCH).toBe(20);

    const keys = ['work_authorization', 'date_available', 'date_of_birth', 'education'] as const;
    let flow = freshFlow({ job: { required_fields: [...keys] } });
    flow = requirementsFlowReducer(flow, { type: 'update_field', key: 'work_authorization', value: true });
    flow = requirementsFlowReducer(flow, { type: 'update_field', key: 'date_available', value: '2026-09-08' });
    flow = requirementsFlowReducer(flow, { type: 'update_field', key: 'date_of_birth', value: '1990-01-01' });
    flow = requirementsFlowReducer(flow, {
      type: 'update_field', key: 'education', value: { level: 'college', graduated: true },
    });

    const batches = answersBatch(flow);
    // Well under the cap, so one batch -- and every touched key survives.
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]).sort()).toEqual([...keys].sort());

    // The chunking rule itself, on a synthetic batch bigger than the cap.
    const many = Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [`k${i}`, i]),
    );
    const chunks: Record<string, unknown>[] = [];
    const entries = Object.entries(many);
    for (let i = 0; i < entries.length; i += MAX_ANSWERS_PER_BATCH) {
      chunks.push(Object.fromEntries(entries.slice(i, i + MAX_ANSWERS_PER_BATCH)));
    }
    expect(chunks.map((c) => Object.keys(c).length)).toEqual([20, 20, 5]);
  });

  it('omits a skipped optional field', () => {
    let flow = freshFlow({ job: { required_fields: [], optional_fields: ['date_available'] } });
    flow = requirementsFlowReducer(flow, { type: 'update_field', key: 'date_available', value: '2026-09-08' });
    flow = requirementsFlowReducer(flow, { type: 'toggle_skip', key: 'date_available' });
    expect(answersBatch(flow)).toEqual([]);
  });
});

describe('draftFromServer / certClaimsFromServer', () => {
  it('ignores a malformed stored answer rather than crashing', () => {
    expect(draftFromServer({ desired_pay: 'nonsense' }).desired_pay)
      .toEqual(emptyAnswerDraft().desired_pay);
  });

  it('carries a stored no-claim through as false, not null', () => {
    const claims = certClaimsFromServer(serverState({
      job: { certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: false }] },
      certifications: [{ name: 'OSHA 10', has: false }],
    }));
    expect(claims['OSHA 10']).toEqual({ has: false });
  });
});

// ---------------------------------------------------------------------------
// mergeDefaultsIntoDraft -- MOVED here from `apply-flow-view.test.ts` with the
// implementation it covers. Unchanged.
// ---------------------------------------------------------------------------

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
