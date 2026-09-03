import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-jobs-detail';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const baseEvent = {
  requestContext: { authorizer: { claims: { sub: 'worker-sub-1' } } },
  pathParameters: { jobId: 'job-1' },
} as unknown as APIGatewayProxyEvent;

describe('worker-jobs-detail', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 404 if job not found (RLS-filtered)', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(404);
  });

  it('returns job with missing_docs computed from worker_documents', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: ['resume', 'driver_license'], created_at: 'ts', company_name: 'Acme' };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [{ doc_type: 'resume' }] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.missing_docs).toEqual(['driver_license']);
    expect(body.already_applied).toBe(false);
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-id');
    const docsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM worker_documents'))?.[0];
    expect(docsSql).toContain('AND (job_id IS NULL OR job_id = $3::uuid)');
  });

  it('returns already_applied=true when application exists', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: [], created_at: 'ts', company_name: 'Acme' };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ status: 'pending' }] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    const body = JSON.parse(res.body);
    expect(body.already_applied).toBe(true);
    expect(body.application_status).toBe('pending');
  });

  it('exposes public_listing_enabled on the job detail response', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: [], created_at: 'ts', company_name: 'Acme', public_listing_enabled: true };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.public_listing_enabled).toBe(true);
    const jobsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs'))?.[0];
    expect(jobsSql).toContain('public_listing_enabled');
  });

  it('exposes city_key on the job detail response', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: [], created_at: 'ts', company_name: 'Acme', city_key: 'austin-tx' };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.city_key).toBe('austin-tx');
    const jobsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs'))?.[0];
    expect(jobsSql).toContain('j.city_key');
  });

  it('exposes the six 077 structured fields on the job detail response (apply flow reads certification_requirements from here)', async () => {
    // Regression pin for an integration gap caught in adversarial review: the
    // apply flow's certification-claims step and the structured facts rows
    // source these fields EXCLUSIVELY from this endpoint. Omitting them from
    // the SELECT made every required-tier certification job un-applyable
    // (backend gate fires, UI never prompts for claims).
    const certReqs = [{ name: 'OSHA 30', tier: 'required', proof_required: true }];
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: [], created_at: 'ts', company_name: 'Acme',
                  trade_category_other: 'Welder', expected_duration_bucket: '1_3m',
                  work_days: ['mon', 'wed'], shift_start: '07:00:00', shift_end: '16:00:00',
                  certification_requirements: certReqs };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trade_category_other).toBe('Welder');
    expect(body.expected_duration_bucket).toBe('1_3m');
    expect(body.work_days).toEqual(['mon', 'wed']);
    expect(body.shift_start).toBe('07:00:00');
    expect(body.shift_end).toBe('16:00:00');
    expect(body.certification_requirements).toEqual(certReqs);
    const jobsSql = String(mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs'))?.[0]);
    for (const col of ['j.trade_category_other', 'j.expected_duration_bucket', 'j.work_days', 'j.shift_start', 'j.shift_end', 'j.certification_requirements']) {
      expect(jobsSql).toContain(col);
    }
  });

  it('normalizes nullable required_docs for the frontend contract', async () => {
    const job = {
      id: 'job-1',
      title: 'T',
      location: 'L',
      job_type: 'full-time',
      description: 'D',
      required_docs: null,
      created_at: 'ts',
      company_name: 'Acme',
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.required_docs).toEqual([]);
    expect(body.missing_docs).toEqual([]);
  });

  it('passes a non-active status through the 200 body and coalesces paused in SQL', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: [], created_at: 'ts', company_name: 'Acme', status: 'closed' };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ status: 'pending' }] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('closed');
    expect(body.already_applied).toBe(true);

    const jobsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs'))?.[0] as string;
    // paused is billing-private: the API must never emit it to a worker.
    expect(jobsSql).toContain("CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS status");
    // Company name via the 031 definer function; the users join is dead under
    // worker RLS (no policy grants employer-row reads) and must be gone.
    expect(jobsSql).toContain('employer_display_name(j.employer_id) AS company_name');
    expect(jobsSql).not.toContain('JOIN users');
  });

  it('exposes required_fields/optional_fields/optional_docs and computes unanswered lists before applying', async () => {
    const job = {
      id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
      required_docs: [], created_at: 'ts', company_name: 'Acme',
      required_fields: ['work_authorization'], optional_fields: ['date_available'], optional_docs: ['driver_license'],
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.required_fields).toEqual(['work_authorization']);
    expect(body.optional_fields).toEqual(['date_available']);
    expect(body.optional_docs).toEqual(['driver_license']);
    // Nothing answered yet (not applied) -- everything required/optional is unanswered.
    expect(body.missing_fields).toEqual(['work_authorization']);
    // 091: optional_unanswered is now optionalFields U missing optional DOCS
    // (the engine's remaining.optionalFields U optionalDocs), so a skipped
    // optional upload is reported the same way a skipped optional field is.
    expect(body.optional_unanswered).toEqual(['date_available', 'driver_license']);
  });

  it('computes missing_fields/optional_unanswered from the stored application_answers when already applied', async () => {
    const job = {
      id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
      required_docs: [], created_at: 'ts', company_name: 'Acme',
      required_fields: ['work_authorization', 'date_available'], optional_fields: ['home_address'], optional_docs: [],
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) {
        return Promise.resolve({ rows: [{ status: 'pending', application_answers: { work_authorization: true } }] });
      }
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.already_applied).toBe(true);
    expect(body.missing_fields).toEqual(['date_available']);
    expect(body.optional_unanswered).toEqual(['home_address']);
    // v1 write-once contract: never leak the raw answers, only derived key lists.
    expect(body.application_answers).toBeUndefined();
  });

  it('normalizes nullable required_fields/optional_fields/optional_docs for the frontend contract', async () => {
    const job = {
      id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
      required_docs: null, created_at: 'ts', company_name: 'Acme',
      required_fields: null, optional_fields: null, optional_docs: null,
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.required_fields).toEqual([]);
    expect(body.optional_fields).toEqual([]);
    expect(body.optional_docs).toEqual([]);
    expect(body.missing_fields).toEqual([]);
    expect(body.optional_unanswered).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Application stages (091)
  // ---------------------------------------------------------------------------

  describe('application stages (091)', () => {
    const JOB = {
      id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
      created_at: 'ts', company_name: 'Acme',
      required_docs: ['resume'], optional_docs: [],
      required_fields: ['work_authorization'], optional_fields: [],
      certification_requirements: null,
      pre_application_prompts: [{ id: 'p1', text: 'Do you own tools?' }],
    };

    function mockRun(over: {
      job?: Record<string, unknown>;
      docs?: Array<Record<string, unknown>>;
      application?: Record<string, unknown> | null;
    } = {}) {
      const { job = {}, docs = [], application = null } = over;
      mockQuery.mockImplementation((q: string) => {
        if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
        if (q.includes('FROM jobs')) return Promise.resolve({ rows: [{ ...JOB, ...job }] });
        if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: docs });
        if (q.includes('FROM job_applications')) return Promise.resolve({ rows: application ? [application] : [] });
        return Promise.resolve({});
      });
    }

    async function body(over = {}) {
      mockRun(over);
      const res = await handler(baseEvent);
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body);
    }

    it('selects pre_application_prompts and returns the parsed list', async () => {
      const b = await body();
      expect(b.pre_application_prompts).toEqual([{ id: 'p1', text: 'Do you own tools?' }]);
      const jobsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs'))?.[0] as string;
      expect(jobsSql).toContain('j.pre_application_prompts');
    });

    it('adds no stage keys at all before the worker has applied', async () => {
      const b = await body();
      expect(b.already_applied).toBe(false);
      expect(b.application_id).toBeUndefined();
      expect(b.details_status).toBeUndefined();
      expect(b.stage).toBeUndefined();
      expect(b.remaining).toBeUndefined();
      // The three legacy keys stay populated pre-apply, exactly as before.
      expect(b.missing_docs).toEqual(['resume']);
      expect(b.missing_fields).toEqual(['work_authorization']);
    });

    it('adds the stage keys once an application exists', async () => {
      const b = await body({
        docs: [{ doc_type: 'resume', job_scoped: true }],
        application: {
          application_id: 'app-1', status: 'details_requested',
          application_answers: {}, prompt_answers: { p1: 'Yes' },
          details_requested_at: '2026-09-01T00:00:00Z', details_completed_at: null,
        },
      });
      expect(b.application_id).toBe('app-1');
      expect(b.application_status).toBe('details_requested');
      expect(b.details_status).toBe('requested');
      expect(b.stage).toBe('details');
      expect(b.remaining).toEqual({
        prompts: [],
        fields: ['work_authorization'],
        certifications: { unclaimed: [], unproven: [] },
        docs: [],
        counts: { prompts: 0, fields: 1, certifications: 0, docs: 0 },
        complete: false,
      });
    });

    it('reports outstanding prompts on an apply-stage application', async () => {
      const b = await body({
        application: {
          application_id: 'app-1', status: 'pending',
          application_answers: {}, prompt_answers: {},
          details_requested_at: null, details_completed_at: null,
        },
      });
      expect(b.details_status).toBe('not_requested');
      expect(b.stage).toBe('apply');
      expect(b.remaining.prompts).toEqual(['p1']);
    });

    it('never leaks the raw prompt answers to the worker', async () => {
      const b = await body({
        application: {
          application_id: 'app-1', status: 'pending',
          application_answers: { work_authorization: true }, prompt_answers: { p1: 'Yes' },
          details_requested_at: null, details_completed_at: null,
        },
      });
      expect(b.application_answers).toBeUndefined();
      expect(b.prompt_answers).toBeUndefined();
    });

    // ── The two doc scopes ────────────────────────────────────────────────
    // `remaining` must agree with the EMPLOYER's view (job-scoped), while
    // `missing_docs` keeps answering the worker's own question ("do I still
    // need to upload this?"), which vault rows DO satisfy. Same probe, two
    // sets -- otherwise every vault-holding worker would be told to re-upload.

    it('keeps missing_docs on the vault-or-job set while remaining.docs stays job-scoped', async () => {
      const b = await body({
        docs: [{ doc_type: 'resume', job_scoped: false }], // vault only, not attached to this job
        application: {
          application_id: 'app-1', status: 'pending',
          application_answers: { work_authorization: true }, prompt_answers: { p1: 'Yes' },
          details_requested_at: '2026-09-01T00:00:00Z', details_completed_at: null,
        },
      });
      expect(b.missing_docs).toEqual([]);
      expect(b.remaining.docs).toEqual(['resume']);
    });

    it('probes required AND optional doc types, and marks which rows are job-scoped', async () => {
      await body({ job: { required_docs: [], optional_docs: ['driver_license'] } });
      const docsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM worker_documents'))?.[0] as string;
      // Previously required-only: without the widening, every optional doc
      // read as missing no matter what the worker holds.
      expect(docsSql).toContain('doc_type = ANY($2::text[])');
      expect(docsSql).toContain('AND (job_id IS NULL OR job_id = $3::uuid)');
      expect(docsSql).toContain('AS job_scoped');
      const params = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM worker_documents'))?.[1] as unknown[];
      expect(params[1]).toEqual(['driver_license']);
    });

    it('drops an uncollectable legacy required doc from missing_docs (no flow can collect ssn)', async () => {
      const b = await body({ job: { required_docs: ['resume', 'ssn'] } });
      expect(b.missing_docs).toEqual(['resume']);
    });
  });
});
