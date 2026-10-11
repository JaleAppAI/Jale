import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { PUBLIC_REPORTS_LOGIN, ReportsStack, publicIntakeReservedConcurrency } from '../../../lib/stacks/reports-stack';
import { dbLoginSecretName } from '../../../lib/constructs/db-login-secrets';
import { loadManifest, type AccessManifest } from '../../../db/access/access-manifest';

const ALARM_TOPIC_ARN = 'arn:aws:sns:us-east-2:111122223333:jale-alarms';
const ALLOWED_ORIGIN = 'https://jaleapp.ai';

/**
 * The signed-out intake login's connection limit, read straight from its
 * manifest fragment rather than through the stack's own lookup.
 */
function publicReportsConnectionLimit(): number {
  const fragment = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../db/access/manifest.d/reports.json'), 'utf8'));
  return fragment.logins.jale_api_public_reports.connection_limit;
}

type Json = any;

interface Built {
  app: cdk.App;
  api: ApiStack;
  reports: ReportsStack;
  template: Template;
  apiTemplate: Template;
}

function build(environment: string): Built {
  const app = new cdk.App({ context: { environment, otpSmsFromNumber: '+13252210992' } });
  const network = new NetworkStack(app, 'TestNetworkStack');
  const database = new DatabaseStack(app, 'TestDatabaseStack', { network });
  const auth = new AuthStack(app, 'TestAuthStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
  });
  const ai = new AiStack(app, 'TestAiStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    aiDbSecret: database.aiDbSecret,
    alarmTopicArn: ALARM_TOPIC_ARN,
  });
  const api = new ApiStack(app, 'TestApiStack', {
    workerPool: auth.workerPool,
    employerPool: auth.employerPool,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    aliasGeneratorFn: ai.aliasGeneratorFn.function,
    whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
  });
  const reports = new ReportsStack(app, 'TestReportsStack', {
    network,
    api,
    allowedOrigin: ALLOWED_ORIGIN,
    workerUserPoolId: auth.workerPool.userPool.userPoolId,
    employerUserPoolId: auth.employerPool.userPool.userPoolId,
    alarmTopicArn: ALARM_TOPIC_ARN,
  });
  return {
    app,
    api,
    reports,
    template: Template.fromStack(reports),
    apiTemplate: Template.fromStack(api),
  };
}

describe('ReportsStack', () => {
  let built: Built;
  let template: Template;
  let apiTemplate: Template;
  let resources: Record<string, Json>;

  const resolve = (value: unknown): Json => cdk.Stack.of(built.reports).resolve(value);
  const key = (value: unknown): string => JSON.stringify(resolve(value));

  /** The single resource of `type`, by logical id. */
  function only(type: string): [string, Json] {
    const found = Object.entries(resources).filter(([, r]) => r.Type === type);
    expect(found).toHaveLength(1);
    return found[0];
  }

  /** The Lambda whose description is `description`. */
  function lambda(description: string): Json {
    const found = Object.values(resources).filter(
      (r) => r.Type === 'AWS::Lambda::Function' && r.Properties.Description === description,
    );
    expect(found).toHaveLength(1);
    return found[0];
  }

  /**
   * Every S3, KMS and Secrets Manager action the Lambda's role is allowed, as
   * action -> sorted resource list. Other services (X-Ray, the VPC managed
   * policy) are outside what this stack decides.
   */
  function permissions(description: string): Record<string, string[]> {
    const roleId = lambda(description).Properties.Role['Fn::GetAtt'][0];
    const out: Record<string, string[]> = {};
    for (const resource of Object.values(resources)) {
      if (resource.Type !== 'AWS::IAM::Policy') continue;
      if (!resource.Properties.Roles.some((r: Json) => r.Ref === roleId)) continue;
      for (const statement of [resource.Properties.PolicyDocument.Statement].flat()) {
        expect(statement.Effect).toBe('Allow');
        for (const action of [statement.Action].flat() as string[]) {
          if (!/^(s3|kms|secretsmanager):/.test(action)) continue;
          out[action] = [...(out[action] ?? []), ...[statement.Resource].flat().map((r) => JSON.stringify(r))].sort();
        }
      }
    }
    return out;
  }

  const objects = (prefix: string): string => key(built.reports.imagesBucket.arnForObjects(`${prefix}/*`));
  const loginSecret = (login: string): string =>
    expect.stringContaining(`:secret:${dbLoginSecretName(login)}-??????`) as unknown as string;

  beforeAll(() => {
    built = build('production');
    template = built.template;
    apiTemplate = built.apiTemplate;
    resources = template.toJSON().Resources;
  });

  // ── The images bucket and its key ──────────────────────────────────────

  describe('images bucket', () => {
    it('is named from account and region tokens only, so another stack can derive it', () => {
      const [, bucket] = only('AWS::S3::Bucket');
      expect(bucket.Properties.BucketName).toEqual({
        'Fn::Join': ['', ['jale-report-images-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]],
      });
    });

    it('is encrypted with its own rotating key and a bucket key', () => {
      const [keyId, keyResource] = only('AWS::KMS::Key');
      expect(keyResource.Properties.EnableKeyRotation).toBe(true);
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              BucketKeyEnabled: true,
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
                KMSMasterKeyID: { 'Fn::GetAtt': [keyId, 'Arn'] },
              },
            },
          ],
        },
      });
    });

    it('is not versioned, so a deleted image is gone', () => {
      const [, bucket] = only('AWS::S3::Bucket');
      expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
    });

    it('blocks all public access and enforces bucket-owner object ownership', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      });
    });

    it('denies every request that is not over TLS', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Action: 's3:*',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    it('allows only a cross-origin POST, from the web origin only', () => {
      const [, bucket] = only('AWS::S3::Bucket');
      expect(bucket.Properties.CorsConfiguration).toEqual({
        CorsRules: [
          {
            AllowedMethods: ['POST'],
            AllowedOrigins: [ALLOWED_ORIGIN],
            AllowedHeaders: ['Content-Type'],
          },
        ],
      });
    });

    it('expires uploads after 1 day, images after 90 days, and abandoned multipart uploads after 1 day', () => {
      const [, bucket] = only('AWS::S3::Bucket');
      const rules: Json[] = bucket.Properties.LifecycleConfiguration.Rules;
      const strip = (rule: Json) => {
        const { Id: _id, ...rest } = rule;
        return rest;
      };
      expect(rules.map(strip)).toEqual(expect.arrayContaining([
        { Prefix: 'incoming/', ExpirationInDays: 1, Status: 'Enabled' },
        { Prefix: 'images/', ExpirationInDays: 90, Status: 'Enabled' },
        { AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: 'Enabled' },
      ]));
      expect(rules).toHaveLength(3);
    });

    it('retains the bucket and the key outside dev', () => {
      expect(only('AWS::S3::Bucket')[1].DeletionPolicy).toBe('Retain');
      expect(only('AWS::KMS::Key')[1].DeletionPolicy).toBe('Retain');
    });

    it('lets dev tear the bucket and key down', () => {
      const dev = build('dev').template.toJSON().Resources as Record<string, Json>;
      const of = (type: string) => Object.values(dev).filter((r) => r.Type === type);
      expect(of('AWS::S3::Bucket').map((r) => r.DeletionPolicy)).toEqual(['Delete']);
      expect(of('AWS::KMS::Key').map((r) => r.DeletionPolicy)).toEqual(['Delete']);
    });
  });

  // ── The address salt ───────────────────────────────────────────────────

  it('generates the address salt in Secrets Manager, with no value and no fixed name in the template', () => {
    const [, salt] = only('AWS::SecretsManager::Secret');
    expect(salt.Properties.GenerateSecretString).toEqual(
      expect.objectContaining({ PasswordLength: 64, ExcludePunctuation: true }),
    );
    expect(salt.Properties.SecretString).toBeUndefined();
    expect(salt.Properties.Name).toBeUndefined();
  });

  // ── The three Lambdas ──────────────────────────────────────────────────

  describe('Lambdas', () => {
    const INTAKE = 'Report a problem: signed-in intake';
    const PUBLIC_INTAKE = 'Report a problem: signed-out intake';
    const CLEANUP = 'Report a problem: daily clean-up';

    it('runs each one in the VPC on the shared Lambda security group', () => {
      for (const description of [INTAKE, PUBLIC_INTAKE, CLEANUP]) {
        const vpcConfig = lambda(description).Properties.VpcConfig;
        expect(vpcConfig.SecurityGroupIds).toHaveLength(1);
        expect(JSON.stringify(vpcConfig.SecurityGroupIds)).toContain('LambdaSg');
      }
    });

    it('gives each one exactly its expected environment', () => {
      const envOf = (description: string) => lambda(description).Properties.Environment.Variables;
      const intakeKeys = [
        'ALLOWED_ORIGIN',
        'DB_EXPECTED_LOGIN',
        'DB_SECRET_ARN',
        'EMPLOYER_USER_POOL_ID',
        'REPORT_IMAGES_BUCKET',
        'REPORT_IMAGES_KEY_ID',
        'WORKER_USER_POOL_ID',
      ];
      expect(Object.keys(envOf(INTAKE)).sort()).toEqual(intakeKeys);
      expect(Object.keys(envOf(PUBLIC_INTAKE)).sort()).toEqual(
        [...intakeKeys, 'REPORT_ADDRESS_SALT_SECRET_ARN'].sort(),
      );
      expect(Object.keys(envOf(CLEANUP)).sort()).toEqual(
        ['DB_EXPECTED_LOGIN', 'DB_SECRET_ARN', 'REPORT_IMAGES_BUCKET'],
      );
    });

    it('connects each one as its own login, through that login secret name', () => {
      const cases: Array<[string, string]> = [
        [INTAKE, 'jale_api'],
        [PUBLIC_INTAKE, 'jale_api_public_reports'],
        [CLEANUP, 'jale_job_report_cleanup'],
      ];
      for (const [description, login] of cases) {
        const env = lambda(description).Properties.Environment.Variables;
        expect(env.DB_EXPECTED_LOGIN).toBe(login);
        expect(env.DB_SECRET_ARN).toBe(dbLoginSecretName(login));
      }
    });

    it('points the bucket, key, salt, pools and origin variables at the right values', () => {
      const [saltId] = only('AWS::SecretsManager::Secret');
      for (const description of [INTAKE, PUBLIC_INTAKE]) {
        const env = lambda(description).Properties.Environment.Variables;
        expect(env.REPORT_IMAGES_BUCKET).toEqual(resolve(built.reports.imagesBucket.bucketName));
        expect(env.REPORT_IMAGES_KEY_ID).toEqual(resolve(built.reports.imagesKey.keyArn));
        expect(env.ALLOWED_ORIGIN).toBe(ALLOWED_ORIGIN);
        expect(JSON.stringify(env.WORKER_USER_POOL_ID)).toContain('WorkerPool');
        expect(JSON.stringify(env.EMPLOYER_USER_POOL_ID)).toContain('EmployerPool');
      }
      expect(lambda(PUBLIC_INTAKE).Properties.Environment.Variables.REPORT_ADDRESS_SALT_SECRET_ARN)
        .toEqual({ Ref: saltId });
      expect(lambda(CLEANUP).Properties.Environment.Variables.REPORT_IMAGES_BUCKET)
        .toEqual(resolve(built.reports.imagesBucket.bucketName));
    });

    it('gives the clean-up a 120-second timeout and one reserved execution; the signed-in intake is unreserved', () => {
      expect(lambda(CLEANUP).Properties.Timeout).toBe(120);
      expect(lambda(CLEANUP).Properties.ReservedConcurrentExecutions).toBe(1);
      expect(lambda(INTAKE).Properties.ReservedConcurrentExecutions).toBeUndefined();
    });

    it("reserves the signed-out intake exactly its login's connection limit, so a burst is throttled before the database", () => {
      const limit = publicReportsConnectionLimit();
      expect(Number.isInteger(limit) && limit > 0).toBe(true);
      expect(lambda(PUBLIC_INTAKE).Properties.ReservedConcurrentExecutions).toBe(limit);
    });

    it('takes that reservation from the merged access manifest, and refuses a limit that is not a positive whole number', () => {
      expect(publicIntakeReservedConcurrency()).toBe(publicReportsConnectionLimit());
      const merged = loadManifest();
      const withLimit = (limit: unknown): AccessManifest => ({
        ...merged,
        logins: { ...merged.logins, [PUBLIC_REPORTS_LOGIN]: { ...merged.logins[PUBLIC_REPORTS_LOGIN], connection_limit: limit as number } },
      });
      expect(publicIntakeReservedConcurrency(withLimit(7))).toBe(7);
      for (const bad of [-1, 0, 2.5, '10', undefined]) {
        expect(() => publicIntakeReservedConcurrency(withLimit(bad))).toThrow('REPORTS_PUBLIC_LOGIN_LIMIT_INVALID');
      }
      const { [PUBLIC_REPORTS_LOGIN]: _dropped, ...others } = merged.logins;
      expect(() => publicIntakeReservedConcurrency({ ...merged, logins: others })).toThrow('REPORTS_PUBLIC_LOGIN_LIMIT_INVALID');
    });

    it('gives the signed-in intake exactly its storage, key and own-login rights', () => {
      const keyArn = key(built.reports.imagesKey.keyArn);
      expect(permissions(INTAKE)).toEqual({
        's3:PutObject': [objects('images'), objects('incoming')].sort(),
        's3:GetObject': [objects('incoming')],
        's3:DeleteObject': [objects('images'), objects('incoming')].sort(),
        'kms:GenerateDataKey': [keyArn],
        'kms:Encrypt': [keyArn],
        'kms:Decrypt': [keyArn],
        'secretsmanager:GetSecretValue': [loginSecret('jale_api')],
        'secretsmanager:DescribeSecret': [loginSecret('jale_api')],
      });
    });

    it('gives the signed-out intake the same rights on its own login, plus read on the salt', () => {
      const keyArn = key(built.reports.imagesKey.keyArn);
      const [saltId] = only('AWS::SecretsManager::Secret');
      const salt = JSON.stringify({ Ref: saltId });
      expect(permissions(PUBLIC_INTAKE)).toEqual({
        's3:PutObject': [objects('images'), objects('incoming')].sort(),
        's3:GetObject': [objects('incoming')],
        's3:DeleteObject': [objects('images'), objects('incoming')].sort(),
        'kms:GenerateDataKey': [keyArn],
        'kms:Encrypt': [keyArn],
        'kms:Decrypt': [keyArn],
        'secretsmanager:GetSecretValue': [loginSecret('jale_api_public_reports'), salt].sort(),
        'secretsmanager:DescribeSecret': [loginSecret('jale_api_public_reports'), salt].sort(),
      });
    });

    it('lets the clean-up only delete objects under the two prefixes and read its own login', () => {
      expect(permissions(CLEANUP)).toEqual({
        's3:DeleteObject': [objects('images'), objects('incoming')].sort(),
        'secretsmanager:GetSecretValue': [loginSecret('jale_job_report_cleanup')],
        'secretsmanager:DescribeSecret': [loginSecret('jale_job_report_cleanup')],
      });
    });

    it('grants no listing right, and no wildcard storage or key action, anywhere in the stack', () => {
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toMatch(/s3:List/);
      for (const resource of Object.values(resources)) {
        if (resource.Type !== 'AWS::IAM::Policy') continue;
        for (const statement of [resource.Properties.PolicyDocument.Statement].flat()) {
          for (const action of [statement.Action].flat() as string[]) {
            expect(action).not.toMatch(/^(s3|kms):.*\*/);
          }
        }
      }
    });
  });

  // ── Routes (their Methods live in ApiStack's template) ─────────────────

  describe('routes', () => {
    const apiResources = () => apiTemplate.toJSON().Resources as Record<string, Json>;

    function resourceId(pathParts: string[]): string {
      const all = apiResources();
      let parent: string | undefined;
      for (const part of pathParts) {
        const match = Object.entries(all).find(([, r]) => r.Type === 'AWS::ApiGateway::Resource'
          && r.Properties.PathPart === part
          && (parent === undefined ? r.Properties.ParentId['Fn::GetAtt'] !== undefined : r.Properties.ParentId.Ref === parent));
        if (!match) throw new Error(`no resource for /${pathParts.join('/')}`);
        parent = match[0];
      }
      return parent as string;
    }

    function methodsOn(id: string): Record<string, Json> {
      return Object.fromEntries(
        Object.values(apiResources())
          .filter((r) => r.Type === 'AWS::ApiGateway::Method' && r.Properties.ResourceId.Ref === id)
          .map((r) => [r.Properties.HttpMethod, r]),
      );
    }

    it('makes /reports and /public/reports path-only', () => {
      expect(methodsOn(resourceId(['reports']))).toEqual({});
      expect(methodsOn(resourceId(['public', 'reports']))).toEqual({});
    });

    it('serves POST /reports/{action} behind the dual authorizer, to the signed-in intake', () => {
      const methods = methodsOn(resourceId(['reports', '{action}']));
      expect(Object.keys(methods).sort()).toEqual(['OPTIONS', 'POST']);
      expect(methods.POST.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
      expect(methods.POST.Properties.AuthorizerId).toEqual(
        cdk.Stack.of(built.api).resolve(built.api.dualAuthorizer.authorizerId),
      );
      const uri = JSON.stringify(methods.POST.Properties.Integration.Uri);
      expect(uri).toMatch(/ReportIntake/);
      expect(uri).not.toMatch(/PublicReportIntake/);
    });

    it('serves POST and GET /public/reports/{action} with no authorizer, to the signed-out intake', () => {
      const methods = methodsOn(resourceId(['public', 'reports', '{action}']));
      expect(Object.keys(methods).sort()).toEqual(['GET', 'OPTIONS', 'POST']);
      for (const verb of ['GET', 'POST']) {
        expect(methods[verb].Properties.AuthorizationType).toBe('NONE');
        expect(methods[verb].Properties.AuthorizerId).toBeUndefined();
        expect(JSON.stringify(methods[verb].Properties.Integration.Uri)).toMatch(/PublicReportIntake/);
      }
    });

    it('makes ApiStack depend on this stack, never the reverse', () => {
      expect(built.api.dependencies).toContain(built.reports);
      expect(built.reports.dependencies).not.toContain(built.api);
    });
  });

  // ── Schedule ───────────────────────────────────────────────────────────

  it('runs the clean-up from a rule every 24 hours', () => {
    const [, rule] = only('AWS::Events::Rule');
    expect(rule.Properties.ScheduleExpression).toBe('rate(1 day)');
    const cleanupId = Object.entries(resources).find(([, r]) => r.Type === 'AWS::Lambda::Function'
      && r.Properties.Description === 'Report a problem: daily clean-up')![0];
    expect(rule.Properties.Targets).toEqual([
      expect.objectContaining({ Arn: { 'Fn::GetAtt': [cleanupId, 'Arn'] } }),
    ]);
  });

  // ── Alarms ─────────────────────────────────────────────────────────────

  describe('alarms', () => {
    function alarm(name: string): Json {
      const found = Object.values(resources).filter(
        (r) => r.Type === 'AWS::CloudWatch::Alarm' && r.Properties.AlarmName === name,
      );
      expect(found).toHaveLength(1);
      return found[0].Properties;
    }

    const notify = { AlarmActions: [ALARM_TOPIC_ARN] };

    it('alarms on any intake error over 15 minutes', () => {
      expect(alarm('ReportIntakeErrors')).toEqual(expect.objectContaining({
        Namespace: 'Jale/Reports',
        MetricName: 'ReportIntakeErrors',
        Statistic: 'Sum',
        Period: 900,
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        TreatMissingData: 'notBreaching',
        ...notify,
      }));
      expect(alarm('ReportIntakeErrors').Dimensions).toBeUndefined();
    });

    it('alarms on any skipped team email', () => {
      expect(alarm('ReportEmailSkipped')).toEqual(expect.objectContaining({
        Namespace: 'Jale/Reports',
        MetricName: 'ReportEmailSkipped',
        Statistic: 'Sum',
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        ...notify,
      }));
    });

    it('alarms on any failed clean-up', () => {
      expect(alarm('ReportCleanupFailed')).toEqual(expect.objectContaining({
        Namespace: 'Jale/Reports',
        MetricName: 'ReportCleanupFailed',
        Statistic: 'Sum',
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        ...notify,
      }));
    });

    // Pinned whole: these two read DIMENSIONLESS rollups the Lambdas emit
    // beside their dimensioned values. An alarm with
    // no dimensions sees only datapoints published with none.
    it('alarms when no clean-up datapoint has arrived for 26 hours, treating silence as breaching', () => {
      expect(alarm('ReportCleanupMissing')).toEqual({
        AlarmName: 'ReportCleanupMissing',
        AlarmDescription: expect.any(String),
        Namespace: 'Jale/Reports',
        MetricName: 'ReportCleanupDeleted',
        Statistic: 'SampleCount',
        Period: 3600,
        // No DatapointsToAlarm: all 26 periods must breach.
        EvaluationPeriods: 26,
        Threshold: 1,
        ComparisonOperator: 'LessThanThreshold',
        TreatMissingData: 'breaching',
        ...notify,
      });
    });

    it('alarms on a spike of more than 20 reports in 15 minutes', () => {
      expect(alarm('ReportsCreatedSpike')).toEqual({
        AlarmName: 'ReportsCreatedSpike',
        AlarmDescription: expect.any(String),
        Namespace: 'Jale/Reports',
        MetricName: 'ReportsCreated',
        Statistic: 'Sum',
        Period: 900,
        EvaluationPeriods: 1,
        Threshold: 20,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        ...notify,
      });
    });

    it('reads the dimensionless run total for the missing-run alarm and the dimensionless count for the spike', () => {
      // A dimension added to either alarm would point it at a series the
      // dimensionless rollup never feeds: the spike alarm would go silent and
      // the missing-run alarm, with silence breaching, would fire forever.
      for (const name of ['ReportCleanupMissing', 'ReportsCreatedSpike']) {
        const props = alarm(name);
        expect(props.Dimensions).toBeUndefined();
        expect(props.Metrics).toBeUndefined();
        expect(props.ExtendedStatistic).toBeUndefined();
      }
      expect(alarm('ReportCleanupMissing').MetricName).toBe('ReportCleanupDeleted');
      expect(alarm('ReportsCreatedSpike').MetricName).toBe('ReportsCreated');
    });

    it('alarms on any report refused by the global daily cap', () => {
      expect(alarm('ReportRateLimitedGlobal')).toEqual(expect.objectContaining({
        Namespace: 'Jale/Reports',
        MetricName: 'ReportRateLimited',
        Dimensions: [{ Name: 'Scope', Value: 'global' }],
        Statistic: 'Sum',
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        ...notify,
      }));
    });

    it('computes the capture success share as metric math, report-only with no action', () => {
      const props = alarm('ReportCaptureSuccessShare');
      expect(props.AlarmActions).toBeUndefined();
      expect(props.OKActions).toBeUndefined();
      expect(props.ComparisonOperator).toBe('LessThanThreshold');
      expect(props.TreatMissingData).toBe('notBreaching');
      const queries: Json[] = props.Metrics;
      const outcomes = queries
        .filter((q) => q.MetricStat)
        .map((q) => {
          expect(q.MetricStat.Metric.Namespace).toBe('Jale/Reports');
          expect(q.MetricStat.Metric.MetricName).toBe('ReportCapture');
          expect(q.MetricStat.Stat).toBe('Sum');
          expect(q.ReturnData).toBe(false);
          return q.MetricStat.Metric.Dimensions[0].Value;
        })
        .sort();
      expect(outcomes).toEqual(['failed', 'ok', 'timeout']);
      const expression = queries.filter((q) => q.Expression);
      expect(expression).toHaveLength(1);
      expect(expression[0].ReturnData).not.toBe(false);
    });

    it('sends every alarm but the report-only one to the ops topic', () => {
      const alarms = Object.values(resources).filter((r) => r.Type === 'AWS::CloudWatch::Alarm');
      expect(alarms).toHaveLength(7);
      for (const a of alarms) {
        if (a.Properties.AlarmName === 'ReportCaptureSuccessShare') continue;
        expect(a.Properties.AlarmActions).toEqual([ALARM_TOPIC_ARN]);
      }
    });
  });
});
