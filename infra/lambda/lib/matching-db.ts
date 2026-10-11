import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { createCheckedPool, rdsSslConfig, requireExpectedLogin, requireSecretLogin } from './db';

// The matching login's secret carries only a username and password. The
// endpoint comes from the function's environment (DB_HOST, DB_PORT, DB_NAME,
// set from the instance by the stack), so this pool never reads another
// login's secret.

interface MatchingSecret {
  username: string;
  password: string;
}

let matchingPool: Pool | undefined;
let pendingMatchingPool: Promise<Pool> | undefined;
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

function requiredEnv(name: 'DB_HOST' | 'DB_PORT' | 'DB_NAME'): string {
  const value = process.env[name];
  if (!value) throw new Error(`matching database endpoint: ${name} is not set`);
  return value;
}

function matchingEndpoint(): { host: string; port: number; database: string } {
  const host = requiredEnv('DB_HOST');
  const rawPort = requiredEnv('DB_PORT');
  const database = requiredEnv('DB_NAME');
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('matching database endpoint: DB_PORT is not a valid port');
  }
  return { host, port, database };
}

export async function getMatchingDbPool(): Promise<Pool> {
  if (matchingPool) return matchingPool;
  pendingMatchingPool ??= (async () => {
    const expectedLogin = requireExpectedLogin(process.env.DB_EXPECTED_LOGIN, 'matching');
    const endpoint = matchingEndpoint();
    const matchingSecret = await getMatchingSecret();
    requireSecretLogin(matchingSecret.username, expectedLogin, 'matching');

    const built = await createCheckedPool({
      host: endpoint.host,
      port: endpoint.port,
      database: endpoint.database,
      user: matchingSecret.username,
      password: matchingSecret.password,
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 2000,
      ssl: rdsSslConfig(),
    }, expectedLogin, 'matching');

    built.on('error', () => {
      if (matchingPool === built) matchingPool = undefined;
    });
    matchingPool = built;
    return built;
  })().finally(() => {
    pendingMatchingPool = undefined;
  });
  return pendingMatchingPool;
}
