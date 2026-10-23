import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildJaleApp } from '../../../lib/app-composition';
import { AdminStack, getAdminDurability } from '../../../lib/stacks/admin-stack';

const describeIfDocker = process.env.SKIP_DOCKER_TESTS ? describe.skip : describe;

const ALARM_TOPIC_ARN = 'arn:aws:sns:us-east-1:111111111111:jale-alarms';

interface BuiltAdmin {
  template: Template;
  stack: AdminStack;
  reportImagesBucket: s3.Bucket;
  reportImagesKey: kms.Key;
  supportMediaBucket: s3.Bucket;
  supportMediaKey: kms.Key;
}

function buildAdmin(
  alarmTopicArn?: string,
  extraContext: Record<string, unknown> = {},
  extraProps: Record<string, unknown> = {},
): BuiltAdmin {
  const app = new cdk.App({ context: { environment: 'prod', ...extraContext } });
  const support = new cdk.Stack(app, 'AdminSupportStack', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(support, 'Vpc', { maxAzs: 2 });
  const lambdaSg = new ec2.SecurityGroup(support, 'LambdaSg', { vpc });
  const adminDbSecret = new secretsmanager.Secret(support, 'AdminDbSecret');
  const reportImagesKey = new kms.Key(support, 'ReportImagesKey');
  const reportImagesBucket = new s3.Bucket(support, 'ReportImagesBucket', { encryptionKey: reportImagesKey });
  const supportMediaKey = new kms.Key(support, 'SupportMediaKey');
  const supportMediaBucket = new s3.Bucket(support, 'SupportMediaBucket', { encryptionKey: supportMediaKey });
  const certificate = acm.Certificate.fromCertificateArn(
    support,
    'AdminCert',
    'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000',
  );

  const stack = new AdminStack(app, 'TestAdminStack', {
    env: { account: '111111111111', region: 'us-east-1' },
    domainName: 'example.com',
    hostedZoneId: 'Z1234567890ABC',
    vpc,
    privateSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets,
    lambdaSg,
    adminDbSecret,
    reportImagesBucket,
    reportImagesKey,
    supportMediaBucket,
    supportMediaKey,
    certificate,
    webAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/admin/00000000-0000-0000-0000-000000000000',
    alarmTopicArn,
    ...extraProps,
  });

  return {
    template: Template.fromStack(stack), stack, reportImagesBucket, reportImagesKey, supportMediaBucket, supportMediaKey,
  };
}

describeIfDocker('AdminStack', () => {
  let template: Template;
  let stack: AdminStack;
  let reportImagesBucket: s3.Bucket;
  let reportImagesKey: kms.Key;
  let supportMediaBucket: s3.Bucket;
  let supportMediaKey: kms.Key;

  beforeAll(() => {
    ({
      template, stack, reportImagesBucket, reportImagesKey, supportMediaBucket, supportMediaKey,
    } = buildAdmin(ALARM_TOPIC_ARN));
  });

  test('creates a dedicated admin Cognito user pool and client', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-admin-pool',
      MfaConfiguration: 'ON',
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });

    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  test('creates admin role groups', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'admin_readonly',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'admin_ops',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'admin_superadmin',
    });
  });

  test('creates the admin Next.js Lambda with response streaming Function URL and database access wiring', () => {
    template.hasResourceProperties('AWS::Lambda::Function',
      Match.objectLike({
        PackageType: 'Image',
        MemorySize: 1024,
        Timeout: 30,
        VpcConfig: Match.objectLike({
          SecurityGroupIds: Match.anyValue(),
          SubnetIds: Match.anyValue(),
        }),
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            DB_SECRET_ARN: Match.anyValue(),
          }),
        }),
      }),
    );

    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
      InvokeMode: 'RESPONSE_STREAM',
    });
  });

  test('creates CloudFront distribution and DNS aliases for admin.jaleapp.ai', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          Aliases: ['admin.example.com'],
          Enabled: true,
          WebACLId: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/admin/00000000-0000-0000-0000-000000000000',
        }),
      }),
    );

    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'admin.example.com.',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'admin.example.com.',
    });
  });

  test('creates access logging and operational alarms', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.anyValue(),
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  // The distribution's 5xx alarm lives in FrontendStack, in us-east-1, the
  // one region CloudFront publishes its metrics to.
  test('sends its two alarms to the ops topic, and only their ALARM state', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as any[];
    expect(alarms.map((a) => a.Properties.AlarmName).sort()).toEqual([
      'jale-admin-lambda-errors',
      'jale-admin-lambda-throttles',
    ]);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toEqual([ALARM_TOPIC_ARN]);
      expect(alarm.Properties.OKActions).toBeUndefined();
    }
  });

  // The ops topic arrives as the optional `whatsappAlarmTopicArn` context,
  // which a dev synth may not pass: the alarms still exist, with no action.
  test('keeps its two alarms without an action when no alarm topic is given', () => {
    const alarms = Object.values(buildAdmin().template.findResources('AWS::CloudWatch::Alarm')) as any[];
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toBeUndefined();
    }
  });

  test('retains production identity, logs, and access-log storage for 90 days', () => {
    const resources = template.toJSON().Resources;
    const retainedTypes = new Set([
      'AWS::Cognito::UserPool',
      'AWS::Logs::LogGroup',
      'AWS::S3::Bucket',
    ]);
    for (const resource of Object.values(resources) as any[]) {
      if (!retainedTypes.has(resource.Type)) continue;
      expect(resource.DeletionPolicy).toBe('Retain');
      expect(resource.UpdateReplacePolicy).toBe('Retain');
    }
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 90,
    });
  });

  test('development durability remains disposable', () => {
    expect(getAdminDurability('dev')).toEqual({
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      logRetention: expect.anything(),
      autoDeleteObjects: true,
    });
    expect(getAdminDurability('prod')).toEqual({
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      logRetention: expect.anything(),
      autoDeleteObjects: false,
    });
  });

  // ── Report images: read the attached images, nothing else ──

  /** Every Allow statement on the admin Lambda's role, flattened per action. */
  function adminRolePermissions(t: Template = template): Array<{ action: string; resource: string }> {
    const resources = t.toJSON().Resources as Record<string, any>;
    const fn = Object.values(resources).find((r) => r.Type === 'AWS::Lambda::Function'
      && r.Properties.FunctionName === 'jale-admin-nextjs');
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    const out: Array<{ action: string; resource: string }> = [];
    for (const r of Object.values(resources)) {
      if (r.Type !== 'AWS::IAM::Policy' || !r.Properties.Roles.some((x: any) => x.Ref === roleId)) continue;
      for (const statement of [r.Properties.PolicyDocument.Statement].flat()) {
        expect(statement.Effect).toBe('Allow');
        for (const action of [statement.Action].flat() as string[]) {
          for (const resource of [statement.Resource].flat()) out.push({ action, resource: JSON.stringify(resource) });
        }
      }
    }
    return out;
  }

  test('the admin Lambda can read report images and support media, and nothing else in either bucket', () => {
    const resolve = (value: unknown) => JSON.stringify(cdk.Stack.of(stack).resolve(value));
    const s3Rights = adminRolePermissions().filter((p) => p.action.startsWith('s3:'));
    expect(s3Rights).toEqual([
      { action: 's3:GetObject', resource: resolve(reportImagesBucket.arnForObjects('images/*')) },
      { action: 's3:GetObject', resource: resolve(supportMediaBucket.arnForObjects('support/*')) },
    ]);
    expect(JSON.stringify(s3Rights)).not.toContain('incoming');
  });

  test('the admin Lambda can only decrypt, with the report images and support media keys', () => {
    const resolve = (value: unknown) => JSON.stringify(cdk.Stack.of(stack).resolve(value));
    const kmsRights = adminRolePermissions().filter((p) => p.action.startsWith('kms:'));
    expect(kmsRights).toEqual([
      { action: 'kms:Decrypt', resource: resolve(reportImagesKey.keyArn) },
      { action: 'kms:Decrypt', resource: resolve(supportMediaKey.keyArn) },
    ]);
  });

  test('the admin Lambda is told the support media bucket', () => {
    const resources = template.toJSON().Resources as Record<string, any>;
    const fn = Object.values(resources).find((r) => r.Type === 'AWS::Lambda::Function'
      && r.Properties.FunctionName === 'jale-admin-nextjs');
    expect(fn.Properties.Environment.Variables.SUPPORT_MEDIA_BUCKET)
      .toEqual(cdk.Stack.of(stack).resolve(supportMediaBucket.bucketName));
  });

  // ── Dead-letter queue depth (K3.3 #11): the listed queues' attributes only ──

  // The dead-letter queues with a producer, in the order the Ops page lists
  // them. The candidate materialization and worker rerank queues have none.
  const DLQ = [
    ['whatsapp-inbound-v2-dlq.fifo', 'WhatsApp inbound'],
    ['whatsapp-inbound-dlq', 'WhatsApp inbound (first version)'],
    ['whatsapp-worker-intent-wake-dlq', 'Worker notifications'],
    ['whatsapp-domain-outbox-wake-dlq', 'WhatsApp outbox'],
    ['billing-webhook-dlq', 'Billing webhooks'],
    ['jale-post-confirmation-dlq', 'Sign-up confirmations'],
    ['jale-employer-candidate-rerank-dlq', 'Candidate ranking'],
    ['trust-extraction-dlq', 'Trust answers'],
    ['trust-assessment-dlq', 'Trust scores'],
    ['jale-employer-digest-producer-dlq', 'Employer digest'],
  ] as const;

  test('the admin Lambda can read the depth of exactly the listed dead-letter queues', () => {
    const resolve = (value: unknown) => JSON.stringify(cdk.Stack.of(stack).resolve(value));
    const sqsRights = adminRolePermissions().filter((p) => p.action.startsWith('sqs:'));
    expect(sqsRights).toEqual(DLQ.map(([name]) => ({
      action: 'sqs:GetQueueAttributes',
      resource: resolve(stack.formatArn({ service: 'sqs', resource: name })),
    })));
    expect(JSON.stringify(sqsRights)).not.toMatch(/materialization|worker-rerank|\*/);
  });

  test('the admin Lambda may read CloudWatch metric data, which has no resource-level form', () => {
    const metricRights = adminRolePermissions().filter((p) => p.action.startsWith('cloudwatch:'));
    expect(metricRights).toEqual([{ action: 'cloudwatch:GetMetricData', resource: JSON.stringify('*') }]);
  });

  test('the admin Lambda is told each listed queue by a plain label and its address', () => {
    const resources = template.toJSON().Resources as Record<string, any>;
    const fn = Object.values(resources).find((r) => r.Type === 'AWS::Lambda::Function'
      && r.Properties.FunctionName === 'jale-admin-nextjs');
    const queues = JSON.parse(fn.Properties.Environment.Variables.ADMIN_DLQ_QUEUES);
    expect(queues).toEqual(DLQ.map(([name, label]) => ({
      label,
      url: `https://sqs.${stack.region}.amazonaws.com/${stack.account}/${name}`,
    })));
    for (const { label } of queues) expect(label).not.toMatch(/dlq|arn:|https?:/i);
  });

  // ── The SES feedback dead-letter queue (Home health, K3.4) ──
  // It exists only when the employer email configuration set is named, so
  // the stack is told its name only then.

  const FEEDBACK_DLQ = 'jale-test-employer-email-feedback-dlq';
  const adminFunctionOf = (t: Template): any => Object.values(t.toJSON().Resources as Record<string, any>)
    .find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === 'jale-admin-nextjs');

  test('without the SES feedback queue, the admin Lambda is told no such queue', () => {
    expect(adminFunctionOf(template).Properties.Environment.Variables).not.toHaveProperty('ADMIN_SES_FEEDBACK_DLQ_URL');
    expect(JSON.stringify(adminRolePermissions())).not.toContain('feedback');
  });

  test('with the SES feedback queue, the admin Lambda is told its address and may read its depth too', () => {
    const built = buildAdmin(ALARM_TOPIC_ARN, {}, { sesFeedbackDlqName: FEEDBACK_DLQ });
    const resolve = (value: unknown) => JSON.stringify(cdk.Stack.of(built.stack).resolve(value));
    expect(adminFunctionOf(built.template).Properties.Environment.Variables.ADMIN_SES_FEEDBACK_DLQ_URL)
      .toBe(`https://sqs.${built.stack.region}.amazonaws.com/${built.stack.account}/${FEEDBACK_DLQ}`);
    expect(adminRolePermissions(built.template).filter((p) => p.action.startsWith('sqs:'))).toEqual(
      [...DLQ.map(([name]) => name), FEEDBACK_DLQ].map((name) => ({
        action: 'sqs:GetQueueAttributes',
        resource: resolve(built.stack.formatArn({ service: 'sqs', resource: name })),
      })),
    );
    // The Ops page's list is unchanged: the feedback queue is a Home tile of its own.
    const queues = JSON.parse(adminFunctionOf(built.template).Properties.Environment.Variables.ADMIN_DLQ_QUEUES);
    expect(queues.map((q: { label: string }) => q.label)).toEqual(DLQ.map(([, label]) => label));
  });

  test('refuses an SES feedback queue name SQS would not accept', () => {
    for (const name of ['', 'has space', 'x'.repeat(81), 'a.fifo']) {
      expect(() => buildAdmin(ALARM_TOPIC_ARN, {}, { sesFeedbackDlqName: name })).toThrow(/sesFeedbackDlqName/);
    }
  });

  test('the admin Lambda is told the report images bucket', () => {
    const resources = template.toJSON().Resources as Record<string, any>;
    const fn = Object.values(resources).find((r) => r.Type === 'AWS::Lambda::Function'
      && r.Properties.FunctionName === 'jale-admin-nextjs');
    expect(fn.Properties.Environment.Variables.REPORT_IMAGES_BUCKET)
      .toEqual(cdk.Stack.of(stack).resolve(reportImagesBucket.bucketName));
  });

  test('outputs the admin url and Cognito identifiers', () => {
    template.hasOutput('AdminUrl', {
      Value: 'https://admin.example.com',
    });
    template.hasOutput('AdminUserPoolId', Match.anyValue());
    template.hasOutput('AdminUserPoolClientId', Match.anyValue());
  });
});

/**
 * Sprint 28 (contract K1): the admin pool sends through the shared SES sender,
 * invites with the branded template rendered at synth, remembers trusted
 * browsers only on the server's say-so, and the console may manage this pool's
 * admins and devices, and nothing else.
 */
describeIfDocker('AdminStack admin access (sprint 28)', () => {
  const SES_CONTEXT = { sesEmailFromAddress: 'sender@example.test', sesEmailRegion: 'us-east-1' };
  let ses: BuiltAdmin;
  let plain: BuiltAdmin;

  const poolOf = (built: BuiltAdmin) => {
    const pools = built.template.findResources('AWS::Cognito::UserPool');
    expect(Object.keys(pools)).toHaveLength(1);
    const [[logicalId, pool]] = Object.entries(pools) as Array<[string, any]>;
    return { logicalId, props: pool.Properties as Record<string, any> };
  };

  beforeAll(() => {
    ses = buildAdmin(ALARM_TOPIC_ARN, SES_CONTEXT);
    plain = buildAdmin(ALARM_TOPIC_ARN);
  });

  // Guard: the properties that would REPLACE the pool (and fail mid-deploy
  // against DeletionProtection) stay exactly as they were.
  test('keeps one pool with the same name, logical id, username attributes and no schema or aliases', () => {
    for (const built of [ses, plain]) {
      const { logicalId, props } = poolOf(built);
      expect(logicalId).toMatch(/^AdminUserPool[0-9A-F]{8}$/);
      expect(props.UserPoolName).toBe('jale-admin-pool');
      expect(props.UsernameAttributes).toEqual(['email']);
      expect(props.Schema).toBeUndefined();
      expect(props.AliasAttributes).toBeUndefined();
      expect(props.UsernameConfiguration).toBeUndefined();
    }
  });

  test('sends through the SES sender in context, and through Cognito\'s default without it', () => {
    const { props } = poolOf(ses);
    expect(props.EmailConfiguration.EmailSendingAccount).toBe('DEVELOPER');
    expect(props.EmailConfiguration.From).toBe('Jale <sender@example.test>');
    expect(JSON.stringify(props.EmailConfiguration.SourceArn)).toContain(':identity/example.test');
    expect(poolOf(plain).props.EmailConfiguration).toBeUndefined();
  });

  test('invites with the branded template: each placeholder once, nothing after the password', () => {
    for (const built of [ses, plain]) {
      const template = poolOf(built).props.AdminCreateUserConfig.InviteMessageTemplate;
      expect(template.EmailSubject).toBe("You're invited to the Jale admin console");
      const body: string = template.EmailMessage;
      expect(body.split('{username}')).toHaveLength(2);
      expect(body.split('{####}')).toHaveLength(2);
      expect(body).not.toMatch(/\{####\}\s*\./);
      expect(body).toContain('{####}</td>');
      expect(body).toContain('href="https://admin.example.com"');
      expect(body.length).toBeLessThanOrEqual(20000);
      expect(poolOf(built).props.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(true);
    }
  });

  test('remembers a device only on request, and lets a remembered device stand in for the code', () => {
    expect(poolOf(ses).props.DeviceConfiguration).toEqual({
      ChallengeRequiredOnNewDevice: true,
      DeviceOnlyRememberedOnUserPrompt: true,
    });
  });

  test('states the temporary password\'s 7 days explicitly, as the invitation does', () => {
    expect(poolOf(ses).props.Policies.PasswordPolicy.TemporaryPasswordValidityDays).toBe(7);
  });

  test('lets the console manage this pool\'s admins and devices, on its ARN only', () => {
    const resources = ses.template.toJSON().Resources as Record<string, any>;
    const fn = Object.values(resources).find((r) => r.Type === 'AWS::Lambda::Function'
      && r.Properties.FunctionName === 'jale-admin-nextjs');
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    const statements = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((x: any) => x.Ref === roleId))
      .flatMap((r) => [r.Properties.PolicyDocument.Statement].flat());
    const cognitoStatements = statements.filter((st) => [st.Action].flat().some((a: string) => a.startsWith('cognito-idp:')));
    expect(cognitoStatements).toHaveLength(1);
    const [statement] = cognitoStatements;
    expect(statement.Effect).toBe('Allow');
    expect(statement.Sid).toBe('AdminPoolDirectory');
    expect([statement.Action].flat().sort()).toEqual([
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminForgetDevice',
      'cognito-idp:AdminGetDevice',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListDevices',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:AdminUpdateDeviceStatus',
      'cognito-idp:AdminUserGlobalSignOut',
    ]);
    const { logicalId } = poolOf(ses);
    expect(statement.Resource).toEqual({ 'Fn::GetAtt': [logicalId, 'Arn'] });
    expect(JSON.stringify(statements)).not.toContain('userpool/*');
    // The metric read (cloudwatch:GetMetricData) has no resource-level form,
    // so it is the one statement on "*"; it is pinned on its own above. No
    // other statement of this role names a wildcard.
    const isMetricRead = (st: any) => st.Action === 'cloudwatch:GetMetricData' && st.Resource === '*';
    expect(statements.filter(isMetricRead)).toHaveLength(1);
    expect(JSON.stringify(statements.filter((st) => !isMetricRead(st)))).not.toMatch(/"cognito-idp:\*"|"\*"/);
  });
});

/**
 * G1 (sprint 22 R2-G): the admin pool holds the internal operator accounts and
 * their TOTP enrolments — unrecoverable from any backup — so it takes the same
 * app-global `deletionProtection` context flag as the worker/employer pools and
 * the RDS instance.
 */
describeIfDocker('AdminStack Cognito DeletionProtection', () => {
  const buildTemplate = (deletionProtection?: unknown): Template => {
    // 'production' is the value bin/jale-app.ts accepts and the deploy workflow
    // passes; 'prod' is not a real environment name anywhere in the app.
    const context: Record<string, unknown> = { environment: 'production' };
    if (deletionProtection !== undefined) {
      context.deletionProtection = deletionProtection;
    }
    const app = new cdk.App({ context });
    const support = new cdk.Stack(app, 'AdminSupportStack', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const vpc = new ec2.Vpc(support, 'Vpc', { maxAzs: 2 });
    const lambdaSg = new ec2.SecurityGroup(support, 'LambdaSg', { vpc });
    const adminDbSecret = new secretsmanager.Secret(support, 'AdminDbSecret');
    const reportImagesKey = new kms.Key(support, 'ReportImagesKey');
    const reportImagesBucket = new s3.Bucket(support, 'ReportImagesBucket', { encryptionKey: reportImagesKey });
    const supportMediaKey = new kms.Key(support, 'SupportMediaKey');
    const supportMediaBucket = new s3.Bucket(support, 'SupportMediaBucket', { encryptionKey: supportMediaKey });
    const certificate = acm.Certificate.fromCertificateArn(
      support,
      'AdminCert',
      'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000',
    );
    const stack = new AdminStack(app, 'TestAdminStack', {
      env: { account: '111111111111', region: 'us-east-1' },
      domainName: 'example.com',
      hostedZoneId: 'Z1234567890ABC',
      vpc,
      privateSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets,
      lambdaSg,
      adminDbSecret,
      reportImagesBucket,
      reportImagesKey,
      supportMediaBucket,
      supportMediaKey,
      webAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/admin/00000000-0000-0000-0000-000000000000',
      certificate,
    });
    return Template.fromStack(stack);
  };

  // 'true' is the STRING the CDK CLI hands through for `-c deletionProtection=true`.
  // The no-context row is the fail-safe case: absent must not mean disarmed.
  test.each([
    ['the string CI actually passes', 'true'],
    ['a boolean from cdk.json', true],
    ['no context at all (fail-safe)', undefined],
  ])('the admin pool is ACTIVE with %s', (_label, value) => {
    buildTemplate(value).hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-admin-pool',
      DeletionProtection: 'ACTIVE',
    });
  });

  // Only an explicit false disarms, in either spelling — `-c` values arrive as
  // strings.
  test('the admin pool stays disposable only on an explicit false', () => {
    for (const value of [false, 'false']) {
      const pools = Object.values(buildTemplate(value).findResources('AWS::Cognito::UserPool'));
      expect(pools).toHaveLength(1);
      const props = (pools[0] as { Properties: Record<string, unknown> }).Properties;
      expect(props.DeletionProtection === undefined || props.DeletionProtection === 'INACTIVE')
        .toBe(true);
    }
  });
});

/**
 * The composed app passes the SES feedback queue's name to AdminStack only
 * when NotificationsStack creates that queue, and by the name it is created
 * with: a plain string, so no export joins the two stacks.
 */
describeIfDocker('AdminStack in the composed app: the SES feedback queue', () => {
  const INFRA_ROOT = path.join(__dirname, '../../..');
  const PRODUCTION_LIKE_CONTEXT: Record<string, unknown> = {
    environment: 'production',
    deletionProtection: 'true',
    emailFromAddress: 'billing@example.com',
    sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:111122223333:identity/example.com',
    sesEmailFromAddress: 'no-reply@example.com',
    sesEmailRegion: 'us-east-1',
    whatsappStatusCallbackUrl: 'https://example.com/whatsapp/status-callback',
    whatsappAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
    billingAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
    whatsappInboundV2TransportEnabled: 'true',
    publicSiteBaseUrl: 'https://jaleapp.ai',
    whatsappBusinessNumber: '15551234567',
    guardDutyMode: 'create',
    securityHubMode: 'create',
    configMode: 'create',
    dbSharedPreloadLibrariesDefault: 'pg_stat_statements',
    'aws:cdk:bundling-stacks': [],
  };

  function compose(sesConfigurationSetName: string): Record<string, any> {
    const readJson = (file: string): Record<string, unknown> => {
      const full = path.join(INFRA_ROOT, file);
      return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {};
    };
    const saved = {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
      configurationSet: process.env.JALE_SES_CONFIGURATION_SET_NAME,
    };
    process.env.CDK_DEFAULT_ACCOUNT = '111111111111';
    process.env.CDK_DEFAULT_REGION = 'us-east-2';
    delete process.env.JALE_SES_CONFIGURATION_SET_NAME;
    try {
      const app = new cdk.App({
        context: {
          ...(readJson('cdk.json').context as Record<string, unknown> ?? {}),
          ...readJson('cdk.context.json'),
          ...PRODUCTION_LIKE_CONTEXT,
          sesConfigurationSetName,
        },
      });
      buildJaleApp(app);
      return Object.fromEntries(app.synth().stacks.map((s) => [s.stackName, s.template]));
    } finally {
      for (const [key, name] of [
        ['account', 'CDK_DEFAULT_ACCOUNT'], ['region', 'CDK_DEFAULT_REGION'], ['configurationSet', 'JALE_SES_CONFIGURATION_SET_NAME'],
      ] as const) {
        if (saved[key] === undefined) delete process.env[name];
        else process.env[name] = saved[key];
      }
    }
  }

  const adminVariables = (templates: Record<string, any>): Record<string, unknown> => (Object.values(templates.JaleAdminStack.Resources) as any[])
    .find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === 'jale-admin-nextjs')
    .Properties.Environment.Variables;
  const feedbackQueues = (templates: Record<string, any>): any[] => Object.entries(templates.JaleNotificationsStack.Resources as Record<string, any>)
    .filter(([id, r]) => r.Type === 'AWS::SQS::Queue' && /^SesFeedbackHandlerDlq[0-9A-F]{8}$/.test(id))
    .map(([, r]) => r);

  test('with the configuration set, the admin Lambda reads the queue NotificationsStack creates', () => {
    const templates = compose('jale-test-employer-email');
    const [queue] = feedbackQueues(templates);
    expect(feedbackQueues(templates)).toHaveLength(1);
    expect(typeof queue.Properties.QueueName).toBe('string');
    expect(adminVariables(templates).ADMIN_SES_FEEDBACK_DLQ_URL)
      .toBe(`https://sqs.us-east-2.amazonaws.com/111111111111/${queue.Properties.QueueName}`);
    expect(JSON.stringify(templates.JaleAdminStack)).not.toMatch(/Fn::ImportValue[^}]*Notifications/);
  });

  test('without it, there is no queue and the admin Lambda is told none', () => {
    const templates = compose('');
    expect(feedbackQueues(templates)).toEqual([]);
    expect(adminVariables(templates)).not.toHaveProperty('ADMIN_SES_FEEDBACK_DLQ_URL');
  });
});
