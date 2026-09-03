import { describe, expect, it } from 'vitest';
import {
  ApiError,
  classifyError,
  errorMessageKey,
  isRetryableKind,
  parseApiError,
  type ErrorKind,
} from '../errors';
import { LegalWallError } from '../../api';

// vitest runs this suite in the 'node' environment (no jsdom), so responses are
// minimal stubs -- parseApiError only ever touches `status` and `json()`.
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function brokenBodyResponse(status: number, reason: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new SyntaxError(reason); },
  } as unknown as Response;
}

/** The legacy shape page-local fetches still build by hand. */
function legacyError(message: string, status: number, code?: string): Error {
  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}

describe('ApiError', () => {
  it('keeps message === code (pages branch on err.message)', () => {
    const err = new ApiError(404, 'applicant_not_found');
    expect(err.message).toBe('applicant_not_found');
    expect(err.code).toBe('applicant_not_found');
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('mirrors payload.missing_docs onto the top-level field', () => {
    const err = new ApiError(400, 'missing_required_docs', { missing_docs: ['resume'] });
    expect(err.missing_docs).toEqual(['resume']);
    expect(err.payload.missing_docs).toEqual(['resume']);
  });

  it('leaves missing_docs undefined when the payload has none', () => {
    expect(new ApiError(409, 'already_applied').missing_docs).toBeUndefined();
    expect(new ApiError(409, 'already_applied').payload).toEqual({});
  });

  it('carries status 0 for errors that never reached the server', () => {
    expect(new ApiError(0, 'offline').status).toBe(0);
    expect(new ApiError(0, 'timeout').message).toBe('timeout');
  });
});

describe('parseApiError', () => {
  it('uses the backend error code when the body carries one', async () => {
    const err = await parseApiError(jsonResponse(404, { error: 'job_not_found' }), 'fetch_failed');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('job_not_found');
    expect(err.message).toBe('job_not_found');
  });

  it('falls back to the caller code on an empty body', async () => {
    const err = await parseApiError(jsonResponse(500, undefined), 'share_failed');
    expect(err.code).toBe('share_failed');
    expect(err.status).toBe(500);
  });

  it('falls back to the caller code on a non-JSON body', async () => {
    const err = await parseApiError(brokenBodyResponse(502, 'Unexpected token <'), 'fetch_failed');
    expect(err.code).toBe('fetch_failed');
    expect(err.status).toBe(502);
    expect(err.payload).toEqual({});
  });

  it('falls back to the caller code when `error` is not a non-empty string', async () => {
    expect((await parseApiError(jsonResponse(400, { error: 42 }), 'update_failed')).code)
      .toBe('update_failed');
    expect((await parseApiError(jsonResponse(400, { error: '' }), 'update_failed')).code)
      .toBe('update_failed');
  });

  it('ignores a JSON body that is not an object', async () => {
    expect((await parseApiError(jsonResponse(400, 'nope'), 'update_failed')).code).toBe('update_failed');
    expect((await parseApiError(jsonResponse(400, ['nope']), 'update_failed')).code).toBe('update_failed');
    expect((await parseApiError(jsonResponse(400, null), 'update_failed')).code).toBe('update_failed');
  });

  it('keeps allowlisted payload fields and drops everything else', async () => {
    // 403, not 409: all three backend limit gates (employer-jobs-create.ts:230,
    // employer-jobs-update.ts:118, employer-templates-save.ts:175) answer with
    // `statusCode: 403`.
    const err = await parseApiError(
      jsonResponse(403, {
        error: 'job_limit_reached',
        plan_code: 'employer_free',
        active_job_limit: 1,
        active_jobs: 1,
        stack: 'Error: at PostgresPool.query',
        message: 'duplicate key value violates unique constraint',
      }),
      'create_failed',
    );
    expect(err.payload).toEqual({
      plan_code: 'employer_free',
      active_job_limit: 1,
      active_jobs: 1,
    });
    expect(err.payload).not.toHaveProperty('stack');
    expect(err.payload).not.toHaveProperty('message');
  });

  it('allowlists missing_docs and exposes it on both the payload and the error', async () => {
    const err = await parseApiError(
      jsonResponse(400, { error: 'missing_required_docs', missing_docs: ['resume', 'driver_license'] }),
      'apply_failed',
    );
    expect(err.payload.missing_docs).toEqual(['resume', 'driver_license']);
    expect(err.missing_docs).toEqual(['resume', 'driver_license']);
  });

  it('drops a malformed missing_docs rather than handing the UI something it cannot render', async () => {
    const err = await parseApiError(
      jsonResponse(400, { error: 'missing_required_docs', missing_docs: 'resume' }),
      'apply_failed',
    );
    expect(err.missing_docs).toBeUndefined();
    expect(err.payload.missing_docs).toBeUndefined();
    expect(err.code).toBe('missing_required_docs');
  });

  // -------------------------------------------------------------------------
  // blocking_jobs: forward-compat. No backend sends it yet -- the limit dialog
  // derives the list client-side from the employer's jobs -- but once one does,
  // the payload has to arrive already validated: the dialog renders one row per
  // entry, so a malformed value would crash it rather than degrade it.
  // -------------------------------------------------------------------------

  it('allowlists a well-formed blocking_jobs list', async () => {
    const err = await parseApiError(
      jsonResponse(403, {
        error: 'job_limit_reached',
        blocking_jobs: [
          { id: 'job-a', title: 'Landscape Maintenance Tech' },
          { id: 'job-b', title: 'Concrete Finisher' },
        ],
      }),
      'create_failed',
    );
    expect(err.payload.blocking_jobs).toEqual([
      { id: 'job-a', title: 'Landscape Maintenance Tech' },
      { id: 'job-b', title: 'Concrete Finisher' },
    ]);
  });

  it('caps blocking_jobs at the dialog\'s display limit', async () => {
    const err = await parseApiError(
      jsonResponse(403, {
        error: 'job_limit_reached',
        blocking_jobs: Array.from({ length: 9 }, (_unused, i) => ({ id: `job-${i}`, title: `Job ${i}` })),
      }),
      'create_failed',
    );
    expect(err.payload.blocking_jobs).toHaveLength(3);
    expect(err.payload.blocking_jobs?.[0]).toEqual({ id: 'job-0', title: 'Job 0' });
  });

  it.each([
    ['a non-array', 'job-a'],
    ['an object', { id: 'job-a', title: 'Landscape' }],
    ['an array of strings', ['job-a', 'job-b']],
    ['an entry with a non-string id', [{ id: 5, title: 'Landscape' }]],
    ['an entry with a null title', [{ id: 'job-a', title: null }]],
    ['an entry missing title entirely', [{ id: 'job-a' }]],
    ['a null entry', [null]],
    ['one bad entry among good ones', [{ id: 'job-a', title: 'Landscape' }, { id: 'job-b' }]],
  ])('drops blocking_jobs when it is %s', async (_label, blocking_jobs) => {
    const err = await parseApiError(
      jsonResponse(403, { error: 'job_limit_reached', blocking_jobs }),
      'create_failed',
    );
    // The whole key is dropped -- a partially-valid list is still a list the
    // dialog cannot trust, so it falls back to the client-derived one.
    expect(err.payload.blocking_jobs).toBeUndefined();
    expect(err.code).toBe('job_limit_reached');
  });

  it('allowlists certs so the worker apply flow can render the missing-proof list', async () => {
    const err = await parseApiError(
      jsonResponse(400, { error: 'missing_certification_proof', certs: ['osha30', 'welding'] }),
      'apply_failed',
    );
    expect(err.payload.certs).toEqual(['osha30', 'welding']);
  });

  it('drops a malformed certs value rather than handing the UI something it cannot render', async () => {
    const err = await parseApiError(
      jsonResponse(400, { error: 'missing_certification_proof', certs: 'osha30' }),
      'apply_failed',
    );
    expect(err.payload.certs).toBeUndefined();
    expect(err.code).toBe('missing_certification_proof');
  });

  it('allowlists the string-array `missing` of a missing_prompt_answers 400', async () => {
    const err = await parseApiError(
      jsonResponse(400, { error: 'missing_prompt_answers', missing: ['p1', 'p2'] }),
      'apply_failed',
    );
    expect(err.payload.missing).toEqual(['p1', 'p2']);
  });

  it('allowlists the three-bucket `missing` of a details_incomplete 409', async () => {
    // Same key, a different shape, under a different code -- readers
    // discriminate on `err.code`, never on the shape alone.
    const missing = { fields: ['date_available'], docs: ['resume'], certifications: [] };
    const err = await parseApiError(
      jsonResponse(409, { error: 'details_incomplete', missing }),
      'status_update_failed',
    );
    expect(err.payload.missing).toEqual(missing);
  });

  it('drops a `missing` that is neither shape', async () => {
    const err = await parseApiError(
      jsonResponse(409, { error: 'details_incomplete', missing: { fields: 'date_available' } }),
      'status_update_failed',
    );
    expect(err.payload.missing).toBeUndefined();
    expect(err.code).toBe('details_incomplete');
  });

  it('keeps the legal-wall payload fields the accept page reads', async () => {
    const err = await parseApiError(
      jsonResponse(403, { error: 'legal_required', requiredVersion: 'v3', currentVersion: 'v2', required: ['tos'] }),
      'fetch_failed',
    );
    expect(err.payload).toEqual({ requiredVersion: 'v3', currentVersion: 'v2', required: ['tos'] });
  });
});

describe('classifyError', () => {
  it('maps a LegalWallError to legal_wall', () => {
    const result = classifyError(new LegalWallError());
    expect(result.kind).toBe('legal_wall');
    expect(result.code).toBe('legal_required');
    expect(result.status).toBe(403);
    expect(result.retryable).toBe(false);
  });

  it('maps ApiError(0, "timeout") to timeout', () => {
    expect(classifyError(new ApiError(0, 'timeout'))).toMatchObject({
      kind: 'timeout',
      status: 0,
      code: 'timeout',
      retryable: true,
    });
  });

  it('maps ApiError(0, ...) without the timeout code to offline', () => {
    expect(classifyError(new ApiError(0, 'offline'))).toMatchObject({
      kind: 'offline',
      status: 0,
      retryable: true,
    });
  });

  it('maps a raw fetch TypeError to offline', () => {
    expect(classifyError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'offline',
      retryable: true,
    });
  });

  const statusRows: Array<[number, ErrorKind, boolean]> = [
    [401, 'unauthorized', false],
    [403, 'forbidden', false],
    [404, 'not_found', false],
    [410, 'gone', false],
    [409, 'conflict', false],
    [400, 'validation', false],
    [422, 'validation', false],
    [429, 'rate_limited', true],
    [500, 'server', true],
    [502, 'server', true],
    [503, 'server', true],
  ];

  it.each(statusRows)('maps an ApiError with status %i to %s', (status, kind, retryable) => {
    expect(classifyError(new ApiError(status, 'some_code'))).toMatchObject({
      kind,
      status,
      code: 'some_code',
      retryable,
    });
  });

  it.each(statusRows)('maps a legacy Error & { status: %i } to %s', (status, kind, retryable) => {
    expect(classifyError(legacyError('boom', status))).toMatchObject({
      kind,
      status,
      retryable,
    });
  });

  it('prefers a legacy error `code` over its message, and falls back to the message', () => {
    expect(classifyError(legacyError('boom', 404, 'applicant_not_found')).code).toBe('applicant_not_found');
    expect(classifyError(legacyError('applicant_not_found', 404)).code).toBe('applicant_not_found');
  });

  it('surfaces the ApiError payload for the caller', () => {
    const err = new ApiError(403, 'job_limit_reached', { active_job_limit: 1 });
    expect(classifyError(err).payload).toEqual({ active_job_limit: 1 });
  });

  it('classifies a plan-limit 403 as `forbidden` while preserving its payload', () => {
    // The plan-limit codes arrive as 403, so the classifier calls them
    // `forbidden` -- the same kind as a genuine permission denial. That is
    // deliberate: `useErrorMessage` overrides are keyed by kind, so a new kind
    // here would change copy for every unrelated 403. Callers that want the
    // limit dialog branch on `err.code` BEFORE classifying (see lib/plan-limit).
    const err = new ApiError(403, 'job_limit_reached', {
      plan_code: 'employer_free',
      active_job_limit: 1,
      active_jobs: 1,
    });
    const classified = classifyError(err);

    expect(classified.kind).toBe('forbidden');
    expect(classified.retryable).toBe(false);
    expect(classified.payload).toEqual({
      plan_code: 'employer_free',
      active_job_limit: 1,
      active_jobs: 1,
    });
  });

  it('maps an unmapped status (e.g. 418) to unknown', () => {
    expect(classifyError(new ApiError(418, 'teapot')).kind).toBe('unknown');
  });

  it('maps anything that is not a recognisable error to unknown', () => {
    for (const value of [new Error('plain'), 'a string', undefined, null, 42, {}, { status: 500 }]) {
      expect(classifyError(value)).toEqual({ kind: 'unknown', retryable: false });
    }
  });

  it('ignores a non-numeric status on an Error', () => {
    const err = new Error('boom') as Error & { status?: unknown };
    err.status = '500';
    expect(classifyError(err).kind).toBe('unknown');
  });
});

describe('errorMessageKey / isRetryableKind', () => {
  const allKinds: ErrorKind[] = [
    'offline', 'timeout', 'unauthorized', 'forbidden', 'not_found', 'gone',
    'conflict', 'validation', 'rate_limited', 'server', 'legal_wall', 'unknown',
  ];

  it.each(allKinds.filter((k) => k !== 'legal_wall'))('maps %s to its own common key', (kind) => {
    expect(errorMessageKey(kind)).toBe(`errors.${kind}`);
  });

  it('maps legal_wall to the generic key (it should have been redirected first)', () => {
    expect(errorMessageKey('legal_wall')).toBe('errors.unknown');
  });

  it('marks exactly the transient kinds retryable', () => {
    const retryable = allKinds.filter(isRetryableKind);
    expect(retryable).toEqual(['offline', 'timeout', 'rate_limited', 'server']);
  });
});
