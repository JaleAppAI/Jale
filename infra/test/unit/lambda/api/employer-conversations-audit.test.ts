/**
 * Access records for the employer's conversation and overview reads: each
 * read is recorded in its own
 * transaction before COMMIT, names exactly the workers and threads returned,
 * and a failed record answers 500 with none of the data. Not-found and
 * failures are recorded as attempts after the transaction ends.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as overviewHandler } from '../../../../lambda/api/employer-applicants-overview';
import { handler as listHandler } from '../../../../lambda/api/employer-conversations-list';
import { handler as detailHandler } from '../../../../lambda/api/employer-conversations-detail';
import { handler as createHandler } from '../../../../lambda/api/employer-conversations-create';
import { handler as sendHandler } from '../../../../lambda/api/employer-conversations-send';
import { handler as updateHandler } from '../../../../lambda/api/employer-conversations-update';
import { getDbPool } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { listEmployerApplicantsOverview } from '../../../../lambda/lib/employer-applicants-overview';
import {
  closeEmployerConversation,
  createApplicantConversation,
  getEmployerConversationDetail,
  listEmployerConversations,
  queueConversationMessageFromEmployer,
  sendPendingJobMessageOutbox,
} from '../../../../lambda/lib/job-messaging';
import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import {
  callerFor, expectAttemptAfter, expectRecordedInsideTransaction, queryOrder, withRequestId,
} from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/employer-applicants-overview');
jest.mock('../../../../lambda/lib/job-messaging', () => ({
  ...jest.requireActual('../../../../lambda/lib/job-messaging'),
  listEmployerConversations: jest.fn(),
  getEmployerConversationDetail: jest.fn(),
  createApplicantConversation: jest.fn(),
  queueConversationMessageFromEmployer: jest.fn(),
  closeEmployerConversation: jest.fn(),
  sendPendingJobMessageOutbox: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');

import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const ORG_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const FOREMAN_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const actorResult = (userId: string, scopeUserIds: string[] = [userId]) => ({
  ok: true as const,
  actor: { userId, organizationId: ORG_ID, role: 'owner' as const, scopeUserIds },
});

const mockQuery = jest.fn();
const mockRecordAccess = recordAccess as jest.Mock;
const mockRecordAttempt = recordAttempt as jest.Mock;
const EMPLOYER_ID = '55555555-5555-4555-8555-555555555555';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKER_ID = '66666666-6666-4666-8666-666666666666';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const employer = callerFor('employer', EMPLOYER_ID);
const client = expect.objectContaining({ query: mockQuery });

function event(extra: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return withRequestId({
    requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
    ...extra,
  } as unknown as APIGatewayProxyEvent);
}

const detail = {
  conversation: {
    id: CONVERSATION_ID, job_id: JOB_ID, application_id: 'app-1', job_title: 'Fixture', worker_id: WORKER_ID,
    worker_name: 'Fixture Name', status: 'open', last_message_preview: 'fixture text',
  },
  messages: [
    { id: 'm1', sender_type: 'employer', direction: 'outbound', body: 'fixture text', status: 'sent', created_at: 't1', sent_at: 't1' },
    { id: 'm2', sender_type: 'worker', direction: 'inbound', body: 'fixture text', status: 'received', created_at: 't2', sent_at: null },
  ],
};
const detailFields = [...new Set([...Object.keys(detail.conversation), ...Object.keys(detail.messages[0])])].sort();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.REQUIRED_TOS_VERSION = 'v1.0';
  (getDbPool as jest.Mock).mockResolvedValue({
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
  });
  (checkCompliance as jest.Mock).mockResolvedValue({ compliant: true, userExists: true });
  mockQuery.mockImplementation(async (sql: string) =>
    (/FROM users WHERE cognito_sub/i.test(String(sql)) ? { rows: [{ id: EMPLOYER_ID }] } : { rows: [] }));
  mockRecordAccess.mockResolvedValue(undefined);
  mockRecordAttempt.mockResolvedValue(undefined);
  (sendPendingJobMessageOutbox as jest.Mock).mockResolvedValue(undefined);
  mockResolveEmployerActor.mockResolvedValue(actorResult(EMPLOYER_ID));
});

describe('employer.applicants_overview', () => {
  const overview = {
    applicants: [
      { application_id: 'app-1', worker_id: WORKER_ID, worker_name: 'Fixture Name', job_id: JOB_ID, trust_score: 50 },
      { application_id: 'app-2', worker_id: WORKER_ID, worker_name: 'Fixture Name', job_id: 'job-2', trust_score: 50 },
    ],
    jobs: [{ job_id: JOB_ID, title: 'Fixture' }],
    total: 2,
  };

  it('records every applicant listed, before COMMIT', async () => {
    (listEmployerApplicantsOverview as jest.Mock).mockResolvedValue(overview);
    const res = await overviewHandler(event());
    expect(res.statusCode).toBe(200);
    expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
      surface: 'employer.applicants_overview',
      subjectUserIds: [WORKER_ID, WORKER_ID],
      recordIds: ['app-1', 'app-2'],
      resultCount: 2,
      fieldNames: Object.keys(overview.applicants[0]).sort(),
    });
    expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
  });

  it('answers 500 with no applicants when the record cannot be written', async () => {
    (listEmployerApplicantsOverview as jest.Mock).mockResolvedValue(overview);
    mockRecordAccess.mockRejectedValue(new Error('audit'));
    const res = await overviewHandler(event());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
    expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, { surface: 'employer.applicants_overview', outcome: 'failed' });
  });

  it('answers the actor failure after COMMIT and reads nothing', async () => {
    mockResolveEmployerActor.mockResolvedValueOnce({ ok: false, status: 403, error: 'membership_inactive' });
    const res = await overviewHandler(event());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery.mock.calls.map(([q]) => q)).toEqual(['BEGIN', 'COMMIT']);
    expect(listEmployerApplicantsOverview).not.toHaveBeenCalled();
    expect(mockRecordAttempt).not.toHaveBeenCalled();
  });

  it("lists the owner's whole scope and records the owner as the caller", async () => {
    mockResolveEmployerActor.mockResolvedValueOnce(actorResult(OWNER_ID, [OWNER_ID, FOREMAN_ID]));
    (listEmployerApplicantsOverview as jest.Mock).mockResolvedValue(overview);
    expect((await overviewHandler(event())).statusCode).toBe(200);
    expect(listEmployerApplicantsOverview).toHaveBeenCalledWith(client, [OWNER_ID, FOREMAN_ID]);
    expect(mockRecordAccess.mock.calls[0][1]).toEqual(callerFor('employer', OWNER_ID));
  });
});

describe('employer.conversations_list', () => {
  const conversations = [
    { id: CONVERSATION_ID, job_id: JOB_ID, worker_id: WORKER_ID, worker_name: 'Fixture Name', last_message_preview: 'fixture text' },
    { id: 'conv-2', job_id: JOB_ID, worker_id: OTHER_WORKER_ID, worker_name: 'Fixture Name', last_message_preview: null },
  ];

  it('records every thread listed, before COMMIT', async () => {
    (listEmployerConversations as jest.Mock).mockResolvedValue(conversations);
    const res = await listHandler(event());
    expect(res.statusCode).toBe(200);
    expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
      surface: 'employer.conversations_list',
      subjectUserIds: [WORKER_ID, OTHER_WORKER_ID],
      recordIds: [CONVERSATION_ID, 'conv-2'],
      resultCount: 2,
      fieldNames: Object.keys(conversations[0]).sort(),
    });
    expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
  });

  it('answers 500 with no threads when the record cannot be written', async () => {
    (listEmployerConversations as jest.Mock).mockResolvedValue(conversations);
    mockRecordAccess.mockRejectedValue(new Error('audit'));
    const res = await listHandler(event());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
  });
});

describe('employer.conversation_detail', () => {
  const detailEvent = () => event({ pathParameters: { conversationId: CONVERSATION_ID } } as never);

  it('records the thread and its message count before COMMIT', async () => {
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    const res = await detailHandler(detailEvent());
    expect(res.statusCode).toBe(200);
    expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
      surface: 'employer.conversation_detail',
      subjectUserIds: [WORKER_ID],
      recordIds: [CONVERSATION_ID],
      resultCount: 2,
      fieldNames: detailFields,
      purpose: { kind: 'job', id: JOB_ID },
    });
    expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
  });

  it('records a not_found attempt after the transaction for an unknown thread', async () => {
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(null);
    const res = await detailHandler(detailEvent());
    expect(res.statusCode).toBe(404);
    expect(mockRecordAccess).not.toHaveBeenCalled();
    expectAttemptAfter(mockQuery, mockRecordAttempt, 'COMMIT');
    expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, {
      surface: 'employer.conversation_detail', outcome: 'not_found', recordIds: [CONVERSATION_ID],
    });
  });

  it('answers 500 with no thread when the record cannot be written', async () => {
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    mockRecordAccess.mockRejectedValue(new Error('audit'));
    const res = await detailHandler(detailEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockQuery.mock.calls.some(([q]) => q === 'COMMIT')).toBe(false);
    expect(mockRecordAttempt.mock.calls[0][2]).toEqual({
      surface: 'employer.conversation_detail', outcome: 'failed', recordIds: [CONVERSATION_ID],
    });
  });
});

describe('employer.conversation_create / _send / _update', () => {
  it('create: records the thread it returns before COMMIT, and sends after', async () => {
    (createApplicantConversation as jest.Mock).mockResolvedValue({ conversationId: CONVERSATION_ID });
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    const res = await createHandler(event({
      body: JSON.stringify({ job_id: JOB_ID, worker_id: WORKER_ID, initial_message: 'fixture text' }),
    }));
    expect(res.statusCode).toBe(201);
    expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
      surface: 'employer.conversation_create',
      subjectUserIds: [WORKER_ID],
      recordIds: [CONVERSATION_ID],
      resultCount: 2,
      fieldNames: detailFields,
      purpose: { kind: 'job', id: JOB_ID },
    });
    expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
    expect((sendPendingJobMessageOutbox as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(queryOrder(mockQuery, 'COMMIT'));
  });

  it('create: records a not_found attempt after the ROLLBACK for a worker who is not an applicant', async () => {
    (createApplicantConversation as jest.Mock).mockRejectedValue(new Error('applicant_not_found'));
    const res = await createHandler(event({
      body: JSON.stringify({ job_id: JOB_ID, worker_id: WORKER_ID, initial_message: 'fixture text' }),
    }));
    expect(res.statusCode).toBe(404);
    expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
    expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, {
      surface: 'employer.conversation_create', outcome: 'not_found', subjectUserIds: [WORKER_ID], purpose: { kind: 'job', id: JOB_ID },
    });
  });

  it('create: records nothing for a worker without WhatsApp (409)', async () => {
    (createApplicantConversation as jest.Mock).mockRejectedValue(new Error('worker_whatsapp_unavailable'));
    const res = await createHandler(event({
      body: JSON.stringify({ job_id: JOB_ID, worker_id: WORKER_ID, initial_message: 'fixture text' }),
    }));
    expect(res.statusCode).toBe(409);
    expect(mockRecordAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['the conversations foreign key (23503)', { code: '23503', constraint: 'job_conversations_job_employer_fkey' }],
    ['the application guard (23514)', {
      code: '23514',
      message: 'job_conversations: a conversation must name its application\'s worker and job, and that job\'s employer',
    }],
  ])('create: a job moved to another member meanwhile, refused by %s: 409 job_move_conflict, ROLLBACK, nothing recorded or sent', async (_label, fields) => {
    (createApplicantConversation as jest.Mock).mockRejectedValue(
      Object.assign(new Error(String((fields as { message?: string }).message ?? 'violates foreign key constraint')), fields),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await createHandler(event({
      body: JSON.stringify({ job_id: JOB_ID, worker_id: WORKER_ID, initial_message: 'fixture text' }),
    }));
    const warned = warn.mock.calls;
    warn.mockRestore();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_move_conflict' });
    // Logged with the refusal, so a genuine employer mismatch (no race) is visible.
    const f = fields as { code: string; constraint?: string };
    expect(warned).toEqual([['employer-conversations-create job_move_conflict:', f.code, f.constraint]]);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockRecordAttempt).not.toHaveBeenCalled();
    expect(sendPendingJobMessageOutbox).not.toHaveBeenCalled();
  });

  it('create: another foreign key violation is still a 500', async () => {
    (createApplicantConversation as jest.Mock).mockRejectedValue(
      Object.assign(new Error('violates foreign key constraint'), { code: '23503', constraint: 'job_conversations_worker_id_fkey' }),
    );
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await createHandler(event({
      body: JSON.stringify({ job_id: JOB_ID, worker_id: WORKER_ID, initial_message: 'fixture text' }),
    }));
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
  });

  it('send: records the thread it returns before COMMIT', async () => {
    (queueConversationMessageFromEmployer as jest.Mock).mockResolvedValue(undefined);
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    const res = await sendHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ body: 'fixture text' }) } as never));
    expect(res.statusCode).toBe(200);
    expect(mockRecordAccess.mock.calls[0][2]).toEqual({
      surface: 'employer.conversation_send',
      subjectUserIds: [WORKER_ID],
      recordIds: [CONVERSATION_ID],
      resultCount: 2,
      fieldNames: detailFields,
      purpose: { kind: 'job', id: JOB_ID },
    });
    expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
  });

  it('send: records a not_found attempt after the ROLLBACK for an unknown thread', async () => {
    (queueConversationMessageFromEmployer as jest.Mock).mockRejectedValue(new Error('conversation_not_found'));
    const res = await sendHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ body: 'fixture text' }) } as never));
    expect(res.statusCode).toBe(404);
    expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
    expect(mockRecordAttempt.mock.calls[0][2]).toEqual({
      surface: 'employer.conversation_send', outcome: 'not_found', recordIds: [CONVERSATION_ID],
    });
  });

  it('update: records the thread it returns before COMMIT', async () => {
    (closeEmployerConversation as jest.Mock).mockResolvedValue(true);
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    const res = await updateHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ status: 'closed' }) } as never));
    expect(res.statusCode).toBe(200);
    expect(mockRecordAccess.mock.calls[0][2]).toMatchObject({ surface: 'employer.conversation_update', recordIds: [CONVERSATION_ID] });
    expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
  });

  it('update: records a not_found attempt, and no read, when nothing was closed', async () => {
    (closeEmployerConversation as jest.Mock).mockResolvedValue(false);
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    const res = await updateHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ status: 'closed' }) } as never));
    expect(res.statusCode).toBe(404);
    expect(mockRecordAccess).not.toHaveBeenCalled();
    expectAttemptAfter(mockQuery, mockRecordAttempt, 'COMMIT');
  });
});

describe('conversations act for the caller scope (employer organizations)', () => {
  const OWNER_SCOPE = [OWNER_ID, FOREMAN_ID];
  const owner = callerFor('employer', OWNER_ID);
  const ownerActor = actorResult(OWNER_ID, OWNER_SCOPE).actor;

  it.each([
    ['list', () => listHandler(event())],
    ['detail', () => detailHandler(event({ pathParameters: { conversationId: CONVERSATION_ID } } as never))],
    ['create', () => createHandler(event({ body: JSON.stringify({ job_id: JOB_ID, worker_id: WORKER_ID, initial_message: 'fixture text' }) }))],
    ['send', () => sendHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ body: 'fixture text' }) } as never))],
    ['update', () => updateHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ status: 'closed' }) } as never))],
  ])('%s: answers the actor failure after COMMIT and touches no conversation', async (_name, run) => {
    mockResolveEmployerActor.mockResolvedValueOnce({ ok: false, status: 403, error: 'membership_inactive' });
    const res = await run();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery.mock.calls.map(([q]) => q)).toEqual(['BEGIN', 'COMMIT']);
    for (const fn of [listEmployerConversations, getEmployerConversationDetail, createApplicantConversation,
      queueConversationMessageFromEmployer, closeEmployerConversation, sendPendingJobMessageOutbox]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(mockRecordAttempt).not.toHaveBeenCalled();
  });

  it('list: reads the whole scope and records the owner', async () => {
    mockResolveEmployerActor.mockResolvedValueOnce(actorResult(OWNER_ID, OWNER_SCOPE));
    (listEmployerConversations as jest.Mock).mockResolvedValue([]);
    expect((await listHandler(event())).statusCode).toBe(200);
    expect(listEmployerConversations).toHaveBeenCalledWith(client, OWNER_SCOPE);
    expect(mockRecordAccess.mock.calls[0][1]).toEqual(owner);
  });

  it('detail: reads the thread by the whole scope', async () => {
    mockResolveEmployerActor.mockResolvedValueOnce(actorResult(OWNER_ID, OWNER_SCOPE));
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    expect((await detailHandler(event({ pathParameters: { conversationId: CONVERSATION_ID } } as never))).statusCode).toBe(200);
    expect(getEmployerConversationDetail).toHaveBeenCalledWith(client, CONVERSATION_ID, OWNER_SCOPE);
    expect(mockRecordAccess.mock.calls[0][1]).toEqual(owner);
  });

  it('update: closes and reads the thread by the whole scope', async () => {
    mockResolveEmployerActor.mockResolvedValueOnce(actorResult(OWNER_ID, OWNER_SCOPE));
    (closeEmployerConversation as jest.Mock).mockResolvedValue(true);
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    expect((await updateHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ status: 'closed' }) } as never))).statusCode).toBe(200);
    expect(closeEmployerConversation).toHaveBeenCalledWith(client, CONVERSATION_ID, OWNER_SCOPE);
    expect(getEmployerConversationDetail).toHaveBeenCalledWith(client, CONVERSATION_ID, OWNER_SCOPE);
  });

  it('send: queues as the actor and flushes as the owner over the whole scope', async () => {
    mockResolveEmployerActor.mockResolvedValueOnce(actorResult(OWNER_ID, OWNER_SCOPE));
    (queueConversationMessageFromEmployer as jest.Mock).mockResolvedValue(undefined);
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    expect((await sendHandler(event({ pathParameters: { conversationId: CONVERSATION_ID }, body: JSON.stringify({ body: 'fixture text' }) } as never))).statusCode).toBe(200);
    expect(queueConversationMessageFromEmployer).toHaveBeenCalledWith(client, CONVERSATION_ID, ownerActor, 'fixture text');
    expect(getEmployerConversationDetail).toHaveBeenCalledWith(client, CONVERSATION_ID, OWNER_SCOPE);
    expect(sendPendingJobMessageOutbox).toHaveBeenCalledWith(client, {
      conversationId: CONVERSATION_ID, actorUserId: OWNER_ID, actorKind: 'employer', scopeUserIds: OWNER_SCOPE,
    });
  });

  it('create: creates as the actor and flushes as the owner over the whole scope', async () => {
    mockResolveEmployerActor.mockResolvedValueOnce(actorResult(OWNER_ID, OWNER_SCOPE));
    (createApplicantConversation as jest.Mock).mockResolvedValue({ conversationId: CONVERSATION_ID });
    (getEmployerConversationDetail as jest.Mock).mockResolvedValue(detail);
    expect((await createHandler(event({
      body: JSON.stringify({ job_id: JOB_ID, worker_id: WORKER_ID, initial_message: 'fixture text' }),
    }))).statusCode).toBe(201);
    expect(createApplicantConversation).toHaveBeenCalledWith(client, ownerActor, JOB_ID, WORKER_ID, 'fixture text');
    expect(getEmployerConversationDetail).toHaveBeenCalledWith(client, CONVERSATION_ID, OWNER_SCOPE);
    expect(sendPendingJobMessageOutbox).toHaveBeenCalledWith(client, {
      conversationId: CONVERSATION_ID, actorUserId: OWNER_ID, actorKind: 'employer', scopeUserIds: OWNER_SCOPE,
    });
    expect(mockRecordAccess.mock.calls[0][1]).toEqual(owner);
  });
});
