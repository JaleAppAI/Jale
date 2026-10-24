import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-invite-accept';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';
import { applyMemberAccess } from '../../../../lambda/lib/member-access';
import { hashInviteToken } from '../../../../lambda/lib/org-team';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));
jest.mock('../../../../lambda/lib/member-access', () => ({
  ...jest.requireActual('../../../../lambda/lib/member-access'),
  applyMemberAccess: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockApplyMemberAccess = applyMemberAccess as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const SUB = 'sub-foreman-1';
const ORG = '7b0f6a62-5b8f-4d0e-9a51-0e4a3f8a9c11';
const TOKEN = 'Q'.repeat(21) + '-' + 'r'.repeat(21); // 43 base64url characters
const ACCEPT_SQL = /FROM jale_cap\.org_team_invite_accept\(\$1\)/;

// null = absent (a default parameter would swallow undefined).
function event(token: string | null = TOKEN, sub: string | null = SUB): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer x' },
    body: null,
    pathParameters: token === null ? null : { token },
    requestContext: { authorizer: sub === null ? {} : { claims: { sub } } },
  } as unknown as APIGatewayProxyEvent;
}

function definerAnswers(outcome: string, organizationId: string | null = null): void {
  mockQuery.mockImplementation((sql: string) => {
    if (ACCEPT_SQL.test(String(sql))) return Promise.resolve({ rows: [{ outcome, organization_id: organizationId }] });
    return Promise.resolve({ rows: [] });
  });
}

const sqls = (): string[] => mockQuery.mock.calls.map(([sql]) => String(sql));

describe('POST /employer/invites/{token} (employer-invite-accept)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    process.env = {
      ...originalEnv,
      TEAM_MANAGEMENT_ENABLED: 'true',
      REQUIRED_TOS_VERSION: '2026-01',
      ALLOWED_ORIGIN: 'http://localhost:3000',
    };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, currentVersion: '2026-01', userExists: true });
    mockApplyMemberAccess.mockResolvedValue({ converged: 1, failed: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('flag off: 404 not_found, no DB call', async () => {
    process.env.TEAM_MANAGEMENT_ENABLED = 'false';
    const res = await handler(event());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('no caller: 401 unauthorized', async () => {
    const res = await handler(event(TOKEN, null));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('malformed token: 404 invite_not_found without a DB call', async () => {
    for (const token of [null, 'short', 'A'.repeat(42) + '/']) {
      const res = await handler(event(token));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'invite_not_found' });
    }
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('does not call resolveEmployerActor (a removed or orgless login may accept)', async () => {
    definerAnswers('accepted', ORG);
    const res = await handler(event());
    expect(res.statusCode).toBe(200);
    expect(resolveEmployerActor).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'rejoined'])('accepted / rejoined: 200, COMMIT (%s)', async (outcome) => {
    definerAnswers(outcome, ORG);
    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ outcome, organizationId: ORG });
    const s = sqls();
    expect(s[0]).toBe('BEGIN');
    expect(setRlsContext).toHaveBeenCalledWith(expect.anything(), SUB);
    const acceptAt = s.findIndex((q) => ACCEPT_SQL.test(q));
    expect(acceptAt).toBeGreaterThan(0);
    expect(mockQuery.mock.calls[acceptAt][1]).toEqual([hashInviteToken(TOKEN)]);
    expect(s.indexOf('COMMIT')).toBeGreaterThan(acceptAt);
    expect(s).not.toContain('ROLLBACK');
    expect(mockCheckCompliance).toHaveBeenCalledWith(expect.anything(), SUB, '2026-01');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('accepted (a new foreman) changes no Cognito user', async () => {
    definerAnswers('accepted', ORG);
    await handler(event());
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it('rejoined enables the Cognito user after COMMIT', async () => {
    definerAnswers('rejoined', ORG);
    const before = Date.now();
    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(mockApplyMemberAccess).toHaveBeenCalledTimes(1);
    const [changes, deps] = mockApplyMemberAccess.mock.calls[0];
    expect(changes).toEqual([{ cognitoSub: SUB, enabled: true }]);
    expect(deps.deadlineAt).toBeGreaterThanOrEqual(before + 9_000);
    expect(deps.deadlineAt).toBeLessThanOrEqual(Date.now() + 11_000);
    // After COMMIT, with the DB client already released.
    const commitAt = sqls().indexOf('COMMIT');
    expect(mockApplyMemberAccess.mock.invocationCallOrder[0]).toBeGreaterThan(mockQuery.mock.invocationCallOrder[commitAt]);
    expect(mockApplyMemberAccess.mock.invocationCallOrder[0]).toBeGreaterThan(mockRelease.mock.invocationCallOrder[0]);
  });

  it('rejoined: a Cognito failure still answers 200 (the sync repairs it)', async () => {
    definerAnswers('rejoined', ORG);
    mockApplyMemberAccess.mockRejectedValueOnce(new Error('cognito down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(event());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ outcome: 'rejoined', organizationId: ORG });
    errorSpy.mockRestore();
  });

  it('email_mismatch: 403 invite_email_mismatch, ROLLBACK', async () => {
    definerAnswers('email_mismatch');
    const res = await handler(event());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_email_mismatch' });
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it('already_member: 409', async () => {
    definerAnswers('already_member');
    const res = await handler(event());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'already_member' });
    expect(sqls()).toContain('ROLLBACK');
  });

  it('a 23505 on organization_members_pkey (a racing accept or start-company): 409 already_member, not 500', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (ACCEPT_SQL.test(String(sql))) {
        return Promise.reject(Object.assign(new Error('duplicate key value violates unique constraint "organization_members_pkey"'), {
          code: '23505', constraint: 'organization_members_pkey',
        }));
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(event());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'already_member' });
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('another 23505 is still a 500', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (ACCEPT_SQL.test(String(sql))) {
        return Promise.reject(Object.assign(new Error('dup'), { code: '23505', constraint: 'organization_invites_token_hash_key' }));
      }
      return Promise.resolve({ rows: [] });
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(event());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    errorSpy.mockRestore();
  });

  it('not_employer: 403 employer_required', async () => {
    definerAnswers('not_employer');
    const res = await handler(event());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'employer_required' });
  });

  it.each([
    ['not_found', 404, 'invite_not_found'],
    ['expired', 410, 'invite_expired'],
    ['revoked', 410, 'invite_revoked'],
    ['used', 410, 'invite_used'],
  ])('%s: %i %s, ROLLBACK', async (outcome, status, error) => {
    definerAnswers(outcome);
    const res = await handler(event());
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(sqls()).toContain('ROLLBACK');
  });

  it('legal not accepted: 403 legal_required', async () => {
    mockCheckCompliance.mockResolvedValueOnce({ compliant: false, currentVersion: '2025-01', userExists: true });
    const res = await handler(event());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'legal_required', requiredVersion: '2026-01', currentVersion: '2025-01' });
    expect(sqls().some((q) => ACCEPT_SQL.test(q))).toBe(false);
    expect(sqls()).toContain('ROLLBACK');
  });

  it('no users row: 409 user_not_provisioned', async () => {
    mockCheckCompliance.mockResolvedValueOnce({ compliant: false, currentVersion: null, userExists: false });
    const res = await handler(event());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
    expect(sqls().some((q) => ACCEPT_SQL.test(q))).toBe(false);
  });

  it('logs invite_accept_succeeded and invite_accept_refused with the outcome and sub only', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      definerAnswers('accepted', ORG);
      await handler(event());
      expect(logSpy.mock.calls.map(([line]) => JSON.parse(String(line))))
        .toContainEqual({ event: 'invite_accept_succeeded', outcome: 'accepted', cognitoSub: SUB });

      definerAnswers('email_mismatch');
      await handler(event());
      mockQuery.mockImplementation((sql: string) => (ACCEPT_SQL.test(String(sql))
        ? Promise.reject(Object.assign(new Error('dup'), { code: '23505', constraint: 'organization_members_pkey' }))
        : Promise.resolve({ rows: [] })));
      await handler(event());
      const refused = warnSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(refused).toEqual([
        { event: 'invite_accept_refused', outcome: 'email_mismatch', cognitoSub: SUB },
        { event: 'invite_accept_refused', outcome: 'already_member', cognitoSub: SUB },
      ]);
      expect(JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls])).not.toContain(TOKEN);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('an unknown outcome or a DB error: 500, ROLLBACK, the token never logged', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
    try {
      definerAnswers('surprise');
      const unknown = await handler(event());
      expect(unknown.statusCode).toBe(500);
      expect(sqls()).toContain('ROLLBACK');

      mockQuery.mockReset();
      mockQuery.mockImplementation((sql: string) => (ACCEPT_SQL.test(String(sql))
        ? Promise.reject(new Error(`boom for ${TOKEN}`))
        : Promise.resolve({ rows: [] })));
      const failed = await handler(event());
      expect(failed.statusCode).toBe(500);
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(TOKEN);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
