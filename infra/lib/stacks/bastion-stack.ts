import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'path';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { jaleAlarm } from '../constructs/jale-alarm';

/** F23: how long a bastion may live before it is stopped, absent
 *  `-c bastionTtlHours=<n>`. Six hours is a long migration session and still
 *  well inside the same working day it was created in. */
export const DEFAULT_BASTION_TTL_HOURS = 6;

/** How often the sweeper asks whether the bastion has outlived its TTL. The
 *  worst-case overshoot is one interval, which is the price of measuring the
 *  age from the instance's real launch time instead of a synth-time guess. */
const TTL_SWEEP_INTERVAL_MINUTES = 15;

/**
 * Loud on garbage, defaulted on absence. A typo'd `-c bastionTtlHours=six`
 * that silently became 6 hours would be indistinguishable from the operator
 * getting what they asked for.
 */
function resolveTtlHours(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_BASTION_TTL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      'BASTION_TTL_INVALID: -c bastionTtlHours must be a positive number of hours '
      + `(got ${JSON.stringify(raw)})`,
    );
  }
  return hours;
}

/**
 * BastionStack — throwaway EC2 for running DB migrations + ad-hoc psql
 * against the RDS that lives in PRIVATE_ISOLATED subnets.
 *
 * Pattern: ec2.BastionHostLinux gives us a hardened Amazon Linux host with
 * the SSM agent preinstalled, IMDSv2 required, and an IAM role containing
 * AmazonSSMManagedInstanceCore. No SSH keys, no public ingress.
 *
 * Deploy on demand, destroy when done:
 *   npx cdk deploy JaleBastionStack     # ~3 min
 *   bash scripts/run-migrations.sh      # run migrations via aws ssm send-command
 *   npx cdk destroy JaleBastionStack    # ~2 min
 *
 * Cross-stack wiring (RDS ingress, secrets read permissions) is punched
 * from bin/jale-app.ts — this stack takes only the VPC as a prop.
 */
export interface BastionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /**
   * The RDS security group to allow bastion ingress on port 5432.
   * Passing it in (rather than having bin/jale-app.ts call
   * `database.dbInstance.connections.allowFrom(bastion)`) ensures the
   * CfnSecurityGroupIngress resource CDK emits lives IN BastionStack —
   * otherwise NetworkStack would gain a back-edge to BastionStack and
   * synth fails with a circular dependency error.
   */
  rdsSg: ec2.ISecurityGroup;
  /**
   * Optional SNS topic for the TTL alarms. OPTIONAL on purpose, and never
   * fail-closed the way AiStack's is: `scripts/deploy-bastion.sh` synthesizes
   * this stack alone with no alarm context at all, and a bastion that refuses
   * to deploy without an alarm target is a bastion nobody can use to run a
   * migration.
   */
  alarmTopicArn?: string;
}

export class BastionStack extends cdk.Stack {
  public readonly bastionHost: ec2.BastionHostLinux;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    this.bastionHost = new ec2.BastionHostLinux(this, 'Bastion', {
      vpc: props.vpc,
      // PRIVATE_WITH_EGRESS: the bastion needs outbound internet via the NAT
      // Gateway so `dnf install postgresql15` can pull from AL2023 repos.
      // Isolated subnets would work for reaching RDS but not for yum.
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // MICRO (1 GiB), not NANO (512 MiB): on 2026-09-01 the first-boot
      // `dnf install postgresql15 jq` was OOM-killed on a nano (cloud-init
      // log: "Killed dnf install -y postgresql15 jq"), leaving the bastion
      // with no psql and every run-migrations.sh call failing with exit 127.
      // dnf on AL2023 routinely needs >512 MiB; the swapfile below is the
      // second guard.
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
    });

    // UserData runs once at first boot. postgresql15-server is excluded —
    // we only need the client binary. jq lets the migration script parse
    // the jale_admin secret JSON without a Python dependency.
    // A 1 GiB swapfile FIRST so dnf cannot be OOM-killed even on a small
    // instance, then the client packages with weak deps off (smaller
    // transaction, less memory). `set -e` so a failed install is visible in
    // cloud-init-output.log rather than silently leaving psql absent.
    this.bastionHost.instance.addUserData(
      'set -e',
      'fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile',
      'dnf install -y --setopt=install_weak_deps=False postgresql15 jq',
      'command -v psql',
    );

    // Explicit CfnSecurityGroupIngress so the rule resource lands in this
    // stack (BastionStack), not the upstream NetworkStack. `addIngressRule`
    // on a cross-stack SG still mutates the upstream SG, which creates a
    // cycle (NetworkStack → BastionStack for the peer ID, BastionStack →
    // NetworkStack for the VPC ref). Using the L1 resource breaks that.
    new ec2.CfnSecurityGroupIngress(this, 'RdsIngressFromBastion', {
      groupId: props.rdsSg.securityGroupId,
      sourceSecurityGroupId:
        this.bastionHost.connections.securityGroups[0].securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Bastion SSM-only DB access',
    });

    new cdk.CfnOutput(this, 'BastionInstanceId', {
      value: this.bastionHost.instanceId,
      description: 'SSM target for aws ssm start-session / send-command',
      exportName: 'JaleBastionInstanceId',
    });

    // ── F23: auto-teardown ────────────────────────────────────────────────
    //
    // Everything below lives INSIDE this stack, deliberately. `deploy-bastion.sh`
    // deploys with `--exclusively`, and the memory note behind that flag is
    // that a bastion deploy which reaches into other stacks drops their
    // exports. The sweeper therefore takes the instance id from
    // `this.bastionHost.instanceId` -- a Ref within this template, never a
    // cross-stack import -- and adds no export of its own.
    //
    // The cost of keeping it here is honest and worth stating: this is the
    // first Lambda in BastionStack, so `deploy-bastion.sh` (and this stack's
    // unit test) now pay one esbuild bundle. The alternative -- putting the
    // sweeper in a stack `--exclusively` never deploys -- would mean a
    // teardown that is stale or absent exactly when it is needed.
    const ttlHours = resolveTtlHours(this.node.tryGetContext('bastionTtlHours'));

    const ttlSweeper = new JaleLambdaFunction(this, 'BastionTtlSweeperLambda', {
      entry: path.join(__dirname, '../../lambda/ops/bastion-ttl-sweeper.ts'),
      description: `Stops the bastion once it has been running longer than ${ttlHours}h`,
      // No `vpc`: this talks to the EC2 control plane only. A VPC-attached
      // function would pay ENI cold-start cost to call a public API endpoint
      // -- and would need a NAT route to reach it.
      timeout: 30,
      environment: {
        BASTION_INSTANCE_ID: this.bastionHost.instanceId,
        BASTION_TTL_HOURS: String(ttlHours),
      },
    });

    // Least privilege, and the split is forced by the API rather than chosen:
    // ec2:StopInstances IS resource-scoped, so it is pinned to this one
    // instance and can never stop anything else in the account. The whole
    // ec2:Describe* family supports no resource-level permissions at all, so
    // '*' there is the only expressible grant -- it is read-only and carries
    // no ability to change anything.
    ttlSweeper.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:StopInstances'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'ec2',
        resource: 'instance',
        resourceName: this.bastionHost.instanceId,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      })],
    }));
    ttlSweeper.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));

    // A RATE rule, not a one-shot `at()`: see the sweeper's own jsdoc -- an
    // absolute schedule is computed at synth time, so it would fire TTL hours
    // after somebody ran `cdk synth`, and every redeploy would re-arm a stale
    // timestamp.
    new events.Rule(this, 'BastionTtlSweepRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(TTL_SWEEP_INTERVAL_MINUTES)),
      description: `Stops the bastion once it is older than its ${ttlHours}h TTL`,
      targets: [new eventTargets.LambdaFunction(ttlSweeper.function)],
    });

    let alarmAction: cloudwatchActions.SnsAction | undefined;
    if (props.alarmTopicArn) {
      alarmAction = new cloudwatchActions.SnsAction(
        sns.Topic.fromTopicArn(this, 'BastionAlarmTopic', props.alarmTopicArn),
      );
    }
    const alarmActions = alarmAction ? [alarmAction] : [];

    // THE BACKSTOP. The sweeper reports BastionOverTtl=1 only while the
    // instance is still RUNNING past its TTL, so a sweep that stops it
    // successfully breaches once and clears. Two consecutive periods means the
    // stop is not taking effect -- an API denial, a hung shutdown -- and the
    // bastion really is outliving its TTL with nothing removing it.
    jaleAlarm(this, 'BastionOverTtlAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'Jale/Bastion',
        metricName: 'BastionOverTtl',
        statistic: 'Maximum',
        period: cdk.Duration.minutes(TTL_SWEEP_INTERVAL_MINUTES),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      alarmDescription: `Bastion is still running more than ${ttlHours}h after launch and the TTL sweeper has not stopped it`,
      actions: alarmActions,
    });

    // And the hole the alarm above cannot see on its own: a sweeper that
    // throws emits no metric at all, and NOT_BREACHING would read that silence
    // as healthy.
    jaleAlarm(this, 'BastionTtlSweeperErrorsAlarm', {
      metric: ttlSweeper.function.metricErrors({
        period: cdk.Duration.minutes(TTL_SWEEP_INTERVAL_MINUTES),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Bastion TTL sweeper is failing, so the bastion has no auto-teardown',
      actions: alarmActions,
    });
  }
}
