import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { JaleCognitoPool } from '../constructs/cognito-pool';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface ApiStackProps extends cdk.StackProps {
  readonly workerPool: JaleCognitoPool;
  readonly employerPool: JaleCognitoPool;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly dbSecret: secretsmanager.ISecret;
  readonly candidateMaterializationQueue?: sqs.IQueue;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly apiUrl: string;
  public readonly dualAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  public readonly employerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  public readonly workerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const stageName = this.node.tryGetContext('environment') ?? 'dev';

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
        allowHeaders: ['Content-Type', 'Authorization'],
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
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
      },
    });
    this.api.addGatewayResponse('Default5xx', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'${allowedOrigin}'`,
        'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
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

    // Employer jobs update — employer auth, DB access
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
      },
    });
    props.dbSecret.grantRead(workerProfileUpdateLambda.function);

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

    // ── Routes ──

    // GET /health
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(healthLambda.function));

    // GET /worker/profile
    // PATCH /worker/profile
    const workerResource = this.api.root.addResource('worker');
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
    // GET /worker/jobs/{id} — job detail
    // POST /worker/jobs/{id}/apply — apply to a job
    const workerJobsResource = workerResource.addResource('jobs');
    workerJobsResource.addMethod('GET', new apigateway.LambdaIntegration(workerJobsListLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const workerJobResource = workerJobsResource.addResource('{id}');
    workerJobResource.addMethod('GET', new apigateway.LambdaIntegration(workerJobsDetailLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const workerJobApplyResource = workerJobResource.addResource('apply');
    workerJobApplyResource.addMethod('POST', new apigateway.LambdaIntegration(workerJobsApplyLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /worker/applications — list worker's own applications
    const workerApplicationsResource = workerResource.addResource('applications');
    workerApplicationsResource.addMethod('GET', new apigateway.LambdaIntegration(workerApplicationsListLambda.function), {
      authorizer: workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/profile
    const employerResource = this.api.root.addResource('employer');
    const employerProfileResource = employerResource.addResource('profile');
    employerProfileResource.addMethod('GET', new apigateway.LambdaIntegration(employerProfileLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // GET /employer/jobs — list all jobs for this employer
    // POST /employer/jobs — create a new job posting
    const employerJobsResource = employerResource.addResource('jobs');
    employerJobsResource.addMethod('GET', new apigateway.LambdaIntegration(employerJobsListLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    employerJobsResource.addMethod('POST', new apigateway.LambdaIntegration(employerJobsCreateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // PATCH /employer/jobs/{jobId} — toggle active/closed status
    // GET /employer/jobs/{jobId}/applicants — list applicants for a job
    const employerJobResource = employerJobsResource.addResource('{jobId}');
    employerJobResource.addMethod('PATCH', new apigateway.LambdaIntegration(employerJobsUpdateLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const employerJobApplicantsResource = employerJobResource.addResource('applicants');
    employerJobApplicantsResource.addMethod('GET', new apigateway.LambdaIntegration(employerJobApplicantsLambda.function), {
      authorizer: employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // POST /auth/refresh — no auth (user's access token may be expired)
    const authResource = this.api.root.addResource('auth');
    const refreshResource = authResource.addResource('refresh');
    refreshResource.addMethod('POST', new apigateway.LambdaIntegration(tokenRefreshLambda.function));

    // POST /auth/logout — no auth (user may have expired access token)
    const logoutResource = authResource.addResource('logout');
    logoutResource.addMethod('POST', new apigateway.LambdaIntegration(logoutLambda.function));

    // ── Outputs ──
    this.apiUrl = this.api.url;

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'Jale API Gateway URL',
    });
  }
}
