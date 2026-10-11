import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import type { AccessManifest } from '../../db/access/access-manifest';
import { CHANGE_LOG_FILE } from '../../db/access/posture-audit';
import { dedicatedDbLogin } from './db-login-secrets';
import { JaleLambdaFunction } from './lambda-function';

/** The catalog-only login the check connects as. */
export const DB_POSTURE_LOGIN = 'jale_posture';

/**
 * The deploy role's managed policy, by a fixed name: the deploy role lives
 * outside this repository, and attaching the policy to it is a one-time
 * operator step that looks the policy up by this name.
 */
export const DB_POSTURE_GATE_POLICY_NAME = 'JaleDbPostureGate';

const METRIC_NAMESPACE = 'Jale/Database';

/** The merged manifest's file name inside the bundle (the handler's BUNDLED_MANIFEST_FILE). */
const BUNDLED_MANIFEST_FILE = 'access-manifest.json';

/**
 * The audit change-log column list, which the audit posture checks read from
 * the handler's directory on every run. Without it a run is incomplete, and
 * so never clean.
 */
const CHANGE_LOG_SOURCE = path.join(__dirname, '../../db/access', CHANGE_LOG_FILE);

export interface DbPostureCheckProps {
  readonly vpc: ec2.IVpc;
  /** The shared Lambda security group, which the database already admits. */
  readonly securityGroup: ec2.ISecurityGroup;
  /** The merged access manifest the check evaluates against. */
  readonly accessManifest: AccessManifest;
  /**
   * The existing monitored ops topic (the shared `whatsappAlarmTopicArn`
   * context the other stacks' alarms use). Without it the alarms still exist,
   * visible in the console, with no action.
   */
  readonly alarmTopicArn?: string;
}

/**
 * The database posture check, in the database's own stack,
 * which every backend deploy includes:
 *
 *   - the function (`lambda/ops/db-posture-check.ts`), in the VPC like every
 *     database Lambda, reading only its own login's secret, and carrying the
 *     merged access manifest and the audit change-log file in its bundle;
 *   - a daily rule, which runs it as a `daily` run;
 *   - three alarms on the ops topic: a not-clean run; no clean run for 26
 *     hours, counting silence as a breach; and any workload's failed boot
 *     identity check;
 *   - the deploy role's managed policy, which lets the deploy gate find the
 *     function, invoke it and read its metric history, and nothing else;
 *   - two outputs the gate and the runbook read: the function name and the
 *     policy name. Neither is exported.
 */
export class DbPostureCheck extends Construct {
  public readonly function: JaleLambdaFunction;
  public readonly gatePolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: DbPostureCheckProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const login = dedicatedDbLogin(this, DB_POSTURE_LOGIN);

    // The merged manifest is serialised here, at synth time, and copied into
    // the bundle by the bundling step, which runs while the function is being
    // constructed. The staging directory is private to this synth and gone
    // once the function exists.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-access-manifest-'));
    try {
      const stagedManifest = path.join(stagingDir, BUNDLED_MANIFEST_FILE);
      fs.writeFileSync(stagedManifest, JSON.stringify(props.accessManifest));

      this.function = new JaleLambdaFunction(this, 'Function', {
        entry: path.join(__dirname, '../../lambda/ops/db-posture-check.ts'),
        description: 'Database posture check against the access manifest',
        environment: { ...login.environment },
        vpc: props.vpc,
        securityGroups: [props.securityGroup],
        timeout: 60,
        retryAttempts: 0,
        bundledFiles: { [BUNDLED_MANIFEST_FILE]: stagedManifest, [CHANGE_LOG_FILE]: CHANGE_LOG_SOURCE },
      });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    login.grantRead(this.function.function);

    // 10:00 UTC: clear of the backup window and of Sunday's maintenance
    // window, so a routine run never meets either. The no-clean alarm below
    // allows two hours of slack on top of the 24-hour cadence.
    new events.Rule(this, 'DailyRule', {
      description: 'Daily database posture check',
      schedule: events.Schedule.cron({ minute: '0', hour: '10' }),
      targets: [
        new eventTargets.LambdaFunction(this.function.function, {
          event: events.RuleTargetInput.fromObject({ trigger: 'daily' }),
          retryAttempts: 0,
        }),
      ],
    });

    const alarmAction = props.alarmTopicArn
      ? new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, 'AlarmTopic', props.alarmTopicArn))
      : undefined;
    const postureAlarm = (alarmId: string, alarmProps: cloudwatch.AlarmProps): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, alarmId, alarmProps);
      if (alarmAction) alarm.addAlarmAction(alarmAction);
      return alarm;
    };
    // The dimensionless rollups: every trigger, and every workload, in one series.
    const sum = (metricName: string, period: cdk.Duration): cloudwatch.Metric =>
      new cloudwatch.Metric({ namespace: METRIC_NAMESPACE, metricName, statistic: 'Sum', period });

    postureAlarm('NotCleanAlarm', {
      alarmName: 'DbPostureRunNotClean',
      alarmDescription:
        'A database posture check run was not clean: a violation, an incomplete check or a failure. '
        + 'The posture function logs name the finding.',
      metric: sum('DbPostureRunNotClean', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    postureAlarm('NoCleanRunAlarm', {
      alarmName: 'DbPostureNoCleanRun',
      alarmDescription: 'No clean database posture check run for 26 hours.',
      metric: sum('DbPostureRunClean', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      // A check that stopped running publishes nothing at all; that silence
      // is exactly what this alarm is for.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    postureAlarm('IdentityCheckFailedAlarm', {
      alarmName: 'DbIdentityCheckFailed',
      alarmDescription:
        "A workload's database boot identity check failed: it did not connect as the login it expects.",
      metric: sum('DbIdentityCheckFailed', cdk.Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.gatePolicy = new iam.ManagedPolicy(this, 'GatePolicy', {
      managedPolicyName: DB_POSTURE_GATE_POLICY_NAME,
      description: 'Deploy role access for the database posture gate: find, invoke and read the posture check',
      statements: [
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [this.function.function.functionArn],
        }),
        // GetMetricData has no resource form.
        new iam.PolicyStatement({
          actions: ['cloudwatch:GetMetricData'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['cloudformation:DescribeStacks'],
          resources: [stack.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${stack.stackName}/*` })],
        }),
      ],
    });

    // Top-level ids, so the gate reads stable output keys.
    new cdk.CfnOutput(stack, 'DbPostureFunctionName', {
      description: 'The database posture check function, for the deploy gate',
      value: this.function.function.functionName,
    });
    new cdk.CfnOutput(stack, 'DbPostureGatePolicyName', {
      description: 'The managed policy the deploy role needs for the database posture gate',
      value: DB_POSTURE_GATE_POLICY_NAME,
    });
  }
}
