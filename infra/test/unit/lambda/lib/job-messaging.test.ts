const mockQuery = jest.fn();
const client: any = { query: mockQuery };
class MockAmbiguousTwilioSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousTwilioSendError';
  }
}
class MockTwilioTemplateInvalidError extends Error {
  constructor(
    public readonly templateName: string,
    public readonly twilioCode: number,
  ) {
    super(`Twilio template invalid (code ${twilioCode}): ${templateName}`);
    this.name = 'TwilioTemplateInvalidError';
  }
}
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  sendTwilioWhatsAppMessage: jest.fn(),
  queueOutboxText: jest.fn(),
  AmbiguousTwilioSendError: MockAmbiguousTwilioSendError,
  TwilioTemplateInvalidError: MockTwilioTemplateInvalidError,
}));
import { recordWorkerConversationReply, queueConversationMessageFromEmployer, closeWorkerConversation } from '../../../../lambda/lib/job-messaging';

const WORKER = 'aaaaaaaa-0000-0000-0000-000000000001';
const CONV_A = 'bbbbbbbb-0000-0000-0000-00000000000a';
const CONV_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

function openThreadsResult(rows: any[]) {
  return { rows, rowCount: rows.length };
}

describe('recordWorkerConversationReply (focused-thread)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns ambiguous (never recency-routes) when no focus and 2 open threads', async () => {
    // No focusedConversationId -> implementation skips the focused lookup and
    // issues the open-accepted-threads query directly.
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([
        { id: CONV_A, application_id: 'app-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
        { id: CONV_B, application_id: 'app-b', job_title: 'Plomero', company: 'BuildCo', worker_thread_number: 2 },
      ]));
    const result = await recordWorkerConversationReply(
      client, WORKER, 'si puedo el lunes', 'whatsapp:+1512', 'SM1', undefined,
    );
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.threads.map((t: any) => t.conversationId)).toEqual([CONV_A, CONV_B]);
    }
    expect(mockQuery.mock.calls.some(([sql]) =>
      /INSERT INTO job_conversation_messages/.test(sql))).toBe(false);
  });

  it('returns focus_closed (not misrouted) when focused thread is closed', async () => {
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([]))  // focused lookup -> empty (thread closed)
      // NO second mock needed — we early-return before scanning open threads
      .mockResolvedValue({ rows: [], rowCount: 1 }); // cleanup for any stray queries
    const result = await recordWorkerConversationReply(
      client, WORKER, 'hola', 'whatsapp:+1512', 'SM2', 'stale-conversation-id',
    );
    expect(result.status).toBe('focus_closed');
    // Must NOT have inserted any message
    expect(mockQuery.mock.calls.some(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql))).toBe(false);
  });

  it('focus_closed — does NOT route to sole survivor (explicit misroute regression)', async () => {
    // Focus id is set, thread closed. One open survivor exists but MUST NOT be used.
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([]))           // focused lookup -> not open
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await recordWorkerConversationReply(
      client, WORKER, 'hola', 'whatsapp:+1512', 'SM99', 'closed-conv-id',
    );
    expect(result.status).toBe('focus_closed');
    expect(mockQuery.mock.calls.some(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql))).toBe(false);
  });

  it('returns no_conversation when worker has zero open threads', async () => {
    // No focus + no open accepted threads -> gated query empty, then the
    // ungated fallback query also comes back empty.
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([]))
      .mockResolvedValueOnce(openThreadsResult([]));
    const result = await recordWorkerConversationReply(
      client, WORKER, 'hola', 'whatsapp:+1512', 'SM3', undefined,
    );
    expect(result.status).toBe('no_conversation');
  });

  it('marks the conversation accepted on first worker reply', async () => {
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([
        { id: CONV_A, application_id: 'app-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
      ]))
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await recordWorkerConversationReply(client, WORKER, 'hola', 'whatsapp:+1512', 'SM4', CONV_A);
    const update = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_conversations/.test(sql) && /accepted_at/.test(sql));
    expect(update).toBeDefined();
  });

  it('resolves the company label via employer_display_name(), not j.company', async () => {
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([
        { id: CONV_A, application_id: 'app-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
      ]))
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await recordWorkerConversationReply(client, WORKER, 'hola', 'whatsapp:+1512', 'SM5', CONV_A);
    const select = mockQuery.mock.calls.find(([sql]) =>
      /FROM job_conversations jc/.test(sql) && /jc\.id = \$1/.test(sql));
    expect(select).toBeDefined();
    expect(select![0]).toMatch(/employer_display_name\(jc\.employer_id\)/);
  });

  it('routes a bare text to the single open UNACCEPTED thread and flushes waiting messages', async () => {
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([])) // gated query (accepted_at IS NOT NULL) -> 0 rows
      .mockResolvedValueOnce(openThreadsResult([
        { id: CONV_A, application_id: 'app-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
      ])) // fallback query (no accepted_at predicate) -> 1 row
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT inbound worker message
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE job_conversations accepted_at COALESCE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE job_applications -> talking
      .mockResolvedValueOnce({ rows: [{ id: 'em-1', body: 'hola trabajador' }], rowCount: 1 }) // pending employer messages (waiting_worker_reply)
      .mockResolvedValue({ rows: [], rowCount: 1 }); // outbox insert + message status='queued' update
    const result = await recordWorkerConversationReply(
      client, WORKER, 'hola', 'whatsapp:+1512', 'SM6', undefined,
    );
    expect(result).toEqual({ status: 'routed', conversationId: CONV_A });

    const [gatedSql] = mockQuery.mock.calls[0];
    const [fallbackSql] = mockQuery.mock.calls[1];
    expect(gatedSql).toMatch(/accepted_at IS NOT NULL/);
    expect(fallbackSql).not.toMatch(/accepted_at IS NOT NULL/);

    expect(mockQuery.mock.calls.some(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql))).toBe(true);
    const conversationUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE job_conversations/.test(sql) && /accepted_at/.test(sql));
    expect(conversationUpdate).toBeDefined();
    const applicationUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE job_applications/.test(sql));
    expect(applicationUpdate).toBeDefined();

    // The "flushes waiting messages" half of the contract: the pending
    // employer message (em-1, still 'waiting_worker_reply') must actually
    // get queued as a freeform outbox row addressed to the worker's number,
    // and the source message row flipped to 'queued'.
    const outboxInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO job_message_outbox/.test(sql) && /'freeform'/.test(sql));
    expect(outboxInsert).toBeDefined();
    expect(outboxInsert![1]).toEqual([CONV_A, 'em-1', '+1512', expect.stringContaining('hola trabajador')]);

    const messageQueuedUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE job_conversation_messages/.test(sql) && /status = 'queued'/.test(sql));
    expect(messageQueuedUpdate).toBeDefined();
    expect(messageQueuedUpdate![1]).toEqual(['em-1']);
  });

  it('returns ambiguous with the unaccepted threads when several exist and none is accepted', async () => {
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([])) // gated query -> 0 rows
      .mockResolvedValueOnce(openThreadsResult([
        { id: CONV_A, application_id: 'app-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
        { id: CONV_B, application_id: 'app-b', job_title: 'Plomero', company: 'BuildCo', worker_thread_number: 2 },
      ])); // fallback -> 2 rows
    const result = await recordWorkerConversationReply(
      client, WORKER, 'hola', 'whatsapp:+1512', 'SM7', undefined,
    );
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.threads.map((t: any) => t.conversationId)).toEqual([CONV_A, CONV_B]);
    }
    expect(mockQuery.mock.calls.some(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql))).toBe(false);
  });

  it('still returns no_conversation when the worker has no open threads at all', async () => {
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([])) // gated query -> 0 rows
      .mockResolvedValueOnce(openThreadsResult([])); // fallback -> 0 rows
    const result = await recordWorkerConversationReply(
      client, WORKER, 'hola', 'whatsapp:+1512', 'SM8', undefined,
    );
    expect(result.status).toBe('no_conversation');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

import { sendPendingJobMessageOutbox } from '../../../../lambda/lib/job-messaging';
import { sendTwilioWhatsAppMessage, AmbiguousTwilioSendError, TwilioTemplateInvalidError } from '../../../../lambda/whatsapp/lib/outbox';

const CONV_B2 = 'bbbbbbbb-0000-0000-0000-00000000000c';

describe('sendPendingJobMessageOutbox hardening (R8)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a failing row skips the REST of its conversation but other conversations still send', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // set_config (RLS context)
      .mockResolvedValueOnce({ rows: [
        { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: 'a1', content_template: null, content_variables: null },
        { id: 'o2', conversation_id: CONV_A, message_id: 'm2', whatsapp_number: '+1', body: 'a2', content_template: null, content_variables: null },
        { id: 'o3', conversation_id: CONV_B2, message_id: 'm3', whatsapp_number: '+1', body: 'b1', content_template: null, content_variables: null },
      ], rowCount: 3 })                                    // SELECT pending
      .mockResolvedValue({ rows: [], rowCount: 1 });       // all subsequent updates
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('twilio down'))     // o1 fails
      .mockResolvedValue('SMxx');                          // o3 succeeds
    await expect(sendPendingJobMessageOutbox(client, { actorUserId: WORKER }))
      .resolves.toBeUndefined();                           // no rethrow (mixed outcome)
    expect(sendTwilioWhatsAppMessage).toHaveBeenCalledTimes(2); // o1 attempted + o3; o2 SKIPPED
  });

  it('selects only rows under the attempt cap', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER });
    const selectCall = mockQuery.mock.calls.find(([sql]) => /FROM job_message_outbox/.test(sql));
    expect(selectCall![0]).toMatch(/attempt_count < 5/);
  });

  it('rethrows when ALL pending rows are in failed conversations (total outage)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // set_config
      .mockResolvedValueOnce({ rows: [
        { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: 'fail', content_template: null, content_variables: null },
      ], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('total outage'));
    await expect(sendPendingJobMessageOutbox(client, { actorUserId: WORKER }))
      .rejects.toThrow('total outage');
  });

  it('parks an ambiguous (accepted-but-timed-out) send as send_unknown, not failed, and leaves the message row alone', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // set_config
      .mockResolvedValueOnce({ rows: [
        { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: 'a1', content_template: null, content_variables: null },
        { id: 'o2', conversation_id: CONV_B2, message_id: 'm2', whatsapp_number: '+1', body: 'b1', content_template: null, content_variables: null },
      ], rowCount: 2 })                                    // SELECT pending
      .mockResolvedValue({ rows: [], rowCount: 1 });       // subsequent updates
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new AmbiguousTwilioSendError('Twilio request timed out')) // o1 ambiguous
      .mockResolvedValue('SMxx');                          // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER });

    const outboxUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_message_outbox/.test(sql) && /SET status = \$1/.test(sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate![1]).toEqual(['send_unknown', 'Twilio request timed out', 'o1']);

    const messageUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_conversation_messages/.test(sql) && /status = 'failed'/.test(sql));
    expect(messageUpdate).toBeUndefined();
  });

  it('marks a normal (non-ambiguous) send error as failed, including the message row', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // set_config
      .mockResolvedValueOnce({ rows: [
        { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: 'a1', content_template: null, content_variables: null },
        { id: 'o2', conversation_id: CONV_B2, message_id: 'm2', whatsapp_number: '+1', body: 'b1', content_template: null, content_variables: null },
      ], rowCount: 2 })                                    // SELECT pending
      .mockResolvedValue({ rows: [], rowCount: 1 });       // subsequent updates
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('Twilio 400 bad request'))  // o1 fails
      .mockResolvedValue('SMxx');                                 // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER });

    const outboxUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_message_outbox/.test(sql) && /SET status = \$1/.test(sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate![1]).toEqual(['failed', 'Twilio 400 bad request', 'o1']);

    const messageUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_conversation_messages/.test(sql) && /status = 'failed'/.test(sql));
    expect(messageUpdate).toBeDefined();
    expect(messageUpdate![1]).toEqual(['m1']);
  });

  it('does NOT mark the conversation message sent when a TEMPLATE row sends successfully', async () => {
    // A template row is only the invite — the real text arrives later via
    // the worker-reply flush. Marking the employer message 'sent' here would
    // silently drop it forever, since the flush only rescues rows still in
    // 'waiting_worker_reply'.
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // set_config
      .mockResolvedValueOnce({ rows: [
        { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: null, content_template: 'invite_v1', content_variables: {}, send_kind: 'template' },
      ], rowCount: 1 })                                    // SELECT pending
      .mockResolvedValue({ rows: [], rowCount: 1 });       // subsequent updates
    (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValueOnce('SMtemplate');

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER });

    const outboxUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_message_outbox/.test(sql) && /SET status = 'sent'/.test(sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate![1]).toEqual(['o1', 'SMtemplate']);

    const messageUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_conversation_messages/.test(sql) && /status = 'sent'/.test(sql));
    expect(messageUpdate).toBeUndefined();
  });

  it('still marks the conversation message failed when a template row fails unambiguously', async () => {
    // Failure-marking is unchanged for both send kinds: a dead invite must
    // still surface as 'failed' on the employer's message.
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // set_config
      .mockResolvedValueOnce({ rows: [
        { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: null, content_template: 'invite_v1', content_variables: {}, send_kind: 'template' },
        { id: 'o2', conversation_id: CONV_B2, message_id: 'm2', whatsapp_number: '+1', body: 'b1', content_template: null, content_variables: null, send_kind: 'freeform' },
      ], rowCount: 2 })                                    // SELECT pending
      .mockResolvedValue({ rows: [], rowCount: 1 });       // subsequent updates
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('Twilio 400 bad request'))  // o1 (template) fails
      .mockResolvedValue('SMxx');                                 // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER });

    const messageUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_conversation_messages/.test(sql) && /status = 'failed'/.test(sql));
    expect(messageUpdate).toBeDefined();
    expect(messageUpdate![1]).toEqual(['m1']);
  });

  it('emits JobMessageTemplateSidInvalid when the send throws TwilioTemplateInvalidError', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // set_config
      .mockResolvedValueOnce({ rows: [
        { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: null, content_template: 'employer_message_invite_es', content_variables: {}, send_kind: 'template' },
        { id: 'o2', conversation_id: CONV_B2, message_id: 'm2', whatsapp_number: '+1', body: 'b1', content_template: null, content_variables: null, send_kind: 'freeform' },
      ], rowCount: 2 })                                    // SELECT pending
      .mockResolvedValue({ rows: [], rowCount: 1 });       // subsequent updates
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new TwilioTemplateInvalidError('employer_message_invite_es', 21655))  // o1 fails
      .mockResolvedValue('SMxx');                                 // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER });

    const metricLog = logSpy.mock.calls.find(([line]) =>
      typeof line === 'string' && line.includes('JobMessageTemplateSidInvalid'));
    expect(metricLog).toBeDefined();
    expect(JSON.parse(metricLog![0] as string)).toEqual({
      metric: 'JobMessageTemplateSidInvalid',
      template: 'employer_message_invite_es',
      conversationId: CONV_A,
      outboxId: 'o1',
    });

    const outboxUpdate = mockQuery.mock.calls.find(([sql]) =>
      /UPDATE job_message_outbox/.test(sql) && /SET status = \$1/.test(sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate![0]).toMatch(/attempt_count = attempt_count \+ 1/);
    expect(outboxUpdate![1]).toEqual([
      'failed',
      'Twilio template invalid (code 21655): employer_message_invite_es',
      'o1',
    ]);

    logSpy.mockRestore();
  });
});

import { createApplicantConversation } from '../../../../lambda/lib/job-messaging';

const EMPLOYER = 'cccccccc-0000-0000-0000-000000000001';

// Minimal ConversationAccessRow as returned by loadConversationForEmployer.
function conversationAccessRow(overrides: any = {}) {
  return {
    id: CONV_A, job_id: 'job-1', employer_id: EMPLOYER, worker_id: WORKER,
    application_id: 'app-a', status: 'open',
    worker_phone: '+15125551234', worker_language: 'es',
    company_name: 'ACME', job_title: 'Plomero',
    last_worker_message_at: null,  // window CLOSED -> template branch
    ...overrides,
  };
}

describe('queueConversationMessageFromEmployer template dedupe (R7)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not queue a second invite template while one is un-actioned', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [conversationAccessRow()], rowCount: 1 })   // loadConversationForEmployer
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // setInternalUserRlsContext(worker)
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ready' }], rowCount: 1 })    // loadWorkerGate -> ready
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // setInternalUserRlsContext(employer)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 })            // INSERT message (waiting_worker_reply)
      .mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 })           // pending-template EXISTS check -> true
      .mockResolvedValue({ rows: [], rowCount: 1 });                              // remaining updates
    await queueConversationMessageFromEmployer(client, CONV_A, EMPLOYER, 'second overnight msg');
    const queuedTemplate = mockQuery.mock.calls.some(([sql]) =>
      /INSERT INTO job_message_outbox/.test(sql) && /'template'/.test(sql));
    expect(queuedTemplate).toBe(false);
  });

  it('queues a template when none is pending yet', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [conversationAccessRow()], rowCount: 1 })   // load
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // setInternalUserRlsContext(worker)
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ready' }], rowCount: 1 })    // loadWorkerGate -> ready
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // setInternalUserRlsContext(employer)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 })            // INSERT message
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 })          // pending-template EXISTS -> false
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await queueConversationMessageFromEmployer(client, CONV_A, EMPLOYER, 'first overnight msg');
    const queuedTemplate = mockQuery.mock.calls.some(([sql]) =>
      /INSERT INTO job_message_outbox/.test(sql) && /'template'/.test(sql));
    expect(queuedTemplate).toBe(true);
  });

  it('ignores permanently-failed templates in the dedupe check (dead invites must not suppress new ones)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [conversationAccessRow()], rowCount: 1 })   // load
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // setInternalUserRlsContext(worker)
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ready' }], rowCount: 1 })    // loadWorkerGate -> ready
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // setInternalUserRlsContext(employer)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 })            // INSERT message
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 })          // dedupe EXISTS
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await queueConversationMessageFromEmployer(client, CONV_A, EMPLOYER, 'msg after dead template');
    const dedupeSql = mockQuery.mock.calls
      .map(([sql]) => sql as string)
      .find((sql) => /send_kind = 'template'/.test(sql) && /SELECT EXISTS/.test(sql));
    expect(dedupeSql).toBeDefined();
    // A template that exhausted its send attempts was never delivered — it is
    // not an "un-actioned invite" and must not suppress queueing a new one.
    expect(dedupeSql!).toMatch(/NOT \(status = 'failed' AND attempt_count >= 5\)/);
  });
});

describe('createApplicantConversation thread-number assignment', () => {
  beforeEach(() => jest.clearAllMocks());

  it('assigns worker_thread_number via assign_worker_thread_number on create', async () => {
    const EMP = 'cccccccc-0000-0000-0000-000000000001';
    const accessRow = {
      job_id: 'job-1', employer_id: EMP, worker_id: WORKER, application_id: 'app-a',
      worker_phone: '+15125551234', worker_language: 'es', company_name: 'ACME', job_title: 'Plomero',
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [accessRow], rowCount: 1 })        // (1) access check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // (2) existing OPEN conversation: none
      .mockResolvedValueOnce({ rows: [{ n: 3 }], rowCount: 1 })         // (3) assign_worker_thread_number -> 3
      .mockResolvedValueOnce({ rows: [{ id: CONV_A }], rowCount: 1 })   // (4) INSERT ... RETURNING id
      .mockResolvedValueOnce({ rows: [{                                 // (5) re-SELECT building ConversationAccessRow
        id: CONV_A, job_id: 'job-1', employer_id: EMP, worker_id: WORKER, application_id: 'app-a',
        status: 'open', worker_phone: '+15125551234', worker_language: 'es',
        company_name: 'ACME', job_title: 'Plomero', last_worker_message_at: null,
        worker_thread_number: 3,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ active: false }], rowCount: 1 }) // (6) cross-session EXISTS check -> no active session
      .mockResolvedValueOnce({ rows: [{                                 // (7) loadConversationForEmployer (inside queueConversationMessageFromEmployer)
        id: CONV_A, job_id: 'job-1', employer_id: EMP, worker_id: WORKER, application_id: 'app-a',
        status: 'open', worker_phone: '+15125551234', worker_language: 'es',
        company_name: 'ACME', job_title: 'Plomero', last_worker_message_at: null,
        worker_thread_number: 3,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // (8) setInternalUserRlsContext(worker)
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ready' }], rowCount: 1 }) // (9) loadWorkerGate -> ready
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // (10) setInternalUserRlsContext(employer)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 })  // (11) INSERT job_conversation_messages
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 }) // (12) pending-template EXISTS check -> false
      .mockResolvedValue({ rows: [], rowCount: 1 });                    // (13+) INSERT outbox, UPDATE conversations, UPDATE applications

    await createApplicantConversation(client, EMP, 'job-1', WORKER, 'hola, te escribo sobre el trabajo');

    // Assertion (a): counter function was called with workerId
    expect(mockQuery.mock.calls.some(([sql]) =>
      /assign_worker_thread_number\s*\(\s*\$1\s*\)/.test(sql))).toBe(true);

    // Assertion (b): INSERT includes worker_thread_number column
    const insert = mockQuery.mock.calls.find(([sql]) =>
      /INSERT INTO job_conversations/.test(sql));
    expect(insert).toBeDefined();
    expect(insert![0]).toMatch(/worker_thread_number/);
  });
});

describe('closeWorkerConversation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('closes the focused thread and inserts a system message, returns true', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE: 1 row affected
      .mockResolvedValue({ rows: [], rowCount: 1 });    // INSERT system message
    const closed = await closeWorkerConversation(client, CONV_A, WORKER);
    expect(closed).toBe(true);
    const systemInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql) && /'system'/.test(sql));
    expect(systemInsert).toBeDefined();
  });

  it('returns false when thread is already closed (UPDATE matches 0 rows)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE: no rows
    const closed = await closeWorkerConversation(client, CONV_A, WORKER);
    expect(closed).toBe(false);
    // No INSERT should have occurred
    const systemInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql));
    expect(systemInsert).toBeUndefined();
  });

  it('uses custom systemMessageBody when provided', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // UPDATE → closed
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // INSERT system message
    await closeWorkerConversation(client, CONV_A, WORKER, 'El trabajador encontró trabajo / Worker found work');
    const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql));
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain('El trabajador encontró trabajo / Worker found work');
  });

  it('uses default body when systemMessageBody is omitted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await closeWorkerConversation(client, CONV_A, WORKER);
    const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO job_conversation_messages/.test(sql));
    expect(insertCall![1]).toContain('El trabajador terminó la conversación / Worker ended the conversation');
  });
});

describe('queueConversationMessageFromEmployer onboarding gate', () => {
  beforeEach(() => jest.clearAllMocks());

  // A scripted client that dispatches by SQL substring rather than call
  // order — resilient to internal reordering, matches the convention used
  // by worker-delivery-gateway.test.ts's scriptedClient.
  function scriptedClient() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM job_conversations jc\s*\n\s*JOIN jobs j/.test(sql) && /jc\.id = \$1/.test(sql)) {
        return { rows: [conversationAccessRow()], rowCount: 1 };
      }
      if (/INSERT INTO job_conversation_messages/.test(sql)) {
        return { rows: [{ id: 'msg-v2-1' }], rowCount: 1 };
      }
      if (/INSERT INTO worker_message_intents/.test(sql)) {
        return { rows: [{ id: 'intent-1', outbox_id: null, status: 'deferred' }] };
      }
      if (/FROM worker_onboarding_state/.test(sql)) {
        return { rows: [] };
      }
      if (/UPDATE worker_message_intents/.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 1 };
    });
    return { query, calls };
  }

  // 2026-07-27 parity-audit fix: the intent path is for ONBOARDING workers
  // only. Routing READY workers through it destroyed the employer's text
  // (row stamped 'queued', no outbox row ever, flush only rescues
  // 'waiting_worker_reply'). scriptedClient's default gate response (no
  // worker_onboarding_state rows) models the onboarding/no-row case; the
  // ready case overrides it below.
  function scriptedClientWithReadyGate() {
    const base = scriptedClient();
    const inner = base.query.getMockImplementation()!;
    base.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/FROM worker_onboarding_state/.test(sql)) {
        base.calls.push({ sql, params });
        return {
          rows: [{
            user_id: WORKER, lifecycle: 'ready', run_id: 'run-1',
            workflow_version: 1, current_step_key: 'trust.question.3',
            status: 'completed', preferred_language: 'es', lock_version: 9,
          }],
          rowCount: 1,
        };
      }
      return inner(sql, params);
    });
    return base;
  }

  it('a READY worker takes the v1 freeform path with the text intact — never the intent', async () => {
    const { query, calls } = scriptedClientWithReadyGate();
    // Open reply window -> freeform.
    const openWindowRow = conversationAccessRow({ last_worker_message_at: new Date(), worker_thread_number: 1 });
    query.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [openWindowRow], rowCount: 1 };
    });

    await queueConversationMessageFromEmployer({ query } as any, CONV_A, EMPLOYER, 'te espero manana a las 8');

    // No intent — the employer's words travel the real delivery path.
    expect(calls.some((c) => /INSERT INTO worker_message_intents/.test(c.sql))).toBe(false);
    const freeform = calls.find((c) =>
      /INSERT INTO job_message_outbox/.test(c.sql) && c.params.some((p) => typeof p === 'string' && (p as string).includes('te espero manana a las 8')));
    expect(freeform).toBeDefined();
    // Freeform-eligible message keeps the v1 'queued' stamp.
    const msgInsert = calls.find((c) => /INSERT INTO job_conversation_messages/.test(c.sql));
    expect(msgInsert!.params[2]).toBe('queued');
  });

  it('an ONBOARDING worker (no gate row) gets the intent AND the text is stamped waiting_worker_reply even inside the reply window', async () => {
    const { query, calls } = scriptedClient(); // gate: no rows -> onboarding
    const openWindowRow = conversationAccessRow({ last_worker_message_at: new Date() });
    query.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [openWindowRow], rowCount: 1 };
    });

    await queueConversationMessageFromEmployer({ query } as any, CONV_A, EMPLOYER, 'hola');

    expect(calls.some((c) => /INSERT INTO worker_message_intents/.test(c.sql))).toBe(true);
    // The stored row is the ONLY carrier of the text on this path: it must
    // be flush-recoverable, never 'queued'.
    const msgInsert = calls.find((c) => /INSERT INTO job_conversation_messages/.test(c.sql));
    expect(msgInsert!.params[2]).toBe('waiting_worker_reply');
  });

  it('a worker whose phone fails to normalize now takes the same gate read as everyone else — deferred intent, not the old v1 freeform fallback', async () => {
    // Known, accepted behavior change: previously a null/unparseable
    // worker_phone short-circuited v2Enabled to false and fell through to
    // the v1 freeform/template path untouched. With the gate unconditional,
    // a worker with no phone and no gate row is just another ONBOARDING
    // worker: the intent path, same as anyone else without a ready gate row.
    const { query, calls } = scriptedClient(); // gate: no rows -> onboarding
    const noPhoneRow = conversationAccessRow({ worker_phone: null, last_worker_message_at: new Date() });
    query.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [noPhoneRow], rowCount: 1 };
    });

    await queueConversationMessageFromEmployer({ query } as any, CONV_A, EMPLOYER, 'hola');

    expect(calls.some((c) => /INSERT INTO job_message_outbox/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INSERT INTO worker_message_intents/.test(c.sql))).toBe(true);
    const msgInsert = calls.find((c) => /INSERT INTO job_conversation_messages/.test(c.sql));
    expect(msgInsert!.params[2]).toBe('waiting_worker_reply');
  });

  it('a matched worker creates exactly one employer_chat intent with the exact dedupe key and expiry, and issues no job_message_outbox insert', async () => {
    const { query, calls } = scriptedClient();
    const beforeMs = Date.now();

    await queueConversationMessageFromEmployer({ query } as any, CONV_A, EMPLOYER, 'hola');

    expect(calls.some((c) => /INSERT INTO job_message_outbox/.test(c.sql))).toBe(false);

    const intentInserts = calls.filter((c) => /INSERT INTO worker_message_intents/.test(c.sql));
    expect(intentInserts).toHaveLength(1);
    const params = intentInserts[0].params;
    expect(params[0]).toBe(WORKER);
    expect(params[1]).toBe('employer_chat');
    expect(params[2]).toBe('job-messaging');
    expect(params[3]).toBe('job_conversation_message');
    expect(params[4]).toBe('msg-v2-1');
    expect(params[5]).toBe('employer-chat:msg-v2-1');
    expect(params[6]).toBe(40);
    expect(JSON.parse(params[8] as string)).toEqual({
      conversationId: CONV_A,
      companyName: 'ACME',
      jobTitle: 'Plomero',
    });
    const expiresAt = params[9] as Date;
    const expectedExpiryMs = beforeMs + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt.getTime() - expectedExpiryMs)).toBeLessThan(5000);

    // job_conversation_messages insert (unchanged) still happened.
    expect(calls.some((c) => /INSERT INTO job_conversation_messages/.test(c.sql))).toBe(true);

    const workerContextIndex = calls.findIndex((c) =>
      c.sql.includes("set_config('app.current_internal_user_id'") &&
      c.params[0] === WORKER);
    const intentIndex = calls.findIndex((c) => /INSERT INTO worker_message_intents/.test(c.sql));
    const restoredEmployerContextIndex = calls.findIndex((c, index) =>
      index > intentIndex &&
      c.sql.includes("set_config('app.current_internal_user_id'") &&
      c.params[0] === EMPLOYER);
    const conversationUpdateIndex = calls.findIndex((c) =>
      /UPDATE job_conversations/.test(c.sql));
    expect(workerContextIndex).toBeGreaterThanOrEqual(0);
    expect(intentIndex).toBeGreaterThan(workerContextIndex);
    expect(restoredEmployerContextIndex).toBeGreaterThan(intentIndex);
    expect(conversationUpdateIndex).toBeGreaterThan(restoredEmployerContextIndex);

  });

  it('a repeated employer send does not create a second intent for the same message', async () => {
    const { query, calls } = scriptedClient();

    await queueConversationMessageFromEmployer({ query } as any, CONV_A, EMPLOYER, 'hola');
    await queueConversationMessageFromEmployer({ query } as any, CONV_A, EMPLOYER, 'hola de nuevo');

    // Each call inserts a fresh job_conversation_messages row (distinct
    // messageId), so each gets its own dedupe_key — this asserts the two
    // dedupe keys are message-scoped and distinct, matching the intent
    // table's design (dedupeKey `employer-chat:<messageId>`), not that a
    // single call is repeated (that dedupe is enqueueWorkerMessage's own
    // ON CONFLICT, covered in worker-delivery-gateway.test.ts).
    const intentInserts = calls.filter((c) => /INSERT INTO worker_message_intents/.test(c.sql));
    expect(intentInserts).toHaveLength(2);
    expect(intentInserts[0].params[5]).toBe(intentInserts[1].params[5]); // same messageId mock -> same dedupe key
  });
});

describe('context header on employer freeform messages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('freeform employer message includes 🏢 context header', async () => {
    // last_worker_message_at: new Date() makes it a freeform (window open)
    const row = conversationAccessRow({ worker_thread_number: 2, last_worker_message_at: new Date() });
    mockQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 }) // loadConversationForEmployer
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // setInternalUserRlsContext(worker)
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ready' }], rowCount: 1 }) // loadWorkerGate -> ready
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // setInternalUserRlsContext(employer)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 }) // INSERT message
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await queueConversationMessageFromEmployer(client, CONV_A, EMPLOYER, 'Hola, ¿puedes?');
    const outboxInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO job_message_outbox/.test(sql) || /INSERT INTO.*outbox/.test(sql));
    // The body argument (one of the $N params) should start with 🏢
    const params: any[] = outboxInsert![1];
    const bodyParam = params.find((p: any) => typeof p === 'string' && p.startsWith('🏢'));
    expect(bodyParam).toBeDefined();
    expect(bodyParam).toMatch(/^🏢 ACME — Plomero \(#2\)\n/);
    expect(bodyParam).toContain('Hola, ¿puedes?');
  });

  it('template path does NOT get a header', async () => {
    // last_worker_message_at: null → window closed → template branch
    const row = conversationAccessRow({ worker_thread_number: 1, last_worker_message_at: null });
    mockQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // setInternalUserRlsContext(worker)
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ready' }], rowCount: 1 }) // loadWorkerGate -> ready
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // setInternalUserRlsContext(employer)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await queueConversationMessageFromEmployer(client, CONV_A, EMPLOYER, 'Hola');
    // All INSERT INTO outbox calls should NOT have a body param starting with 🏢
    const outboxInserts = mockQuery.mock.calls.filter(([sql]: [string]) =>
      /INSERT INTO.*outbox/.test(sql) || /INSERT INTO job_message_outbox/.test(sql));
    outboxInserts.forEach((call: [string, any[]]) => {
      const params: any[] = call[1];
      const hasHeader = params.some((p: any) => typeof p === 'string' && p.includes('🏢'));
      expect(hasHeader).toBe(false);
    });
  });
});

describe('template outbox visibility (spec 2026-08-13)', () => {
  it('queueWorkerInviteTemplate carries the message_id so failures mark the employer message', async () => {
    // Drive queueConversationMessageFromEmployer down the template path:
    // conversation loaded, worker gate ready, reply window closed (default
    // conversationAccessRow has last_worker_message_at: null), no pending invite.
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const scriptedQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      // Distinguish loadConversationForEmployer from the pendingInvite EXISTS
      // check below — both contain "FROM job_conversations jc" (the dedupe
      // query joins it in a subquery), so also require the jobs join that
      // only the top-level load performs.
      if (sql.includes('FROM job_conversations jc') && sql.includes('JOIN jobs j')) {
        return { rows: [conversationAccessRow()], rowCount: 1 };
      }
      if (sql.includes('FROM worker_onboarding_state')) {
        return { rows: [{ lifecycle: 'ready' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO job_conversation_messages')) {
        return { rows: [{ id: 'msg-77' }], rowCount: 1 };
      }
      if (sql.includes('SELECT EXISTS')) {
        return { rows: [{ exists: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await queueConversationMessageFromEmployer({ query: scriptedQuery } as any, CONV_A, EMPLOYER, 'hola');

    const outboxInsert = calls.find((c) => c.sql.includes('INSERT INTO job_message_outbox'));
    expect(outboxInsert).toBeDefined();
    expect(outboxInsert!.sql).toContain('message_id');
    expect(outboxInsert!.params).toContain('msg-77');
  });
});
