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

const replace = vi.fn();
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ replace }),
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

// `vi.mock` is hoisted above this, so a static import still gets the stubs.
import { ApplicationRequirementsFlow } from '../ApplicationRequirementsFlow';

// ---------------------------------------------------------------------------

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
  application?: Partial<ApplicationRequirementsState['application']>;
  job?: Partial<ApplicationRequirementsState['job']>;
  answers?: Record<string, unknown>;
  prompt_answers?: Record<string, string>;
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
    certifications: [],
    prompt_answers: over.prompt_answers ?? {},
    documents: [],
    remaining: over.remaining ?? remaining(),
    next_step: { kind: 'complete' },
  };
}

function renderFlow(state: ApplicationRequirementsState, locale: 'en' | 'es' = 'en') {
  return renderIntl(<ApplicationRequirementsFlow token="tok" initialState={state} />, locale);
}

beforeEach(() => {
  vi.clearAllMocks();
  getVaultDocuments.mockResolvedValue({ documents: [] });
  getApplicationDefaults.mockResolvedValue({ answers: {} });
});

// ---------------------------------------------------------------------------

describe('ApplicationRequirementsFlow — terminal panels', () => {
  it('shows the closed panel for a closed job and offers other jobs', () => {
    renderFlow(serverState({ job: { status: 'closed' } }));
    expect(screen.getByText(message('worker_application_details.terminal.closed'))).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: message('worker_application_details.terminal.find_jobs'),
    })).toBeInTheDocument();
  });

  // The WhatsApp `application_hired` link and the in-app celebration both land
  // on this page. A hired worker must read "you got the job", never "this job
  // is closed / the employer took it down" (prod report 2026-09-08).
  it('shows the hired panel, not the closed one, for a hired worker on an open job', () => {
    renderFlow(serverState({
      application: { status: 'hired', details_completed_at: '2026-09-02T10:00:00Z' },
      job: { status: 'active' },
    }));
    expect(screen.getByText(message('worker_application_details.terminal.hired'))).toBeInTheDocument();
    expect(screen.queryByText(message('worker_application_details.terminal.closed'))).not.toBeInTheDocument();
    expect(screen.queryByText(message('worker_application_details.terminal.closed_body'))).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: message('worker_application_details.terminal.view_applications'),
    })).toBeInTheDocument();
  });

  it('keeps the hired panel when the job filled after the hire', () => {
    renderFlow(serverState({ application: { status: 'hired' }, job: { status: 'filled' } }));
    expect(screen.getByText(message('worker_application_details.terminal.hired'))).toBeInTheDocument();
    expect(screen.queryByText(message('worker_application_details.terminal.closed'))).not.toBeInTheDocument();
  });

  it('shows the not-interested panel, not the closed-job one, for a not_interested application', () => {
    renderFlow(serverState({ application: { status: 'not_interested' } }));
    expect(screen.getByText(message('worker_application_details.terminal.not_interested'))).toBeInTheDocument();
    expect(screen.queryByText(message('worker_application_details.terminal.closed_body'))).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: message('worker_application_details.terminal.find_jobs'),
    })).toBeInTheDocument();
  });

  it('shows the already-complete panel once details_completed_at is set', () => {
    renderFlow(serverState({ application: { details_completed_at: '2026-09-02T00:00:00Z' } }));
    expect(screen.getByText(message('worker_application_details.terminal.already_complete')))
      .toBeInTheDocument();
    // F2: and it says WHY there is no way to edit, and where to go instead.
    expect(screen.getByText(message('worker_application_details.terminal.already_complete_note')))
      .toBeInTheDocument();
  });

  it('shows the not-requested panel before the employer asks', () => {
    renderFlow(serverState({
      application: { stage: 'apply', details_status: 'not_requested', details_requested_at: null },
    }));
    expect(screen.getByText(message('worker_application_details.terminal.not_requested')))
      .toBeInTheDocument();
  });

  it('renders NO stepper on a terminal screen', () => {
    renderFlow(serverState({ job: { status: 'filled' } }));
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('names "your employer" instead of a blank when the job has no company', () => {
    // `company_name` is nullable (an orphaned job). Interpolating '' used to
    // leave a subject-less sentence -- "has it all." -- so each {company}
    // string has a `_no_company` twin.
    renderFlow(serverState({
      application: { details_completed_at: '2026-09-02T00:00:00Z' },
      job: { company_name: null },
    }));
    expect(
      screen.getByText(message('worker_application_details.terminal.already_complete_body_no_company')),
    ).toBeInTheDocument();
  });

  /*
   * The API's `company_name` is `employer_display_name()`, which ends in
   * COALESCE(..., 'Empleador') -- a Spanish placeholder, not a name. Dropped
   * into "{company} has it all." it reads as a company literally called
   * Empleador, and on the English page it is not even in the right language.
   * It is the same sentinel the hire copy already refuses; this surface has
   * `_no_company` twins for exactly this, and now uses them.
   */
  it('treats the "Empleador" placeholder as no company at all', () => {
    renderFlow(serverState({
      application: { details_completed_at: '2026-09-02T00:00:00Z' },
      job: { company_name: 'Empleador' },
    }));

    expect(
      screen.getByText(message('worker_application_details.terminal.already_complete_body_no_company')),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Empleador/)).not.toBeInTheDocument();
  });

  /* Equality, not a substring test: "Empleadora del Norte" is a real name. */
  it('keeps a real company name that merely starts with the placeholder word', () => {
    renderFlow(serverState({
      application: { details_completed_at: '2026-09-02T00:00:00Z' },
      job: { company_name: 'Empleadora del Norte' },
    }));

    expect(screen.getByText(/Empleadora del Norte/)).toBeInTheDocument();
  });

  it('every terminal panel keeps a way out', () => {
    renderFlow(serverState({ application: { details_completed_at: '2026-09-02T00:00:00Z' } }));
    expect(screen.getByRole('button', {
      name: message('worker_application_details.terminal.view_job'),
    })).toBeInTheDocument();
  });
});

describe('ApplicationRequirementsFlow — the prompt top-up', () => {
  const withPrompts = serverState({
    application: { stage: 'apply', details_status: 'not_requested', details_requested_at: null },
    job: { pre_application_prompts: [{ id: 'p1', text: 'How long have you poured concrete?' }] },
    remaining: remaining({ prompts: ['p1'], counts: { prompts: 1, fields: 0, certifications: 0, docs: 0 }, complete: false }),
  });

  it('BEATS the not_requested dead end -- this is the only surface that can take the answer', () => {
    renderFlow(withPrompts);
    expect(screen.queryByText(message('worker_application_details.terminal.not_requested')))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText('How long have you poured concrete?')).toBeInTheDocument();
  });

  it('renders AHEAD of the stepper, not inside it', () => {
    renderFlow(withPrompts);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('posts the trimmed answers and hydrates from the response', async () => {
    const user = userEvent.setup();
    postApplicationPromptAnswers.mockResolvedValue({ kind: 'saved', state: serverState() });
    renderFlow(withPrompts);

    await user.type(screen.getByLabelText('How long have you poured concrete?'), '  Six years  ');
    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.prompts.submit'),
    }));

    await waitFor(() => expect(postApplicationPromptAnswers).toHaveBeenCalledWith(
      'tok', 'app-1', { p1: 'Six years' },
    ));
    // Hydrated: the top-up is gone and the stepper has taken over.
    await waitFor(() => expect(screen.getByRole('navigation')).toBeInTheDocument());
  });

  it('shows only the OUTSTANDING prompts -- an answered one is write-once', () => {
    renderFlow(serverState({
      job: {
        pre_application_prompts: [
          { id: 'p1', text: 'Already answered on WhatsApp' },
          { id: 'p2', text: 'Still outstanding' },
        ],
      },
      prompt_answers: { p1: 'yes' },
      remaining: remaining({ prompts: ['p2'], complete: false }),
    }));
    expect(screen.queryByLabelText('Already answered on WhatsApp')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Still outstanding')).toBeInTheDocument();
  });
});

describe('ApplicationRequirementsFlow — saving field answers', () => {
  const withField = serverState({
    job: { required_fields: ['work_authorization'] },
    remaining: remaining({
      fields: ['work_authorization'],
      counts: { prompts: 0, fields: 1, certifications: 0, docs: 0 },
      complete: false,
    }),
  });

  it('does not POST when nothing was touched -- it just advances', async () => {
    const user = userEvent.setup();
    renderFlow(serverState());
    // Nothing outstanding, so the flow opens on review; step back to details.
    await user.click(screen.getByRole('button', {
      name: new RegExp(message('worker_application_details.steps.details')),
    }));
    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.continue_button'),
    }));
    expect(postApplicationAnswers).not.toHaveBeenCalled();
  });

  it('marks the field the door rejected', async () => {
    const user = userEvent.setup();
    postApplicationAnswers.mockResolvedValue({
      kind: 'invalid', errors: { work_authorization: 'invalid_value' },
    });
    renderFlow(withField);

    await user.click(screen.getByRole('radio', { name: message('job_requirements.apply.yes') }));
    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.continue_button'),
    }));

    await waitFor(() => expect(
      screen.getByText(message('worker_application_details.errors.invalid_batch')),
    ).toBeInTheDocument());
    // Still on the form -- a rejected batch stored nothing and must be fixable.
    expect(screen.getByRole('radio', { name: message('job_requirements.apply.yes') })).toBeInTheDocument();
  });

  it('a blocked write swaps in the fresh state and shows ITS terminal panel', async () => {
    const user = userEvent.setup();
    postApplicationAnswers.mockResolvedValue({
      kind: 'blocked',
      reason: 'application_closed',
      state: serverState({ job: { status: 'closed' } }),
    });
    renderFlow(withField);

    await user.click(screen.getByRole('radio', { name: message('job_requirements.apply.yes') }));
    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.continue_button'),
    }));

    await waitFor(() => expect(
      screen.getByText(message('worker_application_details.terminal.closed')),
    ).toBeInTheDocument());
  });

  /**
   * F2 (Luis ruling, sprint 26). The web door used to accept edits to an
   * application the employer already had, while WhatsApp refused them. It now
   * answers 409 `application_locked` with the fresh state -- which must land
   * as the read-only panel plus the WhatsApp instruction, not as a thrown
   * error page and not as an inline "something went wrong".
   */
  it('a 409 application_locked write renders the read-only panel and says to use WhatsApp', async () => {
    const user = userEvent.setup();
    postApplicationAnswers.mockResolvedValue({
      kind: 'blocked',
      reason: 'application_locked',
      state: serverState({ application: { details_completed_at: '2026-09-02T00:00:00Z' } }),
    });
    renderFlow(withField);

    await user.click(screen.getByRole('radio', { name: message('job_requirements.apply.yes') }));
    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.continue_button'),
    }));

    await waitFor(() => expect(
      screen.getByText(message('worker_application_details.terminal.already_complete')),
    ).toBeInTheDocument());
    expect(screen.getByText(message('worker_application_details.terminal.already_complete_note')))
      .toBeInTheDocument();
    // The form is gone: read-only means there is nothing left to submit.
    expect(screen.queryByRole('radio', { name: message('job_requirements.apply.yes') }))
      .not.toBeInTheDocument();
  });

  it('renders too_large as an inline error, not a thrown page', async () => {
    const user = userEvent.setup();
    postApplicationAnswers.mockResolvedValue({ kind: 'too_large' });
    renderFlow(withField);

    await user.click(screen.getByRole('radio', { name: message('job_requirements.apply.yes') }));
    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.continue_button'),
    }));

    await waitFor(() => expect(
      screen.getByText(message('worker_application_details.errors.too_large')),
    ).toBeInTheDocument());
  });
});

/**
 * R2. Finish used to be a re-read, because the door completed an application
 * on ANY GET. That made sending something a page load could do TO a worker:
 * WhatsApp's armFill pre-fills saved answers and vault documents and then
 * waits at its LISTO consent gate, so simply opening this page sent the
 * application, and F2's lock refused every correction afterwards.
 */
describe('ApplicationRequirementsFlow — Finish is the completion act', () => {
  it('completes through an explicit POST, not a re-read', async () => {
    const user = userEvent.setup();
    postApplicationComplete.mockResolvedValue({
      kind: 'saved',
      state: serverState({ application: { details_completed_at: '2026-09-02T00:00:00Z' } }),
    });
    renderFlow(serverState());

    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.review.finish'),
    }));

    await waitFor(() => expect(
      screen.getByText(message('worker_application_details.complete.title')),
    ).toBeInTheDocument());
    expect(postApplicationComplete).toHaveBeenCalledTimes(1);
    // The GET must NOT be what completes it any more.
    expect(getApplicationRequirements).not.toHaveBeenCalled();
    expect(postApplicationAnswers).not.toHaveBeenCalled();
  });

  it('renders the read-only panel when completion comes back 409 locked', async () => {
    const user = userEvent.setup();
    postApplicationComplete.mockResolvedValue({
      kind: 'blocked',
      reason: 'application_locked',
      state: serverState({ application: { details_completed_at: '2026-09-02T00:00:00Z' } }),
    });
    renderFlow(serverState());

    await user.click(screen.getByRole('button', {
      name: message('worker_application_details.review.finish'),
    }));

    await waitFor(() => expect(
      screen.getByText(message('worker_application_details.terminal.already_complete')),
    ).toBeInTheDocument());
  });

  it('blocks Finish and names what is missing while the server still owes something', () => {
    renderFlow(serverState({
      job: { required_fields: ['date_available'] },
      remaining: remaining({
        fields: ['date_available'],
        counts: { prompts: 0, fields: 1, certifications: 0, docs: 0 },
        complete: false,
      }),
    }));
    // Opens on details; walk to review via the nav is blocked, so check the
    // gate from the review step the flow would render.
    expect(screen.getByRole('button', {
      name: new RegExp(message('worker_application_details.steps.review')),
    })).toBeDisabled();
  });
});

describe('ApplicationRequirementsFlow — defaults', () => {
  it('does NOT merge defaults when the server already has answers', async () => {
    renderFlow(serverState({ answers: { work_authorization: true } }));
    await waitFor(() => expect(getVaultDocuments).toHaveBeenCalled());
    expect(getApplicationDefaults).not.toHaveBeenCalled();
  });

  it('merges them once when the door opens with nothing stored', async () => {
    renderFlow(serverState());
    await waitFor(() => expect(getApplicationDefaults).toHaveBeenCalledOnce());
  });
});

describe('ApplicationRequirementsFlow — progress and locale', () => {
  it('states what is left', () => {
    renderFlow(serverState({
      job: { required_fields: ['work_authorization', 'date_available'] },
      remaining: remaining({
        fields: ['date_available'],
        counts: { prompts: 0, fields: 1, certifications: 0, docs: 0 },
        complete: false,
      }),
    }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('renders in Spanish from the real catalogue', () => {
    renderFlow(serverState({ job: { status: 'closed' } }), 'es');
    expect(screen.getByText(message('worker_application_details.terminal.closed', 'es')))
      .toBeInTheDocument();
  });
});
