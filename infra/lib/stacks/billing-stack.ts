import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface BillingStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  /** Dedicated billing security group (billingLambdaSg from NetworkStack) */
  readonly billingLambdaSg: ec2.ISecurityGroup;
  /** jale/billing/db secret (CDK-created in DatabaseStack) — processor (jale_billing role) ONLY */
  readonly billingDbSecret: secretsmanager.ISecret;
  /**
   * App DB credential (jale_admin role) — same secret ApiStack Lambdas use.
   * The jale_billing role (034) is processor-only: no billing_operations grant,
   * no users access, and owner RLS policies are TO jale_admin. The user-facing
   * billing Lambdas (get-billing, checkout, portal) must use this credential.
   */
  readonly appDbSecret: secretsmanager.ISecret;
  /** Shared REST API from ApiStack */
  readonly api: apigateway.RestApi;
  /** Employer Cognito authorizer from ApiStack */
  readonly employerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  /** /employer resource from ApiStack — billing routes hang off it */
  readonly employerResource: apigateway.Resource;
}

export function validateBillingEmailConfiguration(
  emailFromAddress: string | undefined,
  sesVerifiedIdentityArn: string | undefined,
): void {
  if (!emailFromAddress || !sesVerifiedIdentityArn) {
    throw new Error('emailFromAddress and sesVerifiedIdentityArn are required for billing email delivery');
  }
}

/**
 * BillingStack — Stripe subscription management for employers.
 *
 * Routes:
 *   GET  /employer/billing              → get-billing Lambda (employer auth)
 *   POST /employer/billing/checkout     → checkout Lambda  (employer auth, Idempotency-Key)
 *   POST /employer/billing/portal       → portal Lambda    (employer auth)
 *   POST /billing/webhook               → webhook verifier Lambda (no auth, Stripe HMAC)
 *
 * Secret isolation (rule 9 of the A6 spec):
 *   get-billing : DB_SECRET_ARN (app DB / jale_admin) only
 *   checkout    : DB_SECRET_ARN (app DB / jale_admin) + STRIPE_SECRET_ARN
 *   portal      : DB_SECRET_ARN (app DB / jale_admin) + STRIPE_SECRET_ARN
 *   webhook     : WEBHOOK_SECRET_ARN + QUEUE_URL (no DB, no Stripe API key)
 *   processor   : DB_SECRET_ARN (jale/billing/db / jale_billing) + STRIPE_SECRET_ARN (SQS consumer)
 *
 * DB role split (intended design, migration 034): jale_billing is a processor-only
 * service role — it is granted billing_plans/billing_customers/subscriptions/
 * billing_webhook_events but NOT billing_operations, and has no users access. Owner
 * RLS policies on those tables are TO jale_admin. The three user-facing Lambdas
 * (get-billing, checkout, portal) therefore use the same app DB credential
 * (jale_admin) that ApiStack Lambdas use, not billingDbSecret.
 *
 * Secrets imported by name (operator-created, never CDK-created):
 *   jale/billing/stripe-api  — Stripe API secret key
 *   jale/billing/webhook     — Stripe webhook signing secret
 */
export class BillingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const billingAlarmEmail = this.node.tryGetContext('billingAlarmEmail');
    const billingAlarmTopicArn = this.node.tryGetContext('billingAlarmTopicArn');
    const emailFromAddress = this.node.tryGetContext('emailFromAddress') as string | undefined;
    const sesVerifiedIdentityArn = this.node.tryGetContext('sesVerifiedIdentityArn') as string | undefined;
    validateBillingEmailConfiguration(emailFromAddress, sesVerifiedIdentityArn);
    const requiredEmailFromAddress = emailFromAddress!;
    const requiredSesVerifiedIdentityArn = sesVerifiedIdentityArn!;

    // ── Import operator-created secrets by name ──
    // These secrets are never CDK-managed; CDK only imports the ARN reference.
    const stripeApiSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'StripeApiSecret',
      'jale/billing/stripe-api',
    );
    const webhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'WebhookSecret',
      'jale/billing/webhook',
    );

    // ── DLQ + main queue ──
    // Processor Lambda timeout = 60 s → visibilityTimeout must be >= 6× = 360 s.
    const webhookDlq = new sqs.Queue(this, 'BillingWebhookDlq', {
      queueName: 'billing-webhook-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    const webhookQueue = new sqs.Queue(this, 'BillingWebhookQueue', {
      queueName: 'billing-webhook-queue',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: webhookDlq,
        maxReceiveCount: 3,
      },
    });

    // ── Lambda: get-billing ──
    // App DB (jale_admin) only — no Stripe secrets. jale_billing is processor-only.
    const getBillingLambda = new JaleLambdaFunction(this, 'GetBillingLambda', {
      entry: path.join(__dirname, '../../lambda/billing/get-billing.ts'),
      description: 'Returns employer billing status and plan entitlements',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.appDbSecret.grantRead(getBillingLambda.function);

    // ── Lambda: checkout ──
    // App DB (jale_admin) + Stripe API key. jale_billing is processor-only.
    const checkoutLambda = new JaleLambdaFunction(this, 'CheckoutLambda', {
      entry: path.join(__dirname, '../../lambda/billing/checkout.ts'),
      description: 'Creates Stripe Checkout session for employer subscription',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        STRIPE_SECRET_ARN: stripeApiSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.appDbSecret.grantRead(checkoutLambda.function);
    stripeApiSecret.grantRead(checkoutLambda.function);

    // ── Lambda: portal ──
    // App DB (jale_admin) + Stripe API key. jale_billing is processor-only.
    const portalLambda = new JaleLambdaFunction(this, 'PortalLambda', {
      entry: path.join(__dirname, '../../lambda/billing/portal.ts'),
      description: 'Creates Stripe Customer Portal session for billing management',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        STRIPE_SECRET_ARN: stripeApiSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.appDbSecret.grantRead(portalLambda.function);
    stripeApiSecret.grantRead(portalLambda.function);

    // ── Lambda: webhook verifier ──
    // Webhook secret + queue URL ONLY.  No DB access, no Stripe API key.
    // Must run outside the VPC? No — billingLambdaSg is already HTTPS-egress only,
    // which is fine for SQS calls via the S3 gateway / NAT.  Keep it in VPC for
    // consistency and to avoid a public function URL footprint.
    const webhookVerifierLambda = new JaleLambdaFunction(this, 'BillingWebhookLambda', {
      entry: path.join(__dirname, '../../lambda/billing/webhook.ts'),
      description: 'Verifies Stripe webhook signature and queues to SQS',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        QUEUE_URL: webhookQueue.queueUrl,
      },
      nodeModules: ['@aws-sdk/client-sqs'],
    });
    webhookSecret.grantRead(webhookVerifierLambda.function);
    webhookQueue.grantSendMessages(webhookVerifierLambda.function);

    // ── Lambda: processor (SQS consumer) ──
    // DB + Stripe API key.
    const processorLambda = new JaleLambdaFunction(this, 'BillingProcessorLambda', {
      entry: path.join(__dirname, '../../lambda/billing/processor.ts'),
      description: 'Processes verified Stripe webhook events from SQS',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      timeout: 60,
      environment: {
        DB_SECRET_ARN: props.billingDbSecret.secretArn,
        STRIPE_SECRET_ARN: stripeApiSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.billingDbSecret.grantRead(processorLambda.function);
    stripeApiSecret.grantRead(processorLambda.function);

    webhookQueue.grantConsumeMessages(processorLambda.function);
    processorLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(webhookQueue, {
        batchSize: 1,
        maxConcurrency: 3,
        reportBatchItemFailures: true,
      }),
    );

    const emailSweeperLambda = new JaleLambdaFunction(this, 'EmailOutboxSweeperLambda', {
        entry: path.join(__dirname, '../../lambda/billing/email-outbox-sweeper.ts'),
        description: 'Sends durable billing email outbox messages through SES',
        vpc: props.vpc,
        securityGroups: [props.billingLambdaSg],
        environment: {
          DB_SECRET_ARN: props.appDbSecret.secretArn,
          EMAIL_FROM_ADDRESS: requiredEmailFromAddress,
          ALLOWED_ORIGIN: allowedOrigin,
        },
        nodeModules: ['@aws-sdk/client-ses'],
    });
    props.appDbSecret.grantRead(emailSweeperLambda.function);
    emailSweeperLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [requiredSesVerifiedIdentityArn],
    }));
    new events.Rule(this, 'EmailOutboxSweepSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(emailSweeperLambda.function)],
    });

    // ── Routes ──
    // /employer/billing — employer-auth routes
    const billingResource = props.employerResource.addResource('billing');

    billingResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(getBillingLambda.function),
      {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    billingResource.addResource('checkout').addMethod(
      'POST',
      new apigateway.LambdaIntegration(checkoutLambda.function),
      {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    billingResource.addResource('portal').addMethod(
      'POST',
      new apigateway.LambdaIntegration(portalLambda.function),
      {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    // POST /billing/webhook — public, no Cognito auth; Stripe HMAC validated in handler
    props.api.root
      .addResource('billing')
      .addResource('webhook')
      .addMethod('POST', new apigateway.LambdaIntegration(webhookVerifierLambda.function));

    // ── Alarm notifications ──
    // billingAlarmTopicArn (if set) imports an existing monitored ops topic and
    // takes precedence over creating a new one. billingAlarmEmail only applies
    // to the CDK-created topic — subscribing to an imported topic from this
    // stack's account context isn't reliable, so that case is left to the
    // operator to wire up out-of-band.
    const alarmTopic = billingAlarmTopicArn
      ? sns.Topic.fromTopicArn(this, 'BillingAlarmTopic', billingAlarmTopicArn)
      : new sns.Topic(this, 'BillingAlarmTopic', { topicName: 'jale-billing-alarms' });

    if (!billingAlarmTopicArn && billingAlarmEmail) {
      (alarmTopic as sns.Topic).addSubscription(
        new subscriptions.EmailSubscription(billingAlarmEmail),
      );
    }

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    // ── CloudWatch Alarms ──
    const dlqDepthAlarm = new cloudwatch.Alarm(this, 'BillingWebhookDlqAlarm', {
      metric: webhookDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'BillingWebhookDlqDepth',
    });
    dlqDepthAlarm.addAlarmAction(alarmAction);
    dlqDepthAlarm.addOkAction(alarmAction);

    const processorThrottleAlarm = new cloudwatch.Alarm(this, 'BillingProcessorThrottleAlarm', {
      metric: processorLambda.function.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmName: 'BillingProcessorThrottles',
    });
    processorThrottleAlarm.addAlarmAction(alarmAction);
    processorThrottleAlarm.addOkAction(alarmAction);

    // ── Checkout error taxonomy metrics ──
    // Distinguish permanent Stripe configuration errors (checkout.ts logs
    // "billing-checkout configuration error: <reason>") from retryable
    // provider outages (checkout.ts logs "billing-checkout provider error:
    // <code>") so on-call sees a config break as a hard page, not noise
    // indistinguishable from Stripe having a bad day.
    const checkoutConfigErrorFilter = new logs.MetricFilter(this, 'CheckoutConfigErrorMetricFilter', {
      logGroup: checkoutLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'CheckoutConfigError',
      filterPattern: logs.FilterPattern.literal('"billing-checkout configuration error"'),
      metricValue: '1',
    });

    // Available for dashboards/ad-hoc alarms even though no alarm currently
    // keys off it directly.
    new logs.MetricFilter(this, 'CheckoutProviderErrorMetricFilter', {
      logGroup: checkoutLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'CheckoutProviderError',
      filterPattern: logs.FilterPattern.literal('"billing-checkout provider error"'),
      metricValue: '1',
    });

    const checkoutConfigErrorAlarm = new cloudwatch.Alarm(this, 'CheckoutConfigErrorAlarm', {
      metric: checkoutConfigErrorFilter.metric({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'CheckoutConfigErrorAlarm',
    });
    checkoutConfigErrorAlarm.addAlarmAction(alarmAction);
    checkoutConfigErrorAlarm.addOkAction(alarmAction);

    for (const [id, literal, metricName, alarmName] of [
      ['EmailOutboxRetryable', 'email_outbox_retryable_failure', 'EmailOutboxRetryableFailure', 'EmailOutboxRetryableFailureAlarm'],
      ['EmailOutboxUnknown', 'email_outbox_send_unknown', 'EmailOutboxSendUnknown', 'EmailOutboxSendUnknownAlarm'],
      ['EmailOutboxAttemptCap', 'email_outbox_attempt_cap', 'EmailOutboxAttemptCap', 'EmailOutboxAttemptCapAlarm'],
    ] as const) {
      const metricFilter = new logs.MetricFilter(this, `${id}MetricFilter`, {
        logGroup: emailSweeperLambda.logGroup,
        metricNamespace: 'Jale/Billing',
        metricName,
        filterPattern: logs.FilterPattern.literal(`"${literal}"`),
        metricValue: '1',
      });
      const alarm = new cloudwatch.Alarm(this, `${id}Alarm`, {
        metric: metricFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmName,
      });
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    // ── Unknown-customer terminal skip ──
    // processor.ts terminally skips a Stripe event whose customer has no
    // billing_customers row: the inbox row goes 'skipped' and the SQS message
    // is deleted, so the event never reaches the DLQ and
    // BillingWebhookDlqDepth stays silent. Nothing reads
    // billing_webhook_events either, so this filter over the PROCESSOR's log
    // group (not the sweeper's) is the only signal that an unmapped customer
    // is sending us events. The literal must match the console.warn payload in
    // lambda/billing/processor.ts.
    const unknownCustomerSkipFilter = new logs.MetricFilter(this, 'BillingUnknownCustomerSkippedMetricFilter', {
      logGroup: processorLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'BillingUnknownCustomerSkipped',
      filterPattern: logs.FilterPattern.literal('"billing_unknown_customer_skipped"'),
      metricValue: '1',
    });
    const unknownCustomerSkipAlarm = new cloudwatch.Alarm(this, 'BillingUnknownCustomerSkippedAlarm', {
      metric: unknownCustomerSkipFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'BillingUnknownCustomerSkipped',
    });
    unknownCustomerSkipAlarm.addAlarmAction(alarmAction);
    unknownCustomerSkipAlarm.addOkAction(alarmAction);

    // ── Known-but-skipped subscription lifecycle event ──
    // processor.ts recognises customer.subscription.trial_will_end but
    // deliberately mirrors nothing for it, marking the inbox row 'skipped'
    // and letting SQS delete the message. Like the unknown-customer skip
    // above, that is silent at every level — no DLQ, no inbox reader — so
    // this filter over the PROCESSOR's log group is the only signal that a
    // billing lifecycle event is being dropped. It stays quiet until someone
    // configures a trial price, which is exactly when we want to be told.
    // (invoice.finalized is skipped too but intentionally NOT logged: it
    // fires on every invoice and would keep this alarm permanently
    // breached.) The literal must match the console.warn call in
    // lambda/billing/processor.ts.
    const knownEventSkipFilter = new logs.MetricFilter(this, 'BillingKnownEventSkippedMetricFilter', {
      logGroup: processorLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'BillingKnownEventSkipped',
      filterPattern: logs.FilterPattern.literal('"billing_event_skipped_known"'),
      metricValue: '1',
    });
    const knownEventSkipAlarm = new cloudwatch.Alarm(this, 'BillingKnownEventSkippedAlarm', {
      metric: knownEventSkipFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'BillingKnownEventSkipped',
    });
    knownEventSkipAlarm.addAlarmAction(alarmAction);
    knownEventSkipAlarm.addOkAction(alarmAction);
  }
}
