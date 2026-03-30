import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

type DbSecret = any; // type import for brevity, it's just tested as object anyways

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: (...args: any[]) => mockSend(...args)
  })),
  GetSecretValueCommand: jest.fn()
}));

jest.mock('pg', () => {
  const mPool = {
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

describe('DB Utility', () => {
  const originalEnv = process.env;

  let getDbSecret: any;
  let getDbPool: any;
  let clearSecretCache: any;

  const mockSecret = {
    host: 'db.example.com',
    port: 5432,
    dbname: 'testdb',
    username: 'testuser',
    password: 'password123',
  };

  beforeEach(() => {
    mockSend.mockReset();
    jest.clearAllMocks();
    process.env = { ...originalEnv, DB_SECRET_ARN: 'arn:aws:secretsmanager:test' };
    
    // isolate modules so the database smClient is reinstantiated per-test suite if needed
    jest.isolateModules(() => {
      const db = require('../../../../lambda/lib/db');
      getDbSecret = db.getDbSecret;
      getDbPool = db.getDbPool;
      clearSecretCache = db.clearSecretCache;
      clearSecretCache();
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getDbSecret', () => {
    it('should fetch and parse secret from SecretsManager', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const secret = await getDbSecret();
      expect(secret).toEqual(mockSecret);
      expect(GetSecretValueCommand).toHaveBeenCalledWith({
        SecretId: 'arn:aws:secretsmanager:test',
      });
    });

    it('should use cached secret on subsequent calls', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      // First call
      await getDbSecret();
      // Second call
      const secret2 = await getDbSecret();
      
      expect(secret2).toEqual(mockSecret);
      expect(mockSend).toHaveBeenCalledTimes(1); // Cached
    });

    it('should refetch after cache is cleared', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      await getDbSecret();
      clearSecretCache();
      await getDbSecret();

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should refetch secret after TTL expires', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const dateSpy = jest.spyOn(Date, 'now');
      const baseTime = 1_000_000;
      dateSpy.mockReturnValue(baseTime);

      await getDbSecret(); // First fetch — cachedAt set to baseTime

      // Advance time past the 5-minute TTL (300 000 ms)
      dateSpy.mockReturnValue(baseTime + 5 * 60 * 1000 + 1);

      await getDbSecret(); // TTL expired — must refetch from Secrets Manager

      expect(mockSend).toHaveBeenCalledTimes(2);
      dateSpy.mockRestore();
    });
  });

  describe('getDbPool', () => {
    it('should initialize and return pg Pool using secrets', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const pool = await getDbPool();
      expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
        host: 'db.example.com',
        user: 'testuser',
        password: 'password123',
        database: 'testdb',
      }));
      expect(pool).toBeDefined();
    });

    it('should return the exact same pool instance on subsequent calls', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(mockSecret) });

      const pool1 = await getDbPool();
      const pool2 = await getDbPool();

      expect(pool1).toBe(pool2);
      expect(Pool).toHaveBeenCalledTimes(1);
    });
  });

  it('passes RDS CA bundle to pg Pool ssl config', async () => {
    jest.resetModules();

    const mockPoolConstructor = jest.fn().mockImplementation(() => ({
      on: jest.fn(),
    }));
    jest.mock('pg', () => ({ Pool: mockPoolConstructor }));

    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn().mockReturnValue('MOCK_CA_CERT'),
    }));

    jest.mock('@aws-sdk/client-secrets-manager', () => ({
      SecretsManagerClient: jest.fn().mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({
          SecretString: JSON.stringify({
            host: 'localhost',
            port: 5432,
            dbname: 'test',
            username: 'user',
            password: 'pass',
          }),
        }),
      })),
      GetSecretValueCommand: jest.fn(),
    }));

    const { getDbPool } = await import('../../../../lambda/lib/db');
    process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123456789:secret:test';
    await getDbPool();

    expect(mockPoolConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: expect.objectContaining({
          rejectUnauthorized: true,
          ca: 'MOCK_CA_CERT',
        }),
      }),
    );
  });
});
