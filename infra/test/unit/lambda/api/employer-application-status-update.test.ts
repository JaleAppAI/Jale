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
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
    pathParameters: { jobId: JOB_ID, workerId: WORKER_ID },
    body: JSON.stringify({ status: 'contacted' }),
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
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'reviewed' }) }));

    expect(res.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_status',
      valid: ['pending', 'contacted', 'talking', 'hired', 'not_interested'],
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

  it('returns 400 when path ids are malformed', async () => {
    const invalidJob = await handler(makeEvent({ pathParameters: { jobId: 'job-1', workerId: WORKER_ID } }));
    const invalidWorker = await handler(makeEvent({ pathParameters: { jobId: JOB_ID, workerId: 'worker-1' } }));

    expect(invalidJob.statusCode).toBe(400);
    expect(JSON.parse(invalidJob.body)).toEqual({ error: 'invalid_job_id' });
    expect(invalidWorker.statusCode).toBe(400);
    expect(JSON.parse(invalidWorker.body)).toEqual({ error: 'invalid_worker_id' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns legal_required when the employer has not accepted terms', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });
    mockQuery.mockResolvedValue({});

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('updates an applicant status for an employer-owned job', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: JOB_ID, number_of_workers_needed: 3, workers_hired: 1 }] });
      }
      if (q.includes('FROM job_applications') && !q.includes('UPDATE job_applications')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'app-1', status: 'pending' }] });
      }
      if (q.includes('UPDATE job_applications')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ application_id: 'app-1', job_id: JOB_ID, worker_id: WORKER_ID, status: 'contacted', applied_at: 'ts', updated_at: 'ts2' }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('contacted');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'e-sub');
    expect(mockCheckCompliance).toHaveBeenCalledWith(expect.anything(), 'e-sub', 'v1.0');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('JOIN users u ON u.id = jobs.employer_id'),
      [JOB_ID, 'e-sub'],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      [JOB_ID, WORKER_ID],
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE job_applications'),
      ['contacted', JOB_ID, WORKER_ID],
    );
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 404 when the worker has not applied to the job', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: JOB_ID, number_of_workers_needed: 3, workers_hired: 1 }] });
      }
      if (q.includes('FROM job_applications')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('returns 403 when RLS hides the job from the employer', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('prevents hiring more workers than the job needs', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: JOB_ID, number_of_workers_needed: 2, workers_hired: 2 }] });
      }
      if (q.includes('FROM job_applications')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'app-1', status: 'talking' }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired' }) }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'headcount_full' });
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE job_applications'), expect.anything());
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('allows re-confirming an already-hired worker even when the job is full', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: JOB_ID, number_of_workers_needed: 2, workers_hired: 2 }] });
      }
      if (q.includes('FROM job_applications') && !q.includes('UPDATE job_applications')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'app-1', status: 'hired' }] });
      }
      if (q.includes('UPDATE job_applications')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ application_id: 'app-1', job_id: JOB_ID, worker_id: WORKER_ID, status: 'hired', applied_at: 'ts', updated_at: 'ts2' }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired' }) }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('hired');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns concurrent_modification if a locked application disappears before update', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM jobs')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: JOB_ID, number_of_workers_needed: 3, workers_hired: 1 }] });
      }
      if (q.includes('FROM job_applications') && !q.includes('UPDATE job_applications')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'app-1', status: 'pending' }] });
      }
      if (q.includes('UPDATE job_applications')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'concurrent_modification' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
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

  // ---------------------------------------------------------------------------
  // Visibility-event hook -- hiring fills/unfills a job via sync_job_hired_counts()
  // ---------------------------------------------------------------------------
  //
  // sync_job_hired_counts() (029, SECURITY DEFINER, AFTER trigger on
  // job_applications) flips jobs.status between 'active' and 'filled' within
  // this same transaction whenever the application UPDATE below pushes
  // workers_hired past/below number_of_workers_needed. The handler must
  // re-read jobs.status after the UPDATE and enqueue a visibility transition
  // when the job was publicly listed.

  function makeVisibilityQueryMock(opts: {
    statusBefore: string;
    statusAfter: string;
    publicListingEnabled: boolean;
    publicCode?: string;
    appStatusBefore?: string;
    appStatusRequested?: string;
  }) {
    const {
      statusBefore, statusAfter, publicListingEnabled, publicCode = 'PUBCODE',
      appStatusBefore = 'talking', appStatusRequested = 'hired',
    } = opts;
    return (q: string) => {
      // Pre-update job snapshot (ownership check + before-status read).
      if (q.includes('JOIN users u ON u.id = jobs.employer_id')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, number_of_workers_needed: 3, workers_hired: 2,
            status: statusBefore, public_listing_enabled: publicListingEnabled, public_code: publicCode,
          }],
        });
      }
      // Post-update re-read of jobs.status (after the trigger has run).
      if (/^SELECT status FROM jobs WHERE id/.test(q.trim())) {
        return Promise.resolve({ rows: [{ status: statusAfter }] });
      }
      if (q.includes('UPDATE job_applications')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ application_id: 'app-1', job_id: JOB_ID, worker_id: WORKER_ID, status: appStatusRequested, applied_at: 'ts', updated_at: 'ts2' }],
        });
      }
      if (q.includes('FROM job_applications')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'app-1', status: appStatusBefore }] });
      }
      return Promise.resolve({});
    };
  }

  function findVisibilityEnqueueCall() {
    return mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('enqueue_job_visibility_event'));
  }

  it("enqueues a 'removed' visibility event when hiring fills a listed job (active->filled)", async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({
      statusBefore: 'active', statusAfter: 'filled', publicListingEnabled: true,
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired' }) }));

    expect(res.statusCode).toBe(200);
    const enqueueCall = findVisibilityEnqueueCall();
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall![1]).toEqual([JOB_ID, 'PUBCODE', 'removed']);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it("enqueues a 'published' visibility event when un-hiring reopens a listed job (filled->active)", async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({
      statusBefore: 'filled', statusAfter: 'active', publicListingEnabled: true,
      appStatusBefore: 'hired', appStatusRequested: 'talking',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'talking' }) }));

    expect(res.statusCode).toBe(200);
    const enqueueCall = findVisibilityEnqueueCall();
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall![1]).toEqual([JOB_ID, 'PUBCODE', 'published']);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('does NOT enqueue a visibility event when the status change does not flip effective visibility', async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({
      statusBefore: 'active', statusAfter: 'active', publicListingEnabled: true,
      appStatusBefore: 'pending', appStatusRequested: 'contacted',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'contacted' }) }));

    expect(res.statusCode).toBe(200);
    expect(findVisibilityEnqueueCall()).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('does NOT enqueue a visibility event (and skips the post-update re-read) when the job is not publicly listed', async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({
      statusBefore: 'active', statusAfter: 'filled', publicListingEnabled: false,
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired' }) }));

    expect(res.statusCode).toBe(200);
    expect(findVisibilityEnqueueCall()).toBeUndefined();
    const calls = mockQuery.mock.calls.map(([sql]: [string]) => sql);
    expect(calls.some((s: string) => typeof s === 'string' && /^SELECT status FROM jobs WHERE id/.test(s.trim()))).toBe(false);
  });
});
