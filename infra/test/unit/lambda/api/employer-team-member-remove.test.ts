import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-team-member-remove';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { readCompanyUsage, CompanyUsageRefusedError } from '../../../../lambda/lib/company-usage';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';
import { applyMemberAccess } from '../../../../lambda/lib/member-access';

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
jest.mock('../../../../lambda/lib/member-access', () => ({
  ...jest.requireActual('../../../../lambda/lib/member-access'),
  applyMemberAccess: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockReadCompanyUsage = readCompanyUsage as jest.Mock;
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const mockApplyMemberAccess = applyMemberAccess as jest.Mock;

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ASSIGNEE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TARGET_SUB = 'target-sub';

type MemberRow = { user_id: string; role: 'owner' | 'foreman'; status: 'active' | 'suspended' | 'removed' };
const target: MemberRow = { user_id: TARGET_ID, role: 'foreman', status: 'suspended' };
const assignee: MemberRow = { user_id: ASSIGNEE_ID, role: 'foreman', status: 'active' };

const actor = (role: 'owner' | 'foreman') => ({
  ok: true,
  actor: {
    userId: role === 'owner' ? OWNER_ID : TARGET_ID,
    organizationId: ORG_ID,
    role,
    scopeUserIds: role === 'owner' ? [OWNER_ID, TARGET_ID, ASSIGNEE_ID] : [TARGET_ID],
  },
});

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const order: string[] = [];

let members: MemberRow[];
let movedRows: Array<{ id: string }>;
let removeOutcome: { outcome: string; cognito_sub: string | null };
let jobsUpdateError: unknown;

const makeEvent = (body: unknown, method = 'POST') => ({
  httpMethod: method,
  pathParameters: { action: 'remove' },
  requestContext: { authorizer: { claims: { sub: 'owner-sub' } } },
  body: body === undefined ? null : JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

const validBody = { userId: TARGET_ID, reassignTo: ASSIGNEE_ID };

const sqlCalls = () => mockQuery.mock.calls.map(([sql]) => String(sql));
const jobsUpdates = () => mockQuery.mock.calls.filter(([sql]) => /UPDATE\s+jobs/i.test(String(sql)));

describe('employer-team-member-remove', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    members = [target, assignee, { user_id: OWNER_ID, role: 'owner', status: 'active' }];
    movedRows = [{ id: 'job-1' }, { id: 'job-2' }, { id: 'job-3' }];
    removeOutcome = { outcome: 'removed', cognito_sub: TARGET_SUB };
    jobsUpdateError = undefined;

    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({
        query: mockQuery,
        release: (...args: unknown[]) => { order.push('release'); return mockRelease(...args); },
      }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockImplementation(async () => { order.push('actor'); return actor('owner'); });
    mockReadCompanyUsage.mockImplementation(async (_client: unknown, options?: { lock?: boolean }) => {
      order.push(options?.lock === true ? 'lock' : 'usage');
      return { organizationId: ORG_ID, activeJobs: 3, templates: 0, activeForemen: 2, suspendedForemen: 1, pendingInvites: 0 };
    });
    mockApplyMemberAccess.mockImplementation(async () => { order.push('cognito'); return { converged: 1, failed: [] }; });
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        order.push(sql);
        return Promise.resolve({ rows: [] });
      }
      if (/FROM\s+organization_members/i.test(sql)) {
        order.push('members');
        const ids = (params?.[1] as string[]) ?? [];
        return Promise.resolve({ rows: members.filter((m) => ids.includes(m.user_id)) });
      }
      if (/UPDATE\s+jobs/i.test(sql)) {
        order.push('jobs');
        if (jobsUpdateError) return Promise.reject(jobsUpdateError);
        return Promise.resolve({ rows: movedRows, rowCount: movedRows.length });
      }
      if (sql.includes('jale_cap.org_team_remove_member')) {
        order.push('remove');
        return Promise.resolve({ rows: [removeOutcome] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
  });

  it('locks the company before reading members or touching jobs', async () => {
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(200);
    expect(order).toEqual(['BEGIN', 'actor', 'lock', 'members', 'jobs', 'remove', 'COMMIT', 'release', 'cognito']);
  });

  it('moves every job of the member to reassignTo with the billing mark cleared, then removes; 200 with movedJobs', async () => {
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: true, movedJobs: 3, accessUpdated: true });
    const [[sql, params]] = jobsUpdates();
    expect(sql).toMatch(/SET\s+employer_id\s*=\s*\$1/);
    expect(sql).toMatch(/billing_paused_at\s*=\s*NULL/);
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/);
    expect(sql).toMatch(/WHERE\s+employer_id\s*=\s*\$2/);
    expect(sql).not.toMatch(/status\s*=/);
    expect(sql).not.toMatch(/created_by_user_id/);
    expect(params).toEqual([ASSIGNEE_ID, TARGET_ID]);
    const removeCall = mockQuery.mock.calls.find(([s]) => String(s).includes('jale_cap.org_team_remove_member'));
    expect(removeCall?.[1]).toEqual([TARGET_ID]);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('a member with no jobs: movedJobs 0, still removed', async () => {
    movedRows = [];
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: true, movedJobs: 0, accessUpdated: true });
  });

  it('removed with no cognito_sub: no Cognito call, accessUpdated true', async () => {
    removeOutcome = { outcome: 'removed', cognito_sub: null };
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: true, movedJobs: 3, accessUpdated: true });
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it('reassignTo = the owner: 200, the jobs go to the owner', async () => {
    const res = await handler(makeEvent({ userId: TARGET_ID, reassignTo: OWNER_ID }));
    expect(res.statusCode).toBe(200);
    expect(jobsUpdates()[0][1]).toEqual([OWNER_ID, TARGET_ID]);
  });

  it('an active (not suspended) target is removed too', async () => {
    members = [{ ...target, status: 'active' }, assignee];
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).removed).toBe(true);
  });

  it('upper-case UUIDs in the body are lower-cased and still found', async () => {
    const res = await handler(makeEvent({ userId: TARGET_ID.toUpperCase(), reassignTo: ASSIGNEE_ID.toUpperCase() }));
    expect(res.statusCode).toBe(200);
    expect(jobsUpdates()[0][1]).toEqual([ASSIGNEE_ID, TARGET_ID]);
    const removeCall = mockQuery.mock.calls.find(([s]) => String(s).includes('jale_cap.org_team_remove_member'));
    expect(removeCall?.[1]).toEqual([TARGET_ID]);
  });

  it('disables the removed member\'s Cognito user after COMMIT; accessUpdated false when Cognito fails, still 200', async () => {
    const before = Date.now();
    await handler(makeEvent(validBody));
    expect(mockApplyMemberAccess).toHaveBeenCalledWith(
      [{ cognitoSub: TARGET_SUB, enabled: false }],
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    const { deadlineAt } = mockApplyMemberAccess.mock.calls[0][1];
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 15_000);
    expect(order.indexOf('cognito')).toBeGreaterThan(order.indexOf('COMMIT'));
    expect(order.indexOf('cognito')).toBeGreaterThan(order.indexOf('release'));

    mockApplyMemberAccess.mockResolvedValue({ converged: 0, failed: [TARGET_SUB] });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: true, movedJobs: 3, accessUpdated: false });

    mockApplyMemberAccess.mockRejectedValue(new Error('boom'));
    const thrown = await handler(makeEvent(validBody));
    expect(thrown.statusCode).toBe(200);
    expect(JSON.parse(thrown.body).accessUpdated).toBe(false);
    expect(mockRelease).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['reassignTo = target', { userId: TARGET_ID, reassignTo: TARGET_ID }, () => undefined],
    ['a removed member', validBody, () => { members = [target, { ...assignee, status: 'removed' }]; }],
    ['a suspended member', validBody, () => { members = [target, { ...assignee, status: 'suspended' }]; }],
    ['a member of another company (not in this company\'s rows)', validBody, () => { members = [target]; }],
  ])('reassignTo = target, a removed or suspended member, or a member of another company: 409 invalid_assignee, ROLLBACK, no job moved (%s)', async (_label, body, setup) => {
    setup();
    const res = await handler(makeEvent(body));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_assignee' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(jobsUpdates()).toHaveLength(0);
    expect(sqlCalls().some((s) => s.includes('org_team_remove_member'))).toBe(false);
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it('reads the target and assignee within the caller\'s company only', async () => {
    await handler(makeEvent(validBody));
    const call = mockQuery.mock.calls.find(([s]) => /FROM\s+organization_members/i.test(String(s)));
    expect(String(call?.[0])).toMatch(/organization_id\s*=\s*\$1/);
    expect(call?.[1]).toEqual([ORG_ID, [TARGET_ID, ASSIGNEE_ID]]);
  });

  it.each(['assignee_not_member', 'assignee_inactive', 'assignee_other_company', 'job_employer_not_member'])(
    'a 129 assignee refusal raised by the UPDATE (race): 409 invalid_assignee (%s)',
    async (detail) => {
      jobsUpdateError = Object.assign(new Error('jobs: a job moves only to an active member of its own company'), { code: '42501', detail });
      const res = await handler(makeEvent(validBody));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_assignee' });
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockApplyMemberAccess).not.toHaveBeenCalled();
    },
  );

  it('cannot remove the owner: 409 cannot_remove_owner', async () => {
    members = [{ user_id: OWNER_ID, role: 'owner', status: 'active' }, assignee];
    const res = await handler(makeEvent({ userId: OWNER_ID, reassignTo: ASSIGNEE_ID }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'cannot_remove_owner' });
    expect(jobsUpdates()).toHaveLength(0);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('target not in the company: 404 member_not_found', async () => {
    members = [assignee];
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'member_not_found' });
    expect(jobsUpdates()).toHaveLength(0);
  });

  it('target already removed: 409 already_removed', async () => {
    members = [{ ...target, status: 'removed' }, assignee];
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'already_removed' });
    expect(jobsUpdates()).toHaveLength(0);
  });

  it('has_jobs from the definer: 409 member_has_jobs, ROLLBACK', async () => {
    removeOutcome = { outcome: 'has_jobs', cognito_sub: null };
    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'member_has_jobs' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['not_owner', 403, 'owner_required'],
    ['not_found', 404, 'member_not_found'],
    ['is_owner', 409, 'cannot_remove_owner'],
    ['already_removed', 409, 'already_removed'],
  ])('definer outcome %s: %i %s, ROLLBACK', async (outcome, status, error) => {
    removeOutcome = { outcome, cognito_sub: null };
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('invalid userId or reassignTo: 400 before BEGIN', async () => {
    for (const [body, error] of [
      [{ userId: 'nope', reassignTo: ASSIGNEE_ID }, 'invalid_user_id'],
      [{ reassignTo: ASSIGNEE_ID }, 'invalid_user_id'],
      [{ userId: TARGET_ID, reassignTo: 42 }, 'invalid_reassign_to'],
      [{ userId: TARGET_ID }, 'invalid_reassign_to'],
    ] as const) {
      const res = await handler(makeEvent(body));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error });
    }
    const malformed = await handler({ ...makeEvent(validBody), body: '{not json' } as APIGatewayProxyEvent);
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid_body' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('foreman: 403 owner_required, ROLLBACK, nothing locked', async () => {
    mockResolveEmployerActor.mockResolvedValue(actor('foreman'));
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
    expect(mockReadCompanyUsage).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('flag off: 404 not_found and no DB connection', async () => {
    process.env.TEAM_MANAGEMENT_ENABLED = 'false';
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('GET: 404 not_found', async () => {
    const res = await handler(makeEvent(validBody, 'GET'));
    expect(res.statusCode).toBe(404);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('the usage definer refusing the caller: 403 membership_inactive', async () => {
    mockReadCompanyUsage.mockRejectedValue(new CompanyUsageRefusedError());
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('an unexpected database error: 500, ROLLBACK, no Cognito call', async () => {
    jobsUpdateError = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
