import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-application-status-update';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { enqueueApplicationStageNotification } from '../../../../lambda/lib/application-stage-notify';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/application-stage-notify');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockNotify = enqueueApplicationStageNotification as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333';
const EMPLOYER_ID = '44444444-4444-4444-8444-444444444444';

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
    delete process.env.FRONTEND_BASE_URL;
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockNotify.mockResolvedValue({
      outcome: 'enqueued',
      intentId: 'intent-1',
      decision: { action: 'allow', reason: 'worker_ready' },
      outboxMaterialized: true,
    });
  });

  afterAll(() => { process.env = env; });

  it('rejects invalid statuses before opening a DB transaction', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'reviewed' }) }));

    expect(res.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_status',
      valid: ['pending', 'contacted', 'talking', 'details_requested', 'hired', 'not_interested'],
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
    // 091 stage columns: details_requested_at is stamped once, on the first
    // move into details_requested, and never cleared by a later transition.
    const updateSql = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE job_applications'),
    )![0] as string;
    expect(updateSql).toContain(
      "details_requested_at = CASE WHEN $1 = 'details_requested' THEN COALESCE(details_requested_at, now()) ELSE details_requested_at END",
    );
    expect(updateSql).toContain('updated_at = now()');
    expect(updateSql).toMatch(/RETURNING[\s\S]*details_requested_at[\s\S]*details_completed_at/);
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
            employer_id: EMPLOYER_ID, title: 'Concrete Finisher', employer_user_id: EMPLOYER_ID,
          }],
        });
      }
      // Post-update re-read of jobs.status (after the trigger has run).
      if (/^SELECT status FROM jobs WHERE id/.test(q.trim())) {
        return Promise.resolve({ rows: [{ status: statusAfter }] });
      }
      if (q.includes('employer_display_name')) {
        return Promise.resolve({ rowCount: 1, rows: [{ company_name: 'RM Construction' }] });
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

    // Hiring also notifies the worker, and employer_display_name() must come
    // AFTER the visibility work: it widens employer_profiles reads until COMMIT.
    const sqls = mockQuery.mock.calls.map(([sql]: [string]) => (typeof sql === 'string' ? sql : ''));
    const visibilityIdx = sqls.findIndex((s: string) => s.includes('enqueue_job_visibility_event'));
    const displayNameIdx = sqls.findIndex((s: string) => s.includes('employer_display_name'));
    expect(displayNameIdx).toBeGreaterThan(visibilityIdx);
    expect(mockNotify.mock.calls[0][1]).toMatchObject({
      kind: 'hired', companyName: 'RM Construction', jobTitle: 'Concrete Finisher',
    });
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

  // ---------------------------------------------------------------------------
  // Sprint 23 stage awareness -- the 091 hire gate and the worker notification
  // ---------------------------------------------------------------------------

  const UPDATED_AT = '2026-09-02T12:00:00.000Z';

  function makeStageQueryMock(opts: {
    appStatusBefore: string;
    appStatusRequested: string;
    updateError?: unknown;
  }) {
    return (q: string) => {
      if (q.includes('JOIN users u ON u.id = jobs.employer_id')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, number_of_workers_needed: 3, workers_hired: 0,
            status: 'active', public_listing_enabled: false, public_code: null,
            employer_id: EMPLOYER_ID, title: 'Concrete Finisher', employer_user_id: EMPLOYER_ID,
          }],
        });
      }
      if (q.includes('employer_display_name')) {
        return Promise.resolve({ rowCount: 1, rows: [{ company_name: 'RM Construction' }] });
      }
      if (q.includes('UPDATE job_applications')) {
        if (opts.updateError) return Promise.reject(opts.updateError);
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            application_id: APPLICATION_ID, job_id: JOB_ID, worker_id: WORKER_ID,
            status: opts.appStatusRequested, applied_at: 'ts', updated_at: UPDATED_AT,
            details_requested_at: null, details_completed_at: null,
          }],
        });
      }
      if (q.includes('FROM job_applications')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: APPLICATION_ID, status: opts.appStatusBefore }] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    };
  }

  it("puts the EMPLOYER's users.id in app.current_internal_user_id, after the jobCheck and before the UPDATE", async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'talking', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    // users_employer_applicant_read (020b:261-269) is jale_admin's only path to
    // a worker row and matches on this GUC holding the EMPLOYER's users.id.
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledTimes(1);
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), EMPLOYER_ID);

    const sqls = mockQuery.mock.calls.map(([sql]: [string]) => (typeof sql === 'string' ? sql : ''));
    const jobCheckIdx = sqls.findIndex((q: string) => q.includes('JOIN users u ON u.id = jobs.employer_id'));
    const updateIdx = sqls.findIndex((q: string) => q.includes('UPDATE job_applications'));
    const gucOrder = mockSetInternalUserRlsContext.mock.invocationCallOrder[0];
    expect(gucOrder).toBeGreaterThan(mockQuery.mock.invocationCallOrder[jobCheckIdx]);
    expect(gucOrder).toBeLessThan(mockQuery.mock.invocationCallOrder[updateIdx]);
    // ...and it is never re-pointed at the worker.
    expect(mockSetInternalUserRlsContext).not.toHaveBeenCalledWith(expect.anything(), WORKER_ID);
  });

  it("returns 409 details_incomplete (and rolls back) when 091's hire gate rejects the UPDATE", async () => {
    const gateError = Object.assign(new Error('new row violates check constraint'), {
      code: '23514',
      constraint: 'job_applications_hire_requirements_check',
      detail: JSON.stringify({ fields: ['start_date'], docs: ['id'], certifications: ['OSHA 10'] }),
    });
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'details_requested', appStatusRequested: 'hired', updateError: gateError,
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired' }) }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: 'details_incomplete',
      missing: { fields: ['start_date'], docs: ['id'], certifications: ['OSHA 10'] },
    });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('still 500s and rolls back on a CHECK violation that is not the hire gate', async () => {
    const otherError = Object.assign(new Error('nope'), {
      code: '23514',
      constraint: 'job_applications_status_check',
    });
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'pending', appStatusRequested: 'hired', updateError: otherError,
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired' }) }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('enqueues the worker notification on details_requested, after resolving the company name', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'talking', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(expect.anything(), {
      applicationId: APPLICATION_ID,
      workerId: WORKER_ID,
      kind: 'details_requested',
      jobId: JOB_ID,
      jobTitle: 'Concrete Finisher',
      companyName: 'RM Construction',
      frontendBaseUrl: 'https://jaleapp.ai',
      updatedAt: UPDATED_AT,
    });

    // employer_display_name() widens employer_profiles reads until COMMIT, so
    // it must be the LAST employer-adjacent query -- immediately before the
    // enqueue, which is itself the last thing before COMMIT.
    const displayNameCall = mockQuery.mock.calls.findIndex(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('employer_display_name'),
    );
    const commitCall = mockQuery.mock.calls.findIndex(([sql]: [string]) => sql === 'COMMIT');
    expect(displayNameCall).toBeGreaterThan(-1);
    expect(displayNameCall).toBe(commitCall - 1);
    expect(mockQuery.mock.invocationCallOrder[displayNameCall])
      .toBeLessThan(mockNotify.mock.invocationCallOrder[0]);
    expect(mockQuery.mock.invocationCallOrder[commitCall])
      .toBeGreaterThan(mockNotify.mock.invocationCallOrder[0]);
  });

  it('enqueues with kind hired when the employer hires the worker', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'details_requested', appStatusRequested: 'hired',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][1]).toMatchObject({ kind: 'hired', applicationId: APPLICATION_ID });
  });

  it('uses FRONTEND_BASE_URL when it is configured', async () => {
    process.env.FRONTEND_BASE_URL = 'https://app.jaleapp.ai';
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'talking', appStatusRequested: 'details_requested',
    }));

    await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(mockNotify.mock.calls[0][1]).toMatchObject({ frontendBaseUrl: 'https://app.jaleapp.ai' });
  });

  it("falls back to employer_display_name()'s own default when the lookup yields no row", async () => {
    const base = makeStageQueryMock({ appStatusBefore: 'talking', appStatusRequested: 'details_requested' });
    mockQuery.mockImplementation((q: string) => (
      q.includes('employer_display_name') ? Promise.resolve({ rowCount: 0, rows: [] }) : base(q)
    ));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockNotify.mock.calls[0][1]).toMatchObject({ companyName: 'Empleador' });
  });

  it('does NOT enqueue for a non-notifying status such as contacted', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'pending', appStatusRequested: 'contacted',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'contacted' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('employer_display_name'), expect.anything());
  });

  it('does NOT enqueue when the status did not actually change', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'details_requested', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
    // The GUC-widening lookup must not run for a no-op PATCH either.
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('employer_display_name'), expect.anything());
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('commits the status change and logs a metric when the worker cannot be rendered', async () => {
    mockNotify.mockResolvedValue({ outcome: 'renderer_unavailable', reason: 'renderer_unavailable' });
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'talking', appStatusRequested: 'details_requested',
    }));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('details_requested');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      metric: 'ApplicationStageNotifySkipped',
      reason: 'renderer_unavailable',
      applicationId: APPLICATION_ID,
    }));
    logSpy.mockRestore();
  });

  it('rolls back to 500 when the enqueue fails for any other reason', async () => {
    mockNotify.mockRejectedValue(new Error('permission denied for table worker_message_intents'));
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'talking', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });
  // ---------------------------------------------------------------------------
  // B7 (sprint 24) -- honest notification outcome + resend
  //
  // The employer could not previously tell whether the worker actually heard
  // about a details request: a `renderer_unavailable` worker got a plain 200
  // with the row. The response now says so, and `resend: true` re-sends the
  // same stage notification for a status that is already committed.
  // ---------------------------------------------------------------------------

  it('reports notified true when the status changed and the notification was enqueued', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'talking', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.notified).toBe(true);
    // Only present when the answer is "no" -- there is nothing to explain
    // about a notification that went out.
    expect(body).not.toHaveProperty('notify_reason');
  });

  it("reports notified false with reason 'unchanged' when the same status is re-asserted without resend", async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'details_requested', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ notified: false, notify_reason: 'unchanged' });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("reports notified false with reason 'not_notifiable_status' for a status the worker is never pinged about", async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'pending', appStatusRequested: 'contacted',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'contacted' }) }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ notified: false, notify_reason: 'not_notifiable_status' });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("reports notified false with reason 'renderer_unavailable' and STILL commits the status", async () => {
    mockNotify.mockResolvedValue({ outcome: 'renderer_unavailable', reason: 'renderer_unavailable' });
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'talking', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'details_requested' }) }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('details_requested');
    expect(body.notified).toBe(false);
    expect(body.notify_reason).toBe('renderer_unavailable');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('re-enqueues the stage notification when resend is requested on an already details_requested application', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'details_requested', appStatusRequested: 'details_requested',
    }));

    const res = await handler(makeEvent({
      body: JSON.stringify({ status: 'details_requested', resend: true }),
    }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).notified).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][1]).toMatchObject({
      kind: 'details_requested',
      applicationId: APPLICATION_ID,
      updatedAt: UPDATED_AT,
    });
  });

  it('re-enqueues the hired notification when resend is requested on an already hired application', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'hired', appStatusRequested: 'hired',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'hired', resend: true }) }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).notified).toBe(true);
    expect(mockNotify.mock.calls[0][1]).toMatchObject({ kind: 'hired' });
  });

  it('returns 400 resend_not_applicable (and rolls back) when resend is asked for on a pending application', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'pending', appStatusRequested: 'pending',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'pending', resend: true }) }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'resend_not_applicable', status: 'pending' });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    // Nothing may be written on the refused path.
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE job_applications'), expect.anything());
  });

  it('rejects a non-boolean resend before opening a DB transaction (400)', async () => {
    const res = await handler(makeEvent({
      body: JSON.stringify({ status: 'details_requested', resend: 'yes' }),
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_resend' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('treats resend: false as no resend at all (no 400, no notification)', async () => {
    mockQuery.mockImplementation(makeStageQueryMock({
      appStatusBefore: 'pending', appStatusRequested: 'pending',
    }));

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'pending', resend: false }) }));

    expect(res.statusCode).toBe(200);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });
});
