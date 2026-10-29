import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-team-job-reassign';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { readCompanyUsage, CompanyUsageRefusedError } from '../../../../lambda/lib/company-usage';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/company-usage', () => ({
  ...jest.requireActual('../../../../lambda/lib/company-usage'),
  readCompanyUsage: jest.fn(),
}));
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockReadCompanyUsage = readCompanyUsage as jest.Mock;
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREMAN_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREMAN_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const JOB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SCOPE = [OWNER_ID, FOREMAN_A, FOREMAN_B];

const actor = (role: 'owner' | 'foreman') => ({
  ok: true,
  actor: {
    userId: role === 'owner' ? OWNER_ID : FOREMAN_A,
    organizationId: ORG_ID,
    role,
    scopeUserIds: role === 'owner' ? SCOPE : [FOREMAN_A],
  },
});

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const order: string[] = [];

let jobRows: Array<{ employer_id: string }>;
let assigneeRows: Array<{ status: string }>;
let updateResult: { rowCount: number } | Error;
let movedError: unknown;

const makeEvent = (body: unknown, method = 'POST') => ({
  httpMethod: method,
  pathParameters: { action: 'reassign' },
  requestContext: { authorizer: { claims: { sub: 'owner-sub' } } },
  body: body === undefined ? null : JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

const validBody = { jobId: JOB_ID, userId: FOREMAN_B };
const movedCalls = () => mockQuery.mock.calls.filter(([sql]) => String(sql).includes('jale_cap.org_job_moved'));
const jobsUpdates = () => mockQuery.mock.calls.filter(([sql]) => /UPDATE\s+jobs/i.test(String(sql)));

describe('employer-team-job-reassign', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    jobRows = [{ employer_id: FOREMAN_A }];
    assigneeRows = [{ status: 'active' }];
    updateResult = { rowCount: 1 };
    movedError = undefined;
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockResolvedValue(actor('owner'));
    mockReadCompanyUsage.mockImplementation(async (_c: unknown, options?: { lock?: boolean }) => {
      order.push(options?.lock === true ? 'lock' : 'usage');
      return { organizationId: ORG_ID, activeJobs: 1, templates: 0, activeForemen: 2, suspendedForemen: 0, pendingInvites: 0 };
    });
    mockQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        order.push(sql);
        return Promise.resolve({ rows: [] });
      }
      if (/SELECT\s+employer_id\s+FROM\s+jobs/i.test(sql)) {
        order.push('job');
        return Promise.resolve({ rows: jobRows });
      }
      if (/FROM\s+organization_members/i.test(sql)) {
        order.push('assignee');
        return Promise.resolve({ rows: assigneeRows });
      }
      if (/UPDATE\s+jobs/i.test(sql)) {
        order.push('update');
        if (updateResult instanceof Error) return Promise.reject(updateResult);
        return Promise.resolve({ rows: [], rowCount: updateResult.rowCount });
      }
      if (sql.includes('jale_cap.org_job_moved')) {
        order.push('moved');
        if (movedError) return Promise.reject(movedError);
        return Promise.resolve({ rows: [{ org_job_moved: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
  });

  it('owner moves a job to an active foreman; created_by_user_id is never in the SQL', async () => {
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jobId: JOB_ID, assigneeUserId: FOREMAN_B, changed: true });
    expect(order).toEqual(['BEGIN', 'lock', 'job', 'assignee', 'update', 'moved', 'COMMIT']);
    for (const [sql] of mockQuery.mock.calls) expect(String(sql)).not.toMatch(/created_by_user_id/);
    const jobRead = mockQuery.mock.calls.find(([s]) => /SELECT\s+employer_id\s+FROM\s+jobs/i.test(String(s)));
    expect(String(jobRead?.[0])).toMatch(/employer_id\s*=\s*ANY\(\$2::uuid\[\]\)/);
    expect(jobRead?.[1]).toEqual([JOB_ID, SCOPE]);
    const assigneeRead = mockQuery.mock.calls.find(([s]) => /FROM\s+organization_members/i.test(String(s)));
    expect(assigneeRead?.[1]).toEqual([FOREMAN_B, ORG_ID]);
    const [[sql, params]] = jobsUpdates();
    expect(sql).toMatch(/SET\s+employer_id\s*=\s*\$2/);
    expect(sql).toMatch(/billing_paused_at\s*=\s*NULL/);
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/);
    expect(params).toEqual([JOB_ID, FOREMAN_B, FOREMAN_A]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('the move leaves the thread notice: org_job_moved([job], from, to, false), inside the transaction before COMMIT', async () => {
    await handler(makeEvent(validBody));

    const calls = movedCalls();
    expect(calls).toHaveLength(1);
    const [sql, params] = calls[0];
    expect(String(sql)).toMatch(/^SELECT jale_cap\.org_job_moved\(\$1::uuid\[\], \$2::uuid, \$3::uuid, false\)$/);
    expect(params).toEqual([[JOB_ID], FOREMAN_A, FOREMAN_B]);
    expect(order.indexOf('moved')).toBeGreaterThan(order.indexOf('update'));
    expect(order.indexOf('moved')).toBeLessThan(order.indexOf('COMMIT'));
  });

  it('upper-case UUIDs in the body are lower-cased and still found', async () => {
    const res = await handler(makeEvent({ jobId: JOB_ID.toUpperCase(), userId: FOREMAN_B.toUpperCase() }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jobId: JOB_ID, assigneeUserId: FOREMAN_B, changed: true });
    expect(jobsUpdates()[0][1]).toEqual([JOB_ID, FOREMAN_B, FOREMAN_A]);
  });

  it('unchanged when the assignee already holds it', async () => {
    jobRows = [{ employer_id: FOREMAN_B }];
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jobId: JOB_ID, assigneeUserId: FOREMAN_B, changed: false });
    expect(jobsUpdates()).toHaveLength(0);
    expect(movedCalls()).toHaveLength(0);
  });

  it('foreman: 403 owner_required', async () => {
    mockResolveEmployerActor.mockResolvedValue(actor('foreman'));
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
    expect(mockReadCompanyUsage).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('a job outside the company: 404', async () => {
    jobRows = [];
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_not_found' });
    expect(jobsUpdates()).toHaveLength(0);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('a job deleted between the read and the move: 404', async () => {
    updateResult = { rowCount: 0 };
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_not_found' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(movedCalls()).toHaveLength(0);
  });

  it.each([
    ['a removed member', [{ status: 'removed' }]],
    ['a suspended member', [{ status: 'suspended' }]],
    ['no member of this company', []],
  ])('assignee is %s: 409 invalid_assignee, no move', async (_label, rows) => {
    assigneeRows = rows;
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_assignee' });
    expect(jobsUpdates()).toHaveLength(0);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it.each(['assignee_not_member', 'assignee_inactive', 'assignee_other_company', 'job_employer_not_member'])(
    'a 129 refusal raised by the UPDATE: 409 invalid_assignee (%s)',
    async (detail) => {
      updateResult = Object.assign(new Error('jobs: a job moves only to an active member of its own company'), { code: '42501', detail });
      const res = await handler(makeEvent(validBody));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_assignee' });
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    },
  );

  it('a refusal of org_job_moved (P0001 org_job_moved_refused): 500 internal_error, ROLLBACK, no COMMIT, a structured log line', async () => {
    movedError = Object.assign(new Error('org_job_moved: refused'), { code: 'P0001', detail: 'org_job_moved_refused' });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(makeEvent(validBody));
    const logged = err.mock.calls.map((c) => String(c[0]));
    err.mockRestore();

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(order).not.toContain('COMMIT');
    expect(order[order.length - 1]).toBe('ROLLBACK');
    expect(mockQuery.mock.calls[mockQuery.mock.calls.length - 1][0]).toBe('ROLLBACK');
    expect(logged).toContain(JSON.stringify({ event: 'org_job_moved_refused', handler: 'employer-team-job-reassign', jobId: JOB_ID, organizationId: ORG_ID }));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a P0001 without the refusal DETAIL', { code: 'P0001' }],
    ['a P0001 with another DETAIL', { code: 'P0001', detail: 'something_else' }],
    ['an invalid_parameter_value (22023)', { code: '22023' }],
  ])('%s from org_job_moved is not the refusal: 500, ROLLBACK, no org_job_moved_refused log line', async (_label, fields) => {
    movedError = Object.assign(new Error('org_job_moved: other'), fields);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(makeEvent(validBody));
    const logged = err.mock.calls.map((c) => String(c[0]));
    err.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(order).not.toContain('COMMIT');
    expect(order[order.length - 1]).toBe('ROLLBACK');
    expect(logged.some((l) => l.includes('org_job_moved_refused'))).toBe(false);
  });

  it('employer_inactive_for_activation is not mapped (500)', async () => {
    updateResult = Object.assign(new Error('jobs: only an active member\'s job can be made active'), {
      code: '42501', detail: 'employer_inactive_for_activation',
    });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('invalid jobId or userId: 400 before BEGIN', async () => {
    for (const [body, error] of [
      [{ jobId: 'x', userId: FOREMAN_B }, 'invalid_job_id'],
      [{ userId: FOREMAN_B }, 'invalid_job_id'],
      [{ jobId: JOB_ID, userId: null }, 'invalid_user_id'],
    ] as const) {
      const res = await handler(makeEvent(body));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error });
    }
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('flag off or another method: 404 not_found before any DB work', async () => {
    const get = await handler(makeEvent(validBody, 'GET'));
    expect(get.statusCode).toBe(404);
    process.env.TEAM_MANAGEMENT_ENABLED = 'false';
    const off = await handler(makeEvent(validBody));
    expect(off.statusCode).toBe(404);
    expect(JSON.parse(off.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('the usage definer refusing the caller: 403 membership_inactive', async () => {
    mockReadCompanyUsage.mockRejectedValue(new CompanyUsageRefusedError());
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
  });

  it.each(['55P03', '57014', '40P01'])('the company lock busy (%s): 503 busy, Retry-After 2, ROLLBACK, nothing moved', async (code) => {
    mockReadCompanyUsage.mockRejectedValue(Object.assign(new Error('lock timeout'), { code }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await handler(makeEvent(validBody));
    warn.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'busy', retryable: true, retryAfterSeconds: 2 });
    expect(res.headers).toEqual(expect.objectContaining({ 'Retry-After': '2' }));
    expect(order).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it.each(['55P03', '57014', '40P01'])('the move busy (%s): 503 busy, ROLLBACK', async (code) => {
    updateResult = Object.assign(new Error('canceling statement'), { code });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await handler(makeEvent(validBody));
    warn.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'busy', retryable: true, retryAfterSeconds: 2 });
    expect(res.headers).toEqual(expect.objectContaining({ 'Retry-After': '2' }));
    expect(order).not.toContain('COMMIT');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it.each(['55P03', '57014', '40P01'])('org_job_moved busy or deadlocked with a worker write (%s): 503 busy, Retry-After 2, ROLLBACK, no COMMIT', async (code) => {
    movedError = Object.assign(new Error('deadlock detected'), { code });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await handler(makeEvent(validBody));
    warn.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'busy', retryable: true, retryAfterSeconds: 2 });
    expect(res.headers).toEqual(expect.objectContaining({ 'Retry-After': '2' }));
    expect(order).not.toContain('COMMIT');
    expect(order[order.length - 1]).toBe('ROLLBACK');
  });
});
