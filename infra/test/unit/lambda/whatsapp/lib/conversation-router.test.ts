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
  closeWorkerConversation: jest.fn(),
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
  relayWorkerFreeText, handlePickerResponse, parseDisambiguationPick,
  tryConversationRelay, handleEmployerConversationButton, isChatsKeyword,
  isCloseKeyword, isLikelyOtpCode, parseEmployerConversationTextAction,
  handleEmployerConversationTextAction, ensureWorkerTosAccepted,
} from '../../../../../lambda/whatsapp/lib/conversation-router';
import {
  recordWorkerConversationReply,
  openWorkerConversationFromButton,
  closeWorkerConversation,
  declineWorkerConversationFromButton,
  declineLatestWorkerConversationFromButtonText,
} from '../../../../../lambda/lib/job-messaging';
import { queueOutboxText } from '../../../../../lambda/whatsapp/lib/outbox';

const WORKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const CONV_A = 'bbbbbbbb-0000-0000-0000-00000000000a';
const CONV_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

const deps = {
  updateConversation: jest.fn(),
  queueLegalPrompt: jest.fn(),
  recordLegalAcceptance: jest.fn(),
  requiredLegalVersion: '1.0',
};
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

describe('picker flow (Phase 2 — no buffer)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('on ambiguous: sets pending_picker with kind=disambiguation, asks to resend', async () => {
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
    expect(ctx.pending_picker).toBeDefined();
    expect(ctx.pending_picker.kind).toBe('disambiguation');
    expect(ctx.pending_picker.threads).toHaveLength(2);
    expect(ctx.pending_picker.pending).toBeUndefined(); // no buffer
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toContain('1. ACME');
    expect(sent).toContain('2. BuildCo');
  });

  it('numbered pick sets focus and asks to send message (no delivery)', async () => {
    const conv = {
      ...baseConv,
      state_context: { pending_picker: {
        kind: 'disambiguation',
        threads: [
          { conversationId: CONV_A, jobTitle: 'Plomero', companyName: 'ACME', threadNumber: 1 },
          { conversationId: CONV_B, jobTitle: 'Plomero', companyName: 'BuildCo', threadNumber: 2 },
        ],
      }},
    };
    await handlePickerResponse(client, conv, { ...msg, body: '2', messageSid: 'SM11' }, WORKER, deps);
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
    const fields = (deps.updateConversation as jest.Mock).mock.calls[0][2];
    expect(fields.focused_job_conversation_id).toBe(CONV_B);
    const confirmation = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(confirmation).toMatch(/BuildCo/);
    expect(confirmation).toMatch(/[Ee]scribe|[Ss]end your message/);
  });

  it('out-of-range pick reprompts', async () => {
    const conv = {
      ...baseConv,
      state_context: { pending_picker: {
        kind: 'disambiguation',
        threads: [{ conversationId: CONV_A, jobTitle: 'Plomero', companyName: 'ACME', threadNumber: 1 }],
      }},
    };
    await handlePickerResponse(client, conv, { ...msg, body: '5' }, WORKER, deps);
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toMatch(/1|número|number/i);
  });

  it('setting focus via handlePickerResponse clears pending_picker from state_context', async () => {
    const conv = {
      ...baseConv,
      state_context: {
        pending_picker: {
          kind: 'disambiguation' as const,
          threads: [
            { conversationId: CONV_A, jobTitle: 'Plomero', companyName: 'ACME', threadNumber: 1 },
            { conversationId: CONV_B, jobTitle: 'Plomero', companyName: 'BuildCo', threadNumber: 2 },
          ],
        },
      },
    };
    await handlePickerResponse(client, conv, { ...msg, body: '2' }, WORKER, deps);
    // The updateConversation call must have state_context without pending_picker
    const updateCall = (deps.updateConversation as jest.Mock).mock.calls[0];
    const updatedFields = updateCall[2];
    expect(updatedFields.state_context?.pending_picker).toBeUndefined();
    expect(updatedFields.focused_job_conversation_id).toBe(CONV_B);
  });

  it('handlePickerResponse: CHATS pick sets fill_relay_override when a fill is armed', async () => {
    const conv = {
      ...baseConv,
      state_context: {
        fill_application_id: '11111111-1111-1111-1111-111111111111',
        pending_picker: {
          kind: 'disambiguation' as const,
          threads: [
            { conversationId: CONV_A, jobTitle: 'Plomero', companyName: 'ACME', threadNumber: 1 },
            { conversationId: CONV_B, jobTitle: 'Plomero', companyName: 'BuildCo', threadNumber: 2 },
          ],
        },
      },
    };
    await handlePickerResponse(client, conv, { ...msg, body: '2' }, WORKER, deps);
    const updateCall = (deps.updateConversation as jest.Mock).mock.calls[0];
    const updatedFields = updateCall[2];
    expect(updatedFields.state_context?.fill_relay_override).toBe(true);
    // every other key the function already writes must survive untouched
    expect(updatedFields.state_context?.fill_application_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(updatedFields.state_context?.pending_picker).toBeUndefined();
    expect(updatedFields.focused_job_conversation_id).toBe(CONV_B);
  });

  it('handlePickerResponse: CHATS pick does NOT set fill_relay_override when no fill is armed', async () => {
    const conv = {
      ...baseConv,
      state_context: {
        pending_picker: {
          kind: 'disambiguation' as const,
          threads: [
            { conversationId: CONV_A, jobTitle: 'Plomero', companyName: 'ACME', threadNumber: 1 },
            { conversationId: CONV_B, jobTitle: 'Plomero', companyName: 'BuildCo', threadNumber: 2 },
          ],
        },
      },
    };
    await handlePickerResponse(client, conv, { ...msg, body: '2' }, WORKER, deps);
    const updateCall = (deps.updateConversation as jest.Mock).mock.calls[0];
    const updatedFields = updateCall[2];
    // key must be ABSENT, not merely falsy
    expect('fill_relay_override' in (updatedFields.state_context ?? {})).toBe(false);
  });

  it('parseDisambiguationPick accepts 1-2 digit numbers only (never OTP codes)', () => {
    expect(parseDisambiguationPick('2')).toBe(2);
    expect(parseDisambiguationPick(' 1 ')).toBe(1);
    expect(parseDisambiguationPick('12')).toBe(12);
    expect(parseDisambiguationPick('123456')).toBeNull(); // OTP code — must not be hijacked
    expect(parseDisambiguationPick('2 aceptar')).toBeNull();
    expect(parseDisambiguationPick('')).toBeNull();
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

describe('ensureWorkerTosAccepted', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepted worker: returns \'accepted\', no prompt queued', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    const result = await ensureWorkerTosAccepted(
      client, baseConv, msg, WORKER, deps, 'ConversationRelayLegalHold');
    expect(result).toBe('accepted');
    expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
    expect(deps.recordLegalAcceptance).not.toHaveBeenCalled();
  });

  it('un-accepted worker, body "hola": queues the legal prompt, logs the hold metric, returns \'handled\'', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await ensureWorkerTosAccepted(
      client, baseConv, { ...msg, body: 'hola' }, WORKER, deps, 'ConversationRelayLegalHold');
    expect(result).toBe('handled');
    expect(deps.queueLegalPrompt).toHaveBeenCalledTimes(1);
    expect(deps.queueLegalPrompt).toHaveBeenCalledWith(client, msg.messageSid, msg.from, baseConv.language);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ metric: 'ConversationRelayLegalHold', workerId: WORKER }));
    logSpy.mockRestore();
  });

  it('un-accepted worker, body "Acepto": records acceptance and queues the ES confirmation, returns \'handled\', no prompt', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 });
    (deps.recordLegalAcceptance as jest.Mock).mockResolvedValueOnce({ verified: true });
    const result = await ensureWorkerTosAccepted(
      client, baseConv, { ...msg, body: 'Acepto' }, WORKER, deps, 'ConversationRelayLegalHold');
    expect(result).toBe('handled');
    expect(deps.recordLegalAcceptance).toHaveBeenCalledWith(
      client, { workerId: WORKER, documentVersion: deps.requiredLegalVersion });
    expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toContain('aceptados');
  });

  it('un-accepted worker, body "acepto", recordLegalAcceptance verified:false: logs WhatsAppConsentWriteFailed + apology', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 });
    (deps.recordLegalAcceptance as jest.Mock).mockResolvedValueOnce({ verified: false });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await ensureWorkerTosAccepted(
      client, baseConv, { ...msg, body: 'acepto' }, WORKER, deps, 'ConversationRelayLegalHold');
    expect(result).toBe('handled');
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ metric: 'WhatsAppConsentWriteFailed', workerId: WORKER }));
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toMatch(/algo salió mal/i);
    logSpy.mockRestore();
  });

  it('un-accepted worker, body "Aceptó" (accented autocorrect): records acceptance, no legal prompt', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 });
    (deps.recordLegalAcceptance as jest.Mock).mockResolvedValueOnce({ verified: true });
    const result = await ensureWorkerTosAccepted(
      client, baseConv, { ...msg, body: 'Aceptó' }, WORKER, deps, 'ConversationRelayLegalHold');
    expect(result).toBe('handled');
    expect(deps.recordLegalAcceptance).toHaveBeenCalledWith(
      client, { workerId: WORKER, documentVersion: deps.requiredLegalVersion });
    expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
  });

  it('relayWorkerFreeText integration: un-accepted worker typing "Acepto" is handled by the gate (no recordWorkerConversationReply)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 });
    (deps.recordLegalAcceptance as jest.Mock).mockResolvedValueOnce({ verified: true });
    const routed = await relayWorkerFreeText(client, baseConv, { ...msg, body: 'Acepto' }, WORKER, deps);
    expect(routed).toBe(WORKER);
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
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

  it('does NOT relay for the `new` state when the session is unbound', async () => {
    // Identity binding requires verified OTP (design §4.2a). A phone match is
    // not an identity — the Manuel incident. The guard returns before the
    // resolver, so no SQL runs at all.
    //
    // Seed a REAL phone match the guard must never consume, for the same
    // reason as the Manuel block below: without the seed, removing the guard
    // kills this test on an unconfigured mock (TypeError) instead of failing
    // on `expect(mockQuery).not.toHaveBeenCalled()`. Reset at the end so the
    // un-consumed value cannot leak into the next test — clearAllMocks() does
    // not purge queued mockResolvedValueOnce values.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: WORKER }], rowCount: 1 })         // phone match exists
      .mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 }); // legal wall, if reached

    const conv = { ...baseConv, conversation_state: 'new', user_id: null };
    const routed = await tryConversationRelay(client, conv, msg, deps);

    expect(routed).toBeNull();
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    assertNoIdentityBinding();

    mockQuery.mockReset();
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

  describe('Manuel regression — unbound awaiting_otp session', () => {
    // These tests deliberately seed mockQuery with rows the guard must never
    // consume. clearAllMocks() (the outer beforeEach) does not purge queued
    // mockResolvedValueOnce values, so an un-consumed seed would otherwise
    // leak into later tests and shift their mock chains. Reset fully after
    // each test in this block to keep that leakage from escaping.
    afterEach(() => mockQuery.mockReset());

    const manuelConv = {
      ...baseConv,
      conversation_state: 'awaiting_otp' as const,
      user_id: null,
      state_context: { cognito_session: 'sess-manuel' },
    };

    function assertNoJobConversationSql() {
      for (const call of mockQuery.mock.calls) {
        expect(String(call[0])).not.toMatch(/job_conversation_messages/i);
      }
    }

    // Every test in this block seeds a REAL phone match — a row that
    // resolveWorkerIdForWhatsappNumber would happily return — deliberately.
    // The point of the Manuel regression is that a resolvable phone number
    // must NOT be sufficient to relay an unbound session. A second seeded
    // row (tos_version: null, i.e. ToS not yet accepted) lets the OLD
    // fallback path — if the guard were ever removed — run all the way to
    // the legal-wall branch and return a real (non-null) workerId, instead
    // of crashing partway through on an unmocked query. That guarantees
    // `expect(routed).toBeNull()` / `expect(mockQuery).not.toHaveBeenCalled()`
    // fail as ordinary, readable assertion failures — not a TypeError — if
    // this regression is ever reintroduced.
    function seedPhoneMatchAndUnacceptedTos() {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: WORKER }], rowCount: 1 })         // phone match exists
        .mockResolvedValueOnce({ rows: [{ tos_version: null }], rowCount: 1 }); // legal wall, if reached
    }

    it('does not relay free text', async () => {
      seedPhoneMatchAndUnacceptedTos();
      const routed = await tryConversationRelay(client, { ...manuelConv }, msg, deps);
      expect(routed).toBeNull();
      expect(recordWorkerConversationReply).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      assertNoJobConversationSql();
      assertNoIdentityBinding();
    });

    it('does not present the legal prompt for CHATS', async () => {
      seedPhoneMatchAndUnacceptedTos();
      const chatsMsg = { ...msg, body: 'CHATS' };
      const routed = await tryConversationRelay(client, { ...manuelConv }, chatsMsg, deps);
      expect(routed).toBeNull();
      expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
      assertNoJobConversationSql();
      assertNoIdentityBinding();
    });

    it('does not open an employer conversation from a button', async () => {
      seedPhoneMatchAndUnacceptedTos();
      const routed = await handleEmployerConversationButton(
        client, { ...manuelConv }, msg,
        { action: 'open', conversationId: CONV_A }, deps,
      );
      expect(routed).toBeNull();
      expect(deps.updateConversation).not.toHaveBeenCalled();
      expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('does not open an employer conversation from typed text', async () => {
      seedPhoneMatchAndUnacceptedTos();
      const routed = await handleEmployerConversationTextAction(
        client, { ...manuelConv }, msg, 'open', deps,
      );
      expect(routed).toBeNull();
      expect(deps.updateConversation).not.toHaveBeenCalled();
      expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});

describe('CHATS/MENSAJES keyword in tryConversationRelay', () => {
  beforeEach(() => jest.clearAllMocks());

  it('CHATS with 0 open threads: replies "no open conversations"', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }) // ToS check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // sendChatsPickerOrAutoFocus
    const conv = { ...baseConv, user_id: WORKER };
    const routed = await tryConversationRelay(client, conv, { ...msg, body: 'CHATS' }, deps);
    expect(routed).toBe(WORKER);
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toMatch(/no.*conversaci|no open/i);
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });

  it('MENSAJES with 2 open threads: sends picker', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { id: 'conv-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
        { id: 'conv-b', job_title: 'Electricista', company: 'BuildCo', worker_thread_number: 2 },
      ], rowCount: 2 });
    const conv = { ...baseConv, user_id: WORKER };
    await tryConversationRelay(client, conv, { ...msg, body: 'MENSAJES' }, deps);
    const state = (deps.updateConversation as jest.Mock).mock.calls[0]?.[2]?.state_context;
    expect(state?.pending_picker?.kind).toBe('chats');
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toContain('1. ACME');
    expect(sent).toContain('2. BuildCo');
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });

  it('CHATS lists all open threads regardless of accepted_at (new freeform invites included)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }) // ToS check
      .mockResolvedValueOnce({ rows: [
        { id: 'conv-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
        { id: 'conv-b', job_title: 'Electricista', company: 'BuildCo', worker_thread_number: 2 },
      ], rowCount: 2 });
    const conv = { ...baseConv, user_id: WORKER };
    await tryConversationRelay(client, conv, { ...msg, body: 'CHATS' }, deps);

    // The open-threads query must NOT gate on accepted_at — an unaccepted
    // freeform invite would otherwise be invisible and unreachable.
    const openThreadsSql = mockQuery.mock.calls
      .map((c: any[]) => String(c[0]))
      .find((sql: string) => /FROM job_conversations/.test(sql) && /status = 'open'/.test(sql));
    expect(openThreadsSql).toBeDefined();
    expect(openThreadsSql).not.toMatch(/accepted_at/);
    // Company label resolves via the SECURITY DEFINER lookup, not j.company
    // (jale_whatsapp cannot read employer rows directly).
    expect(openThreadsSql).toMatch(/employer_display_name\(/);
  });

  it('CHATS with 1 open thread: shows the picker (no auto-focus)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }) // ToS check
      .mockResolvedValueOnce({ rows: [                                          // sendChatsPickerOrAutoFocus
        { id: 'conv-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
      ], rowCount: 1 });
    const conv = { ...baseConv, user_id: WORKER };
    const routed = await tryConversationRelay(client, conv, { ...msg, body: 'CHATS' }, deps);

    expect(routed).toBe(WORKER);

    // Picker stored, not a focus switch
    const updateCalls = (deps.updateConversation as jest.Mock).mock.calls;
    const state = updateCalls[0]?.[2]?.state_context;
    expect(state?.pending_picker?.kind).toBe('chats');
    expect(state?.pending_picker?.threads).toHaveLength(1);

    // Did NOT auto-focus the single thread
    const focusCall = updateCalls.find(
      (c: any[]) => c[2]?.focused_job_conversation_id === 'conv-a');
    expect(focusCall).toBeUndefined();

    // Numbered list rendered
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toContain('1. ACME');
  });

  it('CHATS is case-insensitive: "chats" works', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const conv = { ...baseConv, user_id: WORKER };
    const routed = await tryConversationRelay(client, conv, { ...msg, body: 'chats' }, deps);
    expect(routed).toBe(WORKER);
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });

  it('isChatsKeyword: exact match only', () => {
    expect(isChatsKeyword('CHATS')).toBe(true);
    expect(isChatsKeyword('MENSAJES')).toBe(true);
    expect(isChatsKeyword('chats')).toBe(true);
    expect(isChatsKeyword('mensajes')).toBe(true);
    expect(isChatsKeyword(' CHATS ')).toBe(true); // trim
    expect(isChatsKeyword('CHATS NOW')).toBe(false); // not an exact match
    expect(isChatsKeyword('')).toBe(false);
  });

  it('isChatsKeyword tolerates stray punctuation', () => {
    expect(isChatsKeyword('chats.')).toBe(true);
  });
});

describe('focus_closed handling in relayWorkerFreeText', () => {
  beforeEach(() => jest.clearAllMocks());

  it('on focus_closed with ≥2 open threads: sends ended notice, clears focus, sends picker', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }) // tos check
      .mockResolvedValueOnce({ rows: [                                          // sendChatsPickerOrAutoFocus
        { id: 'conv-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
        { id: 'conv-b', job_title: 'Electricista', company: 'BuildCo', worker_thread_number: 2 },
      ], rowCount: 2 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({ status: 'focus_closed' });

    const conv = { ...baseConv, focused_job_conversation_id: 'old-closed-conv' };
    const routed = await relayWorkerFreeText(client, conv, msg, WORKER, deps);

    expect(routed).toBe(WORKER);

    // "ended" notice sent
    const notices = (queueOutboxText as jest.Mock).mock.calls.map((c: any[]) => c[3] as string);
    expect(notices.some(t => /terminó|has ended/i.test(t))).toBe(true);

    // Focus cleared to null via setFocusedConversation
    const focusClearCall = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2] && c[2].focused_job_conversation_id === null);
    expect(focusClearCall).toBeDefined();

    // Picker text sent containing both companies
    expect(notices.some(t => /ACME/.test(t) && /BuildCo/.test(t))).toBe(true);
  });

  it('on focus_closed with 1 open thread: sends ended notice, clears focus, auto-focuses survivor', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }) // tos check
      .mockResolvedValueOnce({ rows: [                                          // sendChatsPickerOrAutoFocus
        { id: 'conv-b', job_title: 'Plomero', company: 'BuildCo', worker_thread_number: 2 },
      ], rowCount: 1 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({ status: 'focus_closed' });

    const conv = { ...baseConv, focused_job_conversation_id: 'old-closed-conv' };
    const routed = await relayWorkerFreeText(client, conv, msg, WORKER, deps);

    expect(routed).toBe(WORKER);

    // "ended" notice sent
    const notices = (queueOutboxText as jest.Mock).mock.calls.map((c: any[]) => c[3] as string);
    expect(notices.some(t => /terminó|has ended/i.test(t))).toBe(true);

    // At some point focused_job_conversation_id becomes 'conv-b' (auto-focus)
    const autoFocusCall = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => c[2].focused_job_conversation_id === 'conv-b');
    expect(autoFocusCall).toBeDefined();
  });

  it('on focus_closed with 0 open threads: sends ended notice, clears focus, sends no-conversations message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }) // tos check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                        // sendChatsPickerOrAutoFocus
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({ status: 'focus_closed' });

    const conv = { ...baseConv, focused_job_conversation_id: 'old-closed-conv' };
    const routed = await relayWorkerFreeText(client, conv, msg, WORKER, deps);

    expect(routed).toBe(WORKER);

    const notices = (queueOutboxText as jest.Mock).mock.calls.map((c: any[]) => c[3] as string);
    // "ended" notice
    expect(notices.some(t => /terminó|has ended/i.test(t))).toBe(true);
    // "no open conversations" notice
    expect(notices.some(t => /no open|no tienes/i.test(t))).toBe(true);

    // Focus cleared to null
    const focusClearCall = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2] && c[2].focused_job_conversation_id === null);
    expect(focusClearCall).toBeDefined();
  });
});

describe('conversation:focus button', () => {
  beforeEach(() => jest.clearAllMocks());

  it('focus on open thread: sets focus, clears pending_picker, replies "send your message"', async () => {
    // Mock: thread validation query returns an open thread row
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conv-b' }], rowCount: 1 });
    const conv = {
      ...baseConv,
      user_id: WORKER,
      focused_job_conversation_id: 'conv-a', // was focused on a different thread
      state_context: { pending_picker: { kind: 'chats' as const, threads: [] } },
    };
    const routed = await handleEmployerConversationButton(
      client, conv, msg, { action: 'focus', conversationId: 'conv-b' }, deps);
    expect(routed).toBe(WORKER);
    // Focus must be set to conv-b
    const focusUpdate = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2]);
    expect(focusUpdate).toBeDefined();
    expect(focusUpdate![2].focused_job_conversation_id).toBe('conv-b');
    // pending_picker must be cleared (setFocusedConversation invariant)
    expect(focusUpdate![2].state_context?.pending_picker).toBeUndefined();
    // Confirmation reply asks worker to send their message
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toMatch(/[Ss]end your message|[Ee]scribe tu mensaje/);
  });

  it('conversation:focus button sets fill_relay_override when a fill is armed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conv-b' }], rowCount: 1 });
    const conv = {
      ...baseConv,
      user_id: WORKER,
      focused_job_conversation_id: 'conv-a',
      state_context: {
        fill_application_id: '22222222-2222-2222-2222-222222222222',
        pending_picker: { kind: 'chats' as const, threads: [] },
      },
    };
    const routed = await handleEmployerConversationButton(
      client, conv, msg, { action: 'focus', conversationId: 'conv-b' }, deps);
    expect(routed).toBe(WORKER);
    const focusUpdate = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2]);
    expect(focusUpdate).toBeDefined();
    expect(focusUpdate![2].state_context?.fill_relay_override).toBe(true);
    expect(focusUpdate![2].state_context?.fill_application_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(focusUpdate![2].state_context?.pending_picker).toBeUndefined();
  });

  it('focus on closed thread: replies unavailable, returns null, does not set focus', async () => {
    // Mock: thread validation query returns empty (thread closed or not found)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const conv = { ...baseConv, user_id: WORKER };
    const routed = await handleEmployerConversationButton(
      client, conv, msg, { action: 'focus', conversationId: 'conv-b' }, deps);
    expect(routed).toBeNull();
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3];
    expect(sent).toMatch(/disponible|available/i);
    // Focus must NOT have been set
    const focusUpdate = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2]);
    expect(focusUpdate).toBeUndefined();
  });

  it('focus button is NOT ToS-gated (no legal prompt when ToS not accepted)', async () => {
    // Mock: thread validation returns an open thread — no ToS query should occur
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conv-b' }], rowCount: 1 });
    const conv = { ...baseConv, user_id: WORKER };
    await handleEmployerConversationButton(
      client, conv, msg, { action: 'focus', conversationId: 'conv-b' }, deps);
    expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
    // Only one DB query should have been issued (the thread check), not a ToS SELECT
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/job_conversations/);
    expect(sql).not.toMatch(/tos_version/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FINAL-REVIEW Finding 1b: `setFocusedConversation` must arm
// `fill_relay_override` ONLY when it is actually focusing a real thread
// (`conversationId !== null`). Every call site below passes `null`
// (decline, the close-reason picker resolution, `focus_closed`'s clear) --
// none of them focuses anything, so arming the override there would flag
// the worker's NEXT free-text message for relay with no focused thread to
// relay it to: `handleFillMessage`'s consume step would then return
// `handled:false` and the message (e.g. the worker's real field answer)
// gets silently swallowed instead of either relaying or feeding the fill.
// The three "armed when a fill is armed" tests above (CHATS pick,
// conversation:focus button) all target a REAL conversationId and are
// correctly unaffected by this fix -- these tests cover the complementary
// null-conversationId call sites.
// ─────────────────────────────────────────────────────────────────────────

describe('setFocusedConversation null-focus call sites do not arm fill_relay_override (Finding 1b)', () => {
  beforeEach(() => jest.clearAllMocks());

  const FILL_APP_ID = '33333333-3333-3333-3333-333333333333';

  it('decline via button: does NOT arm fill_relay_override even when a fill is armed', async () => {
    (declineWorkerConversationFromButton as jest.Mock).mockResolvedValueOnce(true);
    const conv = {
      ...baseConv,
      user_id: WORKER,
      focused_job_conversation_id: CONV_A,
      state_context: { fill_application_id: FILL_APP_ID },
    };
    const routed = await handleEmployerConversationButton(
      client, conv, msg, { action: 'decline', conversationId: CONV_A }, deps);
    expect(routed).toBeNull();
    const focusClear = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2]);
    expect(focusClear).toBeDefined();
    expect(focusClear![2].focused_job_conversation_id).toBeNull();
    expect('fill_relay_override' in (focusClear![2].state_context ?? {})).toBe(false);
    // fill_application_id itself is untouched (only the override is at issue).
    expect(focusClear![2].state_context?.fill_application_id).toBe(FILL_APP_ID);
  });

  it('decline via typed text: does NOT arm fill_relay_override even when a fill is armed', async () => {
    (declineLatestWorkerConversationFromButtonText as jest.Mock).mockResolvedValueOnce(true);
    const conv = {
      ...baseConv,
      user_id: WORKER,
      focused_job_conversation_id: CONV_A,
      state_context: { fill_application_id: FILL_APP_ID },
    };
    const routed = await handleEmployerConversationTextAction(client, conv, msg, 'decline', deps);
    expect(routed).toBeNull();
    const focusClear = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2]);
    expect(focusClear).toBeDefined();
    expect(focusClear![2].focused_job_conversation_id).toBeNull();
    expect('fill_relay_override' in (focusClear![2].state_context ?? {})).toBe(false);
  });

  it('close-reason picker resolution: does NOT arm fill_relay_override even when a fill is armed', async () => {
    (closeWorkerConversation as jest.Mock).mockResolvedValueOnce(true);
    const conv = {
      ...baseConv,
      focused_job_conversation_id: CONV_A,
      state_context: {
        fill_application_id: FILL_APP_ID,
        pending_picker: { kind: 'close_reason' as const, conversationId: CONV_A },
      },
    };
    const result = await handlePickerResponse(client, conv, { ...msg, body: '1' }, WORKER, deps);
    expect(result).toBe(WORKER);
    const focusClear = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2]);
    expect(focusClear).toBeDefined();
    expect(focusClear![2].focused_job_conversation_id).toBeNull();
    expect('fill_relay_override' in (focusClear![2].state_context ?? {})).toBe(false);
  });

  it('focus_closed auto-clear: does NOT arm fill_relay_override even when a fill is armed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }) // tos check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                        // sendChatsPickerOrAutoFocus: no open threads
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({ status: 'focus_closed' });

    const conv = {
      ...baseConv,
      focused_job_conversation_id: 'old-closed-conv',
      state_context: { fill_application_id: FILL_APP_ID },
    };
    const routed = await relayWorkerFreeText(client, conv, msg, WORKER, deps);
    expect(routed).toBe(WORKER);

    const focusClear = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2] && c[2].focused_job_conversation_id === null);
    expect(focusClear).toBeDefined();
    expect('fill_relay_override' in (focusClear![2].state_context ?? {})).toBe(false);
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
    expect(fields.state_context?.collected?.city).toBe('Austin'); // collected answers preserved
    expect(fields.state_context?.pending_picker).toBeUndefined(); // picker cleared
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

describe('CERRAR/CLOSE contextual close in relayWorkerFreeText', () => {
  beforeEach(() => jest.clearAllMocks());

  it('CERRAR with focused thread sends reason picker and sets close_reason state — does NOT close immediately', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 }); // ToS check
    const conv = { ...baseConv, language: 'es' as const, focused_job_conversation_id: CONV_A };
    const routed = await relayWorkerFreeText(client, conv, { ...msg, body: 'CERRAR' }, WORKER, deps);
    expect(routed).toBe(WORKER);
    // Must NOT call closeWorkerConversation
    expect(closeWorkerConversation).not.toHaveBeenCalled();
    // Must NOT clear focused_job_conversation_id
    const focusClearCall = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2] && c[2].focused_job_conversation_id === null);
    expect(focusClearCall).toBeUndefined();
    // Must call updateConversation with pending_picker.kind === 'close_reason'
    const updateCall = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => c[2].state_context?.pending_picker?.kind === 'close_reason');
    expect(updateCall).toBeDefined();
    expect(updateCall![2].state_context.pending_picker.conversationId).toBe(CONV_A);
    // Must send picker message
    expect(queueOutboxText).toHaveBeenCalledTimes(1);
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(sent).toMatch(/Por qué cierras/i);
    expect(sent).toContain('1.');
    expect(sent).toContain('2.');
    expect(sent).toContain('3.');
    expect(recordWorkerConversationReply).not.toHaveBeenCalled();
  });

  it('CLOSE (EN) with focused thread sends EN reason picker', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    const conv = { ...baseConv, language: 'en' as const, focused_job_conversation_id: CONV_A };
    const routed = await relayWorkerFreeText(client, conv, { ...msg, body: 'CLOSE' }, WORKER, deps);
    expect(routed).toBe(WORKER);
    expect(closeWorkerConversation).not.toHaveBeenCalled();
    expect(queueOutboxText).toHaveBeenCalledTimes(1);
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(sent).toMatch(/Why are you closing/i);
    expect(sent).not.toMatch(/Por qué/);
  });

  it('CERRAR sends Spanish picker when conv.language === "es"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    const conv = { ...baseConv, language: 'es' as const, focused_job_conversation_id: CONV_A };
    await relayWorkerFreeText(client, conv, { ...msg, body: 'CERRAR' }, WORKER, deps);
    const sent = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(sent).toMatch(/Por qué cierras/i);
    expect(sent).not.toMatch(/Why are you closing/i);
  });

  it('CERRAR with no focus: relays as ordinary text (not intercepted)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({ status: 'no_conversation' });
    const conv = { ...baseConv, focused_job_conversation_id: null };
    await relayWorkerFreeText(client, conv, { ...msg, body: 'CERRAR' }, WORKER, deps);
    expect(closeWorkerConversation).not.toHaveBeenCalled();
    expect(recordWorkerConversationReply).toHaveBeenCalled();
  });

  it('isCloseKeyword: exact match only', () => {
    expect(isCloseKeyword('CERRAR')).toBe(true);
    expect(isCloseKeyword('CLOSE')).toBe(true);
    expect(isCloseKeyword('cerrar')).toBe(true);
    expect(isCloseKeyword('close')).toBe(true);
    expect(isCloseKeyword(' CLOSE ')).toBe(true);
    expect(isCloseKeyword('CLOSE NOW')).toBe(false);
    expect(isCloseKeyword('')).toBe(false);
  });

  it('isCloseKeyword tolerates stray punctuation', () => {
    expect(isCloseKeyword('CERRAR!')).toBe(true);
  });
});

describe('normalization regressions — punctuation must not hijack unrelated matchers', () => {
  it('isLikelyOtpCode rejects trailing punctuation, still accepts clean 6-digit codes', () => {
    expect(isLikelyOtpCode('123456.')).toBe(false);
    expect(isLikelyOtpCode('123456')).toBe(true);
  });

  it('parseDisambiguationPick stays null for punctuated input', () => {
    expect(parseDisambiguationPick('1.')).toBeNull();
  });

  it('parseEmployerConversationTextAction tolerates stray punctuation', () => {
    expect(parseEmployerConversationTextAction('abrir.')).toBe('open');
  });
});

describe('EN/ES language assertions for Phase 2 messages', () => {
  beforeEach(() => jest.clearAllMocks());

  // Test 1: focus_closed notice in Spanish
  it('focus_closed "ended" notice is in Spanish when conv.language === "es"', async () => {
    // Mock: ToS check + open-threads query (0 threads, so sendChatsPickerOrAutoFocus returns early)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({ status: 'focus_closed' });
    const conv = {
      ...baseConv,
      language: 'es' as const,
      focused_job_conversation_id: 'old-conv',
    };
    await relayWorkerFreeText(client, conv, msg, WORKER, deps);
    const notices = (queueOutboxText as jest.Mock).mock.calls.map((c: any[]) => c[3] as string);
    const endedNotice = notices[0];
    expect(endedNotice).toMatch(/terminó/); // Spanish
    expect(endedNotice).not.toMatch(/has ended/i); // NOT English
  });

  // Test 2: focus_closed notice in English
  it('focus_closed "ended" notice is in English when conv.language === "en"', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    (recordWorkerConversationReply as jest.Mock).mockResolvedValueOnce({ status: 'focus_closed' });
    const conv = {
      ...baseConv,
      language: 'en' as const,
      focused_job_conversation_id: 'old-conv',
    };
    await relayWorkerFreeText(client, conv, msg, WORKER, deps);
    const notices = (queueOutboxText as jest.Mock).mock.calls.map((c: any[]) => c[3] as string);
    const endedNotice = notices[0];
    expect(endedNotice).toMatch(/has ended/i); // English
    expect(endedNotice).not.toMatch(/terminó/); // NOT Spanish
  });

  // Test 3: CHATS picker header in Spanish
  it('CHATS picker header is in Spanish when conv.language === "es"', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { id: 'conv-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
        { id: 'conv-b', job_title: 'Electricista', company: 'BuildCo', worker_thread_number: 2 },
      ], rowCount: 2 });
    const conv = { ...baseConv, language: 'es' as const, user_id: WORKER };
    await tryConversationRelay(client, conv, { ...msg, body: 'CHATS' }, deps);
    const picker = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(picker).toMatch(/Tus conversaciones/);
    expect(picker).not.toMatch(/Your open/i);
  });

  // Test 4: CHATS picker header in English
  it('CHATS picker header is in English when conv.language === "en"', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { id: 'conv-a', job_title: 'Plumber', company: 'ACME', worker_thread_number: 1 },
        { id: 'conv-b', job_title: 'Electrician', company: 'BuildCo', worker_thread_number: 2 },
      ], rowCount: 2 });
    const conv = { ...baseConv, language: 'en' as const, user_id: WORKER };
    await tryConversationRelay(client, conv, { ...msg, body: 'CHATS' }, deps);
    const picker = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(picker).toMatch(/Your open conversations/i);
    expect(picker).not.toMatch(/Tus conversaciones/);
  });

  // Test 5: CERRAR picker in Spanish
  it('CERRAR picker is in Spanish when conv.language === "es"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    const conv = {
      ...baseConv,
      language: 'es' as const,
      focused_job_conversation_id: 'conv-a',
    };
    await relayWorkerFreeText(client, conv, { ...msg, body: 'CERRAR' }, WORKER, deps);
    const picker = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(picker).toMatch(/Por qué cierras/i);
    expect(picker).not.toMatch(/Why are you closing/i);
  });

  // Test 6: CLOSE picker in English
  it('CLOSE picker is in English when conv.language === "en"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tos_version: '1.0' }], rowCount: 1 });
    const conv = {
      ...baseConv,
      language: 'en' as const,
      focused_job_conversation_id: 'conv-a',
    };
    await relayWorkerFreeText(client, conv, { ...msg, body: 'CLOSE' }, WORKER, deps);
    const picker = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(picker).toMatch(/Why are you closing/i);
    expect(picker).not.toMatch(/Por qué cierras/i);
  });
});

import type { ProfileStateContext } from '../../../../../lambda/whatsapp/lib/flows';

describe('handlePickerResponse — close_reason branch', () => {
  const CLOSE_CONV = 'conv-to-close';
  const baseCloseConv = {
    ...baseConv,
    focused_job_conversation_id: CLOSE_CONV,
    state_context: {
      pending_picker: { kind: 'close_reason' as const, conversationId: CLOSE_CONV },
    } as ProfileStateContext,
  };

  beforeEach(() => jest.clearAllMocks());

  it('pick 1 (found work) closes with "encontró trabajo" system message and clears focus', async () => {
    (closeWorkerConversation as jest.Mock).mockResolvedValueOnce(true);
    const conv = { ...baseCloseConv, language: 'es' as const };
    const result = await handlePickerResponse(client, conv, { ...msg, body: '1' }, WORKER, deps);
    expect(result).toBe(WORKER);
    expect(closeWorkerConversation).toHaveBeenCalledWith(
      client, CLOSE_CONV, WORKER,
      'El trabajador encontró trabajo / Worker found work',
    );
    const focusClear = (deps.updateConversation as jest.Mock).mock.calls.find(
      (c: any[]) => 'focused_job_conversation_id' in c[2]);
    expect(focusClear![2].focused_job_conversation_id).toBeNull();
    const confirmation = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(confirmation).toMatch(/cerrada/i);
  });

  it('pick 2 (not interested) closes with "no está interesado" system message', async () => {
    (closeWorkerConversation as jest.Mock).mockResolvedValueOnce(true);
    const conv = { ...baseCloseConv, language: 'es' as const };
    await handlePickerResponse(client, conv, { ...msg, body: '2' }, WORKER, deps);
    expect(closeWorkerConversation).toHaveBeenCalledWith(
      client, CLOSE_CONV, WORKER,
      'El trabajador no está interesado / Worker is not interested',
    );
  });

  it('pick 3 (other) closes with default system message', async () => {
    (closeWorkerConversation as jest.Mock).mockResolvedValueOnce(true);
    const conv = { ...baseCloseConv, language: 'es' as const };
    await handlePickerResponse(client, conv, { ...msg, body: '3' }, WORKER, deps);
    expect(closeWorkerConversation).toHaveBeenCalledWith(
      client, CLOSE_CONV, WORKER,
      'El trabajador terminó la conversación / Worker ended the conversation',
    );
  });

  it('pick 1 EN sends "Conversation closed." confirmation', async () => {
    (closeWorkerConversation as jest.Mock).mockResolvedValueOnce(true);
    const conv = { ...baseCloseConv, language: 'en' as const };
    await handlePickerResponse(client, conv, { ...msg, body: '1' }, WORKER, deps);
    const confirmation = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(confirmation).toMatch(/Conversation closed/i);
    expect(confirmation).not.toMatch(/cerrada/i);
  });

  it('out-of-range pick 4 reprompts with valid range (ES)', async () => {
    const conv = { ...baseCloseConv, language: 'es' as const };
    const result = await handlePickerResponse(client, conv, { ...msg, body: '4' }, WORKER, deps);
    expect(result).toBe(WORKER);
    expect(closeWorkerConversation).not.toHaveBeenCalled();
    const reprompt = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(reprompt).toMatch(/1 y 3/);
  });

  it('out-of-range pick 0 reprompts (EN)', async () => {
    const conv = { ...baseCloseConv, language: 'en' as const };
    await handlePickerResponse(client, conv, { ...msg, body: '0' }, WORKER, deps);
    expect(closeWorkerConversation).not.toHaveBeenCalled();
    const reprompt = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(reprompt).toMatch(/1 and 3/);
  });

  it('already-closed thread (returns false) sends "ya había terminado" notice', async () => {
    (closeWorkerConversation as jest.Mock).mockResolvedValueOnce(false);
    const conv = { ...baseCloseConv, language: 'es' as const };
    await handlePickerResponse(client, conv, { ...msg, body: '1' }, WORKER, deps);
    const notice = (queueOutboxText as jest.Mock).mock.calls[0][3] as string;
    expect(notice).toMatch(/ya había terminado/i);
  });

  it('non-numeric body returns null (falls through to relay)', async () => {
    const conv = { ...baseCloseConv };
    const result = await handlePickerResponse(client, conv, { ...msg, body: 'hola' }, WORKER, deps);
    expect(result).toBeNull();
    expect(closeWorkerConversation).not.toHaveBeenCalled();
  });
});
