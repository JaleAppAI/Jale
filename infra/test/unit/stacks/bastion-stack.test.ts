import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BastionStack } from '../../../lib/stacks/bastion-stack';

describe('BastionStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
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

  test('Instance is t4g.nano', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.nano',
    });
  });

  test('Instance has an IAM instance profile attached', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      IamInstanceProfile: Match.anyValue(),
    });
  });

  test('BastionInstanceId is exported', () => {
    template.hasOutput('BastionInstanceId', {
      Export: { Name: 'JaleBastionInstanceId' },
    });
  });

  test('Bastion SG has no inbound rules', () => {
    const sgs = template.findResources('AWS::EC2::SecurityGroup', {
      Properties: {
        GroupDescription: Match.stringLikeRegexp('.*Bastion.*'),
      },
    });
    for (const [, sg] of Object.entries(sgs)) {
      const inline = sg.Properties.SecurityGroupIngress;
      if (inline) {
        expect(Array.isArray(inline) ? inline.length : 1).toBe(0);
      }
    }
  });
});
