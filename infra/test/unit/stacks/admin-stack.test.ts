import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AdminStack, getAdminDurability } from '../../../lib/stacks/admin-stack';

const describeIfDocker = process.env.SKIP_DOCKER_TESTS ? describe.skip : describe;

describeIfDocker('AdminStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { environment: 'prod' } });
    const support = new cdk.Stack(app, 'AdminSupportStack', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const vpc = new ec2.Vpc(support, 'Vpc', { maxAzs: 2 });
    const lambdaSg = new ec2.SecurityGroup(support, 'LambdaSg', { vpc });
    const adminDbSecret = new secretsmanager.Secret(support, 'AdminDbSecret');
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
      certificate,
      webAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/admin/00000000-0000-0000-0000-000000000000',
    });

    template = Template.fromStack(stack);
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
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
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

  test('outputs the admin url and Cognito identifiers', () => {
    template.hasOutput('AdminUrl', {
      Value: 'https://admin.example.com',
    });
    template.hasOutput('AdminUserPoolId', Match.anyValue());
    template.hasOutput('AdminUserPoolClientId', Match.anyValue());
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
