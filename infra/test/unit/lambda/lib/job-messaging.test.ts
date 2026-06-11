const mockQuery = jest.fn();
const client: any = { query: mockQuery };
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  sendTwilioWhatsAppMessage: jest.fn(),
  queueOutboxText: jest.fn(),
}));
import { recordWorkerConversationReply } from '../../../../lambda/lib/job-messaging';

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

  it('routes to the single open accepted thread when focus is stale', async () => {
    mockQuery
      .mockResolvedValueOnce(openThreadsResult([]))                          // stale focused id -> none
      .mockResolvedValueOnce(openThreadsResult([
        { id: CONV_A, application_id: 'app-a', job_title: 'Plomero', company: 'ACME', worker_thread_number: 1 },
      ]))
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await recordWorkerConversationReply(
      client, WORKER, 'hola', 'whatsapp:+1512', 'SM2', 'stale-conversation-id',
    );
    expect(result.status).toBe('routed');
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
