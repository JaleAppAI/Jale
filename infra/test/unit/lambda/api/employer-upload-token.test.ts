import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-upload-token';
import { getDbPool } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('employer-upload-token Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    process.env.FRONTEND_BASE_URL = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  const makeEvent = (body: object) =>
    ({
      requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
      body: JSON.stringify(body),
    }) as unknown as APIGatewayProxyEvent;

  it('returns 400 if job_id or worker_id is missing', async () => {
    const res = await handler(makeEvent({ job_id: 'j1' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 if employer does not own the job', async () => {
    mockQuery.mockResolvedValueOnce({}).mockResolvedValue({ rows: [] });
    const res = await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    expect(res.statusCode).toBe(403);
  });

  it('returns 201 with upload link on success', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'j1' }] }) // job ownership
      .mockResolvedValueOnce({}) // INSERT token
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.upload_url).toContain('/upload/');
    expect(mockRelease).toHaveBeenCalled();
  });
});
