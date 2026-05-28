import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-worker-profile';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('employer-worker-profile Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
  });

  const makeEvent = (sub: string | null, workerId = 'worker-uuid', jobId = 'job-uuid') =>
    ({
      requestContext: { authorizer: { claims: sub ? { sub } : {} } },
      pathParameters: { worker_id: workerId },
      queryStringParameters: { job_id: jobId },
    }) as unknown as APIGatewayProxyEvent;

  it('returns 401 if cognitoSub is missing', async () => {
    const res = await handler(makeEvent(null));
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 if legal compliance not met', async () => {
    mockCheckCompliance.mockResolvedValue({
      compliant: false,
      userExists: true,
      currentVersion: 'v0.9',
    });
    mockQuery.mockResolvedValue({});
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 if employer does not own the job', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({ rows: [] }); // job ownership check
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
  });

  it('returns 200 with worker profile and application status', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const mockProfile = {
      worker_id: 'worker-uuid',
      full_name: 'Maria G',
      phone: '555-1234',
      skills: ['Forklift'],
      availability: 'immediate',
      years_experience: 3,
      location: 'LA',
      application_status: 'pending',
      applied_at: new Date().toISOString(),
    };
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] }) // job ownership
      .mockResolvedValueOnce({ rows: [mockProfile] }) // profile query
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(mockProfile);
    const profileQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'))?.[0];
    expect(profileQuery).toContain('FROM worker_skills ws');
    expect(profileQuery).toContain('WHERE ws.worker_id = ja.worker_id');
    expect(profileQuery).toContain('j.employer_id = $3');
    expect(profileQuery).not.toContain('wp.skills');
    expect(mockRelease).toHaveBeenCalled();
  });
});
