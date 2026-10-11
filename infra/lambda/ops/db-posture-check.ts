import * as fs from 'fs';
import * as path from 'path';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import { emitEmfMetrics, type EmfMetric } from '../lib/emf';
import { manifestDigest, parseManifest, type AccessManifest } from '../../db/access/access-manifest';
import {
  checkPosture,
  type PostureQueryable,
  type PostureResult,
  type PostureViolation,
} from '../../db/access/posture';

/**
 * The database posture check, run daily by EventBridge and on both sides of
 * every production deploy by the deploy gate (`scripts/db-posture-gate.mjs`).
 *
 * It connects as its own catalog-only login and evaluates the catalog against
 * the access manifest through `db/access/posture.ts`, then publishes one
 * datapoint per run and returns a report that names objects, never data.
 *
 * THE MANIFEST is the merged one (manifest.json plus every manifest.d
 * fragment), serialised at synth time into the bundle next to this handler
 * (see `lib/constructs/db-posture-check.ts`) and validated here with
 * `parseManifest`. A bundle without it, or with one that fails validation,
 * is a not-clean run: the check never passes against a manifest it could not
 * read.
 *
 * FAILING CLOSED. Nothing throws past the handler. Every failure (the
 * manifest, the secret, the connection, the identity check, the catalog
 * reads) becomes `complete: false` and a DbPostureRunNotClean datapoint, so
 * the deploy gate and the alarms always see the run. A failure is logged as
 * its stage and error code only: driver and SDK messages can carry hosts,
 * user names and, for a failed sign-in, worse.
 *
 * METRICS (namespace Jale/Database), EMF so the role needs no CloudWatch
 * write permission:
 *   - DbPostureRunClean: 1 when the check completed with zero violations;
 *   - DbPostureRunNotClean: 1 on any violation, an incomplete check or any
 *     failure;
 *   - DbPostureViolations: the count.
 * Each is published twice: with dimension Trigger (daily | deploy), and as a
 * dimensionless rollup, which is what the deploy gate and the alarms read.
 * An identity failure also publishes DbIdentityCheckFailed, in the same two
 * shapes the workloads' boot check uses: dimensionless and by Login.
 */

export const METRIC_NAMESPACE = 'Jale/Database';

/** The merged manifest's file name inside the bundle. */
export const BUNDLED_MANIFEST_FILE = 'access-manifest.json';

export type PostureTrigger = 'daily' | 'deploy';

/** What the handler returns, to the deploy gate or to EventBridge. */
export interface PostureReport {
  complete: boolean;
  violations: PostureViolation[];
  serverVersion: string | null;
  /** manifestDigest() of the manifest the check ran against; null when none could be read. */
  manifest_sha256: string | null;
}

/** The posture login's credentials, as credential preparation stores them. */
export interface PostureLoginSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

/** An open connection as the posture login. */
export interface PostureConnection extends PostureQueryable {
  end(): Promise<void>;
}

export interface PostureCheckDependencies {
  /** The merged access manifest. Throws when it is missing or invalid. */
  readManifest(): AccessManifest;
  readSecret(): Promise<PostureLoginSecret>;
  connect(secret: PostureLoginSecret): Promise<PostureConnection>;
  checkPosture(client: PostureQueryable, manifest: AccessManifest): Promise<PostureResult>;
}

type Stage = 'manifest' | 'identity' | 'secret' | 'connect' | 'check';

class StageFailure extends Error {
  constructor(readonly stage: Stage, readonly underlying?: unknown) {
    super(`posture check failed at ${stage}`);
  }
}

// ── The bundle and the connection ───────────────────────────────────────────

/**
 * The merged manifest the bundle carries. `dir` is the handler's own
 * directory in the bundle; tests pass another.
 */
export function readBundledManifest(dir: string = __dirname): AccessManifest {
  const text = fs.readFileSync(path.join(dir, BUNDLED_MANIFEST_FILE), 'utf8');
  return parseManifest(JSON.parse(text));
}

const secretsManager = new SecretsManagerClient({});

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The posture login's secret, by the name in DB_SECRET_ARN. */
export async function readPostureSecret(): Promise<PostureLoginSecret> {
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
  const raw = JSON.parse(result.SecretString ?? '') as Record<string, unknown>;
  const port = Number(raw.port);
  if (
    !nonEmptyString(raw.host)
    || !Number.isInteger(port) || port <= 0
    || !nonEmptyString(raw.dbname)
    || !nonEmptyString(raw.username)
    || !nonEmptyString(raw.password)
  ) {
    throw new Error('the posture login secret is incomplete');
  }
  return { host: raw.host, port, dbname: raw.dbname, username: raw.username, password: raw.password };
}

/**
 * The RDS CA bundle. The bundling step copies it next to the handler; from
 * source (tests) it is read where it is checked in.
 */
function rdsCaBundle(): string {
  const candidates = [
    path.join(__dirname, 'rds-ca-bundle.pem'),
    path.join(__dirname, '..', 'lib', 'rds-ca-bundle.pem'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('the RDS CA bundle is missing');
  return fs.readFileSync(found, 'utf8');
}

/**
 * One short-lived client: connect, query, close. Deliberately not the
 * workloads' pool getter, which caches a pool for warm invocations; this
 * check runs once a day and once per deploy.
 */
export async function connectAsPostureLogin(secret: PostureLoginSecret): Promise<PostureConnection> {
  const client = new Client({
    host: secret.host,
    port: secret.port,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl: { rejectUnauthorized: true, ca: rdsCaBundle() },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: 'jale-db-posture-check',
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

const defaultDependencies: PostureCheckDependencies = {
  readManifest: () => readBundledManifest(),
  readSecret: readPostureSecret,
  connect: connectAsPostureLogin,
  checkPosture,
};

// ── The handler ─────────────────────────────────────────────────────────────

function triggerOf(event: unknown): PostureTrigger {
  return typeof event === 'object' && event !== null && (event as { trigger?: unknown }).trigger === 'deploy'
    ? 'deploy'
    : 'daily';
}

function publishRun(trigger: PostureTrigger, report: PostureReport): void {
  const clean = report.complete && report.violations.length === 0;
  const metrics: EmfMetric[] = [
    { name: 'DbPostureRunClean', value: clean ? 1 : 0 },
    { name: 'DbPostureRunNotClean', value: clean ? 0 : 1 },
    { name: 'DbPostureViolations', value: report.violations.length },
  ];
  emitEmfMetrics(METRIC_NAMESPACE, metrics, { Trigger: trigger });
  emitEmfMetrics(METRIC_NAMESPACE, metrics);
}

function publishIdentityFailure(expectedLogin: string): void {
  const metrics: EmfMetric[] = [{ name: 'DbIdentityCheckFailed', value: 1 }];
  emitEmfMetrics(METRIC_NAMESPACE, metrics);
  emitEmfMetrics(METRIC_NAMESPACE, metrics, { Login: expectedLogin });
}

/** An error's name and code, which identify it without its message. */
function errorShape(error: unknown): { errorName?: string; errorCode?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const { name, code } = error as { name?: unknown; code?: unknown };
  const safe = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
  return { errorName: safe(name), errorCode: safe(code) };
}

function normalise(result: PostureResult, digest: string): PostureReport | null {
  if (typeof result !== 'object' || result === null || !Array.isArray(result.violations)) return null;
  return {
    complete: result.complete === true,
    violations: result.violations.map(({ check, object, detail }) => ({ check, object, detail })),
    serverVersion: typeof result.serverVersion === 'string' ? result.serverVersion : null,
    manifest_sha256: digest,
  };
}

async function runCheck(deps: PostureCheckDependencies, digestOut: { value: string | null }): Promise<PostureReport> {
  let manifest: AccessManifest;
  try {
    manifest = deps.readManifest();
    digestOut.value = manifestDigest(manifest);
  } catch (error) {
    throw new StageFailure('manifest', error);
  }

  const expectedLogin = process.env.DB_EXPECTED_LOGIN ?? '';
  if (!expectedLogin || expectedLogin === manifest.master) {
    publishIdentityFailure(expectedLogin || 'unset');
    throw new StageFailure('identity');
  }

  let secret: PostureLoginSecret;
  try {
    secret = await deps.readSecret();
  } catch (error) {
    throw new StageFailure('secret', error);
  }
  // The secret must be the expected login's own, before anything connects.
  if (secret.username !== expectedLogin) {
    publishIdentityFailure(expectedLogin);
    throw new StageFailure('identity');
  }

  let connection: PostureConnection;
  try {
    connection = await deps.connect(secret);
  } catch (error) {
    throw new StageFailure('connect', error);
  }

  try {
    let row: { session_login?: unknown; login?: unknown } | undefined;
    try {
      const { rows } = await connection.query('SELECT session_user AS session_login, current_user AS login');
      row = rows[0] as { session_login?: unknown; login?: unknown } | undefined;
    } catch (error) {
      // A failed identity query is an identity failure too, like the
      // workloads' boot check reports it.
      publishIdentityFailure(expectedLogin);
      throw new StageFailure('identity', error);
    }
    // session_user is the login that signed in; current_user is the role in
    // effect. Both must be the expected login.
    if (row?.session_login !== expectedLogin || row?.login !== expectedLogin) {
      publishIdentityFailure(expectedLogin);
      throw new StageFailure('identity');
    }

    let result: PostureResult;
    try {
      result = await deps.checkPosture(connection, manifest);
    } catch (error) {
      throw new StageFailure('check', error);
    }
    const report = normalise(result, digestOut.value as string);
    if (!report) throw new StageFailure('check');
    return report;
  } finally {
    await connection.end().catch(() => undefined);
  }
}

export function createPostureCheckHandler(deps: PostureCheckDependencies) {
  return async function handler(event?: unknown): Promise<PostureReport> {
    const trigger = triggerOf(event);
    const digest: { value: string | null } = { value: null };
    let report: PostureReport;
    try {
      report = await runCheck(deps, digest);
    } catch (error) {
      const failure = error instanceof StageFailure ? error : new StageFailure('check', error);
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        event: 'DbPostureCheckFailed',
        trigger,
        stage: failure.stage,
        ...errorShape(failure.underlying),
      }));
      report = { complete: false, violations: [], serverVersion: null, manifest_sha256: digest.value };
    }

    publishRun(trigger, report);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      event: 'DbPostureCheck',
      trigger,
      complete: report.complete,
      violationCount: report.violations.length,
      serverVersion: report.serverVersion,
      manifest_sha256: report.manifest_sha256,
      violations: report.violations,
    }));
    return report;
  };
}

export const handler = createPostureCheckHandler(defaultDependencies);
