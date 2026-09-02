import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/public-job';
import { getPublicJobsDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetPublicJobsDbPool = getPublicJobsDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ACTIVE_JOB_ROW = {
  id: 'job-uuid',
  code: 'ABC123',
  title: 'Warehouse Associate',
  company: 'Acme Co',
  location: 'Miami, FL',
  city: 'Miami',
  state_region: 'FL',
  job_type: 'full_time',
  description: 'Lift boxes',
  pay: 20,
  pay_min: 18,
  pay_max: 22,
  pay_interval: 'hourly',
  start_date: null,
  expected_duration: null,
  shift_schedule: null,
  trade_category: null,
  required_experience_years: null,
  required_experience_months: null,
  certifications: null,
  language_preference: null,
  transportation_required: false,
  work_authorization_required: false,
  number_of_workers_needed: 2,
  required_docs: [],
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('public-job Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetPublicJobsDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  const makeEvent = (opts: {
    code?: string;
    headers?: Record<string, string>;
    ip?: string;
  }): APIGatewayProxyEvent =>
    ({
      pathParameters: opts.code !== undefined ? { code: opts.code } : null,
      queryStringParameters: null,
      headers: opts.headers ?? {},
      requestContext: { identity: { sourceIp: opts.ip ?? '1.2.3.4' } },
    }) as unknown as APIGatewayProxyEvent;

  it('returns 400 when code is missing', async () => {
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_code');
  });

  it('returns 400 when code fails validation', async () => {
    const res = await handler(makeEvent({ code: '!!!' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_code');
  });

  it('returns 404 for an unknown code', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // job lookup
    const res = await handler(makeEvent({ code: 'ZZZZZZ' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('is indistinguishable from unknown when the employer opted out (RLS hides the row)', async () => {
    // The RLS policy jobs_public_read filters on public_listing_enabled, so an
    // opted-out job simply never appears in the result set -- same zero-row
    // path as a code that never existed.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  it('returns the full public projection for an active job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }); // job lookup only -- company present
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('ABC123');
    expect(body.title).toBe('Warehouse Associate');
    expect(body.status).toBe('active');
    // `id` IS returned for an active job -- it's what lets the post-signup
    // redirect land on /worker/jobs/{id} with no new lookup endpoint.
    expect(body.id).toBe('job-uuid');
    expect(body.employer_id).toBeUndefined();
    // city/state_region (migration 061's column-scoped grant) are selected
    // and returned for schema.org jobLocation on the public job page.
    expect(body.city).toBe('Miami');
    expect(body.state_region).toBe('FL');
  });

  it('selects city and state_region in the job lookup query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }); // job lookup only
    await handler(makeEvent({ code: 'ABC123' }));
    const jobLookupCall = mockQuery.mock.calls[0];
    expect(jobLookupCall[0]).toMatch(/\bcity\b/);
    expect(jobLookupCall[0]).toMatch(/\bstate_region\b/);
  });

  // ---------------------------------------------------------------------------
  // BE-T2 -- six new structured fields (077)
  // ---------------------------------------------------------------------------

  it('selects all six BE-T2 structured columns in the job lookup query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] });
    await handler(makeEvent({ code: 'ABC123' }));
    const jobLookupCall = mockQuery.mock.calls[0];
    expect(jobLookupCall[0]).toMatch(/\btrade_category_other\b/);
    expect(jobLookupCall[0]).toMatch(/\bexpected_duration_bucket\b/);
    expect(jobLookupCall[0]).toMatch(/\bwork_days\b/);
    expect(jobLookupCall[0]).toMatch(/\bshift_start\b/);
    expect(jobLookupCall[0]).toMatch(/\bshift_end\b/);
    expect(jobLookupCall[0]).toMatch(/\bcertification_requirements\b/);
  });

  it('returns null passthrough for the six BE-T2 columns on a legacy row that predates them', async () => {
    // A legacy row's SELECT returns these columns as SQL NULL -- the driver
    // surfaces them as JS null (not undefined), and the handler does no
    // extra normalization: nullable passthrough, straight from the row.
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...ACTIVE_JOB_ROW,
        trade_category_other: null,
        expected_duration_bucket: null,
        work_days: null,
        shift_start: null,
        shift_end: null,
        certification_requirements: null,
      }],
    });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trade_category_other).toBeNull();
    expect(body.expected_duration_bucket).toBeNull();
    expect(body.work_days).toBeNull();
    expect(body.shift_start).toBeNull();
    expect(body.shift_end).toBeNull();
    expect(body.certification_requirements).toBeNull();
  });

  it('passes through populated values for the six BE-T2 columns', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...ACTIVE_JOB_ROW,
        trade_category: 'other',
        trade_category_other: 'Scaffolding',
        expected_duration_bucket: '1_2w',
        work_days: ['mon', 'tue'],
        shift_start: '07:00:00',
        shift_end: '15:30:00',
        certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
      }],
    });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trade_category_other).toBe('Scaffolding');
    expect(body.expected_duration_bucket).toBe('1_2w');
    expect(body.work_days).toEqual(['mon', 'tue']);
    expect(body.shift_start).toBe('07:00:00');
    expect(body.shift_end).toBe('15:30:00');
    expect(body.certification_requirements).toEqual([{ name: 'OSHA 30', tier: 'required', proof_required: true }]);
  });

  it('does NOT include the six BE-T2 columns in the closed-job minimal view', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ACTIVE_JOB_ROW, status: 'filled', trade_category_other: 'Scaffolding' }],
    });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      code: 'ABC123',
      title: 'Warehouse Associate',
      company: 'Acme Co',
      location: 'Miami, FL',
      status: 'closed',
      applications_closed: true,
    });
  });

  it('returns the minimal closed view for a non-active job, not a 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ACTIVE_JOB_ROW, status: 'filled' }] });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      code: 'ABC123',
      title: 'Warehouse Associate',
      company: 'Acme Co',
      location: 'Miami, FL',
      status: 'closed',
      applications_closed: true,
    });
    // The closed view must NOT gain `id` -- only the active branch includes it.
    expect(body.id).toBeUndefined();
  });

  describe('company fallback', () => {
    it('does not query public_job_company when the job row already has a company', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }); // company: 'Acme Co'
      const res = await handler(makeEvent({ code: 'ABC123' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).company).toBe('Acme Co');
      // Only the single job lookup query -- no extra round trip.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('calls public_job_company and merges the result when the job row has a null company', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ ...ACTIVE_JOB_ROW, company: null }] }) // job lookup
        .mockResolvedValueOnce({ rows: [{ company: 'Fallback Inc' }] }); // public_job_company
      const res = await handler(makeEvent({ code: 'ABC123' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).company).toBe('Fallback Inc');

      const fallbackCall = mockQuery.mock.calls[1];
      expect(fallbackCall[0]).toMatch(/public_job_company/);
      expect(fallbackCall[1]).toEqual(['job-uuid']);
    });

    it('leaves company null when public_job_company itself returns null', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ ...ACTIVE_JOB_ROW, company: null }] })
        .mockResolvedValueOnce({ rows: [{ company: null }] });
      const res = await handler(makeEvent({ code: 'ABC123' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).company).toBeNull();
    });

    it('also applies the fallback to the closed-job minimal view', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ ...ACTIVE_JOB_ROW, status: 'filled', company: null }] })
        .mockResolvedValueOnce({ rows: [{ company: 'Fallback Inc' }] });
      const res = await handler(makeEvent({ code: 'ABC123' }));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('closed');
      expect(body.company).toBe('Fallback Inc');
    });
  });

  // ---------------------------------------------------------------------------
  // pre_application_prompts (091)
  // ---------------------------------------------------------------------------

  it('selects pre_application_prompts (091 grants it to jale_public_jobs) and never employer_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] });
    await handler(makeEvent({ code: 'ABC123' }));
    const jobLookupCall = mockQuery.mock.calls[0];
    expect(jobLookupCall[0]).toMatch(/\bpre_application_prompts\b/);
    // The column-scoped GRANT is the access control here, not handler
    // discipline -- but employer_id has never been in it and must not appear.
    expect(jobLookupCall[0]).not.toMatch(/\bemployer_id\b/);
  });

  it('returns the parsed prompt list for an active job', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ACTIVE_JOB_ROW, pre_application_prompts: [{ id: 'p1', text: '  Do you own tools?  ' }] }],
    });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(JSON.parse(res.body).pre_application_prompts).toEqual([{ id: 'p1', text: 'Do you own tools?' }]);
  });

  it('degrades a corrupt stored prompt list to [] instead of 500-ing the public page', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ACTIVE_JOB_ROW, pre_application_prompts: [{ id: 'ok', text: 'A' }, 'garbage', { text: 'no id' }] }],
    });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).pre_application_prompts).toEqual([{ id: 'ok', text: 'A' }]);
  });

  it('omits pre_application_prompts from the closed-job minimal view', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ACTIVE_JOB_ROW, status: 'filled', pre_application_prompts: [{ id: 'p1', text: 'A' }] }],
    });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(JSON.parse(res.body).pre_application_prompts).toBeUndefined();
  });
});
