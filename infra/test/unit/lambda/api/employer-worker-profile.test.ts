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

  it('returns 200 with worker profile including safe onboarding facts', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const mockProfile = {
      worker_id: 'worker-uuid',
      full_name: 'Maria G',
      phone: '555-1234',
      skills: ['Forklift'],
      availability: 'immediate',
      years_experience: 3,
      experience_months: 36,
      location: 'LA',
      certifications: ['OSHA 10'],
      main_trade: 'electrician',
      main_trade_other: null,
      has_transportation: true,
      city: 'Los Angeles',
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
    expect(profileQuery).toContain('wp.experience_months');
    expect(profileQuery).toContain('wp.certifications');
    // Safe onboarding facts must be in the query
    expect(profileQuery).toContain('u.main_trade');
    expect(profileQuery).toContain('u.main_trade_other');
    expect(profileQuery).toContain('u.has_transportation');
    expect(profileQuery).toContain('u.city');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('does not expose scoring or rubric internals in the SQL query', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] }) // employer lookup
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] }) // job ownership
      .mockResolvedValueOnce({ rows: [{ worker_id: 'w', full_name: null, phone: null, skills: [], availability: null, years_experience: null, experience_months: null, location: null, certifications: [], main_trade: null, main_trade_other: null, has_transportation: null, city: null, application_status: 'pending', applied_at: null }] }) // profile query
      .mockResolvedValueOnce({}); // COMMIT
    await handler(makeEvent('employer-sub'));
    const profileQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'))?.[0];
    expect(profileQuery).not.toContain('trade_competency_score');
    expect(profileQuery).not.toContain('trust_signals');
    expect(profileQuery).not.toContain('worker_trust_assessments');
    expect(profileQuery).not.toContain('score_components');
    expect(profileQuery).not.toContain('score_rationale');
    expect(profileQuery).not.toContain('confidence_scores');
  });
});
