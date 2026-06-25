const mockQuery = jest.fn();
const client: any = { query: mockQuery };
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  sendTwilioWhatsAppMessage: jest.fn(),
  queueOutboxText: jest.fn(),
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
    // No focus + no open accepted threads -> single open-threads query returns empty.
    mockQuery.mockResolvedValueOnce(openThreadsResult([]));
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
});

import { sendPendingJobMessageOutbox } from '../../../../lambda/lib/job-messaging';
import { sendTwilioWhatsAppMessage } from '../../../../lambda/whatsapp/lib/outbox';

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
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 })  // (8) INSERT job_conversation_messages
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 }) // (9) pending-template EXISTS check -> false
      .mockResolvedValue({ rows: [], rowCount: 1 });                    // (10+) INSERT outbox, UPDATE conversations, UPDATE applications

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

describe('context header on employer freeform messages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('freeform employer message includes 🏢 context header', async () => {
    // last_worker_message_at: new Date() makes it a freeform (window open)
    const row = conversationAccessRow({ worker_thread_number: 2, last_worker_message_at: new Date() });
    mockQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 }) // loadConversationForEmployer
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
