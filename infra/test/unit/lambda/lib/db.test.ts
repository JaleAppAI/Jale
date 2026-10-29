import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: (...args: any[]) => mockSend(...args)
  })),
  GetSecretValueCommand: jest.fn()
}));

// One fake pg pool per `new Pool(...)`. Each pool hands out one fake client
// whose identity-check answer the test controls through `identityRow`.
type FakeClient = {
  query: jest.Mock;
  release: jest.Mock;
  getTransactionStatus: jest.Mock;
};
type FakePool = {
  on: jest.Mock;
  end: jest.Mock;
  connect: jest.Mock;
  client: FakeClient;
  /** The release function pg-pool assigned on the latest checkout. */
  lastRelease: jest.Mock;
  /** pg-pool's own connect; the guard replaces `connect` on the instance. */
  rawConnect: jest.Mock;
};
let identityRow: { session_login: string; login: string; rls_active: boolean } | Error =
  { session_login: 'jale_api', login: 'jale_api', rls_active: true };
const createdPools: FakePool[] = [];

function makeFakePool(): FakePool {
  const client: FakeClient = {
    query: jest.fn(async () => {
      if (identityRow instanceof Error) throw identityRow;
      return { rows: [identityRow], rowCount: 1 };
    }),
    release: jest.fn(),
    getTransactionStatus: jest.fn(() => 'I'),
  };
  const rawConnect = jest.fn(async () => {
    // pg-pool assigns a fresh `release` on every checkout.
    const release = jest.fn();
    client.release = release;
    pool.lastRelease = release;
    return client;
  });
  const pool: FakePool = {
    on: jest.fn(),
    end: jest.fn(async () => undefined),
    connect: rawConnect,
    client,
    lastRelease: jest.fn(),
    rawConnect,
  };
  createdPools.push(pool);
  return pool;
}

jest.mock('pg', () => ({ Pool: jest.fn(() => makeFakePool()) }));

const IDENTITY_QUERY = /session_user[\s\S]*current_user[\s\S]*row_security_active\(c\.oid\)[\s\S]*n\.nspname = 'public'[\s\S]*c\.relname = 'users'/;

function identityQueriesRun(): number {
  return createdPools.reduce(
    (count, pool) => count + pool.client.query.mock.calls.filter(([sql]: [string]) => IDENTITY_QUERY.test(sql)).length,
    0,
  );
}

function emittedIdentityFailures(logSpy: jest.SpyInstance): Array<Record<string, any>> {
  return logSpy.mock.calls
    .map(([line]) => line)
    .filter((line): line is string => typeof line === 'string' && line.includes('DbIdentityCheckFailed'))
    .map((line) => JSON.parse(line));
}

describe('DB Utility', () => {
  const originalEnv = process.env;

  let db: any;

  const mockSecret = {
    host: 'db.example.com',
    port: 5432,
    dbname: 'testdb',
    username: 'jale_api',
    password: 'password123',
  };

  beforeEach(() => {
    mockSend.mockReset();
    jest.clearAllMocks();
    createdPools.length = 0;
    identityRow = { session_login: 'jale_api', login: 'jale_api', rls_active: true };
    process.env = {
      ...originalEnv,
      DB_SECRET_ARN: 'arn:aws:secretsmanager:test',
      DB_EXPECTED_LOGIN: 'jale_api',
    };

    // isolate modules so the database smClient is reinstantiated per-test suite if needed
    jest.isolateModules(() => {
      db = require('../../../../lambda/lib/db');
      db.clearSecretCache();
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getDbSecret', () => {
    it('should fetch and parse secret from SecretsManager', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const secret = await db.getDbSecret();
      expect(secret).toEqual(mockSecret);
      expect(GetSecretValueCommand).toHaveBeenCalledWith({
        SecretId: 'arn:aws:secretsmanager:test',
      });
    });

    it('should use cached secret on subsequent calls', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      // First call
      await db.getDbSecret();
      // Second call
      const secret2 = await db.getDbSecret();

      expect(secret2).toEqual(mockSecret);
      expect(mockSend).toHaveBeenCalledTimes(1); // Cached
    });

    it('should refetch after cache is cleared', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      await db.getDbSecret();
      db.clearSecretCache();
      await db.getDbSecret();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should refetch secret after TTL expires', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const dateSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_000_000;
      dateSpy.mockReturnValue(baseTime);

      await db.getDbSecret(); // First fetch — cachedAt set to baseTime

      // Advance time past the 5-minute TTL (300 000 ms)
      dateSpy.mockReturnValue(baseTime + 5 * 60 * 1000 + 1);

      await db.getDbSecret(); // TTL expired — must refetch from Secrets Manager

      expect(mockSend).toHaveBeenCalledTimes(2);
      dateSpy.mockRestore();
    });
  });

  describe('getDbPool', () => {
    it('should initialize and return pg Pool using secrets', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const pool = await db.getDbPool();
      expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
        host: 'db.example.com',
        user: 'jale_api',
        password: 'password123',
        database: 'testdb',
      }));
      expect(pool).toBeDefined();
    });

    it('sets no session timeouts unless the Lambda asks for them', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      await db.getDbPool();
      const config = (Pool as unknown as jest.Mock).mock.calls[0][0];
      expect(config).not.toHaveProperty('statement_timeout');
      expect(config).not.toHaveProperty('lock_timeout');
    });

    it('passes DB_STATEMENT_TIMEOUT_MS and DB_LOCK_TIMEOUT_MS to the pool as session settings', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });
      process.env.DB_STATEMENT_TIMEOUT_MS = '5000';
      process.env.DB_LOCK_TIMEOUT_MS = '3000';

      await db.getDbPool();
      expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
        statement_timeout: 5000,
        lock_timeout: 3000,
      }));
    });

    it.each(['0', '-1', '1.5', 'abc', '60001', ' '])(
      'refuses a session timeout of %p before reading any secret',
      async (value) => {
        process.env.DB_LOCK_TIMEOUT_MS = value;
        await expect(db.getDbPool()).rejects.toThrow('DB_TIMEOUT_INVALID: DB_LOCK_TIMEOUT_MS');
        expect(mockSend).not.toHaveBeenCalled();
        expect(Pool).not.toHaveBeenCalled();
      },
    );

    it('should return the exact same pool instance on subsequent calls', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const pool1 = await db.getDbPool();
      const pool2 = await db.getDbPool();

      expect(pool1).toBe(pool2);
      expect(Pool).toHaveBeenCalledTimes(1);
    });
  });

  it('rds-ca-bundle.pem contains the full AWS global CA bundle (not truncated)', () => {
    const fs = jest.requireActual('fs');
    const path = jest.requireActual('path');
    const bundlePath = path.resolve(__dirname, '../../../../lambda/lib/rds-ca-bundle.pem');
    const content = fs.readFileSync(bundlePath, 'utf-8');
    const certCount = (content.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    expect(certCount).toBeGreaterThanOrEqual(50);
  });

  it('passes RDS CA bundle to pg Pool ssl config', async () => {
    // Use top-level mockSend (already wired to the module-level smClient) for the secret fetch.
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({
        host: 'localhost',
        port: 5432,
        dbname: 'test',
        username: 'jale_api',
        password: 'pass',
      }),
    });

    // Mock fs.readFileSync to return a known CA cert string, then re-require the
    // module in isolation so db.ts loads with the patched fs and a fresh pool state.
    let isolatedGetDbPool: any;
    jest.isolateModules(() => {
      jest.doMock('fs', () => ({
        ...jest.requireActual('fs'),
        readFileSync: jest.fn().mockReturnValue('MOCK_CA_CERT'),
      }));

      const isolated = require('../../../../lambda/lib/db');
      isolated.clearSecretCache();
      isolatedGetDbPool = isolated.getDbPool;
    });

    process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123456789:secret:test';
    await isolatedGetDbPool();

    // The top-level jest.mock('pg', ...) is still active; Pool is the hoisted mock.
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: expect.objectContaining({
          rejectUnauthorized: true,
          ca: 'MOCK_CA_CERT',
        }),
      }),
    );
  });

  it('sets the internal user UUID RLS context with a parameterized query', async () => {
    const client = { query: jest.fn().mockResolvedValue({}) };

    await db.setInternalUserRlsContext(client, 'worker-id');

    expect(client.query).toHaveBeenCalledWith(
      `SELECT set_config('app.current_internal_user_id', $1, true)`,
      ['worker-id'],
    );
  });

  // ── Boot identity check ───────────────────────────────────────────
  //
  // Every pool getter proves, on the pool's first connection, that it signed
  // in as the login the workload was deployed for and that row security is
  // active for it. Any failure throws, emits DbIdentityCheckFailed and leaves
  // the pool unbuilt so the next call retries.

  type Getter = 'getDbPool' | 'getPublicJobsDbPool';
  const getters: Getter[] = ['getDbPool', 'getPublicJobsDbPool'];

  describe.each(getters)('%s boot identity check', (getter) => {
    beforeEach(() => {
      process.env.REFERRALS_DB_SECRET_ARN = 'referrals-secret-name';
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });
    });

    it('checks session_user, current_user and the OID-form row_security_active probe on the first connection', async () => {
      const pool = await db[getter]();
      expect(pool).toBe(createdPools[0]);
      expect(identityQueriesRun()).toBe(1);
      // The check's client goes back to the pool idle, not destroyed.
      expect(createdPools[0].lastRelease).toHaveBeenCalledTimes(1);
      expect(createdPools[0].lastRelease.mock.calls[0][0]).toBeFalsy();
    });

    it('runs the check once per pool, not once per call, and builds one pool for concurrent first calls', async () => {
      const [a, b] = await Promise.all([db[getter](), db[getter]()]);
      const c = await db[getter]();
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(Pool).toHaveBeenCalledTimes(1);
      expect(identityQueriesRun()).toBe(1);
    });

    it('throws on a login mismatch, emits the metric and leaves the pool unbuilt so the next call retries', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      identityRow = { session_login: 'jale_whatsapp', login: 'jale_whatsapp', rls_active: true };

      await expect(db[getter]()).rejects.toThrow(/identity/i);
      expect(createdPools[0].end).toHaveBeenCalled();
      const [metric] = emittedIdentityFailures(logSpy);
      expect(metric).toMatchObject({ Login: 'jale_api', DbIdentityCheckFailed: 1 });
      expect(metric._aws.CloudWatchMetrics[0]).toMatchObject({
        Namespace: 'Jale/Database',
        Metrics: [{ Name: 'DbIdentityCheckFailed', Unit: 'Count' }],
      });
      // Both the per-login series and the dimensionless rollup the alarm reads.
      expect(metric._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Login'], []]);

      // Not cached: the next call builds and checks a fresh pool.
      identityRow = { session_login: 'jale_api', login: 'jale_api', rls_active: true };
      const pool = await db[getter]();
      expect(pool).toBe(createdPools[1]);
      expect(Pool).toHaveBeenCalledTimes(2);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('refuses a secret for another login before connecting, and reports it as a login mismatch', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockSend.mockResolvedValue({ SecretString: JSON.stringify({ ...mockSecret, username: 'jale_admin' }) });

      await expect(db[getter]()).rejects.toMatchObject({ reason: 'login_mismatch' });
      expect(Pool).not.toHaveBeenCalled();
      const metrics = emittedIdentityFailures(logSpy);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({ Login: 'jale_api', DbIdentityCheckFailed: 1 });
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('refuses a session that signed in as another login, even when its current role is the expected login', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      identityRow = { session_login: 'jale_admin', login: 'jale_api', rls_active: true };

      await expect(db[getter]()).rejects.toMatchObject({ reason: 'login_mismatch' });
      expect(createdPools[0].end).toHaveBeenCalled();
      expect(emittedIdentityFailures(logSpy)).toHaveLength(1);
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('throws when row security is not active for the login (a login with BYPASSRLS, or a superuser)', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      identityRow = { session_login: 'jale_api', login: 'jale_api', rls_active: false };

      await expect(db[getter]()).rejects.toThrow(/row security/i);
      expect(emittedIdentityFailures(logSpy)).toHaveLength(1);
      expect(createdPools[0].end).toHaveBeenCalled();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('throws before reading any secret when DB_EXPECTED_LOGIN is missing, with Login=unset', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      delete process.env.DB_EXPECTED_LOGIN;

      await expect(db[getter]()).rejects.toThrow(/DB_EXPECTED_LOGIN/);
      expect(mockSend).not.toHaveBeenCalled();
      expect(Pool).not.toHaveBeenCalled();
      const [metric] = emittedIdentityFailures(logSpy);
      expect(metric).toMatchObject({ Login: 'unset', DbIdentityCheckFailed: 1 });
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('refuses the master login as an expected login outright', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      process.env.DB_EXPECTED_LOGIN = 'jale_admin';
      identityRow = { session_login: 'jale_admin', login: 'jale_admin', rls_active: true };

      await expect(db[getter]()).rejects.toThrow(/jale_admin/);
      expect(Pool).not.toHaveBeenCalled();
      expect(emittedIdentityFailures(logSpy)[0]).toMatchObject({ Login: 'jale_admin' });
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('does not report an unreachable database as an identity failure, and retries on the next call', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      (Pool as unknown as jest.Mock).mockImplementationOnce(() => {
        const pool = makeFakePool();
        pool.rawConnect.mockRejectedValueOnce(new Error('connect timeout'));
        return pool;
      });

      await expect(db[getter]()).rejects.toThrow('connect timeout');
      expect(createdPools[0].end).toHaveBeenCalled();
      expect(emittedIdentityFailures(logSpy)).toHaveLength(0);

      const retried = await db[getter]();
      expect(retried).toBe(createdPools[1]);
      logSpy.mockRestore();
    });

    it('fails closed when the identity query itself errors', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      identityRow = new Error('permission denied');

      await expect(db[getter]()).rejects.toThrow('permission denied');
      expect(emittedIdentityFailures(logSpy)).toHaveLength(1);
      // The client that failed the check is destroyed, never pooled.
      expect(createdPools[0].lastRelease.mock.calls[0][0]).toBeTruthy();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('assertDbIdentity', () => {
    const client = (row: Record<string, unknown>) => ({ query: jest.fn(async () => ({ rows: [row] })) });

    it('accepts a session whose login and current role are both the expected login', async () => {
      await expect(db.assertDbIdentity(client({ session_login: 'jale_api', login: 'jale_api', rls_active: true }), 'jale_api'))
        .resolves.toBeUndefined();
    });

    it.each([
      ['the session signed in as another login', { session_login: 'jale_admin', login: 'jale_api', rls_active: true }],
      ['the current role is another login', { session_login: 'jale_api', login: 'jale_whatsapp', rls_active: true }],
      ['the session login is not reported', { login: 'jale_api', rls_active: true }],
    ])('refuses a session where %s', async (_label, row) => {
      await expect(db.assertDbIdentity(client(row), 'jale_api')).rejects.toMatchObject({ reason: 'login_mismatch' });
    });
  });

  it('getPublicJobsDbPool reads its own secret, never the request login one', async () => {
    process.env.REFERRALS_DB_SECRET_ARN = 'referrals-secret-name';
    mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });
    await db.getPublicJobsDbPool();
    expect(GetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'referrals-secret-name' });
    expect(GetSecretValueCommand).not.toHaveBeenCalledWith({ SecretId: 'arn:aws:secretsmanager:test' });
  });

  // ── Transaction hygiene ───────────────────────────────────────────
  //
  // A client handed back inside an open ('T') or failed ('E') transaction is
  // destroyed instead of pooled, so the next request can never run inside a
  // previous request's transaction or see its transaction-local settings.

  describe('release guard on pooled clients', () => {
    beforeEach(() => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });
    });

    async function checkout() {
      const pool = await db.getDbPool();
      const fake = createdPools[createdPools.length - 1];
      const client = await pool.connect();
      const pooledRelease: jest.Mock = fake.lastRelease;
      return { client, fake, pooledRelease };
    }

    it.each([
      ['I', false],
      ['T', true],
      ['E', true],
      [null, true],
    ])('a client released with transaction status %p is destroyed: %p', async (status, destroyed) => {
      const { client, fake, pooledRelease } = await checkout();
      fake.client.getTransactionStatus.mockReturnValue(status);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      client.release();
      warnSpy.mockRestore();
      expect(pooledRelease).toHaveBeenCalledTimes(1);
      expect(Boolean(pooledRelease.mock.calls[0][0])).toBe(destroyed);
    });

    it('passes an explicit error through unchanged', async () => {
      const { client, pooledRelease } = await checkout();
      const err = new Error('broken connection');
      client.release(err);
      expect(pooledRelease).toHaveBeenCalledWith(err);
    });

    it('guards the callback form of connect too (pool.query uses it)', async () => {
      const pool = await db.getDbPool();
      const fake = createdPools[createdPools.length - 1];
      const pooledRelease = jest.fn();
      fake.rawConnect.mockImplementationOnce((cb: any) => {
        fake.client.release = pooledRelease;
        cb(undefined, fake.client, pooledRelease);
      });
      await new Promise<void>((resolve) => {
        pool.connect((_err: unknown, client: any, done: (e?: unknown) => void) => {
          fake.client.getTransactionStatus.mockReturnValue('T');
          const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
          done();
          warnSpy.mockRestore();
          expect(client).toBe(fake.client);
          resolve();
        });
      });
      expect(pooledRelease).toHaveBeenCalledTimes(1);
      expect(pooledRelease.mock.calls[0][0]).toBeTruthy();
    });
  });
});
