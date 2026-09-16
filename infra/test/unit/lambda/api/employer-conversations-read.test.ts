import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-conversations-read';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYER_ID = '33333333-3333-4333-8333-333333333333';
const READ_AT = '2026-09-16T10:00:00.000Z';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
    pathParameters: { conversationId: CONVERSATION_ID },
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

/**
 * Default wiring: the employer lookup resolves, and the mark-read UPDATE
 * touches exactly the caller's own row.
 */
function wireQueries(updateResult: { rowCount: number; rows: Array<{ employer_last_read_at: string }> }) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM users WHERE cognito_sub/i.test(sql)) {
      return { rowCount: 1, rows: [{ id: EMPLOYER_ID }] };
    }
    if (/UPDATE job_conversations/i.test(sql)) return updateResult;
    return { rowCount: 1, rows: [] };
  });
}

describe('employer-conversations-read', () => {
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
  });

  afterAll(() => { process.env = env; });

  it('returns 401 when unauthenticated, before opening a connection', async () => {
    const res = await handler(makeEvent({
      requestContext: { authorizer: { claims: {} } },
    } as unknown as Partial<APIGatewayProxyEvent>));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 when the conversation id is absent', async () => {
    const res = await handler(makeEvent({ pathParameters: null }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_conversation_id');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  // Without this guard a non-UUID reaches Postgres and comes back as a 22P02,
  // which the catch-all turns into a 500 -- a client error reported as an
  // outage, and a log line per probe.
  it('returns 400 on a malformed conversation id, before opening a connection', async () => {
    const res = await handler(makeEvent({ pathParameters: { conversationId: 'not-a-uuid' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_conversation_id');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 409 user_not_provisioned when the caller has no users row', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: false });
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('user_not_provisioned');
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE job_conversations/i), expect.anything(),
    );
  });

  it('returns 403 legal_required when the caller has not accepted the current ToS', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE job_conversations/i), expect.anything(),
    );
  });

  it('marks the caller\'s own conversation read and commits', async () => {
    wireQueries({ rowCount: 1, rows: [{ employer_last_read_at: READ_AT }] });
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      conversation_id: CONVERSATION_ID,
      employer_last_read_at: READ_AT,
    });
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockQuery).not.toHaveBeenCalledWith('ROLLBACK');
  });

  // Both GUCs matter and they are different things: `app.current_user_id`
  // carries the Cognito sub the legal/compliance policies key on, and
  // `app.current_internal_user_id` is what 025's
  // job_conversations_employer_all keys on -- without the second, the UPDATE
  // below matches ZERO rows and this endpoint 404s on the employer's own
  // conversation.
  it('sets BOTH RLS contexts inside the transaction and before the UPDATE', async () => {
    const order: string[] = [];
    mockSetRlsContext.mockImplementation(async () => { order.push('setRlsContext'); });
    mockSetInternalUserRlsContext.mockImplementation(async () => { order.push('setInternalUserRlsContext'); });
    mockQuery.mockImplementation((sql: string) => {
      if (/^BEGIN$/i.test(sql)) order.push('BEGIN');
      if (/UPDATE job_conversations/i.test(sql)) {
        order.push('UPDATE');
        return { rowCount: 1, rows: [{ employer_last_read_at: READ_AT }] };
      }
      if (/FROM users WHERE cognito_sub/i.test(sql)) return { rowCount: 1, rows: [{ id: EMPLOYER_ID }] };
      return { rowCount: 1, rows: [] };
    });

    await handler(makeEvent());

    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'e-sub');
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), EMPLOYER_ID);
    expect(order).toEqual(['BEGIN', 'setRlsContext', 'setInternalUserRlsContext', 'UPDATE']);
  });

  // Defence in depth, not redundancy: RLS already scopes the row set, and the
  // explicit employer_id predicate means a future policy change cannot
  // silently widen this write to another employer's thread.
  it('scopes the UPDATE by both conversation id and employer id', async () => {
    wireQueries({ rowCount: 1, rows: [{ employer_last_read_at: READ_AT }] });
    await handler(makeEvent());

    const [sql, params] = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && /UPDATE job_conversations/i.test(call[0]),
    )!;
    expect(sql).toMatch(/SET employer_last_read_at = now\(\)/i);
    expect(sql).toMatch(/WHERE id = \$1/i);
    expect(sql).toMatch(/AND employer_id = \$2/i);
    expect(sql).toMatch(/RETURNING employer_last_read_at/i);
    expect(params).toEqual([CONVERSATION_ID, EMPLOYER_ID]);
  });

  // A conversation belonging to somebody else and a conversation that does not
  // exist must be INDISTINGUISHABLE from outside: RLS filters the foreign row
  // out, so both arrive here as rowCount 0 and both answer the same 404 with
  // the same body.
  it('returns 404 for a foreign conversation without leaking that it exists', async () => {
    wireQueries({ rowCount: 0, rows: [] });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'conversation_not_found' });
  });

  it('returns 404 for an unknown conversation id', async () => {
    wireQueries({ rowCount: 0, rows: [] });
    const res = await handler(makeEvent({
      pathParameters: { conversationId: '44444444-4444-4444-8444-444444444444' },
    }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'conversation_not_found' });
  });

  it('rolls back and answers 500 when the UPDATE throws', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM users WHERE cognito_sub/i.test(sql)) return { rowCount: 1, rows: [{ id: EMPLOYER_ID }] };
      if (/UPDATE job_conversations/i.test(sql)) throw new Error('boom');
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('releases the client on both the success and the failure path', async () => {
    wireQueries({ rowCount: 1, rows: [{ employer_last_read_at: READ_AT }] });
    await handler(makeEvent());
    expect(mockRelease).toHaveBeenCalledTimes(1);

    mockQuery.mockImplementation(() => { throw new Error('boom'); });
    await handler(makeEvent());
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });
});
