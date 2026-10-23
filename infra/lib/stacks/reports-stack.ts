import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { ApiStack } from './api-stack';
import type { AccessManifest } from '../../db/access/access-manifest';
import { appAccessManifest, dedicatedDbLogin, defaultAccessManifest } from '../constructs/db-login-secrets';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { jaleAlarm } from '../constructs/jale-alarm';
import { lambdaIntegration, addPathOnlyResource } from '../api-integration';

export interface ReportsStackProps extends cdk.StackProps {
  readonly network: NetworkStack;
  /**
   * The shared REST API. The report routes hang off it, so their Methods land
   * in ApiStack's template and ApiStack depends on this stack, never the
   * reverse: nothing here may read a value ApiStack owns.
   */
  readonly api: ApiStack;
  /** The web app's origin: the only origin the images bucket accepts an upload from. */
  readonly allowedOrigin: string;
  /** The two user pools, so the signed-in intake can tell a worker token from an employer token. */
  readonly workerUserPoolId: string;
  readonly employerUserPoolId: string;
  /**
   * The existing monitored ops topic (the shared `whatsappAlarmTopicArn`
   * context). Optional, like ReferralsStack's: without it the alarms still
   * exist and are visible in the console, with no action.
   */
  readonly alarmTopicArn?: string;
}

/** CloudWatch namespace every report metric is emitted under. */
export const REPORTS_METRIC_NAMESPACE = 'Jale/Reports';

/**
 * The daily screenshot-capture success share (%) below which
 * ReportCaptureSuccessShare notifies the ops topic.
 */
export const REPORT_CAPTURE_SUCCESS_SHARE_THRESHOLD = 80;

/**
 * The report-images bucket's fixed name in the calling stack's region, built
 * from account and region tokens only. The one place it is spelled: this stack
 * names its bucket with it, and the audit stack calls it to log object reads
 * on the bucket without a cross-stack export.
 */
export function reportImagesBucketName(): string {
  return `jale-report-images-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`;
}

/** The signed-out intake's dedicated database login. */
export const PUBLIC_REPORTS_LOGIN = 'jale_api_public_reports';

/**
 * The signed-out intake's reserved concurrency: exactly its login's connection
 * limit in the merged access manifest. Each container holds at most one
 * connection (`lib/db.ts`), so Lambda throttles a burst beyond the limit
 * before any database call, instead of the database refusing the connection.
 * A limit that is not a positive whole number fails the synth. The stack
 * passes the manifest its app is composed with; with no argument, the
 * checked-in one is read.
 */
export function publicIntakeReservedConcurrency(manifest: AccessManifest = defaultAccessManifest()): number {
  const limit: unknown = manifest.logins[PUBLIC_REPORTS_LOGIN]?.connection_limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `REPORTS_PUBLIC_LOGIN_LIMIT_INVALID: ${PUBLIC_REPORTS_LOGIN} needs a positive whole-number connection_limit `
      + 'in the access manifest (infra/db/access); the signed-out intake reserves exactly that many executions',
    );
  }
  return limit;
}

/**
 * ReportsStack: "report a problem".
 *
 * Routes (Methods in ApiStack's template):
 *   POST /reports/{action}          signed-in intake (dual authorizer)
 *   POST /public/reports/{action}   signed-out intake (no authorizer)
 *   GET  /public/reports/{action}   signed-out intake (no authorizer)
 *
 * Plus a private, unversioned, expiring images bucket with its own key, a
 * generated salt for hashing the viewer address, a daily clean-up, and the
 * alarms on the `Jale/Reports` metrics.
 *
 * Per-method throttles for the three routes live in ApiStack's single
 * MethodSettings array; this stack must NOT call
 * addPropertyOverride('MethodSettings').
 */
export class ReportsStack extends cdk.Stack {
  /** Images attached to reports. The admin console reads `images/*` from it. */
  public readonly imagesBucket: s3.IBucket;
  /** The images bucket's key. */
  public readonly imagesKey: kms.IKey;

  constructor(scope: Construct, id: string, props: ReportsStackProps) {
    super(scope, id, props);

    const isDev = this.node.tryGetContext('environment') === 'dev';
    // Retained outside dev: a report's image must outlive a stack replacement
    // for as long as the retention promise says, and so must the key it is
    // encrypted under.
    const removalPolicy = isDev ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // ── Images bucket and key ──
    const imagesKey = new kms.Key(this, 'ReportImagesKey', {
      enableKeyRotation: true,
      description: 'Key for report-a-problem images',
      removalPolicy,
    });
    this.imagesKey = imagesKey;

    // The name comes from reportImagesBucketName(), tokens only, which the
    // audit stack calls too, so it derives the bucket's ARN without a
    // cross-stack export. (The admin stack takes the bucket and its key as
    // props, through exports.)
    //
    // Not versioned: an image that is deleted, by the clean-up or by its
    // lifecycle rule, is really gone. The final `images/` key is never
    // presigned; only the intakes write it, by copying a checked upload.
    const imagesBucket = new s3.Bucket(this, 'ReportImagesBucket', {
      bucketName: reportImagesBucketName(),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: imagesKey,
      bucketKeyEnabled: true,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy,
      // The browser uploads with a presigned POST: a multipart form whose
      // policy fields carry everything S3 checks, from the web origin only.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: [props.allowedOrigin],
          allowedHeaders: ['Content-Type'],
        },
      ],
      lifecycleRules: [
        // An upload that was never attached.
        { id: 'expire-incoming', prefix: 'incoming/', expiration: cdk.Duration.days(1) },
        // Attached images are kept 90 days. The clean-up deletes them
        // explicitly; this rule is the backstop.
        { id: 'expire-images', prefix: 'images/', expiration: cdk.Duration.days(90) },
        { id: 'abort-incomplete-multipart', abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
    });
    this.imagesBucket = imagesBucket;

    // ── Address salt ──
    // Generated by Secrets Manager and read at runtime by the signed-out
    // intake only; never an environment variable, which would put it in the
    // template and in every function-configuration read. No fixed name: only
    // its ARN is ever passed around.
    const addressSalt = new secretsmanager.Secret(this, 'ReportAddressSaltSecret', {
      description: 'Salt for hashing the viewer address on signed-out reports',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // ── Database logins ──
    const apiDb = dedicatedDbLogin(this, 'jale_api');
    const publicReportsDb = dedicatedDbLogin(this, PUBLIC_REPORTS_LOGIN);
    const cleanupDb = dedicatedDbLogin(this, 'jale_job_report_cleanup');

    const lambdaProps = {
      vpc: props.network.vpc,
      securityGroups: [props.network.lambdaSg],
    };

    const intakeEnv = {
      REPORT_IMAGES_BUCKET: imagesBucket.bucketName,
      // The key's ARN: S3 accepts it as the SSE-KMS key id in an upload
      // policy, and HeadObject reports an object's key as its ARN.
      REPORT_IMAGES_KEY_ID: imagesKey.keyArn,
      WORKER_USER_POOL_ID: props.workerUserPoolId,
      EMPLOYER_USER_POOL_ID: props.employerUserPoolId,
      ALLOWED_ORIGIN: props.allowedOrigin,
    };

    // ── Lambdas ──
    const intake = new JaleLambdaFunction(this, 'ReportIntake', {
      entry: path.join(__dirname, '../../lambda/reports/intake.ts'),
      description: 'Report a problem: signed-in intake',
      environment: { ...apiDb.environment, ...intakeEnv },
      ...lambdaProps,
    });

    // Reserved at its login's connection limit in the access manifest this
    // app is composed with (see publicIntakeReservedConcurrency): a burst past
    // it is throttled by Lambda before it can be refused by the database.
    const publicIntake = new JaleLambdaFunction(this, 'PublicReportIntake', {
      entry: path.join(__dirname, '../../lambda/reports/public-intake.ts'),
      description: 'Report a problem: signed-out intake',
      reservedConcurrentExecutions: publicIntakeReservedConcurrency(appAccessManifest(this)),
      environment: {
        ...publicReportsDb.environment,
        ...intakeEnv,
        REPORT_ADDRESS_SALT_SECRET_ARN: addressSalt.secretArn,
      },
      ...lambdaProps,
    });

    // Only the schedule invokes it. One reserved execution keeps a retried or
    // duplicated scheduled invoke from running a second clean-up beside the
    // first.
    const cleanup = new JaleLambdaFunction(this, 'ReportCleanup', {
      entry: path.join(__dirname, '../../lambda/reports/cleanup.ts'),
      description: 'Report a problem: daily clean-up',
      timeout: 120,
      reservedConcurrentExecutions: 1,
      environment: {
        ...cleanupDb.environment,
        REPORT_IMAGES_BUCKET: imagesBucket.bucketName,
      },
      ...lambdaProps,
    });

    // ── IAM, exactly ──
    // Explicit statements rather than the bucket's grant helpers, which would
    // add listing and bucket-level actions. No role here can list the bucket.
    const incomingObjects = imagesBucket.arnForObjects('incoming/*');
    const imageObjects = imagesBucket.arnForObjects('images/*');

    for (const fn of [intake, publicIntake]) {
      // PutObject on `incoming/*` signs the presigned POST; on `images/*` it
      // is the destination of the copy that pins a checked upload.
      fn.function.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [incomingObjects, imageObjects],
      }));
      // Read and remove the upload being checked.
      fn.function.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:DeleteObject'],
        resources: [incomingObjects],
      }));
      // Remove a copy whose attach was refused.
      fn.function.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [imageObjects],
      }));
      fn.function.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:GenerateDataKey', 'kms:Encrypt', 'kms:Decrypt'],
        resources: [imagesKey.keyArn],
      }));
    }

    cleanup.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: [incomingObjects, imageObjects],
    }));

    apiDb.grantRead(intake.function);
    publicReportsDb.grantRead(publicIntake.function);
    cleanupDb.grantRead(cleanup.function);
    addressSalt.grantRead(publicIntake.function);

    // ── Routes ──
    // Path-only: nothing on /reports itself.
    addPathOnlyResource(props.api.api.root, 'reports')
      .addResource('{action}')
      .addMethod('POST', lambdaIntegration(intake.function), {
        authorizer: props.api.dualAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // Path-only: nothing on /public/reports itself. No authorizer: the
    // signed-out door.
    const publicReportsAction = addPathOnlyResource(props.api.publicResource, 'reports')
      .addResource('{action}');
    publicReportsAction.addMethod('POST', lambdaIntegration(publicIntake.function));
    publicReportsAction.addMethod('GET', lambdaIntegration(publicIntake.function));

    // ── Schedule ──
    new events.Rule(this, 'ReportCleanupRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [new eventTargets.LambdaFunction(cleanup.function)],
    });

    // ── Alarms ──
    const actions = props.alarmTopicArn
      ? [new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, 'ReportsAlarmTopic', props.alarmTopicArn))]
      : [];
    const metric = (
      metricName: string,
      period: cdk.Duration,
      statistic = 'Sum',
      dimensionsMap?: Record<string, string>,
    ): cloudwatch.Metric => new cloudwatch.Metric({
      namespace: REPORTS_METRIC_NAMESPACE,
      metricName,
      statistic,
      period,
      dimensionsMap,
    });
    const anyOf = (alarmId: string, alarmName: string, alarmDescription: string, m: cloudwatch.Metric) =>
      jaleAlarm(this, alarmId, {
        alarmName,
        alarmDescription,
        metric: m,
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        actions,
      });

    anyOf(
      'ReportIntakeErrorsAlarm',
      'ReportIntakeErrors',
      'A report intake request failed with an internal error in the last 15 minutes. The intake logs carry the API request id.',
      metric('ReportIntakeErrors', cdk.Duration.minutes(15)),
    );

    anyOf(
      'ReportEmailSkippedAlarm',
      'ReportEmailSkipped',
      'A report was saved but no team email was queued: the team mailbox or the dashboard base URL is not set in the Reports settings.',
      metric('ReportEmailSkipped', cdk.Duration.minutes(15)),
    );

    anyOf(
      'ReportCleanupFailedAlarm',
      'ReportCleanupFailed',
      'The daily report clean-up failed. The lifecycle rules still expire images, but personal content past its retention is not being erased.',
      metric('ReportCleanupFailed', cdk.Duration.hours(1)),
    );

    // The clean-up emits its run total on every completed run, zero
    // included, as a DIMENSIONLESS ReportCleanupDeleted beside the per-Kind
    // values, so an hour with a datapoint is an hour with a run. This alarm
    // must read that dimensionless series: an alarm sees only datapoints
    // published with exactly its dimensions. A clean-up that stopped running,
    // or that fails every run, publishes no total at all, and that silence is
    // what this is for.
    jaleAlarm(this, 'ReportCleanupMissingAlarm', {
      alarmName: 'ReportCleanupMissing',
      alarmDescription: 'No report clean-up run has been recorded for 26 hours.',
      metric: metric('ReportCleanupDeleted', cdk.Duration.hours(1), 'SampleCount'),
      threshold: 1,
      // All 26 must breach: with no DatapointsToAlarm, CloudWatch requires
      // every evaluated period to breach.
      evaluationPeriods: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actions,
    });

    // The dimensionless ReportsCreated the intakes emit beside the
    // (Role, Verified) values: every report, whatever its role.
    jaleAlarm(this, 'ReportsCreatedSpikeAlarm', {
      alarmName: 'ReportsCreatedSpike',
      alarmDescription: 'More than 20 problem reports were created in 15 minutes.',
      metric: metric('ReportsCreated', cdk.Duration.minutes(15)),
      threshold: 20,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      actions,
    });

    anyOf(
      'ReportRateLimitedGlobalAlarm',
      'ReportRateLimitedGlobal',
      'A signed-out report was refused by the global daily cap.',
      metric('ReportRateLimited', cdk.Duration.minutes(15), 'Sum', { Scope: 'global' }),
    );

    // The share of screenshot captures that produced an image, among the
    // captures that ran (ok, timeout, failed). A removed, attached or absent
    // capture is a choice, not a capture result, so it is left out. A day
    // with no capture has no share, which is not a breach.
    const captureOutcome = (outcome: string) =>
      metric('ReportCapture', cdk.Duration.days(1), 'Sum', { Outcome: outcome });
    jaleAlarm(this, 'ReportCaptureSuccessShareAlarm', {
      alarmName: 'ReportCaptureSuccessShare',
      alarmDescription:
        `The daily share of screenshot captures that succeeded was under ${REPORT_CAPTURE_SUCCESS_SHARE_THRESHOLD}%.`,
      metric: new cloudwatch.MathExpression({
        label: 'Capture success share (%)',
        expression:
          'IF((FILL(ok, 0) + FILL(timeout, 0) + FILL(failed, 0)) > 0, '
          + '100 * FILL(ok, 0) / (FILL(ok, 0) + FILL(timeout, 0) + FILL(failed, 0)))',
        usingMetrics: {
          ok: captureOutcome('ok'),
          timeout: captureOutcome('timeout'),
          failed: captureOutcome('failed'),
        },
        period: cdk.Duration.days(1),
      }),
      threshold: REPORT_CAPTURE_SUCCESS_SHARE_THRESHOLD,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actions,
    });
  }
}
