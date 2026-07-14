/**
 * Tests for infra/lambda/lib/stripe-webhook.ts
 *
 * Covers:
 *  - Secret loader: absent ARN, binary/malformed/invalid-prefix secrets
 *  - Real cryptographic signature verification (plain + base64-encoded body)
 *  - Tampered body fails
 */
import Stripe = require('stripe');
import {
  getWebhookSecret,
  verifyStripeEvent,
  clearWebhookSecretCache,
} from '../../../lambda/lib/stripe-webhook';

// ── Secrets Manager mock ──────────────────────────────────────────────────────
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const send = jest.fn();
  const GetSecretValueCommand = jest.fn().mockImplementation((params: unknown) => ({ params }));
  const SecretsManagerClient = jest.fn().mockImplementation(() => ({ send }));
  return { SecretsManagerClient, GetSecretValueCommand, __mockSend: send };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const smMock = require('@aws-sdk/client-secrets-manager');
const mockSend: jest.Mock = smMock.__mockSend;

// Fake signing secret — never a real value
const FAKE_SECRET = 'whsec_' + '0'.repeat(32);

function mockSecretString(value: string): void {
  mockSend.mockResolvedValueOnce({ SecretString: value });
}

describe('stripe-webhook: getWebhookSecret()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    clearWebhookSecretCache();
    jest.resetAllMocks();
    process.env = { ...originalEnv, WEBHOOK_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:test' };
  });

  afterAll(() => {
    process.env = originalEnv;
    clearWebhookSecretCache();
  });

  it('throws when WEBHOOK_SECRET_ARN env var is absent', async () => {
    delete process.env.WEBHOOK_SECRET_ARN;
    await expect(getWebhookSecret()).rejects.toThrow('WEBHOOK_SECRET_ARN env var not set');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws when SecretString is null/missing', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: null });
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_missing_string');
  });

  it('throws when SecretString is binary (not parseable JSON)', async () => {
    // Simulate binary data returned as a non-JSON string
    mockSend.mockResolvedValueOnce({ SecretString: '\x00\x01\xFF' });
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_not_json');
  });

  it('throws when JSON is not an object (array)', async () => {
    mockSecretString('["not", "an", "object"]');
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_not_object');
  });

  it('throws when webhookSigningSecret field is missing', async () => {
    mockSecretString(JSON.stringify({ someOtherField: 'value' }));
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_missing_field');
  });

  it('throws when webhookSigningSecret is not a string', async () => {
    mockSecretString(JSON.stringify({ webhookSigningSecret: 42 }));
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_missing_field');
  });

  it('throws when webhookSigningSecret is empty string', async () => {
    mockSecretString(JSON.stringify({ webhookSigningSecret: '' }));
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_missing_field');
  });

  it('throws when webhookSigningSecret has invalid prefix (sk_ not whsec_)', async () => {
    mockSecretString(JSON.stringify({ webhookSigningSecret: 'sk_test_' + '0'.repeat(32) }));
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_invalid_prefix');
  });

  it('throws when webhookSigningSecret has invalid prefix (plain string)', async () => {
    mockSecretString(JSON.stringify({ webhookSigningSecret: 'plaintextvalue' }));
    await expect(getWebhookSecret()).rejects.toThrow('webhook_secret_invalid_prefix');
  });

  it('returns the webhookSigningSecret on valid input', async () => {
    mockSecretString(JSON.stringify({ webhookSigningSecret: FAKE_SECRET }));
    const result = await getWebhookSecret();
    expect(result.webhookSigningSecret).toBe(FAKE_SECRET);
  });

  it('caches within TTL and does not call Secrets Manager again', async () => {
    mockSecretString(JSON.stringify({ webhookSigningSecret: FAKE_SECRET }));
    await getWebhookSecret();
    const second = await getWebhookSecret();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(second.webhookSigningSecret).toBe(FAKE_SECRET);
  });

  it('refreshes after clearWebhookSecretCache()', async () => {
    mockSecretString(JSON.stringify({ webhookSigningSecret: FAKE_SECRET }));
    await getWebhookSecret();
    clearWebhookSecretCache();
    mockSecretString(JSON.stringify({ webhookSigningSecret: FAKE_SECRET }));
    await getWebhookSecret();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('stripe-webhook: verifyStripeEvent()', () => {
  const testPayload = JSON.stringify({
    id: 'evt_test000',
    object: 'event',
    type: 'customer.subscription.created',
    data: { object: { id: 'sub_test000' } },
  });

  it('verifies a valid plain-UTF8 body with a matching signature', () => {
    const body = Buffer.from(testPayload, 'utf8');
    const header = Stripe.webhooks.generateTestHeaderString({
      payload: testPayload,
      secret: FAKE_SECRET,
    });
    // Should NOT throw
    const evt = verifyStripeEvent(body, header, FAKE_SECRET);
    expect(evt.id).toBe('evt_test000');
    expect(evt.type).toBe('customer.subscription.created');
  });

  it('verifies when the body is base64-decoded back to UTF-8 (simulates API Gateway isBase64Encoded path)', () => {
    // Simulate: API Gateway sends base64-encoded body; handler decodes it to Buffer before verifying
    const base64 = Buffer.from(testPayload, 'utf8').toString('base64');
    const decodedBuffer = Buffer.from(base64, 'base64');
    const header = Stripe.webhooks.generateTestHeaderString({
      payload: testPayload,
      secret: FAKE_SECRET,
    });
    const evt = verifyStripeEvent(decodedBuffer, header, FAKE_SECRET);
    expect(evt.id).toBe('evt_test000');
  });

  it('throws StripeSignatureVerificationError on a tampered body', () => {
    const tamperedBody = Buffer.from(testPayload.replace('evt_test000', 'evt_tampered'), 'utf8');
    const header = Stripe.webhooks.generateTestHeaderString({
      payload: testPayload,
      secret: FAKE_SECRET,
    });
    expect(() => verifyStripeEvent(tamperedBody, header, FAKE_SECRET)).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );
  });

  it('throws StripeSignatureVerificationError on wrong secret', () => {
    const body = Buffer.from(testPayload, 'utf8');
    const header = Stripe.webhooks.generateTestHeaderString({
      payload: testPayload,
      secret: FAKE_SECRET,
    });
    const wrongSecret = 'whsec_' + '1'.repeat(32);
    expect(() => verifyStripeEvent(body, header, wrongSecret)).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );
  });

  it('throws on an empty/missing signature header', () => {
    const body = Buffer.from(testPayload, 'utf8');
    expect(() => verifyStripeEvent(body, '', FAKE_SECRET)).toThrow();
  });
});
