import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../../../lambda/lib/db';
import { checkCompliance } from '../../../lambda/legal/check-compliance';
import { getStripe, getStripeSecret, StripeConfigError } from '../../../lambda/lib/stripe-client';
import { handler } from '../../../lambda/billing/portal';

jest.mock('../../../lambda/lib/db');
jest.mock('../../../lambda/legal/check-compliance');
// Keep the real StripeConfigError class (so `instanceof` checks in portal.ts
// work against genuine instances) while mocking the async functions.
jest.mock('../../../lambda/lib/stripe-client', () => ({
  ...jest.requireActual('../../../lambda/lib/stripe-client'),
  getStripe: jest.fn(),
  getStripeSecret: jest.fn(),
}));

const query = jest.fn();
const release = jest.fn();
const portalCreate = jest.fn();
const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockGetStripe = getStripe as jest.Mock;
const mockGetStripeSecret = getStripeSecret as jest.Mock;

function event(body: unknown = { returnUrl: 'http://localhost:3000/billing' }): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'cognito-sub' } } },
  } as unknown as APIGatewayProxyEvent;
}

describe('billing portal handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, ALLOWED_ORIGIN: 'http://localhost:3000', REQUIRED_TOS_VERSION: 'v1' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query, release }) });
    mockCheckCompliance.mockResolvedValue({ userExists: true, compliant: true, currentVersion: 'v1' });
    mockGetStripeSecret.mockResolvedValue({ portalConfigurationId: 'bpc_123' });
    mockGetStripe.mockResolvedValue({ billingPortal: { sessions: { create: portalCreate } } });
    portalCreate.mockResolvedValue({ url: 'https://billing.stripe.test/session' });
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT bc.provider_customer_id')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects cross-origin return URLs before DB or Stripe work', async () => {
    const res = await handler(event({ returnUrl: 'https://evil.example/billing' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_return_origin' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it('commits and closes the DB transaction before creating the Stripe portal session', async () => {
    const calls: string[] = [];
    query.mockImplementation((sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT bc.provider_customer_id')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });
    portalCreate.mockImplementation(async () => {
      expect(calls).toContain('COMMIT');
      return { url: 'https://billing.stripe.test/session' };
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://billing.stripe.test/session' });
    expect(setRlsContext).toHaveBeenCalledWith(expect.any(Object), 'cognito-sub');
    expect(portalCreate).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'http://localhost:3000/billing',
      configuration: 'bpc_123',
    });
    expect(release).toHaveBeenCalled();
  });

  it('returns configuration error when portal configuration is absent', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetStripeSecret.mockResolvedValue({});

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_configuration_invalid' });
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(portalCreate).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      'billing-portal configuration error:',
      'stripe_portal_configuration_missing',
    );
    errorLog.mockRestore();
  });

  it('returns billing_configuration_invalid (not a retryable error) when getStripeSecret throws StripeConfigError', async () => {
    mockGetStripeSecret.mockRejectedValue(new StripeConfigError('stripe_api_secret_invalid_key'));

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_configuration_invalid' });
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(portalCreate).not.toHaveBeenCalled();
  });

  it('returns billing_configuration_invalid when getStripe throws StripeConfigError', async () => {
    mockGetStripeSecret.mockResolvedValue({ portalConfigurationId: 'bpc_123' });
    mockGetStripe.mockRejectedValue(new StripeConfigError('stripe_secret_arn_missing'));

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_configuration_invalid' });
    expect(portalCreate).not.toHaveBeenCalled();
  });
});
