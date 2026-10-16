import * as zlib from 'zlib';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient, ListUserPoolClientsCommand, ListUserPoolsCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DescribeRuleCommand, EventBridgeClient, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { emitEmfMetrics } from '../lib/emf';
import {
  classifyCognitoFailure,
  classifyEvent,
  cognitoClientIdOf,
  cognitoPoolIdOf,
  type AlertRecord,
  type ArchiveRecord,
  type Classification,
  type SentinelConfig,
} from './audit-sentinel-rules';
import {
  edgeDeadLetterQueue,
  edgeRoutes,
  mainRoutes,
  ruleState,
  samePattern,
  type AuditRoute,
  type EventPatternJson,
  type RoutedFindings,
  type RouteNames,
} from './audit-sentinel-routes';

/**
 * The audit sentinel. It has no database access. Two inputs:
 *
 *   (a) CloudWatch Logs subscriptions on the audit log groups (the fallback
 *       group, the ops-command output group and, after window deploy 2, the
 *       engine log group). Each batch becomes one gzip object of JSON lines
 *       under `logs/<source>/dt=<UTC day of its first event>/`, keyed by its
 *       first and last event ids, so a redelivered batch is a no-op.
 *   (b) EventBridge rules for risky actions, secret reads, findings and
 *       sign-in events. Each event is classified by `audit-sentinel-rules.ts`;
 *       an alert goes to the audit-alerts topic and its record to
 *       `findings/`, and a finding that does not alert is archived only.
 *       A failed user-pool sign-in alerts only when it is in the admin pool:
 *       the pool it names, or, when it names none, the app client it names.
 *       The pool is looked up by name, and its app clients with it (see
 *       createAdminPoolResolver).
 *
 * ONE ALERT PER EVENT. Several rules can deliver the same CloudTrail event,
 * and a retried invocation delivers it again. The archive key is derived from
 * the CloudTrail event id (for a Security Hub finding, from the finding's
 * state, so one alert per state however often it is imported), so the
 * sentinel checks the key before publishing and writes it after: a duplicate
 * finds the record and stops, and a publish that failed leaves no record, so
 * the retry publishes. The worst case is a duplicate alert, never a lost one.
 *
 * FAILURES THROW. A batch or event that cannot be archived or published fails
 * the invocation; Lambda retries it and then hands it to the dead-letter
 * queue, which alarms. Nothing is dropped silently.
 *
 * Every archive write uses `If-None-Match: *` with an SDK checksum, which the
 * archive's Object Lock default retention requires.
 */

export type LogSource = 'fallback' | 'ops-command' | 'engine';

export interface ArchiveStore {
  /** True when the key exists. */
  exists(key: string): Promise<boolean>;
  /** Writes the object unless the key exists. */
  putIfAbsent(key: string, body: Buffer, contentType: string): Promise<'created' | 'exists'>;
}

export interface AlertPublisher {
  publish(subject: string, message: string): Promise<void>;
}

export interface SentinelDependencies {
  readonly config: SentinelConfig;
  readonly archive: ArchiveStore;
  readonly publisher: AlertPublisher;
  /** The audit log groups created by name, and the source each one is archived as. */
  readonly logSources: Readonly<Record<string, Exclude<LogSource, 'engine'>>>;
  /** Which user pool, and which app clients, are the admin dashboard's. */
  readonly adminPool: AdminPoolResolver;
  /** The daily edge check's expectations and its read-only view of the edge regions. */
  readonly edge?: { config: EdgeCheckConfig; inspector: EdgeInspector };
}

/** A rule as it must be deployed: its state and its pattern. */
export interface ExpectedRule {
  name: string;
  state: string;
  pattern: EventPatternJson;
}

/** What the main region must hold: its routes, each to the sentinel itself (`lib/stacks/audit-stack.ts`). */
export interface MainCheckConfig {
  region: string;
  rules: ExpectedRule[];
  /** The sentinel's dead-letter queue, every route's. */
  deadLetterArn: string;
}

/** What each edge region must hold (`lib/stacks/audit-edge-stack.ts`), and the main region. */
export interface EdgeCheckConfig {
  regions: string[];
  rules: ExpectedRule[];
  /** The main region's default bus, every forward's target. */
  mainBusArn: string;
  /** Each region's dead-letter queue. */
  deadLetterArns: Record<string, string>;
  /** The main region's routes. Production always sets it. */
  main?: MainCheckConfig;
}

/** Read-only calls into a region's audit rules and queues. */
export interface EdgeInspector {
  /** The rule's state and its pattern as JSON, or null when it does not exist. */
  describeRule(region: string, name: string): Promise<{ state?: string; eventPattern?: string } | null>;
  /** Each target, and whether it hands its target something other than the matched event. */
  listTargets(region: string, name: string): Promise<Array<{ arn?: string; deadLetterArn?: string; transformsInput?: boolean }>>;
  queueDepth(region: string, queueArn: string): Promise<number>;
}

export type AdminPoolAnswer = { status: 'resolved'; adminPoolId: string } | { status: 'unresolved' };

/** The admin pool and its app clients' ids. */
export type AdminClientAnswer =
  | { status: 'resolved'; adminPoolId: string; adminClientIds: ReadonlySet<string> }
  | { status: 'unresolved' };

export interface AdminPoolResolver {
  /** The admin pool, given the pool a failed sign-in names (see createAdminPoolResolver). */
  resolve(eventPoolId: string): Promise<AdminPoolAnswer>;
  /** The admin pool and its app clients, given the app client a failed sign-in names when it names no pool. */
  resolveClient(eventClientId: string): Promise<AdminClientAnswer>;
}

export interface AdminPoolResolverOptions {
  /** One ListUserPools page. */
  listPage(nextToken?: string): Promise<{ pools: Array<{ Id?: string; Name?: string }>; nextToken?: string }>;
  /** One ListUserPoolClients page of a pool. */
  listClientsPage(poolId: string, nextToken?: string): Promise<{ clients: Array<{ ClientId?: string }>; nextToken?: string }>;
  /** The admin pool's fixed name. */
  poolName: string;
  /** How long an answer is kept (default one hour). */
  ttlMs?: number;
  /**
   * The least age an answer must reach before an event naming another pool,
   * or an app client it does not hold, refreshes it (default five minutes).
   */
  minRefreshMs?: number;
  now?: () => number;
}

/**
 * Finds the admin pool by its fixed name: every ListUserPools page, an exact
 * name match, and exactly one match, or the answer is `unresolved` (nothing
 * alerts, and the handler counts AuditCognitoPoolUnresolved). With the pool
 * found, every ListUserPoolClients page of it gives the admin app clients.
 * The answer is cached for an hour, and only once both listings complete. An
 * event naming another pool, or an app client the answer does not hold,
 * refreshes it once, so a recreated admin pool or a new admin client is
 * found, but no more than once every five minutes: worker and employer
 * failures are frequent, and each would otherwise cost a lookup. A failed
 * lookup throws, so the event is retried.
 */
export function createAdminPoolResolver(options: AdminPoolResolverOptions): AdminPoolResolver {
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  const minRefreshMs = options.minRefreshMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now;
  let cached: { answer: AdminClientAnswer; at: number } | undefined;

  async function clientIdsOf(poolId: string): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    let nextToken: string | undefined;
    do {
      const page = await options.listClientsPage(poolId, nextToken);
      for (const client of page.clients) {
        if (typeof client.ClientId === 'string') ids.add(client.ClientId);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return ids;
  }

  async function lookup(): Promise<AdminClientAnswer> {
    const matches: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await options.listPage(nextToken);
      for (const pool of page.pools) {
        if (pool.Name === options.poolName && typeof pool.Id === 'string') matches.push(pool.Id);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    const answer: AdminClientAnswer = matches.length === 1
      ? { status: 'resolved', adminPoolId: matches[0], adminClientIds: await clientIdsOf(matches[0]) }
      : { status: 'unresolved' };
    cached = { answer, at: now() };
    return answer;
  }

  /** The cached answer, looked up again when it is older than the TTL, or when it does not know the event's value and is old enough. */
  async function current(knows: (answer: AdminClientAnswer) => boolean): Promise<AdminClientAnswer> {
    if (!cached || now() - cached.at >= ttlMs) return lookup();
    const { answer, at } = cached;
    if (!knows(answer) && now() - at >= minRefreshMs) return lookup();
    return answer;
  }

  return {
    async resolve(eventPoolId) {
      const answer = await current((a) => a.status === 'resolved' && a.adminPoolId === eventPoolId);
      return answer.status === 'resolved' ? { status: 'resolved', adminPoolId: answer.adminPoolId } : answer;
    },
    async resolveClient(eventClientId) {
      return current((a) => a.status === 'resolved' && a.adminClientIds.has(eventClientId));
    },
  };
}

export type SentinelResult =
  | { kind: 'logs'; source: LogSource; key: string; events: number; stored: 'created' | 'exists' }
  | { kind: 'logs-control' }
  | { kind: 'event'; action: Classification['action'] | 'drop'; rule?: string; duplicate?: boolean }
  | { kind: 'edge'; problems: number };

const METRIC_NAMESPACE = 'Jale/Audit';

/** The engine log group RDS writes to, for any instance. */
const ENGINE_LOG_GROUP = /^\/aws\/rds\/instance\/[^/]+\/postgresql$/;

/** CloudWatch Logs event ids are long decimal strings; anything else is hashed out of the key. */
const LOG_EVENT_ID = /^[0-9]{1,64}$/;

interface LogsPayload {
  messageType?: string;
  logGroup?: string;
  logStream?: string;
  logEvents?: Array<{ id?: string; timestamp?: number; message?: string }>;
}

function decodeLogs(data: string): LogsPayload {
  return JSON.parse(zlib.gunzipSync(Buffer.from(data, 'base64')).toString('utf8')) as LogsPayload;
}

function utcDay(epochMs: number): string {
  return new Date(Number.isFinite(epochMs) ? epochMs : Date.now()).toISOString().slice(0, 10);
}

function logSourceOf(logGroup: string | undefined, deps: SentinelDependencies): LogSource {
  if (logGroup && Object.prototype.hasOwnProperty.call(deps.logSources, logGroup)) return deps.logSources[logGroup];
  if (logGroup && ENGINE_LOG_GROUP.test(logGroup)) return 'engine';
  // A subscription this function was not set up for: fail, so the batch is
  // retried and lands in the dead-letter queue instead of being lost.
  throw new Error('AUDIT_SENTINEL_UNKNOWN_LOG_GROUP');
}

async function archiveLogs(payload: LogsPayload, deps: SentinelDependencies): Promise<SentinelResult> {
  if (payload.messageType === 'CONTROL_MESSAGE') return { kind: 'logs-control' };
  const source = logSourceOf(payload.logGroup, deps);
  const events = Array.isArray(payload.logEvents) ? payload.logEvents : [];
  if (events.length === 0) throw new Error('AUDIT_SENTINEL_EMPTY_LOG_BATCH');
  const first = String(events[0].id ?? '');
  const last = String(events[events.length - 1].id ?? '');
  if (!LOG_EVENT_ID.test(first) || !LOG_EVENT_ID.test(last)) throw new Error('AUDIT_SENTINEL_LOG_EVENT_ID');
  const key = `logs/${source}/dt=${utcDay(Number(events[0].timestamp))}/${first}-${last}.jsonl.gz`;
  const body = events
    .map((e) => `${JSON.stringify({ id: e.id, timestamp: e.timestamp, logGroup: payload.logGroup, logStream: payload.logStream, message: e.message })}\n`)
    .join('');
  const stored = await deps.archive.putIfAbsent(key, zlib.gzipSync(Buffer.from(body, 'utf8')), 'application/gzip');
  logLine({ event: 'logs_archived', source, events: events.length, stored });
  return { kind: 'logs', source, key, events: events.length, stored };
}

function logLine(fields: Record<string, string | number | boolean>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(fields));
}

async function raiseAlert(alert: AlertRecord, archive: ArchiveRecord, deps: SentinelDependencies): Promise<SentinelResult> {
  if (await deps.archive.exists(archive.key)) {
    logLine({ event: 'alert_duplicate', rule: alert.rule });
    return { kind: 'event', action: 'alert', rule: alert.rule, duplicate: true };
  }
  await deps.publisher.publish(`Jale audit alert: ${alert.rule}`, JSON.stringify(alert, null, 2));
  await deps.archive.putIfAbsent(archive.key, gzipJson(archive.body), 'application/gzip');
  emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditSentinelAlerts', value: 1 }]);
  logLine({ event: 'alert_published', rule: alert.rule });
  return { kind: 'event', action: 'alert', rule: alert.rule };
}

/** An event that names a pool is attributed by that pool alone. */
const BY_POOL_ALONE: ReadonlySet<string> = new Set();

/**
 * A failed user-pool sign-in: nothing of a non-admin event is kept.
 *   - It names a pool: the admin pool's, or dropped.
 *   - It names no pool and an app client: the admin pool's when the client
 *     is one of its own; any other client is dropped silently, since worker
 *     and employer sign-ins name theirs the same way.
 *   - It names neither: counted (AuditCognitoEventUnattributed), and dropped.
 */
async function handleCognito(event: Record<string, any>, deps: SentinelDependencies): Promise<SentinelResult> {
  const detail = event.detail ?? {};
  const eventPoolId = cognitoPoolIdOf(detail);
  const eventClientId = cognitoClientIdOf(detail);
  let admin: { poolId: string; clientIds: ReadonlySet<string> } | null;
  if (eventPoolId !== null) {
    const answer = await deps.adminPool.resolve(eventPoolId);
    admin = answer.status === 'resolved' ? { poolId: answer.adminPoolId, clientIds: BY_POOL_ALONE } : null;
  } else if (eventClientId !== null) {
    const answer = await deps.adminPool.resolveClient(eventClientId);
    admin = answer.status === 'resolved' ? { poolId: answer.adminPoolId, clientIds: answer.adminClientIds } : null;
  } else {
    emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditCognitoEventUnattributed', value: 1 }]);
    return { kind: 'event', action: 'drop' };
  }
  if (admin === null) {
    emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditCognitoPoolUnresolved', value: 1 }]);
    return { kind: 'event', action: 'drop' };
  }
  const result = classifyCognitoFailure(event, admin.poolId, admin.clientIds);
  return result.action === 'alert' ? raiseAlert(result.alert, result.archive, deps) : { kind: 'event', action: 'drop' };
}

async function handleEvent(event: Record<string, unknown>, deps: SentinelDependencies): Promise<SentinelResult> {
  const result = classifyEvent(event, deps.config);
  switch (result.action) {
    case 'alert':
      return raiseAlert(result.alert, result.archive, deps);
    case 'cognito':
      return handleCognito(event, deps);
    case 'archive':
      await deps.archive.putIfAbsent(result.archive.key, gzipJson(result.archive.body), 'application/gzip');
      logLine({ event: 'finding_archived', category: result.archive.category });
      return { kind: 'event', action: 'archive' };
    default:
      logLine({ event: 'event_classified', action: result.action, reason: result.reason });
      return { kind: 'event', action: result.action };
  }
}

function gzipJson(value: unknown): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
}

type EdgeProblem = { region: string; item: string; problem: string };

/**
 * One rule against what it must be: it exists, in its state, with its
 * pattern, and with one target, the expected one, which keeps its
 * dead-letter queue and passes the matched event on as it is.
 */
async function checkRule(
  inspector: EdgeInspector,
  region: string,
  rule: ExpectedRule,
  target: { arn: string; deadLetterArn?: string },
  problems: EdgeProblem[],
): Promise<void> {
  const problem = (code: string) => problems.push({ region, item: rule.name, problem: code });
  try {
    const found = await inspector.describeRule(region, rule.name);
    if (!found) {
      problem('rule_missing');
      return;
    }
    if (found.state !== rule.state) problem('rule_state');
    if (!samePattern(found.eventPattern, rule.pattern)) problem('rule_pattern');
    const targets = await inspector.listTargets(region, rule.name);
    if (targets.length !== 1 || targets[0].arn !== target.arn) {
      problem('rule_target');
      return;
    }
    if (!target.deadLetterArn || targets[0].deadLetterArn !== target.deadLetterArn) problem('rule_dead_letters');
    if (targets[0].transformsInput !== false) problem('rule_input');
  } catch {
    problem('rule_unreadable');
  }
}

/**
 * The function an invocation runs as, without the version or alias it was
 * invoked by: what the main region's routes target. Undefined when the
 * invocation does not name a function.
 */
export function ownFunctionArn(invokedFunctionArn: unknown): string | undefined {
  if (typeof invokedFunctionArn !== 'string') return undefined;
  const parts = invokedFunctionArn.split(':');
  if (parts.length < 7 || parts[0] !== 'arn' || parts[2] !== 'lambda' || parts[5] !== 'function' || !parts[6]) return undefined;
  return parts.slice(0, 7).join(':');
}

async function publishProblems(deps: SentinelDependencies, rule: string, summary: string, problems: EdgeProblem[]): Promise<void> {
  if (problems.length === 0) return;
  await deps.publisher.publish(`Jale audit alert: ${rule}`, JSON.stringify({ rule, summary, problems }, null, 2));
}

/**
 * The daily check of the audit rules, run with the sentinel's own function.
 *   - In every edge region, each forwarding rule exists, is in its expected
 *     state, has its expected pattern and targets the main bus with its
 *     dead-letter queue, passing each event on unchanged, and the queue is
 *     empty (alert `audit_edge_unhealthy`).
 *   - In the main region, each route exists in the same way and targets
 *     this function with its dead-letter queue (alert `audit_rules_unhealthy`).
 * Problems alert with codes only, and both kinds count in AuditEdgeCheckFailed.
 */
async function runEdgeCheck(deps: SentinelDependencies, ownArn: string | undefined): Promise<SentinelResult> {
  if (!deps.edge) throw new Error('AUDIT_SENTINEL_CONFIG: no edge check configured');
  const { config, inspector } = deps.edge;
  const problems: EdgeProblem[] = [];
  for (const region of config.regions) {
    const dlq = config.deadLetterArns[region];
    for (const rule of config.rules) {
      await checkRule(inspector, region, rule, { arn: config.mainBusArn, deadLetterArn: dlq }, problems);
    }
    try {
      if (!dlq) throw new Error('no queue');
      if (await inspector.queueDepth(region, dlq) > 0) problems.push({ region, item: 'dead_letters', problem: 'events_waiting' });
    } catch {
      problems.push({ region, item: 'dead_letters', problem: 'queue_unreadable' });
    }
  }
  const mainProblems: EdgeProblem[] = [];
  if (config.main) {
    const { region, rules, deadLetterArn } = config.main;
    if (!ownArn) {
      // Every route targets this function; without its ARN the check cannot tell a route from a redirected one.
      mainProblems.push({ region, item: 'sentinel', problem: 'own_function_unknown' });
    } else {
      for (const rule of rules) await checkRule(inspector, region, rule, { arn: ownArn, deadLetterArn }, mainProblems);
    }
  }
  const total = problems.length + mainProblems.length;
  emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditEdgeCheckFailed', value: total }]);
  await publishProblems(deps, 'audit_edge_unhealthy', 'An edge region is not forwarding audit events as configured.', problems);
  await publishProblems(deps, 'audit_rules_unhealthy', 'An audit rule in the main region is not routing events to the sentinel as configured.', mainProblems);
  emitEmfMetrics(METRIC_NAMESPACE, [{ name: 'AuditEdgeCheckCompleted', value: 1 }]);
  logLine({ event: 'edge_checked', problems: total, main_region_problems: mainProblems.length });
  return { kind: 'edge', problems: total };
}

/** What Lambda passes with each invocation, as far as the sentinel reads it. */
export interface InvocationContext {
  readonly invokedFunctionArn?: string;
}

export function createSentinelHandler(deps: SentinelDependencies): (event: unknown, context?: InvocationContext) => Promise<SentinelResult> {
  return async (event: unknown, context?: InvocationContext) => {
    const input = (event ?? {}) as Record<string, any>;
    if (input.check === 'edge') return runEdgeCheck(deps, ownFunctionArn(context?.invokedFunctionArn));
    if (typeof input.awslogs?.data === 'string') return archiveLogs(decodeLogs(input.awslogs.data), deps);
    if (typeof input['detail-type'] === 'string') return handleEvent(input, deps);
    throw new Error('AUDIT_SENTINEL_UNKNOWN_EVENT');
  };
}

// ── Production wiring ───────────────────────────────────────────────────

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`AUDIT_SENTINEL_CONFIG: ${name} is not set`);
  return value;
}

function list(name: string): string[] {
  return required(name).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The names the audit rules' patterns are built from, as the stack sets them. */
function routeNamesFromEnv(): RouteNames {
  return { rulePrefix: required('AUDIT_RULE_PREFIX'), roleNames: list('AUDIT_ROLE_NAMES'), bucketPrefix: required('AUDIT_BUCKET_PREFIX') };
}

/** Which detection services' findings the main region routes: `none`, or some of `guardduty,securityhub`. */
function routedFindingsFromEnv(): RoutedFindings {
  const value = required('AUDIT_ROUTED_FINDINGS');
  const services = value === 'none' ? [] : value.split(',').map((s) => s.trim());
  if (services.some((service) => service !== 'guardduty' && service !== 'securityhub')) {
    throw new Error('AUDIT_SENTINEL_CONFIG: AUDIT_ROUTED_FINDINGS is malformed');
  }
  return { guardDutyFindings: services.includes('guardduty'), securityHubFindings: services.includes('securityhub') };
}

function expected(routes: AuditRoute[]): ExpectedRule[] {
  return routes.map((route) => ({ name: route.name, state: ruleState(route.allManagementEvents), pattern: route.pattern }));
}

/**
 * The daily check's settings, from the environment its stack sets. The rules
 * come from the table the stacks deploy, built with the same names; the
 * main region is the function's own (AWS_REGION, which Lambda sets).
 */
export function edgeCheckConfigFromEnv(): EdgeCheckConfig {
  const regions = (process.env.AUDIT_EDGE_REGIONS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const names = routeNamesFromEnv();
  return {
    regions,
    rules: expected(edgeRoutes(names)),
    mainBusArn: required('AUDIT_MAIN_BUS_ARN'),
    deadLetterArns: JSON.parse(required('AUDIT_EDGE_DLQ_ARNS')) as Record<string, string>,
    main: {
      region: required('AWS_REGION'),
      rules: expected(mainRoutes(names, routedFindingsFromEnv())),
      deadLetterArn: required('AUDIT_SENTINEL_DEAD_LETTER_ARN'),
    },
  };
}

/** The edge regions through their SDK clients, read-only. */
export function sdkEdgeInspector(
  makeEvents: (region: string) => Pick<EventBridgeClient, 'send'> = (region) => new EventBridgeClient({ region }),
  makeSqs: (region: string) => Pick<SQSClient, 'send'> = (region) => new SQSClient({ region }),
): EdgeInspector {
  const events = new Map<string, Pick<EventBridgeClient, 'send'>>();
  const queues = new Map<string, Pick<SQSClient, 'send'>>();
  const eventsIn = (region: string) => events.get(region) ?? events.set(region, makeEvents(region)).get(region)!;
  const sqsIn = (region: string) => queues.get(region) ?? queues.set(region, makeSqs(region)).get(region)!;
  return {
    async describeRule(region, name) {
      try {
        const rule = await eventsIn(region).send(new DescribeRuleCommand({ Name: name }));
        return { state: rule.State, eventPattern: rule.EventPattern };
      } catch (error) {
        if ((error as { name?: string }).name === 'ResourceNotFoundException') return null;
        throw error;
      }
    },
    async listTargets(region, name) {
      const result = await eventsIn(region).send(new ListTargetsByRuleCommand({ Rule: name }));
      return (result.Targets ?? []).map((t) => ({
        arn: t.Arn,
        deadLetterArn: t.DeadLetterConfig?.Arn,
        transformsInput: t.Input != null || t.InputPath != null || t.InputTransformer != null,
      }));
    },
    async queueDepth(region, queueArn) {
      const [, , , , account, name] = queueArn.split(':');
      const result = await sqsIn(region).send(new GetQueueAttributesCommand({
        QueueUrl: `https://sqs.${region}.amazonaws.com/${account}/${name}`,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      const depth = Number(result.Attributes?.ApproximateNumberOfMessages);
      if (!Number.isInteger(depth) || depth < 0) throw new Error('AUDIT_SENTINEL_QUEUE_DEPTH');
      return depth;
    },
  };
}

export function sentinelConfigFromEnv(): Pick<SentinelDependencies, 'config' | 'logSources'> & { adminPoolName: string } {
  const logSources = JSON.parse(required('AUDIT_LOG_SOURCES')) as Record<string, Exclude<LogSource, 'engine'>>;
  const ownName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  return {
    config: {
      alertTopicArn: required('AUDIT_ALERT_TOPIC_ARN'),
      auditKeyArn: required('AUDIT_KEY_ARN'),
      auditKeyAlias: required('AUDIT_KEY_ALIAS'),
      alertKeyArn: required('AUDIT_ALERT_KEY_ARN'),
      alertKeyAlias: required('AUDIT_ALERT_KEY_ALIAS'),
      auditBucketPrefix: required('AUDIT_BUCKET_PREFIX'),
      auditLogGroups: Object.keys(logSources),
      auditRulePrefix: required('AUDIT_RULE_PREFIX'),
      auditRoleNames: list('AUDIT_ROLE_NAMES'),
      auditFunctionNames: [...list('AUDIT_FUNCTION_NAMES'), ...(ownName ? [ownName] : [])],
      exportRoleName: required('AUDIT_EXPORT_ROLE_NAME'),
      masterSecretArn: required('AUDIT_MASTER_SECRET_ARN'),
      appStacks: list('AUDIT_APP_STACKS'),
      opsHostStack: required('AUDIT_OPS_HOST_STACK'),
      deployPolicyNames: list('AUDIT_DEPLOY_POLICIES'),
      fixedFunctions: (process.env.AUDIT_FIXED_FUNCTIONS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        .map((entry) => {
          const [stack, functionName, ...rest] = entry.split('/');
          if (!stack || !functionName || rest.length > 0) throw new Error('AUDIT_SENTINEL_CONFIG: AUDIT_FIXED_FUNCTIONS is malformed');
          return { stack, functionName };
        }),
      auditAlarmPrefix: required('AUDIT_ALARM_PREFIX'),
      // The edge regions' queue by its fixed name, and this function's own queue by its ARN's last part.
      auditQueueNames: [
        edgeDeadLetterQueue({ rulePrefix: required('AUDIT_RULE_PREFIX') }),
        required('AUDIT_SENTINEL_DEAD_LETTER_ARN').split(':').pop()!,
      ],
    },
    logSources,
    adminPoolName: required('AUDIT_ADMIN_POOL_NAME'),
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/** The archive bucket through S3, with conditional writes. */
export function s3ArchiveStore(client: S3Client, bucket: string): ArchiveStore {
  return {
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (statusOf(error) === 404) return false;
        throw error;
      }
    },
    async putIfAbsent(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          IfNoneMatch: '*',
          ChecksumAlgorithm: 'SHA256',
        }));
        return 'created';
      } catch (error) {
        if (statusOf(error) === 412) return 'exists';
        throw error;
      }
    },
  };
}

/**
 * The user-pool listings the admin-pool resolver reads, through the SDK, 60
 * to a page (the most either call returns).
 */
export function sdkUserPoolListers(
  client: Pick<CognitoIdentityProviderClient, 'send'>,
): Pick<AdminPoolResolverOptions, 'listPage' | 'listClientsPage'> {
  return {
    async listPage(nextToken) {
      const page = await client.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: nextToken }));
      return { pools: page.UserPools ?? [], nextToken: page.NextToken };
    },
    async listClientsPage(poolId, nextToken) {
      const page = await client.send(new ListUserPoolClientsCommand({ UserPoolId: poolId, MaxResults: 60, NextToken: nextToken }));
      return { clients: page.UserPoolClients ?? [], nextToken: page.NextToken };
    },
  };
}

/** The audit-alerts topic through SNS. */
export function snsAlertPublisher(client: SNSClient, topicArn: string): AlertPublisher {
  return {
    async publish(subject, message) {
      await client.send(new PublishCommand({ TopicArn: topicArn, Subject: subject.slice(0, 100), Message: message }));
    },
  };
}

let production: ReturnType<typeof createSentinelHandler> | undefined;

export async function handler(event: unknown, context?: InvocationContext): Promise<SentinelResult> {
  if (!production) {
    const { config, logSources, adminPoolName } = sentinelConfigFromEnv();
    production = createSentinelHandler({
      config,
      logSources,
      adminPool: createAdminPoolResolver({ poolName: adminPoolName, ...sdkUserPoolListers(new CognitoIdentityProviderClient({})) }),
      edge: { config: edgeCheckConfigFromEnv(), inspector: sdkEdgeInspector() },
      archive: s3ArchiveStore(new S3Client({}), required('AUDIT_ARCHIVE_BUCKET')),
      publisher: snsAlertPublisher(new SNSClient({}), config.alertTopicArn),
    });
  }
  return production(event, context);
}
