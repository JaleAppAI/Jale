import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { JaleCognitoPool } from '../constructs/cognito-pool';
import { VoiceTranscriptionPipeline } from '../constructs/voice-transcription-pipeline';
import { normalizeWhatsappStatusCallbackUrl } from '../whatsapp-status-callback-url';

export interface WhatsAppStackProps extends cdk.StackProps {
  /** VPC shared across all stacks */
  readonly vpc: ec2.IVpc;
  /** Private-with-egress subnets (NAT-backed in V1) */
  readonly privateSubnets: ec2.ISubnet[];
  /** Lambda security group */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** jale_admin DB secret (NOT used by WhatsApp Lambdas — they use their own) */
  readonly dbSecret: secretsmanager.ISecret;
  /** Worker Cognito pool used for admin creation and CUSTOM_AUTH */
  readonly workerPool: JaleCognitoPool;
  /** Existing API Gateway (from ApiStack) — webhook route added here */
  readonly api: apigateway.RestApi;
  readonly workerRerankQueue?: sqs.IQueue;
  readonly questionGeneratorFn: lambda.IFunction;
  readonly trustAssessmentQueue: sqs.IQueue;
  /** Exact public API Gateway URL configured in Twilio for delivery callbacks. */
  readonly statusCallbackUrl: string;
  /**
   * Existing SNS topic ARN for WhatsApp operational alarms. An alarm with no
   * subscriber is not actionable, so the stack fails synth unless either this
   * ARN or the `whatsappAlarmEmail` context (which subscribes a CDK-created
   * topic) is provided.
   */
  readonly alarmTopicArn?: string;
}

/**
 * WhatsAppStack — V1 WhatsApp integration infrastructure.
 *
 * Creates 3 Lambdas (webhook, processor, job-alert), an SQS queue + DLQ,
 * and a POST /whatsapp/webhook route on the existing API Gateway. The route
 * is intentionally UNAUTHENTICATED because Twilio signs webhook requests
 * using HMAC-SHA1; signature validation happens in the webhook Lambda.
 *
 * Phase 3: Lambdas are stubs. Phases 4-6 replace them with real implementations.
 */
export class WhatsAppStack extends cdk.Stack {
  public readonly inboundQueue: sqs.Queue;
  public readonly inboundDlq: sqs.Queue;
  public readonly inboundV2Queue: sqs.Queue;
  public readonly inboundV2Dlq: sqs.Queue;
  public readonly webhookLambda: JaleLambdaFunction;
  public readonly processorLambda: JaleLambdaFunction;
  public readonly jobAlertLambda: JaleLambdaFunction;
  public readonly adminOutboxDispatcherLambda: JaleLambdaFunction;

  constructor(scope: Construct, id: string, props: WhatsAppStackProps) {
    super(scope, id, props);

    // ── Context values ──────────────────────────────────────────
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const allowedOrigin =
      this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const statusCallbackUrl = normalizeWhatsappStatusCallbackUrl(props.statusCallbackUrl);

    // ── Secrets Manager references ──────────────────────────────
    // NOTE: fromSecretNameV2 is an imported reference — CDK synth/deploy
    // succeeds even if the secret doesn't exist yet. Runtime is when the
    // Lambda calls GetSecretValue. Real credentials must be in both secrets
    // BEFORE the first webhook arrives (db.ts caches secrets for 5 min).
    const whatsappDbSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'WhatsAppDbSecret',
      'jale/whatsapp/db',
    );
    const twilioSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'TwilioSecret',
      'jale/whatsapp/twilio',
    );

    // ── SQS DLQ + inbound queue ─────────────────────────────────
    // DLQ: receives messages that fail max receive count from the main queue.
    // KMS_MANAGED encryption matches the AuthStack post-confirmation DLQ pattern.
    this.inboundDlq = new sqs.Queue(this, 'WhatsAppInboundDlq', {
      queueName: 'whatsapp-inbound-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Main queue — visibility timeout 360s (6x the processor Lambda timeout of 60s,
    // per AWS recommendation). Matches worst-case processor call chain:
    // SecretsMgr → DB → AdminCreateUser → AdminSetUserPassword →
    // defensive INSERT → InitiateAuth → Twilio SMS → DB update.
    this.inboundQueue = new sqs.Queue(this, 'WhatsAppInboundQueue', {
      queueName: 'whatsapp-inbound-queue',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: this.inboundDlq,
        maxReceiveCount: 3,
      },
    });

    // ── v2 SQS FIFO DLQ + inbound queue (additive) ────────────────
    // Inbound v2 events serialize per-phone-hash through a FIFO queue so a
    // single worker's messages process strictly in order. The legacy
    // standard queue/DLQ above are untouched; this is a parallel path
    // selected in the webhook only when WHATSAPP_INBOUND_V2_QUEUE_URL is set.
    this.inboundV2Dlq = new sqs.Queue(this, 'WhatsAppInboundV2Dlq', {
      queueName: 'whatsapp-inbound-v2-dlq.fifo',
      fifo: true,
      contentBasedDeduplication: false,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.inboundV2Queue = new sqs.Queue(this, 'WhatsAppInboundV2Queue', {
      queueName: 'whatsapp-inbound-v2.fifo',
      fifo: true,
      contentBasedDeduplication: false,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: this.inboundV2Dlq,
        maxReceiveCount: 5,
      },
    });

    // ── Webhook Lambda ──────────────────────────────────────────
    // Public-facing: validates Twilio X-Twilio-Signature and pushes the raw
    // body to SQS. No DB, no Twilio API calls.
    //
    // NO WEBHOOK_URL env var — we DELIBERATELY reconstruct the URL at runtime
    // from event.requestContext.{domainName,stage,path}. Two reasons:
    //   1. Using `props.api.url` here would create a cross-stack reference
    //      ApiStack ↔ WhatsAppStack (WhatsApp Lambda env → API Gateway Ref,
    //      while API Gateway Method → WhatsApp Lambda ARN). Dependency cycle.
    //   2. Runtime reconstruction automatically matches what Twilio actually
    //      POSTed to, eliminating trailing-slash normalization bugs that
    //      break HMAC-SHA1 signature validation. If Twilio is configured
    //      with a custom domain later, we read X-Forwarded-Host instead.
    this.webhookLambda = new JaleLambdaFunction(this, 'WhatsAppWebhookLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/webhook.ts'),
      description: 'Twilio WhatsApp webhook receiver — signature validation + SQS push',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        SQS_QUEUE_URL: this.inboundQueue.queueUrl,
        WHATSAPP_INBOUND_V2_QUEUE_URL: this.inboundV2Queue.queueUrl,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    twilioSecret.grantRead(this.webhookLambda.function);
    this.inboundQueue.grantSendMessages(this.webhookLambda.function);
    this.inboundV2Queue.grantSendMessages(this.webhookLambda.function);

    // ── Processor Lambda ────────────────────────────────────────
    // SQS consumer — owns the conversation state machine + profile builder
    // + Cognito custom-auth OTP flow. Connects to RDS as `jale_whatsapp` role.
    //
    // DB_SECRET_ARN is aliased to the WhatsApp DB secret so the shared
    // lambda/lib/db.ts getDbPool() reads jale_whatsapp creds, not jale_admin.
    //
    // Timeout = 60s to cover the worst-case new-user onboarding chain.
    this.processorLambda = new JaleLambdaFunction(this, 'WhatsAppProcessorLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/processor.ts'),
      description: 'WhatsApp SQS processor — state machine + OTP + profile builder',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 60,
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName, // alias: getDbPool() reads this
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        TWILIO_REQUEST_TIMEOUT_MS: '4000',
        WORKER_POOL_ID: props.workerPool.userPoolId,
        WORKER_CLIENT_ID: props.workerPool.clientId,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    });
    whatsappDbSecret.grantRead(this.processorLambda.function);
    twilioSecret.grantRead(this.processorLambda.function);

    // SQS event source — batch size 1 so one failed message doesn't block
    // others. Visibility timeout above ensures no false double-processing.
    this.processorLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(this.inboundQueue, {
        batchSize: 1,
      }),
    );

    // v2 FIFO event source — ReportBatchItemFailures lets a single failed
    // message be retried/redriven without stalling or discarding the rest of
    // the per-phone-hash message group ordering.
    this.processorLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(this.inboundV2Queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // Cognito permissions for suppressed admin creation and CUSTOM_AUTH.
    // Scoped to all pools in the account/region to
    // avoid the circular dependency pattern documented in auth-stack.ts:125-136.
    this.processorLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:InitiateAuth',
          'cognito-idp:RespondToAuthChallenge',
          'cognito-idp:AdminGetUser',
          // C4: the processor calls reconcileWorkerCognitoAccount() (processor.ts),
          // which also needs to repair attributes, re-enable, and (re)add to the
          // Workers group. Without these three the existing-account heal path
          // throws AccessDenied at runtime.
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminAddUserToGroup',
        ],
        resources: [
          `arn:aws:cognito-idp:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:userpool/*`,
        ],
      }),
    );

    // ── Job Alert Sender Lambda ─────────────────────────────────
    // Direct invocation (or future EventBridge) — queries the jobs table,
    // finds matched workers with linked WhatsApp, and sends Twilio template
    // messages.
    this.jobAlertLambda = new JaleLambdaFunction(this, 'WhatsAppJobAlertLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/job-alert.ts'),
      description: 'WhatsApp job alert sender — template messages for matched workers',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        TWILIO_REQUEST_TIMEOUT_MS: '4000',
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    });
    whatsappDbSecret.grantRead(this.jobAlertLambda.function);
    twilioSecret.grantRead(this.jobAlertLambda.function);

    // ── Job Alert Outbox Drain ───────────────────────────────────
    // Crash-safe scheduled sender for job_alert outbox rows queued by
    // WhatsAppJobAlertLambda above (which only queues — see job-alert.ts
    // and drainJobAlertOutbox() for the crash-safety design). EventBridge
    // every 5 minutes, mirroring JobMessageOutboxSweeperLambda's cadence.
    const jobAlertDrainLambda = new JaleLambdaFunction(this, 'JobAlertOutboxDrainLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/job-alert-drain.ts'),
      description: 'Job alert outbox drain — crash-safe scheduled Twilio sends',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        TWILIO_REQUEST_TIMEOUT_MS: '4000',
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    });
    whatsappDbSecret.grantRead(jobAlertDrainLambda.function);
    twilioSecret.grantRead(jobAlertDrainLambda.function);

    new events.Rule(this, 'JobAlertOutboxDrainSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(jobAlertDrainLambda.function)],
    });

    // ── Job Message Outbox Sweeper ──────────────────────────────
    // EventBridge every 5 min: retries stale/failed-under-cap job_message_outbox
    // rows (R8 retry driver for employer-initiated sends). Connects as
    // jale_whatsapp; sends via Twilio, so needs both secrets.
    const outboxSweeperLambda = new JaleLambdaFunction(this, 'JobMessageOutboxSweeperLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/job-message-outbox-sweeper.ts'),
      description: 'Job message outbox sweeper — retries stale employer-message sends',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    });
    whatsappDbSecret.grantRead(outboxSweeperLambda.function);
    twilioSecret.grantRead(outboxSweeperLambda.function);

    new events.Rule(this, 'JobMessageOutboxSweepRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(outboxSweeperLambda.function)],
    });

    this.adminOutboxDispatcherLambda = new JaleLambdaFunction(this, 'AdminOutboxDispatcherLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/admin-outbox-dispatcher.ts'),
      description: 'WhatsApp admin outbox dispatcher',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        TWILIO_REQUEST_TIMEOUT_MS: '4000',
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    });
    whatsappDbSecret.grantRead(this.adminOutboxDispatcherLambda.function);
    twilioSecret.grantRead(this.adminOutboxDispatcherLambda.function);

    new events.Rule(this, 'AdminOutboxDispatchSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventTargets.LambdaFunction(this.adminOutboxDispatcherLambda.function)],
    });

    // ── Media S3 Bucket ──────────────────────────────────────────
    const mediaBucket = new s3.Bucket(this, 'WorkerMediaBucket', {
      bucketName: `jale-worker-media-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── ai-profile-writer Lambda ─────────────────────────────────
    const aiProfileWriterLambda = new JaleLambdaFunction(this, 'AiProfileWriterLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/ai-profile-writer.ts'),
      description: 'ai-profile-writer: Bedrock extraction + DB writes after Transcribe',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 60,
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        TWILIO_REQUEST_TIMEOUT_MS: '4000',
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        BEDROCK_MODEL_ID: 'us.amazon.nova-lite-v1:0',
        AI_EXTRACTION_CONFIDENCE_THRESHOLD: '0.75',
        AI_INDUSTRY_KEYWORDS: '[]',
        QUESTION_GENERATOR_ARN: props.questionGeneratorFn.functionArn,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
      nodeModules: ['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-lambda'],
    });
    whatsappDbSecret.grantRead(aiProfileWriterLambda.function);
    twilioSecret.grantRead(aiProfileWriterLambda.function);
    mediaBucket.grantRead(aiProfileWriterLambda.function);
    props.questionGeneratorFn.grantInvoke(aiProfileWriterLambda.function);

    aiProfileWriterLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/us.amazon.nova-lite-v1:0`,
          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
          `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/amazon.nova-lite-v1:0`,
          'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0',
        ],
      }),
    );

    // ── Step Functions: AI Pipeline ─────────────────────────────
    const voiceTrustReceiverLambda = new JaleLambdaFunction(this, 'VoiceTrustReceiverLambda', {
      entry: path.join(__dirname, '../../lambda/ai/voice-trust-receiver.ts'),
      description: 'voice-trust-receiver: writes transcript to state_context, advances trust step',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 30,
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        TRUST_ASSESSMENT_QUEUE_URL: props.trustAssessmentQueue.queueUrl,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    });
    whatsappDbSecret.grantRead(voiceTrustReceiverLambda.function);
    twilioSecret.grantRead(voiceTrustReceiverLambda.function);
    mediaBucket.grantRead(voiceTrustReceiverLambda.function);
    props.trustAssessmentQueue.grantSendMessages(voiceTrustReceiverLambda.function);

    const profileVoicePipeline = new VoiceTranscriptionPipeline(this, 'ProfileVoicePipeline', {
      vpc: props.vpc,
      lambdaSg: props.lambdaSg,
      mediaBucket,
      completionHandler: aiProfileWriterLambda.function,
    });

    const trustVoicePipeline = new VoiceTranscriptionPipeline(this, 'TrustVoicePipeline', {
      vpc: props.vpc,
      lambdaSg: props.lambdaSg,
      mediaBucket,
      completionHandler: voiceTrustReceiverLambda.function,
    });

    // ── Processor Lambda: add media env vars and grants ──────────
    this.processorLambda.function.addEnvironment('MEDIA_BUCKET_NAME', mediaBucket.bucketName);
    this.processorLambda.function.addEnvironment(
      'AI_PIPELINE_STATE_MACHINE_ARN',
      profileVoicePipeline.stateMachine.stateMachineArn,
    );
    this.processorLambda.function.addEnvironment(
      'TRUST_PIPELINE_STATE_MACHINE_ARN',
      trustVoicePipeline.stateMachine.stateMachineArn,
    );
    this.processorLambda.function.addEnvironment(
      'QUESTION_GENERATOR_ARN',
      props.questionGeneratorFn.functionArn,
    );
    this.processorLambda.function.addEnvironment(
      'TRUST_ASSESSMENT_QUEUE_URL',
      props.trustAssessmentQueue.queueUrl,
    );
    mediaBucket.grantPut(this.processorLambda.function);
    profileVoicePipeline.stateMachine.grantStartExecution(this.processorLambda.function);
    trustVoicePipeline.stateMachine.grantStartExecution(this.processorLambda.function);
    props.trustAssessmentQueue.grantSendMessages(this.processorLambda.function);
    props.questionGeneratorFn.grantInvoke(this.processorLambda.function);

    // Public Twilio delivery-status receiver. Authentication is the Twilio
    // HMAC signature; it needs DB + Twilio secrets but no Cognito authorizer.
    const statusCallbackLambda = new JaleLambdaFunction(this, 'WhatsAppStatusCallbackLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/status-callback.ts'),
      description: 'Twilio WhatsApp delivery status callback — signature validation + durable status',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TWILIO_SECRET_ARN: twilioSecret.secretName,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
    });
    whatsappDbSecret.grantRead(statusCallbackLambda.function);
    twilioSecret.grantRead(statusCallbackLambda.function);

    // ── Alarm notifications ──
    // WhatsApp-specific naming (not billingAlarmTopicArn — a distinct SNS
    // topic per domain keeps ownership and paging routing clear). An alarm
    // with no reachable subscriber is not actionable, so this stack requires
    // either an existing monitored topic ARN (whatsappAlarmTopicArn context /
    // props.alarmTopicArn) or an email to subscribe on a CDK-created topic
    // (whatsappAlarmEmail context). Fail closed rather than silently wiring
    // alarms to an empty topic.
    const whatsappAlarmEmail = this.node.tryGetContext('whatsappAlarmEmail');
    if (!props.alarmTopicArn && !whatsappAlarmEmail) {
      throw new Error(
        'WhatsAppStack requires an actionable alarm target: pass alarmTopicArn '
        + '(-c whatsappAlarmTopicArn=<existing SNS topic ARN>) or -c whatsappAlarmEmail=<address> '
        + 'to subscribe a new topic.',
      );
    }
    const alarmTopic = props.alarmTopicArn
      ? sns.Topic.fromTopicArn(this, 'WhatsAppAlarmTopic', props.alarmTopicArn)
      : new sns.Topic(this, 'WhatsAppAlarmTopic', { topicName: 'jale-whatsapp-alarms' });
    if (!props.alarmTopicArn && whatsappAlarmEmail) {
      (alarmTopic as sns.Topic).addSubscription(
        new snsSubscriptions.EmailSubscription(whatsappAlarmEmail),
      );
    }
    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    const metricFilter = (id: string, metricValueEquals: string, metricName: string) =>
      new logs.MetricFilter(this, id, {
        logGroup: statusCallbackLambda.logGroup,
        filterPattern: logs.FilterPattern.stringValue('$.metric', '=', metricValueEquals),
        metricNamespace: 'Jale/WhatsApp',
        metricName,
        metricValue: '1',
      });

    const alarm = (id: string, alarmName: string, metric: cloudwatch.IMetric) =>
      new cloudwatch.Alarm(this, id, {
        alarmName,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    // Twilio-reported terminal delivery failures (failed/undelivered).
    const deliveryFailureMetric = metricFilter(
      'WhatsAppDeliveryFailureMetric', 'WhatsAppDeliveryFailure', 'DeliveryFailures',
    );
    alarm(
      'WhatsAppDeliveryFailuresAlarm', 'WhatsAppDeliveryFailures',
      deliveryFailureMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // Callback processing/config/database failures (signature validation
    // errors, DB connection failures, secret/config errors) — these are the
    // callback pipeline breaking, not a Twilio-side delivery outcome, and
    // were previously invisible to alarms.
    const callbackErrorMetric = metricFilter(
      'WhatsAppStatusCallbackErrorMetric', 'WhatsAppStatusCallbackError', 'CallbackErrors',
    );
    alarm(
      'WhatsAppStatusCallbackErrorsAlarm', 'WhatsAppStatusCallbackErrors',
      callbackErrorMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // Callbacks for a Twilio SID we have no durable-outbox or job-message row
    // for — could indicate a correlation bug or a race between send-commit
    // and callback delivery worth paging on if sustained.
    const unknownSidMetric = metricFilter(
      'WhatsAppStatusCallbackUnknownSidMetric', 'WhatsAppStatusCallbackUnknownSid', 'UnknownSids',
    );
    alarm(
      'WhatsAppStatusCallbackUnknownSidAlarm', 'WhatsAppStatusCallbackUnknownSids',
      unknownSidMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // v2 inbound DLQ health — depth (messages stuck after exhausting
    // maxReceiveCount) and age (oldest stuck message) on the v2 DLQ.
    alarm(
      'WhatsAppInboundV2DlqDepthAlarm', 'WhatsAppInboundV2DlqDepth',
      this.inboundV2Dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
    ).addAlarmAction(alarmAction);

    alarm(
      'WhatsAppInboundV2DlqAgeAlarm', 'WhatsAppInboundV2DlqAge',
      this.inboundV2Dlq.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
    ).addAlarmAction(alarmAction);

    // ── API Gateway route: POST /whatsapp/webhook ───────────────
    // INTENTIONALLY UNAUTHENTICATED. Twilio signs webhook requests with
    // X-Twilio-Signature (HMAC-SHA1 over the full URL + sorted body params).
    // Signature validation happens in the webhook Lambda; API Gateway just
    // forwards all POSTs to the Lambda. Matches the /health pattern.
    const whatsappResource = props.api.root.addResource('whatsapp');
    const webhookResource = whatsappResource.addResource('webhook');
    webhookResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(this.webhookLambda.function),
      {
        methodResponses: [{ statusCode: '200' }, { statusCode: '403' }],
      },
    );
    const statusCallbackResource = whatsappResource.addResource('status-callback');
    statusCallbackResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(statusCallbackLambda.function),
      {
        authorizationType: apigateway.AuthorizationType.NONE,
        methodResponses: [
          { statusCode: '200' }, { statusCode: '400' },
          { statusCode: '403' }, { statusCode: '503' },
        ],
      },
    );
  }
}
