import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  /** Existing API Gateway REST API (backend routes) */
  readonly api: apigateway.RestApi;
  /** Custom domain (e.g., 'jaleapp.ai') */
  readonly domainName: string;
  /** Route 53 hosted zone ID for domainName */
  readonly hostedZoneId: string;
  /**
   * Amplify CloudFront-style domain serving the survey app at /survey/*
   * (e.g., 'd1a2b3c4.amplifyapp.com'). If omitted, no /survey/* behavior is added.
   */
  readonly surveyOriginDomain?: string;
  /**
   * Cognito Worker pool ID (NEXT_PUBLIC_*; baked into JS bundle at build time).
   * Read from CDK context or env var if not provided.
   */
  readonly workerPoolId: string;
  /** Cognito Worker app client ID. */
  readonly workerClientId: string;
  /** Cognito Employer pool ID. */
  readonly employerPoolId: string;
  /** Cognito Employer app client ID. */
  readonly employerClientId: string;
}

/**
 * FrontendStack — Next.js server in Lambda container, fronted by CloudFront.
 *
 * Architecture:
 *   - Lambda (DockerImageFunction) runs Next.js standalone server
 *   - Function URL exposes the Lambda; locked down with AWS_IAM + CloudFront OAC
 *   - CloudFront distribution fronts everything with three behaviors:
 *       /api/*    → API Gateway (existing backend)
 *       /survey/* → Amplify (existing survey app, optional)
 *       /*        → Lambda Function URL (Next.js server)
 *   - Route 53 A + AAAA aliases point jaleapp.ai → CloudFront
 *
 * EC2 / ECS migration path:
 *   When ready for production, replace the Lambda + Function URL pieces with
 *   ECS Fargate + ALB. The Dockerfile, ECR image, CloudFront, ACM cert,
 *   Route 53 records, and /api/* + /survey/* behaviors all stay the same —
 *   only the default behavior origin changes from FunctionUrlOrigin to
 *   LoadBalancerV2Origin. See docs/FRONTEND-EC2-MIGRATION.md.
 *
 * NOTE: this stack must be deployed in us-east-1 because CloudFront ACM
 * certificates must live in us-east-1.
 */
export class FrontendStack extends cdk.Stack {
  public readonly nextjsFunction: lambda.DockerImageFunction;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // ── Hosted zone (existing) ──────────────────────────────────────
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });

    // ── ACM certificate (us-east-1, validated by Route 53 DNS) ──────
    const certificate = new acm.Certificate(this, 'FrontendCertificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // ── Lambda log group (explicit, replaces deprecated logRetention) ──
    const nextjsLogGroup = new logs.LogGroup(this, 'NextjsFunctionLogGroup', {
      logGroupName: '/aws/lambda/jale-frontend-nextjs',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda (Next.js server in container image) ──────────────────
    // CDK builds frontend/Dockerfile, pushes to ECR, and deploys the Lambda.
    // Public Cognito + API config must be passed at build time (NEXT_PUBLIC_*
    // gets inlined into the client JS bundle).
    const frontendDir = path.resolve(__dirname, '..', '..', '..', 'frontend');
    this.nextjsFunction = new lambda.DockerImageFunction(this, 'NextjsFunction', {
      functionName: 'jale-frontend-nextjs',
      code: lambda.DockerImageCode.fromImageAsset(frontendDir, {
        platform: Platform.LINUX_AMD64,
        buildArgs: {
          NEXT_PUBLIC_WORKER_POOL_ID: props.workerPoolId,
          NEXT_PUBLIC_WORKER_CLIENT_ID: props.workerClientId,
          NEXT_PUBLIC_EMPLOYER_POOL_ID: props.employerPoolId,
          NEXT_PUBLIC_EMPLOYER_CLIENT_ID: props.employerClientId,
          NEXT_PUBLIC_API_BASE_URL: `https://${props.domainName}/api`,
        },
      }),
      memorySize: 1024, // Next.js needs >512 MB; 1024 keeps cold starts reasonable
      timeout: cdk.Duration.seconds(30),
      architecture: lambda.Architecture.X86_64,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: nextjsLogGroup,
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        // AWS Lambda Web Adapter config
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/extensions/lambda-adapter',
        AWS_LWA_INVOKE_MODE: 'response_stream',
        // Server-side runtime fallback (NEXT_PUBLIC_* are already inlined at build time)
        NEXT_PUBLIC_API_BASE_URL: `https://${props.domainName}/api`,
      },
    });

    // ── Function URL (private; only CloudFront can invoke) ──────────
    const functionUrl = this.nextjsFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // Allow CloudFront (signed by OAC) to invoke the Function URL
    this.nextjsFunction.addPermission('AllowCloudFrontInvoke', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/*`,
    });

    // ── CloudFront → Function URL Origin Access Control ─────────────
    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'NextjsOac', {
      originAccessControlName: 'jale-nextjs-oac',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // ── CloudFront behaviors ────────────────────────────────────────
    const lambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, {
      originAccessControl: oac,
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
      // Backend API → existing API Gateway
      '/api/*': {
        origin: new origins.RestApiOrigin(props.api),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      // Next.js static assets are content-hashed → safe to cache aggressively
      '/_next/static/*': {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
    };

    // /survey/* → Amplify (only if origin domain provided)
    if (props.surveyOriginDomain) {
      additionalBehaviors['/survey/*'] = {
        origin: new origins.HttpOrigin(props.surveyOriginDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      };
    }

    // ── CloudFront distribution ─────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: 'Jale frontend (Next.js Lambda) + survey + API routing',
      domainNames: [props.domainName],
      certificate,
      defaultBehavior: {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // HTML is server-rendered with potentially user-specific content; don't cache
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      additionalBehaviors,
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // PRICE_CLASS_100 = US/Canada/Europe edge locations only (cheaper).
      // Bump to PRICE_CLASS_ALL when launching to LATAM at scale.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // ── Route 53 A + AAAA aliases ───────────────────────────────────
    new route53.ARecord(this, 'FrontendARecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(this.distribution),
      ),
    });
    new route53.AaaaRecord(this, 'FrontendAaaaRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(this.distribution),
      ),
    });

    // ── Outputs ─────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID (for cache invalidation)',
    });
    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront default domain (Route 53 alias points here)',
    });
    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.nextjsFunction.functionName,
      description: 'Lambda function name (for log tailing)',
    });
    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: functionUrl.url,
      description: 'Function URL (private; only CloudFront can invoke)',
    });
    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${props.domainName}`,
      description: 'Public frontend URL',
    });
  }
}
