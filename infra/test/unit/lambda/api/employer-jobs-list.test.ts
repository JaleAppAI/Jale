import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-list';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('employer-jobs-list', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const baseEvent = {
    requestContext: { authorizer: { claims: { sub: 'employer-sub-1' } } },
  } as unknown as APIGatewayProxyEvent;

  it('returns 401 when cognito sub is missing', async () => {
    const res = await handler({
      ...baseEvent,
      requestContext: { authorizer: { claims: {} } },
    } as any);

    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with jobs and applicant counts', async () => {
    const row = {
      id: 'job-1',
      title: 'Forklift Driver',
      location: 'Houston',
      job_type: 'full-time',
      status: 'active',
      created_at: '2026-04-20T00:00:00Z',
      applicant_count: 3,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM jobs j')) return Promise.resolve({ rows: [row] });
      if (sql.includes('FROM users')) return Promise.resolve({ rows: [{ id: 'employer-1' }] });
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jobs: [row] });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'employer-sub-1');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM jobs j'), ['employer-sub-1']);
  });
});
