import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BastionStack, DEFAULT_BASTION_TTL_HOURS } from '../../../lib/stacks/bastion-stack';

const ALARM_TOPIC_ARN = 'arn:aws:sns:us-east-2:123456789012:jale-whatsapp-alarms';

/** Stands up a VPC + RDS SG harness and returns the synthesized bastion. */
function synth(context: Record<string, unknown> = {}, alarmTopicArn?: string): Template {
  const app = new cdk.App({ context });
  const vpcStack = new cdk.Stack(app, 'TestVpcStack');
  const vpc = new ec2.Vpc(vpcStack, 'TestVpc', {
    maxAzs: 2,
    subnetConfiguration: [
      { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    ],
  });
  const rdsSg = new ec2.SecurityGroup(vpcStack, 'TestRdsSg', { vpc, allowAllOutbound: false });
  return Template.fromStack(new BastionStack(app, 'TestBastionStack', { vpc, rdsSg, alarmTopicArn }));
}

/** The TTL sweeper's environment, from whichever Lambda carries it. */
function sweeperEnv(template: Template): Record<string, unknown> {
  const fns = template.findResources('AWS::Lambda::Function');
  const sweeper = Object.values(fns).find(
    (fn) => fn.Properties?.Environment?.Variables?.BASTION_TTL_HOURS !== undefined,
  );
  expect(sweeper).toBeDefined();
  return sweeper!.Properties.Environment.Variables;
}

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

/**
 * F23 (Luis ruling, sprint 26): the bastion tears itself down after a TTL.
 *
 * The bastion has never had one -- "destroy it in the same session" was a
 * habit, and a forgotten bastion is an SSM-reachable host inside the VPC
 * holding read on every internal database credential. These pin the mechanism
 * rather than the wording: a rate rule (never a synth-time one-shot), a
 * sweeper scoped to exactly one instance, the 6-hour default, and the context
 * override.
 */
describe('BastionStack - TTL auto-teardown (F23)', () => {
  it('sweeps on a RATE schedule, never a one-shot at() computed at synth time', () => {
    const template = synth();

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
      State: 'ENABLED',
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
    });
    // `at(...)` renders as a cron with a fixed date. If one ever appears here,
    // the TTL has silently become "hours after the last synth".
    const rules = template.findResources('AWS::Events::Rule');
    for (const rule of Object.values(rules)) {
      expect(String(rule.Properties.ScheduleExpression)).not.toMatch(/^cron\(/);
    }
  });

  it('the rule targets the TTL sweeper lambda, and that lambda runs outside the VPC', () => {
    const template = synth();

    const fns = template.findResources('AWS::Lambda::Function');
    const sweeperIds = Object.entries(fns)
      .filter(([, fn]) => fn.Properties?.Environment?.Variables?.BASTION_TTL_HOURS !== undefined)
      .map(([id]) => id);
    expect(sweeperIds).toHaveLength(1);

    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    const targetArns = JSON.stringify(rules.map((r) => r.Properties.Targets));
    expect(targetArns).toContain(sweeperIds[0]);

    // No VpcConfig: it calls the EC2 control plane only, so an ENI would buy
    // cold-start cost and a NAT dependency for nothing.
    expect(fns[sweeperIds[0]].Properties.VpcConfig).toBeUndefined();
  });

  it('defaults to a 6-hour TTL with no context supplied', () => {
    expect(DEFAULT_BASTION_TTL_HOURS).toBe(6);
    expect(sweeperEnv(synth()).BASTION_TTL_HOURS).toBe('6');
  });

  it('honours -c bastionTtlHours as an override', () => {
    expect(sweeperEnv(synth({ bastionTtlHours: '2' })).BASTION_TTL_HOURS).toBe('2');
    expect(sweeperEnv(synth({ bastionTtlHours: 0.5 })).BASTION_TTL_HOURS).toBe('0.5');
  });

  it('refuses a non-numeric or non-positive TTL rather than silently defaulting', () => {
    // A typo that quietly became 6 hours is indistinguishable from the
    // operator getting what they asked for.
    expect(() => synth({ bastionTtlHours: 'six' })).toThrow(/BASTION_TTL_INVALID/);
    expect(() => synth({ bastionTtlHours: 0 })).toThrow(/BASTION_TTL_INVALID/);
    expect(() => synth({ bastionTtlHours: -1 })).toThrow(/BASTION_TTL_INVALID/);
  });

  it('passes the bastion instance id to the sweeper by Ref, never by cross-stack import', () => {
    const template = synth();

    const instanceId = sweeperEnv(template).BASTION_INSTANCE_ID;
    // A Ref to a resource IN THIS TEMPLATE. An Fn::ImportValue here would mean
    // the sweeper depends on another stack's export -- exactly what makes
    // `cdk deploy JaleBastionStack --exclusively` drop exports.
    expect(JSON.stringify(instanceId)).toContain('"Ref"');
    expect(JSON.stringify(instanceId)).not.toContain('Fn::ImportValue');
  });

  it('grants ec2:StopInstances on the ONE instance, and Describe read-only', () => {
    const template = synth();

    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p) => (p.Properties.PolicyDocument.Statement ?? []) as Record<string, unknown>[],
    );

    const stop = statements.find((st) => JSON.stringify(st.Action) === JSON.stringify('ec2:StopInstances'));
    expect(stop).toBeDefined();
    // Resource-scoped: ec2:StopInstances supports it, so this can never stop
    // another instance in the account.
    expect(JSON.stringify(stop!.Resource)).not.toBe('"*"');
    expect(JSON.stringify(stop!.Resource)).toContain(':instance/');

    // The Describe* family supports no resource-level permissions at all, so
    // '*' is the only expressible grant -- but it must stay read-only, and it
    // must be the ONLY thing granted at '*'.
    const describe = statements.find((st) => JSON.stringify(st.Action) === JSON.stringify('ec2:DescribeInstances'));
    expect(describe).toBeDefined();
    expect(describe!.Resource).toBe('*');

    // Nothing mutating is ever granted: no terminate (the instance is
    // CloudFormation-managed), no run, no modify.
    const allActions = JSON.stringify(statements.map((st) => st.Action));
    expect(allActions).not.toContain('ec2:TerminateInstances');
    expect(allActions).not.toContain('ec2:RunInstances');
    expect(allActions).not.toContain('ec2:ModifyInstance');
  });

  it('alarms on a bastion that outlives its TTL, and on a sweeper that stops working', () => {
    const template = synth();

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'Jale/Bastion',
      MetricName: 'BastionOverTtl',
      Threshold: 1,
      // Two periods: a sweep that STOPS the instance breaches once and clears,
      // so one period would alarm on the mechanism working.
      EvaluationPeriods: 2,
      Period: 900,
      TreatMissingData: 'notBreaching',
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Threshold: 1,
      EvaluationPeriods: 1,
    });
  });

  /**
   * R2. `deploy-bastion.sh` is the ONLY path that deploys this stack -- it is
   * in none of the deploy workflow's stack lists -- so if it never passes an
   * alarm topic, both backstop alarms are created with no action and the
   * teardown has no watcher at all. The script now forwards
   * WHATSAPP_ALARM_TOPIC_ARN (the same variable the deploy workflow feeds
   * `-c whatsappAlarmTopicArn` from) whenever it is set.
   *
   * Both halves are pinned: wired when given, and STILL SYNTHESIZABLE when
   * not -- a bastion that refuses to deploy without an alarm target is a
   * bastion nobody can use to run a migration at 2am.
   */
  it('wires both alarms to the topic when one is supplied', () => {
    const template = synth({}, ALARM_TOPIC_ARN);

    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toEqual([ALARM_TOPIC_ARN]);
    }
  });

  it('synthesizes without an alarm topic, leaving the alarms action-less', () => {
    const template = synth();

    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      // Absent or empty -- never a fabricated destination, and never a throw.
      expect(alarm.Properties.AlarmActions ?? []).toEqual([]);
    }
    // And the teardown itself does not depend on the alarm at all.
    template.resourceCountIs('AWS::Events::Rule', 1);
  });

  it('adds no CloudFormation export beyond the instance id the scripts already read', () => {
    const template = synth();

    const outputs = template.toJSON().Outputs ?? {};
    const exported = Object.values(outputs as Record<string, { Export?: { Name?: unknown } }>)
      .filter((o) => o.Export?.Name !== undefined);
    // `run-migrations.sh` and the 020b-040 runbook both read
    // JaleBastionInstanceId. A second export would be one more thing
    // `--exclusively` has to carry.
    expect(exported).toHaveLength(1);
    expect(JSON.stringify(exported[0].Export!.Name)).toContain('JaleBastionInstanceId');
  });

  it('still creates exactly one EC2 instance and punches no inbound rule on the bastion SG', () => {
    const template = synth();

    template.resourceCountIs('AWS::EC2::Instance', 1);
    const sgs = template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: Match.stringLikeRegexp('.*Bastion.*') },
    });
    for (const [, sg] of Object.entries(sgs)) {
      const inline = sg.Properties.SecurityGroupIngress;
      if (inline) expect(Array.isArray(inline) ? inline.length : 1).toBe(0);
    }
  });
});
