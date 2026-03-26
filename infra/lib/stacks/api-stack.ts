import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly apiUrl: string;
  public readonly dualAuthorizer: apigateway.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'http://localhost:3000';
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';

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
        stageName: 'dev',
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
    const workerAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'WorkerAuthorizer', {
      cognitoUserPools: [props.workerPool.userPool],
      authorizerName: 'worker-authorizer',
    });

    const employerAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'EmployerAuthorizer', {
      cognitoUserPools: [props.employerPool.userPool],
      authorizerName: 'employer-authorizer',
    });

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

    // ── Routes ──

    // GET /health
    const healthResource = this.api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(healthLambda.function));

    // GET /worker/profile
    const workerResource = this.api.root.addResource('worker');
    const workerProfileResource = workerResource.addResource('profile');
    workerProfileResource.addMethod('GET', new apigateway.LambdaIntegration(workerProfileLambda.function), {
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
