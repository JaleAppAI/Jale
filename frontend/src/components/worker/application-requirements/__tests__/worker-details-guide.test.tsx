// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { Spotlight } from '@/components/tutorials/spotlight/Spotlight';
import guide from '@/components/tutorials/guides/worker-details';
import type {
  ApplicationRequirementsRemaining,
  ApplicationRequirementsState,
  JobFieldKey,
  WorkerVaultDoc,
} from '@/lib/api/worker';

/*
 * W3's step-by-step guide over the REAL details flow: every panel, every
 * question type, every document state and both endings of Check & finish.
 * The API is stubbed; the flow, its reducer and the spotlight engine are
 * real. jsdom does no layout, so every element reports one box.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ replace: vi.fn() }),
}));

const api = vi.hoisted(() => ({
  getApplicationRequirements: vi.fn(),
  getApplicationDefaults: vi.fn(),
  getVaultDocuments: vi.fn(),
  postApplicationAnswers: vi.fn(),
  postApplicationComplete: vi.fn(),
  postApplicationCertifications: vi.fn(),
  postApplicationPromptAnswers: vi.fn(),
  getAuthUploadUrl: vi.fn(),
  uploadFileToS3: vi.fn(),
  confirmAuthUpload: vi.fn(),
}));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplicationRequirements: (...a: unknown[]) => api.getApplicationRequirements(...a),
  getApplicationDefaults: (...a: unknown[]) => api.getApplicationDefaults(...a),
  getVaultDocuments: (...a: unknown[]) => api.getVaultDocuments(...a),
  postApplicationAnswers: (...a: unknown[]) => api.postApplicationAnswers(...a),
  postApplicationComplete: (...a: unknown[]) => api.postApplicationComplete(...a),
  postApplicationCertifications: (...a: unknown[]) => api.postApplicationCertifications(...a),
  postApplicationPromptAnswers: (...a: unknown[]) => api.postApplicationPromptAnswers(...a),
  getAuthUploadUrl: (...a: unknown[]) => api.getAuthUploadUrl(...a),
  uploadFileToS3: (...a: unknown[]) => api.uploadFileToS3(...a),
  confirmAuthUpload: (...a: unknown[]) => api.confirmAuthUpload(...a),
}));

import { ApplicationRequirementsFlow } from '../ApplicationRequirementsFlow';

// ---------------------------------------------------------------------------
// State documents

function remaining(over: Partial<ApplicationRequirementsRemaining> = {}): ApplicationRequirementsRemaining {
  return {
    prompts: [],
    fields: [],
    certifications: { unclaimed: [], unproven: [] },
    docs: [],
    counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 },
    complete: false,
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

/** A job asking these questions, none answered yet: the flow opens on Details. */
function askingFields(required: JobFieldKey[], optional: JobFieldKey[] = []): ApplicationRequirementsState {
  return serverState({
    job: { required_fields: required, optional_fields: optional },
    remaining: remaining({ fields: [...required] }),
  });
}

/** A job asking these documents, nothing else: the flow opens on Documents & certifications. */
function askingDocs(
  job: Partial<ApplicationRequirementsState['job']>,
  missing: string[] = ['resume'],
): ApplicationRequirementsState {
  return serverState({ job, remaining: remaining({ docs: missing }) });
}

function vaultDoc(over: Partial<WorkerVaultDoc> & Pick<WorkerVaultDoc, 'doc_type'>): WorkerVaultDoc {
  return {
    id: `doc-${over.doc_type}`,
    file_name: 'file.pdf',
    file_size: 1000,
    uploaded_at: '2026-09-01T10:00:00Z',
    url: 'https://files.test/file.pdf',
    cert_name: null,
    ...over,
  } as WorkerVaultDoc;
}

// ---------------------------------------------------------------------------
// The page and the engine

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.closest('[data-hidden]') ? [] : [{}]) as unknown as DOMRectList;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    top: 100, left: 40, width: 300, height: 60, x: 40, y: 100, right: 340, bottom: 160, toJSON: () => ({}),
  }) as DOMRect);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  document.body.style.overflow = '';
  api.getVaultDocuments.mockResolvedValue({ documents: [] });
  api.getApplicationDefaults.mockResolvedValue({ answers: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const onDismiss = vi.fn();
const onUnavailable = vi.fn();
const catalogues = { en, es } as const;

function renderGuided(state: ApplicationRequirementsState, locale: 'en' | 'es' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
      <OverlayPresenceProvider>
        <ApplicationRequirementsFlow token="tok" initialState={state} />
        <Spotlight
          name="worker_details"
          resolve="lazy"
          steps={guide.steps}
          intro={{
            ...guide.intro,
            startKey: 'tutorial.common.guide.worker.start',
            notNowKey: 'tutorial.common.guide.self',
          }}
          counterKey={guide.counterKey}
          endKey="tutorial.common.guide.end"
          waitMs={50}
          onDismiss={onDismiss}
          onUnavailable={onUnavailable}
        />
      </OverlayPresenceProvider>
    </NextIntlClientProvider>,
  );
}

/** Lets fetches, the page-watching observers and the short waits run. */
async function flush(ms = 0) {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

function callout(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('[data-spotlight] [role="dialog"]');
  return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
}

const stepNow = () => callout()?.getAttribute('data-step') ?? null;

async function expectStep(id: string | null) {
  await vi.waitFor(() => expect(stepNow()).toBe(id), { timeout: 2000 });
}

function calloutButton(name: string | RegExp) {
  const card = callout();
  if (!card) throw new Error('no callout');
  return within(card).getByRole('button', { name });
}

const queryCalloutButton = (name: string | RegExp) => {
  const card = callout();
  return card ? within(card).queryByRole('button', { name }) : null;
};

async function press(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
  await flush();
}

/** Renders the flow with the guide, waits for the intro and presses "Guide me". */
async function start(state: ApplicationRequirementsState, locale: 'en' | 'es' = 'en') {
  renderGuided(state, locale);
  await flush();
  await expectStep('intro');
  await press(calloutButton(locale === 'en' ? 'Guide me' : 'Guíame'));
}

async function next() {
  await press(calloutButton(/^(Next|Got it)$/));
}

const row = (key: string) => document.querySelector<HTMLElement>(`[data-guide="details.field.${key}"]`) as HTMLElement;

function type(field: Element, value: string) {
  fireEvent.change(field, { target: { value } });
}

async function typeIn(field: Element, value: string) {
  await act(async () => type(field, value));
  await flush();
}

function inputIn(container: Element, placeholder: string): HTMLElement {
  return within(container as HTMLElement).getByPlaceholderText(placeholder);
}

const saveAndContinue = () => screen.getByRole('button', { name: 'Save and continue' });

// ---------------------------------------------------------------------------

describe('worker_details guide — where it starts', () => {
  it('starts with the employer’s questions when some are left from applying', async () => {
    api.postApplicationPromptAnswers.mockResolvedValue({
      kind: 'saved',
      state: askingFields(['work_authorization']),
    });
    await start(serverState({
      job: {
        required_fields: ['work_authorization'],
        pre_application_prompts: [{ id: 'p1', text: 'Do you have your own tools?' }, { id: 'p2', text: 'Can you lift 50 lb?' }],
      },
      remaining: remaining({ prompts: ['p1', 'p2'], fields: ['work_authorization'] }),
    }));

    // One box per step: ten together would not fit a phone screen.
    await expectStep('prompt_1');
    expect(callout()).toHaveTextContent('Answer this question in its box');
    expect(calloutButton('Next')).toBeDisabled();
    const boxes = screen.getAllByRole('textbox');
    await typeIn(boxes[0], 'Yes, a full set');
    expect(calloutButton('Next')).toBeEnabled();
    await next();

    await expectStep('prompt_2');
    expect(callout()).toHaveTextContent('One more question');
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(boxes[1], 'x'.repeat(1001));
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(boxes[1], 'Yes');
    await next();

    await expectStep('prompts_save');
    expect(queryCalloutButton('Next')).toBeNull();
    await press(screen.getByRole('button', { name: 'Save and continue' }));

    expect(api.postApplicationPromptAnswers).toHaveBeenCalledWith('tok', 'app-1', { p1: 'Yes, a full set', p2: 'Yes' });
    await expectStep('overview');
  });

  it('ends at once after the employer’s questions when details were never requested', async () => {
    const notRequested = (prompts: string[]) => serverState({
      application: { status: 'pending', details_status: 'not_requested', stage: 'apply', details_requested_at: null },
      job: { pre_application_prompts: [{ id: 'p1', text: 'Do you have your own tools?' }] },
      remaining: remaining({ prompts }),
    });
    api.postApplicationPromptAnswers.mockResolvedValue({ kind: 'saved', state: notRequested([]) });
    await start(notRequested(['p1']));
    await expectStep('prompt_1');
    await typeIn(screen.getByRole('textbox'), 'Yes');
    await next();
    await press(screen.getByRole('button', { name: 'Save and continue' }));

    // The "nothing to add yet" panel: no step applies there, so nothing waits.
    await flush();
    expect(onDismiss).toHaveBeenCalledWith('completed');
    expect(callout()).toBeNull();
  });

  it('keeps the save step up when saving the employer’s questions fails', async () => {
    api.postApplicationPromptAnswers.mockRejectedValue(new TypeError('offline'));
    await start(serverState({
      job: { pre_application_prompts: [{ id: 'p1', text: 'Do you have your own tools?' }] },
      remaining: remaining({ prompts: ['p1'] }),
    }));
    await expectStep('prompt_1');
    await typeIn(screen.getByRole('textbox'), 'Yes');
    await next();
    await press(screen.getByRole('button', { name: 'Save and continue' }));

    await flush(60);
    expect(stepNow()).toBe('prompts_save');
  });

  it('opens on the overview, and waits for the saved files before its Next', async () => {
    let answerVault!: (value: { documents: WorkerVaultDoc[] }) => void;
    api.getVaultDocuments.mockReturnValue(new Promise((resolve) => { answerVault = resolve; }));
    await start(askingFields(['date_available']));

    await expectStep('overview');
    expect(calloutButton('Next')).toBeDisabled();
    expect(callout()).toHaveTextContent('One moment: checking your saved files.');

    await act(async () => answerVault({ documents: [] }));
    await flush();
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('shows the stepper on the overview without letting it be pressed (a step chip saves nothing)', async () => {
    await start(askingFields(['date_available']));
    await expectStep('overview');
    // Look only: a blocker covers the cutout, so the chips under it take no press.
    expect(document.querySelector('[data-spotlight-blocker="hole"]')).not.toBeNull();
    expect(callout()).toHaveTextContent('Details, Documents & certifications, then Check & finish.');
  });

  it('skips the Details steps without waiting when the flow opens on Documents & certifications', async () => {
    api.getVaultDocuments.mockResolvedValue({ documents: [] });
    await start(serverState({
      job: { required_fields: ['date_available'], required_docs: ['resume'] },
      answers: { date_available: '2026-09-15' },
      remaining: remaining({ docs: ['resume'] }),
    }));

    await expectStep('overview');
    await next();
    // No 8-second waits: the Details steps do not apply, so the next step is at once the resume.
    await expectStep('doc_resume_upload');
  });

  it('is unavailable over a terminal panel', async () => {
    renderGuided(serverState({ job: { status: 'closed' } }));
    await flush(60);
    expect(onUnavailable).toHaveBeenCalled();
    expect(callout()).toBeNull();
  });

  it('speaks Spanish, as tú', async () => {
    await start(askingFields(['date_available']), 'es');
    await expectStep('overview');
    expect(callout()).toHaveTextContent('Tres pasos');
    // The overview, the date, Save and continue, then Continue and the summary counted ahead.
    expect(callout()).toHaveTextContent('Tus datos · 1 de 5');
  });
});

describe('worker_details guide — the Details questions', () => {
  it('points at each question the job asks, in the form’s order, and only those', async () => {
    await start(askingFields(['date_available', 'work_authorization'], ['education']));
    await expectStep('overview');
    await next();
    await expectStep('field_work_authorization');
    await press(within(row('work_authorization')).getByRole('radio', { name: 'No' }));
    await expectStep('field_date_available');
    await typeIn(within(row('date_available')).getByDisplayValue(''), '2026-10-01');
    await next();
    await expectStep('field_education_optional');
    await next();
    await expectStep('details_continue');
  });

  it('moves on by itself once Yes or No is tapped for work authorization', async () => {
    await start(askingFields(['work_authorization', 'date_available']));
    await next();
    await expectStep('field_work_authorization');
    expect(queryCalloutButton('Next')).toBeNull();
    await press(within(row('work_authorization')).getByRole('radio', { name: 'Yes' }));
    await expectStep('field_date_available');
  });

  it('shows Next, without moving on, for a question filled in from the last application', async () => {
    api.getApplicationDefaults.mockResolvedValue({ answers: { work_authorization: true } });
    await start(askingFields(['work_authorization', 'date_available']));
    await next();
    await expectStep('field_work_authorization');
    expect(within(row('work_authorization')).getByText('From your last application')).toBeInTheDocument();
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('waits for a date on the date questions', async () => {
    await start(askingFields(['date_available', 'date_of_birth']));
    await next();
    await expectStep('field_date_available');
    expect(calloutButton('Next')).toBeDisabled();
    expect(callout()).toHaveTextContent('Pick a date to continue.');
    await typeIn(row('date_available').querySelector('input') as HTMLElement, '2026-10-01');
    await next();
    await expectStep('field_date_of_birth');
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(row('date_of_birth').querySelector('input') as HTMLElement, '1990-05-04');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('wants desired pay in whole dollars', async () => {
    await start(askingFields(['desired_pay']));
    await next();
    await expectStep('field_desired_pay');
    expect(callout()).toHaveTextContent('Hourly, Daily, Weekly, Monthly or Fixed (flat rate)');
    const amount = row('desired_pay').querySelector('input') as HTMLElement;
    await typeIn(amount, '18.50');
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(amount, '18');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('wants a 2-letter state and a 5-digit ZIP in the address', async () => {
    await start(askingFields(['home_address']));
    await next();
    await expectStep('field_home_address');
    const address = row('home_address');
    await typeIn(inputIn(address, 'Street address'), '12 Main St');
    await typeIn(inputIn(address, 'City'), 'Austin');
    await typeIn(inputIn(address, 'State'), 'Texas');
    await typeIn(inputIn(address, 'ZIP code'), '787');
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(inputIn(address, 'State'), 'tx');
    await typeIn(inputIn(address, 'ZIP code'), '78701');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('wants a name and a real phone number for the emergency contact', async () => {
    await start(askingFields(['emergency_contact']));
    await next();
    await expectStep('field_emergency_contact');
    const contact = row('emergency_contact');
    await typeIn(inputIn(contact, 'Name'), 'Ana Ruiz');
    await typeIn(inputIn(contact, 'Phone'), '12');
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(inputIn(contact, 'Phone'), '(512) 555-0100');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('waits for Yes or No on worked here before and military service, leaving the extra boxes optional', async () => {
    await start(askingFields(['worked_here_before', 'military_service']));
    await next();
    await expectStep('field_worked_here_before');
    expect(calloutButton('Next')).toBeDisabled();
    await press(within(row('worked_here_before')).getByRole('radio', { name: 'Yes' }));
    expect(stepNow()).toBe('field_worked_here_before');
    expect(within(row('worked_here_before')).getByPlaceholderText('When did you work here?')).toBeInTheDocument();
    await next();
    await expectStep('field_military_service');
    await press(within(row('military_service')).getByRole('radio', { name: 'Yes' }));
    expect(within(row('military_service')).getByPlaceholderText('Branch')).toBeInTheDocument();
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('waits for a school level on education', async () => {
    await start(askingFields(['education']));
    await next();
    await expectStep('field_education');
    expect(calloutButton('Next')).toBeDisabled();
    await act(async () => fireEvent.change(row('education').querySelector('select') as HTMLElement, { target: { value: 'high_school' } }));
    await flush();
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('starts references empty: ready only after Add reference and a name, relationship and phone', async () => {
    await start(askingFields(['references']));
    await next();
    await expectStep('field_references');
    expect(callout()).toHaveTextContent('Add reference');
    expect(calloutButton('Next')).toBeDisabled();
    await press(within(row('references')).getByRole('button', { name: 'Add reference' }));
    const refs = row('references');
    await typeIn(inputIn(refs, 'Name'), 'Luz Gomez');
    await typeIn(inputIn(refs, 'Relationship'), 'Former boss');
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(inputIn(refs, 'Phone'), '512 555 0101');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('says references stop at 3, as the form does', async () => {
    await start(askingFields(['references']));
    await next();
    await expectStep('field_references');
    expect(callout()).toHaveTextContent('You can add up to 3.');
    for (let added = 0; added < 3; added += 1) {
      await press(within(row('references')).getByRole('button', { name: 'Add reference' }));
    }
    expect(within(row('references')).queryByRole('button', { name: 'Add reference' })).not.toBeInTheDocument();
  });

  it('starts work history empty: ready only after Add previous job and a company and job title', async () => {
    await start(askingFields(['work_history']));
    await next();
    await expectStep('field_work_history');
    await press(within(row('work_history')).getByRole('button', { name: 'Add previous job' }));
    const jobs = row('work_history');
    await typeIn(inputIn(jobs, 'Company'), 'Acme Concrete');
    expect(calloutButton('Next')).toBeDisabled();
    await typeIn(inputIn(jobs, 'Job title'), 'Finisher');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('offers Skip on an optional question and never holds Next', async () => {
    await start(askingFields(['date_available'], ['references']));
    await next();
    await expectStep('field_date_available');
    await typeIn(row('date_available').querySelector('input') as HTMLElement, '2026-10-01');
    await next();
    await expectStep('field_references_optional');
    expect(callout()).toHaveTextContent('Skip');
    expect(calloutButton('Next')).toBeEnabled();
    await press(within(row('references')).getByRole('button', { name: 'Skip' }));
    expect(within(row('references')).getByRole('button', { name: 'Skipped' })).toBeInTheDocument();
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('stays on Save and continue while a required answer is missing, and moves on once Documents shows', async () => {
    api.postApplicationAnswers.mockResolvedValue({
      kind: 'saved',
      state: serverState({ job: { required_fields: ['date_available'] }, answers: { date_available: '2026-10-01' } }),
    });
    await start(askingFields(['date_available']));
    await next();
    await expectStep('field_date_available');
    // Save and continue with the date still empty: the form refuses it, and
    // the question's step stays up.
    await press(saveAndContinue());
    expect(stepNow()).toBe('field_date_available');
    await typeIn(row('date_available').querySelector('input') as HTMLElement, '2026-10-01');
    await next();
    await expectStep('details_continue');
    expect(queryCalloutButton('Next')).toBeNull();
    await press(saveAndContinue());
    await expectStep('documents_continue');
    expect(api.postApplicationAnswers).toHaveBeenCalledWith('tok', 'app-1', { date_available: '2026-10-01' });
  });

  it('stays on Save and continue when the save fails', async () => {
    api.postApplicationAnswers.mockRejectedValue(new TypeError('offline'));
    await start(askingFields(['work_authorization']));
    await next();
    await press(within(row('work_authorization')).getByRole('radio', { name: 'Yes' }));
    await expectStep('details_continue');
    await press(saveAndContinue());
    await flush(60);
    expect(stepNow()).toBe('details_continue');
  });

  it('goes from the overview straight to Save and continue when the Details panel has no questions', async () => {
    // The door still counts a question the job no longer asks (edited between
    // the two reads), so the flow opens on an empty Details panel.
    await start(serverState({ job: { required_docs: ['resume'] }, remaining: remaining({ fields: ['date_available'] }) }));
    await next();
    await expectStep('details_continue');
  });
});

describe('worker_details guide — Documents & certifications', () => {
  it('says a saved document counts by itself: nothing to do, Replace only if wrong', async () => {
    api.getVaultDocuments.mockResolvedValue({ documents: [vaultDoc({ doc_type: 'resume' })] });
    await start(askingDocs({ required_docs: ['resume'] }));
    await next();
    await expectStep('doc_resume_saved');
    expect(callout()).toHaveTextContent('It shows Uploaded, so it counts automatically');
    expect(within(document.querySelector('[data-guide="details.doc.resume"]') as HTMLElement).getByText('Uploaded')).toBeInTheDocument();
    expect(calloutButton('Next')).toBeEnabled();
    await next();
    await expectStep('documents_continue');
  });

  it('moves on by itself once a missing document is uploaded', async () => {
    api.getVaultDocuments.mockResolvedValueOnce({ documents: [] }).mockResolvedValue({
      documents: [vaultDoc({ doc_type: 'driver_license' })],
    });
    api.getAuthUploadUrl.mockResolvedValue({ url: 'https://s3.test/put', s3_key: 'k1' });
    api.uploadFileToS3.mockResolvedValue(undefined);
    api.confirmAuthUpload.mockResolvedValue({});
    api.getApplicationRequirements.mockResolvedValue(askingDocs({ required_docs: ['driver_license'] }, []));
    await start(askingDocs({ required_docs: ['driver_license'] }, ['driver_license']));
    await next();
    await expectStep('doc_driver_license_upload');
    expect(queryCalloutButton('Next')).toBeNull();
    expect(callout()).toHaveTextContent('Upload your driver’s license to continue.');

    const fileInput = document.querySelector('[data-guide="details.doc.driver_license"] input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [new File(['x'], 'license.jpg', { type: 'image/jpeg' })] } });
    });
    await flush();

    expect(api.confirmAuthUpload).toHaveBeenCalled();
    await expectStep('documents_continue');
  });

  it('keeps the upload step up when the upload fails', async () => {
    api.getAuthUploadUrl.mockRejectedValue(new TypeError('offline'));
    await start(askingDocs({ required_docs: ['resume'] }));
    await next();
    await expectStep('doc_resume_upload');
    const fileInput = document.querySelector('[data-guide="details.doc.resume"] input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [new File(['x'], 'cv.pdf', { type: 'application/pdf' })] } });
    });
    await flush(60);
    expect(stepNow()).toBe('doc_resume_upload');
  });

  it('lets an optional document go without a file', async () => {
    await start(askingDocs({ optional_docs: ['work_auth_doc'] }, ['work_auth_doc']));
    await next();
    await expectStep('doc_work_auth_doc_upload_optional');
    expect(callout()).toHaveTextContent('This one is optional');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('starts with Try again when the saved files could not be read, then shows the files as they are', async () => {
    api.getVaultDocuments.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({
      documents: [vaultDoc({ doc_type: 'resume' })],
    });
    api.getApplicationRequirements.mockResolvedValue(askingDocs({ required_docs: ['resume'] }, []));
    await start(askingDocs({ required_docs: ['resume'] }));
    await next();
    await expectStep('vault_retry');
    await press(screen.getByRole('button', { name: 'Try again' }));
    await expectStep('doc_resume_saved');
  });

  it('points at the notice for a document that cannot be uploaded here', async () => {
    await start(askingDocs({ required_docs: ['ssn' as never] }, ['ssn']));
    await next();
    await expectStep('doc_notice_legacy');
    expect(calloutButton('Next')).toBeEnabled();
    await next();
    await expectStep('documents_continue');
  });

  it('points at the notice for a requirement the app does not know', async () => {
    await start(askingDocs({ required_docs: ['mystery_doc' as never] }, ['mystery_doc']));
    await next();
    await expectStep('doc_notice_unknown');
  });

  it('walks the unnamed certification row: ready once a file is added when it is required', async () => {
    api.getVaultDocuments.mockResolvedValueOnce({ documents: [] }).mockResolvedValue({
      documents: [vaultDoc({ doc_type: 'certification_doc' })],
    });
    api.getAuthUploadUrl.mockResolvedValue({ url: 'https://s3.test/put', s3_key: 'k1' });
    api.uploadFileToS3.mockResolvedValue(undefined);
    api.confirmAuthUpload.mockResolvedValue({});
    api.getApplicationRequirements.mockResolvedValue(askingDocs({ required_docs: ['certification_doc'] }, []));
    await start(askingDocs({ required_docs: ['certification_doc'] }, ['certification_doc']));
    await next();
    await expectStep('certification_doc');
    expect(calloutButton('Next')).toBeDisabled();
    const fileInput = document.querySelector('[data-guide="details.doc.certification_doc"] input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [new File(['x'], 'osha.pdf', { type: 'application/pdf' })] } });
    });
    await flush();
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('walks the named certifications: ready once each required one is Yes, with proof where asked', async () => {
    api.getVaultDocuments.mockResolvedValue({
      documents: [vaultDoc({ doc_type: 'certification_doc', cert_name: 'OSHA 10', file_name: 'osha.pdf' })],
    });
    await start(serverState({
      job: {
        certification_requirements: [
          { name: 'OSHA 10', tier: 'required', proof_required: true },
          { name: 'Forklift', tier: 'required', proof_required: false },
          { name: 'First aid', tier: 'optional', proof_required: true },
        ],
      },
      remaining: remaining({ certifications: { unclaimed: ['OSHA 10', 'Forklift'], unproven: [] } }),
    }));
    await next();
    // One row per step: twenty together would not fit a phone screen.
    await expectStep('cert_1');
    expect(callout()).toHaveTextContent('A certification the employer needs');
    expect(calloutButton('Next')).toBeDisabled();
    const osha = document.querySelector('[data-guide="details.cert.1"]') as HTMLElement;
    await press(within(osha).getByRole('radiogroup', { name: 'Do you have OSHA 10?' }).querySelector('[role="radio"]') as HTMLElement);
    expect(within(osha).getByText('Use osha.pdf from your vault')).toBeInTheDocument();
    expect(calloutButton('Next')).toBeEnabled();
    await next();

    await expectStep('cert_2');
    const forklift = document.querySelector('[data-guide="details.cert.2"]') as HTMLElement;
    expect(calloutButton('Next')).toBeDisabled();
    // A required certification answered No still holds the step.
    await press(within(within(forklift).getByRole('radiogroup', { name: 'Do you have Forklift?' })).getByRole('radio', { name: 'No' }));
    expect(calloutButton('Next')).toBeDisabled();
    await press(within(within(forklift).getByRole('radiogroup', { name: 'Do you have Forklift?' })).getByRole('radio', { name: 'Yes' }));
    expect(calloutButton('Next')).toBeEnabled();
    await next();

    // An optional one never holds the step.
    await expectStep('cert_3_optional');
    expect(callout()).toHaveTextContent('An optional certification');
    expect(calloutButton('Next')).toBeEnabled();
  });

  it('does not count a saved certificate filed under another name as proof', async () => {
    api.getVaultDocuments.mockResolvedValue({
      documents: [vaultDoc({ doc_type: 'certification_doc', cert_name: 'OSHA 30', file_name: 'osha30.pdf' })],
    });
    await start(serverState({
      job: { certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: true }] },
      remaining: remaining({ certifications: { unclaimed: ['OSHA 10'], unproven: [] } }),
    }));
    await next();
    await expectStep('cert_1');
    const certs = document.querySelector('[data-guide="details.cert.1"]') as HTMLElement;
    await press(within(certs).getByRole('radio', { name: 'Yes' }));
    expect(within(certs).getByText('Upload new')).toBeInTheDocument();
    expect(within(certs).queryByText(/osha30\.pdf/)).not.toBeInTheDocument();
    expect(calloutButton('Next')).toBeDisabled();
  });

  it('holds the named certifications while a required one asks for proof that is not saved', async () => {
    await start(serverState({
      job: { certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: true }] },
      remaining: remaining({ certifications: { unclaimed: ['OSHA 10'], unproven: [] } }),
    }));
    await next();
    await expectStep('cert_1');
    const certs = document.querySelector('[data-guide="details.cert.1"]') as HTMLElement;
    await press(within(certs).getByRole('radio', { name: 'Yes' }));
    expect(within(certs).getByText('Upload new')).toBeInTheDocument();
    expect(calloutButton('Next')).toBeDisabled();
  });

  it('moves on from Continue once Check & finish shows, and not before', async () => {
    await start(askingDocs({ required_docs: ['resume'] }));
    await next();
    await expectStep('doc_resume_upload');
    // Continue refused: the resume is still missing.
    await press(screen.getByRole('button', { name: 'Continue' }));
    expect(stepNow()).toBe('doc_resume_upload');
  });
});

describe('worker_details guide — Check & finish', () => {
  it('walks the summary, Finish and the completion screen, ending on Got it', async () => {
    api.postApplicationComplete.mockResolvedValue({
      kind: 'saved',
      state: serverState({ application: { details_completed_at: '2026-09-02T10:00:00Z' }, remaining: remaining({ complete: true }) }),
    });
    await start(serverState({ remaining: remaining({ complete: true }) }));
    await next();
    await expectStep('review_summary');
    await next();
    await expectStep('review_finish');
    expect(queryCalloutButton('Next')).toBeNull();
    await press(screen.getByRole('button', { name: 'Finish' }));
    await expectStep('complete');
    expect(calloutButton('Got it')).toBeEnabled();
    await press(calloutButton('Got it'));
    expect(onDismiss).toHaveBeenCalledWith('completed');
  });

  it('keeps Finish up when it comes back not complete', async () => {
    api.postApplicationComplete.mockResolvedValue({ kind: 'saved', state: serverState({ remaining: remaining({ complete: true }) }) });
    await start(serverState({ remaining: remaining({ complete: true }) }));
    await next();
    await next();
    await expectStep('review_finish');
    await press(screen.getByRole('button', { name: 'Finish' }));
    await flush(60);
    expect(stepNow()).toBe('review_finish');
  });

  it('points at the way back when something is still missing, and ends when it is tapped', async () => {
    await start(serverState({
      job: { required_fields: ['date_available'] },
      answers: { date_available: '2026-09-15' },
      remaining: remaining({ fields: ['date_available'] }),
    }));
    // The door still counts the stored date as missing, so the flow opens on Details.
    await next();
    await expectStep('field_date_available');
    await next();
    await expectStep('details_continue');
    await press(saveAndContinue());
    await expectStep('documents_continue');
    await press(screen.getByRole('button', { name: 'Continue' }));
    await expectStep('review_summary');
    await next();
    await expectStep('review_missing');
    // The last step of this branch: the count ends here, and the copy says the guide does too.
    const counter = callout()?.textContent?.match(/Your details · (\d+) of (\d+)/);
    expect(counter?.[1]).toBeDefined();
    expect(counter?.[1]).toBe(counter?.[2]);
    expect(callout()).toHaveTextContent('This guide ends here; you can finish on your own');
    expect(screen.getByRole('button', { name: 'Go to Details' })).toBeInTheDocument();
    await press(screen.getByRole('button', { name: 'Go to Details' }));
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledWith('completed'));
    // Nothing after it: no Finish or completion step comes up on the way out.
    expect(callout()).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Details/, current: 'step' })).toBeInTheDocument();
  });
});
