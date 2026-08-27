import Stripe = require('stripe');
import { randomBytes } from 'crypto';

// Fixture keys are generated at runtime, never written as literals: a
// key-shaped literal (rk_live_… / rk_test_… + 24+ chars) trips GitHub push
// protection even when fake, and there is no reason for one to exist in source.
const fakeStripeKey = (mode: 'test' | 'live'): string => `rk_${mode}_${randomBytes(24).toString('hex')}`;

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: (...args: any[]) => mockSend(...args),
  })),
  GetSecretValueCommand: jest.fn(),
}));

describe('stripe-client', () => {
  const originalEnv = process.env;

  let getStripeSecret: any;
  let getStripe: any;
  let clearStripeCache: any;
  let STRIPE_API_VERSION: any;
  let StripeConfigError: any;

  const validSecret = {
    secretKey: fakeStripeKey('test'),
    priceIdEmployerPro: 'price_00000000000000',
    portalConfigurationId: 'bpc_00000000000000',
  };

  beforeEach(() => {
    mockSend.mockReset();
    jest.clearAllMocks();
    process.env = { ...originalEnv, STRIPE_SECRET_ARN: 'arn:aws:secretsmanager:test:stripe' };

    jest.isolateModules(() => {
      const mod = require('../../../lambda/lib/stripe-client');
      getStripeSecret = mod.getStripeSecret;
      getStripe = mod.getStripe;
      clearStripeCache = mod.clearStripeCache;
      STRIPE_API_VERSION = mod.STRIPE_API_VERSION;
      StripeConfigError = mod.StripeConfigError;
      clearStripeCache();
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('exact SDK/API version pin', () => {
    it('pins the exact Stripe SDK package version', () => {
      expect(Stripe.PACKAGE_VERSION).toBe('22.3.0');
    });

    it('pins the exact Stripe API version', () => {
      expect(Stripe.API_VERSION).toBe('2026-06-24.dahlia');
      expect(STRIPE_API_VERSION).toBe('2026-06-24.dahlia');
    });
  });

  describe('getStripeSecret', () => {
    it('fetches and parses a valid secret', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      const secret = await getStripeSecret();
      expect(secret).toEqual(validSecret);
    });

    it('throws StripeConfigError with stripe_secret_arn_missing when STRIPE_SECRET_ARN is not set', async () => {
      delete process.env.STRIPE_SECRET_ARN;
      await expect(getStripeSecret()).rejects.toThrow('stripe_secret_arn_missing');
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_secret_arn_missing');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_missing_string when the secret has no SecretString (binary secret)', async () => {
      mockSend.mockResolvedValue({ SecretBinary: new Uint8Array([1, 2, 3]) });
      await expect(getStripeSecret()).rejects.toThrow('stripe_api_secret_missing_string');
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_missing_string');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_malformed on non-JSON secret string', async () => {
      mockSend.mockResolvedValue({ SecretString: 'not-json{{{' });
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_malformed');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_invalid_key when secretKey is missing (incomplete secret)', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify({ priceIdEmployerPro: 'price_x' }) });
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_invalid_key');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_invalid_key when secretKey does not have the rk_ prefix', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ ...validSecret, secretKey: 'sk_live_shouldnotuse' }),
      });
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_invalid_key');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_invalid_price when priceIdEmployerPro has an invalid prefix', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ ...validSecret, priceIdEmployerPro: 'not-a-price-id' }),
      });
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_invalid_price');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_unreadable on SM ResourceNotFoundException', async () => {
      const smError: any = new Error('Secrets Manager can’t find the specified secret.');
      smError.name = 'ResourceNotFoundException';
      mockSend.mockRejectedValue(smError);
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_unreadable');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_unreadable on SM AccessDeniedException', async () => {
      const smError: any = new Error('User is not authorized to perform: secretsmanager:GetSecretValue');
      smError.name = 'AccessDeniedException';
      mockSend.mockRejectedValue(smError);
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_unreadable');
      }
    });

    it('throws StripeConfigError with stripe_api_secret_unreadable on other terminal SM 4xx responses', async () => {
      const smError: any = new Error('Invalid SecretId');
      smError.name = 'ValidationException';
      smError.$metadata = { httpStatusCode: 400 };
      mockSend.mockRejectedValue(smError);
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(StripeConfigError);
        expect((err as any).reason).toBe('stripe_api_secret_unreadable');
        expect((err as Error).message).not.toContain('Invalid SecretId');
      }
    });

    it('does NOT wrap SM ThrottlingException as StripeConfigError (stays retryable)', async () => {
      const smError: any = new Error('Rate exceeded');
      smError.name = 'ThrottlingException';
      mockSend.mockRejectedValue(smError);
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).not.toBeInstanceOf(StripeConfigError);
        expect((err as any).name).toBe('ThrottlingException');
      }
    });

    it('does NOT wrap a Secrets Manager 5xx as StripeConfigError (stays retryable)', async () => {
      const smError: any = new Error('Internal service error');
      smError.name = 'InternalServiceErrorException';
      smError.$metadata = { httpStatusCode: 500 };
      mockSend.mockRejectedValue(smError);
      try {
        await getStripeSecret();
        throw new Error('expected getStripeSecret to reject');
      } catch (err) {
        expect(err).not.toBeInstanceOf(StripeConfigError);
        expect((err as any).$metadata?.httpStatusCode).toBe(500);
      }
    });

    it('does not require priceIdEmployerPro or portalConfigurationId to be present', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ secretKey: validSecret.secretKey }),
      });
      const secret = await getStripeSecret();
      expect(secret.secretKey).toBe(validSecret.secretKey);
    });

    it('caches the secret for subsequent calls within the TTL', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      await getStripeSecret();
      await getStripeSecret();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('refetches after clearStripeCache is called', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      await getStripeSecret();
      clearStripeCache();
      await getStripeSecret();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('refetches after the 5-minute TTL expires', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      const dateSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_000_000;
      dateSpy.mockReturnValue(baseTime);

      await getStripeSecret();

      dateSpy.mockReturnValue(baseTime + 5 * 60 * 1000 + 1);
      await getStripeSecret();

      expect(mockSend).toHaveBeenCalledTimes(2);
      dateSpy.mockRestore();
    });

    it('does not refetch just before the 5-minute TTL expires', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      const dateSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_000_000;
      dateSpy.mockReturnValue(baseTime);

      await getStripeSecret();

      dateSpy.mockReturnValue(baseTime + 5 * 60 * 1000 - 1);
      await getStripeSecret();

      expect(mockSend).toHaveBeenCalledTimes(1);
      dateSpy.mockRestore();
    });
  });

  describe('getStripe', () => {
    it('constructs a Stripe client pinned to the exact API version', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      const stripe = await getStripe();
      // jest.isolateModules gives stripe-client.ts its own copy of the 'stripe'
      // module registry, so the constructed instance isn't `instanceof` this
      // file's top-level `Stripe` import — check shape/name and API version instead.
      expect(stripe.constructor.name).toBe('Stripe');
      expect((stripe as any)._api.version).toBe('2026-06-24.dahlia');
    });

    it('reuses the same Stripe client instance on subsequent calls', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      const stripe1 = await getStripe();
      const stripe2 = await getStripe();

      expect(stripe1).toBe(stripe2);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('constructs a new Stripe client after clearStripeCache', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      const stripe1 = await getStripe();
      clearStripeCache();
      const stripe2 = await getStripe();

      expect(stripe1).not.toBe(stripe2);
    });

    // ── operator key rotation on a warm container ──────────────────────────
    // getStripeSecret() re-reads Secrets Manager every CACHE_TTL_MS, so a
    // rotation must reach the memoized Stripe client too: a warm container
    // that keeps its old client keeps transacting with the retired key.
    const rotatedSecret = {
      ...validSecret,
      secretKey: fakeStripeKey('live'),
    };

    // The SDK keeps the key an instance was constructed with on
    // `_authenticator._apiKey`. Like the `_api.version` reach-in above this is
    // a private internal, and it is the only way to observe which key a
    // constructed client will actually authenticate with.
    const keyOf = (stripe: any): string => stripe._authenticator._apiKey;

    it('does not rebuild the client while the secret keeps returning the same key', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });

      const stripe1 = await getStripe();
      const stripe2 = await getStripe();

      expect(stripe2).toBe(stripe1);
      expect(keyOf(stripe2)).toBe(validSecret.secretKey);
    });

    it('rebuilds the client with the rotated key once the secret TTL expires', async () => {
      const dateSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_000_000;
      dateSpy.mockReturnValue(baseTime);

      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });
      const stripe1 = await getStripe();
      expect(keyOf(stripe1)).toBe(validSecret.secretKey);

      // Operator rotates rk_test_ -> rk_live_ in Secrets Manager.
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(rotatedSecret) });
      dateSpy.mockReturnValue(baseTime + 5 * 60 * 1000 + 1);

      const stripe2 = await getStripe();

      expect(stripe2).not.toBe(stripe1);
      expect(keyOf(stripe2)).toBe(rotatedSecret.secretKey);
      // The rebuilt client keeps the compile-time API version pin.
      expect((stripe2 as any)._api.version).toBe('2026-06-24.dahlia');
      expect(mockSend).toHaveBeenCalledTimes(2);
      dateSpy.mockRestore();
    });

    it('does not rebuild the client within the TTL even if Secrets Manager would now return a different key', async () => {
      const dateSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_000_000;
      dateSpy.mockReturnValue(baseTime);

      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });
      const stripe1 = await getStripe();

      mockSend.mockResolvedValue({ SecretString: JSON.stringify(rotatedSecret) });
      dateSpy.mockReturnValue(baseTime + 5 * 60 * 1000 - 1);

      const stripe2 = await getStripe();

      // The secret cache is authoritative for the TTL window, so no extra
      // Secrets Manager read and no needless client rebuild.
      expect(stripe2).toBe(stripe1);
      expect(keyOf(stripe2)).toBe(validSecret.secretKey);
      expect(mockSend).toHaveBeenCalledTimes(1);
      dateSpy.mockRestore();
    });

    it('propagates a transient Secrets Manager failure raised while refreshing the secret', async () => {
      const dateSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_000_000;
      dateSpy.mockReturnValue(baseTime);

      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });
      await getStripe();

      const smError: any = new Error('Rate exceeded');
      smError.name = 'ThrottlingException';
      mockSend.mockRejectedValue(smError);
      dateSpy.mockReturnValue(baseTime + 5 * 60 * 1000 + 1);

      // The stale client is deliberately NOT served as a fallback — the key it
      // holds may already be revoked. The error keeps its existing retryable
      // classification at the caller.
      try {
        await getStripe();
        throw new Error('expected getStripe to reject');
      } catch (err) {
        expect(err).not.toBeInstanceOf(StripeConfigError);
        expect((err as any).name).toBe('ThrottlingException');
      }
      dateSpy.mockRestore();
    });
  });
});
