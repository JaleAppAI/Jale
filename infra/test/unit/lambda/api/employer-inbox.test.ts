import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-inbox';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { listEmployerInbox } from '../../../../lambda/lib/employer-inbox';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/employer-inbox');
jest.mock('../../../../lambda/legal/check-compliance');

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
    expect(mockListEmployerInbox).toHaveBeenCalledWith(expect.anything(), EMPLOYER_ID);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  // The inbox query itself is employer-scoped by its `$1` parameter, but the
  // conversation columns it reads come from an RLS-governed table, so the
  // internal-user GUC has to be bound before the read the same way the
  // mark-read endpoint binds it.
  it('binds both RLS contexts before reading the inbox', async () => {
    const order: string[] = [];
    mockSetRlsContext.mockImplementation(async () => { order.push('setRlsContext'); });
    mockSetInternalUserRlsContext.mockImplementation(async () => { order.push('setInternalUserRlsContext'); });
    mockListEmployerInbox.mockImplementation(async () => {
      order.push('listEmployerInbox');
      return { items: [], jobs: [], unread_count: 0 };
    });

    await handler(makeEvent());

    expect(order).toEqual(['setRlsContext', 'setInternalUserRlsContext', 'listEmployerInbox']);
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
});
