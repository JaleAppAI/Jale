import * as fs from 'fs';
import * as path from 'path';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Client, Pool, PoolClient, type PoolConfig } from 'pg';
import { emitEmfMetrics } from './emf';

export interface DbSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

// ── Secret caching with TTL ──
// The cache only saves a Secrets Manager round trip on warm containers.
// Credentials are rotated by recycling, not in place: the secret is updated
// and the functions are cold-started with a configuration change. A pool keeps
// the password it was built with and never re-reads it, so a rotation that
// skipped the recycle would leave warm containers on the old password.
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

// ── Boot identity check ──
//
// Each workload connects as its own dedicated login, named by its
// DB_EXPECTED_LOGIN. Before a pool serves anything, its first connection
// checks two things: the session is that login, and row_security_active()
// reads true for it on public.users. The probe uses the OID form of
// row_security_active, which keeps working even if schema USAGE is ever
// revoked (the name form errors then). A login with BYPASSRLS, or a
// superuser, reads false. The master login is never a valid expected login
// for a workload.
//
// Any failure fails closed: the pool is ended and not cached (the next call
// builds and checks a fresh one), the error propagates to the handler, and
// DbIdentityCheckFailed is emitted in Jale/Database with the expected login
// as `Login` (`unset` when the variable is missing) plus a dimensionless
// rollup for the alarm.

const IDENTITY_METRIC_NAMESPACE = 'Jale/Database';
const IDENTITY_METRIC_NAME = 'DbIdentityCheckFailed';
const MASTER_LOGIN = 'jale_admin';

export const DB_IDENTITY_CHECK_SQL = `SELECT session_user::text AS session_login,
       current_user::text AS login,
       (SELECT pg_catalog.row_security_active(c.oid)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'users') AS rls_active`;

export type DbIdentityFailure =
  | 'expected_login_unset'
  | 'master_login_refused'
  | 'login_mismatch'
  | 'row_security_inactive'
  | 'check_failed';

export class DbIdentityCheckError extends Error {
  constructor(
    readonly reason: DbIdentityFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DbIdentityCheckError';
  }
}

function reportIdentityFailure(
  pool: string,
  expectedLogin: string | undefined,
  reason: DbIdentityFailure,
): void {
  const login = expectedLogin ? expectedLogin : 'unset';
  emitEmfMetrics(
    IDENTITY_METRIC_NAMESPACE,
    [{ name: IDENTITY_METRIC_NAME, value: 1 }],
    { Login: login },
    { rollup: true },
  );
  console.error(JSON.stringify({ event: 'db_identity_check_failed', pool, expectedLogin: login, reason }));
}

/**
 * The login a pool must sign in as. Reports and throws when DB_EXPECTED_LOGIN
 * is unset or names the master login. The getters call it before reading any
 * secret, so a misconfigured function fails before it touches Secrets Manager.
 */
export function requireExpectedLogin(expectedLogin: string | undefined, label = 'pool'): string {
  let failure: DbIdentityCheckError | undefined;
  if (!expectedLogin) {
    failure = new DbIdentityCheckError(
      'expected_login_unset',
      'database identity check: DB_EXPECTED_LOGIN is not set',
    );
  } else if (expectedLogin === MASTER_LOGIN) {
    failure = new DbIdentityCheckError(
      'master_login_refused',
      `database identity check: ${MASTER_LOGIN} is never a valid workload login`,
    );
  }
  if (failure) {
    reportIdentityFailure(label, expectedLogin, failure.reason);
    throw failure;
  }
  return expectedLogin as string;
}

/**
 * The secret a pool signs in with must be the expected login's own. Reports
 * and throws login_mismatch otherwise, before any connection is made.
 */
export function requireSecretLogin(username: unknown, expectedLogin: string, label = 'pool'): void {
  if (username === expectedLogin) return;
  const failure = new DbIdentityCheckError(
    'login_mismatch',
    `database identity check: the secret is for a different login than ${expectedLogin}`,
  );
  reportIdentityFailure(label, expectedLogin, failure.reason);
  throw failure;
}

/** Runs the identity probe on one connection and throws on any mismatch. */
export async function assertDbIdentity(
  client: {
    query: (sql: string) => Promise<{ rows: Array<{ session_login?: unknown; login?: unknown; rls_active?: unknown }> }>;
  },
  expectedLogin: string,
): Promise<void> {
  const result = await client.query(DB_IDENTITY_CHECK_SQL);
  const row = result.rows[0];
  // session_user is the login that signed in; current_user is the role in
  // effect. Both must be the expected login.
  if (!row || row.session_login !== expectedLogin || row.login !== expectedLogin) {
    throw new DbIdentityCheckError(
      'login_mismatch',
      `database identity check: connected as a different login than ${expectedLogin}`,
    );
  }
  if (row.rls_active !== true) {
    throw new DbIdentityCheckError(
      'row_security_inactive',
      `database identity check: row security is not active for ${expectedLogin}`,
    );
  }
}

// ── Transaction hygiene ──
//
// Request code opens explicit transactions and sets the caller context with
// set_config(..., true), which lives until the transaction ends. A client
// handed back to the pool while its transaction is still open ('T') or
// aborted ('E') would carry that transaction, and its caller context, into
// the next request that checks the connection out. So a release in any state
// other than idle ('I') destroys the client instead of pooling it; the server
// rolls the transaction back when the connection closes. Session-level
// settings are ruled out statically (transaction-local-settings-guard.test.ts).

type ReleaseFn = (err?: Error | boolean) => void;

function guardClientRelease(client: PoolClient, label: string): ReleaseFn {
  const pooledRelease = client.release.bind(client) as ReleaseFn;
  const guarded: ReleaseFn = (err) => {
    if (err) {
      pooledRelease(err);
      return;
    }
    const status = client.getTransactionStatus();
    if (status === 'I') {
      pooledRelease();
      return;
    }
    console.warn(JSON.stringify({ event: 'db_client_discarded', pool: label, transactionStatus: status }));
    pooledRelease(true);
  };
  client.release = guarded;
  return guarded;
}

/**
 * Makes every client this pool hands out, through either form of connect()
 * (pool.query uses the callback form), destroy itself when it is released
 * inside an open or aborted transaction.
 */
export function guardPoolReleases(pool: Pool, label = 'pool'): Pool {
  const connect = pool.connect.bind(pool) as (...args: any[]) => any;
  const guardedConnect = (callback?: (err: Error | undefined, client?: PoolClient, done?: ReleaseFn) => void) => {
    if (typeof callback === 'function') {
      return connect((err: Error | undefined, client: PoolClient | undefined, done: ReleaseFn) => {
        if (err || !client) {
          callback(err, client, done);
          return;
        }
        callback(err, client, guardClientRelease(client, label));
      });
    }
    return (connect() as Promise<PoolClient>).then((client) => {
      guardClientRelease(client, label);
      return client;
    });
  };
  (pool as unknown as { connect: typeof guardedConnect }).connect = guardedConnect;
  return pool;
}

/**
 * Builds a pool for `expectedLogin`, guards its releases, and proves its
 * identity on the first connection. On any failure the pool is ended and the
 * error is thrown; nothing is cached here, so a caller that retries builds a
 * fresh pool. Used by every pool getter (and by the database suites, which
 * build their pools without TLS).
 */
export async function createCheckedPool(
  config: PoolConfig,
  expectedLoginValue: string | undefined,
  label = 'pool',
): Promise<Pool> {
  const expectedLogin = requireExpectedLogin(expectedLoginValue, label);
  const pool = guardPoolReleases(new Pool(config), label);
  // An idle-client error during the check must not crash the process; the
  // getter installs its own handler once the pool is accepted.
  pool.on('error', () => undefined);

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    // Not reachable is not a wrong identity: no metric, the caller's own
    // error path reports it, and the next call retries.
    await pool.end().catch(() => undefined);
    throw err;
  }

  try {
    await assertDbIdentity(client, expectedLogin);
  } catch (err) {
    client.release(err instanceof Error ? err : true);
    await pool.end().catch(() => undefined);
    reportIdentityFailure(
      label,
      expectedLogin,
      err instanceof DbIdentityCheckError ? err.reason : 'check_failed',
    );
    throw err;
  }
  client.release();
  return pool;
}

/** TLS settings for the RDS endpoint: verified against the bundled CA. */
export function rdsSslConfig(): PoolConfig['ssl'] {
  return {
    rejectUnauthorized: true,
    ca: fs.readFileSync(path.join(__dirname, 'rds-ca-bundle.pem'), 'utf-8'),
  };
}

// ── Connection pool ──
// pg.Pool with max:1 reuses one TCP connection across warm Lambda invocations,
// avoiding the 50-100ms TLS handshake penalty per invocation. The pool handles
// stale connection eviction automatically. Each Lambda container gets its own pool
// instance, so max:1 means one connection per container — not one total.
// The in-flight build is cached, so concurrent first calls share one pool and
// one identity check.
let pool: Pool | undefined;
let pendingPool: Promise<Pool> | undefined;

const MAX_SESSION_TIMEOUT_MS = 60_000;

/**
 * Optional per-Lambda session timeouts for the request pool, sent by pg as
 * startup parameters so they hold for every statement on the connection:
 *
 *   DB_STATEMENT_TIMEOUT_MS  -> statement_timeout
 *   DB_LOCK_TIMEOUT_MS       -> lock_timeout
 *
 * Unset means today's behaviour exactly (no setting is sent; the login's own
 * defaults apply). A Lambda behind API Gateway's 29 s cap sets them so a
 * statement, or a wait on a company lock, ends with an error well before
 * the Lambda or the gateway times out. A value that is not a whole number of
 * milliseconds from 1 to 60000 fails the pool build, before any secret is read,
 * rather than being silently ignored.
 */
function sessionTimeouts(env: NodeJS.ProcessEnv): Pick<PoolConfig, 'statement_timeout' | 'lock_timeout'> {
  const read = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 1 || value > MAX_SESSION_TIMEOUT_MS) {
      throw new Error(`DB_TIMEOUT_INVALID: ${name} must be a whole number of milliseconds from 1 to ${MAX_SESSION_TIMEOUT_MS}`);
    }
    return value;
  };
  const statementTimeout = read('DB_STATEMENT_TIMEOUT_MS');
  const lockTimeout = read('DB_LOCK_TIMEOUT_MS');
  return {
    ...(statementTimeout === undefined ? {} : { statement_timeout: statementTimeout }),
    ...(lockTimeout === undefined ? {} : { lock_timeout: lockTimeout }),
  };
}

export async function getDbPool(): Promise<Pool> {
  if (pool) return pool;
  pendingPool ??= (async () => {
    const timeouts = sessionTimeouts(process.env);
    const expectedLogin = requireExpectedLogin(process.env.DB_EXPECTED_LOGIN, 'app');
    const secret = await getDbSecret();
    requireSecretLogin(secret.username, expectedLogin, 'app');
    const built = await createCheckedPool({
      host: secret.host,
      port: secret.port,
      user: secret.username,
      password: secret.password,
      database: secret.dbname,
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 2000,
      ssl: rdsSslConfig(),
      ...timeouts,
    }, expectedLogin, 'app');

    // Prevent unhandled promise rejections on idle client errors
    built.on('error', (err) => {
      console.error('Unexpected error on idle pg client:', err instanceof Error ? err.message : String(err));
      // Force pool recreation on next call
      if (pool === built) pool = undefined;
    });
    pool = built;
    return built;
  })().finally(() => {
    pendingPool = undefined;
  });
  return pendingPool;
}

// ── Public jobs role connection (separate secret, separate pool) ──
// The unauthenticated public read path connects as the restricted role
// jale_public_jobs, using its own Secrets Manager secret (REFERRALS_DB_SECRET_ARN).
// This is intentionally NOT layered onto getDbPool()/getDbSecret() above: those
// are cached under the request login's secret, and mixing roles onto one cached
// pool would risk a warm container serving one role's connection under the
// other's assumed privileges.
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
let pendingPublicJobsPool: Promise<Pool> | undefined;

/**
 * Pool for the unauthenticated jale_public_jobs role. Callers must never call
 * setRlsContext against this pool's connections — there is no Cognito sub on
 * this route, and access control here is column-scoped GRANTs plus the
 * jobs_public_read RLS policy, not a session variable.
 */
export async function getPublicJobsDbPool(): Promise<Pool> {
  if (publicJobsPool) return publicJobsPool;
  pendingPublicJobsPool ??= (async () => {
    const expectedLogin = requireExpectedLogin(process.env.DB_EXPECTED_LOGIN, 'public_jobs');
    const secret = await getPublicJobsDbSecret();
    requireSecretLogin(secret.username, expectedLogin, 'public_jobs');
    const built = await createCheckedPool({
      host: secret.host,
      port: secret.port,
      user: secret.username,
      password: secret.password,
      database: secret.dbname,
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 2000,
      ssl: rdsSslConfig(),
    }, expectedLogin, 'public_jobs');

    built.on('error', (err) => {
      console.error('Unexpected error on idle pg client (public jobs pool):', err instanceof Error ? err.message : String(err));
      if (publicJobsPool === built) publicJobsPool = undefined;
    });
    publicJobsPool = built;
    return built;
  })().finally(() => {
    pendingPublicJobsPool = undefined;
  });
  return pendingPublicJobsPool;
}
