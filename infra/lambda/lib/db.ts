import * as fs from 'fs';
import * as path from 'path';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

export interface DbSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

// ── Secret caching with TTL ──
// Secrets Manager credentials rotate on a schedule. A TTL ensures warm Lambda
// containers pick up new credentials within 5 minutes of rotation, rather than
// holding a stale password until cold-started.
let cachedSecret: DbSecret | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const smClient = new SecretsManagerClient({});

export async function getDbSecret(): Promise<DbSecret> {
  if (cachedSecret && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedSecret;
  }

  const result = await smClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.DB_SECRET_ARN,
    }),
  );

  cachedSecret = JSON.parse(result.SecretString!) as DbSecret;
  cachedAt = Date.now();
  return cachedSecret;
}

/** Clear the cached secret — call this on authentication failures to force a refresh. */
export function clearSecretCache(): void {
  cachedSecret = undefined;
  cachedAt = 0;
}

// ── Connection pool ──
// pg.Pool with max:1 reuses one TCP connection across warm Lambda invocations,
// avoiding the 50-100ms TLS handshake penalty per invocation. The pool handles
// stale connection eviction automatically. Each Lambda container gets its own pool
// instance, so max:1 means one connection per container — not one total.
let pool: Pool | undefined;

export async function getDbPool(): Promise<Pool> {
  if (pool) return pool;

  const secret = await getDbSecret();
  pool = new Pool({
    host: secret.host,
    port: secret.port,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 2000,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(path.join(__dirname, 'rds-ca-bundle.pem'), 'utf-8'),
    },
  });

  // Prevent unhandled promise rejections on idle client errors
  pool.on('error', (err) => {
    console.error('Unexpected error on idle pg client:', err instanceof Error ? err.message : String(err));
    // Force pool recreation on next call
    pool = undefined;
  });

  return pool;
}
