import * as fs from 'fs';
import * as path from 'path';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import { emitEmfMetrics, type EmfMetric } from '../lib/emf';
import { manifestDigest, parseManifest, type AccessManifest } from '../../db/access/access-manifest';
import {
  checkPosture,
  POSTURE_EXTENSIONS,
  type PostureExtension,
  type PostureQueryable,
  type PostureResult,
  type PostureViolation,
} from '../../db/access/posture';
import {
  auditPosture,
  changeLogDigest,
  createAuditPosture,
  loadChangeLog,
  parseChangeLog,
  type ChangeLog,
} from '../../db/access/posture-audit';

/**
 * The database posture check, run daily by EventBridge and on both sides of
 * every production deploy by the deploy gate (`scripts/db-posture-gate.mjs`).
 *
 * It connects as its own catalog-only login and evaluates the catalog against
 * the access manifest through `db/access/posture.ts`, then publishes one
 * datapoint per run and returns a report that names objects, never data.
 *
 * THE EXPECTATION is the merged manifest (manifest.json plus every manifest.d
 * fragment) and the audit change log. Two sources:
 *   - bundled, for every run but one: both files as they were at this
 *     function's last deploy, serialised into the bundle next to this handler
 *     (see `lib/constructs/db-posture-check.ts`). The manifest is validated
 *     here with `parseManifest`; the audit extension reads the change log
 *     itself. A bundle without the manifest, or with one that fails
 *     validation, is a not-clean run: the check never passes against a
 *     manifest it could not read;
 *   - supplied, for the deploy gate's run before a deploy: the event
 *     `{ trigger: 'deploy', phase: 'pre', expected: { manifest, change_log } }`
 *     carries the incoming release's expectation
 *     (`scripts/write-posture-expectation.ts`). It must be at most 2 MB, pass
 *     `parseManifest` and `parseChangeLog`, and not name the check's own
 *     login as the master; otherwise the run is not clean, at stage
 *     `expected`. The same check then runs against it, with the audit
 *     extension reading the supplied change log.
 * The report says which source it used (`expected_source`) and carries the
 * digest of each file it used (`manifest_sha256`, `change_log_sha256`), so
 * the gate can tell that the check ran against what it sent.
 *
 * FAILING CLOSED. Nothing throws past the handler. Every failure (the
 * expectation, the manifest, the secret, the connection, the identity check,
 * the catalog reads) becomes `complete: false` and a DbPostureRunNotClean
 * datapoint, so the deploy gate and the alarms always see the run. A failure
 * is logged as its stage and error code only: driver and SDK messages can
 * carry hosts, user names and, for a failed sign-in, worse. No log line
 * carries the supplied expectation.
 *
 * METRICS (namespace Jale/Database), EMF so the role needs no CloudWatch
 * write permission:
 *   - DbPostureRunClean: 1 when the check completed with zero violations;
 *   - DbPostureRunNotClean: 1 on any violation, an incomplete check or any
 *     failure;
 *   - DbPostureViolations: the count.
 * A bundled run publishes each twice: with dimension Trigger (daily | deploy),
 * and as a dimensionless rollup, which is what the deploy gate's history and
 * the alarms read. A supplied run publishes each once, with Trigger=deploy-pre
 * only: its result is for the gate's own decision, so it never reaches the
 * rollup or the Trigger=deploy series the gate's history counts.
 * An identity failure also publishes DbIdentityCheckFailed, in the same two
 * shapes the workloads' boot check uses: dimensionless and by Login.
 */

export const METRIC_NAMESPACE = 'Jale/Database';

/** The merged manifest's file name inside the bundle. */
export const BUNDLED_MANIFEST_FILE = 'access-manifest.json';

/** The largest supplied expectation the check accepts, as serialised JSON. */
export const MAX_EXPECTED_BYTES = 2 * 1024 * 1024;

/**
 * The Trigger dimension. `deploy-pre` is only ever the dimension of a run with
 * a supplied expectation; no event's `trigger` maps to it.
 */
export type PostureTrigger = 'daily' | 'deploy' | 'deploy-pre';

/** Where the run's manifest and change log came from. */
export type ExpectedSource = 'bundled' | 'supplied';

/** What the handler returns, to the deploy gate or to EventBridge. */
export interface PostureReport {
  complete: boolean;
  violations: PostureViolation[];
  serverVersion: string | null;
  /** manifestDigest() of the manifest the check ran against; null when none could be read. */
  manifest_sha256: string | null;
  /** changeLogDigest() of the change log the check ran against; null when none could be read. */
  change_log_sha256: string | null;
  expected_source: ExpectedSource;
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
  /** The bundled merged access manifest. Throws when it is missing or invalid. */
  readManifest(): AccessManifest;
  /**
   * The bundled change log, for its digest. Throws when it is missing or
   * invalid. When absent, the file the registered audit extension reads.
   */
  readChangeLog?(): ChangeLog;
  readSecret(): Promise<PostureLoginSecret>;
  connect(secret: PostureLoginSecret): Promise<PostureConnection>;
  /** `extensions` is passed only for a supplied expectation; otherwise the registered ones run. */
  checkPosture(
    client: PostureQueryable,
    manifest: AccessManifest,
    extensions?: ReadonlyArray<PostureExtension<unknown>>,
  ): Promise<PostureResult>;
}

type Stage = 'expected' | 'manifest' | 'identity' | 'secret' | 'connect' | 'check';

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
  readChangeLog: () => loadChangeLog(),
  readSecret: readPostureSecret,
  connect: connectAsPostureLogin,
  checkPosture,
};

// ── The expectation ─────────────────────────────────────────────────────────

/** What one run checks against. */
interface Expectation {
  manifest: AccessManifest;
  manifestSha256: string;
  changeLogSha256: string | null;
  /** Set for a supplied expectation only; otherwise the registered extensions run as they are. */
  extensions?: ReadonlyArray<PostureExtension<unknown>>;
}

/** The digests a failed run still reports: those of whatever it had read. */
interface Digests {
  manifest: string | null;
  changeLog: string | null;
}

/** An error that identifies itself by name and code, the only parts of an error the log keeps. */
function expectationError(code: string): Error {
  return Object.assign(new Error(code), { name: 'ExpectationError', code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The registered extensions, with the audit one reading `changeLog` instead of the bundled file. */
function extensionsWithChangeLog(changeLog: ChangeLog): ReadonlyArray<PostureExtension<unknown>> {
  let replaced = 0;
  const extensions = POSTURE_EXTENSIONS.map((ext) => {
    if (ext.name !== auditPosture.name) return ext;
    replaced += 1;
    return createAuditPosture(() => changeLog);
  });
  // A supplied change log the check would not read must never be reported as used.
  if (replaced !== 1) throw expectationError('ExpectedChangeLogUnused');
  return extensions;
}

function bundledExpectation(deps: PostureCheckDependencies): Expectation {
  let manifest: AccessManifest;
  let manifestSha256: string;
  try {
    manifest = deps.readManifest();
    manifestSha256 = manifestDigest(manifest);
  } catch (error) {
    throw new StageFailure('manifest', error);
  }
  // The digest only: the audit extension reads the bundled change log itself,
  // as it always has, so a change log that cannot be read still makes the
  // check incomplete there.
  let changeLogSha256: string | null = null;
  try {
    changeLogSha256 = changeLogDigest(deps.readChangeLog ? deps.readChangeLog() : loadChangeLog());
  } catch {
    changeLogSha256 = null;
  }
  return { manifest, manifestSha256, changeLogSha256 };
}

/**
 * The supplied expectation, validated: at most MAX_EXPECTED_BYTES as JSON,
 * exactly `manifest` and `change_log`, each passing its parser, and a master
 * other than the login the check runs as. That last comparison is the
 * identity check's own, made here so a supplied manifest can never publish
 * the identity metric.
 */
function suppliedExpectation(raw: unknown, expectedLogin: string): Expectation {
  const fail = (code: string): never => {
    throw new StageFailure('expected', expectationError(code));
  };
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
  } catch {
    fail('ExpectedNotJson');
  }
  if (size > MAX_EXPECTED_BYTES) fail('ExpectedTooLarge');
  if (!isRecord(raw)) return fail('ExpectedNotAnObject');
  if (Object.keys(raw).some((key) => key !== 'manifest' && key !== 'change_log')) fail('ExpectedUnknownField');

  let manifest: AccessManifest;
  try {
    manifest = parseManifest(raw.manifest);
  } catch {
    return fail('ExpectedManifestInvalid');
  }
  let changeLog: ChangeLog;
  try {
    changeLog = parseChangeLog(raw.change_log);
  } catch {
    return fail('ExpectedChangeLogInvalid');
  }
  if (expectedLogin !== '' && manifest.master === expectedLogin) fail('ExpectedMasterIsCheckLogin');

  let extensions: ReadonlyArray<PostureExtension<unknown>>;
  try {
    extensions = extensionsWithChangeLog(changeLog);
  } catch (error) {
    throw new StageFailure('expected', error);
  }
  return {
    manifest,
    manifestSha256: manifestDigest(manifest),
    changeLogSha256: changeLogDigest(changeLog),
    extensions,
  };
}

// ── The handler ─────────────────────────────────────────────────────────────

function triggerOf(event: unknown): Exclude<PostureTrigger, 'deploy-pre'> {
  return typeof event === 'object' && event !== null && (event as { trigger?: unknown }).trigger === 'deploy'
    ? 'deploy'
    : 'daily';
}

/**
 * The deploy gate's run before a deploy, carrying the incoming expectation.
 * Any `expected` field on that exact event makes it a supplied run, valid or
 * not, so an expectation never reaches the bundled series.
 */
function suppliedOf(event: unknown): { expected: unknown } | null {
  if (!isRecord(event) || event.trigger !== 'deploy' || event.phase !== 'pre') return null;
  if (!Object.prototype.hasOwnProperty.call(event, 'expected')) return null;
  return { expected: event.expected };
}

function publishRun(trigger: PostureTrigger, report: PostureReport): void {
  const clean = report.complete && report.violations.length === 0;
  const metrics: EmfMetric[] = [
    { name: 'DbPostureRunClean', value: clean ? 1 : 0 },
    { name: 'DbPostureRunNotClean', value: clean ? 0 : 1 },
    { name: 'DbPostureViolations', value: report.violations.length },
  ];
  emitEmfMetrics(METRIC_NAMESPACE, metrics, { Trigger: trigger });
  // A supplied run is for the deploy gate's own decision: it stays out of the
  // rollup that the gate's history and the alarms read.
  if (trigger !== 'deploy-pre') emitEmfMetrics(METRIC_NAMESPACE, metrics);
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

function normalise(result: PostureResult, expectation: Expectation, source: ExpectedSource): PostureReport | null {
  if (typeof result !== 'object' || result === null || !Array.isArray(result.violations)) return null;
  return {
    complete: result.complete === true,
    violations: result.violations.map(({ check, object, detail }) => ({ check, object, detail })),
    serverVersion: typeof result.serverVersion === 'string' ? result.serverVersion : null,
    manifest_sha256: expectation.manifestSha256,
    change_log_sha256: expectation.changeLogSha256,
    expected_source: source,
  };
}

async function runCheck(
  deps: PostureCheckDependencies,
  supplied: { expected: unknown } | null,
  digests: Digests,
): Promise<PostureReport> {
  const expectedLogin = process.env.DB_EXPECTED_LOGIN ?? '';
  const expectation = supplied ? suppliedExpectation(supplied.expected, expectedLogin) : bundledExpectation(deps);
  digests.manifest = expectation.manifestSha256;
  digests.changeLog = expectation.changeLogSha256;
  const { manifest } = expectation;

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
      // The same check either way; a supplied expectation only changes what
      // the audit extension reads.
      result = expectation.extensions
        ? await deps.checkPosture(connection, manifest, expectation.extensions)
        : await deps.checkPosture(connection, manifest);
    } catch (error) {
      throw new StageFailure('check', error);
    }
    const report = normalise(result, expectation, supplied ? 'supplied' : 'bundled');
    if (!report) throw new StageFailure('check');
    return report;
  } finally {
    await connection.end().catch(() => undefined);
  }
}

export function createPostureCheckHandler(deps: PostureCheckDependencies) {
  return async function handler(event?: unknown): Promise<PostureReport> {
    const supplied = suppliedOf(event);
    const trigger: PostureTrigger = supplied ? 'deploy-pre' : triggerOf(event);
    const source: ExpectedSource = supplied ? 'supplied' : 'bundled';
    const digests: Digests = { manifest: null, changeLog: null };
    let report: PostureReport;
    try {
      report = await runCheck(deps, supplied, digests);
    } catch (error) {
      const failure = error instanceof StageFailure ? error : new StageFailure('check', error);
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        event: 'DbPostureCheckFailed',
        trigger,
        expected_source: source,
        stage: failure.stage,
        ...errorShape(failure.underlying),
      }));
      report = {
        complete: false,
        violations: [],
        serverVersion: null,
        manifest_sha256: digests.manifest,
        change_log_sha256: digests.changeLog,
        expected_source: source,
      };
    }

    publishRun(trigger, report);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      event: 'DbPostureCheck',
      trigger,
      expected_source: report.expected_source,
      complete: report.complete,
      violationCount: report.violations.length,
      serverVersion: report.serverVersion,
      manifest_sha256: report.manifest_sha256,
      change_log_sha256: report.change_log_sha256,
      violations: report.violations,
    }));
    return report;
  };
}

export const handler = createPostureCheckHandler(defaultDependencies);
