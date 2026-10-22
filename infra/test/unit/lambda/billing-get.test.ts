import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../../../lambda/lib/db';
import { checkCompliance } from '../../../lambda/legal/check-compliance';
import { resolveCompanyEntitlements } from '../../../lambda/lib/entitlements';
import { readCompanyUsage, CompanyUsageRefusedError } from '../../../lambda/lib/company-usage';
import { resolveEmployerActor } from '../../../lambda/lib/employer-actor';
import { handler } from '../../../lambda/billing/get-billing';

jest.mock('../../../lambda/lib/db');
jest.mock('../../../lambda/legal/check-compliance');
jest.mock('../../../lambda/lib/entitlements');
jest.mock('../../../lambda/lib/company-usage');
jest.mock('../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const query = jest.fn();
const release = jest.fn();
const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockResolveEntitlements = resolveCompanyEntitlements as jest.Mock;
const mockReadCompanyUsage = readCompanyUsage as jest.Mock;
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREMAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = (role: 'owner' | 'foreman', userId: string, scopeUserIds: string[]) =>
  ({ ok: true, actor: { userId, organizationId: ORG, role, scopeUserIds } });

function event(): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'cognito-sub' } } },
  } as unknown as APIGatewayProxyEvent;
}

function answer(visibleActive: number) {
  query.mockImplementation((sql: string) => {
    if (sql.includes('count(*)::int AS active_jobs')) return Promise.resolve({ rows: [{ active_jobs: visibleActive }] });
    if (sql.includes('SELECT display_price_minor')) return Promise.resolve({ rows: [{ display_price_minor: 2000, currency: 'usd', billing_interval: 'month' }] });
    if (sql.includes('SELECT plan_code, status')) return Promise.resolve({ rows: [{ plan_code: 'employer_pro', status: 'active' }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('billing get handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query, release }) });
    mockCheckCompliance.mockResolvedValue({ userExists: true, compliant: true, currentVersion: 'v1' });
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10, templateLimit: 20, foremanSeatLimit: 3 });
    mockReadCompanyUsage.mockResolvedValue({ organizationId: ORG, activeJobs: 3, templates: 4, activeForemen: 1, suspendedForemen: 1 });
    mockResolveEmployerActor.mockResolvedValue(actor('owner', OWNER, [OWNER, FOREMAN]));
    answer(3);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('shows the owner the company plan, company-wide usage and the seats, without Stripe calls', async () => {
    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      planCode: 'employer_pro',
      activeJobLimit: 10,
      templateLimit: 20,
      foremanSeatLimit: 3,
      activeJobUsage: 3,
      templateUsage: 4,
      otherMembersActiveJobs: 0,
      role: 'owner',
      seats: { used: 1, limit: 3, suspended: 1 },
      subscription: { plan_code: 'employer_pro', status: 'active' },
      display_price_minor: 2000,
      currency: 'usd',
      billing_interval: 'month',
    });
    expect(mockResolveEntitlements).toHaveBeenCalledWith(expect.any(Object), ORG);
    expect(mockReadCompanyUsage).toHaveBeenCalledWith(expect.any(Object));
    const sub = query.mock.calls.find(([sql]) => String(sql).includes('SELECT plan_code, status'));
    expect(String(sub![0])).toMatch(/WHERE organization_id = \$1/);
    expect(sub![1]).toEqual([ORG]);
    expect(setRlsContext).toHaveBeenCalledWith(expect.any(Object), 'cognito-sub');
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('a foreman sees the company plan and company-wide usage, but no seats', async () => {
    mockResolveEmployerActor.mockResolvedValue(actor('foreman', FOREMAN, [FOREMAN]));
    answer(1);

    const body = JSON.parse((await handler(event())).body);

    expect(body).toMatchObject({ planCode: 'employer_pro', activeJobUsage: 3, otherMembersActiveJobs: 2, role: 'foreman', seats: null });
    const visible = query.mock.calls.find(([sql]) => String(sql).includes('AS active_jobs'));
    expect(String(visible![0])).toMatch(/employer_id = ANY\(\$1::uuid\[\]\)/);
    expect(visible![1]).toEqual([[FOREMAN]]);
  });

  it('answers 403 employer_required for a non-employer, and the actor failure for an inactive member', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 409, error: 'user_not_provisioned' });
    const notEmployer = await handler(event());
    expect(notEmployer.statusCode).toBe(403);
    expect(JSON.parse(notEmployer.body)).toEqual({ error: 'employer_required' });

    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });
    const res = await handler(event());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockReadCompanyUsage).not.toHaveBeenCalled();
  });

  it('returns internal_error when the active billing plan catalog row is malformed or missing', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('count(*)::int AS active_jobs')) return Promise.resolve({ rows: [{ active_jobs: 0 }] });
      if (sql.includes('SELECT display_price_minor')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('gives the owner otherMembersActiveJobs 0 without a visible-jobs query, however large the company usage', async () => {
    mockReadCompanyUsage.mockResolvedValue({ organizationId: ORG, activeJobs: 9, templates: 4, activeForemen: 1, suspendedForemen: 0 });
    answer(1);

    const body = JSON.parse((await handler(event())).body);

    expect(body.role).toBe('owner');
    expect(body.activeJobUsage).toBe(9);
    expect(body.otherMembersActiveJobs).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('AS active_jobs'))).toBe(false);
  });

  it('answers 403 no_organization for an employer with no membership row', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'no_organization' });

    const res = await handler(event());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_organization' });
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
  });

  it.each([
    ['resolveCompanyEntitlements', 'billing_plan_catalog_invalid', () => mockResolveEntitlements.mockRejectedValue(new Error('billing_plan_catalog_invalid'))],
    ['readCompanyUsage (unavailable)', 'company_usage_unavailable', () => mockReadCompanyUsage.mockRejectedValue(new Error('company_usage_unavailable'))],
    ['readCompanyUsage (42501)', '42501', () => mockReadCompanyUsage.mockRejectedValue(Object.assign(new Error('not an active member'), { code: '42501' }))],
  ])('answers 500 internal_error and rolls back when %s rejects (%s)', async (_name, _detail, arrange) => {
    arrange();

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('answers 403 membership_inactive and rolls back when the usage read refuses the caller', async () => {
    mockReadCompanyUsage.mockRejectedValue(new CompanyUsageRefusedError());

    const res = await handler(event());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('answers 200 with subscription null for a company with no subscription row', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('count(*)::int AS active_jobs')) return Promise.resolve({ rows: [{ active_jobs: 3 }] });
      if (sql.includes('SELECT display_price_minor')) return Promise.resolve({ rows: [{ display_price_minor: 0, currency: 'usd', billing_interval: 'month' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).subscription).toBeNull();
  });

  it('returns legal wall response before billing queries when ToS is stale', async () => {
    mockCheckCompliance.mockResolvedValue({ userExists: true, compliant: false, currentVersion: 'old' });

    const res = await handler(event());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'legal_required', requiredVersion: 'v1', currentVersion: 'old' });
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
    expect(mockResolveEmployerActor).not.toHaveBeenCalled();
  });
});
