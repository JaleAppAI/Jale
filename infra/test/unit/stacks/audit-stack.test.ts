import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { dbLoginSecretName } from '../../../lib/constructs/db-login-secrets';
import { AuditArchiveStack } from '../../../lib/stacks/audit-archive-stack';
import { AuditEdgeStack, EDGE_RULES, auditEdgeRegions, needsAuditEdgeStack } from '../../../lib/stacks/audit-edge-stack';
import {
  AUDIT_EXPORT_LOGIN,
  AuditStack,
  SERVICE_MODE_FLAGS,
  VERIFY_PROGRESS_PREFIX,
  VERIFY_PROGRESS_WRITE_ACTIONS,
  glueColumns,
  type ServiceMode,
} from '../../../lib/stacks/audit-stack';
import { FULL_VERIFY_STATE_KEY } from '../../../lambda/ops/audit-export';
import type { AuditEngineWindow } from '../../../lib/stacks/database-stack';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import {
  AUDIT_SYSTEM_EVENTS,
  DATABASE_EVENTS,
  PARAMETER_EVENTS,
  SECRET_CHANGE_EVENTS,
  SECRET_READ_EVENTS,
} from '../../../lambda/ops/audit-sentinel-rules';
import { edgeCheckConfigFromEnv, sentinelConfigFromEnv } from '../../../lambda/ops/audit-sentinel';
import { CLOUDWATCH_VALUE_PATTERNS, cloudWatchRegexToJs } from '../../../lambda/ops/audit-value-patterns';
import { MUST_HIT, MUST_NOT_HIT } from '../lambda/ops/fixtures/audit-value-samples';
import { explicitlyDenied, flatten, resourcesOf, onlyResource, statements, wildcard } from './audit-template-helpers';

/**
 * JaleAuditStack and JaleAuditEdgeStack,
 * synthesized from the stacks themselves with the production context, and
 * without bundling: these tests read templates only.
 */

const PLACEHOLDER_ACCOUNT = '111111111111';
/**
 * Account-agnostic, as the credential-free CI synth is: every account-bearing
 * value must then come out as a pseudo-parameter, which the scan below checks.
 * (With a concrete account CDK itself writes it into asset bucket names and
 * imported-secret ARNs, in every stack alike.)
 */
const ENV = { region: 'us-east-2' };

interface Options {
  modes?: Partial<Record<(typeof SERVICE_MODE_FLAGS)[number], ServiceMode | undefined>>;
  window?: AuditEngineWindow;
  environment?: string;
}

/** The master secret's ARN as the composition passes it (an import there); built from pseudo-parameters here. */
const MASTER_SECRET = `arn:${cdk.Aws.PARTITION}:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:JaleDatabaseStackDatabaseS-Example-AbCdEf`;

function synth(options: Options = {}): any {
  const modes = { guardDutyMode: 'create', securityHubMode: 'create', configMode: 'create', ...options.modes };
  const context: Record<string, unknown> = {
    'aws:cdk:bundling-stacks': [],
    environment: options.environment ?? 'production',
  };
  for (const [flag, value] of Object.entries(modes)) if (value !== undefined) context[flag] = value;
  const app = new cdk.App({ context });
  const network = new NetworkStack(app, 'JaleNetworkStack', { env: ENV });
  const archive = new AuditArchiveStack(app, 'JaleAuditArchiveStack', { env: ENV });
  const window = options.window ?? 0;
  const audit = new AuditStack(app, 'JaleAuditStack', {
    env: ENV,
    network,
    auditKeyArn: archive.key.keyArn,
    auditEngineWindow: window,
    dbInstanceIdentifier: window >= 2 ? 'example-instance' : undefined,
    masterSecretArn: MASTER_SECRET,
  });
  return Template.fromStack(audit).toJSON();
}

const template = synth();

/** The audit key's ARN as this stack imports it: the archive stack's one export. */
const KEY: string = Object.values(resourcesOf(template, 'AWS::Lambda::Function'))
  .map((f) => f.Properties.Environment?.Variables?.AUDIT_KEY_ARN)
  .find((v) => v !== undefined);

function lambdaByEntry(t: any, description: RegExp): [string, any] {
  const found = Object.entries(resourcesOf(t, 'AWS::Lambda::Function')).filter(([, f]) => description.test(f.Properties.Description ?? ''));
  expect(found).toHaveLength(1);
  return found[0];
}

function roleStatements(t: any, roleId: string): any[] {
  return Object.values(resourcesOf(t, 'AWS::IAM::Policy'))
    .filter((p) => (p.Properties.Roles as string[]).includes(`\${${roleId}}`))
    .flatMap((p) => statements(p.Properties.PolicyDocument));
}

function roleOf(fn: any): string {
  return /^\$\{(.+)\.Arn\}$/.exec(fn.Properties.Role)![1];
}

describe('JaleAuditStack', () => {
  it('carries no account id, email address, subscription or principal ARN', () => {
    const text = JSON.stringify(template);
    // A 12-digit number on its own (logical-id hashes are runs inside words).
    expect(text).not.toMatch(/(?<![A-Za-z0-9])\d{12}(?![A-Za-z0-9])/);
    expect(text).not.toMatch(/arn:aws:iam::\d{12}:/);
    expect(text).not.toMatch(/[\w.-]+@[\w-]+\.[A-Za-z]{2,}/);
    expect(Object.keys(resourcesOf(template, 'AWS::SNS::Subscription'))).toEqual([]);
  });

  it('imports only the audit key from the archive stack', () => {
    expect(KEY).toMatch(/^\$\{import:JaleAuditArchiveStack:ExportsOutputFnGetAttAuditKey[A-Za-z0-9]+Arn[A-Za-z0-9]+\}$/);
    const imports = JSON.stringify(flatten(template)).match(/\$\{import:[^}]+\}/g) ?? [];
    expect([...new Set(imports.filter((i) => i.includes('JaleAuditArchiveStack')))]).toEqual([KEY]);
  });

  describe('log groups', () => {
    it('creates the fallback and ops-command groups by fixed name, encrypted, for 400 days, kept', () => {
      const groups = Object.values(resourcesOf(template, 'AWS::Logs::LogGroup'))
        .filter((g) => typeof g.Properties.LogGroupName === 'string' && g.Properties.LogGroupName.startsWith('/jale/audit/'));
      expect(groups.map((g) => g.Properties.LogGroupName).sort()).toEqual(['/jale/audit/fallback', '/jale/audit/ops-command']);
      for (const group of groups) {
        expect(group.Properties.KmsKeyId).toBe(KEY);
        expect(group.Properties.RetentionInDays).toBe(400);
        expect(group.DeletionPolicy).toBe('Retain');
      }
    });

    it('subscribes the sentinel to both, for everything', () => {
      const [sentinelId] = lambdaByEntry(template, /^Archives the audit log groups/);
      const subscriptions = Object.values(resourcesOf(template, 'AWS::Logs::SubscriptionFilter'));
      expect(subscriptions).toHaveLength(2);
      for (const s of subscriptions) {
        expect(s.Properties.DestinationArn).toBe(`\${${sentinelId}.Arn}`);
        expect(s.Properties.FilterPattern).toBe('');
      }
    });

    it('scans both for values with the shared patterns, each pattern tested against the shared samples', () => {
      const filters = Object.values(resourcesOf(template, 'AWS::Logs::MetricFilter'));
      expect(filters).toHaveLength(6);
      const byMetric: Record<string, string[]> = {};
      for (const f of filters) {
        const t = f.Properties.MetricTransformations[0];
        expect(t.MetricNamespace).toBe('Jale/Audit');
        expect(t.MetricValue).toBe('1');
        (byMetric[t.MetricName] ??= []).push(f.Properties.FilterPattern);
      }
      const patterns = Object.values(CLOUDWATCH_VALUE_PATTERNS).sort();
      expect(Object.keys(byMetric).sort()).toEqual(['AuditFallbackValueHits', 'AuditOpsCommandValueHits']);
      for (const list of Object.values(byMetric)) expect([...list].sort()).toEqual(patterns);
      for (const pattern of patterns) {
        const regex = cloudWatchRegexToJs(pattern);
        for (const sample of MUST_NOT_HIT) expect([pattern, sample, regex.test(sample)]).toEqual([pattern, sample, false]);
      }
      for (const { sample, kind } of MUST_HIT) expect(cloudWatchRegexToJs(CLOUDWATCH_VALUE_PATTERNS[kind]).test(sample)).toBe(true);
    });
  });

  describe('the alert topic', () => {
    const [alertKeyId, alertKey] = Object.entries(resourcesOf(template, 'AWS::KMS::Key'))[0] ?? [];
    const ROOT = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root';
    const ADMIN_ROLE = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/JaleAuditAdmin';

    it('is encrypted with a key of its own, never the audit key, and has no subscriptions', () => {
      const topic = onlyResource(template, 'AWS::SNS::Topic');
      expect(topic.Properties.TopicName).toBe('jale-audit-alerts');
      expect(Object.keys(resourcesOf(template, 'AWS::KMS::Key'))).toEqual([alertKeyId]);
      expect(topic.Properties.KmsMasterKeyId).toBe(`\${${alertKeyId}.Arn}`);
      expect(topic.Properties.KmsMasterKeyId).not.toBe(KEY);
      expect(topic.Properties.Subscription).toBeUndefined();
    });

    it('has a key that rotates, is kept on deletion, and has the fixed alias', () => {
      expect(alertKey.Properties.EnableKeyRotation).toBe(true);
      expect(alertKey.DeletionPolicy).toBe('Retain');
      expect(alertKey.UpdateReplacePolicy).toBe('Retain');
      expect(onlyResource(template, 'AWS::KMS::Alias').Properties).toEqual({
        AliasName: 'alias/jale-audit-alerts',
        TargetKeyId: `\${${alertKeyId}.Arn}`,
      });
    });

    it("has exactly the pinned key policy: the root, the audit admin, and the alarms' publishing", () => {
      expect(statements(alertKey.Properties.KeyPolicy)).toEqual([
        { Action: 'kms:*', Effect: 'Allow', Principal: { AWS: ROOT }, Resource: '*' },
        {
          Sid: 'AuditAdminKeyAdministration',
          Action: [
            'kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*',
            'kms:Disable*', 'kms:Get*', 'kms:Delete*', 'kms:TagResource', 'kms:UntagResource',
            'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion',
          ],
          Condition: { ArnEquals: { 'aws:PrincipalArn': ADMIN_ROLE } },
          Effect: 'Allow',
          Principal: { AWS: ROOT },
          Resource: '*',
        },
        {
          Sid: 'AlarmsPublishToTheAlertTopic',
          Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          Condition: {
            StringEquals: { 'aws:SourceAccount': '${AWS::AccountId}' },
            ArnLike: { 'aws:SourceArn': 'arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:*' },
          },
          Effect: 'Allow',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Resource: '*',
        },
        {
          Sid: 'OnlyTheAuditAdminDisablesOrDeletesTheKey',
          Action: ['kms:DisableKey', 'kms:ScheduleKeyDeletion'],
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': ADMIN_ROLE } },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Resource: '*',
        },
      ]);
    });

    it('lets exactly one service use the key, for publishing: CloudWatch alarms. No rule publishes to the topic, so EventBridge has no grant', () => {
      const services = statements(alertKey.Properties.KeyPolicy)
        .filter((s: any) => s.Effect === 'Allow' && s.Principal?.Service)
        .map((s: any) => [s.Principal.Service, [s.Action].flat()]);
      expect(services).toEqual([
        ['cloudwatch.amazonaws.com', ['kms:Decrypt', 'kms:GenerateDataKey*']],
      ]);
      expect(JSON.stringify(alertKey.Properties.KeyPolicy)).not.toContain('events.amazonaws.com');
      // No rule's target is the topic.
      const topicId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === 'AWS::SNS::Topic');
      const targets = Object.values(resourcesOf(template, 'AWS::Events::Rule')).flatMap((r) => r.Properties.Targets ?? []);
      expect(targets.length).toBeGreaterThan(20);
      expect(targets.filter((t: any) => JSON.stringify(t.Arn).includes(String(topicId)))).toEqual([]);
    });

    it('never denies a key policy change, so the account root can always recover the key', () => {
      const denied = statements(alertKey.Properties.KeyPolicy).filter((s: any) => s.Effect === 'Deny').flatMap((s: any) => [s.Action].flat());
      expect(denied).not.toContain('kms:PutKeyPolicy');
      expect(denied.some((a: string) => a === 'kms:*' || a === '*')).toBe(false);
    });

    it('lets the sentinel publish with the key, and the audit admin administer it next to the audit key', () => {
      const [, sentinel] = lambdaByEntry(template, /^Archives the audit log groups/);
      expect(roleStatements(template, roleOf(sentinel))).toEqual(expect.arrayContaining([
        expect.objectContaining({ Action: ['kms:Decrypt', 'kms:GenerateDataKey*'], Effect: 'Allow', Resource: `\${${alertKeyId}.Arn}` }),
      ]));
      const admin = Object.entries(resourcesOf(template, 'AWS::IAM::Role')).find(([, r]) => r.Properties.RoleName === 'JaleAuditAdmin')![0];
      const keyAdministration = roleStatements(template, admin).filter((s: any) => s.Sid === 'AuditKeyAdministration');
      expect(keyAdministration.map((s: any) => s.Resource)).toEqual([[KEY, `\${${alertKeyId}.Arn}`]]);
    });

    it("tells the sentinel the key's ARN and alias, so a change to the key alerts", () => {
      const [, sentinel] = lambdaByEntry(template, /^Archives the audit log groups/);
      expect(sentinel.Properties.Environment.Variables).toMatchObject({
        AUDIT_ALERT_KEY_ARN: `\${${alertKeyId}.Arn}`,
        AUDIT_ALERT_KEY_ALIAS: 'alias/jale-audit-alerts',
      });
    });

    it("lets this account's alarms publish to it, and nothing else through the topic policy", () => {
      const policy = onlyResource(template, 'AWS::SNS::TopicPolicy');
      const allows = statements(policy.Properties.PolicyDocument).filter((s: any) => s.Effect === 'Allow');
      expect(allows.map(({ Resource: _r, ...rest }: any) => rest)).toEqual([{
        Sid: 'AlarmsPublish',
        Action: 'sns:Publish',
        Condition: {
          ArnLike: { 'aws:SourceArn': 'arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:*' },
          StringEquals: { 'aws:SourceAccount': '${AWS::AccountId}' },
        },
        Effect: 'Allow',
        Principal: { Service: 'cloudwatch.amazonaws.com' },
      }]);
    });

    it('is the action of every alarm, and the alarms are exactly these', () => {
      const alarms = Object.values(resourcesOf(template, 'AWS::CloudWatch::Alarm'));
      const topicId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === 'AWS::SNS::Topic');
      for (const a of alarms) expect(a.Properties.AlarmActions).toEqual([`\${${topicId}}`]);
      expect(alarms.map((a) => a.Properties.AlarmName).sort()).toEqual([
        'JaleAuditCognitoEventUnattributed',
        'JaleAuditCognitoPoolUnresolved',
        'JaleAuditContextInvalid',
        'JaleAuditDailyCompareMismatch',
        'JaleAuditDailyCompareMissing',
        'JaleAuditEdgeCheckFailed',
        'JaleAuditEdgeCheckMissing',
        'JaleAuditExportLag',
        'JaleAuditExportRunMissing',
        'JaleAuditFallbackEvents',
        'JaleAuditFallbackFailed',
        'JaleAuditFallbackValueHits',
        'JaleAuditFullVerifyMismatch',
        'JaleAuditFullVerifyOverdue',
        'JaleAuditFullVerifyStalled',
        'JaleAuditOpsCommandValueHits',
        'JaleAuditPurgeMissing',
        'JaleAuditSentinelDeadLetters',
        'JaleAuditSentinelErrors',
        'JaleAuditTrailCheckMissing',
        'JaleAuditTrailDeliveryStale',
        'JaleAuditValueScanHits',
        'JaleAuditWriteFailed',
      ]);
    });

    it('alarms on missing export runs and missing daily comparisons, counting silence as a breach', () => {
      const alarms = Object.values(resourcesOf(template, 'AWS::CloudWatch::Alarm'));
      const byName = (name: string) => alarms.find((a) => a.Properties.AlarmName === name)!.Properties;
      expect(byName('JaleAuditExportRunMissing')).toMatchObject({
        MetricName: 'AuditExportRunCompleted', Namespace: 'Jale/Audit', Period: 300, EvaluationPeriods: 6,
        DatapointsToAlarm: 6, ComparisonOperator: 'LessThanThreshold', TreatMissingData: 'breaching',
      });
      expect(byName('JaleAuditDailyCompareMissing')).toMatchObject({
        MetricName: 'AuditDailyCompareCompleted', Period: 3600, EvaluationPeriods: 26, TreatMissingData: 'breaching',
      });
      expect(byName('JaleAuditWriteFailed').Metrics[0].Expression).toBe('SELECT SUM(AuditWriteFailed) FROM SCHEMA("Jale/Audit", Surface)');
      expect(byName('JaleAuditExportLag').AlarmDescription).toMatch(/migrations/);
    });
  });

  describe('the export job', () => {
    const [id, fn] = lambdaByEntry(template, /^Copies the database audit records/);

    it('runs in the VPC with the shared database security group, one at a time, as its own login', () => {
      expect(fn.Properties.ReservedConcurrentExecutions).toBe(1);
      expect(fn.Properties.VpcConfig.SecurityGroupIds).toEqual([expect.stringMatching(/^\$\{import:JaleNetworkStack:ExportsOutputFnGetAttLambdaS[Gg][A-Za-z0-9]+GroupId[A-Za-z0-9]+\}$/)]);
      expect(fn.Properties.Environment.Variables).toMatchObject({
        DB_SECRET_ARN: 'jale/job-audit-export/db',
        DB_EXPECTED_LOGIN: 'jale_job_audit_export',
        AUDIT_ARCHIVE_BUCKET: 'jale-audit-archive-${AWS::AccountId}-${AWS::Region}',
        AUDIT_TRAIL_PREFIX: 'cloudtrail/AWSLogs/${AWS::AccountId}/CloudTrail/${AWS::Region}/',
      });
      void id;
    });

    it('can put db/ and checks/ objects only with If-None-Match, read and list them, and list the trail prefix', () => {
      const s3 = roleStatements(template, roleOf(fn)).filter((s) => [s.Action].flat().some((a: string) => a.startsWith('s3:')));
      const archive = 'arn:${AWS::Partition}:s3:::jale-audit-archive-${AWS::AccountId}-${AWS::Region}';
      expect(s3).toEqual(expect.arrayContaining([
        expect.objectContaining({ Action: 's3:PutObject', Resource: [`${archive}/db/*`, `${archive}/checks/*`], Condition: { Null: { 's3:if-none-match': 'false' } } }),
        expect.objectContaining({ Action: 's3:GetObject', Resource: [`${archive}/db/*`, `${archive}/checks/*`] }),
        expect.objectContaining({ Action: ['s3:ListBucket', 's3:ListBucketVersions'], Resource: archive, Condition: { StringLike: { 's3:prefix': ['db/*', 'checks/*', 'cloudtrail/*'] } } }),
      ]));
      // On the archive, these three grants and the Deny that keeps db/ and checks/ to the export
      // function's own code (below); the full verification's progress is in another bucket.
      const onTheArchive = s3.filter((s) => JSON.stringify(s.Resource).includes('jale-audit-archive-'));
      expect(onTheArchive.filter((s) => s.Effect === 'Allow')).toHaveLength(3);
      expect(onTheArchive).toHaveLength(4);
      // Five grants, and the two Denies that keep the batches and the progress to the export function's own code (below).
      expect(s3.filter((s) => s.Effect === 'Allow')).toHaveLength(5);
      expect(s3).toHaveLength(7);
    });

    it('runs every five minutes, and daily at 03:10 UTC for the comparison and purge', () => {
      const rules = Object.values(resourcesOf(template, 'AWS::Events::Rule')).filter((r) => r.Properties.ScheduleExpression);
      const byName = Object.fromEntries(rules.map((r) => [r.Properties.Name, r.Properties]));
      expect(byName['jale-audit-export'].ScheduleExpression).toBe('rate(5 minutes)');
      expect(JSON.parse(byName['jale-audit-export'].Targets[0].Input)).toEqual({ mode: 'export' });
      expect(byName['jale-audit-export-daily'].ScheduleExpression).toBe('cron(10 3 * * ? *)');
      expect(JSON.parse(byName['jale-audit-export-daily'].Targets[0].Input)).toEqual({ mode: 'daily' });
      // The daily run is retried when a five-minute run holds the one slot.
      expect(byName['jale-audit-export-daily'].Targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: 8, MaximumEventAgeInSeconds: 7200 });
      expect(byName['jale-audit-export'].Targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: 0 });
    });

    it('walks the whole archive weekly in hourly chunks, keeping its progress in the query-results bucket', () => {
      const rule = Object.values(resourcesOf(template, 'AWS::Events::Rule')).find((r) => r.Properties.Name === 'jale-audit-export-full-verify')!.Properties;
      expect(rule.ScheduleExpression).toBe('rate(1 hour)');
      expect(JSON.parse(rule.Targets[0].Input)).toEqual({ mode: 'full-verify' });
      expect(rule.Targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: 8, MaximumEventAgeInSeconds: 3600 });
      expect(fn.Properties.Environment.Variables.AUDIT_STATE_BUCKET).toBe('jale-audit-query-results-${AWS::AccountId}-${AWS::Region}');
      const results = 'arn:${AWS::Partition}:s3:::jale-audit-query-results-${AWS::AccountId}-${AWS::Region}';
      const state = roleStatements(template, roleOf(fn)).filter((s) => JSON.stringify(s.Resource).includes('query-results'));
      expect(state.map(({ Sid: _s, ...rest }: any) => rest)).toEqual([
        { Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: `${results}/export-state/*` },
        { Action: 's3:ListBucket', Effect: 'Allow', Resource: results },
        // Writes from any code but the export function's own (below).
        {
          Action: [...VERIFY_PROGRESS_WRITE_ACTIONS],
          Condition: { ArnNotEquals: { 'lambda:SourceFunctionArn': `\${${id}.Arn}` } },
          Effect: 'Deny',
          Resource: `${results}/export-state/*`,
        },
      ]);
      const alarms = Object.values(resourcesOf(template, 'AWS::CloudWatch::Alarm'));
      const byName = (name: string) => alarms.find((a) => a.Properties.AlarmName === name)!.Properties;
      expect(byName('JaleAuditFullVerifyMismatch')).toMatchObject({ MetricName: 'AuditFullVerifyMismatch', Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold' });
      // Eight days without a completed pass (a CloudWatch alarm cannot look back more than seven, so the job reports the age).
      expect(byName('JaleAuditFullVerifyOverdue')).toMatchObject({
        MetricName: 'AuditFullVerifyHoursSinceCompleted', Statistic: 'Maximum', Threshold: 192, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'notBreaching',
      });
      expect(byName('JaleAuditFullVerifyStalled')).toMatchObject({
        MetricName: 'AuditFullVerifyHoursSinceCompleted', Statistic: 'SampleCount', Period: 3600, EvaluationPeriods: 26, TreatMissingData: 'breaching',
      });
    });

    it('keeps the audit reader from changing the full verification progress', () => {
      const reader = Object.entries(resourcesOf(template, 'AWS::IAM::Role')).find(([, r]) => r.Properties.RoleName === 'JaleAuditReader')![0];
      const denies = roleStatements(template, reader).filter((s: any) => s.Effect === 'Deny');
      expect(denies.map(({ Sid: _s, ...rest }: any) => rest)).toEqual([{
        Action: ['s3:PutObject', 's3:DeleteObject'],
        Effect: 'Deny',
        Resource: 'arn:${AWS::Partition}:s3:::jale-audit-query-results-${AWS::AccountId}-${AWS::Region}/export-state/*',
      }]);
    });

    // Lambda puts the calling function's unqualified ARN in
    // lambda:SourceFunctionArn for the AWS calls its code makes, and the key
    // works in the execution role's identity policy (AWS Lambda Developer
    // Guide, "Using source function ARN to control function access behavior").
    const exportFunctionArn = `\${${id}.Arn}`;
    const otherFunctionArn = 'arn:${AWS::Partition}:lambda:us-west-1:${AWS::AccountId}:function:example-function';
    /** The export role's policy of Denies for code other than the export function's, found by its first statement. */
    const policies = Object.entries(resourcesOf(template, 'AWS::IAM::Policy'))
      .filter(([, p]) => statements(p.Properties.PolicyDocument).some((s: any) => s.Sid === 'OnlyTheExportFunctionWritesTheVerifyProgress'));

    interface RoleRequest { sourceFunctionArn: string | undefined; action: string; resource: string }

    /**
     * Whether the export role's own policies explicitly deny the request:
     * the evaluation an explicit Deny gets, for the statement shapes this
     * stack writes. A negated operator matches when its key is absent (IAM
     * User Guide, "IAM JSON policy elements: Condition operators"). Any
     * other condition fails the test rather than being read as not matching.
     */
    function roleDenies(request: RoleRequest): boolean {
      return roleStatements(template, roleOf(fn)).some((s: any) => {
        if (s.Effect !== 'Deny') return false;
        if (![s.Action].flat().some((a: string) => wildcard(a, request.action))) return false;
        if (![s.Resource].flat().some((r: string) => wildcard(r, request.resource))) return false;
        return Object.entries(s.Condition ?? {}).every(([operator, block]: [string, any]) => Object.entries(block).every(([key, value]) => {
          if (operator === 'ArnNotEquals' && key === 'lambda:SourceFunctionArn') {
            return request.sourceFunctionArn === undefined || request.sourceFunctionArn !== value;
          }
          throw new Error(`unexpected condition ${operator} ${key} in ${s.Sid}`);
        }));
      });
    }

    describe('its progress, which only the export job may write', () => {
      const [bucketId] = Object.entries(resourcesOf(template, 'AWS::S3::Bucket'))
        .find(([, b]) => b.Properties.BucketName === 'jale-audit-query-results-${AWS::AccountId}-${AWS::Region}')!;
      const policy = Object.values(resourcesOf(template, 'AWS::S3::BucketPolicy')).find((p) => p.Properties.Bucket === `\${${bucketId}}`)!;
      const progress = `\${${bucketId}.Arn}/${FULL_VERIFY_STATE_KEY}`;
      const exportRole = `\${${roleOf(fn)}.Arn}`;
      const role = (name: string) => `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${name}`;

      it('keeps the progress under the protected prefix', () => {
        expect(FULL_VERIFY_STATE_KEY.startsWith(VERIFY_PROGRESS_PREFIX)).toBe(true);
      });

      it('denies a write or delete of the progress to everyone but the export job', () => {
        expect(statements(policy.Properties.PolicyDocument).filter((s: any) => s.Sid === 'OnlyTheExportJobWritesTheVerifyProgress')).toEqual([{
          Sid: 'OnlyTheExportJobWritesTheVerifyProgress',
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Action: [...VERIFY_PROGRESS_WRITE_ACTIONS],
          Resource: `\${${bucketId}.Arn}/${VERIFY_PROGRESS_PREFIX}*`,
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': exportRole } },
        }]);
      });

      it.each([
        ['the audit admin', role('JaleAuditAdmin')],
        ['the audit reader', role('JaleAuditReader')],
        ['the deploy execution role', role('cdk-hnb659fds-cfn-exec-role-${AWS::AccountId}-${AWS::Region}')],
        ['an administrator', role('Administrator')],
        ['the account root', 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root'],
        ['the sentinel', `\${${roleOf(lambdaByEntry(template, /^Archives the audit log groups/)[1])}.Arn}`],
        ['a service, which carries no principal ARN', undefined],
      ])('refuses a forged progress write by %s', (_who, principalArn) => {
        for (const action of VERIFY_PROGRESS_WRITE_ACTIONS) {
          expect(explicitlyDenied(policy, { principalArn, action, resource: progress })).toBe(true);
        }
        expect(explicitlyDenied(policy, { principalArn, action: 's3:PutObject', resource: `\${${bucketId}.Arn}/${VERIFY_PROGRESS_PREFIX}other.json` })).toBe(true);
      });

      it('lets the export job write it, and leaves the query results to their readers', () => {
        expect(explicitlyDenied(policy, { principalArn: exportRole, action: 's3:PutObject', resource: progress })).toBe(false);
        expect(explicitlyDenied(policy, { principalArn: role('JaleAuditReader'), action: 's3:PutObject', resource: `\${${bucketId}.Arn}/query-id.csv` })).toBe(false);
        // Without TLS, everything is refused (the bucket's TLS rule), the export job included.
        expect(explicitlyDenied(policy, { principalArn: exportRole, action: 's3:PutObject', resource: progress, secureTransport: false })).toBe(true);
      });

      describe("from the role's side: only the export function's own code may use the role to write it", () => {
        const results = 'arn:${AWS::Partition}:s3:::jale-audit-query-results-${AWS::AccountId}-${AWS::Region}';
        const progressKey = `${results}/${FULL_VERIFY_STATE_KEY}`;

        it('is a Deny of every progress write unless the call comes from the export function, on the export role alone', () => {
          expect(policies).toHaveLength(1);
          const [, policy] = policies[0];
          expect(policy.Properties.Roles).toEqual([`\${${roleOf(fn)}}`]);
          expect(statements(policy.Properties.PolicyDocument).filter((s: any) => s.Sid === 'OnlyTheExportFunctionWritesTheVerifyProgress')).toEqual([{
            Sid: 'OnlyTheExportFunctionWritesTheVerifyProgress',
            Effect: 'Deny',
            Action: [...VERIFY_PROGRESS_WRITE_ACTIONS],
            Resource: `${results}/${VERIFY_PROGRESS_PREFIX}*`,
            Condition: { ArnNotEquals: { 'lambda:SourceFunctionArn': exportFunctionArn } },
          }]);
        });

        it('lets the export function write it', () => {
          for (const action of VERIFY_PROGRESS_WRITE_ACTIONS) {
            expect([action, roleDenies({ sourceFunctionArn: exportFunctionArn, action, resource: progressKey })]).toEqual([action, false]);
          }
        });

        it.each([
          ['another function given the role, in any region', otherFunctionArn],
          ['a call that carries no source function, as from credentials used outside a function', undefined],
        ])('refuses %s', (_who, sourceFunctionArn) => {
          for (const action of VERIFY_PROGRESS_WRITE_ACTIONS) {
            expect([action, roleDenies({ sourceFunctionArn, action, resource: progressKey })]).toEqual([action, true]);
          }
          expect(roleDenies({ sourceFunctionArn, action: 's3:PutObject', resource: `${results}/${VERIFY_PROGRESS_PREFIX}other.json` })).toBe(true);
        });

        it('leaves reads of the progress alone', () => {
          expect(roleDenies({ sourceFunctionArn: otherFunctionArn, action: 's3:GetObject', resource: progressKey })).toBe(false);
        });

        it('is its own policy, which the export function does not wait on, so the template has no cycle', () => {
          const [policyId] = policies[0];
          expect([template.Resources[id].DependsOn ?? []].flat()).not.toContain(policyId);
          expect(JSON.stringify(flatten(template.Resources[policyId]))).toContain(exportFunctionArn);
        });
      });

      it('alerts on any change to the bucket policy that holds the rule: the sentinel watches every jale-audit- bucket', () => {
        const rule = Object.values(resourcesOf(template, 'AWS::Events::Rule')).find((r) => r.Properties.Name === 'jale-audit-system-s3')!.Properties;
        expect(rule.EventPattern.detail.eventName).toEqual(expect.arrayContaining(['PutBucketPolicy', 'DeleteBucketPolicy']));
        const [prefix] = rule.EventPattern.detail.requestParameters.bucketName.map((m: any) => m.prefix);
        expect('jale-audit-query-results-${AWS::AccountId}-${AWS::Region}'.startsWith(prefix)).toBe(true);
        const [, sentinel] = lambdaByEntry(template, /^Archives the audit log groups/);
        expect(sentinel.Properties.Environment.Variables.AUDIT_BUCKET_PREFIX).toBe(prefix);
      });
    });

    describe("its login secret and its batches, which only the export function's own code may use", () => {
      const archive = 'arn:${AWS::Partition}:s3:::jale-audit-archive-${AWS::AccountId}-${AWS::Region}';
      const results = 'arn:${AWS::Partition}:s3:::jale-audit-query-results-${AWS::AccountId}-${AWS::Region}';
      /** The login's secret: `??????` as a policy names it, six characters as a call does. */
      const loginSecret = (suffix: string) =>
        `arn:\${AWS::Partition}:secretsmanager:${ENV.region}:\${AWS::AccountId}:secret:${dbLoginSecretName(AUDIT_EXPORT_LOGIN)}-${suffix}`;
      const fromTheExportFunctionOnly = { ArnNotEquals: { 'lambda:SourceFunctionArn': exportFunctionArn } };
      /** What the export function's code does with them. */
      const uses: Array<[string, string]> = [
        ['secretsmanager:GetSecretValue', loginSecret('AbCdEf')],
        ['secretsmanager:DescribeSecret', loginSecret('AbCdEf')],
        ['s3:PutObject', `${archive}/db/example-batch.json`],
        ['s3:GetObject', `${archive}/db/example-batch.json`],
        ['s3:PutObject', `${archive}/checks/example-checkpoint.json`],
        ['s3:GetObject', `${archive}/checks/example-checkpoint.json`],
      ];

      it("are denied, with the progress writes, to any code but the export function's, in one policy on the export role alone", () => {
        expect(policies).toHaveLength(1);
        const [, policy] = policies[0];
        expect(policy.Properties.Roles).toEqual([`\${${roleOf(fn)}}`]);
        expect(statements(policy.Properties.PolicyDocument)).toEqual([
          {
            Sid: 'OnlyTheExportFunctionWritesTheVerifyProgress',
            Effect: 'Deny',
            Action: [...VERIFY_PROGRESS_WRITE_ACTIONS],
            Resource: `${results}/${VERIFY_PROGRESS_PREFIX}*`,
            Condition: fromTheExportFunctionOnly,
          },
          {
            Sid: 'OnlyTheExportFunctionReadsTheLoginSecret',
            Effect: 'Deny',
            Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            Resource: loginSecret('??????'),
            Condition: fromTheExportFunctionOnly,
          },
          {
            Sid: 'OnlyTheExportFunctionReadsAndWritesTheBatches',
            Effect: 'Deny',
            Action: ['s3:PutObject', 's3:GetObject'],
            Resource: [`${archive}/db/*`, `${archive}/checks/*`],
            Condition: fromTheExportFunctionOnly,
          },
        ]);
      });

      it('names the secret exactly as the read grant does, with the same two actions', () => {
        const onTheSecret = (effect: string) => roleStatements(template, roleOf(fn))
          .filter((s: any) => s.Effect === effect && [s.Action].flat().some((a: string) => a.startsWith('secretsmanager:')));
        const grants = onTheSecret('Allow');
        expect(grants).toHaveLength(1);
        const denies = onTheSecret('Deny');
        expect(denies.map((s: any) => s.Resource)).toEqual([grants[0].Resource]);
        expect(denies.map((s: any) => [s.Action].flat().sort())).toEqual([[grants[0].Action].flat().sort()]);
      });

      it('lets the export function read its secret, and read and write its batches', () => {
        for (const [action, resource] of uses) {
          expect([action, resource, roleDenies({ sourceFunctionArn: exportFunctionArn, action, resource })]).toEqual([action, resource, false]);
        }
      });

      it.each([
        ['another function given the role, in any region', otherFunctionArn],
        ['a call that carries no source function, as from credentials used outside a function', undefined],
      ])('refuses them to %s', (_who, sourceFunctionArn) => {
        for (const [action, resource] of uses) {
          expect([action, resource, roleDenies({ sourceFunctionArn, action, resource })]).toEqual([action, resource, true]);
        }
      });

      it('leaves the listings and the audit key alone', () => {
        const leftAlone: Array<[string, string]> = [
          ['s3:ListBucket', archive],
          ['s3:ListBucketVersions', archive],
          ['kms:Decrypt', KEY],
          ['kms:GenerateDataKey', KEY],
        ];
        for (const [action, resource] of leftAlone) {
          expect([action, resource, roleDenies({ sourceFunctionArn: otherFunctionArn, action, resource })]).toEqual([action, resource, false]);
        }
      });

      it('never denies a KMS, logs, X-Ray or EC2 action, which S3 and the Lambda service use the role for', () => {
        const denies = roleStatements(template, roleOf(fn)).filter((s: any) => s.Effect === 'Deny');
        // Not vacuous: the policy's three statements.
        expect(denies.length).toBeGreaterThanOrEqual(3);
        // A NotAction would deny every action it does not name.
        expect(denies.filter((s: any) => 'NotAction' in s)).toEqual([]);
        const patterns: string[] = denies.flatMap((s: any) => [s.Action].flat());
        expect(patterns.filter((p) => /^(kms|logs|xray|ec2):/i.test(p))).toEqual([]);
        // Wildcards too: no pattern may match any of these.
        for (const action of [
          'kms:Decrypt', 'kms:GenerateDataKey', 'kms:Encrypt',
          'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents',
          'xray:PutTraceSegments', 'xray:PutTelemetryRecords',
          'ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface',
          'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses',
        ]) {
          expect([action, patterns.filter((p) => wildcard(p.toLowerCase(), action.toLowerCase()))]).toEqual([action, []]);
        }
      });
    });

    it('alarms when no trail check has reported for 26 hours, counting silence as a breach', () => {
      const alarms = Object.values(resourcesOf(template, 'AWS::CloudWatch::Alarm'));
      const topicId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === 'AWS::SNS::Topic');
      // Every completed check reports the stale reading, 0 or 1; a check that
      // could not run or could not read the trail's delivery reports nothing.
      expect(alarms.find((a) => a.Properties.AlarmName === 'JaleAuditTrailCheckMissing')!.Properties).toMatchObject({
        Namespace: 'Jale/Audit',
        MetricName: 'AuditTrailDeliveryStale',
        Statistic: 'SampleCount',
        Period: 3600,
        EvaluationPeriods: 26,
        DatapointsToAlarm: 26,
        Threshold: 1,
        ComparisonOperator: 'LessThanThreshold',
        TreatMissingData: 'breaching',
        AlarmActions: [`\${${topicId}}`],
      });
      // The stale alarm itself still reads the reading's value.
      expect(alarms.find((a) => a.Properties.AlarmName === 'JaleAuditTrailDeliveryStale')!.Properties)
        .toMatchObject({ MetricName: 'AuditTrailDeliveryStale', Statistic: 'Sum', Threshold: 1, TreatMissingData: 'notBreaching' });
      // The metric both alarms read is the one the export job reports.
      expect(fs.readFileSync(path.join(__dirname, '../../../lambda/ops/audit-export.ts'), 'utf8')).toContain("name: 'AuditTrailDeliveryStale'");
    });

    it('purges on its own schedule, so a slow check never holds the purge back', () => {
      const rules = Object.values(resourcesOf(template, 'AWS::Events::Rule')).filter((r) => r.Properties.ScheduleExpression);
      const purge = rules.find((r) => r.Properties.Name === 'jale-audit-export-purge')!.Properties;
      expect(purge.ScheduleExpression).toBe('cron(40 3 * * ? *)');
      expect(JSON.parse(purge.Targets[0].Input)).toEqual({ mode: 'purge' });
      expect(purge.Targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: 8, MaximumEventAgeInSeconds: 7200 });
      const alarms = Object.values(resourcesOf(template, 'AWS::CloudWatch::Alarm'));
      expect(alarms.find((a) => a.Properties.AlarmName === 'JaleAuditPurgeMissing')!.Properties).toMatchObject({
        MetricName: 'AuditPurgeCompleted', Period: 3600, EvaluationPeriods: 26, DatapointsToAlarm: 26, TreatMissingData: 'breaching',
      });
    });
  });

  describe('the sentinel', () => {
    const [, fn] = lambdaByEntry(template, /^Archives the audit log groups/);

    it('has no database access and runs outside the VPC', () => {
      expect(fn.Properties.VpcConfig).toBeUndefined();
      expect(Object.keys(fn.Properties.Environment.Variables)).not.toContain('DB_SECRET_ARN');
    });

    it('writes logs/ and findings/ only with If-None-Match, reads findings/, and publishes to the topic', () => {
      const all = roleStatements(template, roleOf(fn));
      const archive = 'arn:${AWS::Partition}:s3:::jale-audit-archive-${AWS::AccountId}-${AWS::Region}';
      expect(all).toEqual(expect.arrayContaining([
        expect.objectContaining({ Action: 's3:PutObject', Resource: [`${archive}/logs/*`, `${archive}/findings/*`], Condition: { Null: { 's3:if-none-match': 'false' } } }),
        expect.objectContaining({ Action: 's3:GetObject', Resource: `${archive}/findings/*` }),
        // Unconditioned, so a HEAD for a missing finding answers 404, not 403.
        { Sid: 'MissingFindingsAnswerNotFound', Action: 's3:ListBucket', Effect: 'Allow', Resource: archive },
        expect.objectContaining({ Action: 'sns:Publish' }),
      ]));
      expect(all.flatMap((s) => [s.Action].flat()).filter((a: string) => a.startsWith('secretsmanager:'))).toEqual([]);
    });

    it('is configured with the fixed audit names', () => {
      expect(fn.Properties.Environment.Variables).toMatchObject({
        AUDIT_KEY_ALIAS: 'alias/jale-audit',
        AUDIT_BUCKET_PREFIX: 'jale-audit-',
        AUDIT_RULE_PREFIX: 'jale-audit-',
        AUDIT_ROLE_NAMES: 'JaleAuditReader,JaleAuditAdmin',
        AUDIT_LOG_SOURCES: JSON.stringify({ '/jale/audit/fallback': 'fallback', '/jale/audit/ops-command': 'ops-command' }),
        AUDIT_KEY_ARN: KEY,
        AUDIT_ALARM_PREFIX: 'JaleAudit',
      });
    });

    it('names every audit alarm, here and in the edge stacks, with the prefix it watches for changes', () => {
      const prefix = fn.Properties.Environment.Variables.AUDIT_ALARM_PREFIX;
      expect(prefix).toBe('JaleAudit');
      const edges = auditEdgeRegions('us-east-2').map((region) =>
        Template.fromStack(new AuditEdgeStack(new cdk.App(), 'Edge', { env: { region }, mainRegion: 'us-east-2' })).toJSON());
      const names = [template, ...edges].flatMap((t) => Object.values(resourcesOf(t, 'AWS::CloudWatch::Alarm')).map((a) => a.Properties.AlarmName));
      expect(names.length).toBeGreaterThan(20);
      expect(names.filter((name) => typeof name !== 'string' || !name.startsWith(prefix))).toEqual([]);
    });

    it('keeps what it cannot process in a dead-letter queue', () => {
      expect(fn.Properties.DeadLetterConfig.TargetArn).toMatch(/SentinelDeadLetters/);
    });
  });

  describe('the trail', () => {
    const trail = onlyResource(template, 'AWS::CloudTrail::Trail');

    it('logs every region, global services and management events, validated and encrypted, into cloudtrail/', () => {
      expect(trail.Properties).toMatchObject({
        TrailName: 'jale-audit-trail',
        IsLogging: true,
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: true,
        EnableLogFileValidation: true,
        KMSKeyId: KEY,
        S3BucketName: 'jale-audit-archive-${AWS::AccountId}-${AWS::Region}',
        S3KeyPrefix: 'cloudtrail',
      });
    });

    it('records object reads, and only GetObject, on the documents, report-images, support-media and archive buckets', () => {
      const [management, data] = trail.Properties.AdvancedEventSelectors;
      expect(management.FieldSelectors).toEqual([{ Field: 'eventCategory', Equals: ['Management'] }]);
      expect(data.FieldSelectors).toEqual([
        { Field: 'eventCategory', Equals: ['Data'] },
        { Field: 'resources.type', Equals: ['AWS::S3::Object'] },
        { Field: 'eventName', Equals: ['GetObject'] },
        {
          Field: 'resources.ARN',
          StartsWith: [
            'arn:${AWS::Partition}:s3:::jale-worker-documents-${AWS::AccountId}/',
            'arn:${AWS::Partition}:s3:::jale-report-images-${AWS::AccountId}-${AWS::Region}/',
            'arn:${AWS::Partition}:s3:::jale-support-media-${AWS::AccountId}-${AWS::Region}/',
            'arn:${AWS::Partition}:s3:::jale-audit-archive-${AWS::AccountId}-${AWS::Region}/',
          ],
        },
      ]);
    });
  });

  describe('routing', () => {
    const rules = Object.values(resourcesOf(template, 'AWS::Events::Rule')).filter((r) => r.Properties.EventPattern);
    const byName = Object.fromEntries(rules.map((r) => [r.Properties.Name, r.Properties]));

    it('names every rule under the audit prefix, so changes to them alert', () => {
      expect(rules.every((r) => r.Properties.Name.startsWith('jale-audit-'))).toBe(true);
    });

    it("admits every rule that dead-letters to the sentinel's queue in one statement, within SQS's policy size limit", () => {
      // SQS refuses a queue policy over 8,192 bytes. One statement per rule
      // (CDK's default for an event target's dead-letter queue) went over it
      // at 26 statements and failed the stack's create.
      const queueId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === 'AWS::SQS::Queue' && id.startsWith('SentinelDeadLetters'))!;
      const queueArn = `\${${queueId}.Arn}`;
      const policies = Object.values(resourcesOf(template, 'AWS::SQS::QueuePolicy'))
        .filter((p) => JSON.stringify(p.Properties.Queues).includes(queueId));
      expect(policies).toHaveLength(1);
      const document = policies[0].Properties.PolicyDocument;
      const sends = statements(document).filter((st) => st.Effect === 'Allow' && [st.Action].flat().includes('sqs:SendMessage'));
      expect(sends).toHaveLength(1);
      expect(sends[0].Principal).toEqual({ Service: 'events.amazonaws.com' });
      expect(sends[0].Resource).toBe(queueArn);
      const deadLettering = Object.entries(resourcesOf(template, 'AWS::Events::Rule'))
        .filter(([, r]) => (r.Properties.Targets ?? []).some((t: any) => t.DeadLetterConfig?.Arn === queueArn));
      expect(deadLettering.length).toBeGreaterThan(20);
      expect([sends[0].Condition.ArnEquals['aws:SourceArn']].flat().sort())
        .toEqual(deadLettering.map(([id]) => `\${${id}.Arn}`).sort());
      // Rendered with real-length values: each rule's ARN, a long queue ARN, and
      // a 64-character stand-in for anything else, compact as SQS stores it.
      const names = Object.fromEntries(deadLettering.map(([id, r]) => [id, r.Properties.Name as string]));
      const rendered = JSON.stringify(document).replace(/\$\{([A-Za-z0-9:]+)(\.Arn)?\}/g, (_m, id: string, arn?: string) => {
        if (arn && names[id]) return `arn:aws:events:us-west-2:123456789012:rule/${names[id]}`;
        if (arn && id === queueId) return `arn:aws:sqs:us-west-2:123456789012:${'q'.repeat(80)}`;
        return 'x'.repeat(64);
      });
      expect(Buffer.byteLength(rendered)).toBeLessThan(6000);
    });

    it('matches read-only events where it routes reads: secret reads, root use, audit-role assumptions', () => {
      const all = rules.filter((r) => r.Properties.State === 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS').map((r) => r.Properties.Name).sort();
      expect(all).toEqual(['jale-audit-admin-sign-in-failures', 'jale-audit-role-assumptions', 'jale-audit-root', 'jale-audit-secret-reads']);
      expect(rules.filter((r) => r.Properties.State !== 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS').every((r) => r.Properties.State === 'ENABLED')).toBe(true);
    });

    it('routes every event name the rules classify', () => {
      expect(byName['jale-audit-secret-reads'].EventPattern.detail.eventName).toEqual([...SECRET_READ_EVENTS]);
      expect(byName['jale-audit-secret-changes'].EventPattern.detail.eventName).toEqual([...SECRET_CHANGE_EVENTS]);
      expect(byName['jale-audit-database'].EventPattern.detail.eventName).toEqual([...DATABASE_EVENTS]);
      expect(byName['jale-audit-parameters'].EventPattern.detail.eventName).toEqual(expect.arrayContaining([...PARAMETER_EVENTS]));
      for (const [service, names] of Object.entries(AUDIT_SYSTEM_EVENTS)) {
        expect(byName[`jale-audit-system-${service.split('.')[0]}`].EventPattern.detail.eventName).toEqual([...names]);
      }
      expect(byName['jale-audit-role-assumptions'].EventPattern.detail.requestParameters.roleArn)
        .toEqual([{ suffix: ':role/JaleAuditReader' }, { suffix: ':role/JaleAuditAdmin' }]);
    });

    it("routes function changes, versions, aliases and execution roles to the sentinel, by Lambda's versioned event names", () => {
      expect(byName['jale-audit-system-lambda'].EventPattern).toEqual({
        source: ['aws.lambda'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: {
          eventName: [
            { prefix: 'UpdateFunctionCode' }, { prefix: 'UpdateFunctionConfiguration' }, { prefix: 'DeleteFunction' },
            { prefix: 'PutFunctionConcurrency' }, { prefix: 'DeleteFunctionConcurrency' }, { prefix: 'AddPermission' },
            { prefix: 'RemovePermission' }, { prefix: 'PutFunctionEventInvokeConfig' }, { prefix: 'UpdateFunctionEventInvokeConfig' },
            { prefix: 'DeleteFunctionEventInvokeConfig' },
            'PublishVersion20150331', 'CreateAlias20150331', 'UpdateAlias20150331', 'DeleteAlias20150331',
            'CreateFunction20150331', 'UpdateFunctionConfiguration20150331v2',
          ],
        },
      });
      expect(byName['jale-audit-system-lambda'].State).toBe('ENABLED');
    });

    it('routes alarm and queue changes to the sentinel, which alerts on the audit ones', () => {
      expect(byName['jale-audit-system-monitoring'].EventPattern).toEqual({
        source: ['aws.monitoring'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: { eventName: ['PutMetricAlarm', 'PutCompositeAlarm', 'DeleteAlarms', 'DisableAlarmActions', 'EnableAlarmActions', 'SetAlarmState', 'PutAlarmMuteRule'] },
      });
      expect(byName['jale-audit-system-sqs'].EventPattern).toEqual({
        source: ['aws.sqs'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: { eventName: ['SetQueueAttributes', 'PurgeQueue', 'DeleteQueue', 'AddPermission', 'RemovePermission', 'StartMessageMoveTask'] },
      });
      expect([byName['jale-audit-system-monitoring'].State, byName['jale-audit-system-sqs'].State]).toEqual(['ENABLED', 'ENABLED']);
    });

    it('routes changes to the audit rules twice, by two rules with the same pattern and the same target', () => {
      const a = byName['jale-audit-system-events'];
      const b = byName['jale-audit-system-events-b'];
      expect(b).toBeDefined();
      expect(b.EventPattern).toEqual(a.EventPattern);
      expect(b.EventPattern.detail.eventName).toEqual([...AUDIT_SYSTEM_EVENTS['events.amazonaws.com']]);
      expect([a.State, b.State]).toEqual(['ENABLED', 'ENABLED']);
      expect(b.Targets).toEqual(a.Targets);
    });

    it('sends everything to the sentinel, with the dead-letter queue', () => {
      const [sentinelId] = lambdaByEntry(template, /^Archives the audit log groups/);
      for (const r of rules) {
        expect(r.Properties.Targets).toHaveLength(1);
        expect(r.Properties.Targets[0].Arn).toBe(`\${${sentinelId}.Arn}`);
        expect(r.Properties.Targets[0].DeadLetterConfig.Arn).toMatch(/SentinelDeadLetters/);
      }
    });
  });

  describe('admin sign-in failures', () => {
    it('routes failed user-pool sign-ins and second factors to the sentinel', () => {
      const rule = Object.values(resourcesOf(template, 'AWS::Events::Rule')).find((r) => r.Properties.Name === 'jale-audit-admin-sign-in-failures');
      expect(rule.Properties.State).toBe('ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS');
      expect(rule.Properties.EventPattern).toEqual({
        source: ['aws.cognito-idp'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: { eventName: ['InitiateAuth', 'RespondToAuthChallenge'], errorCode: [{ exists: true }] },
      });
    });

    it("lets the sentinel list user pools, which has no resource form, and a pool's app clients, and nothing else in Cognito", () => {
      const [, fn] = lambdaByEntry(template, /^Archives the audit log groups/);
      const cognito = roleStatements(template, roleOf(fn)).filter((s) => [s.Action].flat().some((a: string) => a.startsWith('cognito')));
      expect(cognito).toEqual([
        { Sid: 'FindTheAdminPool', Action: 'cognito-idp:ListUserPools', Effect: 'Allow', Resource: '*' },
        {
          Sid: 'ListTheAdminPoolClients',
          Action: 'cognito-idp:ListUserPoolClients',
          Effect: 'Allow',
          Resource: 'arn:${AWS::Partition}:cognito-idp:${AWS::Region}:${AWS::AccountId}:userpool/*',
        },
      ]);
      expect(fn.Properties.Environment.Variables.AUDIT_ADMIN_POOL_NAME).toBe('jale-admin-pool');
    });

    it('alarms on an unattributed event or an unresolved pool, over a day', () => {
      const alarms = Object.values(resourcesOf(template, 'AWS::CloudWatch::Alarm'));
      for (const metric of ['AuditCognitoEventUnattributed', 'AuditCognitoPoolUnresolved']) {
        expect(alarms.find((a) => a.Properties.MetricName === metric).Properties).toMatchObject({
          AlarmName: `JaleAudit${metric.replace(/^Audit/, '')}`,
          Namespace: 'Jale/Audit',
          Statistic: 'Sum',
          Period: 86400,
          Threshold: 1,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
        });
      }
    });
  });

  describe('the audit roles', () => {
    const roles = Object.values(resourcesOf(template, 'AWS::IAM::Role')).filter((r) => /^JaleAudit/.test(r.Properties.RoleName ?? ''));

    it('trust only the account root, with MFA and the matching principal tag', () => {
      expect(roles.map((r) => r.Properties.RoleName).sort()).toEqual(['JaleAuditAdmin', 'JaleAuditReader']);
      for (const role of roles) {
        const tag = role.Properties.RoleName === 'JaleAuditAdmin' ? 'admin' : 'reader';
        expect(statements(role.Properties.AssumeRolePolicyDocument)).toEqual([{
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { AWS: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root' },
          Condition: {
          Bool: { 'aws:MultiFactorAuthPresent': 'true' },
          StringEquals: {
            'aws:PrincipalTag/jale-audit': tag,
            // Only where an assumption alerts: the main region and the edge regions.
            'aws:RequestedRegion': ['us-east-2', 'us-east-1', 'us-west-2'],
          },
        },
        }]);
        expect(role.Properties.MaxSessionDuration).toBe(3600);
      }
    });
  });

  describe('the sentinel: master secret, app stacks and the edge check', () => {
    const [, fn] = lambdaByEntry(template, /^Archives the audit log groups/);
    const env = fn.Properties.Environment.Variables;

    it('knows the master secret, the ops host stack and the fixed-name deploy policies', () => {
      expect(env).toMatchObject({
        AUDIT_MASTER_SECRET_ARN: 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:JaleDatabaseStackDatabaseS-Example-AbCdEf',
        AUDIT_OPS_HOST_STACK: 'JaleBastionStack',
        AUDIT_DEPLOY_POLICIES: 'JaleDbPostureGate',
      });
    });

    it("knows the export job's role by its name, which it alerts on any function being given", () => {
      const [, exportFn] = lambdaByEntry(template, /^Copies the database audit records/);
      expect(env.AUDIT_EXPORT_ROLE_NAME).toBe(`\${${roleOf(exportFn)}}`);
    });

    it('sets every variable the sentinel reads at start, the export role among them (the composition adds the app stacks)', () => {
      const [, exportFn] = lambdaByEntry(template, /^Copies the database audit records/);
      const saved = process.env;
      try {
        process.env = { ...env, AUDIT_APP_STACKS: 'JaleAuditStack' };
        expect(sentinelConfigFromEnv().config.exportRoleName).toBe(`\${${roleOf(exportFn)}}`);
      } finally {
        process.env = saved;
      }
    });

    it('knows what each edge region must hold', () => {
      expect(env.AUDIT_EDGE_REGIONS).toBe('us-east-1,us-west-2');
      // The rules it expects are built from the table the edge stacks deploy (next test), not carried here.
      expect(env.AUDIT_EDGE_RULES).toBeUndefined();
      expect(env.AUDIT_MAIN_BUS_ARN).toBe('arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:event-bus/default');
      expect(env.AUDIT_EDGE_DLQ_ARNS).toBe(
        '{"us-east-1":"arn:${AWS::Partition}:sqs:us-east-1:${AWS::AccountId}:jale-audit-edge-dead-letters",'
        + '"us-west-2":"arn:${AWS::Partition}:sqs:us-west-2:${AWS::AccountId}:jale-audit-edge-dead-letters"}',
      );
    });

    it('expects, from its own settings, exactly the rules each edge stack deploys: names, states and patterns', () => {
      const saved = process.env;
      let expected: Array<{ name: string; state: string; pattern?: unknown }>;
      try {
        process.env = { ...env, AWS_REGION: 'us-east-2' };
        expected = edgeCheckConfigFromEnv().rules;
      } finally {
        process.env = saved;
      }
      for (const region of auditEdgeRegions('us-east-2')) {
        const app = new cdk.App();
        const edgeTemplate = Template.fromStack(new AuditEdgeStack(app, 'Edge', { env: { region }, mainRegion: 'us-east-2' })).toJSON();
        const deployed = Object.values(resourcesOf(edgeTemplate, 'AWS::Events::Rule'))
          .map((r) => ({ name: r.Properties.Name, state: r.Properties.State, pattern: r.Properties.EventPattern }));
        expect(deployed.sort((a, b) => a.name.localeCompare(b.name)))
          .toEqual([...expected].sort((a, b) => a.name.localeCompare(b.name)));
      }
    });

    it.each([['create'], ['existing'], ['off']] as Array<[ServiceMode]>)(
      "with the detection services %s, expects from its own settings exactly the main region's routes, each to the sentinel with its queue and the event unchanged",
      (mode) => {
        const t = mode === 'create' ? template : synth({ modes: { guardDutyMode: mode, securityHubMode: mode, configMode: mode } });
        const [sentinelId, sentinel] = lambdaByEntry(t, /^Archives the audit log groups/);
        const variables = sentinel.Properties.Environment.Variables;
        expect(variables.AUDIT_ROUTED_FINDINGS).toBe(mode === 'off' ? 'none' : 'guardduty,securityhub');
        const saved = process.env;
        let main: { region: string; rules: Array<{ name: string; state: string; pattern: unknown }>; deadLetterArn: string } | undefined;
        try {
          // Lambda sets AWS_REGION to the function's region, the main one.
          process.env = { ...variables, AWS_REGION: 'us-east-2' };
          main = edgeCheckConfigFromEnv().main;
        } finally {
          process.env = saved;
        }
        expect(main?.region).toBe('us-east-2');
        const queueId = Object.keys(t.Resources).find((id) => t.Resources[id].Type === 'AWS::SQS::Queue' && id.startsWith('SentinelDeadLetters'));
        expect(main!.deadLetterArn).toBe(`\${${queueId}.Arn}`);
        const routes = Object.values(resourcesOf(t, 'AWS::Events::Rule')).filter((r) => r.Properties.EventPattern !== undefined);
        const byRuleName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);
        expect(routes.map((r) => ({ name: r.Properties.Name, state: r.Properties.State, pattern: r.Properties.EventPattern })).sort(byRuleName))
          .toEqual([...main!.rules].sort(byRuleName));
        for (const r of routes) {
          expect(r.Properties.Targets).toHaveLength(1);
          const [target] = r.Properties.Targets;
          expect(target.Arn).toBe(`\${${sentinelId}.Arn}`);
          expect(target.DeadLetterConfig).toEqual({ Arn: main!.deadLetterArn });
          expect([target.Input, target.InputPath, target.InputTransformer]).toEqual([undefined, undefined, undefined]);
        }
      },
    );

    it("may only read the audit rules, the main region's and the edge regions', and the edge queues", () => {
      // Besides its own dead-letter queue (Lambda's asynchronous failures).
      const edge = roleStatements(template, roleOf(fn))
        .filter((s) => [s.Action].flat().some((a: string) => /^(events|sqs):/.test(a)))
        .filter((s) => !JSON.stringify(s.Resource).includes('SentinelDeadLetters'));
      expect(edge.map(({ Sid: _s, ...rest }: any) => rest)).toEqual([
        {
          Action: ['events:DescribeRule', 'events:ListTargetsByRule'],
          Effect: 'Allow',
          Resource: 'arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:rule/jale-audit-*',
        },
        {
          Action: ['events:DescribeRule', 'events:ListTargetsByRule'],
          Effect: 'Allow',
          Resource: [
            'arn:${AWS::Partition}:events:us-east-1:${AWS::AccountId}:rule/jale-audit-edge-*',
            'arn:${AWS::Partition}:events:us-west-2:${AWS::AccountId}:rule/jale-audit-edge-*',
          ],
        },
        {
          Action: 'sqs:GetQueueAttributes',
          Effect: 'Allow',
          Resource: [
            'arn:${AWS::Partition}:sqs:us-east-1:${AWS::AccountId}:jale-audit-edge-dead-letters',
            'arn:${AWS::Partition}:sqs:us-west-2:${AWS::AccountId}:jale-audit-edge-dead-letters',
          ],
        },
      ]);
    });

    it('runs the edge check daily and alarms on a problem or a missing check', () => {
      const rule = Object.values(resourcesOf(template, 'AWS::Events::Rule')).find((r) => r.Properties.Name === 'jale-audit-edge-check')!.Properties;
      expect(rule.ScheduleExpression).toBe('cron(0 4 * * ? *)');
      expect(JSON.parse(rule.Targets[0].Input)).toEqual({ check: 'edge' });
      const alarms = Object.values(resourcesOf(template, 'AWS::CloudWatch::Alarm'));
      expect(alarms.find((a) => a.Properties.AlarmName === 'JaleAuditEdgeCheckFailed')!.Properties)
        .toMatchObject({ MetricName: 'AuditEdgeCheckFailed', Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold' });
      expect(alarms.find((a) => a.Properties.AlarmName === 'JaleAuditEdgeCheckMissing')!.Properties)
        .toMatchObject({ MetricName: 'AuditEdgeCheckCompleted', Period: 3600, EvaluationPeriods: 26, TreatMissingData: 'breaching' });
    });
  });

  describe('Athena', () => {
    it('has the workgroup, with KMS-encrypted results in their own expiring bucket', () => {
      const wg = onlyResource(template, 'AWS::Athena::WorkGroup');
      expect(wg.Properties.Name).toBe('jale-audit');
      expect(wg.Properties.WorkGroupConfiguration.EnforceWorkGroupConfiguration).toBe(true);
      expect(wg.Properties.WorkGroupConfiguration.ResultConfiguration.EncryptionConfiguration).toEqual({ EncryptionOption: 'SSE_KMS', KmsKey: KEY });
      const results = Object.values(resourcesOf(template, 'AWS::S3::Bucket'))
        .find((b) => b.Properties.BucketName === 'jale-audit-query-results-${AWS::AccountId}-${AWS::Region}');
      expect(results.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays).toBe(30);
    });

    it('catalogs every export stream and the trail with partition projection', () => {
      const tables = Object.values(resourcesOf(template, 'AWS::Glue::Table')).map((t) => t.Properties.TableInput);
      const byName = Object.fromEntries(tables.map((t) => [t.Name, t]));
      expect(Object.keys(byName).sort()).toEqual([
        'cloudtrail',
        'db_admin_actions_legacy', 'db_admin_actions_legacy_releases',
        'db_changes', 'db_changes_releases',
        'db_events', 'db_events_releases',
      ]);
      for (const stream of ['events', 'changes', 'admin_actions_legacy']) {
        const projected = byName[`db_${stream}`];
        expect(projected.PartitionKeys).toEqual([{ Name: 'dt', Type: 'string' }]);
        expect(projected.Parameters).toMatchObject({
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'storage.location.template': `s3://jale-audit-archive-\${AWS::AccountId}-\${AWS::Region}/db/${stream}/dt=\${dt}/`,
        });
        expect(projected.StorageDescriptor.SerdeInfo.SerializationLibrary).toBe('org.openx.data.jsonserde.JsonSerDe');
        const releases = byName[`db_${stream}_releases`];
        expect(releases.PartitionKeys).toEqual([]);
        expect(releases.StorageDescriptor.Location).toBe(`s3://jale-audit-archive-\${AWS::AccountId}-\${AWS::Region}/db/${stream}/releases/`);
        expect(releases.StorageDescriptor.Columns).toEqual(projected.StorageDescriptor.Columns);
      }
      expect(byName.db_admin_actions_legacy.StorageDescriptor.Columns.map((c: any) => `${c.Name} ${c.Type}`)).toEqual([
        'seq bigint', 'id string', 'xact string', 'created_at string', 'actor_admin_id string',
        'actor_role string', 'action string', 'target_type string', 'target_id string', 'before_state string',
        'after_state string', 'pii_reveal boolean', 'metadata string',
      ]);
      expect(byName.db_events.Parameters['storage.location.template'])
        .toBe('s3://jale-audit-archive-${AWS::AccountId}-${AWS::Region}/db/events/dt=${dt}/');
      expect(byName.cloudtrail.Parameters['storage.location.template'])
        .toBe('s3://jale-audit-archive-${AWS::AccountId}-${AWS::Region}/cloudtrail/AWSLogs/${AWS::AccountId}/CloudTrail/${region}/${timestamp}');
      expect(byName.cloudtrail.StorageDescriptor.Columns.find((c: any) => c.Name === 'useridentity').Type).toMatch(/^struct<type:string,/);
    });

    it('splits columns at top-level commas only', () => {
      expect(glueColumns('a string, b struct<x:string,y:array<string>>, c int')).toEqual([
        { name: 'a', type: 'string' }, { name: 'b', type: 'struct<x:string,y:array<string>>' }, { name: 'c', type: 'int' },
      ]);
    });
  });

  describe('the detection services and their required flags', () => {
    it.each(SERVICE_MODE_FLAGS.map((flag) => [flag]))('fails to synthesize production without %s', (flag) => {
      expect(() => synth({ modes: { [flag]: undefined } })).toThrow(`AUDIT_MODE_REQUIRED: pass -c ${flag}=create|existing|off`);
    });

    it('refuses any other value', () => {
      expect(() => synth({ modes: { guardDutyMode: 'yes' as ServiceMode } })).toThrow('AUDIT_MODE_INVALID');
    });

    it('refuses Security Hub without a Config recorder', () => {
      expect(() => synth({ modes: { securityHubMode: 'existing', configMode: 'off' } })).toThrow('AUDIT_MODE_INVALID');
    });

    it('creates a detector with RDS login monitoring, the hub with the foundational standard, and a recorder, on create', () => {
      expect(onlyResource(template, 'AWS::GuardDuty::Detector').Properties.Features).toEqual([{ Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' }]);
      expect(onlyResource(template, 'AWS::SecurityHub::Hub').Properties.EnableDefaultStandards).toBe(false);
      expect(onlyResource(template, 'AWS::SecurityHub::Standard').Properties.StandardsArn)
        .toBe('arn:${AWS::Partition}:securityhub:${AWS::Region}::standards/aws-foundational-security-best-practices/v/1.0.0');
      expect(onlyResource(template, 'AWS::Config::ConfigurationRecorder').Properties.RecordingMode).toEqual({ RecordingFrequency: 'DAILY' });
      const configBucket = Object.values(resourcesOf(template, 'AWS::S3::Bucket')).find((b) => /config/.test(b.Properties.BucketName));
      expect(configBucket.Properties.ObjectLockEnabled).toBeUndefined();
    });

    it('creates the recorder and the delivery channel side by side, each after the bucket policy only', () => {
      // The recorder's create starts recording, which needs a delivery channel;
      // the channel's create needs a recorder. Either one waiting on the other
      // deadlocks: the create failed with NotStabilized (no channel to start).
      const ids = (type: string) => Object.keys(template.Resources).filter((id) => template.Resources[id].Type === type);
      const [recorderId] = ids('AWS::Config::ConfigurationRecorder');
      const [channelId] = ids('AWS::Config::DeliveryChannel');
      const bucketId = Object.keys(template.Resources).find((id) => /^ConfigBucket[0-9A-F]{8}$/.test(id))!;
      const policyId = ids('AWS::S3::BucketPolicy').find((id) => JSON.stringify(template.Resources[id].Properties.Bucket).includes(bucketId))!;
      const dependsOn = (id: string) => [template.Resources[id].DependsOn ?? []].flat();
      expect(dependsOn(recorderId)).not.toContain(channelId);
      expect(dependsOn(channelId)).not.toContain(recorderId);
      expect(dependsOn(recorderId)).toContain(policyId);
      expect(dependsOn(channelId)).toContain(policyId);
      expect(JSON.stringify(template.Resources[channelId].Properties)).not.toContain(recorderId);
    });

    describe("the recorder on Config's service-linked role", () => {
      const SERVICE_LINKED_ROLE = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig';
      const ids = (type: string) => Object.keys(template.Resources).filter((id) => template.Resources[id].Type === type);
      const dependsOn = (id: string) => [template.Resources[id].DependsOn ?? []].flat() as string[];
      const roleResourceId = (): string => {
        const found = ids('Custom::AWS').filter((id) => /^ConfigServiceLinkedRole[0-9A-F]{8}$/.test(id));
        expect(found).toHaveLength(1);
        return found[0];
      };

      it('records with the service-linked role', () => {
        expect(onlyResource(template, 'AWS::Config::ConfigurationRecorder').Properties.RoleARN).toBe(SERVICE_LINKED_ROLE);
      });

      it('gives Config no role of its own to assume', () => {
        const trusting = Object.entries(resourcesOf(template, 'AWS::IAM::Role'))
          .filter(([, role]) => JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes('config.amazonaws.com'))
          .map(([id]) => id);
        expect(trusting).toEqual([]);
      });

      it('has the recorder wait for the service-linked role, and the delivery channel not', () => {
        const role = roleResourceId();
        const [recorderId] = ids('AWS::Config::ConfigurationRecorder');
        const [channelId] = ids('AWS::Config::DeliveryChannel');
        expect(dependsOn(recorderId)).toContain(role);
        expect(dependsOn(channelId).filter((id) => id.startsWith('ConfigServiceLinkedRole'))).toEqual([]);
      });

      it('creates the role through IAM, accepts one that already exists, and never deletes it', () => {
        const props = resourcesOf(template, 'Custom::AWS')[roleResourceId()].Properties;
        expect(JSON.parse(props.Create)).toEqual({
          service: 'IAM',
          action: 'createServiceLinkedRole',
          parameters: { AWSServiceName: 'config.amazonaws.com' },
          physicalResourceId: { id: 'config-slr' },
          ignoreErrorCodesMatching: 'InvalidInput.*',
        });
        expect(props.InstallLatestAwsSdk).toBe(false);
        expect(props.Update).toBeUndefined();
        expect(props.Delete).toBeUndefined();
      });

      it('may create that one role, for Config only, and nothing else', () => {
        const policyId = Object.keys(template.Resources).find((id) => /^ConfigServiceLinkedRoleCustomResourcePolicy[0-9A-F]{8}$/.test(id));
        expect(policyId).toBeDefined();
        expect(statements(flatten(template.Resources[policyId!].Properties.PolicyDocument))).toEqual([{
          Action: 'iam:CreateServiceLinkedRole',
          Condition: { StringEquals: { 'iam:AWSServiceName': 'config.amazonaws.com' } },
          Effect: 'Allow',
          Resource: SERVICE_LINKED_ROLE,
        }]);
      });

      it('keeps the bucket policy the service-linked role delivers through', () => {
        const bucketId = Object.keys(template.Resources).find((id) => /^ConfigBucket[0-9A-F]{8}$/.test(id))!;
        const policy = Object.values(resourcesOf(template, 'AWS::S3::BucketPolicy'))
          .find((p) => JSON.stringify(p.Properties.Bucket).includes(bucketId));
        const sids = statements(policy.Properties.PolicyDocument).map((st: any) => st.Sid);
        expect(sids).toEqual(expect.arrayContaining(['ConfigBucketPermissionsCheck', 'ConfigBucketDelivery']));
      });
    });

    it('creates none of them on existing, and still routes their findings', () => {
      const t = synth({ modes: { guardDutyMode: 'existing', securityHubMode: 'existing', configMode: 'existing' } });
      for (const type of ['AWS::GuardDuty::Detector', 'AWS::SecurityHub::Hub', 'AWS::SecurityHub::Standard', 'AWS::Config::ConfigurationRecorder']) {
        expect(Object.keys(resourcesOf(t, type))).toEqual([]);
      }
      const names = Object.values(resourcesOf(t, 'AWS::Events::Rule')).map((r) => r.Properties.Name);
      expect(names).toEqual(expect.arrayContaining(['jale-audit-guardduty-findings', 'jale-audit-securityhub-findings']));
    });

    it('creates and routes nothing for them on off', () => {
      const t = synth({ modes: { guardDutyMode: 'off', securityHubMode: 'off', configMode: 'off' } });
      const names = Object.values(resourcesOf(t, 'AWS::Events::Rule')).map((r) => r.Properties.Name);
      expect(names).not.toContain('jale-audit-guardduty-findings');
      expect(names).not.toContain('jale-audit-securityhub-findings');
    });

    it('treats an unset flag as off outside production', () => {
      const t = synth({ environment: 'dev', modes: { guardDutyMode: undefined, securityHubMode: undefined, configMode: undefined } });
      expect(Object.keys(resourcesOf(t, 'AWS::GuardDuty::Detector'))).toEqual([]);
    });
  });

  describe('public sharing of Systems Manager documents', () => {
    const SETTING = 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:servicesetting/ssm/documents/console/public-sharing-permission';
    const blockerIn = (t: any): [string, any] => {
      const found = Object.entries(resourcesOf(t, 'Custom::AWS')).filter(([id]) => /^BlockPublicSsmDocumentSharing[0-9A-F]{8}$/.test(id));
      expect(found).toHaveLength(1);
      return found[0] as [string, any];
    };

    it('is turned off on create and again on every update, and left off when the resource is removed', () => {
      const [, blocker] = blockerIn(template);
      const call = {
        service: 'SSM',
        action: 'updateServiceSetting',
        parameters: { SettingId: SETTING, SettingValue: 'Disable' },
        physicalResourceId: { id: 'ssm-public-sharing-disabled' },
      };
      expect(blocker.Properties.Create).toBeDefined();
      expect(JSON.parse(blocker.Properties.Create)).toEqual(call);
      expect(blocker.Properties.Update).toBeDefined();
      expect(JSON.parse(blocker.Properties.Update)).toEqual(call);
      expect('Delete' in blocker.Properties).toBe(false);
      expect(blocker.Properties.InstallLatestAwsSdk).toBe(false);
    });

    it('may read and change that one setting, and nothing else', () => {
      const [id] = blockerIn(template);
      const policyId = Object.keys(template.Resources).find((key) => key.startsWith(`${id.slice(0, -8)}CustomResourcePolicy`));
      expect(policyId).toBeDefined();
      expect(statements(flatten(template.Resources[policyId!].Properties.PolicyDocument))).toEqual([{
        Action: ['ssm:UpdateServiceSetting', 'ssm:GetServiceSetting'],
        Effect: 'Allow',
        Resource: SETTING,
      }]);
    });

    it('is turned off whatever the detection services are set to', () => {
      blockerIn(synth({ modes: { guardDutyMode: 'off', securityHubMode: 'off', configMode: 'off' } }));
    });

    it('runs the call in a provider function on Node 24', () => {
      const [, blocker] = blockerIn(template);
      const providerId = /^\$\{(.+)\.Arn\}$/.exec(blocker.Properties.ServiceToken)![1];
      expect(template.Resources[providerId]).toMatchObject({ Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs24.x' } });
    });
  });

  describe('the engine log group (window deploy 2)', () => {
    it('does not exist before window 2', () => {
      for (const window of [0, 1] as AuditEngineWindow[]) {
        const groups = Object.values(resourcesOf(synth({ window }), 'AWS::Logs::LogGroup')).map((g) => g.Properties.LogGroupName);
        expect(groups.filter((n) => typeof n === 'string' && n.startsWith('/aws/rds/'))).toEqual([]);
      }
    });

    it('from window 2: encrypted, 400 days, kept, subscribed to the sentinel and value-scanned', () => {
      const t = synth({ window: 2 });
      const engine = Object.values(resourcesOf(t, 'AWS::Logs::LogGroup')).find((g) => g.Properties.LogGroupName === '/aws/rds/instance/example-instance/postgresql');
      expect(engine).toMatchObject({ DeletionPolicy: 'Retain', Properties: { KmsKeyId: KEY, RetentionInDays: 400 } });
      expect(Object.values(resourcesOf(t, 'AWS::Logs::SubscriptionFilter'))).toHaveLength(3);
      const metrics = Object.values(resourcesOf(t, 'AWS::Logs::MetricFilter')).map((f) => f.Properties.MetricTransformations[0].MetricName);
      expect(metrics.filter((m) => m === 'AuditEngineValueHits')).toHaveLength(3);
      const alarms = Object.values(resourcesOf(t, 'AWS::CloudWatch::Alarm')).map((a) => a.Properties.AlarmName);
      expect(alarms).toContain('JaleAuditEngineValueHits');
    });
  });
});

describe('JaleAuditEdgeStack', () => {
  function edge(region: string, main = 'us-east-2'): any {
    const app = new cdk.App();
    return Template.fromStack(new AuditEdgeStack(app, 'Edge', { env: { region }, mainRegion: main })).toJSON();
  }

  it.each([['us-east-1'], ['us-west-2']])('in %s, forwards identity, sign-in, root, role-assumption, rule-change and function-role events to the main bus', (region) => {
    const t = edge(region);
    const rules = Object.values(resourcesOf(t, 'AWS::Events::Rule'));
    expect(rules.map((r) => r.Properties.Name).sort()).toEqual(EDGE_RULES.map((r) => r.name).sort());
    const queue = onlyResource(t, 'AWS::SQS::Queue');
    expect(queue.Properties.QueueName).toBe('jale-audit-edge-dead-letters');
    const queueId = Object.keys(t.Resources).find((id) => t.Resources[id].Type === 'AWS::SQS::Queue');
    for (const r of rules) {
      expect(r.Properties.Targets).toHaveLength(1);
      expect(r.Properties.Targets[0].Arn).toBe('arn:${AWS::Partition}:events:us-east-2:${AWS::AccountId}:event-bus/default');
      // A bus in another region is a target only with a role; what it cannot deliver is kept.
      expect(r.Properties.Targets[0].RoleArn).toMatch(/^\$\{.+\.Arn\}$/);
      expect(r.Properties.Targets[0].DeadLetterConfig).toEqual({ Arn: `\${${queueId}.Arn}` });
    }
    expect(rules.filter((r) => r.Properties.State === 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS').map((r) => r.Properties.Name).sort())
      .toEqual(['jale-audit-edge-role-assumptions', 'jale-audit-edge-root']);
    const changes = rules.filter((r) => /rule-changes/.test(r.Properties.Name));
    expect(changes).toHaveLength(2);
    for (const r of changes) expect(r.Properties.EventPattern.source).toEqual(['aws.events']);
  });

  it.each([['us-east-1'], ['us-west-2']])("in %s, forwards every function created or given a role, for the sentinel to find the export job's", (region) => {
    const t = edge(region);
    const rule = Object.values(resourcesOf(t, 'AWS::Events::Rule')).find((r) => r.Properties.Name === 'jale-audit-edge-function-roles')!;
    expect(Object.values(resourcesOf(t, 'AWS::CloudWatch::Alarm')).map((a) => a.Properties.AlarmName))
      .toContain('JaleAuditEdgeFailedInvocations-jale-audit-edge-function-roles');
    expect(rule.Properties.EventPattern).toEqual({
      source: ['aws.lambda'],
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: { eventName: ['CreateFunction20150331', 'UpdateFunctionConfiguration20150331v2'] },
    });
    expect(rule.Properties.State).toBe('ENABLED');
    // On the main bus, the audit stack's function rule routes each of them on to the sentinel.
    const main = Object.values(resourcesOf(template, 'AWS::Events::Rule')).find((r) => r.Properties.Name === 'jale-audit-system-lambda')!;
    for (const name of rule.Properties.EventPattern.detail.eventName) expect(main.Properties.EventPattern.detail.eventName).toContain(name);
  });

  it.each([['us-east-1'], ['us-west-2']])('in %s, forwards changes to alarms and queues, for the sentinel to alert on its own', (region) => {
    const t = edge(region);
    const rule = Object.values(resourcesOf(t, 'AWS::Events::Rule')).find((r) => r.Properties.Name === 'jale-audit-edge-alarms-and-queues')!;
    expect(rule.Properties.EventPattern).toEqual({
      source: ['aws.monitoring', 'aws.sqs'],
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: {
        eventName: [
          'PutMetricAlarm', 'PutCompositeAlarm', 'DeleteAlarms', 'DisableAlarmActions', 'EnableAlarmActions', 'SetAlarmState', 'PutAlarmMuteRule',
          'SetQueueAttributes', 'PurgeQueue', 'DeleteQueue', 'AddPermission', 'RemovePermission', 'StartMessageMoveTask',
        ],
      },
    });
    expect(rule.Properties.State).toBe('ENABLED');
    expect(Object.values(resourcesOf(t, 'AWS::CloudWatch::Alarm')).map((a) => a.Properties.AlarmName))
      .toContain('JaleAuditEdgeFailedInvocations-jale-audit-edge-alarms-and-queues');
  });

  it('alarms locally on every failed forward and on its dead-letter queue', () => {
    const alarms = Object.values(resourcesOf(edge('us-west-2'), 'AWS::CloudWatch::Alarm')).map((a) => a.Properties);
    expect(alarms.map((a) => a.AlarmName).sort()).toEqual([
      'JaleAuditEdgeDeadLetters',
      ...EDGE_RULES.map((r) => `JaleAuditEdgeFailedInvocations-${r.name}`),
    ].sort());
    for (const a of alarms.filter((x) => x.MetricName === 'FailedInvocations')) expect(a.Namespace).toBe('AWS/Events');
  });

  it('carries no account id', () => {
    expect(JSON.stringify(edge('us-east-1'))).not.toMatch(/(?<![A-Za-z0-9])\d{12}(?![A-Za-z0-9])/);
  });

  it('exists in every edge region but the main one, and never forwards to its own region', () => {
    expect(auditEdgeRegions('us-east-2')).toEqual(['us-east-1', 'us-west-2']);
    expect(auditEdgeRegions('us-east-1')).toEqual(['us-west-2']);
    expect(auditEdgeRegions('us-west-2')).toEqual(['us-east-1']);
    expect(needsAuditEdgeStack('us-east-1', 'us-east-1')).toBe(false);
    expect(() => edge('us-west-2', 'us-west-2')).toThrow('AUDIT_EDGE_MAIN_REGION');
  });

  it('refuses a main region that is not a region name', () => {
    expect(() => edge('us-east-1', '${Token[AWS.Region.1]}')).toThrow('AUDIT_EDGE_MAIN_REGION');
  });
});
