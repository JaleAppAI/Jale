// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_PROMPT_ANSWER_CHARS } from '@/lib/application-requirements-flow';
import { applyFlowReducer, initialApplyFlowState, type ApplyFlowState } from '@/lib/apply-flow-view';
import type { JobDetail } from '@/lib/api/worker';
// Imported IN PLACE rather than relocated to `src/test/`: a sibling lane owns
// `TrustQuestionStep.tsx` and its suite, and moving this helper would rewrite
// the import in every onboarding test underneath them.
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import { ApplyFlow } from '../ApplyFlow';

const PROMPTS = [
  { id: 'p1', text: 'Tell me about the biggest concrete pour you have finished.' },
  { id: 'p2', text: 'What tools do you bring to a job?' },
];

function job(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job-1',
    title: 'Concrete Finisher',
    company_name: 'Rucoba & Maya',
    location: 'Dallas, TX',
    job_type: 'full-time',
    required_docs: [],
    created_at: '2026-08-28T00:00:00Z',
    description: null,
    already_applied: false,
    application_status: null,
    missing_docs: [],
    pre_application_prompts: PROMPTS,
    ...over,
  } as JobDetail;
}

function answered(entries: Record<string, string>): ApplyFlowState {
  let state = initialApplyFlowState();
  for (const [promptId, text] of Object.entries(entries)) {
    state = applyFlowReducer(state, { type: 'set_prompt_answer', promptId, text });
  }
  return state;
}

function renderFlow(over: {
  job?: Partial<JobDetail>;
  state?: ApplyFlowState;
  submitting?: boolean;
  submitError?: { message: string } | null;
} = {}) {
  const dispatch = vi.fn();
  const onSubmit = vi.fn();
  const onBackToDetails = vi.fn();
  const result = renderIntl(
    <ApplyFlow
      job={job(over.job)}
      state={over.state ?? initialApplyFlowState()}
      dispatch={dispatch}
      onSubmit={onSubmit}
      submitting={over.submitting ?? false}
      submitError={over.submitError ?? null}
      onBackToDetails={onBackToDetails}
    />,
  );
  return { ...result, dispatch, onSubmit, onBackToDetails };
}

const submitLabel = message('worker_job_detail.apply_flow.submit');

describe('ApplyFlow — one screen, prompts only', () => {
  it('renders every prompt as its own labelled box', () => {
    renderFlow();
    expect(screen.getByLabelText(PROMPTS[0].text)).toBeInTheDocument();
    expect(screen.getByLabelText(PROMPTS[1].text)).toBeInTheDocument();
  });

  it('has NO step nav, no review step and no document controls', () => {
    renderFlow();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByText(message('worker_application_details.steps.documents')))
      .not.toBeInTheDocument();
    expect(screen.queryByText(message('worker_application_details.steps.review')))
      .not.toBeInTheDocument();
  });

  it('always shows the "documents and details come later" note', () => {
    renderFlow();
    expect(screen.getByText(message('worker_job_detail.apply_flow.later_note'))).toBeInTheDocument();
  });
});

describe('ApplyFlow — the one-tap job', () => {
  it('shows the one-tap intro and no boxes at all', () => {
    renderFlow({ job: { pre_application_prompts: [] } });
    expect(screen.getByText(message('worker_job_detail.apply_flow.intro_one_tap'))).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('leaves Send enabled immediately -- there is nothing to fill in', () => {
    renderFlow({ job: { pre_application_prompts: [] } });
    expect(screen.getByRole('button', { name: submitLabel })).toBeEnabled();
  });

  it('treats an absent pre_application_prompts (a pre-sprint-23 payload) as one tap, never a crash', () => {
    renderFlow({ job: { pre_application_prompts: undefined } });
    expect(screen.getByRole('button', { name: submitLabel })).toBeEnabled();
  });
});

describe('ApplyFlow — the submit gate', () => {
  it('is disabled until EVERY prompt has real text', async () => {
    const { rerender } = renderFlow();
    expect(screen.getByRole('button', { name: submitLabel })).toBeDisabled();

    // One of two answered is still not enough.
    rerender(
      <ApplyFlow
        job={job()}
        state={answered({ p1: 'A 40-yard pour in Garland.' })}
        dispatch={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
        onBackToDetails={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: submitLabel })).toBeDisabled();
  });

  it('opens once both answers have text', () => {
    renderFlow({ state: answered({ p1: 'A 40-yard pour.', p2: 'Trowel, screed, float.' }) });
    expect(screen.getByRole('button', { name: submitLabel })).toBeEnabled();
  });

  it('stays shut on whitespace -- the same trim the door applies', () => {
    renderFlow({ state: answered({ p1: '   ', p2: 'Trowel.' }) });
    expect(screen.getByRole('button', { name: submitLabel })).toBeDisabled();
  });

  it('accepts a ONE-WORD answer: there is no minimum length', () => {
    renderFlow({ state: answered({ p1: 'Yes', p2: 'No' }) });
    expect(screen.getByRole('button', { name: submitLabel })).toBeEnabled();
  });

  it('shuts again on an over-long answer', () => {
    renderFlow({ state: answered({ p1: 'x'.repeat(MAX_PROMPT_ANSWER_CHARS + 1), p2: 'Trowel.' }) });
    expect(screen.getByRole('button', { name: submitLabel })).toBeDisabled();
  });
});

describe('ApplyFlow — dispatch and callbacks', () => {
  it('dispatches set_prompt_answer keyed on the PROMPT ID, not its position', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderFlow();
    await user.type(screen.getByLabelText(PROMPTS[1].text), 'T');
    expect(dispatch).toHaveBeenCalledWith({ type: 'set_prompt_answer', promptId: 'p2', text: 'T' });
  });

  it('calls onSubmit when the gate is open', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderFlow({ state: answered({ p1: 'a', p2: 'b' }) });
    await user.click(screen.getByRole('button', { name: submitLabel }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('calls onBackToDetails from the back link', async () => {
    const user = userEvent.setup();
    const { onBackToDetails } = renderFlow();
    await user.click(screen.getByRole('button', {
      name: message('worker_job_detail.apply_flow.back_to_details'),
    }));
    expect(onBackToDetails).toHaveBeenCalledOnce();
  });
});

describe('ApplyFlow — feedback', () => {
  it('renders the page-chosen submit error inside the flow, not over it', () => {
    renderFlow({ submitError: { message: 'Answer every question before you send this (1 left).' } });
    expect(screen.getByText('Answer every question before you send this (1 left).')).toBeInTheDocument();
    // Still on the form: a fixable problem must never discard what was typed.
    expect(screen.getByLabelText(PROMPTS[0].text)).toBeInTheDocument();
  });

  it('disables the boxes while the application is in flight', () => {
    renderFlow({ state: answered({ p1: 'a', p2: 'b' }), submitting: true });
    expect(screen.getByLabelText(PROMPTS[0].text)).toBeDisabled();
  });

  it('renders in Spanish from the real catalogue', () => {
    renderIntl(
      <ApplyFlow
        job={job({ pre_application_prompts: [] })}
        state={initialApplyFlowState()}
        dispatch={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
        onBackToDetails={vi.fn()}
      />,
      'es',
    );
    expect(screen.getByText(message('worker_job_detail.apply_flow.intro_one_tap', 'es')))
      .toBeInTheDocument();
  });
});
