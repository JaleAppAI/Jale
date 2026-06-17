import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-update';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const JOB_ID = '11111111-1111-4111-8111-111111111111';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
    pathParameters: { jobId: JOB_ID },
    body: JSON.stringify({ status: 'paused' }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('employer-jobs-update', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  afterAll(() => { process.env = env; });

  it('rejects filled because it is a backend-managed status', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'filled' }) }));

    expect(res.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_status',
      valid: ['active', 'paused', 'closed'],
    });
  });

  it('returns 401 when the caller is not authenticated', async () => {
    const res = await handler(makeEvent({
      requestContext: { authorizer: { claims: {} } },
    } as unknown as Partial<APIGatewayProxyEvent>));

    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 when jobId is missing', async () => {
    const res = await handler(makeEvent({ pathParameters: {} }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_job_id' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 when jobId is malformed', async () => {
    const res = await handler(makeEvent({ pathParameters: { jobId: 'job-1' } }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_job_id' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await handler(makeEvent({ body: '{' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('updates a writable job status and returns headcount fields', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: 'job-1',
            title: 'Concrete Finisher',
            location: 'Columbus, OH',
            pay: '$25-$30',
            job_type: 'contract',
            status: 'paused',
            created_at: 'now',
            pay_min: 25,
            pay_max: 30,
            start_date: '2026-06-01',
            expected_duration: '2 weeks',
            shift_schedule: 'Day',
            transportation_required: false,
            language_preference: ['any'],
            number_of_workers_needed: 3,
            hired_count: 1,
            open_count: 2,
            trade_category: 'concrete',
            required_experience_years: 2,
            certifications: [],
            applicant_count: 4,
          }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'paused',
      hired_count: 1,
      open_count: 2,
      number_of_workers_needed: 3,
    });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'e-sub');
    expect(mockCheckCompliance).toHaveBeenCalledWith(expect.anything(), 'e-sub', 'v1.0');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('JOIN users u ON u.id = jobs.employer_id'),
      ['paused', JOB_ID, 'e-sub'],
    );
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('rolls back instead of committing when legal acceptance is missing', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });
    mockQuery.mockResolvedValue({});

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when the employer user is not provisioned', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: false });
    mockQuery.mockResolvedValue({});

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when the employer does not own the job', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('UPDATE jobs')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });
});
