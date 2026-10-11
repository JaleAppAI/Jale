import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-post-delete';
import { getDbPool, setRlsContext, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const POST_ID = '33333333-3333-4333-8333-333333333333';

const makeEvent = (post_id: string) => ({
  requestContext: { authorizer: { claims: { sub: 'worker-sub' } } },
  pathParameters: { post_id },
} as unknown as APIGatewayProxyEvent);

describe('worker-post-delete Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    });
    (setRlsContext as jest.Mock).mockResolvedValue(undefined);
    (setInternalUserRlsContext as jest.Mock).mockResolvedValue(undefined);
    (checkCompliance as jest.Mock).mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: 'worker-uuid' }] };
      if (text.includes('UPDATE worker_posts')) return { rows: [{ id: POST_ID }], rowCount: 1 };
      return { rows: [] };
    });
  });

  it('rejects a non-UUID post id', async () => {
    const res = await handler(makeEvent('nope'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_post_id');
  });

  it('soft-deletes an own published post', async () => {
    const res = await handler(makeEvent(POST_ID));
    expect(res.statusCode).toBe(200);
    const update = mockQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE worker_posts'));
    expect(update?.[0]).toContain(`SET status = 'deleted'`);
    expect(update?.[1]).toEqual([POST_ID, 'worker-uuid']);
  });

  it('returns 404 when nothing matched', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes('FROM users')) return { rows: [{ id: 'worker-uuid' }] };
      if (text.includes('UPDATE worker_posts')) return { rows: [], rowCount: 0 };
      return { rows: [] };
    });
    const res = await handler(makeEvent(POST_ID));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('post_not_found');
  });
});
