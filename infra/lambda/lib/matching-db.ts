import * as fs from 'fs';
import * as path from 'path';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { getDbSecret } from './db';

interface MatchingSecret {
  username: string;
  password: string;
}

let matchingPool: Pool | undefined;
let cachedMatchingSecret: MatchingSecret | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
const smClient = new SecretsManagerClient({});

async function getMatchingSecret(): Promise<MatchingSecret> {
  if (cachedMatchingSecret && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedMatchingSecret;
  }

  const result = await smClient.send(new GetSecretValueCommand({
    SecretId: process.env.MATCHING_DB_SECRET_ARN,
  }));

  cachedMatchingSecret = JSON.parse(result.SecretString!) as MatchingSecret;
  cachedAt = Date.now();
  return cachedMatchingSecret;
}

export async function getMatchingDbPool(): Promise<Pool> {
  if (matchingPool) return matchingPool;

  const dbSecret = await getDbSecret();
  const matchingSecret = await getMatchingSecret();

  matchingPool = new Pool({
    host: dbSecret.host,
    port: dbSecret.port,
    database: dbSecret.dbname,
    user: matchingSecret.username,
    password: matchingSecret.password,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 2000,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(path.join(__dirname, 'rds-ca-bundle.pem'), 'utf-8'),
    },
  });

  matchingPool.on('error', () => {
    matchingPool = undefined;
  });

  return matchingPool;
}
