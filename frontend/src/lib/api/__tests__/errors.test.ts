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
    const err = await parseApiError(
      jsonResponse(409, {
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
    const err = new ApiError(409, 'job_limit_reached', { active_job_limit: 1 });
    expect(classifyError(err).payload).toEqual({ active_job_limit: 1 });
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
