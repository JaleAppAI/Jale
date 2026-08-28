import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { lambdaIntegration } from '../api-integration';

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
  /**
   * Name of the SES configuration set this stack CREATES, and that BillingStack's
   * sweeper tags every outgoing message with. A literal threaded from
   * bin/jale-app.ts to both stacks rather than a CDK reference between them --
   * BillingStack is instantiated first (it must be; this stack consumes
   * api.publicResource), so a real reference in this direction is a cycle.
   *
   * OPTIONAL, and absent is a supported deployment: no configuration set, no
   * event destination, no SNS topic and no feedback Lambda are created, the
   * sweeper sends without the X-SES-CONFIGURATION-SET header, and nothing
   * listens for bounces. That is what keeps `cdk synth` working for a
   * developer with no SES wiring, and it is why notifications-stack.test.ts's
   * default harness still synths with the prop omitted.
   */
  readonly emailConfigurationSetName?: string;
}

/**
 * NotificationsStack — the employer daily-digest lane.
 *
 * Resources:
 *   EmployerDigestProducerLambda    EventBridge every 15 min, DB-only, jale_admin
 *   DigestUnsubscribeLambda         POST /public/employer-digest/unsubscribe (UNAUTHENTICATED)
 *   DigestUnsubscribeSecret         HMAC signing key for the unsubscribe links
 *   EmployerEmailConfigurationSet   SES configuration set (only with emailConfigurationSetName)
 *   EmployerEmailFeedbackTopic      SNS topic for its BOUNCE/COMPLAINT events
 *   SesFeedbackHandlerLambda        applies those events, jale_admin
 *
 * The producer writes rows into `email_outbox` (migration 037) and the
 * EXISTING BillingStack EmailOutboxSweeperLambda drains them via SES,
 * unchanged. Nothing in this stack sends mail directly, and nothing here holds
 * a send permission: the configuration set below is a RECEIVE-side construct
 * (it names where delivery events go), and the sweeper that tags messages with
 * it lives in BillingStack with the ses:SendEmail grant.
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
    // billing-stack.ts:364/392 is the precedent. AiStack/ReferralsStack/
    // WhatsAppStack carried the broken $.metric idiom until sprint 22 R2-G
    // converted them; test/unit/stacks/metric-filter-patterns.test.ts now
    // fails any stack that reintroduces it.
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

    // ── SES delivery feedback ─────────────────────────────────────
    // Configuration set -> SNS event destination -> topic -> Lambda ->
    // migration 087's definer. Created as a unit or not at all: an event
    // destination with no topic, or a topic with nothing subscribed, is a
    // configuration that looks wired and silently drops every bounce.
    if (props.emailConfigurationSetName) {
      const configurationSet = new ses.CfnConfigurationSet(this, 'EmployerEmailConfigurationSet', {
        name: props.emailConfigurationSetName,
      });

      // Not encrypted with a KMS key: SES publishes to this topic from the SES
      // service principal, and an SSE-KMS topic needs a customer-managed key
      // with a policy granting ses.amazonaws.com kms:GenerateDataKey. The
      // payload is a message id, an event type and a recipient address -- the
      // recipient is the only sensitive field, and it is one this account
      // already holds in email_outbox.
      const feedbackTopic = new sns.Topic(this, 'EmployerEmailFeedbackTopic', {
        topicName: `${props.emailConfigurationSetName}-feedback`,
        displayName: 'SES bounce and complaint events for employer email',
      });

      // Without this the lane is inert and every signal says it is healthy.
      // SES publishes as the `ses.amazonaws.com` service principal, and
      // nothing in `new sns.Topic` or the L1 event destination grants it
      // `sns:Publish` — SES would drop each bounce on its own side, so the
      // handler is never invoked, its error alarm never fires, and
      // ses_feedback_unknown_message never counts. `aws:SourceAccount` keeps
      // it from being a confused deputy: any account's SES could otherwise
      // publish a Complaint here and switch an employer's digest off.
      const feedbackPublish = feedbackTopic.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowSesEventPublish',
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [feedbackTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }));

      const feedbackLambda = new JaleLambdaFunction(this, 'SesFeedbackHandlerLambda', {
        entry: path.join(__dirname, '../../lambda/notifications/ses-feedback-handler.ts'),
        description: 'SES bounce/complaint handler — switches the employer digest off',
        environment: {
          // The SAME jale_admin secret the digest settings API uses: the
          // handler reads email_outbox under 037's admin policy and calls
          // 087's definer, both of which are granted to jale_admin and to
          // nothing else.
          DB_SECRET_ARN: props.dbSecret.secretArn,
        },
        // One SNS record per invocation, two short queries. 30s is the default
        // and is generous; the point of naming it is that a hung DB connection
        // must not hold a VPC ENI for the full Lambda maximum.
        timeout: 30,
        ...lambdaProps,
      });
      props.dbSecret.grantRead(feedbackLambda.function);
      feedbackTopic.addSubscription(new snsSubscriptions.LambdaSubscription(feedbackLambda.function));

      // BOUNCE and COMPLAINT only. DELIVERY/SEND/OPEN/CLICK would multiply the
      // topic's traffic by the whole send volume to tell the handler nothing
      // it acts on.
      const feedbackDestination = new ses.CfnConfigurationSetEventDestination(
        this,
        'EmployerEmailFeedbackDestination',
        {
          configurationSetName: configurationSet.ref,
          eventDestination: {
            name: 'bounce-and-complaint-to-sns',
            enabled: true,
            matchingEventTypes: ['BOUNCE', 'COMPLAINT'],
            snsDestination: { topicArn: feedbackTopic.topicArn },
          },
        },
      );
      // SES checks it can publish when the destination is created, so the
      // topic policy has to land first. CloudFormation infers no ordering
      // between them: both only reference the topic.
      if (feedbackPublish.policyDependable) {
        feedbackDestination.node.addDependency(feedbackPublish.policyDependable);
      }

      notificationsAlarm(
        'SesFeedbackHandlerErrorsAlarm',
        'SesFeedbackHandlerErrors',
        'ses-feedback-handler Lambda reported an unhandled error — bounce and complaint events are '
          + 'not being applied, so a dead mailbox keeps receiving a daily digest.',
        feedbackLambda.function.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      );

      // Same literal-term filter reasoning as the producer's metrics above.
      for (const [id, literal, alarmName, alarmDescription] of [
        [
          'SesFeedbackMalformed',
          'ses_feedback_malformed',
          'SesFeedbackMalformed',
          'An SES notification arrived that the feedback handler could not parse. It is dropped, not '
            + 'retried, so nothing else reports it — and a payload shape change means bounces stop '
            + 'being applied entirely.',
        ],
        [
          'SesFeedbackUnknownMessage',
          'ses_feedback_unknown_message',
          'SesFeedbackUnknownMessage',
          'A bounce or complaint named a message id no email_outbox row claims. Expected for mail sent '
            + 'before migration 087; sustained afterwards it means ses_message_id is not being persisted.',
        ],
      ] as const) {
        const metricFilter = new logs.MetricFilter(this, `${id}Metric`, {
          logGroup: feedbackLambda.logGroup,
          filterPattern: logs.FilterPattern.literal(`"${literal}"`),
          metricNamespace: 'Jale/Notifications',
          metricName: id,
          metricValue: '1',
        });
        notificationsAlarm(
          `${id}Alarm`,
          alarmName,
          alarmDescription,
          metricFilter.metric({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
        );
      }
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
      .addMethod('POST', lambdaIntegration(unsubscribeLambda.function));
  }
}
