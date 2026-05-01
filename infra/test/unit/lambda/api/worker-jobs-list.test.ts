import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-jobs-list';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('worker-jobs-list', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });
  afterAll(() => { process.env = originalEnv; });

  const baseEvent = {
    requestContext: { authorizer: { claims: { sub: 'worker-sub-1' } } },
    queryStringParameters: null,
  } as unknown as APIGatewayProxyEvent;

  it('returns 401 if cognito sub missing', async () => {
    const res = await handler({ ...baseEvent, requestContext: { authorizer: { claims: {} } } } as any);
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 legal_required if not compliant', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    mockQuery.mockResolvedValue({});
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });

  it('returns 200 with jobs list on happy path', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const row = {
      id: 'j1', title: 'Forklift', location: 'Houston', job_type: 'full-time',
      company_name: 'Acme', required_docs: ['resume'], created_at: '2026-04-20T00:00:00Z',
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [row] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jobs: [row] });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-sub-1');
  });

  it('passes search and job_type as query params', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockResolvedValue({ rows: [] });
    const ev = { ...baseEvent, queryStringParameters: { search: 'forklift', job_type: 'full-time' } } as any;
    await handler(ev);
    const sqlCall = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('FROM jobs'));
    expect(sqlCall?.[1]).toEqual(expect.arrayContaining(['%forklift%', 'full-time']));
  });
});
