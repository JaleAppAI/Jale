import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

export interface AdminStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly hostedZoneId: string;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  /**
   * Dedicated jale_admin_console role secret (NOT the shared jale_admin
   * secret). The internet-facing admin Lambda runs as a least-privilege
   * role with column-scoped cross-user read of `users` (migration 025).
   */
  readonly adminDbSecret: secretsmanager.ISecret;
}

export class AdminStack extends cdk.Stack {
  public readonly adminPool: cognito.UserPool;
  public readonly adminClient: cognito.UserPoolClient;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });
    const adminDomain = `admin.${props.domainName}`;

    const certificate = new acm.Certificate(this, 'AdminCertificate', {
      domainName: adminDomain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    this.adminPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'jale-admin-pool',
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.adminClient = this.adminPool.addClient('AdminUserPoolClient', {
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    new cognito.CfnUserPoolGroup(this, 'AdminReadonlyGroup', {
      userPoolId: this.adminPool.userPoolId,
      groupName: 'admin_readonly',
      description: 'Read-only admin support staff',
      precedence: 3,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminOpsGroup', {
      userPoolId: this.adminPool.userPoolId,
      groupName: 'admin_ops',
      description: 'Operators who can manage support cases and verifications',
      precedence: 2,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminSuperadminGroup', {
      userPoolId: this.adminPool.userPoolId,
      groupName: 'admin_superadmin',
      description: 'Super-admin role for the smallest internal set',
      precedence: 1,
    });

    const adminLogGroup = new logs.LogGroup(this, 'AdminNextLogGroup', {
      logGroupName: '/aws/lambda/jale-admin-nextjs',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const adminDir = path.resolve(__dirname, '..', '..', '..', 'admin');
    const adminFunction = new lambda.DockerImageFunction(this, 'AdminNextjsFunction', {
      functionName: 'jale-admin-nextjs',
      code: lambda.DockerImageCode.fromImageAsset(adminDir, {
        platform: Platform.LINUX_AMD64,
      }),
      description: 'Jale admin Next.js server',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      architecture: lambda.Architecture.X86_64,
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      securityGroups: [props.lambdaSg],
      logGroup: adminLogGroup,
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/extensions/lambda-adapter',
        AWS_LWA_INVOKE_MODE: 'response_stream',
        DB_SECRET_ARN: props.adminDbSecret.secretArn,
        NEXT_PUBLIC_ADMIN_USER_POOL_ID: this.adminPool.userPoolId,
        NEXT_PUBLIC_ADMIN_CLIENT_ID: this.adminClient.userPoolClientId,
        NEXT_PUBLIC_ADMIN_REGION: cdk.Stack.of(this).region,
        NEXT_PUBLIC_ADMIN_HOSTED_DOMAIN: adminDomain,
      },
    });

    props.adminDbSecret.grantRead(adminFunction);

    const functionUrl = adminFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'AdminOac', {
      originAccessControlName: 'jale-admin-oac',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    const lambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, {
      originAccessControl: oac,
    });

    const stripAuthorization = new cloudfront.Function(this, 'StripAdminAuthorization', {
      functionName: 'jale-strip-admin-authorization',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  delete request.headers.authorization;
  return request;
}
`),
    });

    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'AdminOriginRequestPolicy', {
      originRequestPolicyName: 'jale-admin-origin-request',
      comment: 'Forward SSR request data to the admin app without viewer auth headers.',
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList('host', 'authorization'),
    });

    this.distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      defaultBehavior: {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        functionAssociations: [
          {
            function: stripAuthorization,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/_next/static/*': {
          origin: lambdaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          functionAssociations: [
            {
              function: stripAuthorization,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      domainNames: [adminDomain],
      certificate,
      enableIpv6: true,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    new route53.ARecord(this, 'AdminAliasRecordA', {
      zone: hostedZone,
      recordName: adminDomain,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(this.distribution)),
    });
    new route53.AaaaRecord(this, 'AdminAliasRecordAAAA', {
      zone: hostedZone,
      recordName: adminDomain,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(this.distribution)),
    });

    new cdk.CfnOutput(this, 'AdminUrl', {
      value: `https://${adminDomain}`,
    });
    new cdk.CfnOutput(this, 'AdminUserPoolId', {
      value: this.adminPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'AdminUserPoolClientId', {
      value: this.adminClient.userPoolClientId,
    });
  }
}
