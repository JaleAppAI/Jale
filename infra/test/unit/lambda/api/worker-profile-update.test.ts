import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-profile-update';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const mkEv = (body: any) => ({
  requestContext: { authorizer: { claims: { sub: 'w' } } },
  body: JSON.stringify(body),
  httpMethod: 'PATCH',
} as unknown as APIGatewayProxyEvent);

describe('worker-profile-update', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('rejects invalid availability', async () => {
    const res = await handler(mkEv({ availability: 'whenever' }));
    expect(res.statusCode).toBe(400);
  });

  it('upserts worker_profiles and optionally updates users.full_name', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('UPDATE users')) return Promise.resolve({ rowCount: 1 });
      if (q.includes('INSERT INTO worker_profiles')) return Promise.resolve({ rows: [{ user_id: 'u', skills: ['welding'], availability: 'immediate', years_experience: 3, location: 'TX', bio: null }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv({ full_name: 'John', skills: ['welding'], availability: 'immediate', years_experience: 3, location: 'TX' }));
    expect(res.statusCode).toBe(200);
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('UPDATE users'))).toBe(true);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_profiles'))).toBe(true);
  });
});
