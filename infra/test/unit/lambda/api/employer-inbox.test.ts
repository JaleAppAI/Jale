import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-inbox';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { listEmployerInbox } from '../../../../lambda/lib/employer-inbox';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import { callerFor, expectAttemptAfter, expectRecordedInsideTransaction, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/employer-inbox');
jest.mock('../../../../lambda/legal/check-compliance');
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

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockListEmployerInbox = listEmployerInbox as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const EMPLOYER_ID = '55555555-5555-4555-8555-555555555555';

function makeEvent(): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
  } as unknown as APIGatewayProxyEvent;
}

/**
 * GET /employer/inbox's RESPONSE SHAPE, which is the contract the employer web
 * client mirrors in frontend/src/lib/api/employer.ts.
 *
 * `lib/employer-inbox.ts` has its own suite for the unread arithmetic; this one
 * exists because the handler serialises whatever that module returns, so a
 * field could be computed correctly and still never reach the client. The nav
 * badge reads `unread_count` off the top level, so that is asserted on the
 * parsed body rather than on the module's return value.
 */
describe('employer-inbox handler', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockSetInternalUserRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockResolvedValue(actorResult(EMPLOYER_ID));
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM users WHERE cognito_sub/i.test(sql)) return { rowCount: 1, rows: [{ id: EMPLOYER_ID }] };
      return { rowCount: 1, rows: [] };
    });
  });

  afterAll(() => { process.env = env; });

  it('returns 401 when unauthenticated', async () => {
    mockGetDbPool.mockClear();
    const res = await handler({
      requestContext: { authorizer: { claims: {} } },
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('ships items, jobs AND the top-level unread_count, and commits', async () => {
    mockListEmployerInbox.mockResolvedValue({
      items: [
        { application_id: 'a1', conversation_id: 'c1', tab: 'active', unread: true },
        { application_id: 'a2', conversation_id: 'c2', tab: 'closed', unread: false },
      ],
      jobs: [{ job_id: 'j1', title: 'Line Cook', city: 'Austin', status: 'active' }],
      unread_count: 1,
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.unread_count).toBe(1);
    expect(body.items.map((item: { unread: boolean }) => item.unread)).toEqual([true, false]);
    expect(body.jobs).toHaveLength(1);
    expect(mockListEmployerInbox).toHaveBeenCalledWith(expect.anything(), [EMPLOYER_ID]);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  // The inbox query itself is employer-scoped by its `$1` parameter, but the
  // conversation columns it reads come from an RLS-governed table, so the
  // internal-user GUC has to be bound before the read the same way the
  // mark-read endpoint binds it.
  it('binds the sub lane and resolves the actor (which binds the internal lane) before reading the inbox', async () => {
    const order: string[] = [];
    mockSetRlsContext.mockImplementation(async () => { order.push('setRlsContext'); });
    mockResolveEmployerActor.mockImplementation(async () => { order.push('resolveEmployerActor'); return actorResult(EMPLOYER_ID); });
    mockListEmployerInbox.mockImplementation(async () => {
      order.push('listEmployerInbox');
      return { items: [], jobs: [], unread_count: 0 };
    });

    await handler(makeEvent());

    expect(order).toEqual(['setRlsContext', 'resolveEmployerActor', 'listEmployerInbox']);
    expect(mockSetInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('answers the actor failure after COMMIT and reads nothing', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockListEmployerInbox).not.toHaveBeenCalled();
  });

  it("reads an owner's whole scope", async () => {
    mockResolveEmployerActor.mockResolvedValue(actorResult(OWNER_ID, [OWNER_ID, FOREMAN_ID]));
    mockListEmployerInbox.mockResolvedValue({ items: [], jobs: [], unread_count: 0 });
    expect((await handler(makeEvent())).statusCode).toBe(200);
    expect(mockListEmployerInbox).toHaveBeenCalledWith(expect.anything(), [OWNER_ID, FOREMAN_ID]);
  });

  it('reports unread_count 0 for an empty inbox rather than omitting it', async () => {
    mockListEmployerInbox.mockResolvedValue({ items: [], jobs: [], unread_count: 0 });
    const res = await handler(makeEvent());
    const body = JSON.parse(res.body);
    // `undefined` would serialise away entirely and leave the badge reading a
    // missing field as NaN.
    expect(body).toHaveProperty('unread_count', 0);
  });

  it('rolls back and answers 500 when the inbox read throws', async () => {
    mockListEmployerInbox.mockRejectedValue(new Error('boom'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  describe('access record', () => {
    const mockRecordAccess = recordAccess as jest.Mock;
    const mockRecordAttempt = recordAttempt as jest.Mock;
    const employer = callerFor('employer', EMPLOYER_ID);
    const client = expect.objectContaining({ query: mockQuery });
    const inbox = {
      items: [
        { application_id: 'a1', worker_id: 'w1', worker_name: 'Fixture Name', conversation_id: 'c1', last_message_preview: 'fixture text', tab: 'active', unread: true },
        { application_id: 'a2', worker_id: 'w2', worker_name: 'Fixture Name', conversation_id: null, last_message_preview: null, tab: 'active', unread: false },
      ],
      jobs: [],
      unread_count: 1,
    };

    beforeEach(() => {
      mockRecordAccess.mockResolvedValue(undefined);
      mockRecordAttempt.mockResolvedValue(undefined);
    });

    it('records every worker listed and every thread previewed, before COMMIT', async () => {
      mockListEmployerInbox.mockResolvedValue(inbox);
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(200);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.inbox',
        subjectUserIds: ['w1', 'w2'],
        recordIds: ['c1'],
        resultCount: 2,
        fieldNames: Object.keys(inbox.items[0]).sort(),
      });
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
    });

    it('answers 500 with no inbox when the record cannot be written', async () => {
      mockListEmployerInbox.mockResolvedValue(inbox);
      mockRecordAccess.mockRejectedValue(new Error('audit'));
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, { surface: 'employer.inbox', outcome: 'failed' });
    });
  });
});
