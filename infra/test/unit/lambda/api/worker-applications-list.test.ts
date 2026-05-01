import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-applications-list';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ev = { requestContext: { authorizer: { claims: { sub: 'w' } } } } as unknown as APIGatewayProxyEvent;

describe('worker-applications-list', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 200 with applications list', async () => {
    const row = { application_id: 'a1', job_id: 'j1', job_title: 'T', company_name: 'Acme', status: 'pending', applied_at: 'ts' };
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [row] });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ applications: [row] });
  });
});
