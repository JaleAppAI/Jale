import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AdminStack } from '../../../lib/stacks/admin-stack';

const describeIfDocker = process.env.SKIP_DOCKER_TESTS ? describe.skip : describe;

describeIfDocker('AdminStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const support = new cdk.Stack(app, 'AdminSupportStack', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const vpc = new ec2.Vpc(support, 'Vpc', { maxAzs: 2 });
    const lambdaSg = new ec2.SecurityGroup(support, 'LambdaSg', { vpc });
    const adminDbSecret = new secretsmanager.Secret(support, 'AdminDbSecret');

    const stack = new AdminStack(app, 'TestAdminStack', {
      env: { account: '111111111111', region: 'us-east-1' },
      domainName: 'example.com',
      hostedZoneId: 'Z1234567890ABC',
      vpc,
      privateSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets,
      lambdaSg,
      adminDbSecret,
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

  test('outputs the admin url and Cognito identifiers', () => {
    template.hasOutput('AdminUrl', {
      Value: 'https://admin.example.com',
    });
    template.hasOutput('AdminUserPoolId', Match.anyValue());
    template.hasOutput('AdminUserPoolClientId', Match.anyValue());
  });
});
