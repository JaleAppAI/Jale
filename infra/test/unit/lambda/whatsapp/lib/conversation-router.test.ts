// infra/test/unit/lambda/whatsapp/lib/conversation-router.test.ts
//
// Verifies that resolveWorkerIdForWhatsappNumber only queries
// Cognito-verified phone fields (users.whatsapp_number, users.phone)
// and never joins worker_profiles or uses wp.phone.
//
// ./templates and ./flows are left unmocked — pure functions/types,
// no I/O, no side effects.

const mockQuery = jest.fn();
const client: any = { query: mockQuery };

jest.mock('../../../../../lambda/lib/db', () => ({
  setInternalUserRlsContext: jest.fn(),
}));

jest.mock('../../../../../lambda/lib/job-messaging', () => ({
  recordWorkerConversationReply: jest.fn(),
  openWorkerConversationFromButton: jest.fn(),
  openLatestWorkerConversationFromButtonText: jest.fn(),
  declineWorkerConversationFromButton: jest.fn(),
  declineLatestWorkerConversationFromButtonText: jest.fn(),
}));

jest.mock('../../../../../lambda/whatsapp/lib/outbox', () => ({
  queueOutboxText: jest.fn(),
}));

// ./templates — pure functions (t, detectLanguage): left UNMOCKED intentionally.
// ./flows — type-only import: no mock needed.

import { resolveWorkerIdForWhatsappNumber } from
  '../../../../../lambda/whatsapp/lib/conversation-router';

describe('resolveWorkerIdForWhatsappNumber', () => {
  beforeEach(() => jest.clearAllMocks());

  it('matches only verified phone fields — never worker_profiles.phone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await resolveWorkerIdForWhatsappNumber(client, 'whatsapp:+15125551234');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/u\.whatsapp_number = \$1/);
    expect(sql).toMatch(/u\.phone = \$1/);
    expect(sql).not.toMatch(/wp\.phone/);
    expect(sql).not.toMatch(/worker_profiles/);
    expect(params).toEqual(['+15125551234']);
  });

  it('strips the whatsapp: prefix before querying', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'worker-uuid-1' }], rowCount: 1 });
    const result = await resolveWorkerIdForWhatsappNumber(client, 'whatsapp:+15125559999');
    expect(result).toBe('worker-uuid-1');
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['+15125559999']);
  });

  it('returns null when no matching worker is found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await resolveWorkerIdForWhatsappNumber(client, '+15125550000');
    expect(result).toBeNull();
  });
});

import {
  relayWorkerFreeText, handleDisambiguationPick, parseDisambiguationPick,
  tryConversationRelay, handleEmployerConversationButton,
} from '../../../../../lambda/whatsapp/lib/conversation-router';
import {
  recordWorkerConversationReply,
  openWorkerConversationFromButton,
} from '../../../../../lambda/lib/job-messaging';
import { queueOutboxText } from '../../../../../lambda/whatsapp/lib/outbox';

const WORKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const CONV_A = 'bbbbbbbb-0000-0000-0000-00000000000a';
const CONV_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

const deps = { updateConversation: jest.fn(), queueLegalPrompt: jest.fn() };
const baseConv: any = {
  id: 'wa-conv-1', user_id: WORKER, whatsapp_number: '+1512', language: 'es',
  conversation_state: 'idle', state_context: {}, otp_attempts: 0,
  otp_expires_at: null, last_processed_message_sid: null,
  focused_job_conversation_id: null,
};
const msg: any = {
  body: 'puedo el lunes a las 9', buttonPayload: undefined, interactivePayload: undefined,
  messageSid: 'SM10', from: 'whatsapp:+1512', numMedia: 0,
  mediaUrl: undefined, mediaSid: undefined, mediaContentType: undefined,
};

describe('disambiguation flow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('on ambiguous: buffers the message, sends a numbered list, delivers nothing', async () => {
    // relayWorkerFreeText now issues the tos-gate SELECT first (legal wall).
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({
      status: 'ambiguous',
      threads: [
        { conversationId: CONV_A, jobTitle: 'Plomero', companyName: 'ACME', threadNumber: 1 },
        { conversationId: CONV_B, jobTitle: 'Plomero', companyName: 'BuildCo', threadNumber: 2 },
      ],
    });
    const routed = await relayWorkerFreeText(client, baseConv, msg, WORKER, deps);
    expect(routed).toBe(WORKER);
    const ctx = (deps.updateConversation as jest.Mock).mock.calls[0][2].state_context;
    expect(ctx.conversation_disambiguation.pending.body).toBe('puedo el lunes a las 9');
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toContain('1. ACME');
    expect(sent).toContain('2. BuildCo');
  });

  it('numbered pick focuses the thread and delivers the buffered message', async () => {
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce(
      { status: 'routed', conversationId: CONV_B });
    const conv = {
      ...baseConv,
      state_context: { conversation_disambiguation: {
        threads: [
          { conversationId: CONV_A, jobTitle: 'Plomero', companyName: 'ACME', threadNumber: 1 },
          { conversationId: CONV_B, jobTitle: 'Plomero', companyName: 'BuildCo', threadNumber: 2 },
        ],
        pending: { body: 'puedo el lunes a las 9', messageSid: 'SM10', ts: Date.now() },
      } },
    };
    await handleDisambiguationPick(client, conv, { ...msg, body: '2', messageSid: 'SM11' }, WORKER, deps);
    expect(recordWorkerConversationReply).toHaveBeenCalledWith(
      client, WORKER, 'puedo el lunes a las 9', msg.from, 'SM10', CONV_B);
    const fields = (deps.updateConversation as jest.Mock).mock.calls[0][2];
    expect(fields.focused_job_conversation_id).toBe(CONV_B);
    expect(fields.state_context.conversation_disambiguation).toBeUndefined();
  });

  it('parseDisambiguationPick accepts 1-2 digit numbers only (never OTP codes)', () => {
    expect(parseDisambiguationPick('2')).toBe(2);
    expect(parseDisambiguationPick(' 1 ')).toBe(1);
    expect(parseDisambiguationPick('123456')).toBeNull();
    expect(parseDisambiguationPick('2 aceptar')).toBeNull();
  });
});

describe('legal-wall gate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('blocks relay and queues the legal prompt when ToS not accepted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 });
    const routed = await relayWorkerFreeText(client, baseConv, msg, WORKER, deps);
    expect(routed).toBe(WORKER);
    expect(deps.queueLegalPrompt).toHaveBeenCalledWith(client, msg.messageSid, msg.from, 'es');
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });

  it('relays normally when ToS accepted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce(
      { status: 'routed', conversationId: CONV_A });
    const routed = await relayWorkerFreeText(client, baseConv, msg, WORKER, deps);
    expect(routed).toBe(WORKER);
    expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
  });
});

describe('tryConversationRelay', () => {
  beforeEach(() => jest.clearAllMocks());

  // Helper: assert no updateConversation call ever bound identity or state.
  function assertNoIdentityBinding() {
    for (const call of (deps.updateConversation as jest.Mock).mock.calls) {
      const fields = call[2];
      expect(fields).not.toHaveProperty('user_id');
      expect(fields).not.toHaveProperty('conversation_state');
    }
  }

  it('relays for the `new` state via phone resolution without binding identity', async () => {
    // 1) resolve worker by phone (user_id is null), 2) tos-gate SELECT.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: WORKER }], rowCount: 1 })   // resolve
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }); // tos gate
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce(
      { status: 'routed', conversationId: CONV_A });

    const conv = { ...baseConv, conversation_state: 'new', user_id: null };
    const routed = await tryConversationRelay(client, conv, msg, deps);

    expect(routed).toBe(WORKER);
    expect(recordWorkerConversationReply).toHaveBeenCalled();
    // Relay must only touch the focus column, never identity/state.
    assertNoIdentityBinding();
    const fields = (deps.updateConversation as jest.Mock).mock.calls[0]?.[2];
    if (fields) expect(fields).toHaveProperty('focused_job_conversation_id');
  });

  it('does NOT relay a 6-digit OTP code while awaiting_otp (falls through)', async () => {
    const conv = { ...baseConv, conversation_state: 'awaiting_otp' };
    const otpMsg = { ...msg, body: '123456' };
    const routed = await tryConversationRelay(client, conv, otpMsg, deps);
    expect(routed).toBeNull();
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });

  it('relays non-OTP text while awaiting_otp WITHOUT binding identity (§4.2a)', async () => {
    // user_id is set, so no resolve query — only the tos-gate SELECT.
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce(
      { status: 'routed', conversationId: CONV_A });

    const conv = {
      ...baseConv,
      conversation_state: 'awaiting_otp',
      state_context: { cognito_session: 'sess-123' },
    };
    const routed = await tryConversationRelay(client, conv, msg, deps);

    expect(routed).toBe(WORKER);
    expect(recordWorkerConversationReply).toHaveBeenCalled();
    assertNoIdentityBinding();
  });

  it('skips relay for structured-input states (building_profile)', async () => {
    const conv = { ...baseConv, conversation_state: 'building_profile' };
    const routed = await tryConversationRelay(client, conv, msg, deps);
    expect(routed).toBeNull();
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('falls through for the JOBS keyword (reserved-keyword precedence)', async () => {
    const conv = { ...baseConv, conversation_state: 'idle' };
    const routed = await tryConversationRelay(client, conv, { ...msg, body: 'TRABAJOS' }, deps);
    expect(routed).toBeNull();
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });

  it('falls through for a typed job action ("1 aceptar")', async () => {
    const conv = { ...baseConv, conversation_state: 'idle' };
    const routed = await tryConversationRelay(client, conv, { ...msg, body: '1 aceptar' }, deps);
    expect(routed).toBeNull();
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });
});

describe('conversation actions preserve onboarding state (R10) + actionable no-ops (R6)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('open button mid-building_profile preserves state and collected answers', async () => {
    const conv = { ...baseConv, conversation_state: 'building_profile',
      state_context: { collected: { city: 'Austin' } } };
    // legal gate (tos accepted) -> open succeeds
    mockQuery.mockResolvedValue({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    (openWorkerConversationFromButton as jest.Mock).mockResolvedValueOnce(
      { found: true, queuedMessages: 0, conversationId: CONV_A });
    await handleEmployerConversationButton(
      client, conv, { ...msg, buttonPayload: `conversation:open:${CONV_A}` },
      { action: 'open', conversationId: CONV_A }, deps);
    const fields = (deps.updateConversation as jest.Mock).mock.calls[0][2];
    expect(fields.conversation_state).toBeUndefined();   // state untouched
    expect(fields.state_context).toBeUndefined();         // collected answers untouched
    expect(fields.user_id).toBeUndefined();               // no identity binding
    expect(fields.focused_job_conversation_id).toBe(CONV_A);
  });

  it('open button on a closed/missing conversation replies something actionable (R6)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    (openWorkerConversationFromButton as jest.Mock).mockResolvedValueOnce(
      { found: false, queuedMessages: 0 });
    await handleEmployerConversationButton(
      client, baseConv, msg, { action: 'open', conversationId: CONV_A }, deps);
    expect(queueOutboxText).toHaveBeenCalled();
    expect((queueOutboxText as jest.Mock).mock.calls[0][3]).toMatch(/ya no está disponible/);
  });
});
