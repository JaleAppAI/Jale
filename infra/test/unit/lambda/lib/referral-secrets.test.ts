const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args })),
}));

import { getVisitorSalt, clearVisitorSaltCache } from '../../../../lambda/lib/referral-secrets';

describe('getVisitorSalt', () => {
  const env = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    clearVisitorSaltCache();
    process.env = { ...env, REFERRAL_VISITOR_SALT_SECRET_ARN: 'arn:aws:secretsmanager:x:0:secret:salt' };
  });
  afterAll(() => { process.env = env; });

  it('returns the fetched salt and caches it', async () => {
    mockSend.mockResolvedValue({ SecretString: 'the-salt' });
    expect(await getVisitorSalt()).toBe('the-salt');
    expect(await getVisitorSalt()).toBe('the-salt');
    expect(mockSend).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('returns null when unconfigured — a missing salt degrades, never breaks the page', async () => {
    delete process.env.REFERRAL_VISITOR_SALT_SECRET_ARN;
    expect(await getVisitorSalt()).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null on a fetch failure without leaking anything', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSend.mockRejectedValue(new Error('access denied to arn:aws:secretsmanager:x:0:secret:salt'));
    expect(await getVisitorSalt()).toBeNull();
    // A static metric only — the log line must not carry the ARN or any error text.
    for (const call of errSpy.mock.calls) {
      expect(String(call[0])).not.toContain('arn:');
    }
    errSpy.mockRestore();
  });

  it('treats a blank secret value as unconfigured', async () => {
    mockSend.mockResolvedValue({ SecretString: '   ' });
    expect(await getVisitorSalt()).toBeNull();
  });
});
