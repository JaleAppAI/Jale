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
  LANE_SEND_SAVEPOINT,
  RELEASED_TO_WEB_KEY_PREFIX,
  releasedToWebKey,
  releaseFillLaneForApplication,
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

/** The job the template names, as the release's job read projects it. */
interface JobRow { title: string | null; trade_category: string | null; trade_category_other: string | null }
const CONCRETE_JOB: JobRow = { title: 'Concrete Finisher', trade_category: 'concrete', trade_category_other: null };

/**
 * Routes by statement shape; `armedRows` is what the arm SELECT returns and
 * `jobRows` what the job read (the template path only) returns.
 */
function stubQueries(armedRows: ReturnType<typeof armed>[], jobRows: JobRow[] = [CONCRETE_JOB]) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM whatsapp_conversations/.test(sql)) {
      return Promise.resolve({ rows: armedRows, rowCount: armedRows.length });
    }
    if (/UPDATE whatsapp_conversations/.test(sql)) {
      return Promise.resolve({ rows: [], rowCount: armedRows.length });
    }
    if (/FROM job_applications ja\s+JOIN jobs j/.test(sql)) {
      return Promise.resolve({ rows: jobRows, rowCount: jobRows.length });
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

  // Sprint 28 (F29): the first web write already stood the bot down, so the
  // arm keys are gone by the time the web completes. The marker that early
  // release leaves is what still ties the conversation to this application.
  it('also matches a conversation the web already took over for this application, and clears that marker', async () => {
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const sql = String(callMatching(/FROM whatsapp_conversations/)![0]);
    expect(sql).toContain("c.state_context ? ('released_to_web:' || $2)");
    const update = callMatching(/UPDATE whatsapp_conversations/)!;
    // This application's marker only, never another application's.
    expect(String(update[0])).toContain("- ('released_to_web:' || $4::text)");
    expect(update[1]).toEqual([[CONV_ID], WORKER_ID, FILL_SCRUB_KEYS, APP_ID]);
  });

  // A row found through the marker alone may be armed by the bot for ANOTHER
  // application the worker started on WhatsApp since; that arm must survive.
  it('removes the bot keys only from a row whose live arm names this application', async () => {
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const sql = String(callMatching(/UPDATE whatsapp_conversations/)![0]);
    expect(sql).toMatch(/WHEN state_context->>'fill_application_id'\s*= \$4::text/);
    expect(sql).toMatch(/OR state_context->>'fill_offer_application_id' = \$4::text/);
    expect(sql).toMatch(/OR state_context->>'prompt_application_id'\s*= \$4::text/);
    expect(sql).toMatch(/THEN COALESCE\(state_context, '\{\}'::jsonb\) - \$3::text\[\]\s+ELSE COALESCE\(state_context, '\{\}'::jsonb\)/);
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
    expect(update![1]).toEqual([[CONV_ID], WORKER_ID, FILL_SCRUB_KEYS, APP_ID]);
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
    // ASCENDING = sent FIRST (`withinGroupOrder` in worker-ready-release.ts
    // sorts `a.priority - b.priority`, and 043's lease drains by the
    // `release_sequence` it allocates in that order). So this must be a
    // HIGHER number than every lane carrying real news: job alerts and stage
    // changes at 30, employer chat at 40.
    expect(input.priority).toBe(45);
    expect(input.priority).toBeGreaterThan(40);
    // The phone number must never land in worker_message_intents.payload.
    expect(JSON.stringify(input.payload)).not.toContain(NUMBER);
    expect(input.payload.conversationId).toBe(CONV_ID);
  });

  // One completion message, inside or outside the window (owner wording,
  // D-W7): inside it the same text goes free-form.
  it('renders the Spanish closing line as a body-only message, naming the trade and linking the application', async () => {
    stubQueries([armed({ language: 'es' })]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, lang: 'es' });

    const link = `https://jaleapp.ai/es/worker/applications/${APP_ID}`;
    await expect(renderQueuedMessage()).resolves.toEqual({
      whatsappNumber: NUMBER,
      body: `Completaste tu solicitud para el trabajo de Concreto en la web. Revisa su estado en ${link} `
        + 'y te avisamos por aqu\u00ed cuando el empleador responda.',
      contentTemplate: null,
      contentVariables: null,
    });
  });

  it('renders the English closing line as a body-only message, naming the trade and linking the application', async () => {
    stubQueries([armed({ language: 'en' })]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, lang: 'en' });

    const link = `https://jaleapp.ai/en/worker/applications/${APP_ID}`;
    await expect(renderQueuedMessage()).resolves.toEqual({
      whatsappNumber: NUMBER,
      body: `You completed your application for the Concrete job on the web. See its status at ${link} `
        + "and we'll let you know here when the employer responds.",
      contentTemplate: null,
      contentVariables: null,
    });
  });

  it('sends the same words inside the window as the template carries outside it', async () => {
    stubQueries([armed()]);
    await releaseWhatsAppLanesForApplication(client, INPUT);
    const inside = await renderQueuedMessage();

    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue({ intentId: 'i-2', decision: { action: 'allow', reason: 'worker_ready' }, outboxMaterialized: true });
    stubQueries([armed({ last_inbound_at: '2026-09-07T05:00:00.000Z', within_session_window: false })]);
    await releaseWhatsAppLanesForApplication(client, INPUT);
    const outside = await renderQueuedMessage();

    expect(inside?.body).toBe(outside?.contentVariables?.__fallback_body);
  });

  it("prefers the conversation row's language over the caller's", async () => {
    stubQueries([armed({ language: 'en' })]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, lang: 'es' });

    expect(mockEnqueue.mock.calls[0][1].payload.lang).toBe('en');
  });

  it('sends nothing inside the window either when the job names no trade and has no title', async () => {
    stubQueries([armed()], [{ title: null, trade_category: null, trade_category_other: null }]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(sqlCalls()).toContain(`RELEASE SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
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

  // ── (c) armed, outside the window (sprint 28, F28) ──
  //
  // A free-form body is refused outside Meta's 24h window, so the line goes
  // as the `application_web_completed_<lang>` template instead of being
  // skipped. The sender uses the ContentSid when the key is mapped; until it
  // is, it falls back to `__fallback_body`, which Twilio refuses (63016) and
  // `isTemplatePendingRejection` parks instead of failing.
  const STALE = { last_inbound_at: '2026-09-07T05:00:00.000Z', within_session_window: false };
  const LINK = `https://jaleapp.ai/es/worker/applications/${APP_ID}`;

  it('queues the template, naming the trade and linking the application, when the last inbound is older than 24h', async () => {
    stubQueries([armed(STALE)]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: true });
    expect(callMatching(/UPDATE whatsapp_conversations/)).toBeDefined();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const input = mockEnqueue.mock.calls[0][1];
    expect(input.dedupeKey).toBe(`application-web-completion:${APP_ID}`);
    expect(input.payload).toMatchObject({
      kind: 'application_web_completion', applicationId: APP_ID, conversationId: CONV_ID,
      lang: 'es', shape: 'template', trade: 'Concreto', url: LINK,
    });
    expect(JSON.stringify(input.payload)).not.toContain(NUMBER);

    const message = await renderQueuedMessage();
    expect(message).toEqual({
      whatsappNumber: NUMBER,
      body: null,
      contentTemplate: 'application_web_completed_es',
      contentVariables: {
        '1': 'Concreto',
        '2': LINK,
        __fallback_body: `Completaste tu solicitud para el trabajo de Concreto en la web. Revisa su estado en ${LINK} `
          + 'y te avisamos por aqu\u00ed cuando el empleador responda.',
      },
    });
  });

  it('reads the job through the caller-proven worker, inside the send savepoint', async () => {
    stubQueries([armed(STALE)]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const read = callMatching(/FROM job_applications ja\s+JOIN jobs j/)!;
    expect(String(read[0])).toMatch(/ja\.id = \$1/);
    expect(String(read[0])).toMatch(/ja\.worker_id = \$2/);
    expect(read[1]).toEqual([APP_ID, WORKER_ID]);
    const calls = sqlCalls();
    expect(calls.findIndex((sql) => /JOIN jobs j/.test(sql)))
      .toBeGreaterThan(calls.indexOf(`SAVEPOINT ${LANE_SEND_SAVEPOINT}`));
  });

  it('gives the template intent 48 hours, not the lapsed inbound window', async () => {
    stubQueries([armed(STALE)]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const expiresAt: Date = mockEnqueue.mock.calls[0][1].expiresAt;
    const hoursOut = (expiresAt.getTime() - Date.now()) / (60 * 60 * 1000);
    expect(hoursOut).toBeGreaterThan(47.5);
    expect(hoursOut).toBeLessThan(48.5);
  });

  it('ignores a fresh conversation updated_at when the last inbound is stale', async () => {
    // The regression the design change bought: `updated_at` is bumped by
    // OUTBOUND writes too, so it reads "inside the window" for a session that
    // has actually lapsed. Only the inbound clock may decide the shape.
    stubQueries([armed({ updated_at: '2026-09-08T11:30:00.000Z', ...STALE })]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(mockEnqueue.mock.calls[0][1].payload.shape).toBe('template');
  });

  it('queues the template when the worker has no inbound history at all', async () => {
    stubQueries([armed({ last_inbound_at: null, within_session_window: false })]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: true });
    expect(mockEnqueue.mock.calls[0][1].payload.shape).toBe('template');
  });

  it("uses the conversation's language for the trade, the link and the template", async () => {
    stubQueries([armed({ ...STALE, language: 'en' })]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const message = await renderQueuedMessage();
    expect(message?.contentTemplate).toBe('application_web_completed_en');
    expect(message?.contentVariables).toMatchObject({
      '1': 'Concrete',
      '2': `https://jaleapp.ai/en/worker/applications/${APP_ID}`,
    });
  });

  it.each<[string, JobRow, string]>([
    ['the employer\'s own words for an other trade', { title: 'Site Lead', trade_category: 'other', trade_category_other: '  Welder\n ' }, 'Welder'],
    ['the title when the job states no trade', { title: 'Concrete Finisher', trade_category: null, trade_category_other: null }, 'Concrete Finisher'],
    ['the catalogue label for drywall', { title: 'x', trade_category: 'drywall', trade_category_other: null }, 'Drywall'],
    ['the catalogue label for general labor', { title: 'x', trade_category: 'general_labor', trade_category_other: null }, 'Ayudante general'],
  ])('names %s', async (_label, job, expected) => {
    stubQueries([armed(STALE)], [job]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(mockEnqueue.mock.calls[0][1].payload.trade).toBe(expected);
  });

  it('sends nothing outside the window when the job names no trade and has no title', async () => {
    stubQueries([armed(STALE)], [{ title: null, trade_category: null, trade_category_other: null }]);

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(sqlCalls()).toContain(`RELEASE SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
  });

  it('links the application as the bot does: PUBLIC_SITE_BASE_URL, else the production site', async () => {
    const saved = process.env.PUBLIC_SITE_BASE_URL;
    try {
      delete process.env.PUBLIC_SITE_BASE_URL;
      stubQueries([armed(STALE)]);
      await releaseWhatsAppLanesForApplication(client, INPUT);
      expect(mockEnqueue.mock.calls[0][1].payload.url).toBe(`https://jaleapp.ai/es/worker/applications/${APP_ID}`);

      jest.clearAllMocks();
      mockEnqueue.mockResolvedValue({ intentId: 'i-2', decision: { action: 'allow', reason: 'worker_ready' }, outboxMaterialized: true });
      process.env.PUBLIC_SITE_BASE_URL = 'https://site.example.test/';
      stubQueries([armed(STALE)]);
      await releaseWhatsAppLanesForApplication(client, INPUT);
      expect(mockEnqueue.mock.calls[0][1].payload.url).toBe(`https://site.example.test/es/worker/applications/${APP_ID}`);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_SITE_BASE_URL;
      else process.env.PUBLIC_SITE_BASE_URL = saved;
    }
  });

  it('KEEPS the scrub when the job read fails on the template path', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM whatsapp_conversations/.test(sql)) return Promise.resolve({ rows: [armed(STALE)], rowCount: 1 });
      if (/UPDATE whatsapp_conversations/.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 });
      if (/JOIN jobs j/.test(sql)) return Promise.reject(new Error('job read failed'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
    expect(sqlCalls()).toContain(`ROLLBACK TO SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
    expect(sqlCalls()).not.toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
  });

  it('reads the job inside the window too; the free-form payload carries the trade and link, not the template shape', async () => {
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(callMatching(/JOIN jobs j/)).toBeDefined();
    const payload = mockEnqueue.mock.calls[0][1].payload;
    expect(payload.shape).toBeUndefined();
    expect(payload).toMatchObject({ trade: 'Concreto', url: `https://jaleapp.ai/es/worker/applications/${APP_ID}` });
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

  it('KEEPS the scrub when only the closing line fails', async () => {
    // The scrub is the FIX; the line is a courtesy. Sharing one savepoint
    // would let a failed send roll the scrub back -- the bot would go on
    // re-prompting a form the worker already finished, because a WhatsApp
    // message failed. A silent scrub is the acceptable degraded outcome;
    // silently doing nothing is not.
    stubQueries([armed()]);
    mockEnqueue.mockRejectedValue(new Error('renderer_unavailable:account'));

    const result = await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
    // Only the SEND scope rolled back.
    expect(sqlCalls()).toContain(`ROLLBACK TO SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
    expect(sqlCalls()).not.toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
  });

  it('takes the send savepoint only AFTER the scrub is released', async () => {
    // Ordering is the whole mechanism: a savepoint taken before the UPDATE
    // would undo it on rollback, however the results are labelled.
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const calls = sqlCalls();
    const scrubReleased = calls.indexOf(`RELEASE SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    const updateAt = calls.findIndex((sql) => /UPDATE whatsapp_conversations/.test(sql));
    const sendTaken = calls.indexOf(`SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
    expect(updateAt).toBeGreaterThan(-1);
    expect(scrubReleased).toBeGreaterThan(updateAt);
    expect(sendTaken).toBeGreaterThan(scrubReleased);
  });

  it('releases both savepoints on the success path', async () => {
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    expect(sqlCalls()).toContain(`RELEASE SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    expect(sqlCalls()).toContain(`RELEASE SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
    expect(sqlCalls()).not.toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    expect(sqlCalls()).not.toContain(`ROLLBACK TO SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
  });

  it('expires the intent when the INBOUND window closes, not 24h from now', async () => {
    // `evaluateDelivery` defers a mid-onboarding worker's intent, and the
    // worker-ready release materializes it later. A 24h-from-now expiry on a
    // window that opened 20h ago would let that path send a free-form body
    // ~44h after the last inbound: a 63016 which, with no content template,
    // is an ordinary `recordFailure` burning five attempts.
    const lastInbound = new Date(Date.now() - 20 * 60 * 60 * 1000);
    stubQueries([armed({ last_inbound_at: lastInbound.toISOString() })]);

    await releaseWhatsAppLanesForApplication(client, INPUT);

    const expiresAt: Date = mockEnqueue.mock.calls[0][1].expiresAt;
    const hoursOut = (expiresAt.getTime() - Date.now()) / (60 * 60 * 1000);
    expect(hoursOut).toBeGreaterThan(3.5);
    expect(hoursOut).toBeLessThan(4.5);
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

  // ── the first-web-write release (sprint 28, F29) ──
  describe('releaseFillLaneForApplication', () => {
    const releaseFill = (input: { workerId: string; applicationId: string }) =>
      releaseFillLaneForApplication(client, input);

    it('names one marker per application', () => {
      expect(RELEASED_TO_WEB_KEY_PREFIX).toBe('released_to_web:');
      expect(releasedToWebKey(APP_ID)).toBe(`released_to_web:${APP_ID}`);
    });

    it('matches only a live fill, offer or prompt arm for the application, never the marker', async () => {
      stubQueries([]);

      await releaseFill({ workerId: WORKER_ID, applicationId: APP_ID });

      const read = callMatching(/FROM whatsapp_conversations/)!;
      const sql = String(read[0]);
      expect(sql).toMatch(/state_context->>'fill_application_id'\s*=\s*\$2/);
      expect(sql).toMatch(/state_context->>'fill_offer_application_id'\s*=\s*\$2/);
      expect(sql).toMatch(/state_context->>'prompt_application_id'\s*=\s*\$2/);
      expect(sql).not.toMatch(/released_to_web/);
      expect(read[1]).toEqual([WORKER_ID, APP_ID]);
    });

    it('clears every FILL_SCRUB key and leaves the released-to-web marker, scoped to the worker, sending nothing', async () => {
      stubQueries([armed()]);

      const result = await releaseFill({ workerId: WORKER_ID, applicationId: APP_ID });

      expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
      const update = callMatching(/UPDATE whatsapp_conversations/)!;
      const sql = String(update[0]);
      expect(sql).toMatch(/-\s*\$3::text\[\]/);
      expect(sql).toContain("|| jsonb_build_object('released_to_web:' || $4::text, true)");
      expect(sql).toMatch(/user_id = \$2/);
      expect(update[1]).toEqual([[CONV_ID], WORKER_ID, FILL_SCRUB_KEYS, APP_ID]);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('does nothing when no conversation is armed for the application', async () => {
      stubQueries([]);

      const result = await releaseFill({ workerId: WORKER_ID, applicationId: APP_ID });

      expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });
      expect(callMatching(/UPDATE whatsapp_conversations/)).toBeUndefined();
    });

    it('swallows a failing scrub and rolls back to its savepoint', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (/FROM whatsapp_conversations/.test(sql)) return Promise.resolve({ rows: [armed()], rowCount: 1 });
        if (/UPDATE whatsapp_conversations/.test(sql)) return Promise.reject(new Error('scrub failed'));
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const result = await releaseFill({ workerId: WORKER_ID, applicationId: APP_ID });

      expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });
      expect(sqlCalls()).toContain(`ROLLBACK TO SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
    });
  });

  it('never crosses workers: the scrub carries the caller-proven worker id', async () => {
    stubQueries([armed()]);

    await releaseWhatsAppLanesForApplication(client, { ...INPUT, workerId: OTHER_WORKER_ID });

    expect(callMatching(/UPDATE whatsapp_conversations/)![1][1]).toBe(OTHER_WORKER_ID);
    expect(callMatching(/FROM whatsapp_conversations/)![1][0]).toBe(OTHER_WORKER_ID);
  });
});
