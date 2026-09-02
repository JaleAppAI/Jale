import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-application-details';
import { getDbPool, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import {
  computeRemaining,
  detailsStatusFor,
  loadRequirementSnapshot,
  markDetailsCompleteIfDone,
  mergeCertificationClaims,
  mergeFieldAnswers,
  mergePromptAnswers,
  nextStep,
} from '../../../../lambda/lib/application-requirements';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/application-requirements');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockLoad = loadRequirementSnapshot as jest.Mock;
const mockMarkComplete = markDetailsCompleteIfDone as jest.Mock;
const mockComputeRemaining = computeRemaining as jest.Mock;
const mockNextStep = nextStep as jest.Mock;
const mockDetailsStatusFor = detailsStatusFor as jest.Mock;
const mockMergeFieldAnswers = mergeFieldAnswers as jest.Mock;
const mockMergeCertificationClaims = mergeCertificationClaims as jest.Mock;
const mockMergePromptAnswers = mergePromptAnswers as jest.Mock;

const mockQuery = jest.fn();
const mockRelease = jest.fn();

const APP_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYER_ID = '44444444-4444-4444-8444-444444444444';

/** A details-stage snapshot with one required field and one required doc. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    applicationId: APP_ID,
    workerId: WORKER_ID,
    jobId: JOB_ID,
    applicationStatus: 'details_requested',
    jobStatus: 'active',
    jobTitle: 'Concrete Finisher',
    answers: { years_experience: 5, certifications: [{ name: 'OSHA 10' }] },
    promptAnswers: { p1: 'yes' },
    prompts: [{ id: 'p1', text: 'Can you start Monday?' }],
    requiredFields: ['years_experience'],
    optionalFields: ['availability'],
    requiredDocs: ['id_document'],
    optionalDocs: ['work_auth_doc'],
    certificationRequirements: [{ name: 'OSHA 10', proof_required: false }],
    haveDocs: ['id_document'],
    detailsRequestedAt: '2026-09-01T00:00:00.000Z',
    detailsCompletedAt: null,
    appliedAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    stage: 'details',
    ...overrides,
  };
}

const REMAINING = {
  prompts: [],
  fields: [],
  certifications: { unclaimed: [], unproven: [] },
  docs: [],
  uncollectableDocs: [],
  optionalFields: ['availability'],
  optionalDocs: ['work_auth_doc'],
  counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 },
  complete: true,
};

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    requestContext: { authorizer: { claims: { sub: 'w-sub' } } },
    pathParameters: { applicationId: APP_ID },
    body: null,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function post(action: string, body: unknown, overrides: Partial<APIGatewayProxyEvent> = {}) {
  return makeEvent({
    httpMethod: 'POST',
    pathParameters: { applicationId: APP_ID, action },
    body: JSON.stringify(body),
    ...overrides,
  });
}

/** Only the SQL this handler issues itself; the engine module is mocked. */
function defaultQuery(sql: string) {
  if (/resolve_worker_internal_id/.test(sql)) return { rows: [{ id: WORKER_ID }] };
  if (/tos_version/.test(sql)) return { rows: [{ tos_version: 'v1.0' }] };
  if (/FROM job_applications/.test(sql)) return { rows: [{ id: APP_ID }] };
  if (/employer_id FROM jobs/.test(sql)) return { rows: [{ employer_id: EMPLOYER_ID }] };
  if (/employer_display_name/.test(sql)) return { rows: [{ company_name: 'RM Construction' }] };
  return { rows: [], rowCount: 0 };
}

const sqlCalls = () => mockQuery.mock.calls.map((call) => String(call[0]));

describe('worker-application-details', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockQuery.mockImplementation((sql: string) => Promise.resolve(defaultQuery(sql)));
    mockSetInternalUserRlsContext.mockResolvedValue(undefined);
    mockLoad.mockResolvedValue(snapshot());
    mockMarkComplete.mockResolvedValue(false);
    mockComputeRemaining.mockReturnValue(REMAINING);
    mockNextStep.mockReturnValue({ kind: 'complete', stage: 'details' });
    mockDetailsStatusFor.mockReturnValue('complete');
  });

  afterAll(() => { process.env = env; });

  // ── Pre-DB guards ───────────────────────────────────────────────────

  it('returns 401 when the token carries no sub', async () => {
    const res = await handler(makeEvent({
      requestContext: { authorizer: { claims: {} } },
    } as unknown as Partial<APIGatewayProxyEvent>));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 413 for a body over the 16 KB cap, before touching the pool', async () => {
    const res = await handler(post('answers', { answers: { note: 'x'.repeat(17 * 1024) } }));

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'payload_too_large' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 for an unparseable body', async () => {
    const res = await handler(post('answers', {}, { body: '{' } as Partial<APIGatewayProxyEvent>));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_request' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 404 (never 500) for a malformed, non-UUID application id', async () => {
    const res = await handler(makeEvent({ pathParameters: { applicationId: 'not-a-uuid' } }));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  // ── Transactional guards ────────────────────────────────────────────

  it('rolls back and 404s when the sub resolves to no worker', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve(/resolve_worker_internal_id/.test(sql) ? { rows: [{ id: null }] } : defaultQuery(sql)));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'worker_not_found' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('rolls back and 403s when the worker has not accepted the required terms', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve(/tos_version/.test(sql) ? { rows: [{ tos_version: 'v0.9' }] } : defaultQuery(sql)));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'legal_required',
      requiredVersion: 'v1.0',
      currentVersion: 'v0.9',
    });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('rolls back and 404s for another worker\'s application (the SELECT is worker-scoped)', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve(/FROM job_applications/.test(sql) ? { rows: [] } : defaultQuery(sql)));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    const ownership = mockQuery.mock.calls.find(
      (call) => /FROM job_applications/.test(String(call[0])),
    );
    expect(String(ownership?.[0])).toMatch(/worker_id = \$2/);
    expect(ownership?.[1]).toEqual([APP_ID, WORKER_ID]);
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('sets the RLS GUC to the resolved internal worker id', async () => {
    await handler(makeEvent());
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), WORKER_ID);
  });

  it('rolls back and 404s when the application vanished between the two reads', async () => {
    mockLoad.mockResolvedValue(null);

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(404);
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  // ── GET state ───────────────────────────────────────────────────────

  it('GET returns the full state document and commits', async () => {
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.application).toEqual({
      id: APP_ID,
      job_id: JOB_ID,
      status: 'details_requested',
      details_status: 'complete',
      stage: 'details',
      details_requested_at: '2026-09-01T00:00:00.000Z',
      details_completed_at: null,
      applied_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    expect(body.job).toEqual({
      id: JOB_ID,
      title: 'Concrete Finisher',
      company_name: 'RM Construction',
      status: 'active',
      required_fields: ['years_experience'],
      optional_fields: ['availability'],
      required_docs: ['id_document'],
      optional_docs: ['work_auth_doc'],
      certification_requirements: [{ name: 'OSHA 10', proof_required: false }],
      pre_application_prompts: [{ id: 'p1', text: 'Can you start Monday?' }],
    });
    // The reserved 'certifications' key never appears in `answers`.
    expect(body.answers).toEqual({ years_experience: 5 });
    expect(body.certifications).toEqual([{ name: 'OSHA 10' }]);
    expect(body.prompt_answers).toEqual({ p1: 'yes' });
    expect(body.documents).toEqual([
      { doc_type: 'id_document', present: true },
      { doc_type: 'work_auth_doc', present: false },
    ]);
    expect(body.remaining).toEqual(REMAINING);
    expect(body.next_step).toEqual({ kind: 'complete', stage: 'details' });
    expect(sqlCalls()).toContain('COMMIT');
    expect(sqlCalls()).not.toContain('ROLLBACK');
  });

  it('syncs document snapshots on the read path', async () => {
    await handler(makeEvent());
    expect(mockLoad).toHaveBeenCalledWith(expect.anything(), APP_ID, { syncDocumentSnapshots: true });
  });

  it('employer_display_name is the LAST query before COMMIT (031 widens employer_profiles)', async () => {
    await handler(makeEvent());

    const calls = sqlCalls();
    const commitIndex = calls.indexOf('COMMIT');
    expect(commitIndex).toBeGreaterThan(0);
    expect(calls[commitIndex - 1]).toMatch(/employer_display_name/);
    expect(calls[commitIndex - 2]).toMatch(/employer_id FROM jobs/);
  });

  it('remaps legacy application statuses the same way the list endpoint does', async () => {
    mockLoad.mockResolvedValue(snapshot({ applicationStatus: 'reviewed' }));
    const reviewed = JSON.parse((await handler(makeEvent())).body);
    expect(reviewed.application.status).toBe('contacted');

    mockLoad.mockResolvedValue(snapshot({ applicationStatus: 'rejected' }));
    const rejected = JSON.parse((await handler(makeEvent())).body);
    expect(rejected.application.status).toBe('not_interested');
  });

  it('GET completes an application finished through /worker/vault/* and re-reads the snapshot', async () => {
    const completed = snapshot({ detailsCompletedAt: '2026-09-02T00:00:00.000Z' });
    mockMarkComplete.mockResolvedValue(true);
    mockLoad.mockResolvedValueOnce(snapshot()).mockResolvedValue(completed);

    const res = await handler(makeEvent());

    expect(mockMarkComplete).toHaveBeenCalledWith(expect.anything(), APP_ID, expect.objectContaining({ applicationId: APP_ID }));
    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body).application.details_completed_at).toBe('2026-09-02T00:00:00.000Z');
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('does not re-load the snapshot when nothing flipped', async () => {
    await handler(makeEvent());
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  // ── POST answers ────────────────────────────────────────────────────

  it('POST answers merges through the shared engine and returns the FRESH state', async () => {
    const merged = snapshot({ answers: { years_experience: 7 } });
    mockMergeFieldAnswers.mockResolvedValue({ ok: true, keys: ['years_experience'], detailsCompleted: false });
    mockLoad.mockResolvedValueOnce(snapshot()).mockResolvedValue(merged);

    const res = await handler(post('answers', { answers: { years_experience: 7 } }));

    expect(mockMergeFieldAnswers).toHaveBeenCalledWith(expect.anything(), {
      applicationId: APP_ID,
      workerId: WORKER_ID,
      answers: { years_experience: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).answers).toEqual({ years_experience: 7 });
    expect(sqlCalls()).toContain('COMMIT');
  });

  it.each([
    ['a non-object answers value', { answers: 'nope' }],
    ['an empty batch', { answers: {} }],
    ['more than 20 keys', { answers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }],
  ])('POST answers rejects %s with 400 invalid_answers and rolls back', async (_label, body) => {
    const res = await handler(post('answers', body));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_answers', errors: {} });
    expect(mockMergeFieldAnswers).not.toHaveBeenCalled();
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
  });

  it('POST answers maps the engine\'s per-key errors onto 400 invalid_answers', async () => {
    mockMergeFieldAnswers.mockResolvedValue({
      ok: false,
      reason: 'invalid',
      errors: { years_experience: 'unknown_answer_key' },
    });

    const res = await handler(post('answers', { answers: { years_experience: 7 } }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_answers',
      errors: { years_experience: 'unknown_answer_key' },
    });
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  it.each([
    ['too_large', 400, { error: 'payload_too_large' }],
    ['not_found', 404, { error: 'not_found' }],
    ['certification_document_limit', 409, { error: 'certification_document_limit' }],
  ])('POST answers maps %s to %i and rolls back', async (reason, status, body) => {
    mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason });

    const res = await handler(post('answers', { answers: { years_experience: 7 } }));

    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual(body);
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
  });

  it.each([
    ['stage_locked', 'stage_locked'],
    ['closed', 'application_closed'],
  ])('POST answers maps %s to 409 %s WITH the state, built before the rollback', async (reason, error) => {
    mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason });

    const res = await handler(post('answers', { answers: { years_experience: 7 } }));

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(error);
    expect(body.state.application.id).toBe(APP_ID);
    expect(body.state.job.company_name).toBe('RM Construction');
    const calls = sqlCalls();
    const rollbackIndex = calls.indexOf('ROLLBACK');
    expect(rollbackIndex).toBeGreaterThan(0);
    expect(calls[rollbackIndex - 1]).toMatch(/employer_display_name/);
    expect(calls).not.toContain('COMMIT');
  });

  // ── POST certifications / prompt-answers ────────────────────────────

  it('POST certifications forwards the claims and returns the fresh state', async () => {
    mockMergeCertificationClaims.mockResolvedValue({ ok: true, certifications: [], detailsCompleted: false });

    const res = await handler(post('certifications', { claims: [{ name: 'OSHA 10' }] }));

    expect(mockMergeCertificationClaims).toHaveBeenCalledWith(expect.anything(), {
      applicationId: APP_ID,
      workerId: WORKER_ID,
      claims: [{ name: 'OSHA 10' }],
    });
    expect(res.statusCode).toBe(200);
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('POST certifications maps the engine\'s bare invalid to 400 with an empty error map', async () => {
    mockMergeCertificationClaims.mockResolvedValue({ ok: false, reason: 'invalid' });

    const res = await handler(post('certifications', { claims: 'nope' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_answers', errors: {} });
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  it('POST certifications maps certification_document_limit to 409', async () => {
    mockMergeCertificationClaims.mockResolvedValue({ ok: false, reason: 'certification_document_limit' });

    const res = await handler(post('certifications', { claims: [] }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'certification_document_limit' });
  });

  it('POST prompt-answers forwards the answers and returns the fresh state', async () => {
    mockMergePromptAnswers.mockResolvedValue({ ok: true, keys: ['p1'] });

    const res = await handler(post('prompt-answers', { answers: { p1: 'yes' } }));

    expect(mockMergePromptAnswers).toHaveBeenCalledWith(expect.anything(), {
      applicationId: APP_ID,
      workerId: WORKER_ID,
      answers: { p1: 'yes' },
    });
    expect(res.statusCode).toBe(200);
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('POST prompt-answers maps closed to 409 application_closed with the state', async () => {
    mockMergePromptAnswers.mockResolvedValue({ ok: false, reason: 'closed' });

    const res = await handler(post('prompt-answers', { answers: { p1: 'yes' } }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('application_closed');
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  it('POST prompt-answers maps too_large to 400 payload_too_large', async () => {
    mockMergePromptAnswers.mockResolvedValue({ ok: false, reason: 'too_large' });

    const res = await handler(post('prompt-answers', { answers: { p1: 'yes' } }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'payload_too_large' });
  });

  // ── Cert-doc cap on the initial load ────────────────────────────────

  it('maps a 078 cert-doc cap raised by the initial snapshot load to 409, not 500', async () => {
    mockLoad.mockRejectedValue(
      Object.assign(new Error('cap'), { code: '23514', constraint: 'certification_document_limit' }),
    );

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'certification_document_limit' });
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  it('maps the per-cert-name variant of that cap too', async () => {
    mockLoad.mockRejectedValue(
      Object.assign(new Error('cap'), { code: '23514', constraint: 'certification_document_name_limit' }),
    );

    expect((await handler(makeEvent())).statusCode).toBe(409);
  });

  // ── Routing ─────────────────────────────────────────────────────────

  it('404s an unknown action and rolls back', async () => {
    const res = await handler(post('complete', {}));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  it.each(['GET', 'PATCH', 'DELETE'])('405s %s on a known action', async (httpMethod) => {
    const res = await handler(makeEvent({
      httpMethod,
      pathParameters: { applicationId: APP_ID, action: 'answers' },
    }));

    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: 'method_not_allowed' });
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  it('405s a non-GET on the bare application resource', async () => {
    const res = await handler(makeEvent({ httpMethod: 'DELETE' }));

    expect(res.statusCode).toBe(405);
    expect(sqlCalls()).toContain('ROLLBACK');
  });

  // ── Failure ─────────────────────────────────────────────────────────

  it('rolls back, releases and 500s on an unexpected failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockLoad.mockRejectedValue(new Error('boom'));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('carries CORS headers on every response, including the pre-DB refusals', async () => {
    // `corsHeaders()` is captured at module load (every sibling handler does
    // the same), so the ORIGIN asserted here is the module-load one, not a
    // per-test env var. What matters is that the header is on every path.
    const ok = await handler(makeEvent());
    expect(ok.headers?.['Access-Control-Allow-Origin']).toBeDefined();
    expect(ok.headers?.['Content-Type']).toBe('application/json');

    const unauth = await handler(makeEvent({
      requestContext: { authorizer: { claims: {} } },
    } as unknown as Partial<APIGatewayProxyEvent>));
    expect(unauth.headers?.['Access-Control-Allow-Origin'])
      .toBe(ok.headers?.['Access-Control-Allow-Origin']);
  });
});
