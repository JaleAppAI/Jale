import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-team-list';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveCompanyEntitlements } from '../../../../lambda/lib/entitlements';
import { readCompanyUsage, CompanyUsageRefusedError } from '../../../../lambda/lib/company-usage';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/entitlements');
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
const mockResolveEntitlements = resolveCompanyEntitlements as jest.Mock;
const mockReadCompanyUsage = readCompanyUsage as jest.Mock;
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREMAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVITE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const INVITE_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const actor = (role: 'owner' | 'foreman') => ({
  ok: true,
  actor: {
    userId: role === 'owner' ? OWNER_ID : FOREMAN_ID,
    organizationId: ORG_ID,
    role,
    scopeUserIds: role === 'owner' ? [OWNER_ID, FOREMAN_ID] : [FOREMAN_ID],
  },
});

const mockQuery = jest.fn();
const mockRelease = jest.fn();

const makeEvent = (method = 'GET') => ({
  httpMethod: method,
  pathParameters: { action: 'members' },
  requestContext: { authorizer: { claims: { sub: 'owner-sub' } } },
  body: null,
} as unknown as APIGatewayProxyEvent);

const memberRows = [
  {
    user_id: OWNER_ID, email: 'owner@gate.co', display_name: 'Olga Owner', role: 'owner', status: 'active',
    billing_suspended: false, joined_at: new Date('2026-01-01T00:00:00Z'), status_changed_at: null,
    active_jobs: 2, open_jobs: 3,
  },
  {
    user_id: FOREMAN_ID, email: 'fred@gate.co', display_name: 'Fred Foreman', role: 'foreman', status: 'suspended',
    billing_suspended: true, joined_at: new Date('2026-02-01T00:00:00Z'), status_changed_at: new Date('2026-03-01T00:00:00Z'),
    active_jobs: 0, open_jobs: 1,
  },
];
const inviteRows = [
  {
    invite_id: INVITE_A, email: 'new@gate.co', contact_name: 'Nina', created_at: new Date('2026-10-20T00:00:00Z'),
    expires_at: new Date('2026-10-27T00:00:00Z'), last_sent_at: new Date('2026-10-20T00:00:00Z'), expired: false,
  },
  {
    invite_id: INVITE_B, email: 'old@gate.co', contact_name: null, created_at: new Date('2026-09-01T00:00:00Z'),
    expires_at: new Date('2026-09-08T00:00:00Z'), last_sent_at: new Date('2026-09-02T00:00:00Z'), expired: true,
  },
];

describe('employer-team-list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockResolvedValue(actor('owner'));
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10, templateLimit: 10, foremanSeatLimit: 5 });
    mockReadCompanyUsage.mockResolvedValue({
      organizationId: ORG_ID, activeJobs: 2, templates: 0, activeForemen: 1, suspendedForemen: 1, pendingInvites: 1,
    });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('jale_cap.org_team_members()')) return Promise.resolve({ rows: memberRows });
      if (sql.includes('jale_cap.org_team_invites()')) return Promise.resolve({ rows: inviteRows });
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
  });

  it('owner: seats from usage and plan, members without removed ones, pending invites incl. expired', async () => {
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      seats: { limit: 5, active: 1, pending: 1, suspended: 1 },
      members: [
        {
          userId: OWNER_ID, name: 'Olga Owner', email: 'owner@gate.co', role: 'owner', status: 'active',
          billingSuspended: false, joinedAt: '2026-01-01T00:00:00.000Z', activeJobs: 2, openJobs: 3,
        },
        {
          userId: FOREMAN_ID, name: 'Fred Foreman', email: 'fred@gate.co', role: 'foreman', status: 'suspended',
          billingSuspended: true, joinedAt: '2026-02-01T00:00:00.000Z', activeJobs: 0, openJobs: 1,
        },
      ],
      invites: [
        {
          inviteId: INVITE_A, email: 'new@gate.co', contactName: 'Nina', createdAt: '2026-10-20T00:00:00.000Z',
          expiresAt: '2026-10-27T00:00:00.000Z', lastSentAt: '2026-10-20T00:00:00.000Z', expired: false,
        },
        {
          inviteId: INVITE_B, email: 'old@gate.co', contactName: null, createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-09-08T00:00:00.000Z', lastSentAt: '2026-09-02T00:00:00.000Z', expired: true,
        },
      ],
    });
    // The lists come from 134's definers, which leave removed members out; the usage read takes no lock.
    expect(mockReadCompanyUsage).toHaveBeenCalledWith(expect.anything());
    expect(mockReadCompanyUsage.mock.calls[0][1]?.lock).not.toBe(true);
    expect(mockResolveEntitlements).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('a removed member row that reaches the handler is still left out', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('jale_cap.org_team_members()')) {
        return Promise.resolve({ rows: [...memberRows, { ...memberRows[1], user_id: INVITE_A, status: 'removed' }] });
      }
      if (sql.includes('jale_cap.org_team_invites()')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(makeEvent());
    expect(JSON.parse(res.body).members.map((m: { userId: string }) => m.userId)).toEqual([OWNER_ID, FOREMAN_ID]);
  });

  it('foreman: 403 owner_required', async () => {
    mockResolveEmployerActor.mockResolvedValue(actor('foreman'));
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('org_team_members'))).toBe(false);
  });

  it('flag off: 404', async () => {
    process.env.TEAM_MANAGEMENT_ENABLED = 'false';
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(res.headers).toHaveProperty('Access-Control-Allow-Origin');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('POST: 404', async () => {
    const res = await handler(makeEvent('POST'));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('no sub: 401', async () => {
    const res = await handler({ ...makeEvent(), requestContext: {} } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('not compliant: 403 legal_required', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });

  it('an inactive member: 403 membership_inactive with the status', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive', membershipStatus: 'removed' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive', membershipStatus: 'removed' });
  });

  it('the usage definer refusing the caller: 403 membership_inactive', async () => {
    mockReadCompanyUsage.mockRejectedValue(new CompanyUsageRefusedError());
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('the list definer refusing a caller who stopped being the owner: 403 owner_required', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('jale_cap.org_team_members()')) {
        return Promise.reject(Object.assign(new Error('org_team: the caller is not the active owner'), { code: '42501' }));
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
  });

  it.each(['55P03', '57014'])('the company read busy (%s): 503 busy, Retry-After 2, ROLLBACK', async (code) => {
    mockReadCompanyUsage.mockRejectedValue(Object.assign(new Error('canceling statement'), { code }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await handler(makeEvent());
    const warned = warn.mock.calls;
    warn.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'busy', retryable: true, retryAfterSeconds: 2 });
    expect(res.headers).toEqual(expect.objectContaining({ 'Retry-After': '2' }));
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(warned).toEqual([['employer-team-list busy:', code]]);
  });

  it('a usage read for another company: 500', async () => {
    mockReadCompanyUsage.mockResolvedValue({
      organizationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', activeJobs: 0, templates: 0, activeForemen: 0, suspendedForemen: 0, pendingInvites: 0,
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
