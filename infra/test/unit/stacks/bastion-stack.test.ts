import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BastionStack } from '../../../lib/stacks/bastion-stack';

describe('BastionStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    // Stand up a minimal VPC in a harness stack so the bastion has somewhere
    // to land — we don't exercise the real NetworkStack wiring here.
    const vpcStack = new cdk.Stack(app, 'TestVpcStack');
    const vpc = new ec2.Vpc(vpcStack, 'TestVpc', {
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });
    const rdsSg = new ec2.SecurityGroup(vpcStack, 'TestRdsSg', {
      vpc,
      allowAllOutbound: false,
    });

    const stack = new BastionStack(app, 'TestBastionStack', { vpc, rdsSg });
    template = Template.fromStack(stack);
  });

  test('Single EC2 instance exists', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
  });

  test('Instance is t4g.micro (ARM graviton; nano OOM-killed dnf on first boot)', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.micro',
    });
  });

  test('Instance has an IAM instance profile attached', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      IamInstanceProfile: Match.anyValue(),
    });
  });

  test('IAM role has minimum SSM Session Manager actions (tighter than managed policy)', () => {
    // CDK's BastionHostLinux attaches a scoped inline policy — the 3 actions
    // below are what SSM agent needs to keep a session alive and report
    // instance state. This is narrower than AmazonSSMManagedInstanceCore
    // (which also grants write to CloudWatch + S3); the narrower grant is
    // the current CDK best practice.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ssmmessages:*',
              'ssm:UpdateInstanceInformation',
              'ec2messages:*',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('UserData installs postgresql15 and jq on first boot', () => {
    // BastionHostLinux base64-encodes UserData. Find the instance and
    // decode its UserData payload to search for our install commands.
    const instances = template.findResources('AWS::EC2::Instance');
    const instanceKey = Object.keys(instances)[0];
    const userDataFnBase64 = instances[instanceKey].Properties.UserData;
    // CDK emits `Fn::Base64: <string-or-join>` — we just assert the install
    // command is present in the stringified payload (tolerates Fn::Join
    // tokens around it).
    const serialized = JSON.stringify(userDataFnBase64);
    expect(serialized).toContain('postgresql15');
    // Swap is created BEFORE dnf: on 2026-09-01 a nano's first-boot install
    // was OOM-killed, leaving no psql. The order matters.
    expect(serialized.indexOf('swapon /swapfile')).toBeGreaterThan(-1);
    expect(serialized.indexOf('swapon /swapfile')).toBeLessThan(serialized.indexOf('dnf install'));
    expect(serialized).toContain('install_weak_deps=False');
    expect(serialized).toContain('jq');
  });

  test('BastionInstanceId is exported as a CloudFormation output', () => {
    template.hasOutput('BastionInstanceId', {
      Export: { Name: 'JaleBastionInstanceId' },
    });
  });

  test('Bastion SG has no inbound rules (SSM-only access)', () => {
    // The SG itself should exist; any SecurityGroupIngress resources in the
    // template attached to the bastion SG are the concern. The bastion
    // construct does NOT create inbound rules by default — this guards
    // against a future edit accidentally punching one.
    const sgs = template.findResources('AWS::EC2::SecurityGroup', {
      Properties: {
        GroupDescription: Match.stringLikeRegexp('.*Bastion.*'),
      },
    });
    for (const [, sg] of Object.entries(sgs)) {
      // If SecurityGroupIngress is defined inline on the SG, it should be
      // absent or an empty array.
      const inline = sg.Properties.SecurityGroupIngress;
      if (inline) {
        expect(Array.isArray(inline) ? inline.length : 1).toBe(0);
      }
    }
  });
});
