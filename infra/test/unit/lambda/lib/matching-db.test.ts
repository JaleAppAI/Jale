import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: (...args: any[]) => mockSend(...args),
  })),
  GetSecretValueCommand: jest.fn(),
}));

let identityRow: { session_login: string; login: string; rls_active: boolean } =
  { session_login: 'jale_matching', login: 'jale_matching', rls_active: true };
const identityQueries: string[] = [];

jest.mock('pg', () => ({
  Pool: jest.fn(() => {
    const client = {
      query: jest.fn(async (sql: string) => {
        identityQueries.push(sql);
        return { rows: [identityRow], rowCount: 1 };
      }),
      release: jest.fn(),
      getTransactionStatus: jest.fn(() => 'I'),
    };
    return {
      on: jest.fn(),
      end: jest.fn(async () => undefined),
      connect: jest.fn(async () => {
        client.release = jest.fn();
        return client;
      }),
    };
  }),
}));

describe('matching DB utility', () => {
  const originalEnv = process.env;
  let getMatchingDbPool: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
    identityQueries.length = 0;
    identityRow = { session_login: 'jale_matching', login: 'jale_matching', rls_active: true };
    process.env = {
      ...originalEnv,
      MATCHING_DB_SECRET_ARN: 'matching-secret-name',
      DB_EXPECTED_LOGIN: 'jale_matching',
      DB_HOST: 'db.example.com',
      DB_PORT: '5432',
      DB_NAME: 'jale',
    };
    delete process.env.DB_SECRET_ARN;
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({
        username: 'jale_matching',
        password: 'matching-pass',
      }),
    });

    jest.isolateModules(() => {
      getMatchingDbPool = require('../../../../lambda/lib/matching-db').getMatchingDbPool;
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('takes host, port and database from env and only the credentials from the matching secret', async () => {
    await getMatchingDbPool();

    expect(GetSecretValueCommand).toHaveBeenCalledTimes(1);
    expect(GetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'matching-secret-name' });
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.example.com',
      port: 5432,
      database: 'jale',
      user: 'jale_matching',
      password: 'matching-pass',
      max: 1,
    }));
  });

  it.each(['DB_HOST', 'DB_PORT', 'DB_NAME'])('refuses to build a pool without %s', async (name) => {
    delete process.env[name];
    await expect(getMatchingDbPool()).rejects.toThrow(name);
    expect(Pool).not.toHaveBeenCalled();
  });

  it.each(['0', 'abc', '70000', '5432x'])('refuses DB_PORT=%p', async (port) => {
    process.env.DB_PORT = port;
    await expect(getMatchingDbPool()).rejects.toThrow('DB_PORT');
    expect(Pool).not.toHaveBeenCalled();
  });

  it('runs the boot identity check once per pool', async () => {
    const a = await getMatchingDbPool();
    const b = await getMatchingDbPool();
    expect(a).toBe(b);
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(identityQueries.filter((sql) => /session_user[\s\S]*current_user[\s\S]*row_security_active\(c\.oid\)/.test(sql))).toHaveLength(1);
  });

  it('fails closed on a login mismatch and retries on the next call', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    identityRow = { session_login: 'jale_api', login: 'jale_api', rls_active: true };

    await expect(getMatchingDbPool()).rejects.toThrow(/identity/i);
    const metric = logSpy.mock.calls
      .map(([line]) => line)
      .find((line) => typeof line === 'string' && line.includes('DbIdentityCheckFailed'));
    expect(JSON.parse(metric as string)).toMatchObject({ Login: 'jale_matching' });

    identityRow = { session_login: 'jale_matching', login: 'jale_matching', rls_active: true };
    await expect(getMatchingDbPool()).resolves.toBeDefined();
    expect(Pool).toHaveBeenCalledTimes(2);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('refuses a secret for another login before connecting, and reports it as a login mismatch', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ username: 'jale_admin', password: 'matching-pass' }) });

    await expect(getMatchingDbPool()).rejects.toMatchObject({ reason: 'login_mismatch' });
    expect(Pool).not.toHaveBeenCalled();
    const metrics = logSpy.mock.calls
      .map(([line]) => line)
      .filter((line) => typeof line === 'string' && line.includes('DbIdentityCheckFailed'))
      .map((line) => JSON.parse(line as string));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ Login: 'jale_matching', DbIdentityCheckFailed: 1 });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('refuses a session that signed in as another login, even when its current role is the matching login', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    identityRow = { session_login: 'jale_admin', login: 'jale_matching', rls_active: true };

    await expect(getMatchingDbPool()).rejects.toMatchObject({ reason: 'login_mismatch' });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
