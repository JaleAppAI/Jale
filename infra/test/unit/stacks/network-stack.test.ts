import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';

describe('NetworkStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new NetworkStack(app, 'TestNetworkStack');
    template = Template.fromStack(stack);
  });

  test('VPC exists with 2 AZs (6 subnets: 2 Public + 2 Private + 2 Isolated)', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs × 3 subnet tiers = 6 subnets.
    // Public tier added in Phase 3 to host the NAT gateway for Twilio egress.
    template.resourceCountIs('AWS::EC2::Subnet', 6);
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

  test('Interface VPC endpoints exist for secretsmanager and cloudwatch logs only', () => {
    const endpoints = ['secretsmanager', 'logs'];
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

  test('Pruned interface endpoints (sns, cognito-idp, sts, sqs) are absent', () => {
    // Per 2026-04-20 audit (docs/Audit.md Status Log): these services route
    // via the NAT Gateway instead. Negative assertion guards against drive-by
    // re-adds without review.
    const pruned = ['sns', 'cognito-idp', 'sts', 'sqs'];
    for (const svc of pruned) {
      const found = template.findResources('AWS::EC2::VPCEndpoint', {
        Properties: {
          VpcEndpointType: 'Interface',
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([
                Match.stringLikeRegexp(`.*${svc}.*`),
              ]),
            ]),
          }),
        },
      });
      expect(Object.keys(found)).toHaveLength(0);
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

  test('Cognito SMS IAM role exists with cognito-idp trust and inline SNS policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'cognito-idp.amazonaws.com' },
          }),
        ]),
      }),
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyName: 'SnsPublish',
        }),
      ]),
    });
  });

  // ── Phase 3: NAT Gateway (needed for Twilio API egress) ─────────
  test('Exactly 1 NAT Gateway exists (for Twilio external egress)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('Exactly 1 Elastic IP exists (attached to the NAT Gateway)', () => {
    template.resourceCountIs('AWS::EC2::EIP', 1);
  });
});
