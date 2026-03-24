import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/stacks/network-stack';

describe('NetworkStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new NetworkStack(app, 'TestNetworkStack');
    template = Template.fromStack(stack);
  });

  test('VPC exists with 2 AZs (4 subnets: 2 Private + 2 Isolated)', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs x 2 subnet tiers = 4 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  test('Lambda security group exists', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Lambda functions',
    });
  });

  test('RDS security group exists', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for RDS PostgreSQL',
    });
  });

  test('RDS SG has inbound rule on port 5432 from Lambda SG', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    });
  });

  test('Interface VPC endpoints exist for secretsmanager, sns, cognito-idp, sts, logs', () => {
    const endpoints = [
      'secretsmanager',
      'sns',
      'cognito-idp',
      'sts',
      'logs',
    ];
    for (const svc of endpoints) {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Interface',
        ServiceName: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp(`.*${svc}.*`),
            ]),
          ]),
        }),
      });
    }
  });

  test('S3 Gateway VPC endpoint exists', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([
            Match.stringLikeRegexp('.*s3'),
          ]),
        ]),
      }),
    });
  });
});
