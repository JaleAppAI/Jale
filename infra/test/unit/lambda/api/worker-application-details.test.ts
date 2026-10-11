import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-application-details';
import { getDbPool, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import {
  applicationIsOver,
  computeRemaining,
  detailsLocked,
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

import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectAttemptAfter, queryOrder, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/application-requirements');
jest.mock('../../../../lambda/lib/application-web-completion');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockLoad = loadRequirementSnapshot as jest.Mock;
const mockMarkComplete = markDetailsCompleteIfDone as jest.Mock;
const mockComputeRemaining = computeRemaining as jest.Mock;
/** R2: pure snapshot predicates. Auto-mocked they return `undefined`, which
 *  would make every completion-gate assertion below pass for the wrong
 *  reason, so the REAL implementations are reinstalled in `beforeEach`. */
const realRequirements = jest.requireActual<typeof import('../../../../lambda/lib/application-requirements')>(
  '../../../../lambda/lib/application-requirements',
);
const mockApplicationIsOver = applicationIsOver as jest.Mock;
const mockDetailsLocked = detailsLocked as jest.Mock;
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
  if (/employer_display_name/.test(sql)) return { rows: [{ company_name: 'NB Construction' }] };
  return { rows: [], rowCount: 0 };
}

const sqlCalls = () => mockQuery.mock.calls.map((call) => String(call[0]));

/** The savepoint each write door takes before its snapshot load. */
const WRITE_SAVEPOINT = 'application_details_write';

/** Every request that gets past the ownership check begins with these steps. */
const ENTRY_STEPS = ['BEGIN', 'resolve worker', 'user context', 'audit context', 'terms', 'ownership'];

/** A state document's access record, its two employer queries, and the COMMIT that keeps them together. */
const STATE_STEPS = ['record', 'employer id', 'employer name', 'COMMIT'];

/**
 * A write refused with the state: the load and the merge are undone back to
 * the savepoint, and the state that goes out is recorded and committed in the
 * same transaction. One BEGIN, and no ROLLBACK of the whole transaction.
 */
const REFUSED_WITH_STATE = [
  ...ENTRY_STEPS,
  `SAVEPOINT ${WRITE_SAVEPOINT}`, 'load', 'merge', `ROLLBACK TO SAVEPOINT ${WRITE_SAVEPOINT}`,
  ...STATE_STEPS,
];

/** A label for each statement the handler sends itself; any other statement keeps its own text. */
function statementStep(sql: string): string {
  if (/resolve_worker_internal_id/.test(sql)) return 'resolve worker';
  if (/^SELECT tos_version FROM users WHERE id = \$1$/.test(sql)) return 'terms';
  if (/^SELECT id FROM job_applications WHERE id = \$1 AND worker_id = \$2$/.test(sql)) return 'ownership';
  if (/^UPDATE job_applications\s+SET hired_/.test(sql)) return 'hire-ack update';
  if (/^SELECT employer_id FROM jobs WHERE id = \$1$/.test(sql)) return 'employer id';
  if (/^SELECT employer_display_name\(\$1\) AS company_name$/.test(sql)) return 'employer name';
  return sql;
}

/**
 * Everything the handler did, in call order: each statement it sent, and each
 * call into the mocked helpers listed here. Compared exactly, it pins the
 * whole transaction, so a statement added, dropped or moved fails the test.
 */
function timeline(): string[] {
  const helpers: Array<[string, jest.Mock]> = [
    ['user context', mockSetInternalUserRlsContext],
    ['audit context', setAuditContext as jest.Mock],
    ['load', mockLoad],
    ['merge', mockMergeFieldAnswers],
    ['merge', mockMergeCertificationClaims],
    ['merge', mockMergePromptAnswers],
    ['mark complete', mockMarkComplete],
    ['release lanes', mockReleaseLanes],
    ['release prompt lane', mockReleasePromptLane],
    ['record', recordAccess as jest.Mock],
    ['attempt', recordAttempt as jest.Mock],
  ];
  const steps = mockQuery.mock.calls.map(([sql], index) => ({
    order: mockQuery.mock.invocationCallOrder[index],
    step: statementStep(String(sql)),
  }));
  for (const [step, mock] of helpers) {
    for (const order of mock.mock.invocationCallOrder) steps.push({ order, step });
  }
  return steps.sort((a, b) => a.order - b.order).map(({ step }) => step);
}

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
    mockApplicationIsOver.mockImplementation(realRequirements.applicationIsOver);
    mockDetailsLocked.mockImplementation(realRequirements.detailsLocked);
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
      company_name: 'NB Construction',
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

  /**
   * R2. THE READ NEVER COMPLETES ANYTHING.
   *
   * The GET used to call `markDetailsCompleteIfDone`, which was harmless
   * while a completed application stayed editable. F2 made the timestamp a
   * LOCK, and the two together were a trap: WhatsApp's `armFill` seeds the
   * worker's saved answers and copies their vault documents, then
   * deliberately waits at the LISTO consent gate (branch (f)) -- so the
   * application is already `complete` before the worker has confirmed
   * anything. Merely OPENING the web page stamped it, released the bot's
   * arm, and left every later edit answering 409 `application_locked`. The
   * worker never agreed to send it and could no longer correct what was
   * pre-filled for them.
   *
   * Completion is now an explicit act: a deliberate POST, or LISTO on
   * WhatsApp. This asserts on `markDetailsCompleteIfDone` itself -- the
   * function that issues the UPDATE -- because a body assertion would pass
   * while the write still happened.
   */
  it('GET never stamps details_completed_at, even when nothing is outstanding', async () => {
    mockComputeRemaining.mockReturnValue({ ...REMAINING, complete: true, fields: [], docs: [] });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(mockMarkComplete).not.toHaveBeenCalled();
    expect(mockReleaseLanes).not.toHaveBeenCalled();
    expect(sqlCalls()).toContain('COMMIT');
  });

  it('GET reads once and never re-loads: nothing it does can change the snapshot', async () => {
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
  ])('POST answers maps %s to 409 %s WITH the state, recorded in the same transaction', async (reason, error) => {
    mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason });

    const res = await handler(post('answers', { answers: { years_experience: 7 } }));

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(error);
    expect(body.state.application.id).toBe(APP_ID);
    expect(body.state.job.company_name).toBe('NB Construction');
    // The merge is undone back to the savepoint, never committed; the state
    // that goes out is recorded and committed in the same transaction, with
    // employer_display_name still the last query before the COMMIT.
    expect(timeline()).toEqual(REFUSED_WITH_STATE);
  });

  it('POST certifications maps locked to 409 application_locked too -- the lock is per application, not per door', async () => {
    mockMergeCertificationClaims.mockResolvedValue({ ok: false, reason: 'locked' });

    const res = await handler(post('certifications', { certifications: [{ name: 'OSHA 30', has: true }] }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('application_locked');
    expect(timeline()).toEqual(REFUSED_WITH_STATE);
  });

  /**
   * R2: POST {id}/complete -- the explicit completion act.
   *
   * There was no "POST complete" before: the GET stamped the timestamp and
   * the web Finish button was a re-read. That made completion something a
   * page load could do TO a worker (see the GET test above), which F2's lock
   * turned from sloppy into harmful.
   */
  describe('POST complete -- the explicit completion act', () => {
    it('stamps, re-reads, and returns the completed state', async () => {
      const completed = snapshot({ detailsCompletedAt: '2026-09-02T00:00:00.000Z' });
      mockMarkComplete.mockResolvedValue(true);
      mockLoad.mockResolvedValueOnce(snapshot()).mockResolvedValue(completed);

      const res = await handler(post('complete', {}));

      expect(res.statusCode).toBe(200);
      expect(mockMarkComplete).toHaveBeenCalledWith(
        expect.anything(), APP_ID, expect.objectContaining({ applicationId: APP_ID }),
      );
      expect(mockLoad).toHaveBeenCalledTimes(2);
      expect(JSON.parse(res.body).application.details_completed_at).toBe('2026-09-02T00:00:00.000Z');
      expect(sqlCalls()).toContain('COMMIT');
    });

    it('is idempotent on an application that is already complete', async () => {
      // Finish pressed twice, or a reload of the confirmation screen. Not an
      // error, and emphatically not 409 `application_locked`: the worker is
      // asking for the state of something they already sent.
      mockLoad.mockResolvedValue(snapshot({ detailsCompletedAt: '2026-09-02T00:00:00.000Z' }));

      const res = await handler(post('complete', {}));

      expect(res.statusCode).toBe(200);
      expect(mockMarkComplete).not.toHaveBeenCalled();
      expect(mockReleaseLanes).not.toHaveBeenCalled();
      expect(sqlCalls()).toContain('COMMIT');
    });

    it('returns the state (not an error) when something is still outstanding, so the review step can say what', async () => {
      mockMarkComplete.mockResolvedValue(false);

      const res = await handler(post('complete', {}));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).application.details_completed_at).toBeNull();
    });

    it.each([
      ['a hired application', { applicationStatus: 'hired' }, 'application_closed'],
      ['a rejected application', { applicationStatus: 'not_interested' }, 'application_closed'],
      ['a filled job', { jobStatus: 'filled' }, 'application_closed'],
      ['an apply-stage application nobody asked about', { stage: 'apply' }, 'stage_locked'],
    ])('refuses to complete %s', async (_label, overrides, error) => {
      mockLoad.mockResolvedValue(snapshot(overrides));

      const res = await handler(post('complete', {}));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(error);
      expect(mockMarkComplete).not.toHaveBeenCalled();
      expect(sqlCalls()).not.toContain('COMMIT');
    });

    it('refuses a GET on the completion action', async () => {
      const res = await handler(makeEvent({
        httpMethod: 'GET', pathParameters: { applicationId: APP_ID, action: 'complete' },
      }));
      expect(res.statusCode).toBe(405);
    });

    it('after completing, an edit is refused with 409 application_locked', async () => {
      mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason: 'locked' });

      const res = await handler(post('answers', { answers: { years_experience: 7 } }));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('application_locked');
    });
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
    expect(JSON.parse(res.body).state.application.id).toBe(APP_ID);
    expect(timeline()).toEqual(REFUSED_WITH_STATE);
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
      // The explicit worker_id predicate proves ownership, and the status
      // predicate keeps a row that is not a hire from being marked as one.
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
    // Was `complete` until R2 made that a real action.
    const res = await handler(post('finalise', {}));

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

    it('DOES release on the explicit completion POST when it flips details_completed_at', async () => {
      // The document-last worker. A file uploaded through `/worker/vault/*`
      // never touches the requirements engine, so the synced load this POST
      // performs is what closes their stage -- and because
      // `markDetailsCompleteIfDone` flips only `WHERE details_completed_at IS
      // NULL`, no later POST can ever report `detailsCompleted: true` for
      // that application. Missing this call left those workers re-prompted
      // forever. R2 moved it off the GET, not away.
      mockMarkComplete.mockResolvedValue(true);

      const res = await handler(post('complete', {}));

      expect(res.statusCode).toBe(200);
      expect(mockReleaseLanes).toHaveBeenCalledTimes(1);
      expect(mockReleaseLanes).toHaveBeenCalledWith(expect.anything(), {
        workerId: WORKER_ID,
        applicationId: APP_ID,
        jobTitle: 'Concrete Finisher',
        lang: 'es',
      });
    });

    it('does NOT release on a completion POST that changes nothing', async () => {
      mockMarkComplete.mockResolvedValue(false);

      const res = await handler(post('complete', {}));

      expect(res.statusCode).toBe(200);
      expect(mockReleaseLanes).not.toHaveBeenCalled();
    });

    it('releases on the completion POST BEFORE buildState flips the 031 GUC', async () => {
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

      await handler(post('complete', {}));

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

  describe('access record and change context', () => {
    const mockRecordAccess = recordAccess as jest.Mock;
    const mockRecordAttempt = recordAttempt as jest.Mock;
    const mockSetAuditContext = setAuditContext as jest.Mock;
    const worker = callerFor('worker', WORKER_ID);
    const client = expect.objectContaining({ query: mockQuery });
    const stateFields = ['answers', 'application', 'certifications', 'documents', 'job', 'next_step', 'prompt_answers', 'remaining'];
    const readEvent = {
      surface: 'worker.application_details',
      subjectUserIds: [WORKER_ID],
      recordIds: [APP_ID],
      resultCount: 1,
      fieldNames: stateFields,
      purpose: { kind: 'self' },
    };

    beforeEach(() => {
      mockRecordAccess.mockResolvedValue(undefined);
      mockRecordAttempt.mockResolvedValue(undefined);
      mockSetAuditContext.mockResolvedValue(undefined);
    });

    it('states the worker as the actor before the snapshot sync can write', async () => {
      await handler(withRequestId(makeEvent()));
      expect(mockSetAuditContext).toHaveBeenCalledWith(client, worker, 'worker.application_details');
      expect(mockSetAuditContext.mock.invocationCallOrder[0]).toBeLessThan(mockLoad.mock.invocationCallOrder[0]);
      expect(mockSetAuditContext.mock.invocationCallOrder[0])
        .toBeGreaterThan(mockSetInternalUserRlsContext.mock.invocationCallOrder[0]);
    });

    it('GET records the state it returns before employer_display_name and COMMIT', async () => {
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(200);
      expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(stateFields);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, worker, readEvent);
      const recorded = mockRecordAccess.mock.invocationCallOrder[0];
      expect(recorded).toBeLessThan(queryOrder(mockQuery, /employer_id FROM jobs/));
      expect(recorded).toBeLessThan(queryOrder(mockQuery, /employer_display_name/));
      expect(recorded).toBeLessThan(queryOrder(mockQuery, 'COMMIT'));
      expect(recorded).toBeGreaterThan(mockLoad.mock.invocationCallOrder[0]);
    });

    it('a successful write records the fresh state it returns', async () => {
      mockMergePromptAnswers.mockResolvedValue({ ok: true });
      const res = await handler(withRequestId(post('prompt-answers', { answers: { p1: 'yes' } })));
      expect(res.statusCode).toBe(200);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, worker, readEvent);
      expect(mockRecordAccess.mock.invocationCallOrder[0]).toBeLessThan(queryOrder(mockQuery, 'COMMIT'));
    });

    it('a refused merge rolls back to its savepoint, then records the state it returns in the same transaction', async () => {
      mockMergePromptAnswers.mockResolvedValue({ ok: false, reason: 'closed' });
      const res = await handler(withRequestId(post('prompt-answers', { answers: { p1: 'yes' } })));
      expect(res.statusCode).toBe(409);
      expect(Object.keys(JSON.parse(res.body).state).sort()).toEqual(stateFields);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, worker, readEvent);
      const recorded = mockRecordAccess.mock.invocationCallOrder[0];
      // One transaction: its only BEGIN opens it, nothing rolls the whole of
      // it back, and the record lands after the return to the savepoint and
      // before the employer queries and the COMMIT.
      expect(sqlCalls().filter((q) => q === 'BEGIN')).toHaveLength(1);
      expect(sqlCalls()).not.toContain('ROLLBACK');
      expect(recorded).toBeGreaterThan(queryOrder(mockQuery, `ROLLBACK TO SAVEPOINT ${WRITE_SAVEPOINT}`));
      expect(recorded).toBeLessThan(queryOrder(mockQuery, /employer_id FROM jobs/));
      expect(recorded).toBeLessThan(queryOrder(mockQuery, 'COMMIT'));
    });

    it('records a not_found attempt after the ROLLBACK when the application vanishes under a merge', async () => {
      mockMergePromptAnswers.mockResolvedValue({ ok: false, reason: 'not_found' });
      const res = await handler(withRequestId(post('prompt-answers', { answers: { p1: 'yes' } })));
      expect(res.statusCode).toBe(404);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, worker, {
        surface: 'worker.application_details', outcome: 'not_found', recordIds: [APP_ID], subjectUserIds: [WORKER_ID],
      });
    });

    it('records nothing for a merge refused as invalid, which returns no state', async () => {
      mockMergePromptAnswers.mockResolvedValue({ ok: false, reason: 'invalid', errors: {} });
      const res = await handler(withRequestId(post('prompt-answers', { answers: { p1: 'yes' } })));
      expect(res.statusCode).toBe(400);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expect(mockRecordAttempt).not.toHaveBeenCalled();
    });

    it('a failed merge whose read cannot be recorded answers 500 with no state', async () => {
      mockMergePromptAnswers.mockResolvedValue({ ok: false, reason: 'closed' });
      mockRecordAccess.mockRejectedValue(new Error('audit'));
      const res = await handler(withRequestId(post('prompt-answers', { answers: { p1: 'yes' } })));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(sqlCalls()).not.toContain('COMMIT');
      expect(mockRecordAttempt.mock.calls[0][2]).toEqual({
        surface: 'worker.application_details', outcome: 'failed', recordIds: [APP_ID], subjectUserIds: [WORKER_ID],
      });
    });

    it('answers 500 with no state when the GET record cannot be written', async () => {
      mockRecordAccess.mockRejectedValue(new Error('audit'));
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(sqlCalls()).not.toContain('COMMIT');
      expect(sqlCalls().some((q) => /employer_display_name/.test(q))).toBe(false);
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
    });

    it('records a not_found attempt after the ROLLBACK for another worker\'s application', async () => {
      mockQuery.mockImplementation((sql: string) =>
        Promise.resolve(/FROM job_applications/.test(sql) ? { rows: [] } : defaultQuery(sql)));
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(404);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, worker, {
        surface: 'worker.application_details', outcome: 'not_found', recordIds: [APP_ID], subjectUserIds: [WORKER_ID],
      });
    });

    it('records nothing before the worker is known, at the legal wall, or for refusals', async () => {
      mockQuery.mockImplementation((sql: string) =>
        Promise.resolve(/resolve_worker_internal_id/.test(sql) ? { rows: [{ id: null }] } : defaultQuery(sql)));
      expect((await handler(makeEvent())).statusCode).toBe(404);
      mockQuery.mockImplementation((sql: string) =>
        Promise.resolve(/tos_version/.test(sql) ? { rows: [{ tos_version: 'v0' }] } : defaultQuery(sql)));
      expect((await handler(makeEvent())).statusCode).toBe(403);
      mockQuery.mockImplementation((sql: string) => Promise.resolve(defaultQuery(sql)));
      expect((await handler(makeEvent({ httpMethod: 'DELETE' }))).statusCode).toBe(405);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expect(mockRecordAttempt).not.toHaveBeenCalled();
    });
  });

  // ── The transaction, statement by statement ─────────────────────────
  //
  // Each list is a request's whole transaction, in order (see `timeline`).
  // A write door takes a savepoint before its snapshot load. A write refused
  // with the state rolls back to that savepoint, then records and commits the
  // state it returns, so the read and its record commit together. The write
  // doors gain only the savepoint statements; every other path sends exactly
  // the statements it sent before.
  describe('the transaction, statement by statement', () => {
    const SAVEPOINT = `SAVEPOINT ${WRITE_SAVEPOINT}`;
    const RELEASE = `RELEASE SAVEPOINT ${WRITE_SAVEPOINT}`;
    const ROLLBACK_TO = `ROLLBACK TO SAVEPOINT ${WRITE_SAVEPOINT}`;
    const mockRecordAccess = recordAccess as jest.Mock;
    const merges: Record<string, jest.Mock> = {
      answers: mockMergeFieldAnswers,
      certifications: mockMergeCertificationClaims,
      'prompt-answers': mockMergePromptAnswers,
    };
    const writeBodies: Record<string, unknown> = {
      answers: { answers: { years_experience: 7 } },
      certifications: { claims: [{ name: 'OSHA 10' }] },
      'prompt-answers': { answers: { p1: 'yes' } },
    };
    const capError = () => Object.assign(new Error('cap'), { code: '23514', constraint: 'certification_document_limit' });
    const quiet = () => { jest.spyOn(console, 'error').mockImplementation(() => undefined); };
    const withQuery = (match: RegExp, result: unknown) => () => {
      mockQuery.mockImplementation((sql: string) => Promise.resolve(match.test(sql) ? result : defaultQuery(sql)));
    };

    it.each([
      ['answers', 'stage_locked', 'stage_locked'],
      ['answers', 'closed', 'application_closed'],
      ['answers', 'locked', 'application_locked'],
      ['certifications', 'stage_locked', 'stage_locked'],
      ['certifications', 'closed', 'application_closed'],
      ['certifications', 'locked', 'application_locked'],
      ['prompt-answers', 'closed', 'application_closed'],
    ])('POST %s refused as %s: one BEGIN, the savepoint and the return to it, then the record and the COMMIT', async (door, reason, error) => {
      merges[door].mockResolvedValue({ ok: false, reason });

      const res = await handler(post(door, writeBodies[door]));

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(['error', 'state']);
      expect(body.error).toBe(error);
      expect(timeline()).toEqual(REFUSED_WITH_STATE);
    });

    it('a refused write returns exactly the state a GET returns', async () => {
      const read = JSON.parse((await handler(makeEvent())).body);
      mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason: 'locked' });

      const refused = JSON.parse((await handler(post('answers', writeBodies.answers))).body);

      expect(refused).toEqual({ error: 'application_locked', state: read });
    });

    it.each<[string, () => void, () => APIGatewayProxyEvent, number, string[]]>([
      ['a GET', () => undefined, () => makeEvent(), 200,
        [...ENTRY_STEPS, 'load', ...STATE_STEPS]],
      ['a GET whose application vanished after the ownership check', () => { mockLoad.mockResolvedValue(null); },
        () => makeEvent(), 404, [...ENTRY_STEPS, 'load', 'ROLLBACK', 'attempt']],
      ['a GET whose load reaches a document cap', () => { mockLoad.mockRejectedValue(capError()); },
        () => makeEvent(), 409, [...ENTRY_STEPS, 'load', 'ROLLBACK']],
      ['a GET whose load fails', () => { quiet(); mockLoad.mockRejectedValue(new Error('boom')); },
        () => makeEvent(), 500, [...ENTRY_STEPS, 'load', 'ROLLBACK', 'attempt']],
      ['a GET whose record cannot be written', () => { quiet(); mockRecordAccess.mockRejectedValue(new Error('audit')); },
        () => makeEvent(), 500, [...ENTRY_STEPS, 'load', 'record', 'ROLLBACK', 'attempt']],
      ['a completion that stamps the application', () => { mockMarkComplete.mockResolvedValue(true); },
        () => post('complete', {}), 200, [...ENTRY_STEPS, 'load', 'mark complete', 'load', 'release lanes', ...STATE_STEPS]],
      ['a completion with something still outstanding', () => undefined,
        () => post('complete', {}), 200, [...ENTRY_STEPS, 'load', 'mark complete', ...STATE_STEPS]],
      ['a completion of an application already sent',
        () => { mockLoad.mockResolvedValue(snapshot({ detailsCompletedAt: '2026-09-02T00:00:00.000Z' })); },
        () => post('complete', {}), 200, [...ENTRY_STEPS, 'load', ...STATE_STEPS]],
      ['a completion of a closed application', () => { mockLoad.mockResolvedValue(snapshot({ applicationStatus: 'hired' })); },
        () => post('complete', {}), 409, [...ENTRY_STEPS, 'load', 'ROLLBACK']],
      ['a hire acknowledgement',
        withQuery(/^UPDATE job_applications/, { rowCount: 1, rows: [{ hired_seen_at: '2026-09-04T16:00:00.000Z', hired_ack_at: null }] }),
        () => post('hire-ack', { step: 'seen' }), 200, [...ENTRY_STEPS, 'hire-ack update', 'COMMIT']],
      ['a hire acknowledgement with an unknown step', () => undefined,
        () => post('hire-ack', { step: 'nonsense' }), 400, [...ENTRY_STEPS, 'ROLLBACK']],
      ['a sub that resolves to no worker', withQuery(/resolve_worker_internal_id/, { rows: [{ id: null }] }),
        () => makeEvent(), 404, ['BEGIN', 'resolve worker', 'ROLLBACK']],
      ['a worker on an old terms version', withQuery(/tos_version/, { rows: [{ tos_version: 'v0.9' }] }),
        () => makeEvent(), 403, ['BEGIN', 'resolve worker', 'user context', 'audit context', 'terms', 'ROLLBACK']],
      ["a write to another worker's application", withQuery(/FROM job_applications/, { rows: [] }),
        () => post('answers', writeBodies.answers), 404, [...ENTRY_STEPS, 'ROLLBACK', 'attempt']],
      ['an unknown action', () => undefined, () => post('finalise', {}), 404, [...ENTRY_STEPS, 'ROLLBACK']],
      ['a GET on a write door', () => undefined,
        () => makeEvent({ pathParameters: { applicationId: APP_ID, action: 'answers' } }), 405, [...ENTRY_STEPS, 'ROLLBACK']],
    ])('%s sends the statements it always sent, with no savepoint', async (_label, arrange, request, status, expected) => {
      arrange();

      const res = await handler(request());

      expect(res.statusCode).toBe(status);
      expect(timeline()).toEqual(expected);
    });

    it.each<[string, () => void, () => APIGatewayProxyEvent, number, string[]]>([
      ['a merged answer',
        () => { mockMergeFieldAnswers.mockResolvedValue({ ok: true, keys: ['years_experience'], detailsCompleted: false }); },
        () => post('answers', writeBodies.answers), 200,
        [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', RELEASE, 'load', ...STATE_STEPS]],
      ['a merged answer that completes the details stage',
        () => { mockMergeFieldAnswers.mockResolvedValue({ ok: true, keys: ['years_experience'], detailsCompleted: true }); },
        () => post('answers', writeBodies.answers), 200,
        [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', RELEASE, 'load', 'release lanes', ...STATE_STEPS]],
      ['a merged certification claim',
        () => { mockMergeCertificationClaims.mockResolvedValue({ ok: true, certifications: [], detailsCompleted: false }); },
        () => post('certifications', writeBodies.certifications), 200,
        [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', RELEASE, 'load', ...STATE_STEPS]],
      ['a merged prompt answer, the last one outstanding',
        () => { mockMergePromptAnswers.mockResolvedValue({ ok: true, keys: ['p1'] }); },
        () => post('prompt-answers', writeBodies['prompt-answers']), 200,
        [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', RELEASE, 'load', 'release prompt lane', ...STATE_STEPS]],
      ['a merge refused as invalid',
        () => { mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason: 'invalid', errors: { years_experience: 'unknown_answer_key' } }); },
        () => post('answers', writeBodies.answers), 400, [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', 'ROLLBACK']],
      ['a merge refused as too large', () => { mockMergePromptAnswers.mockResolvedValue({ ok: false, reason: 'too_large' }); },
        () => post('prompt-answers', writeBodies['prompt-answers']), 400, [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', 'ROLLBACK']],
      ['a merge refused at the document cap',
        () => { mockMergeCertificationClaims.mockResolvedValue({ ok: false, reason: 'certification_document_limit' }); },
        () => post('certifications', writeBodies.certifications), 409, [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', 'ROLLBACK']],
      ['a merge whose application vanished', () => { mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason: 'not_found' }); },
        () => post('answers', writeBodies.answers), 404, [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', 'ROLLBACK', 'attempt']],
      ['a merge whose fresh state vanished', () => {
        mockMergeFieldAnswers.mockResolvedValue({ ok: true, keys: ['years_experience'], detailsCompleted: false });
        mockLoad.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(null);
      }, () => post('answers', writeBodies.answers), 404,
      [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', RELEASE, 'load', 'ROLLBACK', 'attempt']],
      ['a malformed answers batch', () => undefined,
        () => post('answers', { answers: 'nope' }), 400, [...ENTRY_STEPS, SAVEPOINT, 'load', 'ROLLBACK']],
      ['an answers batch with a __proto__ key', () => undefined,
        () => makeEvent({
          httpMethod: 'POST',
          pathParameters: { applicationId: APP_ID, action: 'answers' },
          body: '{"answers":{"__proto__":{"polluted":true}}}',
        }), 400, [...ENTRY_STEPS, SAVEPOINT, 'load', 'ROLLBACK']],
      ['a write whose load reaches a document cap', () => { mockLoad.mockRejectedValue(capError()); },
        () => post('answers', writeBodies.answers), 409, [...ENTRY_STEPS, SAVEPOINT, 'load', 'ROLLBACK']],
      ['a write whose application vanished before the merge', () => { mockLoad.mockResolvedValue(null); },
        () => post('answers', writeBodies.answers), 404, [...ENTRY_STEPS, SAVEPOINT, 'load', 'ROLLBACK', 'attempt']],
      ['a merge that fails', () => { quiet(); mockMergeFieldAnswers.mockRejectedValue(new Error('boom')); },
        () => post('answers', writeBodies.answers), 500, [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', 'ROLLBACK', 'attempt']],
      ['a refusal with the state whose record cannot be written', () => {
        quiet();
        mockMergeFieldAnswers.mockResolvedValue({ ok: false, reason: 'locked' });
        mockRecordAccess.mockRejectedValue(new Error('audit'));
      }, () => post('answers', writeBodies.answers), 500,
      [...ENTRY_STEPS, SAVEPOINT, 'load', 'merge', ROLLBACK_TO, 'record', 'ROLLBACK', 'attempt']],
    ])('%s takes the savepoint before its load and otherwise ends as it did', async (_label, arrange, request, status, expected) => {
      arrange();

      const res = await handler(request());

      expect(res.statusCode).toBe(status);
      expect(timeline()).toEqual(expected);
    });
  });
});
