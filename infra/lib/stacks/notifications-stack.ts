import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface NotificationsStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  /**
   * Shared `network.lambdaSg` — the SAME security group AuthStack, AiStack and
   * MatchingStack use, deliberately NOT a dedicated one.
   *
   * ReferralsStack and BillingStack each got their own SG because each of them
   * connects as its own least-privilege database role (jale_public_jobs,
   * jale_billing) and the SG is part of keeping those lanes separable. This
   * stack has no such role: both Lambdas connect as jale_admin using the
   * shared `dbSecret`, exactly like every ApiStack Lambda, because the tables
   * they touch (employer_digest_settings, jobs, job_applications, email_outbox)
   * carry RLS policies written TO jale_admin, and the one cross-tenant read
   * they need is fenced behind migration 082's SECURITY DEFINER functions
   * rather than behind a role of their own. A dedicated SG would suggest an
   * isolation boundary that does not exist here.
   */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** App DB credential (jale_admin) — the same secret ApiStack Lambdas use. */
  readonly dbSecret: secretsmanager.ISecret;
  /**
   * ApiStack's exported `/public` resource. Reused, never re-declared: two
   * stacks calling `addResource('public')` on the same RestApi is a
   * construct-id collision at synth, and which stack wins depends on
   * instantiation order in bin/jale-app.ts.
   */
  readonly publicResource: apigateway.Resource;
  /**
   * Existing monitored SNS topic for alarm actions — the same shared
   * `whatsappAlarmTopicArn` context AiStack/WhatsAppStack/ReferralsStack read.
   *
   * Optional, following ReferralsStack rather than AiStack/WhatsAppStack: this
   * stack is new, so there is no retrofitted-alarms-with-no-target problem to
   * fail closed on, and notifications-stack.test.ts synths without the prop.
   * Absent means "alarm exists and is visible in the console but pages nobody".
   */
  readonly alarmTopicArn?: string;
}

/**
 * NotificationsStack — the employer daily-digest lane.
 *
 * Resources:
 *   EmployerDigestProducerLambda  EventBridge every 15 min, DB-only, jale_admin
 *   DigestUnsubscribeLambda       POST /public/employer-digest/unsubscribe (UNAUTHENTICATED)
 *   DigestUnsubscribeSecret       HMAC signing key for the unsubscribe links
 *
 * The producer writes rows into `email_outbox` (migration 037) and the
 * EXISTING BillingStack EmailOutboxSweeperLambda drains them via SES,
 * unchanged. Nothing in this stack sends mail directly, and nothing here needs
 * SES permissions.
 *
 * Per-method throttles for the unauthenticated route live in ApiStack's single
 * centralized MethodSettings array — this stack must NOT call
 * addPropertyOverride('MethodSettings').
 *
 * The API Gateway Resource and Method constructs created below are children of
 * ApiStack's RestApi construct, so those two CloudFormation resources land in
 * the ApiStack template, not this one. That is why the route assertions for
 * this feature live in api-stack.test.ts.
 */
export class NotificationsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NotificationsStackProps) {
    super(scope, id, props);

    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';

    // Required — the producer mints absolute dashboard/job/unsubscribe links
    // into an email. A relative path is dead the moment it lands in an inbox,
    // and there is no runtime fallback, so fail closed at synth. Same shape as
    // ReferralsStack's check; CI already passes -c publicSiteBaseUrl=... so no
    // workflow change is needed for this.
    //
    // It is NOT derived from props.api.url: an API Gateway URL in a Lambda env
    // var creates an ApiStack <-> this-stack reference cycle (documented at
    // whatsapp-stack.ts:174-183) and would also mail an API origin to a human.
    const publicSiteBaseUrlRaw = this.node.tryGetContext('publicSiteBaseUrl')
      ?? process.env.JALE_PUBLIC_SITE_BASE_URL;
    if (!publicSiteBaseUrlRaw) {
      throw new Error(
        'NotificationsStack requires publicSiteBaseUrl context (or JALE_PUBLIC_SITE_BASE_URL env var) — '
        + 'pass -c publicSiteBaseUrl=https://jaleapp.ai',
      );
    }
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(publicSiteBaseUrlRaw);
    } catch {
      throw new Error('publicSiteBaseUrl must be a valid absolute http(s) URL');
    }
    if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
      throw new Error('publicSiteBaseUrl must be a valid absolute http(s) URL');
    }
    const publicSiteBaseUrl = publicSiteBaseUrlRaw.replace(/\/+$/, '');

    // ── Secret: unsubscribe link signing key ──────────────────────
    // A bare generated string (no generateStringKey), the same shape as
    // ReferralsStack's visitor salt, and for the same reason: an env var lands
    // in the CloudFormation template, cdk diff output, and every
    // lambda:GetFunctionConfiguration response, and this key is the only thing
    // that makes an unsubscribe link unforgeable.
    //
    // ROTATION WARNING: rotating this secret invalidates EVERY unsubscribe link
    // already sitting in an employer's inbox. Unlike the visitor salt (where a
    // rotation merely resets a 30-minute de-duplication window), that is
    // user-visible: an old link starts returning invalid_token. To revoke one
    // employer's links, bump their unsubscribe_token_version instead.
    const unsubscribeSecret = new secretsmanager.Secret(this, 'DigestUnsubscribeSecret', {
      secretName: 'jale/notifications/unsubscribe-signing-secret',
      description: 'HMAC-SHA256 signing key for employer digest one-click unsubscribe links',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    const lambdaProps = {
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
    };

    // ── DLQ for the producer's ASYNC invocations ───────────────────
    // EventBridge invokes the producer asynchronously, so a failure is retried
    // by the Lambda service and then silently discarded unless there is a DLQ.
    // Same shape as AuthStack's PostConfirmationDlq: retryAttempts 0 because a
    // whole-run failure is not usefully retried on a 15-minute cadence (the
    // next sweep re-reads the due list, and no watermark was advanced), and
    // maxEventAge 1 hour so a stale event cannot fire hours later.
    const producerDlq = new sqs.Queue(this, 'EmployerDigestProducerDlq', {
      queueName: 'jale-employer-digest-producer-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    const producerLambda = new JaleLambdaFunction(this, 'EmployerDigestProducerLambda', {
      entry: path.join(__dirname, '../../lambda/notifications/employer-digest-producer.ts'),
      description: 'Employer daily digest producer',
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        UNSUBSCRIBE_SECRET_ARN: unsubscribeSecret.secretArn,
        PUBLIC_SITE_BASE_URL: publicSiteBaseUrl,
      },
      // The default 30s is not enough: one run walks every due employer, and
      // each employer costs a jobs read plus three queries per active job
      // inside listEmployerCandidates. 120s is bounded well under the
      // 15-minute cadence, and a timeout is recoverable rather than lossy --
      // employers are committed one at a time and an unprocessed tail never had
      // its watermark advanced, so the next sweep picks it up.
      timeout: 120,
      // Serializes the sweep against itself. The hour predicate in
      // due_digest_employers() is true for four consecutive sweeps, and only
      // the committed watermark makes the digest at-most-once; two overlapping
      // runs would race on that watermark. The idempotency key is the second
      // line of defence, not the first.
      reservedConcurrentExecutions: 1,
      deadLetterQueue: producerDlq,
      retryAttempts: 0,
      maxEventAge: cdk.Duration.hours(1),
      ...lambdaProps,
    });
    props.dbSecret.grantRead(producerLambda.function);
    unsubscribeSecret.grantRead(producerLambda.function);
    producerDlq.grantSendMessages(producerLambda.function);

    new events.Rule(this, 'EmployerDigestProducerRule', {
      // 15 minutes, not 60: send_hour_local is an hour in the employer's own
      // zone, and several real zones sit on 30- or 45-minute offsets, so an
      // hourly sweep would systematically mistime those employers.
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      description: 'Employer daily digest sweep — asks the DB who is due right now',
      targets: [new eventTargets.LambdaFunction(producerLambda.function)],
    });

    // ── Unsubscribe Lambda ────────────────────────────────────────
    const unsubscribeLambda = new JaleLambdaFunction(this, 'DigestUnsubscribeLambda', {
      entry: path.join(__dirname, '../../lambda/notifications/unsubscribe.ts'),
      description: 'Employer digest unsubscribe endpoint (unauthenticated)',
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        UNSUBSCRIBE_SECRET_ARN: unsubscribeSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.dbSecret.grantRead(unsubscribeLambda.function);
    unsubscribeSecret.grantRead(unsubscribeLambda.function);

    // ── Alarms ────────────────────────────────────────────────────
    // Four failure shapes, four signals. The last two exist because the
    // producer is deliberately per-employer fault-tolerant: it catches, counts,
    // and CONTINUES, which means signals 1 and 2 are blind to anything that
    // goes wrong with an individual employer.
    //   1. DLQ depth — an async invocation the Lambda service gave up on.
    //   2. Lambda Errors — the run itself threw (bad config, unreadable signing
    //      secret, dead connection).
    //   3. digest_skipped_invalid_email — the DELIBERATE skip: a stored address
    //      that cannot satisfy email_outbox's CHECK. Returns normally.
    //   4. digest_employer_failed — ANY per-employer rollback. Returns normally.
    let alarmAction: cloudwatchActions.SnsAction | undefined;
    if (props.alarmTopicArn) {
      const alarmTopic = sns.Topic.fromTopicArn(this, 'NotificationsAlarmTopic', props.alarmTopicArn);
      alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
    }

    const notificationsAlarm = (
      constructId: string,
      alarmName: string,
      alarmDescription: string,
      metric: cloudwatch.IMetric,
    ): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, constructId, {
        alarmName,
        alarmDescription,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      if (alarmAction) {
        alarm.addAlarmAction(alarmAction);
        // OK action too: these alarms describe transient conditions (a DLQ that
        // gets drained, an address that gets fixed), so the operator needs the
        // recovery notification, not just the break.
        alarm.addOkAction(alarmAction);
      }
      return alarm;
    };

    notificationsAlarm(
      'EmployerDigestProducerDlqAlarm',
      'EmployerDigestProducerDlqDepth',
      'An employer-digest producer invocation was dead-lettered — a whole sweep was lost',
      producerDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
    );

    notificationsAlarm(
      'EmployerDigestProducerErrorsAlarm',
      'EmployerDigestProducerErrors',
      'employer-digest-producer Lambda reported an unhandled error',
      producerLambda.function.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
    );

    // ── Silent per-employer outcomes -> alarmable metrics ─────────
    // LITERAL term patterns, deliberately NOT `FilterPattern.stringValue(
    // '$.metric', ...)`. A JSON filter pattern requires the whole log EVENT to
    // parse as JSON, and Node 20 Lambda's default TEXT log format prefixes
    // every console line with `timestamp<TAB>requestId<TAB>LEVEL<TAB>` -- so a
    // `{ $.metric = "..." }` pattern matches nothing and the alarm is silently
    // disarmed. A quoted term matches the substring inside the JSON.stringify
    // output under BOTH the text and JSON log formats.
    // billing-stack.ts:364/392 is the precedent; the $.metric idiom used by
    // AiStack/ReferralsStack/WhatsAppStack is the thing being avoided here.
    //
    // The literals must match what employer-digest-producer.ts writes. A rename
    // on either side silently disarms the alarm, so keep the two in step.
    for (const [id, literal, metricName, alarmName, alarmDescription] of [
      [
        'EmployerDigestSkippedInvalidEmail',
        'digest_skipped_invalid_email',
        'EmployerDigestSkippedInvalidEmail',
        'EmployerDigestSkippedInvalidEmail',
        'An employer with the digest enabled was skipped because their stored email address is unusable. '
          + 'Nothing throws on this path and their watermark is not advanced, so they simply never receive a digest.',
      ],
      [
        'EmployerDigestEmployerFailed',
        'digest_employer_failed',
        'EmployerDigestEmployerFailed',
        'EmployerDigestEmployerFailed',
        'A single employer’s digest transaction was rolled back — a constraint violation, an outbox '
          + 'idempotency conflict, or a mid-loop AWS throttle. The run continues and returns normally, so the '
          + 'Lambda Errors metric and the DLQ are both blind to this. That employer got no digest today.',
      ],
    ] as const) {
      const metricFilter = new logs.MetricFilter(this, `${id}Metric`, {
        logGroup: producerLambda.logGroup,
        filterPattern: logs.FilterPattern.literal(`"${literal}"`),
        metricNamespace: 'Jale/Notifications',
        metricName,
        metricValue: '1',
      });
      notificationsAlarm(
        `${id}Alarm`,
        alarmName,
        alarmDescription,
        metricFilter.metric({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      );
    }

    // ── Route ─────────────────────────────────────────────────────
    // POST /public/employer-digest/unsubscribe — UNAUTHENTICATED. The
    // method-options argument is omitted ENTIRELY, matching the
    // ReferralsStack/DocumentsStack/LegalStack idiom for downstream stacks
    // adding unauthenticated methods to the shared API.
    //
    // Throttle (burst 10 / rate 5, the unauthenticated-write tier) lives in
    // ApiStack's centralized MethodSettings array, not here.
    props.publicResource
      .addResource('employer-digest')
      .addResource('unsubscribe')
      .addMethod('POST', new apigateway.LambdaIntegration(unsubscribeLambda.function));
  }
}
