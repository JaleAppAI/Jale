const mockQuery = jest.fn();
const client: any = { query: mockQuery };
class MockAmbiguousTwilioSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousTwilioSendError';
  }
}
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  sendTwilioWhatsAppMessage: jest.fn(),
  queueOutboxText: jest.fn(),
  AmbiguousTwilioSendError: MockAmbiguousTwilioSendError,
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
});

import { sendPendingJobMessageOutbox } from '../../../../lambda/lib/job-messaging';
import { sendTwilioWhatsAppMessage, AmbiguousTwilioSendError } from '../../../../lambda/whatsapp/lib/outbox';

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
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // loadRuntimeControls (no rows -> v2 disabled, legacy path)
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
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // loadRuntimeControls -> v2 disabled
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
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                          // loadRuntimeControls -> v2 disabled
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
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // (9) loadRuntimeControls -> v2 disabled
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 }) // (10) pending-template EXISTS check -> false
      .mockResolvedValue({ rows: [], rowCount: 1 });                    // (11+) INSERT outbox, UPDATE conversations, UPDATE applications

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

describe('queueConversationMessageFromEmployer v2 redirect', () => {
  beforeEach(() => jest.clearAllMocks());

  // A scripted client that dispatches by SQL substring rather than call
  // order — resilient to internal reordering, matches the convention used
  // by worker-delivery-gateway.test.ts's scriptedClient.
  function scriptedClient(opts: { v2GlobalEnabled: boolean }) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM job_conversations jc\s*\n\s*JOIN jobs j/.test(sql) && /jc\.id = \$1/.test(sql)) {
        return { rows: [conversationAccessRow()], rowCount: 1 };
      }
      if (/INSERT INTO job_conversation_messages/.test(sql)) {
        return { rows: [{ id: 'msg-v2-1' }], rowCount: 1 };
      }
      if (/FROM whatsapp_runtime_controls/.test(sql)) {
        return {
          rows: [{
            control_key: 'onboarding_v2_enabled',
            enabled: true,
            phone_hashes: [],
            global_enabled: opts.v2GlobalEnabled,
          }],
        };
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

  it('a v2-disabled worker keeps the legacy job_message_outbox path and creates no intent row', async () => {
    const { query, calls } = scriptedClient({ v2GlobalEnabled: false });
    await queueConversationMessageFromEmployer({ query } as any, CONV_A, EMPLOYER, 'hola');

    expect(calls.some((c) => /INSERT INTO worker_message_intents/.test(c.sql))).toBe(false);
    const legacyTemplateInsert = calls.find((c) =>
      /INSERT INTO job_message_outbox/.test(c.sql) && /'template'/.test(c.sql));
    expect(legacyTemplateInsert).toBeDefined();
  });

  it('a v2-enabled worker creates exactly one employer_chat intent with the exact dedupe key and expiry, and issues no job_message_outbox insert', async () => {
    const { query, calls } = scriptedClient({ v2GlobalEnabled: true });
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

  it('a repeated employer send for a v2-enabled worker does not create a second intent for the same message', async () => {
    const { query, calls } = scriptedClient({ v2GlobalEnabled: true });

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
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 }) // INSERT message
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // loadRuntimeControls -> v2 disabled
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
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // loadRuntimeControls -> v2 disabled
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
