import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import { jaleAlarm } from '../constructs/jale-alarm';

export interface FrontendStackProps extends cdk.StackProps {
  /** API Gateway origin domain, without protocol or stage path. */
  readonly apiOriginDomainName: string;
  /** API Gateway stage path used as CloudFront originPath, without leading slash. */
  readonly apiStageName: string;
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
    const wwwDomainName = `www.${props.domainName}`;

    // ── ACM certificate (us-east-1, validated by Route 53 DNS) ──────
    const certificate = new acm.Certificate(this, 'FrontendCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [wwwDomainName],
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

    // ── CloudFront → Function URL Origin Access Control ─────────────
    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'NextjsOac', {
      originAccessControlName: 'jale-nextjs-oac',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // ── CloudFront behaviors ────────────────────────────────────────
    const lambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, {
      originAccessControl: oac,
    });

    const nextjsOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'NextjsOriginRequestPolicy',
      {
        originRequestPolicyName: 'jale-nextjs-origin-request',
        comment: 'Forward SSR request data to Next.js without overriding OAC auth.',
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList(
          'host',
          'authorization',
        ),
      },
    );

    // Viewer-request function for the Next.js (default + static) behaviors. It does
    // two things, in order:
    //   1. Canonical host redirect: www.<domain> → <apex>. The apex is the ONLY
    //      origin the API's CORS config allows, and NEXT_PUBLIC_API_BASE_URL is
    //      baked to the apex (`https://<apex>/api`). If the app is served from
    //      www it stays functional to look at but every API call is cross-origin
    //      (www → apex) and blocked by CORS, so the app shows a generic error.
    //      Redirecting to the apex keeps a single origin end-to-end.
    //   2. Strip the viewer Authorization header before OAC SigV4 signing (apex
    //      requests only; www requests never reach this point).
    const stripFrontendAuthorization = new cloudfront.Function(
      this,
      'StripFrontendAuthorizationFunction',
      {
        functionName: 'jale-strip-frontend-authorization',
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var hostHeader = request.headers.host;
  var host = hostHeader ? hostHeader.value : '';

  if (host === '${wwwDomainName}') {
    var qs = request.querystring;
    var pairs = [];
    for (var key in qs) {
      var entry = qs[key];
      if (entry.multiValue) {
        for (var i = 0; i < entry.multiValue.length; i++) {
          pairs.push(key + '=' + entry.multiValue[i].value);
        }
      } else if (entry.value !== '') {
        pairs.push(key + '=' + entry.value);
      } else {
        pairs.push(key);
      }
    }
    var query = pairs.length > 0 ? '?' + pairs.join('&') : '';
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://${props.domainName}' + request.uri + query },
        'cache-control': { value: 'max-age=3600' }
      }
    };
  }

  delete request.headers.authorization;
  return request;
}
`),
      },
    );

    const rewriteApiPrefix = new cloudfront.Function(
      this,
      'RewriteApiPrefixFunction',
      {
        functionName: 'jale-rewrite-api-prefix',
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace(/^\\/api(?=\\/|$)/, '') || '/';
  return request;
}
`),
      },
    );

    const rewriteSurveyPrefix = new cloudfront.Function(
      this,
      'RewriteSurveyPrefixFunction',
      {
        functionName: 'jale-rewrite-survey-prefix',
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace(/^\\/survey(?=\\/|$)/, '') || '/';
  return request;
}
`),
      },
    );

    // Public SEO surfaces (job pages + crawler files) are server-rendered but not
    // user-specific — short-TTL edge caching is safe and takes load off the Lambda.
    // Query strings are excluded from the cache key so that `?r=` share codes on
    // job links (referral attribution) never fragment the cache into one entry
    // per share code.
    //
    // maxTtl is capped at 60s (not 300s) so that unpublishing a job (toggling
    // public_listing_enabled off, or pausing/closing it) cannot leave a stale
    // "still public" edge response served for up to 5 minutes after the
    // employer acted. Worst case now: an edge cache entry can be up to 60s
    // stale, plus the underlying Next.js ISR page can itself be up to 60s
    // stale, for a combined worst-case staleness of ~2 minutes -- an
    // acceptable trade against the extra Lambda load from an even shorter TTL.
    // minTtl is 60s ON PURPOSE, not 0: the Next.js origin serves these routes
    // with `Cache-Control: private, no-cache, no-store` at runtime (next-intl's
    // request-scoped locale resolution keeps the render dynamic even though the
    // route declares revalidate=60), and with a zero minimum TTL CloudFront
    // honors that header and never caches. Per CloudFront's TTL rules, a
    // non-zero minimum TTL caches the response for minTtl even when the origin
    // says no-cache/no-store -- which is exactly the designed 60s edge cache.
    const publicPagesCachePolicy = new cloudfront.CachePolicy(this, 'PublicPagesShortTtl', {
      comment:
        'Short-TTL cache for public job pages + SEO files; query strings excluded so ?r= share codes never fragment the cache',
      minTtl: cdk.Duration.seconds(60),
      defaultTtl: cdk.Duration.seconds(60),
      maxTtl: cdk.Duration.seconds(60),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    // Brand assets referenced from transactional emails (Cognito code email,
    // employer digest) and the site itself. Next.js serves public/ with
    // `Cache-Control: public, max-age=0`, so a managed policy with minTtl=1s
    // would cache for one second (see the minTtl note on publicPagesCachePolicy).
    // Pin a one-day edge TTL; email assets are versioned by filename.
    const brandAssetsCachePolicy = new cloudfront.CachePolicy(this, 'BrandAssetsCache', {
      comment: 'One-day edge cache for /brand/* assets; origin max-age=0 cannot defeat it',
      minTtl: cdk.Duration.days(1),
      defaultTtl: cdk.Duration.days(1),
      maxTtl: cdk.Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
      // Backend API → existing API Gateway
      '/api/*': {
        origin: new origins.HttpOrigin(props.apiOriginDomainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          originPath: `/${props.apiStageName}`,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        functionAssociations: [
          {
            function: rewriteApiPrefix,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      // Next.js static assets are content-hashed → safe to cache aggressively
      '/_next/static/*': {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          {
            function: stripFrontendAuthorization,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      // Brand assets (email wordmark, logos) served from the Next.js public/
      // directory. Emails are opened long after a deploy and can be opened many
      // times, so these must never fall through to the default CACHING_DISABLED
      // behavior and invoke the Lambda on every open.
      '/brand/*': {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: brandAssetsCachePolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
        functionAssociations: [
          {
            function: stripFrontendAuthorization,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    };

    // Public job pages + SEO files: server-rendered from the same Lambda as the
    // default behavior, but safe to cache briefly since they carry no per-viewer
    // content. Query strings are excluded from the cache policy (see
    // publicPagesCachePolicy) so `?r=` share codes don't fragment the cache.
    for (const publicPagePattern of [
      '/en/j/*',
      '/es/j/*',
      '/sitemap.xml',
      '/feed.xml',
      '/robots.txt',
    ]) {
      additionalBehaviors[publicPagePattern] = {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: publicPagesCachePolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
        functionAssociations: [
          {
            function: stripFrontendAuthorization,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      };
    }

    // /survey/* → Amplify (only if origin domain provided)
    if (props.surveyOriginDomain) {
      const surveyOrigin = new origins.HttpOrigin(props.surveyOriginDomain, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      });
      const surveyBehavior = (
        stripSurveyPrefix: boolean,
      ): cloudfront.BehaviorOptions => ({
        origin: surveyOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        ...(stripSurveyPrefix
          ? {
              functionAssociations: [
                {
                  function: rewriteSurveyPrefix,
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                },
              ],
            }
          : {}),
      });

      additionalBehaviors['/survey'] = surveyBehavior(true);
      additionalBehaviors['/survey/*'] = surveyBehavior(true);
      additionalBehaviors['/assets/*'] = surveyBehavior(false);
      additionalBehaviors['/JaleLogo.png'] = surveyBehavior(false);
      additionalBehaviors['/jale-logo-light.png'] = surveyBehavior(false);
      additionalBehaviors['/jale-logo-dark.png'] = surveyBehavior(false);
    }

    // ── CloudFront distribution ─────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: 'Jale frontend (Next.js Lambda) + survey + API routing',
      domainNames: [props.domainName, wwwDomainName],
      certificate,
      defaultBehavior: {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // HTML is server-rendered with potentially user-specific content; don't cache
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: nextjsOriginRequestPolicy,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        functionAssociations: [
          {
            function: stripFrontendAuthorization,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors,
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // PRICE_CLASS_100 = US/Canada/Europe edge locations only (cheaper).
      // Bump to PRICE_CLASS_ALL when launching to LATAM at scale.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Lambda Function URLs with AWS_IAM auth require both actions. CloudFront
    // signs origin requests through OAC; these permissions scope that signer to
    // this distribution and only to Function URL invocations.
    this.nextjsFunction.addPermission('AllowCloudFrontInvokeFunctionUrl', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: this.distribution.distributionArn,
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    this.nextjsFunction.addPermission('AllowCloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: this.distribution.distributionArn,
      invokedViaFunctionUrl: true,
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
    new route53.ARecord(this, 'FrontendWwwARecord', {
      zone: hostedZone,
      recordName: wwwDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(this.distribution),
      ),
    });
    new route53.AaaaRecord(this, 'FrontendWwwAaaaRecord', {
      zone: hostedZone,
      recordName: wwwDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.CloudFrontTarget(this.distribution),
      ),
    });

    // ── SES send health, us-east-1 ──────────────────────────────────
    // NOT about the frontend. This stack is here only because it is the one
    // stack Jale deploys to us-east-1, and `AWS/SES` metrics are REGIONAL.
    //
    // NotificationsStack carries the same two alarms for us-east-2, where the
    // employer digest and the billing outbox send from. Cognito's verification
    // and forgot-password emails go out through SES in us-east-1
    // (`sesEmailRegion`, auth-stack.ts), and an alarm in us-east-2 cannot see a
    // single one of them — so a us-east-1 reputation problem would take out
    // every signup confirmation and password reset in the product while every
    // dashboard stayed green. That is the 2026-08-28 failure (6 of 6 sends
    // bounced, nothing reported it) with the blast radius pointed at the login
    // door instead of the digest.
    //
    // NO ALARM ACTION: this stack takes no alarm-topic prop and the shared ops
    // topic lives in us-east-2, where a CloudWatch alarm in us-east-1 cannot
    // publish. Console-visible and dashboard-able is strictly better than
    // absent, and it is the same trade auth-stack.ts's CustomMessage error
    // alarms already make. Wiring a us-east-1 SNS topic (or a cross-region
    // forwarder) is the follow-up, not this change.
    //
    // No dimensions on either metric — `AWS/SES` publishes Bounce and
    // Reputation.* at the account level, and any dimension yields a metric that
    // never reports, i.e. an alarm that cannot fire.
    jaleAlarm(this, 'SesBounceCountUsEast1Alarm', {
      alarmName: 'SesBounceCountUsEast1',
      alarmDescription:
        'SES in us-east-1 reported a bounce in the last hour. This is the region Cognito sends '
        + 'verification and forgot-password emails from, so bounces here are signups and password '
        + 'resets that silently failed.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Bounce',
        period: cdk.Duration.hours(1),
        statistic: 'Sum',
      }),
      threshold: 1,
    });

    jaleAlarm(this, 'SesReputationBounceRateUsEast1Alarm', {
      alarmName: 'SesReputationBounceRateUsEast1',
      alarmDescription:
        'SES bounce RATE in us-east-1 is at or above 5%. AWS reviews sending at 5% and can suspend '
        + 'it at 10% — which would stop every Cognito verification and password-reset email.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Reputation.BounceRate',
        period: cdk.Duration.hours(1),
        // Maximum, not Average: SES already averages this over a rolling
        // window, and averaging it again hides the peak.
        statistic: 'Maximum',
      }),
      threshold: 0.05,
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
