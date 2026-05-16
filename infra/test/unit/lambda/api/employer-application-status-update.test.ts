import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-application-status-update';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
    pathParameters: { jobId: 'job-1', workerId: 'worker-1' },
    body: JSON.stringify({ status: 'reviewed' }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('employer-application-status-update', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  afterAll(() => { process.env = env; });

  it('rejects invalid statuses before opening a DB transaction', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'contacted' }) }));

    expect(res.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_status',
      valid: ['pending', 'reviewed', 'hired', 'rejected'],
    });
  });

  it('returns 401 when the caller is not authenticated', async () => {
    const res = await handler(makeEvent({
      requestContext: { authorizer: { claims: {} } },
    } as unknown as Partial<APIGatewayProxyEvent>));

    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await handler(makeEvent({ body: '{' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns legal_required when the employer has not accepted terms', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });
    mockQuery.mockResolvedValue({});

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('updates an applicant status for an employer-owned job', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) return Promise.resolve({ rowCount: 1, rows: [{ id: 'job-1' }] });
      if (q.includes('UPDATE job_applications')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ application_id: 'app-1', job_id: 'job-1', worker_id: 'worker-1', status: 'reviewed', applied_at: 'ts', updated_at: 'ts2' }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('reviewed');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'e-sub');
    expect(mockCheckCompliance).toHaveBeenCalledWith(expect.anything(), 'e-sub', 'v1.0');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE job_applications'),
      ['reviewed', 'job-1', 'worker-1'],
    );
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 404 when the worker has not applied to the job', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) return Promise.resolve({ rowCount: 1, rows: [{ id: 'job-1' }] });
      if (q.includes('UPDATE job_applications')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 403 when RLS hides the job from the employer', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back on unexpected DB errors', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) throw new Error('boom');
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
