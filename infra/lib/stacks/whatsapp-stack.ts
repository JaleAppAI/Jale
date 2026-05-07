import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { JaleCognitoPool } from '../constructs/cognito-pool';

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
      this.node.tryGetContext('allowedOrigin') ?? 'http://localhost:3000';

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
