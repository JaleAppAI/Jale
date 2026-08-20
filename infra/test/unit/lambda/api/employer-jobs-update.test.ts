import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-update';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveEntitlements } from '../../../../lambda/lib/entitlements';
import { setJobCoordinates } from '../../../../lambda/lib/location';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/entitlements');
jest.mock('../../../../lambda/lib/location');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockResolveEntitlements = resolveEntitlements as jest.Mock;
const mockSetJobCoordinates = setJobCoordinates as jest.Mock;
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
    mockSetJobCoordinates.mockResolvedValue(undefined);
    // Default: employer_free plan with 1 slot, 0 active jobs — won't affect non-active transitions
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1 });
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
            public_code: 'PUB123',
            public_listing_enabled: true,
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
      public_code: 'PUB123',
      public_listing_enabled: true,
    });
    const statusUpdateCall = mockQuery.mock.calls.find(([q]) => typeof q === 'string' && q.includes('UPDATE jobs SET status'));
    expect(statusUpdateCall[0]).toContain('public_code');
    expect(statusUpdateCall[0]).toContain('public_listing_enabled');
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

  // ---------------------------------------------------------------------------
  // Entitlement gate — A7 tests
  // ---------------------------------------------------------------------------

  // Helper to build a mock query dispatcher for the update path.
  // currentJobStatus: status returned by the SELECT before UPDATE.
  // activeJobs: count returned for active job count.
  function makeUpdateQueryMock(currentJobStatus: string, activeJobs: number) {
    return (q: string) => {
      // The pre-read (current job status fetch) now carries its own
      // "FOR UPDATE OF jobs" row lock (fix: TOCTOU on status change), so it
      // must be matched BEFORE the generic entitlement-lock "FOR UPDATE"
      // check below, or this branch would never be reached.
      if (q.includes('SELECT') && q.includes('jobs.status') && !q.includes('UPDATE jobs')) {
        // current job status fetch
        return Promise.resolve({ rows: [{ status: currentJobStatus }] });
      }
      if (q.includes('FROM users') && q.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      if (q.includes('COUNT(*)')) return Promise.resolve({ rows: [{ active_jobs: activeJobs }] });
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, title: 'Concrete Finisher', location: 'Columbus, OH',
            pay: null, job_type: 'contract', status: 'active', created_at: 'now',
            pay_min: null, pay_max: null, pay_interval: null, start_date: null,
            expected_duration: null, shift_schedule: null, transportation_required: false,
            work_authorization_required: false, language_preference: ['any'],
            number_of_workers_needed: 1, hired_count: 0, open_count: 1,
            trade_category: 'concrete', required_experience_years: null,
            required_experience_months: null, certifications: [], applicant_count: 0,
          }],
        });
      }
      return Promise.resolve({});
    };
  }

  it('returns 403 job_limit_reached when paused→active reactivation exceeds free plan limit', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1 });
    mockQuery.mockImplementation(makeUpdateQueryMock('paused', 1)); // 1 active job = at limit

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('job_limit_reached');
    expect(body.plan_code).toBe('employer_free');
    expect(body.active_job_limit).toBe(1);
    expect(body.active_jobs).toBe(1);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE jobs'), expect.anything());
  });

  it('allows paused→active when employer_pro plan has slots remaining', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10 });
    mockQuery.mockImplementation(makeUpdateQueryMock('paused', 3)); // under limit

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('does NOT apply entitlement gate for active→paused (slot freed, not consumed)', async () => {
    // Even if resolveEntitlements would return limit=0 (impossible but proves gate is skipped)
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 0 });
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, title: 'Concrete Finisher', location: 'Columbus, OH',
            pay: null, job_type: 'contract', status: 'paused', created_at: 'now',
            pay_min: null, pay_max: null, pay_interval: null, start_date: null,
            expected_duration: null, shift_schedule: null, transportation_required: false,
            work_authorization_required: false, language_preference: ['any'],
            number_of_workers_needed: 1, hired_count: 0, open_count: 1,
            trade_category: 'concrete', required_experience_years: null,
            required_experience_months: null, certifications: [], applicant_count: 0,
          }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'paused' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    // Gate NOT applied: no FOR UPDATE and no active-job-count gate query (distinct from
    // the applicant_count subselect in the UPDATE RETURNING clause).
    const calls = mockQuery.mock.calls.map(([sql]: [string]) => sql);
    // Specific to the entitlement lock (`FROM users ... FOR UPDATE`), not a
    // generic "FOR UPDATE" substring check -- the pre-read query always runs
    // and always carries its own "FOR UPDATE OF jobs" (fix: TOCTOU on status
    // change), which would otherwise make this assertion trivially true for
    // the wrong reason regardless of whether the entitlement gate ran.
    expect(calls.some((s: string) => s.includes('FROM users') && s.includes('FOR UPDATE'))).toBe(false);
    expect(calls.some((s: string) => s.includes('active_jobs'))).toBe(false);
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
  });

  it('does NOT apply entitlement gate for active→closed', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, title: 'Concrete Finisher', location: 'Columbus, OH',
            pay: null, job_type: 'contract', status: 'closed', created_at: 'now',
            pay_min: null, pay_max: null, pay_interval: null, start_date: null,
            expected_duration: null, shift_schedule: null, transportation_required: false,
            work_authorization_required: false, language_preference: ['any'],
            number_of_workers_needed: 1, hired_count: 0, open_count: 1,
            trade_category: 'concrete', required_experience_years: null,
            required_experience_months: null, certifications: [], applicant_count: 0,
          }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'closed' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    const calls = mockQuery.mock.calls.map(([sql]: [string]) => sql);
    // Specific to the entitlement lock (`FROM users ... FOR UPDATE`), not a
    // generic "FOR UPDATE" substring check -- the pre-read query always runs
    // and always carries its own "FOR UPDATE OF jobs" (fix: TOCTOU on status
    // change), which would otherwise make this assertion trivially true for
    // the wrong reason regardless of whether the entitlement gate ran.
    expect(calls.some((s: string) => s.includes('FROM users') && s.includes('FOR UPDATE'))).toBe(false);
    expect(calls.some((s: string) => s.includes('active_jobs'))).toBe(false);
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
  });

  it('does NOT apply entitlement gate when editing an already-active job to status active (no slot change)', async () => {
    // active→active: status is being set to 'active' but job is already 'active'.
    // The current-status fetch returns 'active', so the gate branch is skipped.
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('jobs.status') && !q.includes('UPDATE jobs')) {
        return Promise.resolve({ rows: [{ status: 'active' }] }); // already active
      }
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, title: 'Concrete Finisher', location: 'Columbus, OH',
            pay: null, job_type: 'contract', status: 'active', created_at: 'now',
            pay_min: null, pay_max: null, pay_interval: null, start_date: null,
            expected_duration: null, shift_schedule: null, transportation_required: false,
            work_authorization_required: false, language_preference: ['any'],
            number_of_workers_needed: 1, hired_count: 0, open_count: 1,
            trade_category: 'concrete', required_experience_years: null,
            required_experience_months: null, certifications: [], applicant_count: 0,
          }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));

    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    const calls = mockQuery.mock.calls.map(([sql]: [string]) => sql);
    // Specific to the entitlement lock (`FROM users ... FOR UPDATE`), not a
    // generic "FOR UPDATE" substring check -- the pre-read query always runs
    // and always carries its own "FOR UPDATE OF jobs" (fix: TOCTOU on status
    // change), which would otherwise make this assertion trivially true for
    // the wrong reason regardless of whether the entitlement gate ran.
    expect(calls.some((s: string) => s.includes('FROM users') && s.includes('FOR UPDATE'))).toBe(false);
    expect(calls.some((s: string) => s.includes('active_jobs'))).toBe(false);
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
  });

  it('returns 500 when resolveEntitlements throws billing_plan_catalog_invalid on paused→active', async () => {
    mockResolveEntitlements.mockRejectedValue(new Error('billing_plan_catalog_invalid'));
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT') && q.includes('jobs.status') && !q.includes('UPDATE jobs')) {
        return Promise.resolve({ rows: [{ status: 'paused' }] });
      }
      if (q.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  // ---------------------------------------------------------------------------
  // Field-edit path (no `status` in body)
  // ---------------------------------------------------------------------------

  const VALID_EDIT = {
    title: 'Framer',
    location: 'Austin, TX',
    job_type: 'full-time',
    trade_category: 'carpenter',
    pay_min: 25,
    pay_max: 35,
    number_of_workers_needed: 3,
    required_docs: ['resume'],
  };

  // Mock the current-job SELECT the edit path runs before UPDATE.
  function mockCurrentJob(over: Partial<{
    job_type: string; required_docs: string[]; optional_docs: string[];
    required_fields: string[]; optional_fields: string[];
    applicant_count: number; hired_count: number; city: string | null; state_region: string | null;
  }> = {}) {
    const row = {
      job_type: 'full-time', required_docs: ['resume'], optional_docs: [], required_fields: [], optional_fields: [],
      applicant_count: 0, hired_count: 0, city: null, state_region: null, ...over,
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT') && q.includes('applicant_count') && !q.includes('UPDATE jobs')) {
        return Promise.resolve({ rowCount: 1, rows: [row] });
      }
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: JOB_ID, ...VALID_EDIT, status: 'active', hired_count: row.hired_count, open_count: 1, applicant_count: row.applicant_count }] });
      }
      return Promise.resolve({});
    });
  }

  it('edits descriptive fields and returns the updated job', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: JOB_ID, title: 'Framer' });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('includes city and state_region in the RETURNING clause and the response (fix: geo was dropped from the edit RETURNING list)', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT') && q.includes('applicant_count') && !q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ job_type: 'full-time', required_docs: ['resume'], applicant_count: 0, hired_count: 0, city: null, state_region: null }],
        });
      }
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ id: JOB_ID, ...VALID_EDIT, status: 'active', hired_count: 0, open_count: 1, applicant_count: 0, city: 'Austin', state_region: 'TX' }],
        });
      }
      return Promise.resolve({});
    });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.city).toBe('Austin');
    expect(body.state_region).toBe('TX');

    // Pin the SQL contract itself, not just the mock pass-through: the
    // RETURNING clause (not just the SET clause, which already writes these
    // columns) must project city/state_region back out, matching
    // employer-jobs-create.ts's RETURNING list.
    const updateCall = findUpdateCall();
    const returningClause = (updateCall![0] as string).split('RETURNING')[1];
    expect(returningClause).toMatch(/\bcity\b/);
    expect(returningClause).toMatch(/\bstate_region\b/);
  });

  // A-7 (T-A1 ride-along): 4000-char cap on `description`, enforced by
  // parseJobFields (infra/lambda/lib/job-fields.ts) -- this handler makes no
  // description-specific check of its own, so these two tests are the
  // endpoint-level proof that the shared validator's rejection reaches the
  // field-edit path unchanged.
  it('rejects an over-length (4001+ char) description with 400 invalid_description, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, description: 'A'.repeat(4001) }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_description' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('accepts a description at exactly the 4000-char boundary', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, description: 'A'.repeat(4000) }) }));
    expect(res.statusCode).toBe(200);
  });

  it('rejects invalid field values with 400', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, trade_category: 'astronaut' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_trade_category');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects job_type change when the job has applicants (409 field_locked)', async () => {
    mockCurrentJob({ applicant_count: 2, job_type: 'contract' }); // current is contract; edit sends full-time
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('field_locked');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rejects required_docs change when the job has applicants (409 field_locked)', async () => {
    mockCurrentJob({ applicant_count: 1, required_docs: ['resume', 'driver_license'] });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) })); // edit sends ['resume']
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('field_locked');
  });

  it('allows unchanged locked fields even with applicants', async () => {
    mockCurrentJob({ applicant_count: 5, job_type: 'full-time', required_docs: ['resume'] });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects openings below hired count (409 openings_below_hired)', async () => {
    mockCurrentJob({ hired_count: 4 });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, number_of_workers_needed: 2 }) }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('openings_below_hired');
  });

  it('returns 403 when the employer does not own the job', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT') && q.includes('applicant_count') && !q.includes('UPDATE jobs')) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      return Promise.resolve({});
    });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  // ---------------------------------------------------------------------------
  // Field-edit path — city triple + coordinates
  // ---------------------------------------------------------------------------
  //
  // EDITABLE_COLUMNS positional layout (0-based param array index), post
  // Stage 1a shift (optional_docs/required_fields/optional_fields inserted
  // next to required_docs):
  //   23 city_key, 24 city, 25 state, 26 state_region.
  // BE-T2 appended six more columns (27-32: trade_category_other,
  // expected_duration_bucket, work_days, shift_start, shift_end,
  // certification_requirements) at the END of EDITABLE_COLUMNS, so these
  // indices are undisturbed; WHERE id is now bind $34 (i.e. params[33] once
  // the trailing jobId is appended).

  function findUpdateCall() {
    return mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('UPDATE jobs SET'));
  }

  it('returns the public listing fields on a field edit so the detail page can setJob(updated)', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const updateCall = findUpdateCall()!;
    expect(updateCall[0]).toContain('public_code');
    expect(updateCall[0]).toContain('public_listing_enabled');
  });

  it('updates the city triple on a field edit', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({
      ...VALID_EDIT, city_key: 'austin-tx', city: 'Austin', state: 'TX',
    }) }));
    expect(res.statusCode).toBe(200);
    const updateCall = findUpdateCall()!;
    expect(updateCall[0]).toContain('city_key');
    expect(updateCall[1]).toEqual(expect.arrayContaining(['austin-tx', 'Austin', 'TX']));
  });

  it('clears the matching-identity triple when a field edit omits it and the location is unparseable, but preserves the shared city column', async () => {
    // mockCurrentJob() defaults city/state_region to null, so "preserve cur.city"
    // and "null" are the same value here -- see the dedicated preserve-on-update
    // test below (in the city/state_region recompute section) for a case where
    // cur.city is non-null and the preserve behavior is actually observable.
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, location: 'Near the old stadium' }) }));
    expect(res.statusCode).toBe(200);
    const updateCall = findUpdateCall()!;
    expect(updateCall[0]).toContain('city_key');
    // params for city_key/city/state/state_region must be null — pinned positionally:
    expect(updateCall[1].slice(23, 27)).toEqual([null, null, null, null]);
  });

  it('derives the matching-identity triple from parseable location text when a field edit omits the triple', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, location: 'El Paso, TX 79912' }) }));
    expect(res.statusCode).toBe(200);
    const updateCall = findUpdateCall()!;
    // The city-triple parser (city-fields.ts parseCityFromLocation) accepts a
    // ZIP suffix and derives the full triple. The separate SEO parser
    // (job-location-parse.ts) does NOT accept a ZIP suffix on "City, ST" and
    // returns null for this same string, so state_region falls back to the
    // (here, null) stored value -- an intentional asymmetry between the two
    // location parsers under the merged doctrine.
    expect(updateCall[1].slice(23, 27)).toEqual(['el-paso-tx', 'El Paso', 'TX', null]);
  });

  it('a picker triple wins over the location text parse on edit', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({
      ...VALID_EDIT, location: 'El Paso, TX',
      city_key: 'austin-tx', city: 'Austin', state: 'TX',
    }) }));
    expect(res.statusCode).toBe(200);
    const updateCall = findUpdateCall()!;
    // state_region still derives from the SEO parser's read of `location`
    // ("El Paso, TX" -> TX), independently of the picker triple overriding
    // city_key/city/state to Austin.
    expect(updateCall[1].slice(23, 27)).toEqual(['austin-tx', 'Austin', 'TX', 'TX']);
  });

  it('rejects a mismatched city_key on edit (400)', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({
      ...VALID_EDIT, city_key: 'austin-tx', city: 'El Paso', state: 'TX',
    }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_city_key');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('stores coordinates on a field edit when both are provided', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, latitude: 30.27, longitude: -97.74 }) }));
    expect(res.statusCode).toBe(200);
    expect(mockSetJobCoordinates).toHaveBeenCalledWith(expect.anything(), JOB_ID, 30.27, -97.74, 'manual');
  });

  it('does not set coordinates when none are provided', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    expect(mockSetJobCoordinates).not.toHaveBeenCalled();
  });

  it('rejects a field edit with only one coordinate (400)', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, latitude: 30.27 }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_coordinates');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range latitude on a field edit (400)', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, latitude: 91, longitude: -97.74 }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_latitude');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range longitude on a field edit (400)', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, latitude: 30.27, longitude: 181 }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_longitude');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rolls back the whole edit when storing coordinates fails', async () => {
    mockCurrentJob();
    mockSetJobCoordinates.mockRejectedValueOnce(new Error('invalid_latitude'));
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, latitude: 30.27, longitude: -97.74 }) }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  // ---------------------------------------------------------------------------
  // Field-edit path -- city/state_region recompute (SEO channel)
  // ---------------------------------------------------------------------------

  it('recomputes city/state_region from location on every field edit', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, location: 'El Paso, TX' }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[24]).toBe('El Paso');
    expect(params[26]).toBe('TX');
  });

  it('explicit city/state_region body fields win over the parsed location when no triple or derivable location-city is present', async () => {
    mockCurrentJob();
    // `location: 'Austin'` (no comma/state) is unparseable by the city-triple
    // parser (parseCityFromLocation requires "City, ST"), so cityTriple is
    // null here and the shared `city` column falls through to the SEO
    // resolver's explicit-override value below, rather than being derived
    // from the location text (see the picker-triple-wins test above for the
    // case where a derivable triple DOES take priority over an explicit `city`).
    const res = await handler(makeEvent({
      body: JSON.stringify({ ...VALID_EDIT, location: 'Austin', city: 'North Austin', state_region: 'ok' }),
    }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[23]).toBeNull();
    expect(params[24]).toBe('North Austin');
    expect(params[25]).toBeNull();
    expect(params[26]).toBe('OK');
  });

  it('preserves the existing city/state_region when the new location is unparseable and no explicit override is given', async () => {
    mockCurrentJob({ city: 'El Paso', state_region: 'TX' });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, location: '79928' }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    // A bare ZIP never parses -- the pre-existing shared `city`/state_region
    // must survive this edit rather than being nulled out just because
    // location changed. The matching-identity fields (city_key/state) DO
    // reset to null regardless -- that asymmetry is deliberate (see the
    // handler's inline comment) so a stale key never keeps matching feeds.
    expect(params[23]).toBeNull();
    expect(params[24]).toBe('El Paso');
    expect(params[25]).toBeNull();
    expect(params[26]).toBe('TX');
  });

  it('rejects an invalid explicit city on field edit, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, city: '   ' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_city');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit state_region on field edit, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, state_region: 'Texas' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_state_region');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects a state_region that is not a real USPS code even though it matches the 2-letter shape', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, state_region: 'ZZ' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_state_region');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('an explicit null city clears it to NULL -- and also suppresses the city_key/state derive -- even though the job already has a stored city', async () => {
    mockCurrentJob({ city: 'El Paso', state_region: 'TX' });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, location: 'Austin, TX', city: null }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    // city_key/state are also null: cityCleared suppresses the derive
    // entirely, so a deliberately cleared city can never resurrect as a
    // matching city_key (merged doctrine).
    expect(params[23]).toBeNull();
    // city is NULL (cleared) despite both a parseable location ("Austin") and
    // a pre-existing stored value ("El Paso") that the old fallback-to-cur
    // behavior would otherwise have preserved.
    expect(params[24]).toBeNull();
    expect(params[25]).toBeNull();
    expect(params[26]).toBe('TX');
  });

  it('an explicit null state_region clears it to NULL, even though the job already has a stored state_region', async () => {
    mockCurrentJob({ city: 'El Paso', state_region: 'TX' });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, location: 'Austin, TX', state_region: null }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    // Unlike an explicit `city: null`, a cleared state_region does not affect
    // the separate matching-identity triple: "Austin, TX" still derives a
    // full city_key/city/state via parseCityFromLocation.
    expect(params[23]).toBe('austin-tx');
    expect(params[24]).toBe('Austin');
    expect(params[25]).toBe('TX');
    expect(params[26]).toBeNull();
  });

  it('both city and state_region explicitly null clears both, ignoring both the parse and the stored values', async () => {
    mockCurrentJob({ city: 'El Paso', state_region: 'TX' });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, location: 'Austin, TX', city: null, state_region: null }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[23]).toBeNull();
    expect(params[24]).toBeNull();
    expect(params[25]).toBeNull();
    expect(params[26]).toBeNull();
  });

  it('an explicit empty-string city still 400s -- null clears, but empty string is never valid', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, city: '' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_city');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('never enqueues a visibility event from a field edit', async () => {
    mockCurrentJob();
    await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    const enqueued = mockQuery.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('enqueue_job_visibility_event'));
    expect(enqueued).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Field-edit path -- visibility PING (not transition) on content edits
  // ---------------------------------------------------------------------------
  //
  // A field edit never touches status or public_listing_enabled, so
  // enqueueVisibilityTransition (the status-branch / public-listing-toggle
  // mechanism) never fires here. Instead, editing an effectively-visible job's
  // content pings Google's Indexing API directly via enqueueVisibilityPing,
  // deduped against any already-pending 'published' row for the job.

  function mockFieldEditVisibility(opts: {
    status?: string;
    publicListingEnabled?: boolean;
    publicCode?: string | null;
    pendingRowCount?: number;
  } = {}) {
    const { status = 'active', publicListingEnabled = true, publicCode = 'PUB1', pendingRowCount = 0 } = opts;
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT') && q.includes('applicant_count') && !q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ job_type: 'full-time', required_docs: ['resume'], applicant_count: 0, hired_count: 0, city: null, state_region: null }],
        });
      }
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, ...VALID_EDIT, status, hired_count: 0, open_count: 1, applicant_count: 0,
            public_listing_enabled: publicListingEnabled, public_code: publicCode,
          }],
        });
      }
      if (q.includes('FROM job_visibility_events')) {
        return Promise.resolve({ rowCount: pendingRowCount, rows: pendingRowCount > 0 ? [{ '1': 1 }] : [] });
      }
      return Promise.resolve({});
    });
  }

  function findVisibilityPingCall() {
    return mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('enqueue_job_visibility_event'));
  }

  function findDedupeSelectCall() {
    return mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('FROM job_visibility_events'));
  }

  it('pings visibility exactly once when editing a visible (active, publicly-listed) job with no pending event', async () => {
    mockFieldEditVisibility({ status: 'active', publicListingEnabled: true, pendingRowCount: 0 });

    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));

    expect(res.statusCode).toBe(200);
    expect(findDedupeSelectCall()).toBeDefined();
    expect(findDedupeSelectCall()![0]).toContain("event_kind = 'published'");
    expect(findDedupeSelectCall()![0]).toContain("status = 'pending'");
    const pingCall = findVisibilityPingCall();
    expect(pingCall).toBeDefined();
    expect(pingCall![1]).toEqual([JOB_ID, 'PUB1', 'published']);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('does NOT ping visibility again when a published event is already pending for the job', async () => {
    mockFieldEditVisibility({ status: 'active', publicListingEnabled: true, pendingRowCount: 1 });

    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));

    expect(res.statusCode).toBe(200);
    expect(findDedupeSelectCall()).toBeDefined();
    expect(findVisibilityPingCall()).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('does NOT ping visibility (and skips the dedupe check) when editing a paused (non-active) job', async () => {
    mockFieldEditVisibility({ status: 'paused', publicListingEnabled: true });

    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));

    expect(res.statusCode).toBe(200);
    expect(findDedupeSelectCall()).toBeUndefined();
    expect(findVisibilityPingCall()).toBeUndefined();
  });

  it('does NOT ping visibility (and skips the dedupe check) when editing an active job that is not publicly listed', async () => {
    mockFieldEditVisibility({ status: 'active', publicListingEnabled: false });

    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));

    expect(res.statusCode).toBe(200);
    expect(findDedupeSelectCall()).toBeUndefined();
    expect(findVisibilityPingCall()).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Visibility-event hook -- status-branch transition matrix
  // ---------------------------------------------------------------------------

  function makeVisibilityQueryMock(opts: {
    currentStatus: string;
    publicListingEnabled: boolean;
    newStatus: string;
    publicCode?: string;
    activeJobs?: number;
  }) {
    const { currentStatus, publicListingEnabled, newStatus, publicCode = 'JOBCOD', activeJobs = 0 } = opts;
    return (q: string) => {
      // Same ordering fix as makeUpdateQueryMock above: the pre-read now has
      // its own "FOR UPDATE OF jobs", so it must be matched before the
      // generic entitlement-lock "FOR UPDATE" check.
      if (q.includes('SELECT') && q.includes('jobs.status') && !q.includes('UPDATE jobs')) {
        return Promise.resolve({ rows: [{ status: currentStatus, public_listing_enabled: publicListingEnabled, public_code: publicCode }] });
      }
      if (q.includes('FROM users') && q.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ id: 'user-uuid-1' }] });
      if (q.includes('COUNT(*)')) return Promise.resolve({ rows: [{ active_jobs: activeJobs }] });
      if (q.includes('UPDATE jobs')) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{
            id: JOB_ID, title: 'Concrete Finisher', location: 'Columbus, OH',
            pay: null, job_type: 'contract', status: newStatus, created_at: 'now',
            pay_min: null, pay_max: null, pay_interval: null, start_date: null,
            expected_duration: null, shift_schedule: null, transportation_required: false,
            work_authorization_required: false, language_preference: ['any'],
            number_of_workers_needed: 1, hired_count: 0, open_count: 1,
            trade_category: 'concrete', required_experience_years: null,
            required_experience_months: null, certifications: [], applicant_count: 0,
          }],
        });
      }
      return Promise.resolve({});
    };
  }

  function findVisibilityEnqueueCall() {
    return mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('enqueue_job_visibility_event'));
  }

  it("enqueues 'published' on paused->active while listed", async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10 });
    mockQuery.mockImplementation(makeVisibilityQueryMock({ currentStatus: 'paused', publicListingEnabled: true, newStatus: 'active' }));
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));
    expect(res.statusCode).toBe(200);
    const enqueueCall = findVisibilityEnqueueCall();
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall![1]).toEqual([JOB_ID, 'JOBCOD', 'published']);
  });

  it("enqueues 'removed' on active->paused while listed", async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({ currentStatus: 'active', publicListingEnabled: true, newStatus: 'paused' }));
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'paused' }) }));
    expect(res.statusCode).toBe(200);
    const enqueueCall = findVisibilityEnqueueCall();
    expect(enqueueCall![1]).toEqual([JOB_ID, 'JOBCOD', 'removed']);
  });

  it('does NOT enqueue on paused->active while NOT listed', async () => {
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10 });
    mockQuery.mockImplementation(makeVisibilityQueryMock({ currentStatus: 'paused', publicListingEnabled: false, newStatus: 'active' }));
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));
    expect(res.statusCode).toBe(200);
    expect(findVisibilityEnqueueCall()).toBeUndefined();
  });

  it('does NOT enqueue on active->active (already active, listed -- no transition)', async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({ currentStatus: 'active', publicListingEnabled: true, newStatus: 'active' }));
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));
    expect(res.statusCode).toBe(200);
    expect(findVisibilityEnqueueCall()).toBeUndefined();
  });

  it('does NOT enqueue on paused->closed even when listed (job was never effectively visible)', async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({ currentStatus: 'paused', publicListingEnabled: true, newStatus: 'closed' }));
    const res = await handler(makeEvent({ body: JSON.stringify({ status: 'closed' }) }));
    expect(res.statusCode).toBe(200);
    expect(findVisibilityEnqueueCall()).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // TOCTOU guard on the status-change pre-read
  // ---------------------------------------------------------------------------

  it('locks the pre-read row with FOR UPDATE OF jobs, so a concurrent status change cannot race the visibility-event decision', async () => {
    mockQuery.mockImplementation(makeVisibilityQueryMock({ currentStatus: 'paused', publicListingEnabled: true, newStatus: 'active' }));
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10 });
    await handler(makeEvent({ body: JSON.stringify({ status: 'active' }) }));
    const preReadCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('jobs.status') && !c[0].includes('UPDATE jobs'),
    );
    expect(preReadCall).toBeDefined();
    expect(preReadCall![0]).toContain('FOR UPDATE OF jobs');
  });

  // ---------------------------------------------------------------------------
  // Stage 1a -- optional_docs / required_fields / optional_fields
  // ---------------------------------------------------------------------------
  //
  // New EDITABLE_COLUMNS positional layout (0-based param array index), post
  // Stage 1a shift: 5 required_docs, 6 optional_docs, 7 required_fields,
  // 8 optional_fields, 16 work_authorization_required,
  // 23 city_key, 24 city, 25 state, 26 state_region.

  it('rejects an invalid required_fields entry on a field edit, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, required_fields: ['bogus'] }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_required_fields');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects an invalid optional_fields entry on a field edit, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, optional_fields: ['bogus'] }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_optional_fields');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects an invalid optional_docs entry on a field edit, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, optional_docs: ['bogus'] }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_optional_docs');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects overlapping required_fields/optional_fields on update with 400 requirements_tier_overlap', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({
      ...VALID_EDIT, required_fields: ['work_authorization'], optional_fields: ['work_authorization'],
    }) }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('requirements_tier_overlap');
    expect(body.keys).toEqual(['work_authorization']);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rejects overlapping required_docs/optional_docs on update with 400 requirements_tier_overlap', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({
      ...VALID_EDIT, required_docs: ['resume'], optional_docs: ['resume'],
    }) }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('requirements_tier_overlap');
    expect(body.keys).toEqual(['resume']);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rejects an overlap created against a PRESERVED optional_docs value (effective values, not just the raw body)', async () => {
    // optional_docs is omitted from the body -> preserved from cur (['resume']).
    // VALID_EDIT's required_docs (['resume']) now collides with that preserved
    // value -- proves the overlap check runs on effective post-merge values.
    mockCurrentJob({ optional_docs: ['resume'] });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('requirements_tier_overlap');
    expect(body.keys).toEqual(['resume']);
  });

  it('lists exactly optional_docs in 409 field_locked when only optional_docs changes with applicants', async () => {
    mockCurrentJob({ applicant_count: 1, optional_docs: ['driver_license'] });
    // VALID_EDIT's required_docs is ['resume'] -- pick a non-overlapping
    // optional_docs value (work_auth_doc) so this only exercises the freeze
    // check, not the (separately tested) tier-overlap rejection.
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, optional_docs: ['work_auth_doc'] }) }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('field_locked');
    expect(body.fields).toEqual(['optional_docs']);
  });

  it('lists exactly required_fields in 409 field_locked when only required_fields changes with applicants', async () => {
    mockCurrentJob({ applicant_count: 1, required_fields: ['date_available'] });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, required_fields: ['work_authorization'] }) }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('field_locked');
    expect(body.fields).toEqual(['required_fields']);
  });

  it('lists exactly optional_fields in 409 field_locked when only optional_fields changes with applicants', async () => {
    mockCurrentJob({ applicant_count: 1, optional_fields: ['education'] });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, optional_fields: ['references'] }) }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('field_locked');
    expect(body.fields).toEqual(['optional_fields']);
  });

  it('lists every locked field when required_docs, optional_docs, required_fields, optional_fields, and job_type all change with applicants', async () => {
    mockCurrentJob({
      applicant_count: 3, job_type: 'contract', required_docs: ['driver_license'],
      optional_docs: ['work_auth_doc'], required_fields: ['date_available'], optional_fields: ['education'],
    });
    const res = await handler(makeEvent({ body: JSON.stringify({
      ...VALID_EDIT, // job_type 'full-time' differs from cur 'contract'; required_docs ['resume'] differs
      optional_docs: ['certification_doc'], required_fields: ['work_authorization'], optional_fields: ['references'],
    }) }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('field_locked');
    expect(body.fields).toEqual(expect.arrayContaining(['required_docs', 'optional_docs', 'required_fields', 'optional_fields', 'job_type']));
    expect(body.fields).toHaveLength(5);
  });

  it('does NOT lock when the three new arrays are simply omitted from the body on a job with applicants (preserve-on-omit must not look like a change)', async () => {
    mockCurrentJob({ applicant_count: 2, optional_docs: ['driver_license'], required_fields: ['date_available'], optional_fields: ['education'] });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) })); // omits all three new keys
    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('preserves stored optional_docs when the body omits the key', async () => {
    mockCurrentJob({ optional_docs: ['driver_license'] });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[6]).toEqual(['driver_license']);
  });

  it('clears optional_docs when the body sends an explicit empty array', async () => {
    mockCurrentJob({ optional_docs: ['driver_license'] });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, optional_docs: [] }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[6]).toEqual([]);
  });

  it('preserves stored required_fields when the body omits the key', async () => {
    mockCurrentJob({ required_fields: ['date_available'] });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[7]).toEqual(['date_available']);
  });

  it('clears required_fields when the body sends an explicit empty array', async () => {
    mockCurrentJob({ required_fields: ['date_available'] });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, required_fields: [] }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[7]).toEqual([]);
  });

  it('preserves stored optional_fields when the body omits the key', async () => {
    mockCurrentJob({ optional_fields: ['education'] });
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[8]).toEqual(['education']);
  });

  it('clears optional_fields when the body sends an explicit empty array', async () => {
    mockCurrentJob({ optional_fields: ['education'] });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, optional_fields: [] }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[8]).toEqual([]);
  });

  it('required_docs keeps exact-replace semantics: omitting it clears to empty (regression -- unlike the new preserve-on-omit arrays)', async () => {
    mockCurrentJob({ required_docs: ['resume', 'driver_license'] });
    const { required_docs: _omit, ...editWithoutDocs } = VALID_EDIT as Record<string, unknown>;
    const res = await handler(makeEvent({ body: JSON.stringify(editWithoutDocs) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[5]).toEqual([]);
  });

  it('derives work_authorization_required=true from required_fields on update, overriding a false legacy flag', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, required_fields: ['work_authorization'], work_authorization_required: false }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[16]).toBe(true);
  });

  it('derives work_authorization_required=false on update when required_fields is present but excludes it, overriding a true legacy flag', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, required_fields: ['date_available'], work_authorization_required: true }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[16]).toBe(false);
  });

  it('keeps the legacy work_authorization_required flag on update when required_fields is absent from the body', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, work_authorization_required: true }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[16]).toBe(true);
  });

  it('does NOT resync work_authorization_required from a PRESERVED required_fields -- only a body-supplied required_fields owns the flag (deliberate, spec-directed asymmetry)', async () => {
    // Stored required_fields includes work_authorization, but the body omits
    // required_fields (so it's preserved) AND explicitly sends
    // work_authorization_required: false via the legacy flag. Per the
    // ownership rule, the legacy flag governs whenever required_fields is
    // absent from THIS body -- even though the effective (preserved)
    // required_fields still contains work_authorization. The row can end up
    // internally inconsistent (required_fields says required, the flag says
    // not) until the next edit that touches required_fields explicitly --
    // that's the documented tradeoff, not a bug.
    mockCurrentJob({ required_fields: ['work_authorization'] });
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, work_authorization_required: false }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[7]).toEqual(['work_authorization']); // required_fields: preserved as-is
    expect(params[16]).toBe(false); // work_authorization_required: legacy flag wins
  });

  it('required_docs 409 field_locked still fires when required_docs is omitted (exact-replace clears it) on a job with applicants', async () => {
    mockCurrentJob({ applicant_count: 1, required_docs: ['resume', 'driver_license'] });
    const { required_docs: _omit, ...editWithoutDocs } = VALID_EDIT as Record<string, unknown>;
    const res = await handler(makeEvent({ body: JSON.stringify(editWithoutDocs) }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('field_locked');
    expect(body.fields).toEqual(['required_docs']);
  });

  // ---------------------------------------------------------------------------
  // BE-T2 -- six new structured fields (077), field-edit path
  // ---------------------------------------------------------------------------
  //
  // The six new columns are appended at the END of EDITABLE_COLUMNS (indices
  // 27-32: trade_category_other, expected_duration_bucket, work_days,
  // shift_start, shift_end, certification_requirements), so every
  // pre-existing positional index above (5, 6, 7, 8, 16, 23-26) is
  // undisturbed.

  it('a legacy field edit with none of the six new keys still 200s, six params null', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params.slice(27, 33)).toEqual([null, null, null, null, null, null]);
  });

  it('threads all six new fields through UPDATE and RETURNING', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({
      body: JSON.stringify({
        ...VALID_EDIT,
        trade_category: 'other',
        trade_category_other: 'Scaffolding',
        expected_duration_bucket: '1_2w',
        work_days: ['mon', 'tue'],
        shift_start: '07:00',
        shift_end: '15:30',
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      }),
    }));
    expect(res.statusCode).toBe(200);

    const updateCall = findUpdateCall()!;
    expect(updateCall[0]).toContain('trade_category_other');
    expect(updateCall[0]).toContain('expected_duration_bucket');
    expect(updateCall[0]).toContain('work_days');
    expect(updateCall[0]).toContain('shift_start');
    expect(updateCall[0]).toContain('shift_end');
    expect(updateCall[0]).toContain('certification_requirements');
    const returningClause = (updateCall[0] as string).split('RETURNING')[1];
    expect(returningClause).toMatch(/\btrade_category_other\b/);
    expect(returningClause).toMatch(/\bexpected_duration_bucket\b/);
    expect(returningClause).toMatch(/\bwork_days\b/);
    expect(returningClause).toMatch(/\bshift_start\b/);
    expect(returningClause).toMatch(/\bshift_end\b/);
    expect(returningClause).toMatch(/\bcertification_requirements\b/);

    const params = updateCall[1] as unknown[];
    expect(params[27]).toBe('Scaffolding');
    expect(params[28]).toBe('1_2w');
    expect(params[29]).toEqual(['mon', 'tue']);
    expect(params[30]).toBe('07:00');
    expect(params[31]).toBe('15:30');
    expect(params[32]).toBe(JSON.stringify([{ name: 'OSHA 30', tier: 'required', proof_required: true }]));
  });

  it('pins the shift_start/shift_end/certification_requirements casts in the generated UPDATE SQL (::time / ::jsonb)', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({
      body: JSON.stringify({
        ...VALID_EDIT,
        shift_start: '07:00',
        shift_end: '15:30',
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      }),
    }));
    expect(res.statusCode).toBe(200);
    const updateCall = findUpdateCall()!;
    const setClause = (updateCall[0] as string).split('SET')[1].split('WHERE')[0];
    expect(setClause).toMatch(/shift_start = \$\d+::time/);
    expect(setClause).toMatch(/shift_end = \$\d+::time/);
    expect(setClause).toMatch(/certification_requirements = \$\d+::jsonb/);
  });

  it('passes a real SQL NULL (not the string "null") for certification_requirements when absent', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[32]).toBeNull();
  });

  it('passes the JSON string "[]" (not null) for certification_requirements when an explicit empty array is sent', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, certification_requirements: [] }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[32]).toBe('[]');
  });

  it("rejects a trade_category_other sent for a non-'other' trade_category on a field edit, before opening a DB connection", async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, trade_category_other: 'Scaffolding' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_trade_category_other' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects a malformed shift_end on a field edit, before opening a DB connection', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, shift_end: '9:00' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_shift_end');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('rejects certification_requirements conflicting with an explicitly-sent required_docs certification_doc, before opening a DB connection', async () => {
    const res = await handler(makeEvent({
      body: JSON.stringify({
        ...VALID_EDIT,
        required_docs: ['certification_doc'],
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      }),
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_certification_requirements_doc_conflict' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('derives certifications from certification_requirements names on update, ignoring a stale client-supplied certifications value', async () => {
    mockCurrentJob();
    const res = await handler(makeEvent({
      body: JSON.stringify({
        ...VALID_EDIT,
        certifications: ['Stale Legacy Cert'],
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      }),
    }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    // certifications is param index 22 (0-based), unchanged position.
    expect(params[22]).toEqual(['OSHA 30']);
  });

  // The critical preserve-on-omit gap: parseJobFields' doc-conflict check can
  // only see the RAW request body, not the EFFECTIVE (post preserve-on-omit
  // merge) optional_docs computed from `cur` below. A PATCH that sets
  // certification_requirements while omitting optional_docs entirely must
  // still be caught if the job's STORED optional_docs already contains
  // certification_doc -- otherwise the per-cert-proof feature would silently
  // coexist with the single certification_doc gate it's supposed to replace.
  it('rejects when certification_requirements is set and the job\'s PRESERVED (omitted-from-body) optional_docs already contains certification_doc', async () => {
    mockCurrentJob({ optional_docs: ['certification_doc'] });
    const res = await handler(makeEvent({
      body: JSON.stringify({
        ...VALID_EDIT, // omits optional_docs entirely -> preserved from cur
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      }),
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_certification_requirements_doc_conflict' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('does NOT conflict when optional_docs is preserved but contains no certification_doc', async () => {
    mockCurrentJob({ optional_docs: ['driver_license'] });
    const res = await handler(makeEvent({
      body: JSON.stringify({
        ...VALID_EDIT,
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      }),
    }));
    expect(res.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  // ---------------------------------------------------------------------------
  // BE-T2 cross-slice addendum: full-row-write, absent -> NULL (never
  // preserve-on-omit) for the six new columns. 077's CHECK constraints are
  // one-way BECAUSE this handler writes the full row on every PATCH (see that
  // migration's header) -- the six new columns are NOT read from `cur` at
  // all (unlike optional_docs/required_fields/optional_fields), so a PATCH
  // that omits one of them always writes NULL, never the stored value.
  // ---------------------------------------------------------------------------

  it("clears trade_category_other to NULL when trade_category changes away from 'other' without resending trade_category_other -- full-row-write must not preserve the stale text and trip jobs_trade_category_other_valid", async () => {
    // The job's stored trade_category_other is irrelevant here (never read by
    // this handler) -- the point is that an edit switching to a non-'other'
    // category, with no trade_category_other in the body, is a normal 200,
    // not a 500 from a preserved value violating the one-way CHECK.
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify({ ...VALID_EDIT, trade_category: 'electrician' }) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params[19]).toBe('electrician'); // trade_category (unchanged position)
    expect(params[27]).toBeNull(); // trade_category_other: full-row-write clears it
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('writes all six new columns as NULL on a legacy-only edit of an already-structured job (deliberate full-row-write, not preserve-on-omit)', async () => {
    // Unlike optional_docs/required_fields/optional_fields, the six new
    // columns are never read from `cur`, so this holds regardless of what
    // the job currently has stored -- the mock doesn't even need to model a
    // prior structured value to prove it.
    mockCurrentJob();
    const res = await handler(makeEvent({ body: JSON.stringify(VALID_EDIT) }));
    expect(res.statusCode).toBe(200);
    const params = findUpdateCall()![1] as unknown[];
    expect(params.slice(27, 33)).toEqual([null, null, null, null, null, null]);
  });
});
