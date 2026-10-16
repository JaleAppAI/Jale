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
import {
  recordWorkerConversationReply,
  queueConversationMessageFromEmployer,
  closeWorkerConversation,
  listEmployerConversations,
  getEmployerConversationDetail,
} from '../../../../lambda/lib/job-messaging';

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
const EMPLOYER_ID = 'cccccccc-0000-0000-0000-0000000000e1';

// A client that answers by statement, not by call order, and records the
// transaction state at each Twilio send.
function outboxClient(pendingRows: any[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let inTransaction = false;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*BEGIN/i.test(sql)) inTransaction = true;
    if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) inTransaction = false;
    if (/FROM job_message_outbox o/.test(sql)) return { rows: pendingRows, rowCount: pendingRows.length };
    return { rows: [], rowCount: 1 };
  });
  return { client: { query } as any, calls, isInTransaction: () => inTransaction };
}

const freeformRow = (id: string, conversationId: string, messageId: string, body: string) => ({
  id, conversation_id: conversationId, message_id: messageId, whatsapp_number: '+1', body,
  content_template: null, content_variables: null, send_kind: 'freeform',
});

describe('sendPendingJobMessageOutbox hardening (R8)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a failing row skips the REST of its conversation but other conversations still send', async () => {
    const { client } = outboxClient([
      freeformRow('o1', CONV_A, 'm1', 'a1'),
      freeformRow('o2', CONV_A, 'm2', 'a2'),
      freeformRow('o3', CONV_B2, 'm3', 'b1'),
    ]);
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('twilio down'))     // o1 fails
      .mockResolvedValue('SMxx');                          // o3 succeeds
    await expect(sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' }))
      .resolves.toBeUndefined();                           // no rethrow (mixed outcome)
    expect(sendTwilioWhatsAppMessage).toHaveBeenCalledTimes(2); // o1 attempted + o3; o2 SKIPPED
  });

  it('selects only rows under the attempt cap', async () => {
    const { client, calls } = outboxClient([]);
    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });
    const selectCall = calls.find((c) => /FROM job_message_outbox/.test(c.sql));
    expect(selectCall!.sql).toMatch(/attempt_count < 5/);
  });

  it('a worker-mode flush names the worker explicitly in its SQL', async () => {
    const { client, calls } = outboxClient([]);
    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });
    const select = calls.find((c) => /FROM job_message_outbox/.test(c.sql))!;
    expect(select.sql).toMatch(/JOIN job_conversations jc ON jc\.id = o\.conversation_id/);
    expect(select.sql).toMatch(/WHERE jc\.worker_id = \$1/);
    expect(select.sql).not.toMatch(/jc\.employer_id/);
    expect(select.params).toEqual([WORKER]);
  });

  it('an employer-mode flush names the employer explicitly and keeps the conversation filter', async () => {
    const { client, calls } = outboxClient([]);
    await sendPendingJobMessageOutbox(client, { conversationId: CONV_A, actorUserId: EMPLOYER_ID, actorKind: 'employer' });
    const select = calls.find((c) => /FROM job_message_outbox/.test(c.sql))!;
    expect(select.sql).toMatch(/WHERE jc\.employer_id = \$1/);
    expect(select.sql).toMatch(/AND o\.conversation_id = \$2/);
    expect(select.params).toEqual([EMPLOYER_ID, CONV_A]);
  });

  it('sets the actor only transaction-locally, inside its own transactions, and never across the Twilio call', async () => {
    const { client, calls, isInTransaction } = outboxClient([freeformRow('o1', CONV_A, 'm1', 'a1')]);
    const openDuringSend: boolean[] = [];
    let callsBeforeSend = -1;
    (sendTwilioWhatsAppMessage as jest.Mock).mockImplementation(async () => {
      openDuringSend.push(isInTransaction());
      callsBeforeSend = calls.length;
      return 'SMxx';
    });
    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });

    expect(openDuringSend).toEqual([false]);
    expect(isInTransaction()).toBe(false);
    const settings = calls.filter((c) => /set_config/.test(c.sql));
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) {
      expect(s.sql).toBe(`SELECT set_config('app.current_internal_user_id', $1, true)`);
      expect(s.params).toEqual([WORKER]);
    }
    // Every set_config directly follows a BEGIN.
    calls.forEach((c, i) => {
      if (/set_config/.test(c.sql)) expect(calls[i - 1].sql).toBe('BEGIN');
    });
    // The statements that touch the outbox all run inside a transaction: the
    // read, the claim (committed before the provider is called), the marks.
    const sequence = calls.map((c) => c.sql.trim().split(/\s+/)[0].toUpperCase());
    expect(sequence).toEqual([
      'BEGIN', 'SELECT', 'SELECT', 'COMMIT',
      'BEGIN', 'SELECT', 'UPDATE', 'COMMIT',
      'BEGIN', 'SELECT', 'UPDATE', 'UPDATE', 'COMMIT',
    ]);
    expect(callsBeforeSend).toBe(8);
    expect(calls[6].sql).toMatch(/SET status = 'send_unknown'/);
  });

  it('claims each row before the provider call with a statement that names the caller', async () => {
    for (const [actorKind, actorUserId, column] of [
      ['worker', WORKER, 'jc.worker_id'],
      ['employer', EMPLOYER_ID, 'jc.employer_id'],
    ] as const) {
      const { client, calls } = outboxClient([freeformRow('o1', CONV_A, 'm1', 'a1')]);
      (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValue('SMxx');
      await sendPendingJobMessageOutbox(client, { actorUserId, actorKind });
      const claim = calls.find((c) => /SET status = 'send_unknown'/.test(c.sql));
      const text = claim!.sql.replace(/\s+/g, ' ');
      expect(text).toContain("o.status IN ('pending', 'failed')");
      expect(text).toContain('o.attempt_count < 5');
      expect(text).toContain(`AND ${column} = $2`);
      expect(claim!.params).toEqual(['o1', actorUserId]);
    }
  });

  it('skips a row another flush has claimed, and the rest of its conversation, and still sends the other conversations', async () => {
    const { client, calls } = outboxClient([
      freeformRow('o1', CONV_A, 'm1', 'a1'),
      freeformRow('o2', CONV_A, 'm2', 'a2'),
      freeformRow('o3', CONV_B2, 'm3', 'b1'),
    ]);
    const inner = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/SET status = 'send_unknown'/.test(sql) && params[0] === 'o1') {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }
      return inner(sql, params);
    });
    (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValue('SMxx');

    await expect(sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' }))
      .resolves.toBeUndefined();

    expect((sendTwilioWhatsAppMessage as jest.Mock).mock.calls.map(([, row]) => row.id)).toEqual(['o3']);
    // o2 waits behind the held o1, so the conversation keeps its order.
    expect(calls.filter((c) => /SET status = 'send_unknown'/.test(c.sql)).map((c) => c.params[0])).toEqual(['o1', 'o3']);
    expect(calls.some((c) => /SET status = \$1/.test(c.sql))).toBe(false);
  });

  it('keeps a row claimed as send_unknown when the provider accepted it but the mark fails: never failed, never resendable', async () => {
    const { client, calls } = outboxClient([freeformRow('o1', CONV_A, 'm1', 'a1'), freeformRow('o2', CONV_B2, 'm2', 'b1')]);
    (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValue('SMxx');
    let failedOnce = false;
    const inner = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (!failedOnce && /SET status = 'sent'/.test(sql)) {
        failedOnce = true;
        calls.push({ sql, params });
        throw new Error('connection reset');
      }
      return inner(sql, params);
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    let logged: unknown[] = [];
    try {
      await expect(sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' }))
        .resolves.toBeUndefined();
      logged = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    } finally {
      logSpy.mockRestore();
    }
    // Counted by the send-failure alarm, as an ambiguous send, and told apart.
    expect(logged).toEqual([{ metric: 'JobMessageOutboxSendFailed', outboxId: 'o1', ambiguous: true, markFailed: true }]);
    expect(calls.some((c) => /^ROLLBACK/.test(c.sql))).toBe(true);
    // Claimed before the send; no failure is written for o1, and the
    // employer's message is not marked failed.
    expect(calls.filter((c) => /SET status = 'send_unknown'/.test(c.sql)).map((c) => c.params[0])).toEqual(['o1', 'o2']);
    expect(calls.some((c) => /UPDATE job_message_outbox/.test(c.sql) && /SET status = \$1/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /UPDATE job_conversation_messages/.test(c.sql) && /status = 'failed'/.test(c.sql))).toBe(false);
    // The provider's message id is kept on the claimed row, for reconciling.
    const keep = calls.find((c) => /SET twilio_message_sid = COALESCE\(\$2, twilio_message_sid\)/.test(c.sql));
    expect(keep!.sql).toMatch(/AND o\.status = 'send_unknown'/);
    expect(keep!.sql).toMatch(/AND jc\.worker_id = \$4/);
    expect(keep!.params).toEqual(['o1', 'SMxx', 'connection reset', WORKER]);
    // The other conversation still sends.
    expect(sendTwilioWhatsAppMessage).toHaveBeenCalledTimes(2);
  });

  it('a later flush never sends again a row whose accepted send could not be marked', async () => {
    // Statuses held across flushes, as the table holds them.
    const rows = new Map([['o1', { ...freeformRow('o1', CONV_A, 'm1', 'a1'), status: 'pending', attempt_count: 0 }]]);
    let failNextSentMark = true;
    let outboxReads = 0;
    const claimed: string[] = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM job_message_outbox o/.test(sql)) {
        outboxReads += 1;
        const due = [...rows.values()].filter((r) => ['pending', 'failed'].includes(r.status) && r.attempt_count < 5);
        return { rows: due, rowCount: due.length };
      }
      if (/SET status = 'send_unknown'/.test(sql)) {
        claimed.push(params[0] as string);
        const row = rows.get(params[0] as string);
        if (!row || !['pending', 'failed'].includes(row.status)) return { rows: [], rowCount: 0 };
        row.status = 'send_unknown';
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE job_message_outbox/.test(sql) && /SET status = 'sent'/.test(sql)) {
        if (failNextSentMark) {
          failNextSentMark = false;
          throw new Error('connection reset');
        }
        rows.get(params[0] as string)!.status = 'sent';
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE job_message_outbox/.test(sql) && /SET status = \$1/.test(sql)) {
        const row = rows.get(params[2] as string)!;
        row.status = params[0] as string;
        row.attempt_count += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValue('SMxx');
    const flush = () => sendPendingJobMessageOutbox({ query } as any, { actorUserId: WORKER, actorKind: 'worker' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // The first flush sends o1, then the mark fails: the expected failure.
      // The flush keeps o1 claimed, logs it as an ambiguous send, and resolves.
      await expect(flush()).resolves.toBeUndefined();
      expect(failNextSentMark).toBe(false);
      expect(logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { metric: 'JobMessageOutboxSendFailed', outboxId: 'o1', ambiguous: true, markFailed: true },
      ]);
      expect(outboxReads).toBe(1);
      expect(rows.get('o1')!.status).toBe('send_unknown');

      // The second flush reads the outbox, finds nothing it may send, and
      // resolves: it neither claims nor sends o1.
      await expect(flush()).resolves.toBeUndefined();
      expect(outboxReads).toBe(2);
    } finally {
      logSpy.mockRestore();
    }
    expect(claimed).toEqual(['o1']);
    expect(sendTwilioWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(rows.get('o1')!.status).toBe('send_unknown');
  });

  it('rethrows when ALL pending rows are in failed conversations (total outage)', async () => {
    const { client } = outboxClient([freeformRow('o1', CONV_A, 'm1', 'fail')]);
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('total outage'));
    await expect(sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' }))
      .rejects.toThrow('total outage');
  });

  it('parks an ambiguous (accepted-but-timed-out) send as send_unknown, not failed, and leaves the message row alone', async () => {
    const { client, calls } = outboxClient([
      freeformRow('o1', CONV_A, 'm1', 'a1'),
      freeformRow('o2', CONV_B2, 'm2', 'b1'),
    ]);
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new AmbiguousTwilioSendError('Twilio request timed out')) // o1 ambiguous
      .mockResolvedValue('SMxx');                          // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });

    const outboxUpdate = calls.find((c) =>
      /UPDATE job_message_outbox/.test(c.sql) && /SET status = \$1/.test(c.sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate!.params).toEqual(['send_unknown', 'Twilio request timed out', 'o1']);

    const messageUpdate = calls.find((c) =>
      /UPDATE job_conversation_messages/.test(c.sql) && /status = 'failed'/.test(c.sql));
    expect(messageUpdate).toBeUndefined();
  });

  it('marks a normal (non-ambiguous) send error as failed, including the message row', async () => {
    const { client, calls } = outboxClient([
      freeformRow('o1', CONV_A, 'm1', 'a1'),
      freeformRow('o2', CONV_B2, 'm2', 'b1'),
    ]);
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('Twilio 400 bad request'))  // o1 fails
      .mockResolvedValue('SMxx');                                 // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });

    const outboxUpdate = calls.find((c) =>
      /UPDATE job_message_outbox/.test(c.sql) && /SET status = \$1/.test(c.sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate!.params).toEqual(['failed', 'Twilio 400 bad request', 'o1']);

    const messageUpdate = calls.find((c) =>
      /UPDATE job_conversation_messages/.test(c.sql) && /status = 'failed'/.test(c.sql));
    expect(messageUpdate).toBeDefined();
    expect(messageUpdate!.params).toEqual(['m1']);
  });

  it('does NOT mark the conversation message sent when a TEMPLATE row sends successfully', async () => {
    // A template row is only the invite — the real text arrives later via
    // the worker-reply flush. Marking the employer message 'sent' here would
    // silently drop it forever, since the flush only rescues rows still in
    // 'waiting_worker_reply'.
    const { client, calls } = outboxClient([
      { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: null, content_template: 'invite_v1', content_variables: {}, send_kind: 'template' },
    ]);
    (sendTwilioWhatsAppMessage as jest.Mock).mockResolvedValueOnce('SMtemplate');

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });

    const outboxUpdate = calls.find((c) =>
      /UPDATE job_message_outbox/.test(c.sql) && /SET status = 'sent'/.test(c.sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate!.params).toEqual(['o1', 'SMtemplate']);

    const messageUpdate = calls.find((c) =>
      /UPDATE job_conversation_messages/.test(c.sql) && /status = 'sent'/.test(c.sql));
    expect(messageUpdate).toBeUndefined();
  });

  it('still marks the conversation message failed when a template row fails unambiguously', async () => {
    // Failure-marking is unchanged for both send kinds: a dead invite must
    // still surface as 'failed' on the employer's message.
    const { client, calls } = outboxClient([
      { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: null, content_template: 'invite_v1', content_variables: {}, send_kind: 'template' },
      freeformRow('o2', CONV_B2, 'm2', 'b1'),
    ]);
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new Error('Twilio 400 bad request'))  // o1 (template) fails
      .mockResolvedValue('SMxx');                                 // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });

    const messageUpdate = calls.find((c) =>
      /UPDATE job_conversation_messages/.test(c.sql) && /status = 'failed'/.test(c.sql));
    expect(messageUpdate).toBeDefined();
    expect(messageUpdate!.params).toEqual(['m1']);
  });

  it('emits JobMessageTemplateSidInvalid when the send throws TwilioTemplateInvalidError', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { client, calls } = outboxClient([
      { id: 'o1', conversation_id: CONV_A, message_id: 'm1', whatsapp_number: '+1', body: null, content_template: 'employer_message_invite_es', content_variables: {}, send_kind: 'template' },
      freeformRow('o2', CONV_B2, 'm2', 'b1'),
    ]);
    (sendTwilioWhatsAppMessage as jest.Mock)
      .mockRejectedValueOnce(new TwilioTemplateInvalidError('employer_message_invite_es', 21655))  // o1 fails
      .mockResolvedValue('SMxx');                                 // o2 succeeds (avoids total-outage rethrow)

    await sendPendingJobMessageOutbox(client, { actorUserId: WORKER, actorKind: 'worker' });

    const metricLog = logSpy.mock.calls.find(([line]) =>
      typeof line === 'string' && line.includes('JobMessageTemplateSidInvalid'));
    expect(metricLog).toBeDefined();
    expect(JSON.parse(metricLog![0] as string)).toEqual({
      metric: 'JobMessageTemplateSidInvalid',
      template: 'employer_message_invite_es',
      conversationId: CONV_A,
      outboxId: 'o1',
    });

    const outboxUpdate = calls.find((c) =>
      /UPDATE job_message_outbox/.test(c.sql) && /SET status = \$1/.test(c.sql));
    expect(outboxUpdate).toBeDefined();
    expect(outboxUpdate!.sql).toMatch(/attempt_count = attempt_count \+ 1/);
    expect(outboxUpdate!.params).toEqual([
      'failed',
      'Twilio template invalid (code 21655): employer_message_invite_es',
      'o1',
    ]);

    logSpy.mockRestore();
  });
});

import { createApplicantConversation } from '../../../../lambda/lib/job-messaging';

const EMPLOYER = 'cccccccc-0000-0000-0000-000000000001';

// Minimal row as returned by loadConversationForEmployer.
function conversationAccessRow(overrides: any = {}) {
  return {
    id: CONV_A, job_id: 'job-1', employer_id: EMPLOYER, worker_id: WORKER,
    application_id: 'app-a', status: 'open',
    worker_phone: '+15125551234',
    company_name: 'ACME', job_title: 'Plomero',
    last_worker_message_at: null,  // window CLOSED -> template branch
    ...overrides,
  };
}

interface EmployerScript {
  /** The loadConversationForEmployer row. */
  conversation?: Record<string, unknown>;
  /** employer_worker_delivery_context; lifecycle defaults to 'ready'. */
  lifecycle?: 'onboarding' | 'ready' | 'suspended' | null;
  workflowLanguage?: 'en' | 'es';
  whatsappLanguage?: string | null;
  /** employer_claim_worker_intent's decision. */
  claim?: { action: string; reason: string };
  /** The template dedupe check: an un-actioned invite or resume template exists. */
  pendingTemplate?: boolean;
  /** Message ids handed out in order by the message INSERT. */
  messageIds?: string[];
  /** createApplicantConversation: the applicant access row and any open conversation. */
  access?: Record<string, unknown> | null;
  openConversation?: Record<string, unknown> | null;
  crossSession?: boolean;
}

/**
 * A client that answers the employer send and create paths by statement,
 * never by call order, and records every call.
 */
function employerClient(script: EmployerScript = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const messageIds = [...(script.messageIds ?? ['msg-1'])];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const text = sql.replace(/\s+/g, ' ');
    if (/jale_cap\.employer_worker_delivery_context\(/.test(text)) {
      return {
        rows: [{
          lifecycle: script.lifecycle === undefined ? 'ready' : script.lifecycle,
          workflow_language: script.workflowLanguage ?? 'es',
          whatsapp_language: script.whatsappLanguage === undefined ? 'es' : script.whatsappLanguage,
        }],
        rowCount: 1,
      };
    }
    if (/jale_cap\.employer_claim_worker_intent\(/.test(text)) {
      const decision = script.claim ?? { action: 'defer', reason: 'worker_onboarding' };
      return {
        rows: [{
          intent_id: 'intent-1', decision_action: decision.action, decision_reason: decision.reason,
          outbox_id: null, outbox_materialized: false,
        }],
        rowCount: 1,
      };
    }
    if (/FROM jobs j JOIN job_applications ja/.test(text)) {
      const access = script.access === undefined
        ? {
          job_id: 'job-1', employer_id: EMPLOYER, worker_id: WORKER, application_id: 'app-a',
          worker_phone: '+15125551234', company_name: 'ACME', job_title: 'Plomero',
        }
        : script.access;
      return { rows: access ? [access] : [], rowCount: access ? 1 : 0 };
    }
    if (/FROM job_conversations jc WHERE jc\.job_id = \$1/.test(text) && /jc\.status = 'open'/.test(text)) {
      const open = script.openConversation ?? null;
      return { rows: open ? [open] : [], rowCount: open ? 1 : 0 };
    }
    if (/FROM job_conversations jc JOIN jobs j/.test(text) && /jc\.id = \$1/.test(text)) {
      return { rows: [script.conversation ?? conversationAccessRow()], rowCount: 1 };
    }
    if (/assign_worker_thread_number/.test(text)) return { rows: [{ n: 3 }], rowCount: 1 };
    if (/INSERT INTO job_conversations/.test(text)) return { rows: [{ id: CONV_A }], rowCount: 1 };
    if (/SELECT EXISTS/.test(text) && /last_worker_message_at > now\(\) - interval/.test(text)) {
      return { rows: [{ active: script.crossSession ?? false }], rowCount: 1 };
    }
    if (/INSERT INTO job_conversation_messages/.test(text)) {
      return { rows: [{ id: messageIds.length > 1 ? messageIds.shift() : messageIds[0] }], rowCount: 1 };
    }
    if (/SELECT EXISTS/.test(text) && /send_kind = 'template'/.test(text)) {
      return { rows: [{ exists: script.pendingTemplate ?? false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { client: { query } as any, calls };
}

const WORKER_LANE_SQL = /whatsapp_conversations|worker_onboarding_state|worker_workflow_runs|worker_message_intents|whatsapp_runtime_controls|whatsapp_outbox/;

function indexOf(calls: Array<{ sql: string }>, pattern: RegExp): number {
  return calls.findIndex((c) => pattern.test(c.sql));
}

function outboxInserts(calls: Array<{ sql: string; params: unknown[] }>) {
  return calls.filter((c) => /INSERT INTO job_message_outbox/.test(c.sql));
}

describe('queueConversationMessageFromEmployer: gate and languages through the delivery context', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads the gate through jale_cap.employer_worker_delivery_context, with no worker-lane SQL and no caller switch', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'ready' });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');

    const context = calls.find((call) => /jale_cap\.employer_worker_delivery_context\(\$1\)/.test(call.sql));
    expect(context).toBeDefined();
    expect(context!.params).toEqual([WORKER]);
    expect(calls.filter((call) => WORKER_LANE_SQL.test(call.sql))).toEqual([]);
    expect(calls.some((call) => /set_config/.test(call.sql))).toBe(false);
    // The gate is read before the message is stamped.
    expect(indexOf(calls, /employer_worker_delivery_context/)).toBeLessThan(indexOf(calls, /INSERT INTO job_conversation_messages/));
  });

  it('leaves sender_user_id to the database', async () => {
    // Migration 118's trigger job_messages_stamp_sender stamps sender_user_id
    // from app.current_internal_user_id; the INSERT must not name it.
    const { client: c, calls } = employerClient({ lifecycle: 'ready' });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    const insert = calls.find((call) => /INSERT INTO job_conversation_messages/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/\(conversation_id, sender_type, direction, body, status\)/);
    expect(insert!.sql).not.toMatch(/sender_user_id/);
    expect(insert!.params).toHaveLength(3);
  });

  it('an English worker outside the reply window gets the English resume template and fallback copy', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'ready', whatsappLanguage: 'en' });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hello');
    const [template] = outboxInserts(calls);
    expect(template.params).toContain('employer_message_resume_en');
    expect(JSON.parse(template.params[4] as string).__fallback_body).toBe(
      'ACME sent you a message about Plomero. Reply here to open the conversation.',
    );
  });

  it('a Spanish worker gets the Spanish resume template', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'ready', whatsappLanguage: 'es' });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    expect(outboxInserts(calls)[0].params).toContain('employer_message_resume_es');
  });

  it('a worker with no WhatsApp conversation language keeps the Spanish template, as before', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'ready', whatsappLanguage: null, workflowLanguage: 'en' });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    expect(outboxInserts(calls)[0].params).toContain('employer_message_resume_es');
  });
});

describe('queueConversationMessageFromEmployer template dedupe (R7)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not queue a second invite template while one is un-actioned', async () => {
    const { client: c, calls } = employerClient({ pendingTemplate: true });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'second overnight msg');
    expect(outboxInserts(calls).some((call) => /'template'/.test(call.sql))).toBe(false);
  });

  it('queues a template when none is pending yet', async () => {
    const { client: c, calls } = employerClient({ pendingTemplate: false });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'first overnight msg');
    expect(outboxInserts(calls).some((call) => /'template'/.test(call.sql))).toBe(true);
  });

  // F19 (sprint 28): a hired worker can now write from the web. That message
  // is an inbound row, but it opens no WhatsApp window, so it never moves
  // last_worker_message_at. The dedupe must still count it as the worker's
  // latest action, or an employer reply after it is never announced.
  it('counts the newest inbound message, web ones included, as the worker\'s last action', async () => {
    const { client: c, calls } = employerClient({ pendingTemplate: false });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'reply after a web message');
    const dedupeSql = calls.map((call) => call.sql).find((sql) => /send_kind = 'template'/.test(sql) && /SELECT EXISTS/.test(sql))!;
    const flat = dedupeSql.replace(/\s+/g, ' ');
    expect(flat).toContain('GREATEST(jc.accepted_at, jc.last_worker_message_at, '
      + "(SELECT max(m.created_at) FROM job_conversation_messages m WHERE m.conversation_id = jc.id AND m.direction = 'inbound'))");
  });

  it('ignores permanently-failed templates in the dedupe check (dead invites must not suppress new ones)', async () => {
    const { client: c, calls } = employerClient({ pendingTemplate: false });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'msg after dead template');
    const dedupeSql = calls.map((call) => call.sql).find((sql) => /send_kind = 'template'/.test(sql) && /SELECT EXISTS/.test(sql));
    expect(dedupeSql).toBeDefined();
    // A template that exhausted its send attempts was never delivered — it is
    // not an "un-actioned invite" and must not suppress queueing a new one.
    expect(dedupeSql!).toMatch(/NOT \(status = 'failed' AND attempt_count >= 5\)/);
  });
});

describe('createApplicantConversation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('assigns worker_thread_number via assign_worker_thread_number on create', async () => {
    const { client: c, calls } = employerClient();
    await createApplicantConversation(c, EMPLOYER, 'job-1', WORKER, 'hola, te escribo sobre el trabajo');

    // Assertion (a): counter function was called with workerId
    const counter = calls.find((call) => /assign_worker_thread_number\s*\(\s*\$1\s*\)/.test(call.sql));
    expect(counter).toBeDefined();
    expect(counter!.params).toEqual([WORKER]);

    // Assertion (b): INSERT includes worker_thread_number column
    const insert = calls.find((call) => /INSERT INTO job_conversations/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/worker_thread_number/);
    expect(insert!.params).toEqual(['job-1', EMPLOYER, WORKER, 'app-a', 3]);
  });

  it('queues the invite template in the WhatsApp language from the delivery context, with no worker-lane SQL', async () => {
    const { client: c, calls } = employerClient({ whatsappLanguage: 'en' });
    const created = await createApplicantConversation(c, EMPLOYER, 'job-1', WORKER, 'hello about the job');
    expect(created).toEqual({ conversationId: CONV_A });
    const [template] = outboxInserts(calls);
    expect(template.params).toContain('employer_message_invite_en');
    expect(calls.filter((call) => WORKER_LANE_SQL.test(call.sql))).toEqual([]);
  });

  it('reuses an open conversation for the same applicant', async () => {
    const { client: c, calls } = employerClient({ openConversation: { id: CONV_B } });
    const created = await createApplicantConversation(c, EMPLOYER, 'job-1', WORKER, 'hola');
    expect(created).toEqual({ conversationId: CONV_B });
    expect(calls.some((call) => /INSERT INTO job_conversations/.test(call.sql))).toBe(false);
  });

  it('refuses a worker who is not an applicant, and one with no number', async () => {
    await expect(createApplicantConversation(employerClient({ access: null }).client, EMPLOYER, 'job-1', WORKER, 'hola'))
      .rejects.toThrow('applicant_not_found');
    const noPhone = employerClient({
      access: {
        job_id: 'job-1', employer_id: EMPLOYER, worker_id: WORKER, application_id: 'app-a',
        worker_phone: null, company_name: 'ACME', job_title: 'Plomero',
      },
    });
    await expect(createApplicantConversation(noPhone.client, EMPLOYER, 'job-1', WORKER, 'hola'))
      .rejects.toThrow('worker_whatsapp_unavailable');
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

describe('queueConversationMessageFromEmployer: a worker who is not ready gets the intent claim', () => {
  beforeEach(() => jest.clearAllMocks());

  // 2026-07-27 parity-audit fix: the intent path is for ONBOARDING workers
  // only. Routing READY workers through it destroyed the employer's text
  // (row stamped 'queued', no outbox row ever, flush only rescues
  // 'waiting_worker_reply').

  it('a READY worker takes the v1 freeform path with the text intact — never the intent', async () => {
    const { client: c, calls } = employerClient({
      lifecycle: 'ready',
      conversation: conversationAccessRow({ last_worker_message_at: new Date(), worker_thread_number: 1 }),
    });

    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'te espero manana a las 8');

    expect(calls.some((call) => /employer_claim_worker_intent/.test(call.sql))).toBe(false);
    const freeform = outboxInserts(calls).find((call) =>
      call.params.some((param) => typeof param === 'string' && (param as string).includes('te espero manana a las 8')));
    expect(freeform).toBeDefined();
    // Freeform-eligible message keeps the v1 'queued' stamp.
    const msgInsert = calls.find((call) => /INSERT INTO job_conversation_messages/.test(call.sql));
    expect(msgInsert!.params[2]).toBe('queued');
  });

  it('an ONBOARDING worker is claimed through jale_cap.employer_claim_worker_intent: the message is the source, with copy pre-rendered in the workflow language', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'onboarding', workflowLanguage: 'en' });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');

    const claims = calls.filter((call) => /jale_cap\.employer_claim_worker_intent\(\$1, \$2, \$3, \$4::jsonb, \$5::jsonb\)/.test(call.sql));
    expect(claims).toHaveLength(1);
    const [workerId, kind, sourceId, payload, message] = claims[0].params;
    expect([workerId, kind, sourceId]).toEqual([WORKER, 'employer_chat', 'msg-1']);
    expect(JSON.parse(payload as string)).toEqual({ conversationId: CONV_A, companyName: 'ACME', jobTitle: 'Plomero' });
    expect(JSON.parse(message as string)).toEqual({
      body: 'ACME wants to chat with you about the Plomero job. Reply CHATS to open the chat.',
    });

    // The stored row is the ONLY carrier of the text on this path: it must
    // be flush-recoverable, never 'queued' -- even inside the reply window.
    const msgInsert = calls.find((call) => /INSERT INTO job_conversation_messages/.test(call.sql));
    expect(msgInsert!.params[2]).toBe('waiting_worker_reply');
    expect(outboxInserts(calls)).toEqual([]);
    // The claim comes after the message it names, and before the conversation bookkeeping.
    expect(indexOf(calls, /employer_claim_worker_intent/)).toBeGreaterThan(indexOf(calls, /INSERT INTO job_conversation_messages/));
    expect(indexOf(calls, /UPDATE job_conversations/)).toBeGreaterThan(indexOf(calls, /employer_claim_worker_intent/));
    expect(calls.filter((call) => WORKER_LANE_SQL.test(call.sql))).toEqual([]);
    expect(calls.some((call) => /set_config/.test(call.sql))).toBe(false);
  });

  it('a Spanish onboarding worker gets the Spanish copy', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'onboarding', workflowLanguage: 'es' });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    const claim = calls.find((call) => /employer_claim_worker_intent/.test(call.sql))!;
    expect(JSON.parse(claim.params[4] as string).body).toBe(
      'ACME quiere hablar contigo sobre el trabajo de Plomero. Responde MENSAJES para abrir el chat.',
    );
  });

  it('a worker with no onboarding row yet is treated as onboarding, even inside the reply window', async () => {
    const { client: c, calls } = employerClient({
      lifecycle: null,
      conversation: conversationAccessRow({ last_worker_message_at: new Date() }),
    });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    expect(calls.some((call) => /employer_claim_worker_intent/.test(call.sql))).toBe(true);
    const msgInsert = calls.find((call) => /INSERT INTO job_conversation_messages/.test(call.sql));
    expect(msgInsert!.params[2]).toBe('waiting_worker_reply');
  });

  it('a worker whose phone fails to normalize takes the same path: deferred claim, no outbox row', async () => {
    const { client: c, calls } = employerClient({
      lifecycle: 'onboarding',
      conversation: conversationAccessRow({ worker_phone: null, last_worker_message_at: new Date() }),
    });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    expect(outboxInserts(calls)).toEqual([]);
    expect(calls.some((call) => /employer_claim_worker_intent/.test(call.sql))).toBe(true);
  });

  it('a suspended worker is a normal answer (reject/worker_suspended), as before', async () => {
    const { client: c } = employerClient({ lifecycle: 'suspended', claim: { action: 'reject', reason: 'worker_suspended' } });
    await expect(queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola')).resolves.toEqual({
      messageId: 'msg-1', queuedAsTemplate: true,
    });
  });

  it('an allowed claim with nothing to send throws, so the send rolls back as before', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'onboarding', claim: { action: 'reject', reason: 'renderer_unavailable' } });
    await expect(queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola')).rejects.toThrow('renderer_unavailable:employer_chat');
    expect(calls.some((call) => /UPDATE job_conversations/.test(call.sql))).toBe(false);
  });

  it('each employer message gets its own claim, named by that message', async () => {
    const { client: c, calls } = employerClient({ lifecycle: 'onboarding', messageIds: ['msg-1', 'msg-2'] });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola de nuevo');
    const sources = calls.filter((call) => /employer_claim_worker_intent/.test(call.sql)).map((call) => call.params[2]);
    expect(sources).toEqual(['msg-1', 'msg-2']);
  });
});

describe('context header on employer freeform messages', () => {
  beforeEach(() => jest.clearAllMocks());

  it('freeform employer message includes 🏢 context header', async () => {
    // last_worker_message_at: new Date() makes it a freeform (window open)
    const { client: c, calls } = employerClient({
      conversation: conversationAccessRow({ worker_thread_number: 2, last_worker_message_at: new Date() }),
    });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'Hola, ¿puedes?');
    const [outboxInsert] = outboxInserts(calls);
    // The body argument (one of the $N params) should start with 🏢
    const bodyParam = outboxInsert.params.find((p) => typeof p === 'string' && (p as string).startsWith('🏢')) as string;
    expect(bodyParam).toBeDefined();
    expect(bodyParam).toMatch(/^🏢 ACME — Plomero \(#2\)\n/);
    expect(bodyParam).toContain('Hola, ¿puedes?');
  });

  it('template path does NOT get a header', async () => {
    // last_worker_message_at: null → window closed → template branch
    const { client: c, calls } = employerClient({
      conversation: conversationAccessRow({ worker_thread_number: 1, last_worker_message_at: null }),
    });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'Hola');
    const inserts = outboxInserts(calls);
    expect(inserts.length).toBeGreaterThan(0);
    inserts.forEach((call) => {
      expect(call.params.some((p) => typeof p === 'string' && (p as string).includes('🏢'))).toBe(false);
    });
  });
});

describe('template outbox visibility (spec 2026-08-13)', () => {
  it('queueWorkerInviteTemplate carries the message_id so failures mark the employer message', async () => {
    // Down the template path: ready worker, reply window closed, no pending invite.
    const { client: c, calls } = employerClient({ messageIds: ['msg-77'] });
    await queueConversationMessageFromEmployer(c, CONV_A, EMPLOYER, 'hola');
    const [outboxInsert] = outboxInserts(calls);
    expect(outboxInsert).toBeDefined();
    expect(outboxInsert.sql).toContain('message_id');
    expect(outboxInsert.params).toContain('msg-77');
  });
});

describe('employer conversation list/detail — job city and state', () => {
  beforeEach(() => jest.clearAllMocks());

  it('selects the job city and state for the employer list and detail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await listEmployerConversations(client, EMPLOYER);
    expect(mockQuery.mock.calls[0][0]).toMatch(/j\.city AS job_city/);

    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await getEmployerConversationDetail(client, 'conv-1', EMPLOYER);
    expect(mockQuery.mock.calls[1][0]).toMatch(/j\.city AS job_city/);
  });
});
