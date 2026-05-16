import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-detail';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('employer-jobs-detail', () => {
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
    pathParameters: { jobId: 'job-1' },
  } as unknown as APIGatewayProxyEvent;

  it('returns full job posting details', async () => {
    const row = {
      id: 'job-1',
      title: 'Forklift Driver',
      location: 'Houston',
      job_type: 'full-time',
      status: 'active',
      description: 'Unload trucks and stage materials.',
      required_docs: ['driver_license'],
      created_at: '2026-04-20T00:00:00Z',
      applicant_count: 2,
    };
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, title, location')) return Promise.resolve({ rows: [row] });
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(row);
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'employer-sub-1');
  });

  it('normalizes nullable required_docs for the frontend contract', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, title, location')) {
        return Promise.resolve({
          rows: [{
            id: 'job-1',
            title: 'Painter',
            location: 'Austin',
            job_type: 'contract',
            status: 'active',
            description: null,
            required_docs: null,
            created_at: '2026-04-20T00:00:00Z',
            applicant_count: 0,
          }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).required_docs).toEqual([]);
  });
});
