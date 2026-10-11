import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as config from 'aws-cdk-lib/aws-config';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { dedicatedDbLogin } from '../constructs/db-login-secrets';
import { DB_POSTURE_GATE_POLICY_NAME } from '../constructs/db-posture-check';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { mainRoutes, ruleState, type RoutedFindings } from '../../lambda/ops/audit-sentinel-routes';
import { CLOUDWATCH_VALUE_PATTERNS, VALUE_KINDS } from '../../lambda/ops/audit-value-patterns';
import {
  AUDIT_NAMES,
  KEY_ADMIN_ACTIONS,
  PROTECTED_KEY_ACTIONS,
  accountRootPrincipal,
  auditBucketName,
  auditLogGroupArn,
  auditRoleArn,
} from './audit-archive-stack';
import { AUDIT_ROUTE_NAMES, EDGE_DEAD_LETTER_QUEUE, auditEdgeRegions, cdkEventPattern } from './audit-edge-stack';
import type { AuditEngineWindow } from './database-stack';
import type { NetworkStack } from './network-stack';
import { reportImagesBucketName } from './reports-stack';

/** Audit metrics' namespace. */
export const AUDIT_METRIC_NAMESPACE = 'Jale/Audit';

/**
 * The admin dashboard's user pool, by the fixed name AdminStack gives it. The
 * sentinel looks its id up by this name at run time, so this stack
 * needs no reference to AdminStack, which deploys after it.
 */
export const ADMIN_POOL_NAME = 'jale-admin-pool';

/** The export job's login (`prepare_secret` in the audit manifest fragment). */
export const AUDIT_EXPORT_LOGIN = 'jale_job_audit_export';

/** Where, in the query-results bucket, the weekly full verification keeps its progress. */
export const VERIFY_PROGRESS_PREFIX = 'export-state/';

/**
 * Writes and deletes of that progress, which only the export job's role may
 * make. A replication into the bucket writes too, so it is listed.
 */
export const VERIFY_PROGRESS_WRITE_ACTIONS = [
  's3:PutObject',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:ReplicateObject',
  's3:ReplicateDelete',
] as const;

/**
 * The detection services' context flags. Each takes `create` (this
 * stack creates and owns the service), `existing` (the account already runs
 * it; this stack only routes its findings) or `off`. Each is required in
 * production: a silent default could create a duplicate detector or skip a
 * protection, so synth fails without it. Outside production an unset flag
 * means `off`.
 */
export const SERVICE_MODE_FLAGS = ['guardDutyMode', 'securityHubMode', 'configMode'] as const;
export type ServiceModeFlag = (typeof SERVICE_MODE_FLAGS)[number];
export type ServiceMode = 'create' | 'existing' | 'off';

export function serviceMode(scope: Construct, flag: ServiceModeFlag): ServiceMode {
  const raw = scope.node.tryGetContext(flag);
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === undefined || value === null || value === '') {
    if (scope.node.tryGetContext('environment') === 'production') {
      throw new Error(`AUDIT_MODE_REQUIRED: pass -c ${flag}=create|existing|off (the pre-check decides which)`);
    }
    return 'off';
  }
  if (value !== 'create' && value !== 'existing' && value !== 'off') {
    throw new Error(`AUDIT_MODE_INVALID: ${flag} must be create, existing or off`);
  }
  return value;
}

/** The worker documents bucket, by its fixed name (DocumentsStack). */
export function documentsBucketName(): string {
  return `jale-worker-documents-${cdk.Aws.ACCOUNT_ID}`;
}

/** `arn:<partition>:s3:::<bucket>/`, the prefix a data-event selector matches object ARNs with. */
function objectArnPrefix(bucketName: string): string {
  return `arn:${cdk.Aws.PARTITION}:s3:::${bucketName}/`;
}

export interface AuditStackProps extends cdk.StackProps {
  readonly network: NetworkStack;
  /** The audit key's ARN, from JaleAuditArchiveStack: the one cross-stack value. */
  readonly auditKeyArn: string;
  /** The engine audit window (database-stack.ts). */
  readonly auditEngineWindow: AuditEngineWindow;
  /** The database instance's identifier; required from window 2, for the engine log group's name. */
  readonly dbInstanceIdentifier?: string;
  /** The database master secret's ARN, for the sentinel's master-secret rule (an identifier only; no grant). */
  readonly masterSecretArn: string;
}

/** The ops host's stack (BastionStack), whose instance role reads the database secrets. */
export const OPS_HOST_STACK = 'JaleBastionStack';

/** The environment variables that make a Lambda a database Lambda: one per pool getter. */
export const DB_SECRET_ENV_VARS = ['DB_SECRET_ARN', 'REFERRALS_DB_SECRET_ARN', 'MATCHING_DB_SECRET_ARN'] as const;

/** The variable the request and admin helpers read the fallback group's name from. */
export const AUDIT_FALLBACK_ENV = 'AUDIT_FALLBACK_LOG_GROUP';

/**
 * The environment variable names a function has been given so far. CDK keeps
 * them in a private map; reading it here, rather than resolving the rendered
 * template, leaves the function's lazily rendered environment untouched. A
 * CDK upgrade that changes the field fails here, loudly, instead of silently
 * skipping functions.
 */
function environmentKeys(fn: lambda.Function): string[] {
  const env = (fn as unknown as { environment?: { keys?: unknown } }).environment;
  if (!env || typeof env.keys !== 'function') {
    throw new Error('AUDIT_FALLBACK_WIRING: cannot read a function environment from this aws-cdk-lib');
  }
  const keys = [...(env.keys as () => Iterable<unknown>).call(env)];
  if (!keys.every((key): key is string => typeof key === 'string')) {
    throw new Error('AUDIT_FALLBACK_WIRING: cannot read a function environment from this aws-cdk-lib');
  }
  return keys;
}

/** True when `fn` connects to the database. */
export function isDatabaseFunction(fn: lambda.Function): boolean {
  const keys = environmentKeys(fn);
  return DB_SECRET_ENV_VARS.some((name) => keys.includes(name));
}

/**
 * Gives a database Lambda the fallback group: its name in
 * AUDIT_FALLBACK_LOG_GROUP, and CreateLogStream and PutLogEvents on that
 * group only. The ARN is built from the fixed name, never imported, so the
 * function's stack does not reference the audit stack.
 */
export function grantAuditFallback(fn: lambda.Function): void {
  fn.addEnvironment(AUDIT_FALLBACK_ENV, AUDIT_NAMES.fallbackLogGroup);
  fn.addToRolePolicy(new iam.PolicyStatement({
    sid: 'AuditFallbackWrite',
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: [`${auditLogGroupArn(fn, AUDIT_NAMES.fallbackLogGroup)}:*`],
  }));
}

/**
 * The ops host's grants on the ops-command group, for Run Command's output:
 * create a stream, put events, and describe the group's streams; describe
 * log groups, which has no narrower resource form. Never CreateLogGroup: a
 * missing group must not be recreated unencrypted under the stack's name.
 */
export function grantOpsCommandOutput(role: iam.IRole): void {
  const group = auditLogGroupArn(role, AUDIT_NAMES.opsCommandLogGroup);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'RunCommandOutputToTheOpsCommandGroup',
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
    resources: [group, `${group}:*`],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'RunCommandFindsLogGroups',
    actions: ['logs:DescribeLogGroups'],
    resources: ['*'],
  }));
}

/** The engine log group's name for an instance. */
export function engineLogGroupName(instanceIdentifier: string): string {
  return `/aws/rds/instance/${instanceIdentifier}/postgresql`;
}

/**
 * JaleAuditStack: everything of the audit system but the key
 * and the archive. It deploys right after JaleDatabaseStack, before every
 * stack whose functions write to the fallback group.
 *
 *   - the fallback and ops-command log groups (fixed names, audit key, 400
 *     days, kept), each subscribed to the sentinel and scanned by metric
 *     filters for value-shaped content;
 *   - the audit-alerts topic, encrypted with a key of its own so alerts go
 *     out whatever state the audit key is in, with no subscriptions: the
 *     operator adds the email subscriptions out of band;
 *   - AuditExport, the five-minute export job and its daily check, in the VPC
 *     as its own login, with reserved concurrency 1;
 *   - AuditSentinel, which archives the log groups, classifies routed events
 *     and alerts;
 *   - the trail, the EventBridge rules, the detection services (each behind
 *     its *Mode flag), the audit roles, Athena, and the alarms.
 *
 * Nothing account-specific is configured here: every name and ARN is built
 * from pseudo-parameters, and no principal, address or id reaches the
 * template.
 */
export class AuditStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;
  public readonly alertKey: kms.Key;
  public readonly fallbackLogGroup: logs.LogGroup;
  public readonly opsCommandLogGroup: logs.LogGroup;
  public readonly sentinel: JaleLambdaFunction;
  public readonly exportJob: JaleLambdaFunction;
  public readonly engineLogGroup?: logs.LogGroup;

  constructor(scope: Construct, id: string, props: AuditStackProps) {
    super(scope, id, props);

    const guardDutyMode = serviceMode(this, 'guardDutyMode');
    const securityHubMode = serviceMode(this, 'securityHubMode');
    const configMode = serviceMode(this, 'configMode');
    if (securityHubMode !== 'off' && configMode === 'off') {
      throw new Error('AUDIT_MODE_INVALID: Security Hub needs an AWS Config recorder; configMode cannot be off');
    }
    const routedFindings: RoutedFindings = { guardDutyFindings: guardDutyMode !== 'off', securityHubFindings: securityHubMode !== 'off' };

    if (cdk.Token.isUnresolved(this.region)) throw new Error('AUDIT_MAIN_REGION: the audit stack needs a concrete main region');
    const edgeRegions = auditEdgeRegions(this.region);
    const edgeDeadLetterArn = (region: string) => `arn:${cdk.Aws.PARTITION}:sqs:${region}:${cdk.Aws.ACCOUNT_ID}:${EDGE_DEAD_LETTER_QUEUE}`;
    const key = kms.Key.fromKeyArn(this, 'AuditKey', props.auditKeyArn);
    const archiveName = auditBucketName('archive');
    const archive = s3.Bucket.fromBucketName(this, 'Archive', archiveName);

    // ── Log groups and the alert topic ──────────────────────────────────
    const auditLogGroup = (logicalId: string, logGroupName: string): logs.LogGroup => new logs.LogGroup(this, logicalId, {
      logGroupName,
      encryptionKey: key,
      retention: logs.RetentionDays.THIRTEEN_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.fallbackLogGroup = auditLogGroup('FallbackLogGroup', AUDIT_NAMES.fallbackLogGroup);
    this.opsCommandLogGroup = auditLogGroup('OpsCommandLogGroup', AUDIT_NAMES.opsCommandLogGroup);

    // The alert topic's own key. The alarms and the sentinel publish with it,
    // so alerts, including those about the audit key, go out whatever state
    // the audit key is in. Its policy keeps the account root and names the
    // audit-admin role as key administrator; only that role may disable it
    // or schedule its deletion, so it is kept when its stack is deleted.
    // No rule targets the topic: the routes and the daily check target the
    // sentinel, and the export schedules the export job. So EventBridge has no
    // grant on the key; a rule that ever targets the topic adds its own.
    const adminRoleArn = auditRoleArn(AUDIT_NAMES.adminRole);
    this.alertKey = new kms.Key(this, 'AlertKey', {
      alias: AUDIT_NAMES.alertKeyAlias,
      description: 'Audit alerts topic',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({ principals: [accountRootPrincipal()], actions: ['kms:*'], resources: ['*'] })],
      }),
    });
    this.alertKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AuditAdminKeyAdministration',
      principals: [accountRootPrincipal()],
      actions: [...KEY_ADMIN_ACTIONS],
      resources: ['*'],
      conditions: { ArnEquals: { 'aws:PrincipalArn': adminRoleArn } },
    }));
    // CloudWatch alarms publish to the topic: this account's alarms only.
    this.alertKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AlarmsPublishToTheAlertTopic',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': `arn:${cdk.Aws.PARTITION}:cloudwatch:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:alarm:*` },
      },
    }));
    this.alertKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyTheAuditAdminDisablesOrDeletesTheKey',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: [...PROTECTED_KEY_ACTIONS],
      resources: ['*'],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': adminRoleArn } },
    }));

    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: AUDIT_NAMES.alertTopic,
      displayName: 'Jale audit alerts',
      masterKey: this.alertKey,
      enforceSSL: true,
    });
    // The topic's own policy replaces the default one, so the alarms'
    // publishing is allowed explicitly, scoped to this account's alarms.
    this.alertTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AlarmsPublish',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.alertTopic.topicArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': `arn:${cdk.Aws.PARTITION}:cloudwatch:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:alarm:*` },
        StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
      },
    }));
    const alarmAction = new cloudwatchActions.SnsAction(this.alertTopic);
    const alarm = (logicalId: string, alarmProps: cloudwatch.AlarmProps): cloudwatch.Alarm => {
      const created = new cloudwatch.Alarm(this, logicalId, alarmProps);
      created.addAlarmAction(alarmAction);
      return created;
    };
    const auditMetric = (metricName: string, statistic: string, period: cdk.Duration): cloudwatch.Metric =>
      new cloudwatch.Metric({ namespace: AUDIT_METRIC_NAMESPACE, metricName, statistic, period });
    const anyAbove0 = (logicalId: string, alarmName: string, metricName: string, period: cdk.Duration, description: string) =>
      alarm(logicalId, {
        alarmName,
        alarmDescription: description,
        metric: auditMetric(metricName, 'Sum', period),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    // ── The sentinel ────────────────────────────────────────────────────
    const deadLetters = new sqs.Queue(this, 'SentinelDeadLetters', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    // Every rule that targets the sentinel dead-letters here. CDK's event
    // targets add one queue-policy statement per rule, and SQS refuses a queue
    // policy over 8,192 bytes: at 26 statements the stack's create failed. So
    // the rules name the queue directly (deadLetterTo) and one statement admits
    // them all, each by its exact ARN.
    const deadLetteredRules: events.Rule[] = [];
    const deadLetterTo = (rule: events.Rule): events.Rule => {
      (rule.node.defaultChild as events.CfnRule).addPropertyOverride('Targets.0.DeadLetterConfig.Arn', deadLetters.queueArn);
      deadLetteredRules.push(rule);
      return rule;
    };
    deadLetters.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AuditRulesSendUndeliveredEvents',
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [deadLetters.queueArn],
      conditions: { ArnEquals: { 'aws:SourceArn': cdk.Lazy.list({ produce: () => deadLetteredRules.map((r) => r.ruleArn) }) } },
    }));

    this.exportJob = new JaleLambdaFunction(this, 'AuditExport', {
      entry: path.join(__dirname, '../../lambda/ops/audit-export.ts'),
      description: 'Copies the database audit records to the archive; daily chain check, comparison and purge',
      vpc: props.network.vpc,
      securityGroups: [props.network.lambdaSg],
      timeout: 600,
      memorySize: 1024,
      retryAttempts: 0,
      reservedConcurrentExecutions: 1,
      environment: {
        AUDIT_ARCHIVE_BUCKET: archiveName,
        AUDIT_TRAIL_PREFIX: `cloudtrail/AWSLogs/${cdk.Aws.ACCOUNT_ID}/CloudTrail/${cdk.Aws.REGION}/`,
        // The weekly full verification keeps its progress here, outside the archive.
        AUDIT_STATE_BUCKET: auditBucketName('query-results'),
      },
    });

    this.sentinel = new JaleLambdaFunction(this, 'AuditSentinel', {
      entry: path.join(__dirname, '../../lambda/ops/audit-sentinel.ts'),
      description: 'Archives the audit log groups and findings; alerts on risky actions',
      timeout: 60,
      deadLetterQueue: deadLetters,
      environment: {
        AUDIT_ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        AUDIT_ARCHIVE_BUCKET: archiveName,
        AUDIT_KEY_ARN: props.auditKeyArn,
        AUDIT_KEY_ALIAS: AUDIT_NAMES.keyAlias,
        AUDIT_ALERT_KEY_ARN: this.alertKey.keyArn,
        AUDIT_ALERT_KEY_ALIAS: AUDIT_NAMES.alertKeyAlias,
        AUDIT_BUCKET_PREFIX: AUDIT_NAMES.bucketPrefix,
        AUDIT_LOG_SOURCES: JSON.stringify({
          [AUDIT_NAMES.fallbackLogGroup]: 'fallback',
          [AUDIT_NAMES.opsCommandLogGroup]: 'ops-command',
        }),
        AUDIT_RULE_PREFIX: AUDIT_NAMES.rulePrefix,
        // Every audit alarm's name starts with this, here and in the edge stacks.
        AUDIT_ALARM_PREFIX: 'JaleAudit',
        AUDIT_ROLE_NAMES: [AUDIT_NAMES.readerRole, AUDIT_NAMES.adminRole].join(','),
        AUDIT_FUNCTION_NAMES: this.exportJob.function.functionName,
        AUDIT_EXPORT_ROLE_NAME: this.exportJob.function.role!.roleName,
        AUDIT_ADMIN_POOL_NAME: ADMIN_POOL_NAME,
        AUDIT_MASTER_SECRET_ARN: props.masterSecretArn,
        AUDIT_OPS_HOST_STACK: OPS_HOST_STACK,
        AUDIT_DEPLOY_POLICIES: DB_POSTURE_GATE_POLICY_NAME,
        AUDIT_EDGE_REGIONS: edgeRegions.join(','),
        AUDIT_MAIN_BUS_ARN: `arn:${cdk.Aws.PARTITION}:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:event-bus/default`,
        // The daily check reads the main region's routes too: each targets
        // this function with this queue, and the findings routes exist only
        // for the services that are on.
        AUDIT_SENTINEL_DEAD_LETTER_ARN: deadLetters.queueArn,
        AUDIT_ROUTED_FINDINGS: [
          ...(routedFindings.guardDutyFindings ? ['guardduty'] : []),
          ...(routedFindings.securityHubFindings ? ['securityhub'] : []),
        ].join(',') || 'none',
        AUDIT_EDGE_DLQ_ARNS: cdk.Fn.join('', [
          '{',
          cdk.Fn.join(',', edgeRegions.map((region) => `"${region}":"${edgeDeadLetterArn(region)}"`)),
          '}',
        ]),
      },
    });
    const sentinelFn = this.sentinel.function;
    this.alertTopic.grantPublish(sentinelFn);
    sentinelFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ArchiveLogsAndFindings',
      actions: ['s3:PutObject'],
      resources: [archive.arnForObjects('logs/*'), archive.arnForObjects('findings/*')],
      conditions: { Null: { 's3:if-none-match': 'false' } },
    }));
    sentinelFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CheckFindingsAlreadyRecorded',
      actions: ['s3:GetObject'],
      resources: [archive.arnForObjects('findings/*')],
    }));
    // Without ListBucket, S3 answers a HEAD for a missing key with 403
    // instead of 404, and the duplicate check before each alert would fail.
    // A HEAD carries no prefix, so the grant cannot be narrowed to findings/.
    sentinelFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'MissingFindingsAnswerNotFound',
      actions: ['s3:ListBucket'],
      resources: [archive.bucketArn],
    }));
    // ListUserPools has no resource form; it returns pool names and ids only.
    // The daily check reads, and only reads, the audit rules in the main
    // region, and each edge region's rules and queue.
    sentinelFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadTheMainRegionRules',
      actions: ['events:DescribeRule', 'events:ListTargetsByRule'],
      resources: [`arn:${cdk.Aws.PARTITION}:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:rule/${AUDIT_NAMES.rulePrefix}*`],
    }));
    if (edgeRegions.length > 0) {
      sentinelFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ReadTheEdgeRules',
        actions: ['events:DescribeRule', 'events:ListTargetsByRule'],
        resources: edgeRegions.map((region) => `arn:${cdk.Aws.PARTITION}:events:${region}:${cdk.Aws.ACCOUNT_ID}:rule/${AUDIT_NAMES.rulePrefix}edge-*`),
      }));
      sentinelFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'ReadTheEdgeDeadLetterDepth',
        actions: ['sqs:GetQueueAttributes'],
        resources: edgeRegions.map(edgeDeadLetterArn),
      }));
    }
    sentinelFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'FindTheAdminPool',
      actions: ['cognito-idp:ListUserPools'],
      resources: ['*'],
    }));
    sentinelFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'UseTheAuditKey',
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [props.auditKeyArn],
    }));

    for (const [logicalId, group] of [['Fallback', this.fallbackLogGroup], ['OpsCommand', this.opsCommandLogGroup]] as const) {
      new logs.SubscriptionFilter(this, `${logicalId}ToSentinel`, {
        logGroup: group,
        destination: new logsDestinations.LambdaDestination(sentinelFn),
        filterPattern: logs.FilterPattern.allEvents(),
      });
    }

    // ── The export job's grants and schedules ───────────────────────────
    const exportFn = this.exportJob.function;
    const login = dedicatedDbLogin(this, AUDIT_EXPORT_LOGIN);
    for (const [name, value] of Object.entries(login.environment)) exportFn.addEnvironment(name, value);
    const loginRead = login.grantRead(exportFn);
    // db/ holds the export batches; checks/ the daily check's checkpoints.
    const exportBatches = [archive.arnForObjects('db/*'), archive.arnForObjects('checks/*')];
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'WriteExportBatchesOnce',
      actions: ['s3:PutObject'],
      resources: exportBatches,
      conditions: { Null: { 's3:if-none-match': 'false' } },
    }));
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadExportBatches',
      actions: ['s3:GetObject'],
      resources: exportBatches,
    }));
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ListExportBatchesAndTrailDelivery',
      actions: ['s3:ListBucket', 's3:ListBucketVersions'],
      resources: [archive.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['db/*', 'checks/*', 'cloudtrail/*'] } },
    }));
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'UseTheAuditKey',
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [props.auditKeyArn],
    }));
    new events.Rule(this, 'ExportSchedule', {
      ruleName: `${AUDIT_NAMES.rulePrefix}export`,
      description: 'Audit export, every five minutes',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(exportFn, { event: events.RuleTargetInput.fromObject({ mode: 'export' }), retryAttempts: 0 })],
    });
    // The full verification's progress: one object under export-state/ in the
    // query-results bucket (no Object Lock). ListBucket lets a missing object
    // read as not found.
    const resultsArn = `arn:${cdk.Aws.PARTITION}:s3:::${auditBucketName('query-results')}`;
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'FullVerifyProgress',
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [`${resultsArn}/export-state/*`],
    }));
    exportFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'FullVerifyProgressNotFound',
      actions: ['s3:ListBucket'],
      resources: [resultsArn],
    }));
    // The same rights, from the role's side. A function given this role, in
    // any region, would hold them. Lambda names the function whose code makes
    // a call in lambda:SourceFunctionArn, so the role may read its login's
    // secret, read and write the export batches, and write the progress only
    // from the export function itself; a call without the key is refused too,
    // since a negated operator matches an absent key. Left alone: KMS, which
    // S3 and Secrets Manager call on the function's behalf; the logs, tracing
    // and network calls the Lambda service makes with the role; and the
    // listings, which show keys only. It is a policy of its own: the
    // function's ARN in its default policy would make the function wait on
    // itself.
    const onlyFromTheExportFunction = (sid: string, actions: string[], resources: string[]) => new iam.PolicyStatement({
      sid,
      effect: iam.Effect.DENY,
      actions,
      resources,
      conditions: { ArnNotEquals: { 'lambda:SourceFunctionArn': exportFn.functionArn } },
    });
    new iam.Policy(this, 'ExportRoleOnlyFromTheExportFunction', {
      roles: [exportFn.role!],
      statements: [
        onlyFromTheExportFunction('OnlyTheExportFunctionWritesTheVerifyProgress', [...VERIFY_PROGRESS_WRITE_ACTIONS], [`${resultsArn}/${VERIFY_PROGRESS_PREFIX}*`]),
        // On the resource the read grant names.
        onlyFromTheExportFunction('OnlyTheExportFunctionReadsTheLoginSecret', ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          loginRead.principalStatements.flatMap((statement) => statement.resources)),
        onlyFromTheExportFunction('OnlyTheExportFunctionReadsAndWritesTheBatches', ['s3:PutObject', 's3:GetObject'], exportBatches),
      ],
    });
    new events.Rule(this, 'ExportFullVerifySchedule', {
      ruleName: `${AUDIT_NAMES.rulePrefix}export-full-verify`,
      description: 'Weekly full walk of the audit archive, continued hourly in bounded chunks',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new eventTargets.LambdaFunction(exportFn, {
        event: events.RuleTargetInput.fromObject({ mode: 'full-verify' }),
        retryAttempts: 8,
        maxEventAge: cdk.Duration.hours(1),
      })],
    });
    new events.Rule(this, 'ExportPurgeSchedule', {
      ruleName: `${AUDIT_NAMES.rulePrefix}export-purge`,
      description: 'Audit retention purge and trail delivery check, 03:40 UTC',
      schedule: events.Schedule.cron({ minute: '40', hour: '3' }),
      targets: [new eventTargets.LambdaFunction(exportFn, {
        event: events.RuleTargetInput.fromObject({ mode: 'purge' }),
        retryAttempts: 8,
        maxEventAge: cdk.Duration.hours(2),
      })],
    });
    new events.Rule(this, 'ExportDailySchedule', {
      ruleName: `${AUDIT_NAMES.rulePrefix}export-daily`,
      description: 'Audit export daily chain check and comparison, 03:10 UTC',
      schedule: events.Schedule.cron({ minute: '10', hour: '3' }),
      // Retried: with reserved concurrency 1, a five-minute run still in
      // progress at 03:10 throttles the daily one, which must not be lost.
      targets: [new eventTargets.LambdaFunction(exportFn, {
        event: events.RuleTargetInput.fromObject({ mode: 'daily' }),
        retryAttempts: 8,
        maxEventAge: cdk.Duration.hours(2),
      })],
    });

    // ── The trail ───────────────────────────────────────────────────────
    new cloudtrail.CfnTrail(this, 'Trail', {
      trailName: AUDIT_NAMES.trail,
      isLogging: true,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableLogFileValidation: true,
      kmsKeyId: props.auditKeyArn,
      s3BucketName: archiveName,
      s3KeyPrefix: 'cloudtrail',
      advancedEventSelectors: [
        {
          name: 'Every management event, read and write',
          fieldSelectors: [{ field: 'eventCategory', equalTo: ['Management'] }],
        },
        {
          name: 'Object reads on the documents, report images and archive buckets',
          fieldSelectors: [
            { field: 'eventCategory', equalTo: ['Data'] },
            { field: 'resources.type', equalTo: ['AWS::S3::Object'] },
            { field: 'eventName', equalTo: ['GetObject'] },
            {
              field: 'resources.ARN',
              startsWith: [
                objectArnPrefix(documentsBucketName()),
                objectArnPrefix(reportImagesBucketName()),
                objectArnPrefix(archiveName),
              ],
            },
          ],
        },
      ],
    });

    // ── Routing to the sentinel ─────────────────────────────────────────
    const toSentinel = new eventTargets.LambdaFunction(sentinelFn, { retryAttempts: 4 });
    // The routes come from one table (`lambda/ops/audit-sentinel-routes.ts`),
    // which the sentinel's daily check reads each deployed route against.
    for (const spec of mainRoutes(AUDIT_ROUTE_NAMES, routedFindings)) {
      const rule = deadLetterTo(new events.Rule(this, spec.id, {
        ruleName: spec.name,
        description: spec.description,
        eventPattern: cdkEventPattern(spec.pattern),
        targets: [toSentinel],
      }));
      // A rule in the default ENABLED state never matches read-only
      // management events; these rules route reads.
      if (spec.allManagementEvents) (rule.node.defaultChild as events.CfnRule).state = ruleState(true);
    }

    // ── Detection services ──────────────────────────────────────────────
    if (guardDutyMode === 'create') {
      new guardduty.CfnDetector(this, 'Detector', {
        enable: true,
        findingPublishingFrequency: 'FIFTEEN_MINUTES',
        features: [{ name: 'RDS_LOGIN_EVENTS', status: 'ENABLED' }],
      });
    }
    if (configMode === 'create') this.createConfigRecorder();
    if (securityHubMode === 'create') {
      const hub = new securityhub.CfnHub(this, 'SecurityHub', { enableDefaultStandards: false });
      const standard = new securityhub.CfnStandard(this, 'FoundationalBestPractices', {
        standardsArn: `arn:${cdk.Aws.PARTITION}:securityhub:${cdk.Aws.REGION}::standards/aws-foundational-security-best-practices/v/1.0.0`,
      });
      standard.addResourceDependency(hub);
    }

    // ── The audit roles ─────────────────────────────────────────────────
    const auditRole = (logicalId: string, roleName: string, tag: 'reader' | 'admin', description: string): iam.Role =>
      new iam.Role(this, logicalId, {
        roleName,
        description,
        maxSessionDuration: cdk.Duration.hours(1),
        assumedBy: accountRootPrincipal().withConditions({
          Bool: { 'aws:MultiFactorAuthPresent': 'true' },
          StringEquals: {
            [`aws:PrincipalTag/${AUDIT_NAMES.principalTag}`]: tag,
            // Assumed only where an assumption alerts: the main region and
            // the edge regions (an STS call is recorded in its endpoint's
            // region; the global endpoint is us-east-1).
            'aws:RequestedRegion': [this.region, ...edgeRegions],
          },
        }),
      });
    const reader = auditRole('AuditReaderRole', AUDIT_NAMES.readerRole, 'reader', 'Reads the audit archive through Athena');
    const admin = auditRole('AuditAdminRole', AUDIT_NAMES.adminRole, 'admin', 'Administers the audit archive: its rules, retention and key');
    this.grantReader(reader, archive, key);
    reader.addToPolicy(new iam.PolicyStatement({
      sid: 'LeaveTheFullVerifyProgressAlone',
      effect: iam.Effect.DENY,
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${auditBucketName('query-results')}/export-state/*`],
    }));
    admin.addToPolicy(new iam.PolicyStatement({
      sid: 'ArchiveRules',
      actions: [
        's3:GetBucketPolicy', 's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:GetLifecycleConfiguration',
        's3:PutLifecycleConfiguration', 's3:GetBucketVersioning', 's3:PutBucketVersioning',
        's3:GetBucketObjectLockConfiguration', 's3:PutBucketObjectLockConfiguration', 's3:ListBucket', 's3:ListBucketVersions',
      ],
      resources: [archive.bucketArn],
    }));
    admin.addToPolicy(new iam.PolicyStatement({
      sid: 'ArchiveRetention',
      actions: [
        's3:GetObjectRetention', 's3:PutObjectRetention', 's3:GetObjectLegalHold', 's3:PutObjectLegalHold',
        's3:BypassGovernanceRetention', 's3:DeleteObject', 's3:DeleteObjectVersion',
      ],
      resources: [archive.arnForObjects('*')],
    }));
    admin.addToPolicy(new iam.PolicyStatement({
      sid: 'AuditKeyAdministration',
      actions: [
        'kms:Describe*', 'kms:Get*', 'kms:List*', 'kms:PutKeyPolicy', 'kms:EnableKeyRotation', 'kms:TagResource',
        'kms:UntagResource', 'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion', 'kms:DisableKey', 'kms:EnableKey',
      ],
      resources: [props.auditKeyArn, this.alertKey.keyArn],
    }));

    // ── Engine log group (window deploy 2) ──────────────────────────────
    const valueScanned: Array<[string, logs.LogGroup, string]> = [
      ['Fallback', this.fallbackLogGroup, 'AuditFallbackValueHits'],
      ['OpsCommand', this.opsCommandLogGroup, 'AuditOpsCommandValueHits'],
    ];
    if (props.auditEngineWindow >= 2) {
      if (!props.dbInstanceIdentifier) throw new Error('AUDIT_ENGINE_WINDOW: the engine log group needs the instance identifier');
      this.engineLogGroup = auditLogGroup('EngineLogGroup', engineLogGroupName(props.dbInstanceIdentifier));
      new logs.SubscriptionFilter(this, 'EngineToSentinel', {
        logGroup: this.engineLogGroup,
        destination: new logsDestinations.LambdaDestination(sentinelFn),
        filterPattern: logs.FilterPattern.allEvents(),
      });
      valueScanned.push(['Engine', this.engineLogGroup, 'AuditEngineValueHits']);
    }

    // ── Value scan on the log groups ────────────────────────────────────
    for (const [label, group, metricName] of valueScanned) {
      for (const kind of VALUE_KINDS) {
        new logs.MetricFilter(this, `${label}${kind.charAt(0).toUpperCase()}${kind.slice(1)}Filter`, {
          logGroup: group,
          filterPattern: logs.FilterPattern.literal(CLOUDWATCH_VALUE_PATTERNS[kind]),
          metricNamespace: AUDIT_METRIC_NAMESPACE,
          metricName,
          metricValue: '1',
        });
      }
      anyAbove0(`${label}ValueHitsAlarm`, `JaleAudit${metricName.replace(/^Audit/, '')}`, metricName, cdk.Duration.minutes(5),
        'A line in an audit log group looks like it carries a phone number, an email address or a link. Engine '
        + 'lines during a migration window can carry self-check literals: check whether a migration was running.');
    }

    // ── Alarms ──────────────────────────────────────────────────────────
    anyAbove0('FallbackEventsAlarm', 'JaleAuditFallbackEvents', 'AuditFallbackEvents', cdk.Duration.minutes(5),
      'An attempt event went to the fallback log group because the database write failed.');
    anyAbove0('FallbackFailedAlarm', 'JaleAuditFallbackFailed', 'AuditFallbackFailed', cdk.Duration.minutes(5),
      'An attempt event could not be written to the database or the fallback log group, and was lost.');
    alarm('WriteFailedAlarm', {
      alarmName: 'JaleAuditWriteFailed',
      alarmDescription: 'A read failed because its access event could not be recorded (any surface).',
      metric: new cloudwatch.MathExpression({
        expression: `SELECT SUM(AuditWriteFailed) FROM SCHEMA("${AUDIT_METRIC_NAMESPACE}", Surface)`,
        period: cdk.Duration.minutes(5),
        label: 'AuditWriteFailed, every surface',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm('ExportRunMissingAlarm', {
      alarmName: 'JaleAuditExportRunMissing',
      alarmDescription: 'No complete audit export run for 30 minutes.',
      metric: auditMetric('AuditExportRunCompleted', 'Sum', cdk.Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 6,
      datapointsToAlarm: 6,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm('ExportLagAlarm', {
      alarmName: 'JaleAuditExportLag',
      alarmDescription: 'Audit records waited more than an hour to be exported. Expected while migrations hold long '
        + 'transactions, which keep the export window from advancing.',
      metric: auditMetric('AuditExportLagSeconds', 'Maximum', cdk.Duration.minutes(5)),
      threshold: 3600,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm('DailyCompareMissingAlarm', {
      alarmName: 'JaleAuditDailyCompareMissing',
      alarmDescription: 'No completed daily audit comparison for 26 hours.',
      metric: auditMetric('AuditDailyCompareCompleted', 'Sum', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    anyAbove0('FullVerifyMismatchAlarm', 'JaleAuditFullVerifyMismatch', 'AuditFullVerifyMismatch', cdk.Duration.hours(1),
      'The weekly full walk of the archive found an object or a chain link that does not match.');
    // CloudWatch cannot look back eight days, so the job reports the age of
    // its last completed pass every hour and the alarm reads that.
    alarm('FullVerifyOverdueAlarm', {
      alarmName: 'JaleAuditFullVerifyOverdue',
      alarmDescription: 'No completed full walk of the audit archive for eight days.',
      metric: auditMetric('AuditFullVerifyHoursSinceCompleted', 'Maximum', cdk.Duration.hours(1)),
      threshold: 192,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm('FullVerifyStalledAlarm', {
      alarmName: 'JaleAuditFullVerifyStalled',
      alarmDescription: 'The hourly full-walk invocation has not reported for 26 hours.',
      metric: auditMetric('AuditFullVerifyHoursSinceCompleted', 'SampleCount', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm('PurgeMissingAlarm', {
      alarmName: 'JaleAuditPurgeMissing',
      alarmDescription: 'No completed audit retention purge for 26 hours.',
      metric: auditMetric('AuditPurgeCompleted', 'Sum', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    anyAbove0('DailyCompareMismatchAlarm', 'JaleAuditDailyCompareMismatch', 'AuditDailyCompareMismatch', cdk.Duration.hours(1),
      'The archive and the database disagree: the digest chain, an object, or a recomputed window.');
    anyAbove0('ValueScanHitsAlarm', 'JaleAuditValueScanHits', 'AuditValueScanHits', cdk.Duration.minutes(5),
      'A reveal reason looked like it carries a value; the record is held, not exported (holds runbook).');
    anyAbove0('ContextInvalidAlarm', 'JaleAuditContextInvalid', 'AuditContextInvalid', cdk.Duration.hours(1),
      'A change record was written with a malformed audit context.');
    deadLetterTo(new events.Rule(this, 'EdgeCheckSchedule', {
      ruleName: `${AUDIT_NAMES.rulePrefix}edge-check`,
      description: "Daily check of the audit rules: the main region's routes, and the edge regions' forwarding rules and dead letters",
      schedule: events.Schedule.cron({ minute: '0', hour: '4' }),
      targets: [new eventTargets.LambdaFunction(sentinelFn, {
        event: events.RuleTargetInput.fromObject({ check: 'edge' }),
        retryAttempts: 2,
      })],
    }));
    anyAbove0('EdgeCheckFailedAlarm', 'JaleAuditEdgeCheckFailed', 'AuditEdgeCheckFailed', cdk.Duration.hours(1),
      'An audit rule is not as configured, in the main region or an edge region (missing, changed or failing), or an edge region holds events it could not forward.');
    alarm('EdgeCheckMissingAlarm', {
      alarmName: 'JaleAuditEdgeCheckMissing',
      alarmDescription: 'No completed daily check of the audit rules for 26 hours.',
      metric: auditMetric('AuditEdgeCheckCompleted', 'Sum', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    anyAbove0('CognitoEventUnattributedAlarm', 'JaleAuditCognitoEventUnattributed', 'AuditCognitoEventUnattributed', cdk.Duration.days(1),
      'A failed user-pool sign-in named no user pool, so the admin-pool check could not attribute it. Nothing of it was kept.');
    anyAbove0('CognitoPoolUnresolvedAlarm', 'JaleAuditCognitoPoolUnresolved', 'AuditCognitoPoolUnresolved', cdk.Duration.days(1),
      `The sentinel could not find exactly one user pool named ${ADMIN_POOL_NAME}; failed admin sign-ins are not being alerted.`);
    anyAbove0('TrailDeliveryStaleAlarm', 'JaleAuditTrailDeliveryStale', 'AuditTrailDeliveryStale', cdk.Duration.hours(1),
      'The audit trail has delivered nothing to the archive for two hours.');
    // Every completed trail check reports AuditTrailDeliveryStale, 0 or 1. A
    // check that could not run, or could not read the trail's delivery,
    // reports nothing: this alarm counts that silence as a breach.
    alarm('TrailCheckMissingAlarm', {
      alarmName: 'JaleAuditTrailCheckMissing',
      alarmDescription: 'No completed trail delivery check for 26 hours: the daily check could not run or could not read the delivery.',
      metric: auditMetric('AuditTrailDeliveryStale', 'SampleCount', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm('SentinelErrorsAlarm', {
      alarmName: 'JaleAuditSentinelErrors',
      alarmDescription: 'The audit sentinel failed; the event is retried, then kept in its dead-letter queue.',
      metric: sentinelFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm('SentinelDeadLettersAlarm', {
      alarmName: 'JaleAuditSentinelDeadLetters',
      alarmDescription: 'Audit events or log batches the sentinel could not process are waiting in its dead-letter queue.',
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.createAthena(archive, key, exportFn.role!);
  }

  /** The audit-reader role's rights: Athena, the catalog, the archive, query results and the key. */
  private grantReader(reader: iam.Role, archive: s3.IBucket, key: kms.IKey): void {
    const stack = cdk.Stack.of(this);
    reader.addToPolicy(new iam.PolicyStatement({
      sid: 'QueryTheAuditWorkgroup',
      actions: [
        'athena:StartQueryExecution', 'athena:StopQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults',
        'athena:GetQueryRuntimeStatistics', 'athena:ListQueryExecutions', 'athena:BatchGetQueryExecution', 'athena:GetWorkGroup',
      ],
      resources: [stack.formatArn({ service: 'athena', resource: 'workgroup', resourceName: AUDIT_NAMES.workgroup, account: cdk.Aws.ACCOUNT_ID, region: cdk.Aws.REGION })],
    }));
    reader.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadTheAuditCatalog',
      actions: ['glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartition', 'glue:GetPartitions'],
      resources: [
        stack.formatArn({ service: 'glue', resource: 'catalog', account: cdk.Aws.ACCOUNT_ID, region: cdk.Aws.REGION }),
        stack.formatArn({ service: 'glue', resource: 'database', resourceName: AUDIT_NAMES.glueDatabase, account: cdk.Aws.ACCOUNT_ID, region: cdk.Aws.REGION }),
        stack.formatArn({ service: 'glue', resource: 'table', resourceName: `${AUDIT_NAMES.glueDatabase}/*`, account: cdk.Aws.ACCOUNT_ID, region: cdk.Aws.REGION }),
      ],
    }));
    reader.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadTheArchive',
      actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [archive.bucketArn, archive.arnForObjects('*')],
    }));
    const results = auditBucketName('query-results');
    reader.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteQueryResults',
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${results}`, `arn:${cdk.Aws.PARTITION}:s3:::${results}/*`],
    }));
    reader.addToPolicy(new iam.PolicyStatement({
      sid: 'UseTheAuditKey',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [key.keyArn],
    }));
  }

  /** The AWS Config recorder Security Hub needs, delivering to its own unlocked bucket. */
  private createConfigRecorder(): void {
    const bucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName: auditBucketName('config'),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      lifecycleRules: [{ id: 'expire-snapshots', expiration: cdk.Duration.days(400) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const sourceAccount = { StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID } };
    const configService = new iam.ServicePrincipal('config.amazonaws.com');
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'ConfigBucketPermissionsCheck',
      principals: [configService],
      actions: ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: sourceAccount,
    }));
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'ConfigBucketDelivery',
      principals: [configService],
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects(`config/AWSLogs/${cdk.Aws.ACCOUNT_ID}/Config/*`)],
      conditions: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID } },
    }));
    // Same-account delivery uses the recorder's own role (the service
    // principal is only the cross-account fallback), so the role carries the
    // documented S3 statements; the managed policy has no S3 write.
    const role = new iam.Role(this, 'ConfigRecorderRole', {
      assumedBy: configService.withConditions({ StringEquals: { 'AWS:SourceAccount': cdk.Aws.ACCOUNT_ID } }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole')],
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ConfigDeliversSnapshots',
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [bucket.arnForObjects(`config/AWSLogs/${cdk.Aws.ACCOUNT_ID}/*`)],
      conditions: { StringLike: { 's3:x-amz-acl': 'bucket-owner-full-control' } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ConfigChecksTheBucket',
      actions: ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [bucket.bucketArn],
    }));
    const recorder = new config.CfnConfigurationRecorder(this, 'ConfigRecorder', {
      name: 'jale-audit-recorder',
      roleArn: role.roleArn,
      recordingGroup: { allSupported: true, includeGlobalResourceTypes: false },
      recordingMode: { recordingFrequency: 'DAILY' },
    });
    const channel = new config.CfnDeliveryChannel(this, 'ConfigDeliveryChannel', {
      name: 'jale-audit-delivery',
      s3BucketName: bucket.bucketName,
      s3KeyPrefix: 'config',
      configSnapshotDeliveryProperties: { deliveryFrequency: 'TwentyFour_Hours' },
    });
    // Neither waits on the other. The recorder's create starts recording, which
    // needs a delivery channel, and the channel's create needs a recorder, so
    // a dependency either way deadlocks (the create failed NotStabilized).
    // CloudFormation creates them side by side, each after the bucket policy.
    recorder.node.addDependency(bucket);
    channel.node.addDependency(bucket);
  }

  /** The Athena workgroup, its results bucket, and the catalog over the archive. */
  private createAthena(archive: s3.IBucket, key: kms.IKey, exportRole: iam.IRole): void {
    const results = new s3.Bucket(this, 'QueryResultsBucket', {
      bucketName: auditBucketName('query-results'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      lifecycleRules: [{ id: 'expire-results', expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // The full verification's progress: no one but the export job may
    // write or delete it, whatever their IAM rights. Lifting this takes a
    // bucket-policy change on a jale-audit- bucket, which the sentinel alerts on.
    results.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyTheExportJobWritesTheVerifyProgress',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: [...VERIFY_PROGRESS_WRITE_ACTIONS],
      resources: [results.arnForObjects(`${VERIFY_PROGRESS_PREFIX}*`)],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': exportRole.roleArn } },
    }));
    new athena.CfnWorkGroup(this, 'Workgroup', {
      name: AUDIT_NAMES.workgroup,
      description: 'Audit archive queries',
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${results.bucketName}/`,
          encryptionConfiguration: { encryptionOption: 'SSE_KMS', kmsKey: key.keyArn },
        },
      },
    });

    const database = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: { name: AUDIT_NAMES.glueDatabase, description: 'The audit archive' },
    });
    const archiveUri = `s3://${archive.bucketName}`;
    const json = {
      inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
      outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
      serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
    };
    const columns = glueColumns;
    const table = (logicalId: string, name: string, location: string, cols: glue.CfnTable.ColumnProperty[], projected: boolean): void => {
      const created = new glue.CfnTable(this, logicalId, {
        catalogId: cdk.Aws.ACCOUNT_ID,
        databaseName: AUDIT_NAMES.glueDatabase,
        tableInput: {
          name,
          tableType: 'EXTERNAL_TABLE',
          parameters: projected
            ? {
              classification: 'json',
              'projection.enabled': 'true',
              'projection.dt.type': 'date',
              'projection.dt.format': 'yyyy-MM-dd',
              'projection.dt.range': '2026-01-01,NOW',
              'projection.dt.interval': '1',
              'projection.dt.interval.unit': 'DAYS',
              'storage.location.template': `${location}dt=\${dt}/`,
            }
            : { classification: 'json' },
          partitionKeys: projected ? [{ name: 'dt', type: 'string' }] : [],
          storageDescriptor: { columns: cols, location, ...json },
        },
      });
      created.addResourceDependency(database);
    };
    const eventColumns = columns(
      'seq bigint, event_id string, xact string, occurred_at string, kind string, outcome string, actor_kind string, '
      + 'actor_id string, actor_role string, actor_session string, channel string, surface string, categories array<string>, '
      + 'subject_user_ids array<string>, record_type string, record_ids array<string>, result_count int, '
      + 'field_names array<string>, purpose_kind string, purpose_id string, reason string, link_expires_at string, '
      + 'part int, parts int, request_id string, db_login string, db_pid int',
    );
    const changeColumns = columns(
      'seq bigint, event_id string, xact string, occurred_at string, table_name string, operation string, row_count int, '
      + 'record_ids array<string>, subject_user_ids array<string>, changed_fields array<string>, actor_kind string, '
      + 'actor_id string, channel string, surface string, request_id string, context_status string, db_login string, db_pid int',
    );
    // The dashboard's frozen action records, exported as their own
    // stream. The actor is the admin's id; the three JSON fields are kept as
    // their JSON text.
    const legacyColumns = columns(
      'seq bigint, id string, xact string, created_at string, actor_admin_id string, '
      + 'actor_role string, action string, target_type string, target_id string, before_state string, '
      + 'after_state string, pii_reveal boolean, metadata string',
    );
    // One projected table per stream, plus one for its release batches.
    for (const [label, stream, cols] of [
      ['Events', 'events', eventColumns],
      ['Changes', 'changes', changeColumns],
      ['AdminActionsLegacy', 'admin_actions_legacy', legacyColumns],
    ] as const) {
      table(`${label}Table`, `db_${stream}`, `${archiveUri}/db/${stream}/`, cols, true);
      table(`${label}ReleasesTable`, `db_${stream}_releases`, `${archiveUri}/db/${stream}/releases/`, cols, false);
    }

    const trailLocation = `${archiveUri}/cloudtrail/AWSLogs/${cdk.Aws.ACCOUNT_ID}/CloudTrail/`;
    const trail = new glue.CfnTable(this, 'CloudTrailTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: AUDIT_NAMES.glueDatabase,
      tableInput: {
        name: 'cloudtrail',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          classification: 'cloudtrail',
          'projection.enabled': 'true',
          'projection.region.type': 'enum',
          'projection.region.values': [
            'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1', 'eu-west-1', 'eu-west-2',
            'eu-west-3', 'eu-central-1', 'eu-north-1', 'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
            'ap-southeast-1', 'ap-southeast-2',
          ].join(','),
          'projection.timestamp.type': 'date',
          'projection.timestamp.format': 'yyyy/MM/dd',
          'projection.timestamp.range': '2026/01/01,NOW',
          'projection.timestamp.interval': '1',
          'projection.timestamp.interval.unit': 'DAYS',
          'storage.location.template': `${trailLocation}\${region}/\${timestamp}`,
        },
        partitionKeys: [{ name: 'region', type: 'string' }, { name: 'timestamp', type: 'string' }],
        storageDescriptor: {
          location: trailLocation,
          inputFormat: 'com.amazon.emr.cloudtrail.CloudTrailInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'com.amazon.emr.hive.serde.CloudTrailSerde' },
          columns: columns(
            'eventversion string, '
            + 'useridentity struct<type:string,principalid:string,arn:string,accountid:string,invokedby:string,accesskeyid:string,'
            + 'username:string,sessioncontext:struct<attributes:struct<mfaauthenticated:string,creationdate:string>,'
            + 'sessionissuer:struct<type:string,principalid:string,arn:string,accountid:string,username:string>>>, '
            + 'eventtime string, eventsource string, eventname string, awsregion string, sourceipaddress string, '
            + 'useragent string, errorcode string, errormessage string, requestparameters string, responseelements string, '
            + 'additionaleventdata string, requestid string, eventid string, readonly string, '
            + 'resources array<struct<arn:string,accountid:string,type:string>>, eventtype string, apiversion string, '
            + 'recipientaccountid string, serviceeventdetails string, sharedeventid string, vpcendpointid string, '
            + 'eventcategory string',
          ),
        },
      },
    });
    trail.addResourceDependency(database);
  }
}

/** `name type, name type, ...` into Glue columns; commas inside `<...>` belong to the type. */
export function glueColumns(spec: string): glue.CfnTable.ColumnProperty[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '<') depth += 1;
    if (ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => {
    const trimmed = part.trim();
    const at = trimmed.indexOf(' ');
    return { name: trimmed.slice(0, at), type: trimmed.slice(at + 1).trim() };
  });
}
