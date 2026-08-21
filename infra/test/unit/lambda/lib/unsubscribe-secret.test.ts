const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args })),
}));

import { getUnsubscribeSecret, clearUnsubscribeSecretCache } from '../../../../lambda/lib/unsubscribe-secret';

/**
 * The digest unsubscribe signing secret is FAIL-CLOSED, unlike
 * referral-secrets.ts's getVisitorSalt() which deliberately returns null.
 * A null here would mean "accept an unsigned link", i.e. anyone could
 * unsubscribe any employer by guessing a UUID. Every unreadable-secret shape
 * must therefore throw, never resolve.
 */
describe('getUnsubscribeSecret', () => {
  const env = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    clearUnsubscribeSecretCache();
    process.env = { ...env, UNSUBSCRIBE_SECRET_ARN: 'arn:aws:secretsmanager:x:0:secret:unsub' };
  });
  afterAll(() => { process.env = env; });

  it('returns the bare-string secret value, trimmed', async () => {
    mockSend.mockResolvedValue({ SecretString: '  s3cret-signing-key  ' });
    await expect(getUnsubscribeSecret()).resolves.toBe('s3cret-signing-key');
  });

  it('caches for the TTL window instead of calling Secrets Manager per invocation', async () => {
    mockSend.mockResolvedValue({ SecretString: 'cached-key' });
    await expect(getUnsubscribeSecret()).resolves.toBe('cached-key');
    await expect(getUnsubscribeSecret()).resolves.toBe('cached-key');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the 5-minute TTL has elapsed', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    mockSend.mockResolvedValue({ SecretString: 'first-key' });
    await expect(getUnsubscribeSecret()).resolves.toBe('first-key');

    now.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
    mockSend.mockResolvedValue({ SecretString: 'rotated-key' });
    await expect(getUnsubscribeSecret()).resolves.toBe('rotated-key');
    expect(mockSend).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('throws when the env var is unset — never falls back to unsigned links', async () => {
    delete process.env.UNSUBSCRIBE_SECRET_ARN;
    await expect(getUnsubscribeSecret()).rejects.toThrow('UNSUBSCRIBE_SECRET_ARN');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws when the secret has no SecretString', async () => {
    mockSend.mockResolvedValue({});
    await expect(getUnsubscribeSecret()).rejects.toThrow('unsubscribe_secret_missing_string');
  });

  it('throws when the secret value is blank', async () => {
    mockSend.mockResolvedValue({ SecretString: '    ' });
    await expect(getUnsubscribeSecret()).rejects.toThrow('unsubscribe_secret_empty');
  });

  it('does not cache a failure — a transient error must not poison the container', async () => {
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(getUnsubscribeSecret()).rejects.toThrow('throttled');
    mockSend.mockResolvedValue({ SecretString: 'recovered-key' });
    await expect(getUnsubscribeSecret()).resolves.toBe('recovered-key');
  });
});
