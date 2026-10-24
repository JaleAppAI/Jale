/**
 * POST /employer/team/revoke (employer organizations, Phase 3, Task 7).
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-team-invite-revoke';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';
import { applyMemberAccess } from '../../../../lambda/lib/member-access';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/member-access');
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockActor = resolveEmployerActor as jest.Mock;
const mockApplyMemberAccess = applyMemberAccess as jest.Mock;

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVITE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ownerActor = { ok: true, actor: { userId: OWNER_ID, organizationId: ORG_ID, role: 'owner', scopeUserIds: [OWNER_ID] } };

const mockQuery = jest.fn();
const mockRelease = jest.fn();
let definerRow: Record<string, unknown>;

const event = (body: unknown, method = 'POST') => ({
  httpMethod: method,
  requestContext: { authorizer: { claims: { sub: 'owner-sub' } } },
  body: JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]));
const callIndex = (needle: string) => sqlCalls().findIndex((s) => s.includes(needle));

describe('employer-team-invite-revoke', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockActor.mockResolvedValue(ownerActor);
    mockApplyMemberAccess.mockResolvedValue({ converged: 1, failed: [] });
    definerRow = { outcome: 'revoked', cognito_sub: null };
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('org_team_invite_revoke')) return Promise.resolve({ rows: [definerRow] });
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
  });

  it('flag off: 404 not_found and no DB connection', async () => {
    process.env.TEAM_MANAGEMENT_ENABLED = 'TRUE';
    const res = await handler(event({ inviteId: INVITE_ID }));
    expect(res.statusCode).toBe(404);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('GET: 404 not_found', async () => {
    const res = await handler(event({ inviteId: INVITE_ID }, 'GET'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  it.each([
    [{ inviteId: '123' }],
    [{ inviteId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc' }],
    [{ inviteId: 42 }],
    [{}],
  ])('invalid invite id: 400 invalid_invite_id before BEGIN (%#)', async (body) => {
    const res = await handler(event(body));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_invite_id' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('foreman: 403 owner_required, ROLLBACK, no definer call', async () => {
    mockActor.mockResolvedValue({ ok: true, actor: { ...ownerActor.actor, role: 'foreman' } });
    const res = await handler(event({ inviteId: INVITE_ID }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(callIndex('org_team_invite_revoke')).toBe(-1);
  });

  it('revoked: 200 and disables a removed member\'s Cognito user when the definer returns their sub', async () => {
    definerRow = { outcome: 'revoked', cognito_sub: 'removed-sub' };
    const res = await handler(event({ inviteId: INVITE_ID }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revoked: true, accessUpdated: true });
    expect(mockQuery.mock.calls[callIndex('org_team_invite_revoke')][1]).toEqual([INVITE_ID]);
    expect(mockApplyMemberAccess).toHaveBeenCalledWith(
      [{ cognitoSub: 'removed-sub', enabled: false }],
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    const commitAt = mockQuery.mock.invocationCallOrder[sqlCalls().indexOf('COMMIT')];
    expect(commitAt).toBeLessThan(mockApplyMemberAccess.mock.invocationCallOrder[0]);
    expect(mockRelease.mock.invocationCallOrder[0]).toBeLessThan(mockApplyMemberAccess.mock.invocationCallOrder[0]);
  });

  it('a Cognito failure still answers 200, with accessUpdated false', async () => {
    definerRow = { outcome: 'revoked', cognito_sub: 'removed-sub' };
    mockApplyMemberAccess.mockResolvedValue({ converged: 0, failed: ['removed-sub'] });
    const res = await handler(event({ inviteId: INVITE_ID }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revoked: true, accessUpdated: false });
  });

  it('no Cognito call when no sub is returned', async () => {
    const res = await handler(event({ inviteId: INVITE_ID }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ revoked: true, accessUpdated: true });
    expect(sqlCalls()).toContain('COMMIT');
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404, 'invite_not_found'],
    ['closed', 409, 'invite_closed'],
    ['not_owner', 403, 'owner_required'],
  ])('%s: %i %s, ROLLBACK, no Cognito call', async (outcome, status, error) => {
    definerRow = { outcome, cognito_sub: null };
    const res = await handler(event({ inviteId: INVITE_ID }));
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it('a database error: 500 internal_error, ROLLBACK', async () => {
    mockQuery.mockImplementation((sql: string) => (sql.includes('org_team_invite_revoke')
      ? Promise.reject(Object.assign(new Error('x'), { code: 'P0001' }))
      : Promise.resolve({ rows: [] })));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(event({ inviteId: INVITE_ID }));
    spy.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(sqlCalls()).toContain('ROLLBACK');
  });
});
