import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-membership';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockSetAuditContext = setAuditContext as jest.Mock;

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type MembershipRow = {
  user_id: string; organization_id: string; role: string; status: string; company_name: string; has_live_invite: boolean;
};

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const order: string[] = [];

/** Each org_team_membership() call returns the next entry (the last one repeats). */
let membershipReads: MembershipRow[][];
let ensureResult: { org: string } | Error;

const makeEvent = (method: string, body?: unknown) => ({
  httpMethod: method,
  requestContext: { authorizer: { claims: { sub: 'login-sub' } } },
  body: body === undefined ? null : JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

const row = (overrides: Partial<MembershipRow> = {}): MembershipRow => ({
  user_id: USER_ID, organization_id: ORG_ID, role: 'owner', status: 'active', company_name: 'Gate Co', has_live_invite: false,
  ...overrides,
});

const ensureCalls = () => mockQuery.mock.calls.filter(([sql]) => String(sql).includes('employer_ensure_organization'));

describe('employer-membership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockCheckCompliance.mockImplementation(async () => { order.push('compliance'); return { compliant: true, userExists: true, currentVersion: 'v1.0' }; });
    mockSetAuditContext.mockImplementation(async () => { order.push('audit'); });
    membershipReads = [[row()]];
    ensureResult = { org: NEW_ORG_ID };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetRlsContext.mockImplementation(async () => { order.push('rls'); });
    mockQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        order.push(sql);
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('jale_cap.org_team_membership()')) {
        order.push('membership');
        const rows = membershipReads.length > 1 ? membershipReads.shift()! : membershipReads[0];
        return Promise.resolve({ rows });
      }
      if (/^\s*UPDATE\s+users/i.test(sql)) {
        order.push('users');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (/INSERT\s+INTO\s+employer_profiles/i.test(sql)) {
        order.push('profile');
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes('employer_ensure_organization')) {
        order.push('ensure');
        if (ensureResult instanceof Error) return Promise.reject(ensureResult);
        return Promise.resolve({ rows: [ensureResult] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
  });

  describe('GET', () => {
    it('active: role and company name', async () => {
      membershipReads = [[row({ role: 'foreman' })]];
      const res = await handler(makeEvent('GET'));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ userId: USER_ID, organizationId: ORG_ID, role: 'foreman', companyName: 'Gate Co' });
      expect(order).toEqual(['BEGIN', 'rls', 'membership', 'COMMIT']);
      expect(mockCheckCompliance).not.toHaveBeenCalled();
      expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'login-sub');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('removed with a live invite: 403 membership_inactive, membershipStatus removed, hasInvite true', async () => {
      membershipReads = [[row({ role: 'foreman', status: 'removed', has_live_invite: true })]];
      const res = await handler(makeEvent('GET'));

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive', membershipStatus: 'removed', hasInvite: true });
    });

    it('suspended without an invite: 403 membership_inactive, hasInvite false', async () => {
      membershipReads = [[row({ role: 'foreman', status: 'suspended' })]];
      const res = await handler(makeEvent('GET'));

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive', membershipStatus: 'suspended', hasInvite: false });
    });

    it('no membership: 403 no_organization', async () => {
      membershipReads = [[]];
      const res = await handler(makeEvent('GET'));

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'no_organization' });
    });

    it('is served with the flag off', async () => {
      process.env.TEAM_MANAGEMENT_ENABLED = 'false';
      const res = await handler(makeEvent('GET'));
      expect(res.statusCode).toBe(200);
    });

    it('no sub: 401', async () => {
      const res = await handler({ ...makeEvent('GET'), requestContext: {} } as unknown as APIGatewayProxyEvent);
      expect(res.statusCode).toBe(401);
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });

    it('a database error: 500, ROLLBACK', async () => {
      mockQuery.mockImplementation((sql: string) => (sql.includes('org_team_membership')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ rows: [] })));
      const res = await handler(makeEvent('GET'));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('POST (start my own company)', () => {
    it('POST with no membership: ensures the company, 201', async () => {
      membershipReads = [[], [row({ organization_id: NEW_ORG_ID })]];
      const res = await handler(makeEvent('POST', { companyName: '  Acme Roofing  ' }));

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ organizationId: NEW_ORG_ID, role: 'owner' });
      expect(order).toEqual(['BEGIN', 'rls', 'compliance', 'membership', 'ensure', 'membership', 'audit', 'users', 'profile', 'COMMIT']);
      expect(ensureCalls()[0][1]).toEqual(['Acme Roofing']);
    });

    it('seeds the company name: the profile keeps a non-empty name, else the typed one; mirrored into users.full_name', async () => {
      membershipReads = [[], [row({ organization_id: NEW_ORG_ID })]];
      const res = await handler(withRequestId(makeEvent('POST', { companyName: ' Acme Roofing ' })));
      expect(res.statusCode).toBe(201);

      const profile = mockQuery.mock.calls.find(([s]) => /INSERT\s+INTO\s+employer_profiles/i.test(String(s)))!;
      expect(profile[1]).toEqual([USER_ID, 'Acme Roofing']);
      expect(String(profile[0])).toMatch(/ON CONFLICT \(user_id\) DO UPDATE SET\s+company_name = COALESCE\(NULLIF\(employer_profiles\.company_name, ''\), EXCLUDED\.company_name\)/);
      const users = mockQuery.mock.calls.find(([s]) => /^\s*UPDATE\s+users/i.test(String(s)))!;
      expect(String(users[0])).toMatch(/SET full_name = COALESCE\(\(SELECT NULLIF\(ep\.company_name, ''\) FROM employer_profiles ep WHERE ep\.user_id = users\.id\), \$1\)/);
      expect(users[1]).toEqual(['Acme Roofing', 'login-sub']);

      expect(mockSetAuditContext).toHaveBeenCalledWith(expect.anything(), callerFor('employer', USER_ID), 'employer.profile_update');
      expectContextBeforeWrite(mockQuery, mockSetAuditContext, /^\s*UPDATE\s+users/i);
      expectContextBeforeWrite(mockQuery, mockSetAuditContext, /INSERT\s+INTO\s+employer_profiles/i);
    });

    it('no profile or name write on a refusal', async () => {
      membershipReads = [[], [row({ role: 'foreman' })]];
      ensureResult = { org: ORG_ID };
      await handler(makeEvent('POST', { companyName: 'Acme' }));
      expect(order).not.toContain('users');
      expect(order).not.toContain('profile');
      expect(mockSetAuditContext).not.toHaveBeenCalled();
    });

    it('checks the ToS before the pre-check: not compliant gives 403 legal_required, no ensure', async () => {
      mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
      membershipReads = [[]];
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'legal_required', requiredVersion: 'v1.0', currentVersion: 'v0.9' });
      expect(order).toEqual(['BEGIN', 'rls', 'ROLLBACK']);
      expect(ensureCalls()).toHaveLength(0);
    });

    it('an unprovisioned login: 409 user_not_provisioned, no ensure', async () => {
      mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: false, currentVersion: null });
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
      expect(ensureCalls()).toHaveLength(0);
    });

    it('POST with a membership: 409 already_member, no ensure call', async () => {
      membershipReads = [[row({ role: 'foreman', status: 'removed' })]];
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'already_member' });
      expect(ensureCalls()).toHaveLength(0);
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('an accept that commits between the pre-check and the ensure: 409 already_member, never a false 201 owner', async () => {
      // The pre-check sees no membership; the accept commits; the ensure then
      // returns the existing membership's company (118 returns any one), and
      // the re-read shows the caller is that company's foreman.
      membershipReads = [[], [row({ role: 'foreman' })]];
      ensureResult = { org: ORG_ID };
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'already_member' });
      expect(order).toEqual(['BEGIN', 'rls', 'compliance', 'membership', 'ensure', 'membership', 'ROLLBACK']);
    });

    it('a re-read that names another company than the ensure: 409 already_member', async () => {
      membershipReads = [[], [row({ organization_id: ORG_ID })]];
      ensureResult = { org: NEW_ORG_ID };
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'already_member' });
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('a racing accept inserting first (23505 on the members key): 409 already_member, not 500', async () => {
      membershipReads = [[]];
      ensureResult = Object.assign(new Error('duplicate key value violates unique constraint "organization_members_pkey"'), {
        code: '23505', constraint: 'organization_members_pkey',
      });
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'already_member' });
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    });

    it('another 23505: 500', async () => {
      membershipReads = [[]];
      ensureResult = Object.assign(new Error('dup'), { code: '23505', constraint: 'organizations_pkey' });
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));
      expect(res.statusCode).toBe(500);
    });

    it('a login that is not an employer: 403 employer_required', async () => {
      membershipReads = [[]];
      ensureResult = Object.assign(new Error('employer_ensure_organization: only an employer login has a company'), { code: '42501' });
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'employer_required' });
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it.each([
      ['missing', {}],
      ['empty after trim', { companyName: '   ' }],
      ['too long', { companyName: 'x'.repeat(121) }],
      ['not a string', { companyName: 42 }],
    ])('invalid company name (%s): 400 invalid_company_name before BEGIN', async (_label, body) => {
      const res = await handler(makeEvent('POST', body));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_company_name' });
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });

    it('120 characters after trim is accepted', async () => {
      membershipReads = [[], [row({ organization_id: NEW_ORG_ID })]];
      const res = await handler(makeEvent('POST', { companyName: ` ${'x'.repeat(120)} ` }));
      expect(res.statusCode).toBe(201);
    });

    it('POST flag off: 404', async () => {
      process.env.TEAM_MANAGEMENT_ENABLED = 'false';
      const res = await handler(makeEvent('POST', { companyName: 'Acme' }));

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });
  });

  it('another method: 404 not_found', async () => {
    const res = await handler(makeEvent('DELETE'));
    expect(res.statusCode).toBe(404);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });
});
