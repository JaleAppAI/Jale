// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import type {
  ApplicationRequirementsRemaining,
  ApplicationRequirementsState,
} from '@/lib/api/worker';

/*
 * Two behaviours of the details flow that a worker can hit on Check & finish:
 *
 *  - The way back from "Still missing" goes to the step that owns the missing
 *    item, and its label says where it goes.
 *  - Answers filled in from the last application are saved by "Save and
 *    continue" even when the worker leaves them as they are, so Check & finish
 *    agrees with what was sent.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ replace: vi.fn() }),
}));

const getApplicationRequirements = vi.fn();
const getApplicationDefaults = vi.fn();
const getVaultDocuments = vi.fn();
const postApplicationAnswers = vi.fn();
const postApplicationComplete = vi.fn();
const postApplicationCertifications = vi.fn();
const postApplicationPromptAnswers = vi.fn();

vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplicationRequirements: (...a: unknown[]) => getApplicationRequirements(...a),
  getApplicationDefaults: (...a: unknown[]) => getApplicationDefaults(...a),
  getVaultDocuments: (...a: unknown[]) => getVaultDocuments(...a),
  postApplicationAnswers: (...a: unknown[]) => postApplicationAnswers(...a),
  postApplicationComplete: (...a: unknown[]) => postApplicationComplete(...a),
  postApplicationCertifications: (...a: unknown[]) => postApplicationCertifications(...a),
  postApplicationPromptAnswers: (...a: unknown[]) => postApplicationPromptAnswers(...a),
}));

import { ApplicationRequirementsFlow } from '../ApplicationRequirementsFlow';

function remaining(over: Partial<ApplicationRequirementsRemaining> = {}): ApplicationRequirementsRemaining {
  return {
    prompts: [],
    fields: [],
    certifications: { unclaimed: [], unproven: [] },
    docs: [],
    counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 },
    complete: true,
    uncollectableDocs: [],
    optionalFields: [],
    optionalDocs: [],
    ...over,
  };
}

function serverState(over: {
  job?: Partial<ApplicationRequirementsState['job']>;
  answers?: Record<string, unknown>;
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
    },
    job: {
      id: 'job-1',
      title: 'Concrete Finisher',
      company_name: 'Northwind & Birch',
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
    certifications: [],
    prompt_answers: {},
    documents: [],
    remaining: over.remaining ?? remaining(),
    next_step: { kind: 'complete' },
    hire: null,
    sent_messages: [],
  };
}

const missingField = (key: string) => remaining({
  fields: [key],
  counts: { prompts: 0, fields: 1, certifications: 0, docs: 0 },
  complete: false,
});

function chip(step: 'details' | 'documents' | 'review') {
  return screen.getByRole('button', { name: new RegExp(message(`worker_application_details.steps.${step}`)) });
}

const saveAndContinue = () => screen.getByRole('button', { name: message('worker_application_details.continue_button') });

beforeEach(() => {
  vi.clearAllMocks();
  getVaultDocuments.mockResolvedValue({ documents: [] });
  getApplicationDefaults.mockResolvedValue({ answers: {} });
});

describe('Check & finish — the way back to what is missing', () => {
  it('sends the worker to Details, and says so, when a Details question is what is missing', async () => {
    const user = userEvent.setup();
    // The door stored an answer it still counts as missing; the local draft is
    // complete, so the stepper lets the worker reach Check & finish.
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={serverState({
      job: { required_fields: ['date_available'] },
      answers: { date_available: '2026-09-15' },
      remaining: missingField('date_available'),
    })} />);

    await user.click(chip('review'));
    expect(screen.getByText(message('worker_application_details.review.still_missing').replace('{items}', 'Date available')))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message('worker_application_details.review.go_fix') }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: message('worker_application_details.review.go_fix_details') }));

    expect(chip('details')).toHaveAttribute('aria-current', 'step');
    expect(saveAndContinue()).toBeInTheDocument();
  });

  it('says "Ir a Datos" in Spanish', async () => {
    const user = userEvent.setup();
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={serverState({
      job: { required_fields: ['date_available'] },
      answers: { date_available: '2026-09-15' },
      remaining: missingField('date_available'),
    })} />, 'es');

    await user.click(screen.getByRole('button', { name: new RegExp(message('worker_application_details.steps.review', 'es')) }));
    expect(screen.getByRole('button', { name: 'Ir a Datos' })).toBeInTheDocument();
  });

  it('keeps sending the worker to Documents & certifications when a document is what is missing', async () => {
    const user = userEvent.setup();
    getVaultDocuments.mockResolvedValue({
      documents: [{
        id: 'doc-1', doc_type: 'resume', file_name: 'cv.pdf', url: 'https://files.test/cv.pdf',
        uploaded_at: '2026-09-01T10:00:00Z', cert_name: null,
      }],
    });
    // The vault has the file, the door has not counted it yet.
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={serverState({
      job: { required_docs: ['resume'] },
      remaining: remaining({ docs: ['resume'], counts: { prompts: 0, fields: 0, certifications: 0, docs: 1 }, complete: false }),
    })} />);

    await waitFor(() => expect(chip('review')).toBeEnabled());
    await user.click(chip('review'));
    await user.click(screen.getByRole('button', { name: message('worker_application_details.review.go_fix') }));

    expect(chip('documents')).toHaveAttribute('aria-current', 'step');
  });
});

describe('Save and continue — answers filled in from the last application', () => {
  const prefilledJob = serverState({
    job: { required_fields: ['date_available'] },
    remaining: missingField('date_available'),
  });

  it('saves a filled-in answer the worker left as it was', async () => {
    const user = userEvent.setup();
    getApplicationDefaults.mockResolvedValue({ answers: { date_available: '2026-09-15' } });
    postApplicationAnswers.mockResolvedValue({
      kind: 'saved',
      state: serverState({ job: { required_fields: ['date_available'] }, answers: { date_available: '2026-09-15' } }),
    });
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={prefilledJob} />);

    await screen.findByText(message('worker_application_details.prefilled_hint'));
    await user.click(saveAndContinue());

    await waitFor(() => expect(postApplicationAnswers).toHaveBeenCalledTimes(1));
    expect(postApplicationAnswers).toHaveBeenCalledWith('tok', 'app-1', { date_available: '2026-09-15' });
  });

  it('saves the filled-in answers together with the ones the worker changed', async () => {
    const user = userEvent.setup();
    getApplicationDefaults.mockResolvedValue({ answers: { date_available: '2026-09-15' } });
    postApplicationAnswers.mockResolvedValue({
      kind: 'saved',
      state: serverState({
        job: { required_fields: ['work_authorization', 'date_available'] },
        answers: { work_authorization: true, date_available: '2026-09-15' },
      }),
    });
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={serverState({
      job: { required_fields: ['work_authorization', 'date_available'] },
      remaining: remaining({
        fields: ['work_authorization', 'date_available'],
        counts: { prompts: 0, fields: 2, certifications: 0, docs: 0 },
        complete: false,
      }),
    })} />);

    await screen.findByText(message('worker_application_details.prefilled_hint'));
    await user.click(screen.getByRole('radio', { name: message('job_requirements.apply.yes') }));
    await user.click(saveAndContinue());

    await waitFor(() => expect(postApplicationAnswers).toHaveBeenCalledTimes(1));
    expect(postApplicationAnswers.mock.calls[0][2]).toEqual({ work_authorization: true, date_available: '2026-09-15' });
  });

  it('shows nothing missing on Check & finish after the filled-in answers were saved', async () => {
    const user = userEvent.setup();
    getApplicationDefaults.mockResolvedValue({ answers: { date_available: '2026-09-15' } });
    postApplicationAnswers.mockResolvedValue({
      kind: 'saved',
      state: serverState({ job: { required_fields: ['date_available'] }, answers: { date_available: '2026-09-15' } }),
    });
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={prefilledJob} />);

    await screen.findByText(message('worker_application_details.prefilled_hint'));
    await user.click(saveAndContinue());
    await user.click(await screen.findByRole('button', { name: message('worker_application_details.documents_continue') }));

    expect(await screen.findByRole('button', { name: message('worker_application_details.review.finish') })).toBeEnabled();
    expect(screen.queryByText(/Still missing/)).not.toBeInTheDocument();
  });

  it('does not send a filled-in answer again once the door has stored it', async () => {
    const user = userEvent.setup();
    getApplicationDefaults.mockResolvedValue({ answers: { date_available: '2026-09-15' } });
    postApplicationAnswers.mockResolvedValue({
      kind: 'saved',
      state: serverState({ job: { required_fields: ['date_available'] }, answers: { date_available: '2026-09-15' } }),
    });
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={prefilledJob} />);

    await screen.findByText(message('worker_application_details.prefilled_hint'));
    await user.click(saveAndContinue());
    await waitFor(() => expect(chip('documents')).toHaveAttribute('aria-current', 'step'));

    await user.click(chip('details'));
    await user.click(saveAndContinue());

    expect(chip('documents')).toHaveAttribute('aria-current', 'step');
    expect(postApplicationAnswers).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an answer the other door stored after the prefill', async () => {
    const user = userEvent.setup();
    getApplicationDefaults.mockResolvedValue({ answers: { date_available: '2026-09-15', work_authorization: true } });
    postApplicationAnswers.mockResolvedValue({
      kind: 'saved',
      state: serverState({
        job: { required_fields: ['work_authorization', 'date_available'] },
        answers: { work_authorization: true, date_available: '2026-09-20' },
      }),
    });
    // The Documents panel's upload is what re-reads the state; here the re-read
    // is driven directly through a vault retry, which runs the same path.
    getVaultDocuments.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ documents: [] });
    getApplicationRequirements.mockResolvedValue(serverState({
      job: { required_fields: ['work_authorization', 'date_available'] },
      answers: { date_available: '2026-09-20' },
      remaining: missingField('work_authorization'),
    }));
    renderIntl(<ApplicationRequirementsFlow token="tok" initialState={serverState({
      job: { required_fields: ['work_authorization', 'date_available'] },
      remaining: remaining({
        fields: ['work_authorization', 'date_available'],
        counts: { prompts: 0, fields: 2, certifications: 0, docs: 0 },
        complete: false,
      }),
    })} />);

    await waitFor(() => expect(screen.getAllByText(message('worker_application_details.prefilled_hint'))).toHaveLength(2));
    // To Documents and back: the retry there re-reads the door's state.
    await user.click(chip('documents'));
    await user.click(await screen.findByRole('button', { name: message('common.retry') }));
    await waitFor(() => expect(getApplicationRequirements).toHaveBeenCalled());
    await user.click(chip('details'));
    await user.click(saveAndContinue());

    await waitFor(() => expect(postApplicationAnswers).toHaveBeenCalledTimes(1));
    expect(postApplicationAnswers.mock.calls[0][2]).toEqual({ work_authorization: true });
  });
});
