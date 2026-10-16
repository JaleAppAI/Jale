import { createHash } from 'node:crypto';

/**
 * The audit sentinel's classification rules: pure
 * functions from one EventBridge event to what the sentinel does with it.
 *
 * Risky actions are classified here, in code, rather than in EventBridge
 * patterns: the expected readers of a secret cannot be written as patterns
 * without referencing every workload role, and code can be tested against
 * fixture events. The EventBridge rules (`lib/stacks/audit-stack.ts`) only
 * route broadly, from the event-name tables exported below, so routing and
 * classification come from one list.
 *
 * WHAT AN ALERT CARRIES. Codes and the event's own identifying fields: event
 * source and name, time, region, CloudTrail event id, principal type and ARN,
 * the invoking service, the error code, and the one resource field the event
 * names (a secret id, a role, a bucket, a log group). Never request or
 * response bodies, error messages, source addresses or user agents. Secret
 * values never appear in CloudTrail, and nothing here would copy them if they
 * did. Alerts go to email, outside the repository.
 *
 * WHAT IS ARCHIVED under `findings/`: for a CloudTrail event, the alert record
 * only (the full event is already in the trail's own archive, and the eventId
 * finds it); for a GuardDuty finding, the classification and the finding,
 * which exist nowhere else; for a Security Hub finding that alerts, the alert
 * record only, keyed by the finding's state (the finding stays in Security
 * Hub, and its Id, an ARN, is kept out of the archive); for any other Security
 * Hub finding, the classification and the findings.
 */

export interface SentinelConfig {
  /** The audit-alerts topic. */
  readonly alertTopicArn: string;
  /** The audit KMS key's ARN, and its alias. */
  readonly auditKeyArn: string;
  readonly auditKeyAlias: string;
  /** The alert topic's own KMS key's ARN, and its alias. */
  readonly alertKeyArn: string;
  readonly alertKeyAlias: string;
  /** Every audit bucket's name starts with this. */
  readonly auditBucketPrefix: string;
  /** The audit log groups created by name (fallback, ops-command). */
  readonly auditLogGroups: readonly string[];
  /** Every audit EventBridge rule's name starts with this. */
  readonly auditRulePrefix: string;
  /** The audit roles' names. */
  readonly auditRoleNames: readonly string[];
  /** The audit functions' names (the export job and the sentinel itself). */
  readonly auditFunctionNames: readonly string[];
  /**
   * The export job's execution role, by name. Only that role may write the
   * weekly full verification's progress, so any function given it could.
   */
  readonly exportRoleName: string;
  /** The database master secret's ARN. */
  readonly masterSecretArn: string;
  /** The exact names of the app's stacks: their roles and functions carry them as a prefix. */
  readonly appStacks: readonly string[];
  /** The ops host's stack. */
  readonly opsHostStack: string;
  /** Managed policies the app's stacks create under fixed names. */
  readonly deployPolicyNames: readonly string[];
  /** The app's database functions that have a fixed name, each with its stack. */
  readonly fixedFunctions: ReadonlyArray<{ stack: string; functionName: string }>;
  /** Every audit alarm's name starts with this, in the main region and the edge regions. */
  readonly auditAlarmPrefix: string;
  /** The audit queues' names: the sentinel's dead-letter queue and the edge regions'. */
  readonly auditQueueNames: readonly string[];
}

export type AlertRule =
  | 'root_use'
  | 'secret_read'
  | 'secret_read_denied'
  | 'secret_change'
  | 'database_change'
  | 'identity_change'
  | 'parameter_change'
  | 'audit_system_change'
  | 'audit_role_assumed'
  | 'console_sign_in_failed'
  | 'guardduty_finding'
  | 'securityhub_finding'
  | 'admin_sign_in_failed';

export interface AlertRecord {
  rule: AlertRule;
  summary: string;
  eventSource?: string;
  eventName?: string;
  eventTime?: string;
  awsRegion?: string;
  eventId?: string;
  principalType: string;
  principalArn?: string;
  invokedBy?: string;
  errorCode?: string;
  target?: string;
  findingType?: string;
  severity?: string;
  /** A failed sign-in's auth flow and challenge: one of Cognito's own codes, or `other`. */
  authFlow?: string;
  challengeName?: string;
  poolMatch?: true;
}

export type ArchiveCategory = 'cloudtrail' | 'guardduty' | 'securityhub' | 'cognito';

export interface ArchiveRecord {
  category: ArchiveCategory;
  /**
   * `findings/<category>/dt=<UTC day>/<id>.json.gz`: one key per source event,
   * so a repeat is a no-op. A Security Hub alert's record is keyed by its
   * finding's state instead, `findings/securityhub-state/<sha256 hex>.json.gz`,
   * so a re-import of the same state is a no-op too.
   */
  key: string;
  body: Record<string, unknown>;
}

export type Classification =
  | { action: 'alert'; alert: AlertRecord; archive: ArchiveRecord }
  | { action: 'archive'; archive: ArchiveRecord }
  | { action: 'expected'; reason: string }
  | { action: 'ignore'; reason: string }
  /** A failed user-pool sign-in: the handler resolves the admin pool and its app clients, then calls classifyCognitoFailure. */
  | { action: 'cognito' };

type Json = Record<string, any>;

// ── Routing tables (the EventBridge rules are built from these) ──────────

export const SECRET_READ_EVENTS = ['GetSecretValue', 'BatchGetSecretValue'] as const;

export const SECRET_CHANGE_EVENTS = [
  'PutSecretValue', 'UpdateSecret', 'DeleteSecret', 'RestoreSecret', 'RotateSecret', 'CancelRotateSecret',
  'PutResourcePolicy', 'DeleteResourcePolicy', 'UpdateSecretVersionStage',
  'ReplicateSecretToRegions', 'RemoveRegionsFromReplication', 'StopReplicationToReplica',
] as const;

export const DATABASE_EVENTS = [
  'ModifyDBInstance', 'RebootDBInstance', 'DeleteDBInstance', 'StopDBInstance',
  'CreateDBParameterGroup', 'ModifyDBParameterGroup', 'ResetDBParameterGroup', 'DeleteDBParameterGroup', 'CopyDBParameterGroup',
  'CopyDBSnapshot', 'ModifyDBSnapshot', 'ModifyDBSnapshotAttribute', 'DeleteDBSnapshot',
] as const;

export const PARAMETER_EVENTS = [
  'PutParameter', 'DeleteParameter', 'DeleteParameters', 'LabelParameterVersion', 'UnlabelParameterVersion',
] as const;

/** Changes to the Session Manager preferences document, which governs session logging. */
export const SESSION_PREFERENCE_EVENTS = ['UpdateDocument', 'UpdateDocumentDefaultVersion', 'DeleteDocument'] as const;
export const SESSION_PREFERENCES_DOCUMENT = 'SSM-SessionManagerRunShell';

/** Audit-system changes, by the service that records them. */
export const AUDIT_SYSTEM_EVENTS = {
  'cloudtrail.amazonaws.com': ['StopLogging', 'DeleteTrail', 'UpdateTrail', 'PutEventSelectors', 'PutInsightSelectors'],
  's3.amazonaws.com': [
    'PutBucketPolicy', 'DeleteBucketPolicy', 'PutBucketLifecycle', 'PutBucketLifecycleConfiguration', 'DeleteBucketLifecycle',
    'PutBucketVersioning', 'PutObjectLockConfiguration', 'PutBucketEncryption', 'DeleteBucketEncryption',
    'PutBucketPublicAccessBlock', 'DeleteBucketPublicAccessBlock', 'PutBucketAcl', 'PutBucketOwnershipControls',
    'DeleteBucketOwnershipControls', 'PutBucketReplication', 'DeleteBucket',
  ],
  'kms.amazonaws.com': [
    'PutKeyPolicy', 'DisableKey', 'EnableKey', 'ScheduleKeyDeletion', 'CancelKeyDeletion', 'DisableKeyRotation',
    'EnableKeyRotation', 'CreateGrant', 'RevokeGrant', 'UpdateKeyDescription', 'CreateAlias', 'UpdateAlias', 'DeleteAlias',
    'ImportKeyMaterial', 'DeleteImportedKeyMaterial', 'ReplicateKey', 'UpdatePrimaryRegion',
  ],
  'logs.amazonaws.com': [
    'DeleteLogGroup', 'DeleteLogStream', 'PutRetentionPolicy', 'DeleteRetentionPolicy', 'PutSubscriptionFilter',
    'DeleteSubscriptionFilter', 'AssociateKmsKey', 'DisassociateKmsKey', 'PutMetricFilter', 'DeleteMetricFilter',
    'PutDataProtectionPolicy', 'DeleteDataProtectionPolicy',
  ],
  'events.amazonaws.com': ['PutRule', 'EnableRule', 'DisableRule', 'DeleteRule', 'PutTargets', 'RemoveTargets'],
  'guardduty.amazonaws.com': [
    'DeleteDetector', 'UpdateDetector', 'CreateFilter', 'UpdateFilter', 'DeleteFilter', 'CreateIPSet', 'UpdateIPSet',
    'UpdatePublishingDestination', 'DeletePublishingDestination', 'DisassociateFromMasterAccount',
    'DisassociateFromAdministratorAccount', 'UpdateMalwareScanSettings', 'ArchiveFindings',
  ],
  'securityhub.amazonaws.com': [
    'DisableSecurityHub', 'BatchDisableStandards', 'UpdateStandardsControl', 'BatchUpdateStandardsControlAssociations',
    'DisableImportFindingsForProduct', 'CreateAutomationRule', 'BatchUpdateAutomationRules', 'BatchDeleteAutomationRules',
    'UpdateSecurityHubConfiguration',
  ],
  'config.amazonaws.com': [
    'StopConfigurationRecorder', 'DeleteConfigurationRecorder', 'PutConfigurationRecorder', 'DeleteDeliveryChannel',
    'PutDeliveryChannel',
  ],
  'sns.amazonaws.com': [
    'DeleteTopic', 'SetTopicAttributes', 'Subscribe', 'Unsubscribe', 'SetSubscriptionAttributes', 'AddPermission',
    'RemovePermission', 'PutDataProtectionPolicy',
  ],
  // CloudWatch alarms: their definition, actions, state and mute rules.
  'monitoring.amazonaws.com': [
    'PutMetricAlarm', 'PutCompositeAlarm', 'DeleteAlarms', 'DisableAlarmActions', 'EnableAlarmActions', 'SetAlarmState',
    'PutAlarmMuteRule',
  ],
  // Queues: their attributes and policy, their messages and their existence.
  'sqs.amazonaws.com': ['SetQueueAttributes', 'PurgeQueue', 'DeleteQueue', 'AddPermission', 'RemovePermission', 'StartMessageMoveTask'],
} as const;

/** Lambda records versioned event names (`UpdateFunctionCode20150331v2`); these are the prefixes. */
export const AUDIT_FUNCTION_EVENT_PREFIXES = [
  'UpdateFunctionCode', 'UpdateFunctionConfiguration', 'DeleteFunction', 'PutFunctionConcurrency',
  'DeleteFunctionConcurrency', 'AddPermission', 'RemovePermission', 'PutFunctionEventInvokeConfig',
  'UpdateFunctionEventInvokeConfig', 'DeleteFunctionEventInvokeConfig',
] as const;

/**
 * Publishing a version, and creating, changing or deleting an alias: on an
 * audit function, a change to what runs under its name. Lambda's versioned
 * event names, exactly as the AWS Lambda Developer Guide lists them ("Logging
 * AWS Lambda API calls using AWS CloudTrail").
 */
export const FUNCTION_VERSION_EVENTS = ['PublishVersion20150331', 'CreateAlias20150331', 'UpdateAlias20150331', 'DeleteAlias20150331'] as const;

/**
 * The calls whose request names a function's execution role (same source).
 * Passing a role records no IAM event of its own, so the role is read from
 * these: a function created with the export job's role, or given it, runs
 * code that can write what only that role may write.
 */
export const FUNCTION_ROLE_EVENTS = ['CreateFunction20150331', 'UpdateFunctionConfiguration20150331v2'] as const;

export const ROLE_ASSUMPTION_EVENTS = ['AssumeRole', 'AssumeRoleWithSAML', 'AssumeRoleWithWebIdentity'] as const;

/** The user-pool calls that carry a password or a second factor. */
export const COGNITO_SIGN_IN_EVENTS = ['InitiateAuth', 'RespondToAuthChallenge'] as const;

// ── Principals ──────────────────────────────────────────────────────────

const CLOUDFORMATION = 'cloudformation.amazonaws.com';

/** The CDK bootstrap's CloudFormation execution role, through which deploys act. */
const DEPLOY_EXECUTION_ROLE = /^cdk-[a-z0-9]+-cfn-exec-role-\d{12}-[a-z0-9-]+$/;

/** An EC2 instance's role session is named after the instance. */
const EC2_INSTANCE_SESSION = /^i-[0-9a-f]{8,17}$/;

const IAM_READ = /^(Get|List|Generate|Simulate)/;

/** The audit log group CloudWatch receives the engine log in (window deploy 2). */
const ENGINE_LOG_GROUP = /^\/aws\/rds\/instance\/[^/]+\/postgresql$/;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A field value as it may appear in an alert: printable, bounded. */
function safe(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256);
}

function issuerRoleName(detail: Json): string | undefined {
  const identity = detail.userIdentity ?? {};
  return identity.type === 'AssumedRole' ? str(identity.sessionContext?.sessionIssuer?.userName) : undefined;
}

/** The session part of an assumed role's ARN. */
function sessionName(detail: Json): string | undefined {
  const arn = str(detail.userIdentity?.arn);
  const match = arn ? /:assumed-role\/[^/]+\/(.+)$/.exec(arn) : null;
  return match?.[1];
}

/** The app stack whose generated names start a name, exactly. */
function appStackOf(name: string | undefined, config: SentinelConfig): string | undefined {
  if (!name) return undefined;
  return config.appStacks.filter((stack) => name.startsWith(`${stack}-`)).sort((a, b) => b.length - a.length)[0];
}

/**
 * An app function's role, in that function's own session: CloudFormation
 * prefixes both the role and the function name with their stack's name, and
 * Lambda names an execution role's session after the function.
 */
function isAppFunctionRole(detail: Json, config: SentinelConfig): boolean {
  const stack = appStackOf(issuerRoleName(detail), config);
  const session = sessionName(detail);
  if (stack === undefined || session === undefined) return false;
  if (session.startsWith(`${stack}-`)) return true;
  // A function with a fixed name: its exact name, under a role of its own stack.
  return config.fixedFunctions.some((f) => f.stack === stack && f.functionName === session);
}

/** The ops host's instance role, in the instance's own session. */
function isOpsHost(detail: Json, config: SentinelConfig): boolean {
  const role = issuerRoleName(detail);
  const session = sessionName(detail);
  return role !== undefined && role.startsWith(`${config.opsHostStack}-`) && session !== undefined && EC2_INSTANCE_SESSION.test(session);
}

/** A deploy: CloudFormation acting through the bootstrap execution role. */
function isDeployExecution(detail: Json): boolean {
  const role = issuerRoleName(detail);
  return detail.userIdentity?.invokedBy === CLOUDFORMATION && role !== undefined && DEPLOY_EXECUTION_ROLE.test(role);
}

function principalType(detail: Json): string {
  const type = str(detail.userIdentity?.type);
  return type && /^[A-Za-z]+$/.test(type) ? type : 'Unknown';
}

function params(detail: Json): Json {
  return detail.requestParameters && typeof detail.requestParameters === 'object' ? detail.requestParameters : {};
}

// ── Archive keys ────────────────────────────────────────────────────────

function utcDay(time: unknown): string {
  const parsed = typeof time === 'string' ? Date.parse(time) : NaN;
  return new Date(Number.isNaN(parsed) ? Date.now() : parsed).toISOString().slice(0, 10);
}

function keyId(value: unknown): string {
  const text = str(value) ?? '';
  return /^[A-Za-z0-9-]{1,128}$/.test(text) ? text : 'unidentified';
}

function archiveKey(category: ArchiveCategory, time: unknown, id: unknown): string {
  return `findings/${category}/dt=${utcDay(time)}/${keyId(id)}.json.gz`;
}

// ── Alerts ──────────────────────────────────────────────────────────────

const SUMMARIES: Record<AlertRule, string> = {
  root_use: 'The account root user was used.',
  secret_read: 'A secret was read by a principal that is not a Jale workload role.',
  secret_read_denied: 'A Jale workload role was refused a secret it has no rights to.',
  secret_change: 'A secret, its versions or its resource policy changed.',
  database_change: 'The database instance, its parameter groups or its snapshots changed.',
  identity_change: 'Roles, policies, users or access keys changed outside a deploy.',
  parameter_change: 'A Systems Manager parameter or the session preferences changed.',
  audit_system_change: 'The audit system itself changed: trail, archive, keys, log groups, rules, alarms, queues, detectors, alerts or '
    + "the audit roles and functions, including any function given the export job's role.",
  audit_role_assumed: 'An audit role was assumed.',
  console_sign_in_failed: 'A console sign-in failed.',
  guardduty_finding: 'GuardDuty reported a finding of medium severity or higher.',
  securityhub_finding: 'Security Hub reported a critical finding.',
  admin_sign_in_failed: "A sign-in to the admin dashboard's user pool failed.",
};

function compact(record: AlertRecord): AlertRecord {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as unknown as AlertRecord;
}

/** The alert for a CloudTrail event, with its archive record. */
function cloudTrailAlert(event: Json, detail: Json, rule: AlertRule, target?: unknown): Classification {
  const alert = compact({
    rule,
    summary: SUMMARIES[rule],
    eventSource: safe(detail.eventSource),
    eventName: safe(detail.eventName),
    eventTime: safe(detail.eventTime),
    awsRegion: safe(detail.awsRegion),
    eventId: safe(detail.eventID),
    principalType: principalType(detail),
    principalArn: safe(detail.userIdentity?.arn),
    invokedBy: safe(detail.userIdentity?.invokedBy),
    errorCode: safe(detail.errorCode),
    target: safe(target),
  });
  return {
    action: 'alert',
    alert,
    archive: { category: 'cloudtrail', key: archiveKey('cloudtrail', detail.eventTime, detail.eventID ?? event.id), body: { alert } },
  };
}

// ── Per-service rules ───────────────────────────────────────────────────

function has(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

function secretIdsOf(detail: Json): string[] {
  const p = params(detail);
  if (str(p.secretId)) return [p.secretId];
  if (Array.isArray(p.secretIdList)) return p.secretIdList.filter((s: unknown): s is string => typeof s === 'string');
  return [];
}

function secretIdOf(detail: Json): string | undefined {
  const ids = secretIdsOf(detail);
  return ids.length ? ids.join(',') : undefined;
}

/** A secret id as a name: an ARN's resource part, with its six-character suffix when the ARN is complete. */
const SECRET_ARN_PARTS = /^arn:[a-z-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:(.+)$/;

function isMasterSecret(secretId: string, config: SentinelConfig): boolean {
  const master = SECRET_ARN_PARTS.exec(config.masterSecretArn)?.[1];
  if (!master) return false;
  const masterName = master.replace(/-[A-Za-z0-9]{6}$/, '');
  const id = SECRET_ARN_PARTS.exec(secretId)?.[1] ?? secretId;
  return id === master || id === masterName;
}

/**
 * A personal login's secret, `jale/person-<handle>/db` (scripts/ops/person-login.sh
 * creates it under the person's own identity): the login-secret naming rule
 * applied to `jale_person_<handle>`. By name, or by ARN with Secrets Manager's
 * six-character suffix. Nothing else matches.
 */
const PERSONAL_SECRET_NAME = /^jale\/person-[a-z0-9]+(?:-[a-z0-9]+)*\/db$/;
const SECRET_ARN = /^arn:[a-z-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:(.+)-[A-Za-z0-9]{6}$/;

function isPersonalSecret(secretId: string | undefined): boolean {
  if (!secretId || secretId.includes(',')) return false;
  const name = secretId.startsWith('arn:') ? SECRET_ARN.exec(secretId)?.[1] : secretId;
  return name !== undefined && PERSONAL_SECRET_NAME.test(name);
}

function classifySecrets(event: Json, detail: Json, config: SentinelConfig): Classification {
  const name = detail.eventName;
  if (has(SECRET_CHANGE_EVENTS, name)) return cloudTrailAlert(event, detail, 'secret_change', secretIdOf(detail));
  if (!has(SECRET_READ_EVENTS, name)) return { action: 'ignore', reason: 'secret_other' };

  // The master secret: the ops host, and the deploy resolving
  // the master password for the instance.
  if (secretIdsOf(detail).some((id) => isMasterSecret(id, config))) {
    if (isOpsHost(detail, config)) return { action: 'expected', reason: 'ops_host' };
    if (isDeployExecution(detail)) return { action: 'expected', reason: 'cloudformation_master_password' };
    return cloudTrailAlert(event, detail, 'secret_read', secretIdOf(detail));
  }
  if (detail.userIdentity?.type === 'AWSService') return { action: 'expected', reason: 'aws_service' };
  if (isAppFunctionRole(detail, config)) {
    // An app function refused a secret: outside its grant.
    return detail.errorCode
      ? cloudTrailAlert(event, detail, 'secret_read_denied', secretIdOf(detail))
      : { action: 'expected', reason: 'app_function' };
  }
  if (isOpsHost(detail, config)) return { action: 'expected', reason: 'ops_host' };
  if (isPersonalSecret(secretIdOf(detail))) return { action: 'expected', reason: 'personal_login' };
  return cloudTrailAlert(event, detail, 'secret_read', secretIdOf(detail));
}

function classifyDatabase(event: Json, detail: Json): Classification {
  if (!has(DATABASE_EVENTS, detail.eventName)) return { action: 'ignore', reason: 'database_other' };
  const p = params(detail);
  return cloudTrailAlert(event, detail, 'database_change',
    p.dBInstanceIdentifier ?? p.dBParameterGroupName ?? p.dBSnapshotIdentifier ?? p.sourceDBSnapshotIdentifier);
}

/** A managed policy's name, from its ARN or its name parameter. */
function policyNameOf(p: Json): string | undefined {
  const arn = str(p.policyArn);
  if (arn) return /:policy\/(?:.*\/)?([^/]+)$/.exec(arn)?.[1];
  return str(p.policyName);
}

/**
 * A deploy's change to the app's own roles, instance profiles and managed
 * policies: made through the deploy execution role, on a name one of the
 * app's stacks generates (or a fixed policy name an app stack creates), and
 * touching no user, group or credential.
 */
function isAppDeployIdentityChange(detail: Json, config: SentinelConfig): boolean {
  if (!isDeployExecution(detail)) return false;
  const p = params(detail);
  if (p.userName !== undefined || p.groupName !== undefined) return false;
  if (str(p.roleName)) return appStackOf(p.roleName, config) !== undefined;
  if (str(p.instanceProfileName)) return appStackOf(p.instanceProfileName, config) !== undefined;
  const policy = policyNameOf(p);
  if (policy) return appStackOf(policy, config) !== undefined || config.deployPolicyNames.includes(policy);
  return false;
}

function classifyIdentity(event: Json, detail: Json, config: SentinelConfig): Classification {
  const name = str(detail.eventName) ?? '';
  if (IAM_READ.test(name)) return { action: 'ignore', reason: 'identity_read' };
  const p = params(detail);
  const target = p.roleName ?? p.userName ?? p.groupName ?? p.policyArn ?? p.policyName ?? p.instanceProfileName;
  if (has(config.auditRoleNames, p.roleName)) return cloudTrailAlert(event, detail, 'audit_system_change', p.roleName);
  if (name === 'CreateAccessKey') return cloudTrailAlert(event, detail, 'identity_change', target);
  if (isAppDeployIdentityChange(detail, config)) return { action: 'expected', reason: 'app_deploy' };
  return cloudTrailAlert(event, detail, 'identity_change', target);
}

function classifyParameters(event: Json, detail: Json): Classification {
  const p = params(detail);
  if (has(PARAMETER_EVENTS, detail.eventName)) {
    return cloudTrailAlert(event, detail, 'parameter_change', p.name ?? (Array.isArray(p.names) ? p.names.join(',') : undefined));
  }
  if (has(SESSION_PREFERENCE_EVENTS, detail.eventName) && p.name === SESSION_PREFERENCES_DOCUMENT) {
    return cloudTrailAlert(event, detail, 'parameter_change', p.name);
  }
  return { action: 'ignore', reason: 'parameter_other' };
}

function classifyRoleAssumption(event: Json, detail: Json, config: SentinelConfig): Classification {
  if (!has(ROLE_ASSUMPTION_EVENTS, detail.eventName)) return { action: 'ignore', reason: 'sts_other' };
  const roleArn = str(params(detail).roleArn);
  const isAuditRole = roleArn !== undefined && config.auditRoleNames.some((role) => roleArn.endsWith(`:role/${role}`));
  return isAuditRole ? cloudTrailAlert(event, detail, 'audit_role_assumed', roleArn) : { action: 'ignore', reason: 'sts_other_role' };
}

function logGroupNameOf(p: Json): string | undefined {
  const name = str(p.logGroupName);
  if (name) return name;
  const identifier = str(p.logGroupIdentifier);
  if (!identifier) return undefined;
  const marker = ':log-group:';
  const at = identifier.indexOf(marker);
  return (at >= 0 ? identifier.slice(at + marker.length) : identifier).replace(/:\*$/, '');
}

function functionNameOf(p: Json): string | undefined {
  const raw = str(p.functionName);
  if (!raw) return undefined;
  const marker = ':function:';
  const at = raw.indexOf(marker);
  return (at >= 0 ? raw.slice(at + marker.length) : raw).split(':')[0];
}

/**
 * The audit key or the alert topic's key, by its ARN, when the event names
 * either: by ARN, key id or alias, in its parameters or its resources.
 */
function auditSystemKeyOf(detail: Json, config: SentinelConfig): string | null {
  const p = params(detail);
  const ids = [p.keyId, p.targetKeyId, p.aliasName].filter((v): v is string => typeof v === 'string');
  const resources = resourceArns(detail);
  for (const [keyArn, alias] of [[config.auditKeyArn, config.auditKeyAlias], [config.alertKeyArn, config.alertKeyAlias]]) {
    const keySuffix = keyArn.split('/').pop();
    if (resources.includes(keyArn) || ids.some((id) => id === keyArn || id === keySuffix || id === alias || id.endsWith(`:${alias}`))) {
      return keyArn;
    }
  }
  return null;
}

/**
 * The strings in a request, depth-first and bounded: all of them, or only
 * those under a field whose name passes `field`, at any depth.
 */
function stringsIn(value: unknown, field: (name: string) => boolean = () => true, under = false, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || out.length >= 256) return out;
  if (typeof value === 'string') {
    if (under) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, field, under, depth + 1, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) stringsIn(item, field, under || field(name), depth + 1, out);
  }
  return out;
}

function resourceArns(detail: Json): string[] {
  return Array.isArray(detail.resources)
    ? detail.resources.map((r: Json) => r?.ARN).filter((v: unknown): v is string => typeof v === 'string')
    : [];
}

const ALARM_NAMES_FIELD = /^alarmnames?$/i;
const MUTE_TARGETS_FIELD = /^mutetargets$/i;

/**
 * An audit alarm the event names: by name in its alarm-name fields (a mute
 * rule's targets among them), or by ARN anywhere in the request or its
 * resources. A mute rule that names no alarm it can read may cover every
 * alarm, the audit ones included.
 */
function auditAlarmOf(detail: Json, config: SentinelConfig): string | null {
  const p = params(detail);
  const byArn = (text: string) => {
    const at = text.indexOf(':alarm:');
    return at >= 0 ? text.slice(at + ':alarm:'.length) : undefined;
  };
  const names = [
    ...stringsIn(p, (name) => ALARM_NAMES_FIELD.test(name)),
    ...[...stringsIn(p), ...resourceArns(detail)].map(byArn).filter((name): name is string => name !== undefined),
  ];
  const audit = names.find((name) => name.startsWith(config.auditAlarmPrefix));
  if (audit) return audit;
  if (detail.eventName === 'PutAlarmMuteRule') {
    const targets = Object.entries(p).filter(([name]) => MUTE_TARGETS_FIELD.test(name)).map(([, value]) => value);
    if (stringsIn(targets, (name) => ALARM_NAMES_FIELD.test(name)).length === 0) return `${config.auditAlarmPrefix}*`;
  }
  return null;
}

/** A queue's name, from its URL or its ARN. */
const QUEUE_URL = /^https:\/\/[^/]+\/[0-9]+\/([^/?#]+)$/;
const QUEUE_ARN = /^arn:[a-z-]+:sqs:[a-z0-9-]*:[0-9]*:([^:/]+)$/;

/** An audit queue the event names, by URL or ARN anywhere in the request or its resources, or by its name. */
function auditQueueOf(detail: Json, config: SentinelConfig): string | null {
  for (const text of [...stringsIn(params(detail)), ...resourceArns(detail)]) {
    const name = QUEUE_URL.exec(text)?.[1] ?? QUEUE_ARN.exec(text)?.[1] ?? text;
    if (config.auditQueueNames.includes(name)) return name;
  }
  return null;
}

function auditTargetOf(source: string, detail: Json, config: SentinelConfig): string | null {
  const p = params(detail);
  switch (source) {
    case 'cloudtrail.amazonaws.com':
    case 'guardduty.amazonaws.com':
    case 'securityhub.amazonaws.com':
    case 'config.amazonaws.com':
      return str(p.name) ?? str(p.detectorId) ?? str(p.configurationRecorderName) ?? str(p.deliveryChannelName) ?? source;
    case 's3.amazonaws.com': {
      const bucket = str(p.bucketName);
      return bucket && bucket.startsWith(config.auditBucketPrefix) ? bucket : null;
    }
    case 'kms.amazonaws.com':
      return auditSystemKeyOf(detail, config);
    case 'logs.amazonaws.com': {
      const group = logGroupNameOf(p);
      return group && (config.auditLogGroups.includes(group) || ENGINE_LOG_GROUP.test(group)) ? group : null;
    }
    case 'events.amazonaws.com': {
      const rule = str(p.name) ?? str(p.rule);
      return rule && rule.startsWith(config.auditRulePrefix) ? rule : null;
    }
    case 'sns.amazonaws.com': {
      const topic = str(p.topicArn);
      const subscription = str(p.subscriptionArn);
      if (topic === config.alertTopicArn) return topic;
      return subscription && subscription.startsWith(`${config.alertTopicArn}:`) ? config.alertTopicArn : null;
    }
    case 'monitoring.amazonaws.com':
      return auditAlarmOf(detail, config);
    case 'sqs.amazonaws.com':
      return auditQueueOf(detail, config);
    default:
      return null;
  }
}

function classifyAuditSystem(event: Json, detail: Json, config: SentinelConfig): Classification {
  const source = detail.eventSource as keyof typeof AUDIT_SYSTEM_EVENTS;
  if (!has(AUDIT_SYSTEM_EVENTS[source], detail.eventName)) return { action: 'ignore', reason: 'audit_service_other' };
  const target = auditTargetOf(source, detail, config);
  return target === null
    ? { action: 'ignore', reason: 'outside_audit_system' }
    : cloudTrailAlert(event, detail, 'audit_system_change', target);
}

/** A role ARN's name: what follows its last slash, whatever the path. */
function roleNameOf(value: unknown): string | undefined {
  const text = str(value)?.replace(/\/+$/, '');
  if (!text) return undefined;
  const name = text.slice(text.lastIndexOf('/') + 1);
  return name.length > 0 ? name : undefined;
}

/**
 * Whether a call gives a function the export job's role. Role names are
 * unique in an account whatever their case, so the case is ignored.
 */
function givesExportRole(detail: Json, config: SentinelConfig): boolean {
  if (!has(FUNCTION_ROLE_EVENTS, detail.eventName)) return false;
  const role = roleNameOf(params(detail).role);
  return role !== undefined && role.toLowerCase() === config.exportRoleName.toLowerCase();
}

/**
 * Lambda events, through two checks in this order. Each alerts whoever made
 * the call, the deploy included:
 *   - a change to an audit function (its code, configuration, permissions,
 *     concurrency, versions or aliases) alerts, naming the function;
 *   - any other function created with the export job's role, or given it,
 *     alerts, naming the role.
 * The second only adds alerts: it cannot stand in for the first.
 */
function classifyFunctions(event: Json, detail: Json, config: SentinelConfig): Classification {
  const name = str(detail.eventName) ?? '';
  const p = params(detail);
  const changesAFunction = AUDIT_FUNCTION_EVENT_PREFIXES.some((prefix) => name.startsWith(prefix)) || has(FUNCTION_VERSION_EVENTS, name);
  const fn = functionNameOf(p);
  if (changesAFunction && fn !== undefined && config.auditFunctionNames.includes(fn)) {
    return cloudTrailAlert(event, detail, 'audit_system_change', fn);
  }
  if (givesExportRole(detail, config)) return cloudTrailAlert(event, detail, 'audit_system_change', p.role);
  return { action: 'ignore', reason: changesAFunction ? 'outside_audit_system' : 'lambda_other' };
}

function classifyApiCall(event: Json, detail: Json, config: SentinelConfig): Classification {
  if (detail.userIdentity?.type === 'Root') return cloudTrailAlert(event, detail, 'root_use');
  const source = str(detail.eventSource) ?? '';
  switch (source) {
    case 'secretsmanager.amazonaws.com': return classifySecrets(event, detail, config);
    case 'rds.amazonaws.com': return classifyDatabase(event, detail);
    case 'iam.amazonaws.com': return classifyIdentity(event, detail, config);
    case 'ssm.amazonaws.com': return classifyParameters(event, detail);
    case 'sts.amazonaws.com': return classifyRoleAssumption(event, detail, config);
    case 'lambda.amazonaws.com': return classifyFunctions(event, detail, config);
    case 'cognito-idp.amazonaws.com':
      return has(COGNITO_SIGN_IN_EVENTS, detail.eventName) && str(detail.errorCode)
        ? { action: 'cognito' }
        : { action: 'ignore', reason: 'user_pool_other' };
    default:
      return source in AUDIT_SYSTEM_EVENTS
        ? classifyAuditSystem(event, detail, config)
        : { action: 'ignore', reason: 'unrouted_source' };
  }
}

function classifySignIn(event: Json, detail: Json): Classification {
  if (detail.eventName !== 'ConsoleLogin') return { action: 'ignore', reason: 'sign_in_other' };
  if (detail.userIdentity?.type === 'Root') return cloudTrailAlert(event, detail, 'root_use');
  const failed = detail.responseElements?.ConsoleLogin === 'Failure' || detail.errorMessage !== undefined;
  return failed ? cloudTrailAlert(event, detail, 'console_sign_in_failed') : { action: 'expected', reason: 'console_sign_in' };
}

/** GuardDuty's numeric severity: 4 and above is medium or higher. */
const GUARDDUTY_ALERT_SEVERITY = 4;

function classifyGuardDuty(event: Json): Classification {
  const finding: Json = event.detail ?? {};
  const severity = Number(finding.severity);
  const archive: ArchiveRecord = {
    category: 'guardduty',
    key: archiveKey('guardduty', event.time, event.id),
    body: { classification: severity >= GUARDDUTY_ALERT_SEVERITY ? 'alert' : 'archive', finding },
  };
  if (!(severity >= GUARDDUTY_ALERT_SEVERITY)) return { action: 'archive', archive };
  const alert = compact({
    rule: 'guardduty_finding',
    summary: SUMMARIES.guardduty_finding,
    eventTime: safe(event.time),
    awsRegion: safe(event.region),
    eventId: safe(finding.id),
    principalType: 'finding',
    findingType: safe(finding.type),
    severity: String(severity),
    target: safe(finding.resource?.resourceType),
  });
  return { action: 'alert', alert, archive: { ...archive, body: { ...archive.body, alert } } };
}

/**
 * Whether a Security Hub finding alerts: CRITICAL, still active and not
 * suppressed, and a control that FAILED or no compliance status at all (a
 * finding that is not a control's). A CRITICAL control that PASSED, or
 * reports WARNING or NOT_AVAILABLE, does not; nor does a finding whose record
 * state is ARCHIVED or whose workflow status is SUPPRESSED.
 */
function securityHubFindingAlerts(finding: Json): boolean {
  if (finding?.Severity?.Label !== 'CRITICAL') return false;
  if (finding?.RecordState === 'ARCHIVED' || finding?.Workflow?.Status === 'SUPPRESSED') return false;
  const status = str(finding?.Compliance?.Status);
  return status === undefined || status === 'FAILED';
}

/**
 * Where a finding's alert is recorded: the SHA-256 of its Id, compliance
 * status and severity label (`NONE` for an absent one), so every import of the
 * same state finds the same record, and the key never carries the Id itself.
 * Undefined for a finding with no Id.
 */
function securityHubStateKey(finding: Json): string | undefined {
  const id = str(finding?.Id);
  if (!id) return undefined;
  const state = [id, str(finding?.Compliance?.Status) ?? 'NONE', str(finding?.Severity?.Label) ?? 'NONE'].join('|');
  return `findings/securityhub-state/${createHash('sha256').update(state, 'utf8').digest('hex')}.json.gz`;
}

/**
 * Security Hub re-imports an active finding at every evaluation, each time in
 * a new event, so an alerting finding (securityHubFindingAlerts: CRITICAL,
 * active, not suppressed, FAILED or with no compliance status) is recorded by
 * its state, not its event: an alert per (Id, compliance status, severity). A
 * re-import of a state finds its record and stops; a new status or severity
 * alerts once. A state already recorded never alerts again, so a control that
 * fails again after passing finds its earlier FAILED record and stays quiet:
 * the records are written once and cannot hold a latest state. An event
 * carrying several alerting findings alerts on the first of them only; an
 * import event normally carries one finding. The alert names the EventBridge
 * event, never the finding's Id. A finding that does not alert, an archived or
 * suppressed one included, is archived under its event with the findings.
 */
function classifySecurityHub(event: Json): Classification {
  const findings: Json[] = Array.isArray(event.detail?.findings) ? event.detail.findings : [];
  const alerting = findings.find(securityHubFindingAlerts);
  if (!alerting) {
    return {
      action: 'archive',
      archive: { category: 'securityhub', key: archiveKey('securityhub', event.time, event.id), body: { classification: 'archive', findings } },
    };
  }
  const alert = compact({
    rule: 'securityhub_finding',
    summary: SUMMARIES.securityhub_finding,
    eventTime: safe(event.time),
    awsRegion: safe(event.region),
    eventId: safe(event.id),
    principalType: 'finding',
    findingType: safe(alerting.Title),
    severity: 'CRITICAL',
    target: safe(alerting.Resources?.[0]?.Type),
  });
  return {
    action: 'alert',
    alert,
    archive: {
      category: 'securityhub',
      key: securityHubStateKey(alerting) ?? archiveKey('securityhub', event.time, event.id),
      body: { classification: 'alert', alert },
    },
  };
}

/** What the sentinel does with one EventBridge event. */
export function classifyEvent(event: Json, config: SentinelConfig): Classification {
  const detail: Json = event?.detail && typeof event.detail === 'object' ? event.detail : {};
  switch (event?.['detail-type']) {
    case 'AWS API Call via CloudTrail': return classifyApiCall(event, detail, config);
    case 'AWS Console Sign In via CloudTrail': return classifySignIn(event, detail);
    case 'GuardDuty Finding': return classifyGuardDuty(event);
    case 'Security Hub Findings - Imported': return classifySecurityHub(event);
    default: return { action: 'ignore', reason: 'unrouted_detail_type' };
  }
}

// ── Admin sign-in failures ──────────────────────────────────────────────
//
// Admins' failed passwords and second factors happen between the browser and
// Cognito, so CloudTrail is their only record. A failure is the admin pool's
// when the event names that pool, or, when it names no pool, when it names one
// of that pool's app clients: a browser's sign-in calls name their app client
// (`requestParameters.clientId`) and no pool, a remembered browser's device
// step included. The admin pool's failures alert with codes only (the error,
// and the auth flow and challenge as Cognito's own codes), never the client
// id, the user's sub, the session or a device key; nothing of another pool's
// is kept (personal data). A failure that names neither a pool nor a
// client is counted by the handler (AuditCognitoEventUnattributed).

const USER_POOL_ARN = /:userpool\/([\w-]+_[0-9A-Za-z]+)$/;
const USER_POOL_ID = /^[\w-]+_[0-9A-Za-z]+$/;
/** Cognito app client ids are lowercase letters and digits. */
const APP_CLIENT_ID = /^[0-9a-z]{1,128}$/;

/** Cognito's auth flows (AuthFlowType), the only values an alert's `authFlow` takes besides `other`. */
export const COGNITO_AUTH_FLOWS = [
  'ADMIN_NO_SRP_AUTH', 'ADMIN_USER_PASSWORD_AUTH', 'CUSTOM_AUTH', 'REFRESH_TOKEN', 'REFRESH_TOKEN_AUTH', 'USER_AUTH',
  'USER_PASSWORD_AUTH', 'USER_SRP_AUTH',
] as const;

/** Cognito's challenges (ChallengeNameType), the only values an alert's `challengeName` takes besides `other`. */
export const COGNITO_CHALLENGE_NAMES = [
  'ADMIN_NO_SRP_AUTH', 'CUSTOM_CHALLENGE', 'DEVICE_PASSWORD_VERIFIER', 'DEVICE_SRP_AUTH', 'EMAIL_OTP', 'MFA_SETUP',
  'NEW_PASSWORD_REQUIRED', 'PASSWORD', 'PASSWORD_SRP', 'PASSWORD_VERIFIER', 'SELECT_CHALLENGE', 'SELECT_MFA_TYPE', 'SMS_MFA',
  'SMS_OTP', 'SOFTWARE_TOKEN_MFA', 'WEB_AUTHN',
] as const;

/**
 * A request value as a code from a fixed list: the value when the list holds
 * it exactly, `other` for anything else, and undefined when the request has
 * no such value. Never the value itself when it is not in the list.
 */
function codeFrom(list: readonly string[], value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && list.includes(value) ? value : 'other';
}

/**
 * The user pool a Cognito event names, or null when it names none. A
 * browser's sign-in calls name their app client instead (cognitoClientIdOf).
 */
export function cognitoPoolIdOf(detail: Json): string | null {
  const candidates = [detail?.additionalEventData?.userPoolId, detail?.requestParameters?.userPoolId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && USER_POOL_ID.test(candidate)) return candidate;
  }
  const resources: Json[] = Array.isArray(detail?.resources) ? detail.resources : [];
  for (const resource of resources) {
    const match = typeof resource?.ARN === 'string' ? USER_POOL_ARN.exec(resource.ARN) : null;
    if (match) return match[1];
  }
  return null;
}

/** The app client a Cognito event names (`requestParameters.clientId`), or null when it names none in Cognito's form. */
export function cognitoClientIdOf(detail: Json): string | null {
  const candidate = detail?.requestParameters?.clientId;
  return typeof candidate === 'string' && APP_CLIENT_ID.test(candidate) ? candidate : null;
}

/**
 * A failed sign-in, given the admin pool's id and its app clients: an alert
 * carrying codes only (no subject, no client, no address, no request), or a
 * drop. Its auth flow and challenge are named by Cognito's own codes, so a
 * refused refresh token reads apart from a wrong password (both fail with
 * NotAuthorizedException). An event that names a pool is the admin pool's only when that pool is
 * the admin pool, whatever client it names; an event that names no pool is
 * the admin pool's when its app client is one of the admin pool's.
 */
export function classifyCognitoFailure(
  event: Json,
  adminPoolId: string,
  adminClientIds: ReadonlySet<string>,
): { action: 'alert'; alert: AlertRecord; archive: ArchiveRecord } | { action: 'drop' } {
  const detail: Json = event?.detail && typeof event.detail === 'object' ? event.detail : {};
  if (!has(COGNITO_SIGN_IN_EVENTS, detail.eventName) || !str(detail.errorCode)) return { action: 'drop' };
  const poolId = cognitoPoolIdOf(detail);
  const clientId = cognitoClientIdOf(detail);
  const inAdminPool = poolId !== null ? poolId === adminPoolId : clientId !== null && adminClientIds.has(clientId);
  if (!inAdminPool) return { action: 'drop' };
  const alert = compact({
    rule: 'admin_sign_in_failed',
    summary: SUMMARIES.admin_sign_in_failed,
    eventSource: safe(detail.eventSource),
    eventName: safe(detail.eventName),
    eventTime: safe(detail.eventTime),
    awsRegion: safe(detail.awsRegion),
    eventId: safe(detail.eventID),
    principalType: principalType(detail),
    errorCode: safe(detail.errorCode),
    authFlow: codeFrom(COGNITO_AUTH_FLOWS, params(detail).authFlow),
    challengeName: codeFrom(COGNITO_CHALLENGE_NAMES, params(detail).challengeName),
    poolMatch: true,
  });
  return {
    action: 'alert',
    alert,
    archive: { category: 'cognito', key: archiveKey('cognito', detail.eventTime, detail.eventID ?? event.id), body: { alert } },
  };
}
