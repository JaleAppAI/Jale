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
import {
  releasePromptLaneForApplication,
  releaseWhatsAppLanesForApplication,
} from '../../../../lambda/lib/application-web-completion';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/application-requirements');
jest.mock('../../../../lambda/lib/application-web-completion');

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
const mockReleaseLanes = releaseWhatsAppLanesForApplication as jest.Mock;
const mockReleasePromptLane = releasePromptLaneForApplication as jest.Mock;

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
    mockReleaseLanes.mockResolvedValue({ armed: true, scrubbed: 1, closingLineQueued: true });
    mockReleasePromptLane.mockResolvedValue({ armed: true, scrubbed: 1, closingLineQueued: false });
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

  it('returns 400 for a NUL inside a string value, before the pool', async () => {
    // Legal JSON that every length/trim validator accepts and jsonb refuses.
    const res = await handler(makeEvent({
      httpMethod: 'POST',
      pathParameters: { applicationId: APP_ID, action: 'answers' },
      body: '{"answers":{"home_address":{"street":"a\\u0000b"}}}',
    }));

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

  it('POST answers refuses a __proto__ key with a NAMED error, not the engine\'s silent 200', async () => {
    // `errors['__proto__'] = ...` inside the engine runs Object.prototype's
    // setter instead of creating an own property, so its error map stays
    // empty and an entirely rejected batch reads as ok. The door stops that.
    const res = await handler(makeEvent({
      httpMethod: 'POST',
      pathParameters: { applicationId: APP_ID, action: 'answers' },
      body: '{"answers":{"__proto__":{"polluted":true}}}',
    }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('invalid_answers');
    expect(Object.keys(body.errors)).toEqual(['__proto__']);
    expect(mockMergeFieldAnswers).not.toHaveBeenCalled();
    expect(({} as any).polluted).toBeUndefined();
    expect(sqlCalls()).toContain('ROLLBACK');
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
    // F2: a completed application is locked on the web too, not only on
    // WhatsApp. The state rides along so the flow can render its read-only
    // panel from the same response.
    ['locked', 'application_locked'],
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

  it('POST certifications maps locked to 409 application_locked too -- the lock is per application, not per door', async () => {
    mockMergeCertificationClaims.mockResolvedValue({ ok: false, reason: 'locked' });

    const res = await handler(post('certifications', { certifications: [{ name: 'OSHA 30', has: true }] }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('application_locked');
    expect(sqlCalls()).not.toContain('COMMIT');
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

  // ── POST hire-ack (sprint 24, 095) ──────────────────────────────────
  // The worker's celebration state, written server-side so the modal cannot
  // re-fire on their next device. It is NOT one of the three merge actions:
  // it never touches the requirements engine, and it must not, because the
  // snapshot load COPIES vault documents onto the job and can trip an 078 cap
  // -- consequences no banner dismissal should be able to have.
  describe('POST hire-ack', () => {
    /** The UPDATE this action issues, as it reaches the mocked pool. */
    const ackSql = () => sqlCalls().find((sql) => /hired_seen_at\s*=/.test(sql));

    function withAck(row: { hired_seen_at: unknown; hired_ack_at: unknown } | null) {
      mockQuery.mockImplementation((sql: string) => {
        if (/UPDATE job_applications/.test(sql)) {
          return Promise.resolve({ rowCount: row ? 1 : 0, rows: row ? [row] : [] });
        }
        return Promise.resolve(defaultQuery(sql));
      });
    }

    it("stamps hired_seen_at for step 'seen' and answers the two timestamps", async () => {
      withAck({ hired_seen_at: '2026-09-04T16:00:00.000Z', hired_ack_at: null });

      const res = await handler(post('hire-ack', { step: 'seen' }));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        seen_at: '2026-09-04T16:00:00.000Z',
        acknowledged_at: null,
      });
      // COALESCE, so a second showing of the modal keeps the FIRST stamp --
      // the timestamp is evidence of when the worker saw it.
      expect(ackSql()).toContain('hired_seen_at = COALESCE(hired_seen_at, now())');
      // 'seen' must NOT dismiss the banner.
      expect(ackSql()).not.toContain('hired_ack_at =');
      expect(sqlCalls()).toContain('COMMIT');
    });

    it("stamps BOTH columns for step 'dismissed'", async () => {
      withAck({
        hired_seen_at: '2026-09-04T16:00:00.000Z',
        hired_ack_at: '2026-09-05T09:00:00.000Z',
      });

      const res = await handler(post('hire-ack', { step: 'dismissed' }));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        seen_at: '2026-09-04T16:00:00.000Z',
        acknowledged_at: '2026-09-05T09:00:00.000Z',
      });
      // A worker who dismisses the banner has necessarily seen the hire, and
      // a client that only ever calls 'dismissed' (an offline modal, a page
      // reload mid-celebration) must not leave hired_seen_at NULL forever.
      expect(ackSql()).toContain('hired_ack_at = COALESCE(hired_ack_at, now())');
      expect(ackSql()).toContain('hired_seen_at = COALESCE(hired_seen_at, now())');
      expect(sqlCalls()).toContain('COMMIT');
    });

    it('scopes the UPDATE to the caller AND to a hired application', async () => {
      withAck({ hired_seen_at: 'ts', hired_ack_at: null });

      await handler(post('hire-ack', { step: 'seen' }));

      const sql = ackSql()!;
      // jobapp_whatsapp_select is USING (true) (028), so RLS proves nothing
      // about ownership on a read -- and the UPDATE policy is the only thing
      // that would refuse a write. Both predicates are explicit anyway.
      expect(sql).toMatch(/WHERE\s+id = \$1\s+AND worker_id = \$2\s+AND status = 'hired'/);
      expect(sql).toContain('RETURNING hired_seen_at, hired_ack_at');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE job_applications'),
        [APP_ID, WORKER_ID],
      );
    });

    it('404s (and rolls back) when the row is not hired or not the caller\'s', async () => {
      // Zero rows is the same answer for "somebody else's application" and
      // "not hired yet": the UPDATE carries both predicates, and neither is
      // a distinction this caller is entitled to learn.
      withAck(null);

      const res = await handler(post('hire-ack', { step: 'seen' }));

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
      expect(sqlCalls()).toContain('ROLLBACK');
      expect(sqlCalls()).not.toContain('COMMIT');
    });

    it.each([
      ['an unknown step', { step: 'acknowledged' }],
      ['a missing step', {}],
      ['a non-string step', { step: 1 }],
      ['a null step', { step: null }],
      ['a case variant', { step: 'Seen' }],
      ['a padded step', { step: ' seen' }],
    ])('400s invalid_step for %s, and writes nothing', async (_label, body) => {
      const res = await handler(post('hire-ack', body));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_step' });
      expect(sqlCalls().some((sql) => /UPDATE job_applications/.test(sql))).toBe(false);
      expect(sqlCalls()).toContain('ROLLBACK');
    });

    // The whole point of keeping this action off WRITE_ACTIONS: the engine
    // never runs for it.
    it('never loads the requirement snapshot, so no vault document is copied', async () => {
      withAck({ hired_seen_at: 'ts', hired_ack_at: null });

      await handler(post('hire-ack', { step: 'seen' }));

      expect(mockLoad).not.toHaveBeenCalled();
      expect(mockMergePromptAnswers).not.toHaveBeenCalled();
      expect(mockMergeFieldAnswers).not.toHaveBeenCalled();
      expect(mockMergeCertificationClaims).not.toHaveBeenCalled();
      expect(mockMarkComplete).not.toHaveBeenCalled();
      // ...and no state document is built, so the 031 employer_profiles GUC
      // is never flipped by a banner dismissal.
      expect(sqlCalls().some((sql) => /employer_display_name/.test(sql))).toBe(false);
    });

    it('still 404s an unowned application before the step is even validated', async () => {
      // The ownership SELECT comes first: an invalid body on somebody else's
      // application must not answer 400 (which would confirm the row exists).
      mockQuery.mockImplementation((sql: string) => {
        if (/FROM job_applications/.test(sql) && !/UPDATE/.test(sql)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve(defaultQuery(sql));
      });

      const res = await handler(post('hire-ack', { step: 'nonsense' }));

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    });

    it.each(['GET', 'PATCH', 'DELETE'])('405s %s on hire-ack', async (httpMethod) => {
      const res = await handler(makeEvent({
        httpMethod,
        pathParameters: { applicationId: APP_ID, action: 'hire-ack' },
      }));

      expect(res.statusCode).toBe(405);
      expect(JSON.parse(res.body)).toEqual({ error: 'method_not_allowed' });
      expect(sqlCalls()).toContain('ROLLBACK');
    });

    it('is reached through the legal wall like every other /worker/* route', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (/tos_version/.test(sql)) return Promise.resolve({ rows: [{ tos_version: 'v0.9' }] });
        return Promise.resolve(defaultQuery(sql));
      });

      const res = await handler(post('hire-ack', { step: 'seen' }));

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('legal_required');
    });
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

  // ── Releasing the WhatsApp bot's arm (sprint 24 round 2, lane 1.5) ───
  //
  // The bot re-sends its pending fill/prompt step after ANY inbound message
  // while `state_context.fill_application_id` (or `prompt_application_id`)
  // is set, and only the bot ever cleared it. These tests pin WHEN this door
  // clears it: on a details-stage COMPLETION, and never otherwise.

  describe('WhatsApp lane release', () => {
    it('releases the lanes when POST answers completes the details stage', async () => {
      mockMergeFieldAnswers.mockResolvedValue({
        ok: true, keys: ['years_experience'], detailsCompleted: true,
      });

      const res = await handler(post('answers', { answers: { years_experience: 5 } }));

      expect(res.statusCode).toBe(200);
      expect(mockReleaseLanes).toHaveBeenCalledTimes(1);
      expect(mockReleaseLanes).toHaveBeenCalledWith(expect.anything(), {
        workerId: WORKER_ID,
        applicationId: APP_ID,
        jobTitle: 'Concrete Finisher',
        lang: 'es',
      });
      expect(mockReleasePromptLane).not.toHaveBeenCalled();
    });

    it('releases the lanes BEFORE buildState flips the 031 GUC, and before COMMIT', async () => {
      mockMergeFieldAnswers.mockResolvedValue({
        ok: true, keys: ['years_experience'], detailsCompleted: true,
      });
      const order: string[] = [];
      mockReleaseLanes.mockImplementation(async () => {
        order.push('release');
        return { armed: true, scrubbed: 1, closingLineQueued: true };
      });
      mockQuery.mockImplementation((sql: string) => {
        if (/employer_display_name/.test(sql)) order.push('employer_display_name');
        if (/^COMMIT$/.test(sql)) order.push('COMMIT');
        return Promise.resolve(defaultQuery(sql));
      });

      await handler(post('answers', { answers: { years_experience: 5 } }));

      expect(order).toEqual(['release', 'employer_display_name', 'COMMIT']);
    });

    it('releases the lanes when POST certifications completes the details stage', async () => {
      mockMergeCertificationClaims.mockResolvedValue({
        ok: true, certifications: [], detailsCompleted: true,
      });

      const res = await handler(post('certifications', { claims: [{ name: 'OSHA 10' }] }));

      expect(res.statusCode).toBe(200);
      expect(mockReleaseLanes).toHaveBeenCalledTimes(1);
    });

    it('does NOT release when the merge succeeded but the stage is not complete', async () => {
      mockMergeFieldAnswers.mockResolvedValue({
        ok: true, keys: ['years_experience'], detailsCompleted: false,
      });

      await handler(post('answers', { answers: { years_experience: 5 } }));

      expect(mockReleaseLanes).not.toHaveBeenCalled();
      expect(mockReleasePromptLane).not.toHaveBeenCalled();
    });

    it('does NOT release when the merge failed', async () => {
      mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason: 'closed' });

      await handler(post('answers', { answers: { years_experience: 5 } }));

      expect(mockReleaseLanes).not.toHaveBeenCalled();
    });

    it('does NOT release on hire-ack', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (/hired_seen_at/.test(sql)) {
          return Promise.resolve({ rows: [{ hired_seen_at: 'now', hired_ack_at: null }] });
        }
        return Promise.resolve(defaultQuery(sql));
      });

      const res = await handler(post('hire-ack', { step: 'seen' }));

      expect(res.statusCode).toBe(200);
      expect(mockReleaseLanes).not.toHaveBeenCalled();
      expect(mockReleasePromptLane).not.toHaveBeenCalled();
    });

    it('DOES release on the GET path when it flips details_completed_at', async () => {
      // The document-last worker. A file uploaded through `/worker/vault/*`
      // never touches the requirements engine, so the GET's
      // `markDetailsCompleteIfDone` is what closes their stage -- and because
      // it flips only `WHERE details_completed_at IS NULL`, no later POST can
      // ever report `detailsCompleted: true` for that application. Missing
      // this call left those workers re-prompted forever.
      mockMarkComplete.mockResolvedValue(true);

      const res = await handler(makeEvent());

      expect(res.statusCode).toBe(200);
      expect(mockReleaseLanes).toHaveBeenCalledTimes(1);
      expect(mockReleaseLanes).toHaveBeenCalledWith(expect.anything(), {
        workerId: WORKER_ID,
        applicationId: APP_ID,
        jobTitle: 'Concrete Finisher',
        lang: 'es',
      });
    });

    it('does NOT release on a GET that changes nothing', async () => {
      mockMarkComplete.mockResolvedValue(false);

      const res = await handler(makeEvent());

      expect(res.statusCode).toBe(200);
      expect(mockReleaseLanes).not.toHaveBeenCalled();
    });

    it('releases on the GET BEFORE buildState flips the 031 GUC', async () => {
      mockMarkComplete.mockResolvedValue(true);
      const order: string[] = [];
      mockReleaseLanes.mockImplementation(async () => {
        order.push('release');
        return { armed: true, scrubbed: 1, closingLineQueued: true };
      });
      mockQuery.mockImplementation((sql: string) => {
        if (/employer_display_name/.test(sql)) order.push('employer_display_name');
        if (/^COMMIT$/.test(sql)) order.push('COMMIT');
        return Promise.resolve(defaultQuery(sql));
      });

      await handler(makeEvent());

      expect(order).toEqual(['release', 'employer_display_name', 'COMMIT']);
    });

    it('releases the PROMPT lane only, with no closing line, once no prompt is outstanding', async () => {
      mockMergePromptAnswers.mockResolvedValue({ ok: true, keys: ['p1'] });
      mockComputeRemaining.mockReturnValue({ ...REMAINING, prompts: [] });

      const res = await handler(post('prompt-answers', { answers: { p1: 'yes' } }));

      expect(res.statusCode).toBe(200);
      expect(mockReleasePromptLane).toHaveBeenCalledTimes(1);
      expect(mockReleasePromptLane).toHaveBeenCalledWith(expect.anything(), {
        workerId: WORKER_ID,
        applicationId: APP_ID,
      });
      expect(mockReleaseLanes).not.toHaveBeenCalled();
    });

    it('leaves the prompt lane armed while a prompt is still outstanding', async () => {
      mockMergePromptAnswers.mockResolvedValue({ ok: true, keys: ['p1'] });
      mockComputeRemaining.mockReturnValue({ ...REMAINING, prompts: ['p2'] });

      await handler(post('prompt-answers', { answers: { p1: 'yes' } }));

      expect(mockReleasePromptLane).not.toHaveBeenCalled();
      expect(mockReleaseLanes).not.toHaveBeenCalled();
    });

    it('does not change the response shape when the release runs', async () => {
      mockMergeFieldAnswers.mockResolvedValue({
        ok: true, keys: ['years_experience'], detailsCompleted: true,
      });

      const withRelease = await handler(post('answers', { answers: { years_experience: 5 } }));

      jest.clearAllMocks();
      mockGetDbPool.mockResolvedValue({
        connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
      });
      mockQuery.mockImplementation((sql: string) => Promise.resolve(defaultQuery(sql)));
      mockSetInternalUserRlsContext.mockResolvedValue(undefined);
      mockLoad.mockResolvedValue(snapshot());
      mockComputeRemaining.mockReturnValue(REMAINING);
      mockNextStep.mockReturnValue({ kind: 'complete', stage: 'details' });
      mockDetailsStatusFor.mockReturnValue('complete');
      mockMergeFieldAnswers.mockResolvedValue({
        ok: true, keys: ['years_experience'], detailsCompleted: false,
      });

      const withoutRelease = await handler(post('answers', { answers: { years_experience: 5 } }));

      expect(withRelease.statusCode).toBe(withoutRelease.statusCode);
      expect(JSON.parse(withRelease.body)).toEqual(JSON.parse(withoutRelease.body));
    });

    it('never lets a release failure reach the response', async () => {
      // The module swallows its own errors; this is the belt on that brace.
      mockMergeFieldAnswers.mockResolvedValue({
        ok: true, keys: ['years_experience'], detailsCompleted: true,
      });
      mockReleaseLanes.mockResolvedValue({ armed: false, scrubbed: 0, closingLineQueued: false });

      const res = await handler(post('answers', { answers: { years_experience: 5 } }));

      expect(res.statusCode).toBe(200);
      expect(sqlCalls()).toContain('COMMIT');
    });
  });
});
