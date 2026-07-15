import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../../../lambda/lib/db';
import { checkCompliance } from '../../../lambda/legal/check-compliance';
import { resolveEntitlements } from '../../../lambda/lib/entitlements';
import { handler } from '../../../lambda/billing/get-billing';

jest.mock('../../../lambda/lib/db');
jest.mock('../../../lambda/legal/check-compliance');
jest.mock('../../../lambda/lib/entitlements');

const query = jest.fn();
const release = jest.fn();
const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockResolveEntitlements = resolveEntitlements as jest.Mock;

function event(): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'cognito-sub' } } },
  } as unknown as APIGatewayProxyEvent;
}

describe('billing get handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query, release }) });
    mockCheckCompliance.mockResolvedValue({ userExists: true, compliant: true, currentVersion: 'v1' });
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10 });
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
      if (sql.includes('count(*)::int AS active_jobs')) return Promise.resolve({ rows: [{ active_jobs: 3 }] });
      if (sql.includes('SELECT display_price_minor')) return Promise.resolve({ rows: [{ display_price_minor: 2000, currency: 'usd', billing_interval: 'month' }] });
      if (sql.includes('SELECT plan_code, status')) return Promise.resolve({ rows: [{ plan_code: 'employer_pro', status: 'active' }] });
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns catalog-backed billing state and active job usage without Stripe calls', async () => {
    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      planCode: 'employer_pro',
      activeJobLimit: 10,
      activeJobUsage: 3,
      subscription: { plan_code: 'employer_pro', status: 'active' },
      display_price_minor: 2000,
      currency: 'usd',
      billing_interval: 'month',
    });
    expect(mockResolveEntitlements).toHaveBeenCalledWith(expect.any(Object), 'user-1');
    expect(setRlsContext).toHaveBeenCalledWith(expect.any(Object), 'cognito-sub');
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('returns internal_error when the active billing plan catalog row is malformed or missing', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'user-1' }] });
      if (sql.includes('count(*)::int AS active_jobs')) return Promise.resolve({ rows: [{ active_jobs: 0 }] });
      if (sql.includes('SELECT display_price_minor')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('returns legal wall response before billing queries when ToS is stale', async () => {
    mockCheckCompliance.mockResolvedValue({ userExists: true, compliant: false, currentVersion: 'old' });

    const res = await handler(event());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'legal_required', requiredVersion: 'v1', currentVersion: 'old' });
    expect(mockResolveEntitlements).not.toHaveBeenCalled();
  });
});
