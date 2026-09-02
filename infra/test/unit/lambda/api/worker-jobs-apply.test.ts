import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-jobs-apply';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const PROMPTS = [{ id: 'p1', text: 'Years of framing?' }, { id: 'p2', text: 'Own tools?' }];

const ev = {
  requestContext: { authorizer: { claims: { sub: 'w-sub' } } },
  pathParameters: { jobId: 'job-1' },
} as unknown as APIGatewayProxyEvent;

const evWith = (body: unknown) => ({ ...ev, body: JSON.stringify(body) }) as APIGatewayProxyEvent;

/** Routes the shared apply path: users lookup, job SELECT, INSERT, doc copy. */
function routeApply(job: Record<string, unknown>, opts: { insertRows?: unknown[] } = {}) {
  const calls: string[] = [];
  mockQuery.mockImplementation((q: string) => {
    calls.push(typeof q === 'string' ? q : '');
    if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
    if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
    if (q.includes('INSERT INTO job_applications')) {
      return Promise.resolve({ rows: opts.insertRows ?? [{ id: 'a1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });
    }
    if (q.includes('FROM job_applications')) {
      return Promise.resolve({ rows: [{ id: 'a1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });
    }
    if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rowCount: 1 });
    return Promise.resolve({});
  });
  return calls;
}

const jobRow = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'job-1', required_docs: [], optional_docs: [], pre_application_prompts: [], ...overrides });

describe('worker-jobs-apply', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 410 if job is closed or missing', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    expect((await handler(ev)).statusCode).toBe(410);
  });

  it('returns 409 if already applied', async () => {
    routeApply(jobRow(), { insertRows: [] });
    expect((await handler(ev)).statusCode).toBe(409);
  });

  it('returns 201 with application on happy path, copies docs, and inserts prompt_answers', async () => {
    const calls = routeApply(jobRow({ required_docs: ['resume'] }));

    const res = await handler(ev);

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('a1');
    const applicationInsert = calls.find((c) => c.includes('INSERT INTO job_applications')) as string;
    expect(applicationInsert).toContain('(job_id, worker_id, status, application_answers, prompt_answers)');
    expect(applicationInsert).toContain("'pending'");
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-id');
    const docCopy = calls.find((c) => c.includes('INSERT INTO worker_documents')) as string;
    expect(docCopy).toContain('s3_version_id');
  });

  it('returns 400 invalid_json for a malformed request body', async () => {
    const res = await handler({ ...ev, body: '{oops' } as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 missing_id when the path parameter is absent', async () => {
    const res = await handler({ ...ev, pathParameters: {} } as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_id' });
  });

  it('returns 401 without a Cognito sub', async () => {
    const res = await handler({ ...ev, requestContext: { authorizer: { claims: {} } } } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(401);
  });

  it('returns 409 certification_document_limit when the snapshot copy hits either 078 trigger cap, not a 500', async () => {
    for (const constraint of ['certification_document_limit', 'certification_document_name_limit']) {
      jest.clearAllMocks();
      mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
        if (q.includes('FROM jobs')) return Promise.resolve({ rows: [jobRow({ required_docs: ['certification_doc'] })] });
        if (q.includes('INSERT INTO job_applications')) return Promise.resolve({ rows: [{ id: 'a1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });
        if (q.includes('INSERT INTO worker_documents')) {
          return Promise.reject(Object.assign(new Error('cap'), { code: '23514', constraint }));
        }
        return Promise.resolve({});
      });

      const res = await handler(ev);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'certification_document_limit' });
    }
  });

  it('returns 403 apply_forbidden on an RLS denial', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [jobRow()] });
      if (q.includes('INSERT INTO job_applications')) return Promise.reject(Object.assign(new Error('denied'), { code: '42501' }));
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'apply_forbidden' });
  });

  it('returns 500 and rolls back when the apply throws an unmapped database error', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [jobRow()] });
      if (q.includes('INSERT INTO job_applications')) return Promise.reject(Object.assign(new Error('deadlock'), { code: '40P01' }));
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('worker-jobs-apply -- pre-application prompts', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('passes body.prompt_answers through and stores the trimmed values', async () => {
    const calls = routeApply(jobRow({ pre_application_prompts: PROMPTS }));

    const res = await handler(evWith({ prompt_answers: { p1: ' five ', p2: 'yes' } }));

    expect(res.statusCode).toBe(201);
    const insertIdx = calls.findIndex((c) => c.includes('INSERT INTO job_applications'));
    const params = mockQuery.mock.calls[insertIdx][1] as any[];
    expect(JSON.parse(String(params[2]))).toEqual({ p1: 'five', p2: 'yes' });
  });

  it('returns 400 missing_prompt_answers WITH the missing ids', async () => {
    routeApply(jobRow({ pre_application_prompts: PROMPTS }));

    const res = await handler(evWith({ prompt_answers: { p1: 'five' } }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_prompt_answers', missing: ['p2'] });
  });

  it('returns 400 missing_prompt_answers for a body with no prompt_answers at all on a job with prompts', async () => {
    routeApply(jobRow({ pre_application_prompts: PROMPTS }));
    const res = await handler(ev);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_prompt_answers', missing: ['p1', 'p2'] });
  });

  it('returns 400 invalid_prompt_answers for an unknown id or a bad answer', async () => {
    for (const promptAnswers of [{ p1: 'a', p2: 'b', p9: 'c' }, { p1: '  ', p2: 'b' }, 'nope']) {
      routeApply(jobRow({ pre_application_prompts: PROMPTS }));
      const res = await handler(evWith({ prompt_answers: promptAnswers }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_prompt_answers' });
    }
  });

  it('a job with no prompts still applies with an empty body', async () => {
    routeApply(jobRow());
    expect((await handler(evWith({}))).statusCode).toBe(201);
  });
});

describe('worker-jobs-apply -- legacy payload compat window (B4.5, one release)', () => {
  const env = process.env;
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); });
  afterAll(() => { process.env = env; });

  it('ACCEPTS a stale cached-bundle body carrying answers + certification_claims: 201, values ignored, nothing validated', async () => {
    const calls = routeApply(jobRow());

    const res = await handler(evWith({
      answers: { date_of_birth: 'whatever', bogus_key: 1 },
      certification_claims: [{ name: 'OSHA 30', has: true }],
    }));

    expect(res.statusCode).toBe(201);
    // Nothing from the legacy payload reaches the column, and the removed
    // cert-ownership / defaults writes never run.
    const insertIdx = calls.findIndex((c) => c.includes('INSERT INTO job_applications'));
    expect(String((mockQuery.mock.calls[insertIdx][1] as any[])[2])).toBe('{}');
    expect(calls.some((c) => c.includes('worker_application_defaults'))).toBe(false);
    expect(calls.some((c) => c.includes("doc_type = 'certification_doc'"))).toBe(false);
  });

  it('logs a LegacyApplyPayloadIgnored metric line naming which legacy keys were present', async () => {
    routeApply(jobRow());
    await handler(evWith({ answers: {}, certification_claims: [] }));

    const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('LegacyApplyPayloadIgnored'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({
      metric: 'LegacyApplyPayloadIgnored',
      jobId: 'job-1',
      hasAnswers: true,
      hasCertificationClaims: true,
    });
  });

  it('logs nothing for a clean modern body', async () => {
    routeApply(jobRow());
    await handler(evWith({ prompt_answers: {} }));
    expect(logSpy.mock.calls.map((c) => String(c[0])).some((s) => s.includes('LegacyApplyPayloadIgnored'))).toBe(false);
  });

  it('a legacy body on a job WITH prompts still bounces on the prompts it does not carry', async () => {
    routeApply(jobRow({ pre_application_prompts: PROMPTS }));
    const res = await handler(evWith({ answers: { date_of_birth: '1990-04-03' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_prompt_answers', missing: ['p1', 'p2'] });
  });
});
