import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { JaleCognitoPool } from '../constructs/cognito-pool';
import { VoiceTranscriptionPipeline } from '../constructs/voice-transcription-pipeline';

export interface WhatsAppStackProps extends cdk.StackProps {
  /** VPC shared across all stacks */
  readonly vpc: ec2.IVpc;
  /** Private-with-egress subnets (NAT-backed in V1) */
  readonly privateSubnets: ec2.ISubnet[];
  /** Lambda security group */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** jale_admin DB secret (NOT used by WhatsApp Lambdas — they use their own) */
  readonly dbSecret: secretsmanager.ISecret;
  /** Worker Cognito pool — for SignUp / AdminConfirmSignUp / InitiateAuth */
  readonly workerPool: JaleCognitoPool;
  /** Existing API Gateway (from ApiStack) — webhook route added here */
  readonly api: apigateway.RestApi;
  readonly workerRerankQueue?: sqs.IQueue;
  readonly questionGeneratorFn: lambda.IFunction;
  readonly trustAssessmentQueue: sqs.IQueue;
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
  public readonly webhookLambda: JaleLambdaFunction;
  public readonly processorLambda: JaleLambdaFunction;
  public readonly jobAlertLambda: JaleLambdaFunction;

  constructor(scope: Construct, id: string, props: WhatsAppStackProps) {
    super(scope, id, props);

    // ── Context values ──────────────────────────────────────────
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const allowedOrigin =
      this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';

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
    // SecretsMgr → DB → SignUp → AdminConfirmSignUp → defensive INSERT →
    // InitiateAuth → SNS → Twilio → DB update.
    this.inboundQueue = new sqs.Queue(this, 'WhatsAppInboundQueue', {
      queueName: 'whatsapp-inbound-queue',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: this.inboundDlq,
        maxReceiveCount: 3,
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
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    twilioSecret.grantRead(this.webhookLambda.function);
    this.inboundQueue.grantSendMessages(this.webhookLambda.function);

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
        WORKER_POOL_ID: props.workerPool.userPoolId,
        WORKER_CLIENT_ID: props.workerPool.clientId,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
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

    // Cognito permissions — SignUp / AdminConfirmSignUp / InitiateAuth /
    // RespondToAuthChallenge. Scoped to all pools in the account/region to
    // avoid the circular dependency pattern documented in auth-stack.ts:125-136.
    this.processorLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:SignUp',
          'cognito-idp:AdminConfirmSignUp',
          'cognito-idp:InitiateAuth',
          'cognito-idp:RespondToAuthChallenge',
          'cognito-idp:AdminGetUser',
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
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    whatsappDbSecret.grantRead(this.jobAlertLambda.function);
    twilioSecret.grantRead(this.jobAlertLambda.function);

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
      },
    });
    whatsappDbSecret.grantRead(outboxSweeperLambda.function);
    twilioSecret.grantRead(outboxSweeperLambda.function);

    new events.Rule(this, 'JobMessageOutboxSweepRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(outboxSweeperLambda.function)],
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
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        BEDROCK_MODEL_ID: 'us.amazon.nova-lite-v1:0',
        AI_EXTRACTION_CONFIDENCE_THRESHOLD: '0.75',
        AI_INDUSTRY_KEYWORDS: '[]',
        QUESTION_GENERATOR_ARN: props.questionGeneratorFn.functionArn,
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
  }
}
