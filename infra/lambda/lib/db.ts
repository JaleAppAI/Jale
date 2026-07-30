import * as fs from 'fs';
import * as path from 'path';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Client, Pool, PoolClient } from 'pg';

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

/**
 * Sets the RLS session variable for the current transaction.
 * Must be called inside a BEGIN/COMMIT block.
 *
 * Uses set_config() instead of SET LOCAL because PostgreSQL's SET command
 * does not support parameterized queries ($1 placeholders). set_config()
 * with is_local=true is functionally identical to SET LOCAL but accepts
 * parameterized values, preventing SQL injection.
 */
export async function setRlsContext(
  client: Client | PoolClient,
  cognitoSub: string,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_user_id', $1, true)`,
    [cognitoSub],
  );
}

/**
 * Sets the RLS session variable for tables that key policies on users.id.
 * Keep this separate from setRlsContext(), which uses Cognito sub values.
 */
export async function setInternalUserRlsContext(
  client: Client | PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_internal_user_id', $1, true)`,
    [userId],
  );
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

// ── Public jobs role connection (separate secret, separate pool) ──
// The unauthenticated public read path connects as the restricted role
// jale_public_jobs, using its own Secrets Manager secret (REFERRALS_DB_SECRET_ARN).
// This is intentionally NOT layered onto getDbPool()/getDbSecret() above: those
// are cached under the jale_admin secret, and mixing roles onto one cached pool
// would risk a warm container serving one role's connection under the other's
// assumed privileges.
let cachedPublicJobsSecret: DbSecret | undefined;
let cachedPublicJobsSecretAt = 0;

async function getPublicJobsDbSecret(): Promise<DbSecret> {
  if (cachedPublicJobsSecret && Date.now() - cachedPublicJobsSecretAt < CACHE_TTL_MS) {
    return cachedPublicJobsSecret;
  }

  const result = await smClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.REFERRALS_DB_SECRET_ARN,
    }),
  );

  cachedPublicJobsSecret = JSON.parse(result.SecretString!) as DbSecret;
  cachedPublicJobsSecretAt = Date.now();
  return cachedPublicJobsSecret;
}

let publicJobsPool: Pool | undefined;

/**
 * Pool for the unauthenticated jale_public_jobs role. Callers must never call
 * setRlsContext against this pool's connections — there is no Cognito sub on
 * this route, and access control here is column-scoped GRANTs plus the
 * jobs_public_read RLS policy, not a session variable.
 */
export async function getPublicJobsDbPool(): Promise<Pool> {
  if (publicJobsPool) return publicJobsPool;

  const secret = await getPublicJobsDbSecret();
  publicJobsPool = new Pool({
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

  publicJobsPool.on('error', (err) => {
    console.error('Unexpected error on idle pg client (public jobs pool):', err instanceof Error ? err.message : String(err));
    publicJobsPool = undefined;
  });

  return publicJobsPool;
}
