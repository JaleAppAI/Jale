import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-job-public-listing';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const JOB_ID = '11111111-2222-4333-8444-555555555555';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'emp-sub' } } },
    pathParameters: { jobId: JOB_ID },
    body: JSON.stringify({ enabled: true }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('employer-job-public-listing', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  function mockUpdateReturning(rows: unknown[]) {
    mockQuery.mockImplementation((q: string) => {
      if (typeof q === 'string' && q.includes('UPDATE jobs SET public_listing_enabled')) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await handler(makeEvent({ requestContext: { authorizer: { claims: {} } } } as any));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-boolean enabled — publishing is a consent action, no coercion', async () => {
    for (const bad of ['true', 1, null, undefined, {}]) {
      const res = await handler(makeEvent({ body: JSON.stringify({ enabled: bad }) }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_enabled');
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a malformed job id before touching the database', async () => {
    const res = await handler(makeEvent({ pathParameters: { jobId: 'not-a-uuid' } }));
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('turns a listing on for the owning employer', async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: true }]);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: JOB_ID, public_listing_enabled: true });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'emp-sub');
    // The ownership scope lives inside the statement itself.
    const update = mockQuery.mock.calls.find((c) => /UPDATE jobs SET public_listing_enabled/.test(c[0]));
    expect(update[0]).toContain('u.cognito_sub = $3');
    expect(update[1]).toEqual([true, JOB_ID, 'emp-sub']);
  });

  it('turns a listing off with the same shape', async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: false }]);
    const res = await handler(makeEvent({ body: JSON.stringify({ enabled: false }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).public_listing_enabled).toBe(false);
  });

  it("returns 404 for another employer's job — indistinguishable from not-found", async () => {
    // The ownership CTE matches nothing, so the UPDATE returns zero rows.
    mockUpdateReturning([]);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('job_not_found');
    // And the transaction is rolled back, not committed.
    const verbs = mockQuery.mock.calls.map((c) => c[0]);
    expect(verbs).toContain('ROLLBACK');
    expect(verbs).not.toContain('COMMIT');
  });

  it('gates on legal compliance like every other employer endpoint', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });
});
