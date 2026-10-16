import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-job-public-listing';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const EMPLOYER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREMAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ownerActor = (scopeUserIds: string[] = [EMPLOYER_ID]) => ({
  ok: true,
  actor: { userId: EMPLOYER_ID, organizationId: ORG_ID, role: 'owner', scopeUserIds },
});

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'emp-sub' } } },
    pathParameters: { jobId: JOB_ID },
    body: JSON.stringify({ enabled: true }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('employer-job-public-listing', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockResolvedValue(ownerActor());
  });
  afterAll(() => { process.env = env; });

  function mockUpdateReturning(rows: unknown[]) {
    mockQuery.mockImplementation((q: string) => {
      if (typeof q === 'string' && q.includes('UPDATE jobs SET public_listing_enabled')) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await handler(makeEvent({ requestContext: { authorizer: { claims: {} } } } as any));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-boolean enabled — publishing is a consent action, no coercion', async () => {
    for (const bad of ['true', 1, null, undefined, {}]) {
      const res = await handler(makeEvent({ body: JSON.stringify({ enabled: bad }) }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_enabled');
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a malformed job id before touching the database', async () => {
    const res = await handler(makeEvent({ pathParameters: { jobId: 'not-a-uuid' } }));
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('turns a listing on for the owning employer', async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: true }]);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: JOB_ID, public_listing_enabled: true });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'emp-sub');
    // The ownership scope lives inside the statement itself.
    const update = mockQuery.mock.calls.find((c) => /UPDATE jobs SET public_listing_enabled/.test(c[0]));
    expect(update[0]).toContain('j.employer_id = ANY($3::uuid[])');
    expect(update[0]).not.toContain('cognito_sub');
    expect(update[1]).toEqual([true, JOB_ID, [EMPLOYER_ID]]);
  });

  it('turns a listing off with the same shape', async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: false }]);
    const res = await handler(makeEvent({ body: JSON.stringify({ enabled: false }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).public_listing_enabled).toBe(false);
  });

  it("returns 404 for another employer's job — indistinguishable from not-found", async () => {
    // The ownership CTE matches nothing, so the UPDATE returns zero rows.
    mockUpdateReturning([]);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('job_not_found');
    // And the transaction is rolled back, not committed.
    const verbs = mockQuery.mock.calls.map((c) => c[0]);
    expect(verbs).toContain('ROLLBACK');
    expect(verbs).not.toContain('COMMIT');
  });

  it('gates on legal compliance like every other employer endpoint', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });

  // ---------------------------------------------------------------------------
  // Visibility-event hook -- transition matrix
  // ---------------------------------------------------------------------------

  function findEnqueueCall() {
    return mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('enqueue_job_visibility_event'));
  }

  it("enqueues 'published' on false->true while the job is active", async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: true, status: 'active', old_enabled: false }]);
    const res = await handler(makeEvent({ body: JSON.stringify({ enabled: true }) }));
    expect(res.statusCode).toBe(200);
    const enqueueCall = findEnqueueCall();
    expect(enqueueCall).toBeDefined();
    expect(enqueueCall![1]).toEqual([JOB_ID, 'JOBCOD', 'published']);
    // Must be inside the same transaction, before COMMIT.
    const calls = mockQuery.mock.calls.map((c) => c[0]);
    expect(calls.indexOf(calls.find((c) => typeof c === 'string' && c.includes('enqueue_job_visibility_event')))).toBeLessThan(calls.indexOf('COMMIT'));
  });

  it("enqueues 'removed' on true->false while the job is active", async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: false, status: 'active', old_enabled: true }]);
    const res = await handler(makeEvent({ body: JSON.stringify({ enabled: false }) }));
    expect(res.statusCode).toBe(200);
    const enqueueCall = findEnqueueCall();
    expect(enqueueCall![1]).toEqual([JOB_ID, 'JOBCOD', 'removed']);
  });

  it('does NOT enqueue when turning on a listing for a paused (non-active) job', async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: true, status: 'paused', old_enabled: false }]);
    const res = await handler(makeEvent({ body: JSON.stringify({ enabled: true }) }));
    expect(res.statusCode).toBe(200);
    expect(findEnqueueCall()).toBeUndefined();
  });

  it('does NOT enqueue on a no-op write (already enabled, staying enabled)', async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: true, status: 'active', old_enabled: true }]);
    const res = await handler(makeEvent({ body: JSON.stringify({ enabled: true }) }));
    expect(res.statusCode).toBe(200);
    expect(findEnqueueCall()).toBeUndefined();
  });

  it('does NOT enqueue on a no-op write (already disabled, staying disabled)', async () => {
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: false, status: 'active', old_enabled: false }]);
    const res = await handler(makeEvent({ body: JSON.stringify({ enabled: false }) }));
    expect(res.statusCode).toBe(200);
    expect(findEnqueueCall()).toBeUndefined();
  });

  it("passes the owner's whole scope as the uuid[] parameter", async () => {
    mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));
    mockUpdateReturning([{ id: JOB_ID, public_code: 'JOBCOD', public_listing_enabled: true, status: 'paused', old_enabled: false }]);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(mockResolveEmployerActor).toHaveBeenCalledWith(expect.anything(), 'emp-sub');
    const update = mockQuery.mock.calls.find((c) => /UPDATE jobs SET public_listing_enabled/.test(c[0]));
    expect(update[1]).toEqual([true, JOB_ID, [EMPLOYER_ID, FOREMAN_ID]]);
  });

  it('returns the actor failure, rolls back, and touches no job when the membership is inactive', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });
    mockUpdateReturning([]);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    const verbs = mockQuery.mock.calls.map((c) => c[0]);
    expect(verbs).toContain('ROLLBACK');
    expect(verbs).not.toContain('COMMIT');
    expect(verbs.some((v) => typeof v === 'string' && v.includes('UPDATE jobs'))).toBe(false);
  });
});
