import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { getDbSecret } from '../../../../lambda/lib/db';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: (...args: any[]) => mockSend(...args),
  })),
  GetSecretValueCommand: jest.fn(),
}));

jest.mock('pg', () => {
  const mPool = { on: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

jest.mock('../../../../lambda/lib/db', () => ({
  getDbSecret: jest.fn(),
}));

describe('matching DB utility', () => {
  const originalEnv = process.env;
  let getMatchingDbPool: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
    process.env = {
      ...originalEnv,
      DB_SECRET_ARN: 'admin-secret-arn',
      MATCHING_DB_SECRET_ARN: 'matching-secret-arn',
    };
    (getDbSecret as jest.Mock).mockResolvedValue({
      host: 'db.example.com',
      port: 5432,
      dbname: 'jale',
      username: 'jale_admin',
      password: 'admin-pass',
    });
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({
        username: 'jale_matching',
        password: 'matching-pass',
      }),
    });

    getMatchingDbPool = require('../../../../lambda/lib/matching-db').getMatchingDbPool;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('builds a pool from admin endpoint metadata and matching role credentials', async () => {
    await getMatchingDbPool();

    expect(GetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'matching-secret-arn' });
    expect(getDbSecret).toHaveBeenCalled();
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.example.com',
      port: 5432,
      database: 'jale',
      user: 'jale_matching',
      password: 'matching-pass',
      max: 1,
    }));
  });
});
