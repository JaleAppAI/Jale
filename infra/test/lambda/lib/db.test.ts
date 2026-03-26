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
      const db = require('../../../lambda/lib/db');
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
});
