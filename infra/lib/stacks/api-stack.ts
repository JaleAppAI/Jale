import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { JaleCognitoPool } from '../constructs/cognito-pool';
import { dedicatedDbLogin } from '../constructs/db-login-secrets';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { normalizeWhatsappStatusCallbackUrl } from '../whatsapp-status-callback-url';
import { BEDROCK_MODEL_ID, bedrockArns } from '../bedrock-arns';
import { lambdaIntegration, addPathOnlyResource } from '../api-integration';

export interface ApiStackProps extends cdk.StackProps {
  readonly workerPool: JaleCognitoPool;
  readonly employerPool: JaleCognitoPool;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly candidateMaterializationQueue?: sqs.IQueue;
  readonly employerCandidateRerankQueue?: sqs.IQueue;
  readonly aliasGeneratorFn: lambda.IFunction;
  /**
   * Exact public Twilio WhatsApp delivery-status callback URL. Required —
   * the employer-conversations Lambdas send WhatsApp messages and must set
   * a valid StatusCallback on every send. Fail closed rather than silently
   * omitting the env var (a prior version conditionally omitted it).
   */
  readonly whatsappStatusCallbackUrl: string;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly apiUrl: string;
  public readonly dualAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  public readonly employerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  public readonly workerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  /** Exported so BillingStack (and other downstream stacks) can hang routes off /employer */
  public readonly employerResource: apigateway.Resource;
  /** Exported so ReferralsStack (and other downstream stacks) can hang routes off /worker */
  public readonly workerResource: apigateway.Resource;
  /**
   * Exported so WhatsAppStack can hang the stage-2 details door
   * (`/worker/applications/{applicationId}*`) off it. That door runs as
   * `jale_whatsapp` — the only role with a worker-scoped UPDATE policy on
   * `job_applications` (`jobapp_whatsapp_update`, migration 028) — so its
   * Lambda needs WhatsAppStack's `jale/whatsapp/db` secret and cannot live
   * here; ApiStack owns the resource, WhatsAppStack hangs the methods.
   */
  public readonly workerApplicationsResource: apigateway.Resource;
  /**
   * Exported so ReferralsStack and NotificationsStack can hang their
   * UNAUTHENTICATED routes off /public.
   *
   * Promoted here from ReferralsStack (which used to call
   * `props.api.root.addResource('public')` itself) the moment a second stack
   * needed the same node: two stacks calling addResource('public') on one
   * RestApi is a construct-id collision, and which one wins depends purely on
   * instantiation order in bin/jale-app.ts. Same reuse-don't-redeclare rule as
   * workerJobResource / employerJobResource below.
   *
   * The move is CloudFormation-neutral: addResource() scopes the child to the
   * RestApi construct, which has always lived in this stack, so the logical id
   * is unchanged by moving the CALL here.
   */
  public readonly publicResource: apigateway.Resource;
  /**
   * Exported so ReferralsStack can hang POST /worker/jobs/{jobId}/share off the
   * existing /worker/jobs/{jobId} node — NOT a new addResource() call. A second
   * variable-path resource at this level (even a differently-named one, e.g.
   * {id} and {jobId} as siblings) is rejected by API Gateway, so downstream
   * stacks must reuse this node rather than re-declare the path segment.
   *
   * Undefined during a phase-1 rename deploy (-c workerJobsRenamePhase1=true),
   * when the node is deliberately absent — consumers must skip their routes.
   */
  public readonly workerJobResource?: apigateway.Resource;
  /**
   * Exported so ReferralsStack can hang PATCH
   * /employer/jobs/{jobId}/public-listing off the existing employer {jobId}
   * node — same reuse-don't-redeclare rule as workerJobResource above.
   */
  public readonly employerJobResource: apigateway.Resource;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const stageName = this.node.tryGetContext('environment') ?? 'dev';
    if (!props.whatsappStatusCallbackUrl) {
      throw new Error('ApiStack requires whatsappStatusCallbackUrl (props.whatsappStatusCallbackUrl)');
    }
    const whatsappStatusCallbackUrl = normalizeWhatsappStatusCallbackUrl(props.whatsappStatusCallbackUrl);
    const twilioSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'MessagingTwilioSecret',
      'jale/whatsapp/twilio',
    );

    // ── Database logins ──
    // Every authenticated route here connects as the request login. The one
    // unauthenticated route that touches the database, worker web signup,
    // connects as the public login, which can only execute the functions
    // that route calls.
    const apiDb = dedicatedDbLogin(this, 'jale_api');
    const apiPublicDb = dedicatedDbLogin(this, 'jale_api_public');

    // ── API Gateway CloudWatch account role ──
    // This is an account-level setting (one per region) required before API Gateway
    // can write access logs to CloudWatch. Without it, stage creation fails with
    // "CloudWatch Logs role ARN must be set in account settings".
    const apiGwCloudWatchRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });

    const apiGwAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGwCloudWatchRole.roleArn,
    });

    // ── CloudWatch access log group ──
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/jale-api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── REST API ──
    this.api = new apigateway.RestApi(this, 'JaleApi', {
      restApiName: 'jale-api',
      deployOptions: {
        stageName,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        // The standard fields, unchanged and in their usual order, plus the
        // integration's own request id (for a Lambda proxy route, the
        // invocation id that heads that Lambda's log lines), so a request id
        // seen by a client leads to the handler's logs. Then the
        // integration's latency and status.
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          ...JSON.parse(apigateway.AccessLogFormat.jsonWithStandardFields().toString()),
          awsEndpointRequestId: apigateway.AccessLogField.contextAwsEndpointRequestId(),
          integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
          integrationStatus: apigateway.AccessLogField.contextIntegrationStatus(),
        })),
        // Rendered by CDK as the stage-wide '/*' + '*' MethodSetting, which
        // the per-method throttles near the end of this constructor append to.
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [allowedOrigin],
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      },
    });

    // Deployment stage must wait for the account CloudWatch role to be set
    this.api.node.addDependency(apiGwAccount);

    // ── Default Gateway Responses ──
    // API Gateway returns 4xx/5xx before reaching Lambda (auth failures, throttling).
    // These responses lack CORS headers by default, causing browser CORS errors.
    this.api.addGatewayResponse('Default4xx', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'${allowedOrigin}'`,
        'Access-Control-Allow-Headers': "'Content-Type,Authorization,Idempotency-Key'",
      },
    });
    this.api.addGatewayResponse('Default5xx', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'${allowedOrigin}'`,
        'Access-Control-Allow-Headers': "'Content-Type,Authorization,Idempotency-Key'",
      },
    });

    // ── Cognito Authorizers ──
    this.workerAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'WorkerAuthorizer', {
      cognitoUserPools: [props.workerPool.userPool],
      authorizerName: 'worker-authorizer',
    });
    const workerAuthorizer = this.workerAuthorizer;

    this.employerAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'EmployerAuthorizer', {
      cognitoUserPools: [props.employerPool.userPool],
      authorizerName: 'employer-authorizer',
    });
    const employerAuthorizer = this.employerAuthorizer;

    // Dual authorizer — validates tokens from either pool (used by LegalStack)
    this.dualAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'DualAuthorizer', {
      cognitoUserPools: [props.workerPool.userPool, props.employerPool.userPool],
      authorizerName: 'legal-dual-authorizer',
    });

    // ── Lambda Functions ──

    // Health check — no auth, no DB
    const healthLambda = new JaleLambdaFunction(this, 'HealthLambda', {
      entry: path.join(__dirname, '../../lambda/api/health.ts'),
      description: 'Health check endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });

    // Pay reference lookup — dual auth (worker + employer), DB access (T-B2).
    // Reads migration 071's wage_references / city_cbsa_crosswalk tables
    // (T-B1); no REQUIRED_TOS_VERSION env var, since the handler mirrors
    // legal/accept-tos.ts's convention of not calling checkCompliance() for
    // this dual-auth route.
    const payReferenceLambda = new JaleLambdaFunction(this, 'PayReferenceLambda', {
      entry: path.join(__dirname, '../../lambda/api/pay-reference.ts'),
      description: 'Recommended-pay reference lookup endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(payReferenceLambda.function);

    // Worker profile — worker auth, DB access
    const workerProfileLambda = new JaleLambdaFunction(this, 'WorkerProfileLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-profile.ts'),
      description: 'Worker profile endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(workerProfileLambda.function);

    // Worker application defaults — worker auth, DB access. Prefill data
    // for a new application (worker_application_defaults,
    // 079_worker_application_defaults.sql).
    const workerApplicationDefaultsGetLambda = new JaleLambdaFunction(this, 'WorkerApplicationDefaultsGetLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-application-defaults-get.ts'),
      description: 'Worker application defaults endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(workerApplicationDefaultsGetLambda.function);

    // Employer digest settings — employer auth, DB access. GET + PATCH on one
    // Lambda (employer-profile precedent). Reads/writes
    // employer_digest_settings (082_employer_digest_settings.sql).
    const employerDigestSettingsLambda = new JaleLambdaFunction(this, 'EmployerDigestSettingsLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-digest-settings.ts'),
      description: 'Employer digest settings endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerDigestSettingsLambda.function);

    // Employer profile — employer auth, DB access
    const employerProfileLambda = new JaleLambdaFunction(this, 'EmployerProfileLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-profile.ts'),
      description: 'Employer profile endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerProfileLambda.function);

    // Employer jobs list — employer auth, DB access
    const employerJobsListLambda = new JaleLambdaFunction(this, 'EmployerJobsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-list.ts'),
      description: 'Employer jobs list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerJobsListLambda.function);

    // Employer jobs create — employer auth, DB access
    const employerJobsCreateLambda = new JaleLambdaFunction(this, 'EmployerJobsCreateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-create.ts'),
      description: 'Employer jobs create endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerJobsCreateLambda.function);

    // Employer job detail — employer auth, DB access
    const employerJobsDetailLambda = new JaleLambdaFunction(this, 'EmployerJobsDetailLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-detail.ts'),
      description: 'Employer job detail endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerJobsDetailLambda.function);

    const employerJobsUpdateLambda = new JaleLambdaFunction(this, 'EmployerJobsUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-update.ts'),
      description: 'Employer jobs update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerJobsUpdateLambda.function);

    const employerJobsDeleteLambda = new JaleLambdaFunction(this, 'EmployerJobsDeleteLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-delete.ts'),
      description: 'Employer jobs hard-delete endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerJobsDeleteLambda.function);

    // T-A1: AI job-description generation — employer auth. Since Phase 3 it
    // reads the database once, as the request login: the caller's employer
    // actor (a removed or suspended foreman, or a login with no company, gets
    // 403 before any Bedrock call). The shared lambdaSg is the one RdsSg
    // admits on 5432. Daily-cap table modeled on AuthStack's
    // OtpRateLimitTable precedent (PAY_PER_REQUEST + AWS-managed encryption +
    // TTL + RemovalPolicy.RETAIN) but with a single partition key `pk` --
    // this table's key is already the composite "<sub>#<YYYY-MM-DD>" string,
    // so it needs no separate sort key the way OtpRateLimitTable's
    // subject/window pair does.
    const generationCapTable = new dynamodb.Table(this, 'GenerationCapTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const employerGenerateDescriptionLambda = new JaleLambdaFunction(this, 'EmployerGenerateDescriptionLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-generate-description.ts'),
      description: 'Employer generate description endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        GENERATION_CAP_TABLE: generationCapTable.tableName,
        GENERATION_DAILY_LIMIT: '10',
        BEDROCK_MODEL_ID,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerGenerateDescriptionLambda.function);
    generationCapTable.grantReadWriteData(employerGenerateDescriptionLambda.function);
    employerGenerateDescriptionLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockArns(this.region, this.account),
      }),
    );

    // Employer job applicants — employer auth, DB access
    const employerJobApplicantsLambda = new JaleLambdaFunction(this, 'EmployerJobApplicantsLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-job-applicants.ts'),
      description: 'Employer job applicants endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerJobApplicantsLambda.function);

    // Employer applicant routes — employer auth, DB access. The entry
    // dispatches the bare `{workerId}` PATCH (status update) and the
    // `{workerId}/{action}` child (F19 hire details) to their handlers.
    const employerApplicationStatusUpdateLambda = new JaleLambdaFunction(this, 'EmployerApplicationStatusUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-applicant-dispatch.ts'),
      description: 'Employer application status update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        // Deep link in the worker's stage-change WhatsApp message. Same source
        // the DocumentsStack uses for FRONTEND_BASE_URL (documents-stack.ts:69).
        FRONTEND_BASE_URL: allowedOrigin,
      },
    });
    apiDb.grantRead(employerApplicationStatusUpdateLambda.function);

    const employerConversationsListLambda = new JaleLambdaFunction(this, 'EmployerConversationsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-list.ts'),
      description: 'Employer conversations list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerConversationsListLambda.function);

    const employerConversationsDetailLambda = new JaleLambdaFunction(this, 'EmployerConversationsDetailLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-detail.ts'),
      description: 'Employer conversations detail endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerConversationsDetailLambda.function);

    const employerConversationsCreateLambda = new JaleLambdaFunction(this, 'EmployerConversationsCreateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-create.ts'),
      description: 'Employer conversations create endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        TWILIO_SECRET_ARN: twilioSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: whatsappStatusCallbackUrl,
      },
    });
    apiDb.grantRead(employerConversationsCreateLambda.function);
    twilioSecret.grantRead(employerConversationsCreateLambda.function);

    const employerConversationsSendLambda = new JaleLambdaFunction(this, 'EmployerConversationsSendLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-send.ts'),
      description: 'Employer conversations send endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        TWILIO_SECRET_ARN: twilioSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: whatsappStatusCallbackUrl,
      },
    });
    apiDb.grantRead(employerConversationsSendLambda.function);
    twilioSecret.grantRead(employerConversationsSendLambda.function);

    // 1c: lib/job-messaging.ts logs JobMessageOutboxSendFailed from both
    // employer conversation endpoints. These filters only publish to the
    // shared Jale/WhatsApp metric; the JobMessageSendFailures alarm lives in
    // WhatsAppStack (which owns the alarm topic) and sums every filter.
    new logs.MetricFilter(this, 'EmployerConversationsCreateSendFailureMetric', {
      logGroup: employerConversationsCreateLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"JobMessageOutboxSendFailed"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'JobMessageSendFailures',
      metricValue: '1',
    });
    new logs.MetricFilter(this, 'EmployerConversationsSendSendFailureMetric', {
      logGroup: employerConversationsSendLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"JobMessageOutboxSendFailed"'),
      metricNamespace: 'Jale/WhatsApp',
      metricName: 'JobMessageSendFailures',
      metricValue: '1',
    });

    const employerConversationsUpdateLambda = new JaleLambdaFunction(this, 'EmployerConversationsUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-update.ts'),
      description: 'Employer conversations update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerConversationsUpdateLambda.function);

    // T3a — POST /employer/conversations/{conversationId}/read. Stamps
    // job_conversations.employer_last_read_at, which is what clears the inbox
    // unread badge. Same shape as the update endpoint above: DB secret only,
    // no Twilio (it sends nothing).
    const employerConversationsReadLambda = new JaleLambdaFunction(this, 'EmployerConversationsReadLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-read.ts'),
      description: 'Employer conversations read endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerConversationsReadLambda.function);

    const employerInboxLambda = new JaleLambdaFunction(this, 'EmployerInboxLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-inbox.ts'),
      description: 'Employer inbox endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerInboxLambda.function);

    const employerApplicantsOverviewLambda = new JaleLambdaFunction(this, 'EmployerApplicantsOverviewLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-applicants-overview.ts'),
      description: 'Employer applicants overview endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerApplicantsOverviewLambda.function);

    // Employer templates list — employer auth, DB access
    const employerTemplatesListLambda = new JaleLambdaFunction(this, 'EmployerTemplatesListLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-templates-list.ts'),
      description: 'Employer templates list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerTemplatesListLambda.function);

    // Employer templates save — employer auth, DB access
    const employerTemplatesSaveLambda = new JaleLambdaFunction(this, 'EmployerTemplatesSaveLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-templates-save.ts'),
      description: 'Employer templates save endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerTemplatesSaveLambda.function);

    // Employer templates delete — employer auth, DB access
    const employerTemplatesDeleteLambda = new JaleLambdaFunction(this, 'EmployerTemplatesDeleteLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-templates-delete.ts'),
      description: 'Employer templates delete endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(employerTemplatesDeleteLambda.function);

    // Token refresh — no auth (refresh token is the credential), no DB
    const tokenRefreshLambda = new JaleLambdaFunction(this, 'TokenRefreshLambda', {
      entry: path.join(__dirname, '../../lambda/auth/token-refresh.ts'),
      description: 'Token refresh endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        WORKER_CLIENT_ID: props.workerPool.clientId,
        EMPLOYER_CLIENT_ID: props.employerPool.clientId,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });

    // Logout — no auth (user may have expired access token), no DB
    const logoutLambda = new JaleLambdaFunction(this, 'LogoutLambda', {
      entry: path.join(__dirname, '../../lambda/auth/logout.ts'),
      description: 'Logout endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        WORKER_CLIENT_ID: props.workerPool.clientId,
        EMPLOYER_CLIENT_ID: props.employerPool.clientId,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });

    // Worker web signup - no auth yet; creates/confirms worker, then custom auth sends SMS OTP
    const workerWebSignupLambda = new JaleLambdaFunction(this, 'WorkerWebSignupLambda', {
      entry: path.join(__dirname, '../../lambda/auth/worker-web-signup.ts'),
      description: 'Worker web signup endpoint - create confirmed worker before SMS OTP login',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiPublicDb.environment,
        WORKER_POOL_ID: props.workerPool.userPoolId,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiPublicDb.grantRead(workerWebSignupLambda.function);

    // Worker jobs list — worker auth, DB access
    const workerJobsListLambda = new JaleLambdaFunction(this, 'WorkerJobsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-jobs-list.ts'),
      description: 'Worker jobs list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(workerJobsListLambda.function);

    // Worker job detail — worker auth, DB access. Since sprint 28 the same
    // Lambda also serves POST /worker/jobs/{jobId}/view (the job view
    // capture); worker-job-dispatch.ts picks the handler.
    const workerJobsDetailLambda = new JaleLambdaFunction(this, 'WorkerJobsDetailLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-job-dispatch.ts'),
      description: 'Worker job detail endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(workerJobsDetailLambda.function);

    // Worker job apply — worker auth, DB access
    const workerJobsApplyLambda = new JaleLambdaFunction(this, 'WorkerJobsApplyLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-jobs-apply.ts'),
      description: 'Worker job apply endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(workerJobsApplyLambda.function);

    const employerJobCandidatesLambda = new JaleLambdaFunction(this, 'EmployerJobCandidatesLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-job-candidates.ts'),
      description: 'Employer job candidates endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        ...(props.employerCandidateRerankQueue
          ? { EMPLOYER_CANDIDATE_RERANK_QUEUE_URL: props.employerCandidateRerankQueue.queueUrl }
          : {}),
      },
    });
    apiDb.grantRead(employerJobCandidatesLambda.function);
    props.employerCandidateRerankQueue?.grantSendMessages(employerJobCandidatesLambda.function);

    // Worker applications list — worker auth, DB access
    const workerApplicationsListLambda = new JaleLambdaFunction(this, 'WorkerApplicationsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-applications-list.ts'),
      description: 'Worker applications list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(workerApplicationsListLambda.function);

    // Worker profile update — worker auth, DB access
    const workerProfileUpdateLambda = new JaleLambdaFunction(this, 'WorkerProfileUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-profile-update.ts'),
      description: 'Worker profile update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        ALIAS_GENERATOR_ARN: props.aliasGeneratorFn.functionArn,
      },
    });
    apiDb.grantRead(workerProfileUpdateLambda.function);
    props.aliasGeneratorFn.grantInvoke(workerProfileUpdateLambda.function);

    // Tutorial progress and guide settings (sprint 29 contracts K1 and
    // K1-v2) — employer and worker auth, DB access. One function serves
    // GET/POST/PATCH /employer/tutorials and /worker/tutorials: the path picks
    // the role, and each path's authorizer pins its pool. Configured like the
    // pay-reference function: no REQUIRED_TOS_VERSION, because the handler
    // does not call checkCompliance() (UI state, shown before worker
    // onboarding finishes).
    const tutorialProgressFunction = new JaleLambdaFunction(this, 'TutorialProgressFunction', {
      entry: path.join(__dirname, '../../lambda/api/tutorial-progress.ts'),
      description: 'Tutorial progress endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        ...apiDb.environment,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(tutorialProgressFunction.function);

    // ── IAM: Cognito permissions for auth Lambdas ──
    // Scoped to the two pool ARNs to respect least privilege.
    const poolArns = [
      props.workerPool.userPool.userPoolArn,
      props.employerPool.userPool.userPoolArn,
    ];

    tokenRefreshLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:InitiateAuth'],
      resources: poolArns,
    }));

    logoutLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:GlobalSignOut', 'cognito-idp:RevokeToken'],
      resources: poolArns,
    }));

    // C4: this set must cover every Cognito call the signup flow makes,
    // including reconcileWorkerCognitoAccount() on the UsernameExists path:
    // AdminGetUser, AdminUpdateUserAttributes, AdminEnableUser,
    // AdminSetUserPassword, AdminAddUserToGroup. AdminConfirmSignUp was unused
    // (the flow uses AdminCreateUser + SUPPRESS) and is dropped for least-privilege.
    workerWebSignupLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminSetUserPassword',
      ],
      resources: [props.workerPool.userPool.userPoolArn],
    }));

    // ── Routes ──

    // GET /health
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', lambdaIntegration(healthLambda.function));

    // GET /pay-reference — recommended-pay lookup (T-B2). Dual-authenticated:
    // both workers and employers call this (the only other dualAuthorizer
    // consumer is LegalStack's POST /legal/accept). Public BLS statistics
    // only, no per-user data, so RLS context is set for standard transaction
    // hygiene but is not load-bearing here (wage_references /
    // city_cbsa_crosswalk grant jale_admin a flat read-all policy).
    const payReferenceResource = this.api.root.addResource('pay-reference');
    payReferenceResource.addMethod('GET', lambdaIntegration(payReferenceLambda.function), {
      authorizer: this.dualAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /public — the shared parent for every UNAUTHENTICATED route added by a
    // downstream stack (ReferralsStack's /public/jobs*, NotificationsStack's
    // /public/employer-digest/unsubscribe). Declared here, exported, and never
    // re-declared downstream: see the publicResource field comment.
    // Path-only: no method on /public itself, so no CORS preflight is built.
    this.publicResource = addPathOnlyResource(this.api.root, 'public');

    // GET /worker/profile
    // PATCH /worker/profile
    // Exported as public readonly so ReferralsStack (and other downstream
    // stacks) can hang routes off /worker.
    // Path-only: no method on /worker itself, so no CORS preflight is built.
    this.workerResource = addPathOnlyResource(this.api.root, 'worker');
    const workerResource = this.workerResource;
    const workerProfileResource = workerResource.addResource('profile');
    workerProfileResource.addMethod('GET', lambdaIntegration(workerProfileLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    workerProfileResource.addMethod('PATCH', lambdaIntegration(workerProfileUpdateLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /worker/application-defaults — prefill data for a new application
    const workerApplicationDefaultsResource = workerResource.addResource('application-defaults');
    workerApplicationDefaultsResource.addMethod('GET', lambdaIntegration(workerApplicationDefaultsGetLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /worker/jobs — list open jobs for worker
    // GET /worker/jobs/{jobId} — job detail
    // POST /worker/jobs/{jobId}/apply — apply to a job
    // POST /worker/jobs/{jobId}/share — mint a referral share link (ReferralsStack)
    //
    // NOTE: this path parameter is named {jobId}, not {id} — renamed here (and
    // in worker-jobs-detail.ts / worker-jobs-apply.ts, which read
    // pathParameters.jobId) so ReferralsStack's worker-job-share.ts (which
    // also reads pathParameters.jobId and must not be modified) can hang its
    // route off this exact node instead of adding a second, differently-named
    // variable-path resource at the same level — API Gateway does not allow
    // two path-parameter siblings under one parent.
    //
    // ─────────────────────────────────────────────────────────────────────────
    // DEPLOY WARNING — this rename REQUIRES A TWO-PHASE DEPLOY. Read before
    // shipping it the first time.
    //
    // CDK derives a resource's logical id from its path segment, so renaming
    // {id} -> {jobId} is not an update in CloudFormation's eyes: it is a DELETE
    // of the old resource plus a CREATE of a new one. That cascades to the
    // child `apply` resource and every method under both.
    //
    // CloudFormation's default order is create-new-then-delete-old, and that
    // order CANNOT work here: creating {jobId} while {id} still exists is
    // exactly the sibling collision described above, so API Gateway rejects it
    // and the stack update rolls back.
    //
    // Sequence it deliberately instead:
    //   Phase 1 — deploy with the OLD {id} node and its methods removed.
    //             GET /worker/jobs/{id} and POST /worker/jobs/{id}/apply are
    //             UNAVAILABLE from here until phase 2 completes. Job detail and
    //             job apply are high-traffic worker endpoints; pick the window.
    //   Phase 2 — deploy this file as written, creating {jobId} and its methods.
    //
    // Client URLs are unchanged either way (callers build the path from the job
    // id value, never the parameter name), so no frontend or app release is
    // coupled to this. Verify both routes respond after phase 2 before
    // considering the deploy done.
    // ─────────────────────────────────────────────────────────────────────────
    // The two-phase sequence above is expressed as a CONTEXT FLAG so the
    // operator checks out nothing and edits nothing mid-deploy:
    //   Phase 1: cdk deploy -c workerJobsRenamePhase1=true   (routes DOWN)
    //   Phase 2: cdk deploy                                   (routes restored as {jobId})
    // Phase 1 omits the {jobId} node and its methods entirely, which IS the
    // documented outage window for GET /worker/jobs/{id} and its apply route.
    // The env fallback exists so the deploy PIPELINE can drive phase 1 from a
    // GitHub variable (JALE_WORKER_JOBS_RENAME_PHASE1=true) instead of anyone
    // editing files or passing -c flags mid-deploy. An unset variable is an
    // empty string, which is falsy — every ordinary deploy is phase 2.
    const workerJobsRenamePhase1 = this.node.tryGetContext('workerJobsRenamePhase1') === true
      || this.node.tryGetContext('workerJobsRenamePhase1') === 'true'
      || process.env.JALE_WORKER_JOBS_RENAME_PHASE1 === 'true';

    const workerJobsResource = workerResource.addResource('jobs');
    workerJobsResource.addMethod('GET', lambdaIntegration(workerJobsListLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    if (!workerJobsRenamePhase1) {
      this.workerJobResource = workerJobsResource.addResource('{jobId}');
      const workerJobResource = this.workerJobResource;
      workerJobResource.addMethod('GET', lambdaIntegration(workerJobsDetailLambda.function), {
        authorizer: workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
      const workerJobApplyResource = workerJobResource.addResource('apply');
      workerJobApplyResource.addMethod('POST', lambdaIntegration(workerJobsApplyLambda.function), {
        authorizer: workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
      // POST /worker/jobs/{jobId}/view — admin analytics job view (#17),
      // served by the detail Lambda (no new function).
      workerJobResource.addResource('view').addMethod('POST', lambdaIntegration(workerJobsDetailLambda.function), {
        authorizer: workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
    }

    // GET /worker/applications — list worker's own applications
    this.workerApplicationsResource = workerResource.addResource('applications');
    this.workerApplicationsResource.addMethod('GET', lambdaIntegration(workerApplicationsListLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET   /worker/tutorials — the worker's tutorial progress and guide settings
    // POST  /worker/tutorials — record how an auto-opened tutorial or the app tour was dismissed
    // PATCH /worker/tutorials — save the worker's guide settings
    const workerTutorialsResource = workerResource.addResource('tutorials');
    workerTutorialsResource.addMethod('GET', lambdaIntegration(tutorialProgressFunction.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    workerTutorialsResource.addMethod('POST', lambdaIntegration(tutorialProgressFunction.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    workerTutorialsResource.addMethod('PATCH', lambdaIntegration(tutorialProgressFunction.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/profile
    // PATCH /employer/profile
    // Exported as public readonly so BillingStack can hang /employer/billing routes off it.
    // Path-only: no method on /employer itself, so no CORS preflight is built.
    this.employerResource = addPathOnlyResource(this.api.root, 'employer');
    const employerProfileResource = this.employerResource.addResource('profile');
    employerProfileResource.addMethod('GET', lambdaIntegration(employerProfileLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerProfileResource.addMethod('PATCH', lambdaIntegration(employerProfileLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET   /employer/settings/digest — daily-digest preferences
    // PATCH /employer/settings/digest — partial update of those preferences
    //
    // PATCH, not PUT: lib/http.ts's corsHeaders() advertises
    // GET,POST,PATCH,DELETE,OPTIONS and PUT is absent, so a PUT route would
    // fail browser preflight no matter what API Gateway accepted.
    // Path-only: nothing on /employer/settings itself, only /settings/digest below.
    const employerSettingsResource = addPathOnlyResource(this.employerResource, 'settings');
    const employerDigestSettingsResource = employerSettingsResource.addResource('digest');
    employerDigestSettingsResource.addMethod('GET', lambdaIntegration(employerDigestSettingsLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerDigestSettingsResource.addMethod('PATCH', lambdaIntegration(employerDigestSettingsLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/jobs — list all jobs for this employer
    // POST /employer/jobs — create a new job posting
    const employerJobsResource = this.employerResource.addResource('jobs');
    employerJobsResource.addMethod('GET', lambdaIntegration(employerJobsListLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerJobsResource.addMethod('POST', lambdaIntegration(employerJobsCreateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // POST /employer/jobs/generate-description — T-A1 AI job-description draft
    const employerJobsGenerateDescriptionResource = employerJobsResource.addResource('generate-description');
    employerJobsGenerateDescriptionResource.addMethod(
      'POST',
      lambdaIntegration(employerGenerateDescriptionLambda.function),
      {
        authorizer: employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    // GET /employer/jobs/{jobId} — job posting detail
    // PATCH /employer/jobs/{jobId} — toggle active/closed status
    // GET /employer/jobs/{jobId}/applicants — list applicants for a job
    this.employerJobResource = employerJobsResource.addResource('{jobId}');
    const employerJobResource = this.employerJobResource;
    employerJobResource.addMethod('GET', lambdaIntegration(employerJobsDetailLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerJobResource.addMethod('PATCH', lambdaIntegration(employerJobsUpdateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    // DELETE /employer/jobs/{jobId} — permanently delete a job the employer owns
    employerJobResource.addMethod('DELETE', lambdaIntegration(employerJobsDeleteLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const employerJobApplicantsResource = employerJobResource.addResource('applicants');
    employerJobApplicantsResource.addMethod('GET', lambdaIntegration(employerJobApplicantsLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const employerJobApplicantResource = employerJobApplicantsResource.addResource('{workerId}');
    employerJobApplicantResource.addMethod('PATCH', lambdaIntegration(employerApplicationStatusUpdateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    // PUT /employer/jobs/{jobId}/applicants/{workerId}/hire-details (F19):
    // a variable `{action}` child on the same Lambda (lib/path-dispatch.ts),
    // so a later applicant action costs no new Resource or Function.
    employerJobApplicantResource
      .addResource('{action}')
      .addMethod('PUT', lambdaIntegration(employerApplicationStatusUpdateLambda.function), {
        authorizer: employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    const employerJobCandidatesResource = employerJobResource.addResource('candidates');
    employerJobCandidatesResource.addMethod('GET', lambdaIntegration(employerJobCandidatesLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const employerConversationsResource = this.employerResource.addResource('conversations');
    employerConversationsResource.addMethod('GET', lambdaIntegration(employerConversationsListLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerConversationsResource.addMethod('POST', lambdaIntegration(employerConversationsCreateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const employerConversationResource = employerConversationsResource.addResource('{conversationId}');
    employerConversationResource.addMethod('GET', lambdaIntegration(employerConversationsDetailLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerConversationResource.addMethod('PATCH', lambdaIntegration(employerConversationsUpdateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerConversationResource
      .addResource('messages')
      .addMethod('POST', lambdaIntegration(employerConversationsSendLambda.function), {
        authorizer: employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
    // POST, not PATCH: this is not a partial update of the conversation the
    // caller submits, it is "I have read this now", stamped from the database
    // clock with no request body at all.
    employerConversationResource
      .addResource('read')
      .addMethod('POST', lambdaIntegration(employerConversationsReadLambda.function), {
        authorizer: employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    const employerInboxResource = this.employerResource.addResource('inbox');
    employerInboxResource.addMethod('GET', lambdaIntegration(employerInboxLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/applicants — applicants across all of this employer's jobs
    const employerApplicantsResource = this.employerResource.addResource('applicants');
    employerApplicantsResource.addMethod('GET', lambdaIntegration(employerApplicantsOverviewLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/templates — list saved job templates for this employer
    // POST /employer/templates — save a new job template
    const employerTemplatesResource = this.employerResource.addResource('templates');
    employerTemplatesResource.addMethod('GET', lambdaIntegration(employerTemplatesListLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerTemplatesResource.addMethod('POST', lambdaIntegration(employerTemplatesSaveLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // DELETE /employer/templates/{templateId} — delete a job template the employer owns
    const employerTemplateResource = employerTemplatesResource.addResource('{templateId}');
    employerTemplateResource.addMethod('DELETE', lambdaIntegration(employerTemplatesDeleteLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET   /employer/tutorials — the employer's tutorial progress and guide settings
    // POST  /employer/tutorials — record how an auto-opened tutorial or the app tour was dismissed
    // PATCH /employer/tutorials — save the employer's guide settings
    const employerTutorialsResource = this.employerResource.addResource('tutorials');
    employerTutorialsResource.addMethod('GET', lambdaIntegration(tutorialProgressFunction.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerTutorialsResource.addMethod('POST', lambdaIntegration(tutorialProgressFunction.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerTutorialsResource.addMethod('PATCH', lambdaIntegration(tutorialProgressFunction.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // POST /auth/refresh — no auth (user's access token may be expired)
    // Path-only: nothing on /auth itself, only /refresh, /logout, /worker/signup.
    const authResource = addPathOnlyResource(this.api.root, 'auth');
    // Path-only: nothing on /auth/worker itself, only /auth/worker/signup.
    const authWorkerResource = addPathOnlyResource(authResource, 'worker');
    const authWorkerSignupResource = authWorkerResource.addResource('signup');
    authWorkerSignupResource.addMethod('POST', lambdaIntegration(workerWebSignupLambda.function));

    const refreshResource = authResource.addResource('refresh');
    refreshResource.addMethod('POST', lambdaIntegration(tokenRefreshLambda.function));

    // POST /auth/logout — no auth (user may have expired access token)
    const logoutResource = authResource.addResource('logout');
    logoutResource.addMethod('POST', lambdaIntegration(logoutLambda.function));

    // ── Centralized stage method-level throttles ──
    // All per-method throttle overrides live here so there is exactly one
    // CfnStage.MethodSettings array in the entire app: add a route to
    // `methodThrottles` below. Downstream stacks (Legal, Billing, Notifications,
    // Referrals, Reports) must NOT call addPropertyOverride('MethodSettings'),
    // which beats the property set here, and nothing may reassign
    // `methodSettings` without spreading the array already in it.
    //
    // The entries below name plain resource paths for readability; they are
    // encoded on the way out. CloudFormation documents a MethodSetting
    // ResourcePath as the path with every '/' turned into '~1', then one '/'
    // prefixed ('/legal/tos' -> '/~1legal~1tos'), the form CDK's own
    // `methodOptions` renders. A raw '/legal/tos' deploys without error but is stored under a
    // different stage key ('legal/tos/GET', not '~1legal~1tos/GET').
    //
    // They are APPENDED to the array CDK renders from `deployOptions`, never
    // written over it: that array opens with the '/*' + '*' default (API
    // Gateway applies stage throttles at the method level, so each method
    // gets its own 100 burst / 50 rps, not one shared stage total), and
    // replacing it, as an addPropertyOverride did until 2026-10, leaves every
    // other method on the account limit (10,000 rps).
    const deployment = this.api.latestDeployment;
    if (deployment) {
      const cfnStage = this.api.deploymentStage.node.defaultChild as apigateway.CfnStage;
      const encodeResourcePath = (path: string) => (path === '/' ? '/' : `/${path.replace(/\//g, '~1')}`);
      const methodThrottles: Array<{
        ResourcePath: string;
        HttpMethod: string;
        ThrottlingBurstLimit: number;
        ThrottlingRateLimit: number;
      }> = [
        // GET /legal/tos — public endpoint; keep throttle low to limit abuse cost
        {
          ResourcePath: '/legal/tos',
          HttpMethod: 'GET',
          ThrottlingBurstLimit: 20,
          ThrottlingRateLimit: 10,
        },
        // POST /auth/worker/signup — unauthenticated account creation; the
        // cheapest mass pre-registration vector without its own throttle
        // (2026-07-26 security review). Legitimate traffic is one call per
        // human signup.
        {
          ResourcePath: '/auth/worker/signup',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // POST /employer/billing/checkout — idempotent but involves Stripe API calls
        {
          ResourcePath: '/employer/billing/checkout',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // POST /employer/billing/portal — opens Stripe portal session
        {
          ResourcePath: '/employer/billing/portal',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // POST /employer/jobs/generate-description — T-A1: each call invokes
        // Bedrock (real cost) on top of the per-employer daily cap enforced
        // inside the Lambda itself; this stage-wide throttle is the outer
        // brake shared by every caller, same shape precedent as the billing
        // routes above.
        {
          ResourcePath: '/employer/jobs/generate-description',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 5,
          ThrottlingRateLimit: 2,
        },
        // POST /billing/webhook — inbound from Stripe; verification is cheap but
        // we defend against accidental firehoses
        {
          ResourcePath: '/billing/webhook',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 50,
          ThrottlingRateLimit: 20,
        },
        // GET /public/jobs — unauthenticated public job index (ReferralsStack,
        // SEO/search). Same conservative shape as /public/jobs/{code} and
        // /legal/tos: cheap to abuse, no other gate.
        {
          ResourcePath: '/public/jobs',
          HttpMethod: 'GET',
          ThrottlingBurstLimit: 20,
          ThrottlingRateLimit: 10,
        },
        // GET /public/jobs/{code} — unauthenticated public job read (ReferralsStack).
        // Same conservative shape as /legal/tos: cheap to abuse, no other gate.
        {
          ResourcePath: '/public/jobs/{code}',
          HttpMethod: 'GET',
          ThrottlingBurstLimit: 20,
          ThrottlingRateLimit: 10,
        },
        // POST /public/jobs/{code}/open — unauthenticated open-tracking beacon
        // (ReferralsStack). Same conservative shape as the GET reads above: it
        // never returns a 5xx and does one bounded write per call, but nothing
        // else bounds how many opens a caller can record.
        {
          ResourcePath: '/public/jobs/{code}/open',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 20,
          ThrottlingRateLimit: 10,
        },
        // GET /public/jobs/{code}/referrer — unauthenticated referrer-context
        // lookup (ReferralsStack). Same conservative shape as /public/jobs/{code}:
        // cheap read, no other gate, and the 404-collapse behavior already
        // prevents share-code enumeration, not this throttle.
        {
          ResourcePath: '/public/jobs/{code}/referrer',
          HttpMethod: 'GET',
          ThrottlingBurstLimit: 20,
          ThrottlingRateLimit: 10,
        },
        // POST /public/jobs/{code}/apply-intent — unauthenticated referral-token
        // mint. Nothing in public-job-apply-intent.ts bounds how many apply
        // tokens a caller can mint, so this is the only brake on the route.
        //
        // Be precise about what it is: MethodSettings throttles are STAGE-WIDE
        // across all callers, not per-caller (per-client would need a usage plan
        // plus API keys). So this caps total minting, and one abuser saturating
        // the limit degrades the route for real workers rather than being
        // isolated. Sizing it is a trade-off between abuse volume and denying
        // legitimate applicants, not a security boundary. Revisit with usage
        // plans if abuse becomes real.
        //
        // this API Gateway throttle is the ONLY abuse control on that route.
        // Kept tighter than the GET above because minting writes a DB row per call.
        {
          ResourcePath: '/public/jobs/{code}/apply-intent',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // POST /public/employer-digest/unsubscribe — UNAUTHENTICATED one-click
        // unsubscribe (NotificationsStack). The HMAC-signed token is the only
        // credential, so this stage throttle is the only volume brake on the
        // route, and it belongs in the tight unauthenticated-WRITE tier with
        // /auth/worker/signup and /public/jobs/{code}/apply-intent rather than
        // the looser read tier. Legitimate traffic is one call per emailed link.
        //
        // Burst 10 / rate 5 — byte-identical to the two siblings in this tier.
        // A HARVESTED VALID link replayed passes verifyUnsubscribeToken and
        // reaches pool.connect() on every request, so the sustained rate is a
        // real database-connection brake and must not be looser than theirs.
        {
          ResourcePath: '/public/employer-digest/unsubscribe',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // Report a problem (ReportsStack). The signed-out create is the
        // tightest tier: it writes a report and queues an email, and the edge
        // rate rule and the per-address counts in the database sit in front
        // of and behind it. The signed-out GET serves the pause switches the
        // form reads. The signed-in routes are per account in the database.
        {
          ResourcePath: '/public/reports/{action}',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 5,
          ThrottlingRateLimit: 2,
        },
        {
          ResourcePath: '/public/reports/{action}',
          HttpMethod: 'GET',
          ThrottlingBurstLimit: 20,
          ThrottlingRateLimit: 10,
        },
        {
          ResourcePath: '/reports/{action}',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // Team management (Phase 3, BillingStack's routes). The dispatcher's
        // POST covers every owner write (invite, resend, revoke, remove,
        // reassign) and start-my-own-company (POST membership): each one
        // takes the company lock, and invite/resend queue an email. Its GET
        // (team list, own membership) is left at the stage default.
        {
          ResourcePath: '/employer/team/{action}',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 5,
          ThrottlingRateLimit: 2,
        },
        // GET /employer/invites/{token} — UNAUTHENTICATED invite lookup, the
        // invite page's first read. The 43-character token is unguessable, so
        // this is a database-connection brake, not an enumeration defence:
        // every call reaches pool.connect() as jale_api_public.
        {
          ResourcePath: '/employer/invites/{token}',
          HttpMethod: 'GET',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // POST /employer/invites/{token} — the signed-in accept (company lock).
        {
          ResourcePath: '/employer/invites/{token}',
          HttpMethod: 'POST',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
        // T-B2: GET /pay-reference — dual-authenticated (worker+employer)
        // recommended-pay lookup. Modest throttle: read-only against a
        // small reference table, but reachable by any authenticated worker
        // or employer, so still worth capping rather than leaving unbounded.
        {
          ResourcePath: '/pay-reference',
          HttpMethod: 'GET',
          ThrottlingBurstLimit: 10,
          ThrottlingRateLimit: 5,
        },
      ];
      const cdkMethodSettings = cfnStage.methodSettings;
      if (!Array.isArray(cdkMethodSettings)) {
        throw new Error('ApiStack: expected CDK to render the stage MethodSettings from deployOptions');
      }
      cfnStage.methodSettings = [
        ...cdkMethodSettings,
        ...methodThrottles.map((setting) => ({
          resourcePath: encodeResourcePath(setting.ResourcePath),
          httpMethod: setting.HttpMethod,
          throttlingBurstLimit: setting.ThrottlingBurstLimit,
          throttlingRateLimit: setting.ThrottlingRateLimit,
        })),
      ];
    }

    // ── Outputs ──
    this.apiUrl = this.api.url;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'Jale API Gateway URL',
    });
  }
}
