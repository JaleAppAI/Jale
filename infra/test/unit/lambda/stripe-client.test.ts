import Stripe = require('stripe');

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

  const validSecret = {
    secretKey: 'rk_test_00000000000000000000000000000000000000000000000000',
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

    it('throws when STRIPE_SECRET_ARN is not set', async () => {
      delete process.env.STRIPE_SECRET_ARN;
      await expect(getStripeSecret()).rejects.toThrow('STRIPE_SECRET_ARN env var not set');
    });

    it('throws when the secret has no SecretString (binary secret)', async () => {
      mockSend.mockResolvedValue({ SecretBinary: new Uint8Array([1, 2, 3]) });
      await expect(getStripeSecret()).rejects.toThrow('stripe_api_secret_missing_string');
    });

    it('throws on malformed (non-JSON) secret string', async () => {
      mockSend.mockResolvedValue({ SecretString: 'not-json{{{' });
      await expect(getStripeSecret()).rejects.toThrow();
    });

    it('throws when secretKey is missing (incomplete secret)', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify({ priceIdEmployerPro: 'price_x' }) });
      await expect(getStripeSecret()).rejects.toThrow('stripe_api_secret_invalid_key');
    });

    it('throws when secretKey does not have the rk_ prefix', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ ...validSecret, secretKey: 'sk_live_shouldnotuse' }),
      });
      await expect(getStripeSecret()).rejects.toThrow('stripe_api_secret_invalid_key');
    });

    it('throws when priceIdEmployerPro has an invalid prefix', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ ...validSecret, priceIdEmployerPro: 'not-a-price-id' }),
      });
      await expect(getStripeSecret()).rejects.toThrow('stripe_api_secret_invalid_price');
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
  });
});
