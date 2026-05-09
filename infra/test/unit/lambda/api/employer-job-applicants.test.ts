import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-job-applicants';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const makeEvent = (queryStringParameters?: Record<string, string>) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  pathParameters: { jobId: 'job-uuid' },
  queryStringParameters,
} as unknown as APIGatewayProxyEvent);

describe('employer-job-applicants Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  it('reads ordered skills from worker_skills instead of worker_profiles.skills', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 }) // job ownership
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // applicants
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const applicantQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'))?.[0];
    expect(applicantQuery).toContain('FROM worker_skills ws');
    expect(applicantQuery).not.toContain('wp.skills');
  });

  it('filters skills with normalized worker_skills values', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 }) // job ownership
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // applicants
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({ skills: ' Welding, CARPENTRY ,, ' }));

    expect(res.statusCode).toBe(200);
    const applicantCall = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'));
    expect(applicantCall?.[0]).toContain('EXISTS (');
    expect(applicantCall?.[0]).toContain('ws.skill = ANY');
    expect(applicantCall?.[1]).toContainEqual(['welding', 'carpentry']);
  });
});
