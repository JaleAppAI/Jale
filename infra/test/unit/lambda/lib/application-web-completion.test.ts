/**
 * application-web-completion.test.ts
 *
 * Sprint 24 round 2, lane 1.5. The WEB door finishes the details stage; the
 * BOT must stop re-sending the step it was still waiting on.
 *
 * Everything here is mocked at the two seams that matter: `client.query`
 * (so the exact SQL and its parameters are assertable) and the worker
 * delivery gateway (so the intent is assertable without a database). The
 * renderer is NOT stubbed -- it is CAPTURED from the mocked
 * `registerCategoryRenderer` and invoked with the very payload the enqueue
 * shipped, which is the only way a body-only send is provable off-database.
 */
import type { PoolClient } from 'pg';

import {
  LANE_RELEASE_SAVEPOINT,
  buildWebCompletionBody,
  releasePromptLaneForApplication,
  releaseWhatsAppLanesForApplication,
} from '../../../../lambda/lib/application-web-completion';
import { FILL_SCRUB_KEYS } from '../../../../lambda/whatsapp/lib/application-fill';
import { PROMPT_LANE_SCRUB_KEYS } from '../../../../lambda/whatsapp/lib/application-prompts';
import {
  enqueueWorkerMessage,
  registerCategoryRenderer,
} from '../../../../lambda/whatsapp/lib/worker-delivery-gateway';
import type { CategoryRenderer } from '../../../../lambda/whatsapp/lib/onboarding-types';

jest.mock('../../../../lambda/whatsapp/lib/worker-delivery-gateway');

const mockEnqueue = enqueueWorkerMessage as jest.Mock;
const mockRegister = registerCategoryRenderer as jest.Mock;

const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKER_ID = '55555555-5555-4555-8555-555555555555';
const APP_ID = '33333333-3333-4333-8333-333333333333';
const CONV_ID = '44444444-4444-4444-8444-444444444444';
const CONV_ID_2 = '66666666-6666-4666-8666-666666666666';
const NUMBER = '+15550001111';

interface ArmedRow {
  id?: string;
  whatsapp_number?: string;
  language?: string;
  updated_at?: string;
  last_inbound_at?: string | null;
  within_session_window?: boolean;
}

/** An armed conversation row as the arm SELECT projects it. */
function armed(overrides: ArmedRow = {}) {
  return {
    id: CONV_ID,
    whatsapp_number: NUMBER,
    language: 'es',
    updated_at: '2026-09-08T11:00:00.000Z',
    last_inbound_at: '2026-09-08T11:00:00.000Z',
    within_session_window: true,
    ...overrides,
  };
}

const mockQuery = jest.fn();
const client = { query: mockQuery } as unknown as PoolClient;

/** Routes by statement shape; `armedRows` is what the arm SELECT returns. */
function stubQueries(armedRows: ReturnType<typeof armed>[]) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM whatsapp_conversations/.test(sql)) {
      return Promise.resolve({ rows: armedRows, rowCount: armedRows.length });
    }
    if (/UPDATE whatsapp_conversations/.test(sql)) {
      return Promise.resolve({ rows: [], rowCount: armedRows.length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const sqlCalls = () => mockQuery.mock.calls.map((call) => String(call[0]));
const callMatching = (re: RegExp) =>
  mockQuery.mock.calls.find((call) => re.test(String(call[0])));

const INPUT = {
  workerId: WORKER_ID,
  applicationId: APP_ID,
  jobTitle: 'Concrete Finisher',
  companyName: null,
  lang: 'es' as const,
};

/**
 * Invokes the renderer the module registered, with the payload the enqueue
 * actually shipped. `client.query` inside the renderer resolves the
 * recipient from the conversation row.
 */
async function renderQueuedMessage(recipientRows: { whatsapp_number: string }[] = [
  { whatsapp_number: NUMBER },
]) {
  expect(mockRegister).toHaveBeenCalledTimes(1);
  const [category, renderer] = mockRegister.mock.calls[0] as ['account', CategoryRenderer];
  expect(category).toBe('account');
  const input = mockEnqueue.mock.calls[0][1];
  const rendererQuery = jest.fn().mockResolvedValue({
    rows: recipientRows, rowCount: recipientRows.length,
  });
  return renderer({ query: rendererQuery } as unknown as PoolClient, input);
}

describe('application-web-completion', () => {
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue({
      intentId: 'i-1',
      decision: { action: 'allow', reason: 'worker_ready' },
      outboxMaterialized: true,
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ── (a) nothing armed ──
  it('does not scrub or enqueue when no conversation is armed for the application', async () => {
    stubQueries([]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });
    expect(sqlCalls().some((sql) => /UPDATE whatsapp_conversations/.test(sql))).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('matches the fill, offer and prompt arms on the application id, scoped to the worker', async () => {
    stubQueries([]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const read = callMatching(/FROM whatsapp_conversations/);
    expect(read).toBeDefined();
    const sql = String(read![0]);
    expect(sql).toMatch(/state_context->>'fill_application_id'\s*=\s*\$2/);
    expect(sql).toMatch(/state_context->>'fill_offer_application_id'\s*=\s*\$2/);
    expect(sql).toMatch(/state_context->>'prompt_application_id'\s*=\s*\$2/);
    expect(sql).toMatch(/c\.user_id = \$1/);
    expect(read![1]).toEqual([WORKER_ID, APP_ID]);
  });

  it('derives the 24h window from the last INBOUND message, not from the conversation row', async () => {
    stubQueries([]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const sql = String(callMatching(/FROM whatsapp_conversations/)![0]);
    expect(sql).toMatch(/whatsapp_processed_messages/);
    expect(sql).toMatch(/first_seen_at/);
    expect(sql).toMatch(/interval '24 hours'/);
  });

  // ── (b) armed, inside the window ──
  it('scrubs every FILL_SCRUB key, scoped to the worker, and queues exactly one closing line', async () => {
    stubQueries([armed()]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: true });

    const update = callMatching(/UPDATE whatsapp_conversations/);
    expect(update).toBeDefined();
    const sql = String(update![0]);
    // jsonb minus text[] REMOVES the keys; the worker id is in the WHERE
    // because `wa_conv_full` is USING (true) and proves no ownership.
    expect(sql).toMatch(/-\s*\$3::text\[\]/);
    expect(sql).toMatch(/user_id = \$2/);
    expect(update![1]).toEqual([[CONV_ID], WORKER_ID, FILL_SCRUB_KEYS]);
    // The keys the bot's own dispatch tail gates on must be in that set.
    expect(FILL_SCRUB_KEYS).toContain('fill_application_id');
    expect(FILL_SCRUB_KEYS).toContain('fill_offer_application_id');
    expect(FILL_SCRUB_KEYS).toContain('prompt_application_id');

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const input = mockEnqueue.mock.calls[0][1];
    expect(input.workerId).toBe(WORKER_ID);
    expect(input.category).toBe('account');
    expect(input.sourceType).toBe('application_web_completion');
    expect(input.sourceId).toBe(APP_ID);
    expect(input.dedupeKey).toBe(`application-web-completion:${APP_ID}`);
    // The phone number must never land in worker_message_intents.payload.
    expect(JSON.stringify(input.payload)).not.toContain(NUMBER);
    expect(input.payload.conversationId).toBe(CONV_ID);
  });

  it('renders the Spanish closing line as a body-only message', async () => {
    stubQueries([armed({ language: 'es' })]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, lang: 'es' });

    await expect(renderQueuedMessage()).resolves.toEqual({
      whatsappNumber: NUMBER,
      body: 'Completaste tu solicitud para Concrete Finisher en la web. Te avisamos por aqui cuando el empleador responda.',
      contentTemplate: null,
      contentVariables: null,
    });
  });

  it('renders the English closing line as a body-only message', async () => {
    stubQueries([armed({ language: 'en' })]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, lang: 'en' });

    await expect(renderQueuedMessage()).resolves.toEqual({
      whatsappNumber: NUMBER,
      body: "You completed your application for Concrete Finisher on the web. We'll let you know here when the employer responds.",
      contentTemplate: null,
      contentVariables: null,
    });
  });

  it("prefers the conversation row's language over the caller's", async () => {
    stubQueries([armed({ language: 'en' })]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, lang: 'es' });

    expect(mockEnqueue.mock.calls[0][1].payload.lang).toBe('en');
  });

  it('falls back to a generic job name when the title is null', () => {
    expect(buildWebCompletionBody('es', null)).toContain('para este empleo en la web');
    expect(buildWebCompletionBody('en', null)).toContain('for this job on the web');
  });

  it('renders nothing for a payload that is not its own', async () => {
    stubQueries([armed()]);
    await releaseWhatsAppLanesForApplication(client, INPUT);

    const [, renderer] = mockRegister.mock.calls[0] as ['account', CategoryRenderer];
    const foreign = {
      ...mockEnqueue.mock.calls[0][1],
      payload: { kind: 'application_stage', status: 'hired' },
    };
    await expect(
      renderer({ query: jest.fn() } as unknown as PoolClient, foreign),
    ).resolves.toBeNull();
  });

  // ── (c) armed, outside the window ──
  it('scrubs but sends nothing when the last inbound message is older than 24h', async () => {
    stubQueries([armed({
      last_inbound_at: '2026-09-07T05:00:00.000Z',
      within_session_window: false,
    })]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
    expect(callMatching(/UPDATE whatsapp_conversations/)).toBeDefined();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('ignores a fresh conversation updated_at when the last inbound is stale', async () => {
    // The regression the design change bought: `updated_at` is bumped by
    // OUTBOUND writes too, so it reads "inside the window" for a session that
    // has actually lapsed. Only the inbound clock may decide the send.
    stubQueries([armed({
      updated_at: '2026-09-08T11:30:00.000Z',
      last_inbound_at: '2026-09-07T05:00:00.000Z',
      within_session_window: false,
    })]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result.closingLineQueued).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('sends nothing when the worker has no inbound history at all', async () => {
    stubQueries([armed({ last_inbound_at: null, within_session_window: false })]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  // ── multiple armed rows ──
  it('scrubs every armed row but queues one line, addressed to the most recent', async () => {
    stubQueries([
      armed({ id: CONV_ID, whatsapp_number: NUMBER, updated_at: '2026-09-08T11:00:00.000Z' }),
      armed({ id: CONV_ID_2, whatsapp_number: '+15550002222', updated_at: '2026-09-01T09:00:00.000Z' }),
    ]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 2, closingLineQueued: true });
    expect(callMatching(/UPDATE whatsapp_conversations/)![1][0]).toEqual([CONV_ID, CONV_ID_2]);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0][1].payload.conversationId).toBe(CONV_ID);
    expect(String(callMatching(/FROM whatsapp_conversations/)![0]))
      .toMatch(/ORDER BY c\.updated_at DESC/);
  });

  // ── (d) the transaction must survive a failure ──
  it('swallows a failing arm read and rolls back to its savepoint', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM whatsapp_conversations/.test(sql)) {
        return Promise.reject(new Error('permission denied for table whatsapp_conversations'));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });
    expect(sqlCalls()).toContain(`SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    expect(sqlCalls()).toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('swallows a failing scrub UPDATE and rolls back to its savepoint', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM whatsapp_conversations/.test(sql)) {
        return Promise.resolve({ rows: [armed()], rowCount: 1 });
      }
      if (/UPDATE whatsapp_conversations/.test(sql)) {
        return Promise.reject(new Error('permission denied for table whatsapp_conversations'));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });
    expect(sqlCalls()).toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('swallows a failing enqueue and rolls back to its savepoint', async () => {
    stubQueries([armed()]);
    mockEnqueue.mockRejectedValue(new Error('renderer_unavailable:account'));

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });
    expect(sqlCalls()).toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
  });

  it('releases its savepoint on the success path', async () => {
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(sqlCalls()).toContain(`RELEASE SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    expect(sqlCalls()).not.toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
  });

  // ── the prompt-lane-only release ──
  describe('releasePromptLaneForApplication', () => {
    it('clears only the prompt keys and never sends a line', async () => {
      stubQueries([armed()]);

      const result = await releasePromptLaneForApplication(client, {
        workerId: WORKER_ID,
        applicationId: APP_ID,
      });

      expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
      expect(callMatching(/UPDATE whatsapp_conversations/)![1]).toEqual([
        [CONV_ID], WORKER_ID, PROMPT_LANE_SCRUB_KEYS,
      ]);
      expect(PROMPT_LANE_SCRUB_KEYS).toContain('prompt_application_id');
      expect(PROMPT_LANE_SCRUB_KEYS).not.toContain('fill_application_id');
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('matches only the prompt arm', async () => {
      stubQueries([]);

      await releasePromptLaneForApplication(client, {
        workerId: WORKER_ID, applicationId: APP_ID,
      });

      const sql = String(callMatching(/FROM whatsapp_conversations/)![0]);
      expect(sql).toMatch(/state_context->>'prompt_application_id'\s*=\s*\$2/);
      expect(sql).not.toMatch(/fill_application_id/);
    });

    it('never registers a renderer it will not use', async () => {
      stubQueries([armed()]);

      await releasePromptLaneForApplication(client, {
        workerId: WORKER_ID, applicationId: APP_ID,
      });

      expect(mockRegister).not.toHaveBeenCalled();
    });
  });

  it('never crosses workers: the scrub carries the caller-proven worker id', async () => {
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, workerId: OTHER_WORKER_ID });

    expect(callMatching(/UPDATE whatsapp_conversations/)![1][1]).toBe(OTHER_WORKER_ID);
    expect(callMatching(/FROM whatsapp_conversations/)![1][0]).toBe(OTHER_WORKER_ID);
  });
});
