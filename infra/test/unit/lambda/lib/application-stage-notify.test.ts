import type { PoolClient } from 'pg';
import {
  buildApplicationStageMessage,
  enqueueApplicationStageNotification,
  registerApplicationStageRenderer,
} from '../../../../lambda/lib/application-stage-notify';
import {
  _clearCategoryRenderersForTests,
  enqueueWorkerMessage,
  registerCategoryRenderer,
} from '../../../../lambda/whatsapp/lib/worker-delivery-gateway';
import type { CategoryRenderer, WorkerMessageIntentInput } from '../../../../lambda/whatsapp/lib/onboarding-types';

jest.mock('../../../../lambda/whatsapp/lib/worker-delivery-gateway', () => {
  const actual = jest.requireActual('../../../../lambda/whatsapp/lib/worker-delivery-gateway');
  return {
    ...actual,
    registerCategoryRenderer: jest.fn(
      (category: string, renderer: unknown) => actual.registerCategoryRenderer(category, renderer),
    ),
    enqueueWorkerMessage: jest.fn(),
  };
});

const mockEnqueueWorkerMessage = enqueueWorkerMessage as jest.Mock;
const mockRegisterCategoryRenderer = registerCategoryRenderer as jest.Mock;

const APPLICATION_ID = '33333333-3333-4333-8333-333333333333';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const UPDATED_AT = new Date('2026-09-02T12:00:00.000Z');

function fakeClient(rows: Array<Record<string, unknown>> = []): PoolClient {
  return { query: jest.fn().mockResolvedValue({ rowCount: rows.length, rows }) } as unknown as PoolClient;
}

function notifyInput(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: APPLICATION_ID,
    workerId: WORKER_ID,
    kind: 'details_requested' as const,
    jobId: JOB_ID,
    jobTitle: 'Concrete Finisher',
    companyName: 'RM Construction',
    frontendBaseUrl: 'https://jaleapp.ai',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('buildApplicationStageMessage', () => {
  const base = {
    kind: 'details_requested' as const,
    jobTitle: 'Concrete Finisher',
    companyName: 'RM Construction',
    applicationId: APPLICATION_ID,
    url: `https://jaleapp.ai/es/worker/applications/${APPLICATION_ID}`,
  };

  it('builds the Spanish details_requested content template', () => {
    const message = buildApplicationStageMessage('es', base);

    expect(message.contentTemplate).toBe('application_update_es');
    expect(message.body).toBe(
      'RM Construction quiere avanzar con tu aplicacion para Concrete Finisher y necesita algunos datos mas. '
      + `Escribe "aplicaciones" para responder aqui, o entra en https://jaleapp.ai/es/worker/applications/${APPLICATION_ID}`,
    );
    expect(message.contentVariables).toEqual({
      '1': 'Concrete Finisher',
      '2': 'RM Construction',
      '3': `app-${APPLICATION_ID}`,
      '4': `https://jaleapp.ai/es/worker/applications/${APPLICATION_ID}`,
      __fallback_body: message.body,
    });
  });

  it('builds the English details_requested content template', () => {
    const url = `https://jaleapp.ai/en/worker/applications/${APPLICATION_ID}`;
    const message = buildApplicationStageMessage('en', { ...base, url });

    expect(message.contentTemplate).toBe('application_update_en');
    expect(message.body).toBe(
      'RM Construction wants to move forward with your application for Concrete Finisher and needs a few more details. '
      + `Reply "applications" to answer here, or go to ${url}`,
    );
    expect(message.contentVariables['4']).toBe(url);
    expect(message.contentVariables.__fallback_body).toBe(message.body);
  });

  it('builds the Spanish hired content template', () => {
    const message = buildApplicationStageMessage('es', { ...base, kind: 'hired' });

    expect(message.contentTemplate).toBe('application_hired_es');
    expect(message.body).toBe(
      'Buenas noticias: RM Construction te selecciono para Concrete Finisher. '
      + `Te contactaran para los siguientes pasos. Detalles: ${base.url}`,
    );
  });

  it('builds the English hired content template', () => {
    const url = `https://jaleapp.ai/en/worker/applications/${APPLICATION_ID}`;
    const message = buildApplicationStageMessage('en', { ...base, kind: 'hired', url });

    expect(message.contentTemplate).toBe('application_hired_en');
    expect(message.body).toBe(
      'Good news: RM Construction selected you for Concrete Finisher. '
      + `They will contact you about next steps. Details: ${url}`,
    );
  });

  it('emits ASCII-only copy', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const kind of ['details_requested', 'hired'] as const) {
        expect(buildApplicationStageMessage(lang, { ...base, kind }).body).toMatch(/^[\x00-\x7F]*$/);
      }
    }
  });

  it('throws when the application id is not a UUID', () => {
    expect(() => buildApplicationStageMessage('es', { ...base, applicationId: 'app-1' })).toThrow(
      /application_id/,
    );
  });
});

describe('enqueueApplicationStageNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearCategoryRenderersForTests();
    mockEnqueueWorkerMessage.mockResolvedValue({
      intentId: 'intent-1',
      decision: { action: 'allow', reason: 'worker_ready' },
      outboxMaterialized: true,
    });
  });

  afterEach(() => {
    _clearCategoryRenderersForTests();
  });

  it('registers the account renderer and enqueues without touching either RLS GUC', async () => {
    const client = fakeClient();

    const result = await enqueueApplicationStageNotification(client, notifyInput());

    expect(result).toEqual({
      outcome: 'enqueued',
      intentId: 'intent-1',
      decision: { action: 'allow', reason: 'worker_ready' },
      outboxMaterialized: true,
    });
    expect(mockRegisterCategoryRenderer).toHaveBeenCalledWith('account', expect.any(Function));
    // The employer's users.id must stay in app.current_internal_user_id for the
    // whole transaction (see the module's RLS CONTRACT): switching it to the
    // worker here hides the worker row from users_employer_applicant_read and
    // silently drops every notification.
    const setConfigCalls = (client.query as jest.Mock).mock.calls
      .filter(([sql]: [string]) => typeof sql === 'string' && sql.includes('set_config'));
    expect(setConfigCalls).toHaveLength(0);
  });

  it('passes the exact worker message intent input', async () => {
    const client = fakeClient();
    const before = Date.now();

    await enqueueApplicationStageNotification(client, notifyInput({ kind: 'hired' }));

    const [, input] = mockEnqueueWorkerMessage.mock.calls[0] as [PoolClient, WorkerMessageIntentInput];
    expect(input.workerId).toBe(WORKER_ID);
    expect(input.category).toBe('account');
    expect(input.ownerService).toBe('account');
    expect(input.sourceType).toBe('application_stage');
    expect(input.sourceId).toBe(APPLICATION_ID);
    expect(input.dedupeKey).toBe(`application-stage:${APPLICATION_ID}:hired:${UPDATED_AT.getTime()}`);
    expect(input.priority).toBe(30);
    expect(input.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000);
    expect(input.payload).toEqual({
      kind: 'application_stage',
      status: 'hired',
      applicationId: APPLICATION_ID,
      jobId: JOB_ID,
      jobTitle: 'Concrete Finisher',
      companyName: 'RM Construction',
      frontendBaseUrl: 'https://jaleapp.ai',
    });
  });

  it('reports renderer_unavailable instead of throwing', async () => {
    mockEnqueueWorkerMessage.mockRejectedValue(new Error('renderer_unavailable:account'));
    const client = fakeClient();

    const result = await enqueueApplicationStageNotification(client, notifyInput());

    expect(result).toEqual({ outcome: 'renderer_unavailable', reason: 'renderer_unavailable' });
  });

  it('propagates any other enqueue error', async () => {
    mockEnqueueWorkerMessage.mockRejectedValue(new Error('boom'));
    const client = fakeClient();

    await expect(enqueueApplicationStageNotification(client, notifyInput())).rejects.toThrow('boom');
  });
});

describe('registerApplicationStageRenderer', () => {
  let renderer: CategoryRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    _clearCategoryRenderersForTests();
    registerApplicationStageRenderer();
    renderer = mockRegisterCategoryRenderer.mock.calls[0][1] as CategoryRenderer;
  });

  afterEach(() => {
    _clearCategoryRenderersForTests();
  });

  function intent(payload: Record<string, unknown>): WorkerMessageIntentInput {
    return {
      workerId: WORKER_ID,
      category: 'account',
      ownerService: 'account',
      sourceType: 'application_stage',
      sourceId: APPLICATION_ID,
      dedupeKey: 'k',
      priority: 30,
      expiresAt: null,
      payload,
    };
  }

  const payload = {
    kind: 'application_stage',
    status: 'details_requested',
    applicationId: APPLICATION_ID,
    jobId: JOB_ID,
    jobTitle: 'Concrete Finisher',
    companyName: 'RM Construction',
    frontendBaseUrl: 'https://jaleapp.ai/',
  };

  it('renders the content template with the recipient language and a normalized url', async () => {
    const client = fakeClient([{ whatsapp_number: '+15550001111', preferred_language: 'en' }]);

    const rendered = await renderer(client, intent(payload));

    expect(rendered).toEqual({
      whatsappNumber: '+15550001111',
      body: null,
      contentTemplate: 'application_update_en',
      contentVariables: expect.objectContaining({
        '1': 'Concrete Finisher',
        '2': 'RM Construction',
        '3': `app-${APPLICATION_ID}`,
        '4': `https://jaleapp.ai/en/worker/applications/${APPLICATION_ID}`,
      }),
    });
    expect(rendered!.contentVariables!.__fallback_body).toContain('RM Construction');
  });

  it('defaults to Spanish when that is the worker preference', async () => {
    const client = fakeClient([{ whatsapp_number: '+15550001111', preferred_language: 'es' }]);

    const rendered = await renderer(client, intent({ ...payload, status: 'hired' }));

    expect(rendered!.contentTemplate).toBe('application_hired_es');
    expect(rendered!.contentVariables!['4']).toBe(`https://jaleapp.ai/es/worker/applications/${APPLICATION_ID}`);
  });

  it('signals unavailable (null) when the worker has no verified number', async () => {
    const client = fakeClient([{ whatsapp_number: null, preferred_language: 'es' }]);

    await expect(renderer(client, intent(payload))).resolves.toBeNull();
  });

  it('signals unavailable (null) when the worker row is missing', async () => {
    const client = fakeClient([]);

    await expect(renderer(client, intent(payload))).resolves.toBeNull();
  });

  it('signals unavailable (null) for a payload this renderer does not own', async () => {
    const client = fakeClient([{ whatsapp_number: '+15550001111', preferred_language: 'es' }]);

    await expect(renderer(client, intent({ kind: 'something_else' }))).resolves.toBeNull();
  });
});
