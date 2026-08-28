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
  /**
   * ApiStack's `/worker` resource, already `public readonly` there for exactly
   * this reason (ReferralsStack hangs `/worker/jobs/{jobId}/share` off it the
   * same way). S22 R2-C23 adds `/worker/onboarding*` here rather than in
   * ApiStack because the web door needs THIS stack's `jale/whatsapp/db`
   * secret, question/alias generator ARNs and domain-outbox wake queue —
   * moving it the other way would make ApiStack depend on WhatsAppStack,
   * which already depends on ApiStack.
   */
  readonly workerResource: apigateway.Resource;
  /** ApiStack's worker Cognito authorizer — the same one every other
   * `/worker/*` route uses. */
  readonly workerAuthorizer: apigateway.IAuthorizer;
  readonly workerRerankQueue?: sqs.IQueue;
  readonly questionGeneratorFn: lambda.IFunction;
  readonly aliasGeneratorFn: lambda.IFunction;
  readonly trustAssessmentQueue: sqs.IQueue;
  /** R1-X: AiStack's trust-EXTRACTION queue. Required, not optional: the
   *  drain's fan-out to it is fail-open at runtime, so an unwired queue would
   *  otherwise hide behind a metric instead of failing synth. */
  readonly trustExtractionQueue: sqs.IQueue;
  /**
   * Shared worker documents bucket (from DocumentsStack). The processor
   * lambda is granted PUT-only access (+ the KMS actions grantPut adds for
   * the bucket's encryption key) so the WhatsApp flow can upload worker
   * documents — no read/list/delete.
   */
  readonly documentsBucket: s3.IBucket;
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
  /** Shared worker media bucket — MediaBoardStack consumes this (Task 7). */
  public readonly mediaBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: WhatsAppStackProps) {
    super(scope, id, props);

    // ── Context values ──────────────────────────────────────────
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const allowedOrigin =
      this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const inboundV2TransportContext =
      this.node.tryGetContext('whatsappInboundV2TransportEnabled');
    const inboundV2TransportEnabled =
      inboundV2TransportContext === true || inboundV2TransportContext === 'true';
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

    const workerIntentWakeDlq = new sqs.Queue(this, 'WorkerIntentWakeDlq', {
      queueName: 'whatsapp-worker-intent-wake-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    const workerIntentWakeQueue = new sqs.Queue(this, 'WorkerIntentWakeQueue', {
      queueName: 'whatsapp-worker-intent-wake',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: workerIntentWakeDlq, maxReceiveCount: 5 },
    });

    const domainOutboxWakeDlq = new sqs.Queue(this, 'DomainOutboxWakeDlq', {
      queueName: 'whatsapp-domain-outbox-wake-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    const domainOutboxWakeQueue = new sqs.Queue(this, 'DomainOutboxWakeQueue', {
      queueName: 'whatsapp-domain-outbox-wake',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: { queue: domainOutboxWakeDlq, maxReceiveCount: 5 },
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
        ...(inboundV2TransportEnabled
          ? { WHATSAPP_INBOUND_V2_QUEUE_URL: this.inboundV2Queue.queueUrl }
          : {}),
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    twilioSecret.grantRead(this.webhookLambda.function);
    this.inboundQueue.grantSendMessages(this.webhookLambda.function);
    if (inboundV2TransportEnabled) {
      this.inboundV2Queue.grantSendMessages(this.webhookLambda.function);
    }

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
        WORKER_INTENT_WAKE_QUEUE_URL: workerIntentWakeQueue.queueUrl,
        DOMAIN_OUTBOX_WAKE_QUEUE_URL: domainOutboxWakeQueue.queueUrl,
        // Task 15 (controller-discovered gap): the processor calls Bedrock
        // ConverseCommand for application-fill field extraction
        // (lib/application-fill-extraction.ts's makeBedrockExtractionClient)
        // but had no BEDROCK_MODEL_ID env at all — every extraction turn hit
        // that module's `?? 'us.amazon.nova-lite-v1:0'` fallback. Same
        // model ID as the ai-profile-writer Lambda below (BEDROCK_MODEL_ID
        // env + bedrock:InvokeModel policy, ~line 489/522).
        BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
      // Task 15 (confirmed blocker, not just the IAM/env gap): processor.ts
      // imports handleFillMessage from lib/application-fill.ts, which
      // imports extractFieldAnswer from lib/application-fill-extraction.ts,
      // which imports '@aws-sdk/client-bedrock-runtime' at module top level.
      // JaleLambdaFunction's default bundling externalizes ALL '@aws-sdk/*'
      // packages (lambda-function.ts:74) on the assumption the Node 20.x
      // Lambda runtime provides them — untrue for client-bedrock-runtime
      // (see ai-profile-writer's identical nodeModules override above,
      // ~line 504). Without this opt-in, the processor bundle would contain
      // an unresolvable require() for this package, throwing "Cannot find
      // module" at import time — failing EVERY processor invocation, not
      // just Bedrock-calling turns, since the import chain above is
      // unconditional at the top of processor.ts.
      // (@smithy/node-http-handler, also used by makeBedrockExtractionClient,
      // does NOT need listing here — only 'pg-native' and '@aws-sdk/*' are
      // externalModules, so esbuild bundles @smithy/* directly.)
      //
      // C1 (final-review, critical): the media-board post lane (below, ~line
      // 656) makes this lambda call lib/moderation.ts's moderateImage(),
      // which imports '@aws-sdk/client-rekognition' at module top level --
      // the exact same "externalized but not runtime-provided" failure this
      // comment already documents for client-bedrock-runtime. Without this
      // addition the bundle would contain an unresolvable require() for
      // client-rekognition, failing EVERY processor invocation (the import
      // chain is unconditional at the top of processor.ts), not just
      // moderation-calling turns.
      nodeModules: ['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-rekognition'],
    });
    whatsappDbSecret.grantRead(this.processorLambda.function);
    twilioSecret.grantRead(this.processorLambda.function);

    workerIntentWakeQueue.grantSendMessages(this.processorLambda.function);
    domainOutboxWakeQueue.grantSendMessages(this.processorLambda.function);
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

    const workerIntentDrainLambda = new JaleLambdaFunction(
      this,
      'WorkerIntentOutboxDrainLambda',
      {
        entry: path.join(__dirname, '../../lambda/whatsapp/worker-intent-outbox-drain.ts'),
        description: 'Worker intent outbox drain — event-driven ordered Twilio sends with scheduled recovery',
        vpc: props.vpc,
        securityGroups: [props.lambdaSg],
        timeout: 60,
        environment: {
          DB_SECRET_ARN: whatsappDbSecret.secretName,
          TWILIO_SECRET_ARN: twilioSecret.secretName,
          TWILIO_REQUEST_TIMEOUT_MS: '4000',
          TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
        },
      },
    );
    whatsappDbSecret.grantRead(workerIntentDrainLambda.function);
    twilioSecret.grantRead(workerIntentDrainLambda.function);

    workerIntentDrainLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(workerIntentWakeQueue, {
        batchSize: 1,
      }),
    );
    new events.Rule(this, 'WorkerIntentOutboxDrainSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventTargets.LambdaFunction(workerIntentDrainLambda.function)],
    });

    // ── C7: Domain Outbox Drain ──────────────────────────────────
    // Event-driven from the domain wake queue, with a 1-minute recovery
    // schedule: leases worker_domain_outbox events (migration 042's
    // lease_worker_domain_events) written by the workflow
    // lane's completeOnboarding(), and dispatches worker.ready to C6's
    // releaseWorkerReady() and assessment.requested to the existing
    // AiStack TrustScorer SQS queue (no Bedrock call — jale_ai owns
    // scoring). This drain never sends via Twilio, so it gets only the
    // WhatsApp DB secret (no Twilio secret, no Twilio IAM permission) plus
    // least-privilege sqs:SendMessage on the trust-assessment queue.
    const domainOutboxDrainLambda = new JaleLambdaFunction(this, 'DomainOutboxDrainLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/domain-outbox-drain.ts'),
      description: 'Domain outbox drain — event-driven worker.ready / assessment.requested processing with scheduled recovery',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        TRUST_ASSESSMENT_QUEUE_URL: props.trustAssessmentQueue.queueUrl,
        TRUST_EXTRACTION_QUEUE_URL: props.trustExtractionQueue.queueUrl,
        WORKER_INTENT_WAKE_QUEUE_URL: workerIntentWakeQueue.queueUrl,
      },
    });
    whatsappDbSecret.grantRead(domainOutboxDrainLambda.function);
    // Least-privilege: this drain only sends assessment.requested payloads
    // onward to TrustScorer — it never consumes from the trust queue itself, so
    // it gets sqs:SendMessage only (no ReceiveMessage/DeleteMessage), and no
    // Twilio secret access.
    props.trustAssessmentQueue.grantSendMessages(domainOutboxDrainLambda.function);
    // R1-X: same least-privilege posture for the extraction lane — send only.
    props.trustExtractionQueue.grantSendMessages(domainOutboxDrainLambda.function);
    workerIntentWakeQueue.grantSendMessages(domainOutboxDrainLambda.function);
    domainOutboxDrainLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(domainOutboxWakeQueue, {
        batchSize: 1,
      }),
    );

    new events.Rule(this, 'DomainOutboxDrainSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventTargets.LambdaFunction(domainOutboxDrainLambda.function)],
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

    // ── Deferred-intent retrigger sweep ─────────────────────────
    // EventBridge every 5 min: calls the migration-072 SECURITY DEFINER to
    // re-emit worker.ready for ready workers still holding deferred business
    // intents (e.g. web-bypass workers who never got a worker.ready event).
    // The 1-minute DomainOutboxDrainLambda consumes the events. Never sends
    // via Twilio, so it gets only the WhatsApp DB secret.
    const retriggerSweepLambda = new JaleLambdaFunction(this, 'RetriggerSweepLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/retrigger-sweep-drain.ts'),
      description: 'Deferred-intent retrigger sweep — re-emits worker.ready for stranded ready workers',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: whatsappDbSecret.secretName,
      },
    });
    whatsappDbSecret.grantRead(retriggerSweepLambda.function);

    new events.Rule(this, 'RetriggerSweepSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(retriggerSweepLambda.function)],
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
      // Versioned so worker_post_media.s3_version_id can pin moderated
      // bytes — presigned PUTs are multi-use for their TTL, so an
      // unversioned key could be swapped AFTER Rekognition approval.
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [allowedOrigin],
          allowedHeaders: ['*'],
        },
      ],
      lifecycleRules: [
        { noncurrentVersionExpiration: cdk.Duration.days(30) },
      ],
    });
    this.mediaBucket = mediaBucket;

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
        BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        AI_EXTRACTION_CONFIDENCE_THRESHOLD: '0.75',
        AI_INDUSTRY_KEYWORDS: '[]',
        // Sprint 22 R1: QUESTION_GENERATOR_ARN removed — the v1 trust hand-off
        // (autoAdvanceProfileAfterAi) that invoked it was deleted.
        ALIAS_GENERATOR_ARN: props.aliasGeneratorFn.functionArn,
        TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
      },
      nodeModules: ['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-lambda'],
    });
    whatsappDbSecret.grantRead(aiProfileWriterLambda.function);
    twilioSecret.grantRead(aiProfileWriterLambda.function);
    mediaBucket.grantRead(aiProfileWriterLambda.function);
    props.aliasGeneratorFn.grantInvoke(aiProfileWriterLambda.function);
    // Stream B (Task 8d): a voice note ingested from the v2 lane's
    // profile.voice_choice step completes through this SAME lambda; its v2
    // branch re-enters the v2 onboarding lane by sending a synthetic `#vp`
    // event back onto the v2 inbound FIFO queue — gated on the identical
    // transport flag as voice-trust-receiver's wiring below, so this lambda
    // never gets a queue URL/grant in an environment where the v2 lane
    // itself isn't wired up.
    if (inboundV2TransportEnabled) {
      aiProfileWriterLambda.function.addEnvironment(
        'WHATSAPP_INBOUND_V2_QUEUE_URL',
        this.inboundV2Queue.queueUrl,
      );
      this.inboundV2Queue.grantSendMessages(aiProfileWriterLambda.function);
    }

    // Shared with the processor Lambda's identical bedrock:InvokeModel grant
    // below (Task 15) — one ARN list, both grants stay in sync by
    // construction instead of by comment. ConverseCommand (used by both
    // Lambdas) only needs bedrock:InvokeModel, not a separate
    // bedrock:Converse action.
    const bedrockHaiku45Arns = [
      `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
      'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
    ];
    aiProfileWriterLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockHaiku45Arns,
      }),
    );

    // ── Step Functions: AI Pipeline ─────────────────────────────
    const voiceTrustReceiverLambda = new JaleLambdaFunction(this, 'VoiceTrustReceiverLambda', {
      entry: path.join(__dirname, '../../lambda/ai/voice-trust-receiver.ts'),
      description: 'voice-trust-receiver: re-enters the v2 lane with the trust transcript',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 30,
      // Sprint 22 R1: the legacy v1 branch (DB writes, Twilio outbox, direct
      // trust-queue send) was deleted; the receiver now only reads the
      // transcript from S3 and re-enqueues onto the v2 inbound queue below,
      // so it holds no DB/Twilio secrets and no assessment-queue grant.
      environment: {},
    });
    mediaBucket.grantRead(voiceTrustReceiverLambda.function);
    // v2 re-entry (Task 5): a trust voice note started from the v2 lane
    // completes by sending a synthetic event back onto the same v2 inbound
    // FIFO queue the webhook uses — gated on the identical transport flag so
    // this receiver never gets a queue URL/grant in an environment where the
    // v2 lane itself isn't wired up.
    if (inboundV2TransportEnabled) {
      voiceTrustReceiverLambda.function.addEnvironment(
        'WHATSAPP_INBOUND_V2_QUEUE_URL',
        this.inboundV2Queue.queueUrl,
      );
      this.inboundV2Queue.grantSendMessages(voiceTrustReceiverLambda.function);
    }

    const profileVoicePipeline = new VoiceTranscriptionPipeline(this, 'ProfileVoicePipeline', {
      vpc: props.vpc,
      lambdaSg: props.lambdaSg,
      mediaBucket,
      completionHandler: aiProfileWriterLambda.function,
      esVocabularyName: 'jale-es-us-trades',
    });

    const trustVoicePipeline = new VoiceTranscriptionPipeline(this, 'TrustVoicePipeline', {
      vpc: props.vpc,
      lambdaSg: props.lambdaSg,
      mediaBucket,
      completionHandler: voiceTrustReceiverLambda.function,
      esVocabularyName: 'jale-es-us-trades',
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
      'ALIAS_GENERATOR_ARN',
      props.aliasGeneratorFn.functionArn,
    );
    this.processorLambda.function.addEnvironment(
      'TRUST_ASSESSMENT_QUEUE_URL',
      props.trustAssessmentQueue.queueUrl,
    );
    mediaBucket.grantPut(this.processorLambda.function);
    // Task 15 (media-board post lane): the processor moderates each worker
    // post photo via Rekognition DetectModerationLabels, which reads the
    // object directly from S3 under Rekognition's own service role — the
    // CALLER (this Lambda) still needs s3:GetObject(Version) on the bucket
    // for that read to succeed, hence grantRead alongside the existing
    // grantPut. Every moderation call pins s3_version_id (global constraint),
    // so GetObjectVersion is exercised, not just GetObject.
    mediaBucket.grantRead(this.processorLambda.function);
    this.processorLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rekognition:DetectModerationLabels'],
      resources: ['*'], // Rekognition API actions do not support resource-level ARNs.
    }));
    profileVoicePipeline.stateMachine.grantStartExecution(this.processorLambda.function);
    trustVoicePipeline.stateMachine.grantStartExecution(this.processorLambda.function);
    props.trustAssessmentQueue.grantSendMessages(this.processorLambda.function);
    props.questionGeneratorFn.grantInvoke(this.processorLambda.function);
    props.aliasGeneratorFn.grantInvoke(this.processorLambda.function);

    // ── Processor Lambda: worker documents bucket (KMS put access) ──
    // The WhatsApp application-fill flow uploads worker documents (ID,
    // certs, etc.) directly to the shared documents bucket. Put-only —
    // no read/list/delete grant here. grantPut also adds the KMS actions
    // (kms:GenerateDataKey* etc.) needed to write to the KMS-encrypted
    // bucket.
    this.processorLambda.function.addEnvironment(
      'DOCUMENTS_BUCKET',
      props.documentsBucket.bucketName,
    );
    props.documentsBucket.grantPut(this.processorLambda.function);

    // Task 15 (controller-discovered gap): bedrock:InvokeModel grant for the
    // processor's ConverseCommand calls (application-fill extraction).
    // Reuses the same bedrockHaiku45Arns list as the ai-profile-writer
    // Lambda's identical grant above (~line 526) — one ARN list, both
    // grants stay in sync by construction. ConverseCommand only needs
    // bedrock:InvokeModel, not a separate bedrock:Converse action.
    this.processorLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockHaiku45Arns,
      }),
    );

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

    // LITERAL term patterns, NOT `logs.FilterPattern.stringValue('$.metric',
    // ...)`. A JSON selector pattern (`{ $.metric = "X" }`) is only evaluated
    // against log events that are themselves a valid JSON object, and the Node
    // 20 runtime's default TEXT log format prefixes every console line with
    // `timestamp<TAB>requestId<TAB>LEVEL<TAB>` -- so the selector matched
    // NOTHING and every alarm keyed off these filters was silently disarmed. A
    // quoted term matches the substring inside the JSON.stringify payload under
    // both the text and JSON log formats. notifications-stack.ts:260 is where
    // this was first diagnosed; test/unit/stacks/metric-filter-patterns.test.ts
    // now guards the whole repo against the selector idiom.
    const metricFilter = (id: string, metricValueEquals: string, metricName: string) =>
      new logs.MetricFilter(this, id, {
        logGroup: statusCallbackLambda.logGroup,
        filterPattern: logs.FilterPattern.literal(`"${metricValueEquals}"`),
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

    const workerIntentMetricFilter = (
      id: string,
      metricValueEquals: string,
      metricName: string,
    ) => new logs.MetricFilter(this, id, {
      logGroup: workerIntentDrainLambda.logGroup,
      filterPattern: logs.FilterPattern.literal(`"${metricValueEquals}"`),
      metricNamespace: 'Jale/WhatsApp',
      metricName,
      metricValue: '1',
    });
    for (const [filterId, eventName, metricName, alarmId, alarmName] of [
      ['WorkerIntentSendUnknownMetric', 'WorkerIntentOutboxSendUnknown', 'WorkerIntentSendUnknown',
        'WorkerIntentSendUnknownAlarm', 'WhatsAppWorkerIntentSendUnknown'],
      ['WorkerIntentFailureMetric', 'WorkerIntentOutboxFailure', 'WorkerIntentFailures',
        'WorkerIntentFailureAlarm', 'WhatsAppWorkerIntentFailures'],
      ['WorkerIntentLeaseLostMetric', 'WorkerIntentOutboxLeaseLost', 'WorkerIntentLeaseLost',
        'WorkerIntentLeaseLostAlarm', 'WhatsAppWorkerIntentLeaseLost'],
      ['WorkerIntentBacklogAgedMetric', 'WorkerIntentOutboxBacklogAged', 'WorkerIntentBacklogAged',
        'WorkerIntentBacklogAgedAlarm', 'WhatsAppWorkerIntentBacklogAged'],
    ] as const) {
      const metric = workerIntentMetricFilter(filterId, eventName, metricName);
      alarm(
        alarmId,
        alarmName,
        metric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      ).addAlarmAction(alarmAction);
    }

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

    for (const [id, alarmName, queue] of [
      ['WorkerIntentWakeDlqDepthAlarm', 'WhatsAppWorkerIntentWakeDlqDepth', workerIntentWakeDlq],
      ['DomainOutboxWakeDlqDepthAlarm', 'WhatsAppDomainOutboxWakeDlqDepth', domainOutboxWakeDlq],
    ] as const) {
      alarm(
        id,
        alarmName,
        queue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(1),
          statistic: 'Maximum',
        }),
      ).addAlarmAction(alarmAction);
    }

    for (const [id, alarmName, queue] of [
      ['WorkerIntentWakeAgeAlarm', 'WhatsAppWorkerIntentWakeAge', workerIntentWakeQueue],
      ['DomainOutboxWakeAgeAlarm', 'WhatsAppDomainOutboxWakeAge', domainOutboxWakeQueue],
    ] as const) {
      new cloudwatch.Alarm(this, id, {
        alarmName,
        metric: queue.metricApproximateAgeOfOldestMessage({
          period: cdk.Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 15,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);
    }

    const processorWakeFailureMetric = new logs.MetricFilter(this, 'ProcessorOutboxWakeFailureMetric', {
      logGroup: this.processorLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"WhatsAppOutboxWakeFailure"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'OutboxWakeFailures',
      metricValue: '1',
    });
    new logs.MetricFilter(this, 'DomainOutboxWakeFailureMetric', {
      logGroup: domainOutboxDrainLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"WhatsAppOutboxWakeFailure"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'OutboxWakeFailures',
      metricValue: '1',
    });
    alarm(
      'WhatsAppOutboxWakeFailuresAlarm',
      'WhatsAppOutboxWakeFailures',
      processorWakeFailureMetric.metric({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);
    // ── C7: domain-event drain + release operational alarms ─────
    // Resolution #9 (observability ownership): C7 installs the drain's own
    // metrics on the drain Lambda's log group, and installs WhatsAppOtpLock
    // — emitted by the workflow lane's identity handler when a challenge
    // transitions to `locked` — on the PROCESSOR log group, not the drain's.
    const drainMetricFilter = (id: string, metricValueEquals: string, metricName: string) =>
      new logs.MetricFilter(this, id, {
        logGroup: domainOutboxDrainLambda.logGroup,
        filterPattern: logs.FilterPattern.literal(`"${metricValueEquals}"`),
        metricNamespace: 'Jale/WhatsApp',
        metricName,
        metricValue: '1',
      });

    const domainEventStuckMetric = drainMetricFilter(
      'WhatsAppDomainEventStuckMetric', 'WhatsAppDomainEventStuck', 'DomainEventStuck',
    );
    alarm(
      'WhatsAppDomainEventsStuckAlarm', 'WhatsAppDomainEventsStuck',
      domainEventStuckMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    const releaseFailureMetric = drainMetricFilter(
      'WhatsAppReleaseFailureMetric', 'WhatsAppReleaseFailure', 'ReleaseFailures',
    );
    alarm(
      'WhatsAppReleaseFailuresAlarm', 'WhatsAppReleaseFailures',
      releaseFailureMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // Lane C2: symmetric with WhatsAppReleaseFailures — surfaces transient
    // assessment.requested → TrustScorer SQS dispatch failures (emitted by the
    // drain on any dispatch/completion error) before they retry to the
    // WhatsAppDomainEventStuck cap.
    const assessmentDispatchFailureMetric = drainMetricFilter(
      'WhatsAppAssessmentDispatchFailureMetric', 'WhatsAppAssessmentDispatchFailure', 'AssessmentDispatchFailures',
    );
    alarm(
      'WhatsAppAssessmentDispatchFailuresAlarm', 'WhatsAppAssessmentDispatchFailures',
      assessmentDispatchFailureMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    const deferredBacklogAgedMetric = drainMetricFilter(
      'WhatsAppDeferredBacklogAgedMetric', 'WhatsAppDeferredBacklogAged', 'DeferredBacklogAge',
    );
    alarm(
      'WhatsAppDeferredBacklogAgeAlarm', 'WhatsAppDeferredBacklogAge',
      deferredBacklogAgedMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // WhatsAppOtpLock is emitted by the workflow lane's identity handler
    // INSIDE the processor Lambda (not the drain) — the filter must live on
    // the processor's log group.
    const otpLockMetric = new logs.MetricFilter(this, 'WhatsAppOtpLockMetric', {
      logGroup: this.processorLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"WhatsAppOtpLock"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'OtpLockRate',
      metricValue: '1',
    });
    alarm(
      'WhatsAppOtpLockRateAlarm', 'WhatsAppOtpLockRate',
      otpLockMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // ── 2026-07-27 observability pass ─────────────────────────────
    // OnboardingTrustQuestionGenerationFailed has been emitted by the
    // profile step handler since Task 5 but never had a filter/alarm — a
    // custom-trade worker stuck waiting for their generated questions was
    // invisible to operators.
    const trustQuestionGenFailedMetric = new logs.MetricFilter(this, 'WhatsAppTrustQuestionGenFailedMetric', {
      logGroup: this.processorLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"OnboardingTrustQuestionGenerationFailed"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'TrustQuestionGenerationFailed',
      metricValue: '1',
    });
    alarm(
      'WhatsAppTrustQuestionGenFailedAlarm', 'WhatsAppTrustQuestionGenerationFailed',
      trustQuestionGenFailedMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // v2 onboarding funnel: one datapoint per successful step advance
    // (emitted by advanceWorkflow / completeOnboarding in
    // onboarding-repository.ts). Dashboard/diagnosis metric — deliberately
    // no alarm; drop-off is a product signal, not a page.
    new logs.MetricFilter(this, 'WhatsAppOnboardingStepAdvancedMetric', {
      logGroup: this.processorLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"OnboardingStepAdvanced"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'OnboardingStepAdvanced',
      metricValue: '1',
    });
    new logs.MetricFilter(this, 'WhatsAppOnboardingCompletedMetric', {
      logGroup: this.processorLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"OnboardingCompleted"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'OnboardingCompleted',
      metricValue: '1',
    });

    // The two voice Step Functions previously had no failure signal at all
    // — a Transcribe failure or the 15-minute pipeline timeout stranded the
    // worker with no reply and paged nobody. (Prerequisite telemetry for
    // wiring voice into the v2 lane.)
    alarm(
      'WhatsAppProfileVoicePipelineFailedAlarm', 'WhatsAppProfileVoicePipelineFailed',
      profileVoicePipeline.stateMachine.metricFailed({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);
    alarm(
      'WhatsAppProfileVoicePipelineTimedOutAlarm', 'WhatsAppProfileVoicePipelineTimedOut',
      profileVoicePipeline.stateMachine.metricTimedOut({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);
    alarm(
      'WhatsAppTrustVoicePipelineFailedAlarm', 'WhatsAppTrustVoicePipelineFailed',
      trustVoicePipeline.stateMachine.metricFailed({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);
    alarm(
      'WhatsAppTrustVoicePipelineTimedOutAlarm', 'WhatsAppTrustVoicePipelineTimedOut',
      trustVoicePipeline.stateMachine.metricTimedOut({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    ).addAlarmAction(alarmAction);

    // ── I2 (final-review): moderation fail-open alarm ────────────
    // lib/moderation.ts's moderateImage() fails OPEN (approves the image)
    // when Rekognition itself is unreachable/erroring after one retry --
    // spec §5's deliberate choice not to block posting on a Rekognition
    // outage. It logs `moderateImage service fault (fail-open) key=...` via
    // plain `console.error` (NOT the `{ metric: ... }` JSON convention the
    // other filters above key off), so the term this filter matches is a
    // message substring rather than a metric name. (Every filter in this stack
    // is a term pattern now -- see the metricFilter helper above.) Without
    // this, a sustained Rekognition outage would silently auto-approve
    // every worker photo with nobody paged.
    const moderationFailOpenMetric = new logs.MetricFilter(this, 'WhatsAppModerationFailOpenMetric', {
      logGroup: this.processorLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"moderateImage service fault (fail-open)"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'ModerationFailOpen',
      metricValue: '1',
    });
    alarm(
      'WhatsAppModerationFailOpenAlarm', 'WhatsAppModerationFailOpen',
      moderationFailOpenMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
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

    // ═══════════════════════════════════════════════════════════════════
    // S22 R2-C23 — WEB ONBOARDING DOOR
    //
    //   GET    /worker/onboarding
    //   POST   /worker/onboarding/answers
    //   POST   /worker/onboarding/back
    //   PATCH  /worker/onboarding/language
    //
    // One Lambda driving the SAME `worker_workflow_runs` state machine the
    // processor drives for WhatsApp, as the SAME `jale_whatsapp` role — every
    // table the engine writes is granted to that role and no other API role,
    // column by column, across migrations 042/049/066/084/086. Migration 086
    // added the two SECURITY DEFINER entry points
    // (`resolve_worker_internal_id`, `start_web_onboarding_workflow`) that let
    // the web knock on that door.
    //
    // It lives in WhatsAppStack, not ApiStack, because WhatsAppStack already
    // depends on ApiStack (`props.api`) and owns everything this Lambda needs:
    // the `jale/whatsapp/db` secret, the question/alias generator ARNs and the
    // domain-outbox wake queue. Wiring it the other way round would create an
    // ApiStack ↔ WhatsAppStack cycle.
    // ═══════════════════════════════════════════════════════════════════

    const webOnboardingLambda = new JaleLambdaFunction(this, 'WorkerWebOnboardingLambda', {
      entry: path.join(__dirname, '../../lambda/whatsapp/web/worker-onboarding.ts'),
      description: 'Web worker onboarding — drives the WhatsApp v2 engine over HTTP',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      // API Gateway hard-caps a REST integration at 29s. `profile.trade`
      // synchronously invokes the question-generator Lambda on a cache miss,
      // so this is the one route that can legitimately take seconds rather
      // than milliseconds — but it must return a 5xx we control rather than
      // API Gateway's own 504.
      timeout: 28,
      environment: {
        // Same role as the processor: getDbPool() reads this alias.
        DB_SECRET_ARN: whatsappDbSecret.secretName,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        // createTrustQuestionGenerator invokes this synchronously to build a
        // trade's three questions. WITHOUT it the generator throws, the
        // adapter swallows the throw and `seedTrustQuestions` silently seeds
        // the generic FALLBACK set — a defect that is invisible in the flow
        // and only shows up weeks later as un-scorable assessments. The
        // handler logs `WebOnboardingFallbackQuestionsSeeded` when it happens.
        QUESTION_GENERATOR_ARN: props.questionGeneratorFn.functionArn,
        // Requested by the same custom-trust lane when a typed profession has
        // no alias row yet.
        ALIAS_GENERATOR_ARN: props.aliasGeneratorFn.functionArn,
        // The third trust answer completes onboarding and enqueues
        // `assessment.requested` + `worker.ready`. Poking the drain
        // post-commit is what keeps scoring and skill extraction from waiting
        // for the cron — exactly what the processor does.
        DOMAIN_OUTBOX_WAKE_QUEUE_URL: domainOutboxWakeQueue.queueUrl,
      },
    });
    whatsappDbSecret.grantRead(webOnboardingLambda.function);
    props.questionGeneratorFn.grantInvoke(webOnboardingLambda.function);
    props.aliasGeneratorFn.grantInvoke(webOnboardingLambda.function);
    domainOutboxWakeQueue.grantSendMessages(webOnboardingLambda.function);

    const webOnboardingIntegration = new apigateway.LambdaIntegration(webOnboardingLambda.function);
    // CORS preflight is inherited from the RestApi's
    // `defaultCorsPreflightOptions` (ApiStack), exactly like every sibling
    // `/worker/*` route — no per-resource CORS here on purpose.
    const onboardingResource = props.workerResource.addResource('onboarding');
    const workerAuth = {
      authorizer: props.workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };
    onboardingResource.addMethod('GET', webOnboardingIntegration, workerAuth);
    // ONE `{action}` resource, not three siblings (`answers`, `back`,
    // `language`). The URLs the browser calls are unchanged; the CloudFormation
    // footprint is not. ApiStack stands at 489 resources against CloudFormation's
    // hard maximum of 500, and every REST resource costs more than itself: a
    // Resource, its method, the OPTIONS preflight `defaultCorsPreflightOptions`
    // adds, and two Lambda::Permissions per Lambda-backed method. Four sibling
    // resources come to 20 and synthesis fails outright with
    // TooManyResourcesInStack; this shape costs 10.
    //
    // ANY, because one resource has to carry POST (answers, back) and PATCH
    // (language). It is not a widening: the Cognito worker authorizer is
    // attached to the method exactly as it is to the GET, and the handler
    // answers any method/action pair it does not route with 404 `not_found`.
    //
    // NOTE FOR WHOEVER ADDS THE NEXT ROUTE: this leaves ApiStack at 499/500.
    // The stack needs splitting (a nested stack, or a second RestApi for
    // `/worker/*`) before anything else can be hung off it.
    onboardingResource.addResource('{action}').addMethod('ANY', webOnboardingIntegration, workerAuth);
  }
}
