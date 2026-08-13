import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { JaleCognitoPool } from '../constructs/cognito-pool';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { normalizeWhatsappStatusCallbackUrl } from '../whatsapp-status-callback-url';

export interface ApiStackProps extends cdk.StackProps {
  readonly workerPool: JaleCognitoPool;
  readonly employerPool: JaleCognitoPool;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly dbSecret: secretsmanager.ISecret;
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
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
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
    // Reads migration 070's wage_references / city_cbsa_crosswalk tables
    // (T-B1); no REQUIRED_TOS_VERSION env var, since the handler mirrors
    // legal/accept-tos.ts's convention of not calling checkCompliance() for
    // this dual-auth route.
    const payReferenceLambda = new JaleLambdaFunction(this, 'PayReferenceLambda', {
      entry: path.join(__dirname, '../../lambda/api/pay-reference.ts'),
      description: 'Recommended-pay reference lookup endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(payReferenceLambda.function);

    // Worker profile — worker auth, DB access
    const workerProfileLambda = new JaleLambdaFunction(this, 'WorkerProfileLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-profile.ts'),
      description: 'Worker profile endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(workerProfileLambda.function);

    // Employer profile — employer auth, DB access
    const employerProfileLambda = new JaleLambdaFunction(this, 'EmployerProfileLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-profile.ts'),
      description: 'Employer profile endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerProfileLambda.function);

    // Employer jobs list — employer auth, DB access
    const employerJobsListLambda = new JaleLambdaFunction(this, 'EmployerJobsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-list.ts'),
      description: 'Employer jobs list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerJobsListLambda.function);

    // Employer jobs create — employer auth, DB access
    const employerJobsCreateLambda = new JaleLambdaFunction(this, 'EmployerJobsCreateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-create.ts'),
      description: 'Employer jobs create endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerJobsCreateLambda.function);

    // Employer job detail — employer auth, DB access
    const employerJobsDetailLambda = new JaleLambdaFunction(this, 'EmployerJobsDetailLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-detail.ts'),
      description: 'Employer job detail endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerJobsDetailLambda.function);

    const employerJobsUpdateLambda = new JaleLambdaFunction(this, 'EmployerJobsUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-update.ts'),
      description: 'Employer jobs update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerJobsUpdateLambda.function);

    const employerJobsDeleteLambda = new JaleLambdaFunction(this, 'EmployerJobsDeleteLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-jobs-delete.ts'),
      description: 'Employer jobs hard-delete endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerJobsDeleteLambda.function);

    // Employer job applicants — employer auth, DB access
    const employerJobApplicantsLambda = new JaleLambdaFunction(this, 'EmployerJobApplicantsLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-job-applicants.ts'),
      description: 'Employer job applicants endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerJobApplicantsLambda.function);

    // Employer application status update — employer auth, DB access
    const employerApplicationStatusUpdateLambda = new JaleLambdaFunction(this, 'EmployerApplicationStatusUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-application-status-update.ts'),
      description: 'Employer application status update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerApplicationStatusUpdateLambda.function);

    const employerConversationsListLambda = new JaleLambdaFunction(this, 'EmployerConversationsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-list.ts'),
      description: 'Employer conversations list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerConversationsListLambda.function);

    const employerConversationsDetailLambda = new JaleLambdaFunction(this, 'EmployerConversationsDetailLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-detail.ts'),
      description: 'Employer conversations detail endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerConversationsDetailLambda.function);

    const employerConversationsCreateLambda = new JaleLambdaFunction(this, 'EmployerConversationsCreateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-create.ts'),
      description: 'Employer conversations create endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        TWILIO_SECRET_ARN: twilioSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: whatsappStatusCallbackUrl,
      },
    });
    props.dbSecret.grantRead(employerConversationsCreateLambda.function);
    twilioSecret.grantRead(employerConversationsCreateLambda.function);

    const employerConversationsSendLambda = new JaleLambdaFunction(this, 'EmployerConversationsSendLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-send.ts'),
      description: 'Employer conversations send endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        TWILIO_SECRET_ARN: twilioSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        TWILIO_STATUS_CALLBACK_URL: whatsappStatusCallbackUrl,
      },
    });
    props.dbSecret.grantRead(employerConversationsSendLambda.function);
    twilioSecret.grantRead(employerConversationsSendLambda.function);

    const employerConversationsUpdateLambda = new JaleLambdaFunction(this, 'EmployerConversationsUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-conversations-update.ts'),
      description: 'Employer conversations update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerConversationsUpdateLambda.function);

    const employerInboxLambda = new JaleLambdaFunction(this, 'EmployerInboxLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-inbox.ts'),
      description: 'Employer inbox endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerInboxLambda.function);

    // Employer templates list — employer auth, DB access
    const employerTemplatesListLambda = new JaleLambdaFunction(this, 'EmployerTemplatesListLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-templates-list.ts'),
      description: 'Employer templates list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerTemplatesListLambda.function);

    // Employer templates save — employer auth, DB access
    const employerTemplatesSaveLambda = new JaleLambdaFunction(this, 'EmployerTemplatesSaveLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-templates-save.ts'),
      description: 'Employer templates save endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerTemplatesSaveLambda.function);

    // Employer templates delete — employer auth, DB access
    const employerTemplatesDeleteLambda = new JaleLambdaFunction(this, 'EmployerTemplatesDeleteLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-templates-delete.ts'),
      description: 'Employer templates delete endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(employerTemplatesDeleteLambda.function);

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
        DB_SECRET_ARN: props.dbSecret.secretArn,
        WORKER_POOL_ID: props.workerPool.userPoolId,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(workerWebSignupLambda.function);

    // Worker jobs list — worker auth, DB access
    const workerJobsListLambda = new JaleLambdaFunction(this, 'WorkerJobsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-jobs-list.ts'),
      description: 'Worker jobs list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(workerJobsListLambda.function);

    // Worker job detail — worker auth, DB access
    const workerJobsDetailLambda = new JaleLambdaFunction(this, 'WorkerJobsDetailLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-jobs-detail.ts'),
      description: 'Worker job detail endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(workerJobsDetailLambda.function);

    // Worker job apply — worker auth, DB access
    const workerJobsApplyLambda = new JaleLambdaFunction(this, 'WorkerJobsApplyLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-jobs-apply.ts'),
      description: 'Worker job apply endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(workerJobsApplyLambda.function);

    const employerJobCandidatesLambda = new JaleLambdaFunction(this, 'EmployerJobCandidatesLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-job-candidates.ts'),
      description: 'Employer job candidates endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        ...(props.employerCandidateRerankQueue
          ? { EMPLOYER_CANDIDATE_RERANK_QUEUE_URL: props.employerCandidateRerankQueue.queueUrl }
          : {}),
      },
      nodeModules: ['@aws-sdk/client-sqs'],
    });
    props.dbSecret.grantRead(employerJobCandidatesLambda.function);
    props.employerCandidateRerankQueue?.grantSendMessages(employerJobCandidatesLambda.function);

    // Worker applications list — worker auth, DB access
    const workerApplicationsListLambda = new JaleLambdaFunction(this, 'WorkerApplicationsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-applications-list.ts'),
      description: 'Worker applications list endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(workerApplicationsListLambda.function);

    // Worker profile update — worker auth, DB access
    const workerProfileUpdateLambda = new JaleLambdaFunction(this, 'WorkerProfileUpdateLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-profile-update.ts'),
      description: 'Worker profile update endpoint',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        ALIAS_GENERATOR_ARN: props.aliasGeneratorFn.functionArn,
      },
    });
    props.dbSecret.grantRead(workerProfileUpdateLambda.function);
    props.aliasGeneratorFn.grantInvoke(workerProfileUpdateLambda.function);

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
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(healthLambda.function));

    // GET /pay-reference — recommended-pay lookup (T-B2). Dual-authenticated:
    // both workers and employers call this (the only other dualAuthorizer
    // consumer is LegalStack's POST /legal/accept). Public BLS statistics
    // only, no per-user data, so RLS context is set for standard transaction
    // hygiene but is not load-bearing here (wage_references /
    // city_cbsa_crosswalk grant jale_admin a flat read-all policy).
    const payReferenceResource = this.api.root.addResource('pay-reference');
    payReferenceResource.addMethod('GET', new apigateway.LambdaIntegration(payReferenceLambda.function), {
      authorizer: this.dualAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /worker/profile
    // PATCH /worker/profile
    // Exported as public readonly so ReferralsStack (and other downstream
    // stacks) can hang routes off /worker.
    this.workerResource = this.api.root.addResource('worker');
    const workerResource = this.workerResource;
    const workerProfileResource = workerResource.addResource('profile');
    workerProfileResource.addMethod('GET', new apigateway.LambdaIntegration(workerProfileLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    workerProfileResource.addMethod('PATCH', new apigateway.LambdaIntegration(workerProfileUpdateLambda.function), {
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
    workerJobsResource.addMethod('GET', new apigateway.LambdaIntegration(workerJobsListLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    if (!workerJobsRenamePhase1) {
      this.workerJobResource = workerJobsResource.addResource('{jobId}');
      const workerJobResource = this.workerJobResource;
      workerJobResource.addMethod('GET', new apigateway.LambdaIntegration(workerJobsDetailLambda.function), {
        authorizer: workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
      const workerJobApplyResource = workerJobResource.addResource('apply');
      workerJobApplyResource.addMethod('POST', new apigateway.LambdaIntegration(workerJobsApplyLambda.function), {
        authorizer: workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
    }

    // GET /worker/applications — list worker's own applications
    const workerApplicationsResource = workerResource.addResource('applications');
    workerApplicationsResource.addMethod('GET', new apigateway.LambdaIntegration(workerApplicationsListLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/profile
    // PATCH /employer/profile
    // Exported as public readonly so BillingStack can hang /employer/billing routes off it.
    this.employerResource = this.api.root.addResource('employer');
    const employerProfileResource = this.employerResource.addResource('profile');
    employerProfileResource.addMethod('GET', new apigateway.LambdaIntegration(employerProfileLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerProfileResource.addMethod('PATCH', new apigateway.LambdaIntegration(employerProfileLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/jobs — list all jobs for this employer
    // POST /employer/jobs — create a new job posting
    const employerJobsResource = this.employerResource.addResource('jobs');
    employerJobsResource.addMethod('GET', new apigateway.LambdaIntegration(employerJobsListLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerJobsResource.addMethod('POST', new apigateway.LambdaIntegration(employerJobsCreateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/jobs/{jobId} — job posting detail
    // PATCH /employer/jobs/{jobId} — toggle active/closed status
    // GET /employer/jobs/{jobId}/applicants — list applicants for a job
    this.employerJobResource = employerJobsResource.addResource('{jobId}');
    const employerJobResource = this.employerJobResource;
    employerJobResource.addMethod('GET', new apigateway.LambdaIntegration(employerJobsDetailLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerJobResource.addMethod('PATCH', new apigateway.LambdaIntegration(employerJobsUpdateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    // DELETE /employer/jobs/{jobId} — permanently delete a job the employer owns
    employerJobResource.addMethod('DELETE', new apigateway.LambdaIntegration(employerJobsDeleteLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const employerJobApplicantsResource = employerJobResource.addResource('applicants');
    employerJobApplicantsResource.addMethod('GET', new apigateway.LambdaIntegration(employerJobApplicantsLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const employerJobApplicantResource = employerJobApplicantsResource.addResource('{workerId}');
    employerJobApplicantResource.addMethod('PATCH', new apigateway.LambdaIntegration(employerApplicationStatusUpdateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const employerJobCandidatesResource = employerJobResource.addResource('candidates');
    employerJobCandidatesResource.addMethod('GET', new apigateway.LambdaIntegration(employerJobCandidatesLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const employerConversationsResource = this.employerResource.addResource('conversations');
    employerConversationsResource.addMethod('GET', new apigateway.LambdaIntegration(employerConversationsListLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerConversationsResource.addMethod('POST', new apigateway.LambdaIntegration(employerConversationsCreateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const employerConversationResource = employerConversationsResource.addResource('{conversationId}');
    employerConversationResource.addMethod('GET', new apigateway.LambdaIntegration(employerConversationsDetailLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerConversationResource.addMethod('PATCH', new apigateway.LambdaIntegration(employerConversationsUpdateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerConversationResource
      .addResource('messages')
      .addMethod('POST', new apigateway.LambdaIntegration(employerConversationsSendLambda.function), {
        authorizer: employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    const employerInboxResource = this.employerResource.addResource('inbox');
    employerInboxResource.addMethod('GET', new apigateway.LambdaIntegration(employerInboxLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/templates — list saved job templates for this employer
    // POST /employer/templates — save a new job template
    const employerTemplatesResource = this.employerResource.addResource('templates');
    employerTemplatesResource.addMethod('GET', new apigateway.LambdaIntegration(employerTemplatesListLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerTemplatesResource.addMethod('POST', new apigateway.LambdaIntegration(employerTemplatesSaveLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // DELETE /employer/templates/{templateId} — delete a job template the employer owns
    const employerTemplateResource = employerTemplatesResource.addResource('{templateId}');
    employerTemplateResource.addMethod('DELETE', new apigateway.LambdaIntegration(employerTemplatesDeleteLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // POST /auth/refresh — no auth (user's access token may be expired)
    const authResource = this.api.root.addResource('auth');
    const authWorkerResource = authResource.addResource('worker');
    const authWorkerSignupResource = authWorkerResource.addResource('signup');
    authWorkerSignupResource.addMethod('POST', new apigateway.LambdaIntegration(workerWebSignupLambda.function));

    const refreshResource = authResource.addResource('refresh');
    refreshResource.addMethod('POST', new apigateway.LambdaIntegration(tokenRefreshLambda.function));

    // POST /auth/logout — no auth (user may have expired access token)
    const logoutResource = authResource.addResource('logout');
    logoutResource.addMethod('POST', new apigateway.LambdaIntegration(logoutLambda.function));

    // ── Centralized stage method-level throttles ──
    // All per-method throttle overrides live here so there is exactly one
    // CfnStage.MethodSettings array in the entire app.  Downstream stacks
    // (LegalStack, BillingStack) must NOT call addPropertyOverride('MethodSettings').
    const deployment = this.api.latestDeployment;
    if (deployment) {
      const cfnStage = this.api.deploymentStage.node.defaultChild as apigateway.CfnStage;
      cfnStage.addPropertyOverride('MethodSettings', [
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
      ]);
    }

    // ── Outputs ──
    this.apiUrl = this.api.url;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'Jale API Gateway URL',
    });
  }
}
