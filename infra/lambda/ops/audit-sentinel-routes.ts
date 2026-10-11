import {
  AUDIT_FUNCTION_EVENT_PREFIXES,
  AUDIT_SYSTEM_EVENTS,
  COGNITO_SIGN_IN_EVENTS,
  DATABASE_EVENTS,
  FUNCTION_ROLE_EVENTS,
  FUNCTION_VERSION_EVENTS,
  PARAMETER_EVENTS,
  ROLE_ASSUMPTION_EVENTS,
  SECRET_CHANGE_EVENTS,
  SECRET_READ_EVENTS,
  SESSION_PREFERENCE_EVENTS,
} from './audit-sentinel-rules';

/**
 * The audit rules as data: the main region's routes to the sentinel and the
 * edge regions' forwarders. The stacks deploy these rules, and the
 * sentinel's daily check reads each deployed rule back and compares it with
 * the same table, so the two cannot drift apart. No CDK here: the sentinel
 * bundles it.
 *
 * A pattern is kept in the form a rule stores and DescribeRule returns, with
 * `detail-type`; the stacks hand it to the CDK as `detailType`.
 */

/** An EventBridge event pattern, as JSON. */
export type EventPatternJson = { [field: string]: unknown };

export interface AuditRoute {
  /** The rule's construct id in its stack. */
  readonly id: string;
  /** The rule's name, under the audit prefix. */
  readonly name: string;
  readonly description: string;
  readonly pattern: EventPatternJson;
  /** True when the rule matches read-only management events too (see ruleState). */
  readonly allManagementEvents: boolean;
}

/** The names the patterns are built from: the stacks' fixed names, and the sentinel's settings. */
export interface RouteNames {
  readonly rulePrefix: string;
  /** The audit roles, whose assumptions are routed. */
  readonly roleNames: readonly string[];
  readonly bucketPrefix: string;
}

export type RuleState = 'ENABLED' | 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS';

/** A rule in the default ENABLED state never matches read-only management events. */
export function ruleState(allManagementEvents: boolean): RuleState {
  return allManagementEvents ? 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS' : 'ENABLED';
}

const API_CALL = 'AWS API Call via CloudTrail';
const CONSOLE_SIGN_IN = 'AWS Console Sign In via CloudTrail';

function apiCall(source: string, detail: Record<string, unknown>): EventPatternJson {
  return { source: [source], 'detail-type': [API_CALL], detail };
}

function roleAssumptions(names: RouteNames): EventPatternJson {
  return apiCall('aws.sts', {
    eventName: [...ROLE_ASSUMPTION_EVENTS],
    requestParameters: { roleArn: names.roleNames.map((role) => ({ suffix: `:role/${role}` })) },
  });
}

/**
 * The rules each edge region carries, forwarding to the main region's bus
 * (`lib/stacks/audit-edge-stack.ts`). Every call builds new objects.
 */
export function edgeRoutes(names: RouteNames): AuditRoute[] {
  const edge = (id: string, short: string, pattern: EventPatternJson, allManagementEvents = false): AuditRoute => {
    const name = `${names.rulePrefix}edge-${short}`;
    return { id, name, description: `Audit events recorded in this region, to the main region (${name})`, pattern, allManagementEvents };
  };
  return [
    edge('IdentityRule', 'identity', { source: ['aws.iam'], 'detail-type': [API_CALL] }),
    edge('SignInRule', 'sign-in', { 'detail-type': [CONSOLE_SIGN_IN] }),
    edge('RootUseRule', 'root', { 'detail-type': [API_CALL], detail: { userIdentity: { type: ['Root'] } } }, true),
    edge('AuditRoleAssumptionsRule', 'role-assumptions', roleAssumptions(names), true),
    // Changes to the audit rules themselves, twice over, so deleting or
    // disabling one still forwards the change.
    edge('RuleChangesRuleA', 'rule-changes-a', apiCall('aws.events', { eventName: [...AUDIT_SYSTEM_EVENTS['events.amazonaws.com']] })),
    edge('RuleChangesRuleB', 'rule-changes-b', apiCall('aws.events', { eventName: [...AUDIT_SYSTEM_EVENTS['events.amazonaws.com']] })),
    // Functions created with an execution role or given one, where the
    // sentinel looks for the export job's role.
    edge('FunctionRolesRule', 'function-roles', apiCall('aws.lambda', { eventName: [...FUNCTION_ROLE_EVENTS] })),
    // Changes to alarms and queues, where the sentinel looks for this
    // region's own: its alarms and its dead-letter queue.
    edge('AlarmsAndQueuesRule', 'alarms-and-queues', {
      source: ['aws.monitoring', 'aws.sqs'],
      'detail-type': [API_CALL],
      detail: { eventName: [...AUDIT_SYSTEM_EVENTS['monitoring.amazonaws.com'], ...AUDIT_SYSTEM_EVENTS['sqs.amazonaws.com']] },
    }),
  ];
}

/** The queue that keeps what an edge region could not forward, by its fixed name in every edge region. */
export function edgeDeadLetterQueue(names: Pick<RouteNames, 'rulePrefix'>): string {
  return `${names.rulePrefix}edge-dead-letters`;
}

/** Which detection services' findings the main region routes: those whose mode is not off. */
export interface RoutedFindings {
  readonly guardDutyFindings: boolean;
  readonly securityHubFindings: boolean;
}

/**
 * The main region's rules, each to the sentinel (`lib/stacks/audit-stack.ts`).
 * They route broadly, from the event-name tables the sentinel classifies by.
 * Every call builds new objects.
 */
export function mainRoutes(names: RouteNames, findings: RoutedFindings): AuditRoute[] {
  const route = (id: string, short: string, description: string, pattern: EventPatternJson, allManagementEvents = false): AuditRoute =>
    ({ id, name: `${names.rulePrefix}${short}`, description, pattern, allManagementEvents });
  const routes = [
    route('SecretReadsRule', 'secret-reads', 'Secret reads, for the sentinel', apiCall('aws.secretsmanager', { eventName: [...SECRET_READ_EVENTS] }), true),
    route('SecretChangesRule', 'secret-changes', 'Secret changes', apiCall('aws.secretsmanager', { eventName: [...SECRET_CHANGE_EVENTS] })),
    route('DatabaseRule', 'database', 'Database instance, parameter group and snapshot changes', apiCall('aws.rds', { eventName: [...DATABASE_EVENTS] })),
    route('IdentityRule', 'identity', 'Identity changes (forwarded from us-east-1)', { source: ['aws.iam'], 'detail-type': [API_CALL] }),
    route('ParametersRule', 'parameters', 'Parameter and session preference changes',
      apiCall('aws.ssm', { eventName: [...PARAMETER_EVENTS, ...SESSION_PREFERENCE_EVENTS] })),
    route('AuditRoleAssumptionsRule', 'role-assumptions', 'Assumptions of the audit roles', roleAssumptions(names), true),
    route('RootUseRule', 'root', 'Any use of the account root', { 'detail-type': [API_CALL], detail: { userIdentity: { type: ['Root'] } } }, true),
    route('SignInRule', 'sign-in', 'Console sign-in events', { 'detail-type': [CONSOLE_SIGN_IN] }),
    // The admin pool's failed passwords and second factors happen between
    // the browser and Cognito. The sentinel keeps only the admin pool's, and
    // nothing of any other pool's.
    route('AdminSignInFailuresRule', 'admin-sign-in-failures', 'Failed user-pool sign-ins, for the admin pool check',
      apiCall('aws.cognito-idp', { eventName: [...COGNITO_SIGN_IN_EVENTS], errorCode: [{ exists: true }] }), true),
  ];
  for (const [service, eventNames] of Object.entries(AUDIT_SYSTEM_EVENTS)) {
    const short = service.split('.')[0];
    const detail = (): Record<string, unknown> => ({
      eventName: [...eventNames],
      ...(short === 's3' ? { requestParameters: { bucketName: [{ prefix: names.bucketPrefix }] } } : {}),
    });
    const id = `AuditSystem${short.charAt(0).toUpperCase()}${short.slice(1)}Rule`;
    routes.push(route(id, `system-${short}`, `Audit system changes recorded by ${short}`, apiCall(`aws.${short}`, detail())));
    // Changes to the audit rules themselves, routed twice, as the edge
    // regions forward them twice: changing one route leaves the other.
    if (short === 'events') {
      routes.push(route(`${id}B`, `system-${short}-b`, `Audit system changes recorded by ${short} (the second of two routes)`, apiCall(`aws.${short}`, detail())));
    }
  }
  routes.push(route('AuditSystemLambdaRule', 'system-lambda', "Changes to functions, for the audit functions and the export job's role",
    apiCall('aws.lambda', {
      eventName: [...AUDIT_FUNCTION_EVENT_PREFIXES.map((prefix) => ({ prefix })), ...FUNCTION_VERSION_EVENTS, ...FUNCTION_ROLE_EVENTS],
    })));
  if (findings.guardDutyFindings) {
    routes.push(route('GuardDutyFindingsRule', 'guardduty-findings', 'GuardDuty findings', { source: ['aws.guardduty'], 'detail-type': ['GuardDuty Finding'] }));
  }
  if (findings.securityHubFindings) {
    routes.push(route('SecurityHubFindingsRule', 'securityhub-findings', 'New, active, high and critical Security Hub control findings', {
      source: ['aws.securityhub'],
      'detail-type': ['Security Hub Findings - Imported'],
      detail: {
        findings: {
          ProductName: ['Security Hub'],
          Severity: { Label: ['HIGH', 'CRITICAL'] },
          RecordState: ['ACTIVE'],
          Workflow: { Status: ['NEW'] },
        },
      },
    }));
  }
  return routes;
}

/**
 * A pattern in one canonical form: object keys sorted, and each list read as
 * a set (sorted, without repeats), because a rule matches any value in a
 * list whatever its order. A `numeric` list is a sequence of operators and
 * operands, so its order is kept.
 */
export function canonicalPattern(value: unknown): string {
  return canonical(value, false);
}

function canonical(value: unknown, ordered: boolean): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, false));
    return `[${(ordered ? items : [...new Set(items)].sort()).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.keys(value)
      .filter((field) => (value as Record<string, unknown>)[field] !== undefined)
      .sort()
      .map((field) => `${JSON.stringify(field)}:${canonical((value as Record<string, unknown>)[field], field === 'numeric')}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** True when a deployed rule's pattern, as DescribeRule returns it, is the expected one. */
export function samePattern(deployed: string | undefined, expected: EventPatternJson): boolean {
  if (typeof deployed !== 'string' || deployed.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(deployed);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return canonicalPattern(parsed) === canonicalPattern(expected);
}
