import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { FrontendStack } from '../../../lib/stacks/frontend-stack';
import { flatten } from './audit-template-helpers';
import { BOUNCE_SHARE, BOUNCE_SHARE_EXPRESSION, sesBounceAlarmBreaches } from '../../../lib/constructs/ses-bounce-alarm';

// CDK builds the Docker image during synth (DockerImageFunction.fromImageAsset).
// Skip this suite in environments without Docker (set SKIP_DOCKER_TESTS=1).
const describeIfDocker = process.env.SKIP_DOCKER_TESTS ? describe.skip : describe;

/** The admin console's distribution, as the composition passes its id. */
const ADMIN_DISTRIBUTION_ID = 'EDFDVBD6EXAMPLE';

/**
 * The Docker build args of the stack's one container image, from the asset
 * manifest the synth writes (the template only carries the image digest).
 */
function imageBuildArgs(app: cdk.App, stack: cdk.Stack): Record<string, string> {
  const assembly = app.synth();
  const manifestArtifact = assembly.artifacts.find((artifact) => artifact instanceof cxapi.AssetManifestArtifact
    && artifact.id === `${stack.artifactId}.assets`) as cxapi.AssetManifestArtifact | undefined;
  expect(manifestArtifact).toBeDefined();
  const manifest = JSON.parse(fs.readFileSync(manifestArtifact!.file, 'utf8'));
  const images = Object.values(manifest.dockerImages ?? {}) as Array<{ source: { dockerBuildArgs?: Record<string, string> } }>;
  expect(images).toHaveLength(1);
  return images[0].source.dockerBuildArgs ?? {};
}

describeIfDocker('FrontendStack (Lambda + CloudFront)', () => {
  let template: Template;
  let buildArgs: Record<string, string>;

  beforeAll(() => {
    const app = new cdk.App();

    const props = {
      env: { account: '111111111111', region: 'us-east-1' },
      apiOriginDomainName: 'abc123.execute-api.us-east-2.amazonaws.com',
      apiStageName: 'production',
      domainName: 'example.com',
      hostedZoneId: 'Z1234567890ABC',
      surveyOriginDomain: 'd1a2b3c4.amplifyapp.com',
      workerPoolId: 'us-east-1_TEST',
      workerClientId: 'test-worker-client',
      employerPoolId: 'us-east-1_EMPL',
      employerClientId: 'test-employer-client',
      whatsappBusinessNumber: '15551234567',
      adminDistributionId: ADMIN_DISTRIBUTION_ID,
      teamManagementEnabled: false,
    };
    const stack = new FrontendStack(app, 'TestFrontendStack', props);

    template = Template.fromStack(stack);
    buildArgs = imageBuildArgs(app, stack);
  });

  test('passes NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED as a build arg', () => {
    expect(buildArgs).toEqual({
      NEXT_PUBLIC_WORKER_POOL_ID: 'us-east-1_TEST',
      NEXT_PUBLIC_WORKER_CLIENT_ID: 'test-worker-client',
      NEXT_PUBLIC_EMPLOYER_POOL_ID: 'us-east-1_EMPL',
      NEXT_PUBLIC_EMPLOYER_CLIENT_ID: 'test-employer-client',
      NEXT_PUBLIC_API_BASE_URL: 'https://example.com/api',
      // Off: the frontend makes no membership call and shows Phase 2's nav.
      NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED: 'false',
    });
  });

  test('the Dockerfile declares the build arg and exports it to the Next.js build', () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../../../frontend/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED$/m);
    expect(dockerfile).toMatch(/^ENV NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED=\$NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED$/m);
  });

  test('creates a container Lambda function', () => {
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        PackageType: 'Image',
        MemorySize: 1024,
        Timeout: 30,
      }),
    );
  });

  test('Lambda environment carries WHATSAPP_BUSINESS_NUMBER for the /whatsapp redirect route', () => {
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            WHATSAPP_BUSINESS_NUMBER: '15551234567',
          }),
        }),
      }),
    );
  });

  test('Lambda has Function URL with AWS_IAM auth and response streaming', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
      InvokeMode: 'RESPONSE_STREAM',
    });
  });

  test('grants CloudFront permission to invoke the Function URL', () => {
    template.hasResourceProperties(
      'AWS::Lambda::Permission',
      Match.objectLike({
        Action: 'lambda:InvokeFunctionUrl',
        Principal: 'cloudfront.amazonaws.com',
        FunctionUrlAuthType: 'AWS_IAM',
      }),
    );
  });

  test('grants CloudFront permission to invoke the function via Function URL', () => {
    template.hasResourceProperties(
      'AWS::Lambda::Permission',
      Match.objectLike({
        Action: 'lambda:InvokeFunction',
        Principal: 'cloudfront.amazonaws.com',
        InvokedViaFunctionUrl: true,
      }),
    );
  });

  test('creates CloudFront distribution with custom domain', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          Enabled: true,
          Aliases: ['example.com', 'www.example.com'],
          IPV6Enabled: true,
        }),
      }),
    );
  });

  test('CloudFront has /api/* behavior', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          Origins: Match.arrayWith([
            Match.objectLike({
              DomainName: 'abc123.execute-api.us-east-2.amazonaws.com',
              OriginPath: '/production',
            }),
          ]),
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/api/*' }),
          ]),
        }),
      }),
    );
  });

  test('rewrites /api prefix before forwarding to API Gateway', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'jale-rewrite-api-prefix',
      FunctionCode: Match.stringLikeRegexp(
        'request\\.uri = request\\.uri\\.replace',
      ),
    });
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/api/*',
              OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
              FunctionAssociations: Match.arrayWith([
                Match.objectLike({ EventType: 'viewer-request' }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  // ── The viewer-address header on /api/* ──

  /** The deployed body of the /api/* viewer-request function, as a callable. */
  function apiViewerRequestHandler(): (event: unknown) => any {
    const functions = template.findResources('AWS::CloudFront::Function', {
      Properties: { Name: 'jale-rewrite-api-prefix' },
    });
    const bodies = Object.values(functions).map((f: any) => f.Properties.FunctionCode as string);
    expect(bodies).toHaveLength(1);
    // CloudFront Functions are plain JavaScript with a top-level `handler`.
    return new Function(`${bodies[0]}\nreturn handler;`)() as (event: unknown) => any;
  }

  function viewerEvent(uri: string, headers: Record<string, unknown>, ip = '203.0.113.7') {
    return {
      version: '1.0',
      context: { eventType: 'viewer-request' },
      viewer: { ip },
      request: { method: 'POST', uri, querystring: {}, headers, cookies: {} },
    };
  }

  test('the /api/* viewer-request function sets x-jale-viewer-address from event.viewer.ip', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'jale-rewrite-api-prefix',
      FunctionCode: Match.stringLikeRegexp(
        "request\\.headers\\['x-jale-viewer-address'\\] = \\{ value: event\\.viewer\\.ip \\}",
      ),
    });
  });

  test('the /api/* viewer-request function adds the viewer address and still strips the /api prefix', () => {
    const handler = apiViewerRequestHandler();
    const request = handler(viewerEvent('/api/public/reports/create', { host: { value: 'example.com' } }));
    expect(request.uri).toBe('/public/reports/create');
    expect(request.headers['x-jale-viewer-address']).toEqual({ value: '203.0.113.7' });
    expect(request.headers.host).toEqual({ value: 'example.com' });

    expect(handler(viewerEvent('/api', {})).uri).toBe('/');
    expect(handler(viewerEvent('/apiary/x', {})).uri).toBe('/apiary/x');
  });

  test('the /api/* viewer-request function replaces a client-sent viewer-address header', () => {
    const handler = apiViewerRequestHandler();
    // CloudFront hands the function lowercase header names, so this is the
    // shape any spelling of a forged header arrives in, multi-valued or not.
    const forged = {
      'x-jale-viewer-address': {
        value: '198.51.100.1',
        multiValue: [{ value: '198.51.100.1' }, { value: '198.51.100.2' }],
      },
    };
    const request = handler(viewerEvent('/api/public/reports/create', forged, '2001:db8::5'));
    expect(request.headers['x-jale-viewer-address']).toEqual({ value: '2001:db8::5' });
  });

  test('forwards every viewer header on /api/*, so the API receives the viewer-address header', () => {
    // A header a viewer-request function sets is a viewer header to the
    // origin request policy. The managed all-viewer-except-host policy
    // forwards all of them; a policy that LISTED headers would have to name
    // x-jale-viewer-address.
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/api/*',
              OriginRequestPolicyId: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
            }),
          ]),
        }),
      }),
    );
  });

  // ── Edge rate rule for the signed-out report route ──

  test('creates one CLOUDFRONT-scope web ACL that allows by default, with metrics and no sampled requests', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      VisibilityConfig: {
        CloudWatchMetricsEnabled: true,
        SampledRequestsEnabled: false,
        MetricName: Match.anyValue(),
      },
    });
  });

  test('its only rule blocks more than 10 signed-out report POSTs per address in 10 minutes', () => {
    const acl = Object.values(template.findResources('AWS::WAFv2::WebACL'))[0] as any;
    const rules: any[] = acl.Properties.Rules;
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule.Action).toEqual({ Block: {} });
    expect(rule.OverrideAction).toBeUndefined();
    expect(rule.VisibilityConfig).toEqual(expect.objectContaining({
      CloudWatchMetricsEnabled: true,
      SampledRequestsEnabled: false,
    }));

    const rate = rule.Statement.RateBasedStatement;
    expect(rate.AggregateKeyType).toBe('IP');
    // 10 is the smallest limit WAF accepts, and 600 seconds its longest window.
    expect(rate.Limit).toBe(10);
    expect(rate.EvaluationWindowSec).toBe(600);

    const scope: any[] = rate.ScopeDownStatement.AndStatement.Statements;
    expect(scope).toHaveLength(2);
    const byField = (field: string) => scope.find((s) => s.ByteMatchStatement.FieldToMatch[field]);
    expect(byField('Method').ByteMatchStatement).toEqual(expect.objectContaining({
      SearchString: 'POST',
      PositionalConstraint: 'EXACTLY',
    }));
    expect(byField('UriPath').ByteMatchStatement).toEqual(expect.objectContaining({
      SearchString: '/api/public/reports/',
      PositionalConstraint: 'STARTS_WITH',
    }));
    // Equivalent spellings of the path are decoded and normalized before the match.
    expect(byField('UriPath').ByteMatchStatement.TextTransformations).toEqual([
      { Priority: 0, Type: 'URL_DECODE' },
      { Priority: 1, Type: 'NORMALIZE_PATH' },
    ]);
  });

  test('uses no managed rule group', () => {
    expect(JSON.stringify(template.findResources('AWS::WAFv2::WebACL'))).not.toContain('ManagedRuleGroupStatement');
  });

  test('attaches the web ACL to the web distribution', () => {
    const aclId = Object.keys(template.findResources('AWS::WAFv2::WebACL'))[0];
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: { 'Fn::GetAtt': [aclId, 'Arn'] },
      }),
    });
  });

  test('CloudFront has survey behaviors when surveyOriginDomain provided', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/survey' }),
            Match.objectLike({ PathPattern: '/survey/*' }),
            Match.objectLike({ PathPattern: '/assets/*' }),
            Match.objectLike({ PathPattern: '/JaleLogo.png' }),
            Match.objectLike({ PathPattern: '/jale-logo-light.png' }),
            Match.objectLike({ PathPattern: '/jale-logo-dark.png' }),
          ]),
        }),
      }),
    );
  });

  test('strips /survey prefix before forwarding to the survey origin', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'jale-rewrite-survey-prefix',
      FunctionCode: Match.stringLikeRegexp('request\\.uri\\.replace'),
    });
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/survey/*',
              FunctionAssociations: Match.arrayWith([
                Match.objectLike({ EventType: 'viewer-request' }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  test('CloudFront has /_next/static/* cached behavior', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/_next/static/*' }),
          ]),
        }),
      }),
    );
  });

  test('creates Origin Access Control for the Function URL', () => {
    template.hasResource('AWS::CloudFront::OriginAccessControl', {});
  });

  test('does not forward viewer Authorization to the Function URL origin', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        Name: 'jale-nextjs-origin-request',
        CookiesConfig: {
          CookieBehavior: 'all',
        },
        QueryStringsConfig: {
          QueryStringBehavior: 'all',
        },
        HeadersConfig: Match.objectLike({
          HeaderBehavior: 'allExcept',
          Headers: ['host', 'authorization'],
        }),
      }),
    });
  });

  test('strips viewer Authorization on frontend behaviors before OAC signing', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'jale-strip-frontend-authorization',
      FunctionCode: Match.stringLikeRegexp('delete request\\.headers\\.authorization'),
    });
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-request' }),
            ]),
          }),
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/_next/static/*',
              FunctionAssociations: Match.arrayWith([
                Match.objectLike({ EventType: 'viewer-request' }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  test('viewer-request function redirects www to the apex domain (301)', () => {
    const fns = template.findResources('AWS::CloudFront::Function', {
      Properties: Match.objectLike({ Name: 'jale-strip-frontend-authorization' }),
    });
    const code = (Object.values(fns)[0] as {
      Properties: { FunctionCode: string };
    }).Properties.FunctionCode;

    // Redirects only when the Host is the www alias...
    expect(code).toContain("host === 'www.example.com'");
    // ...to the apex over https with a 301.
    expect(code).toContain('statusCode: 301');
    expect(code).toContain("'https://example.com'");
    // ...and still strips Authorization for apex (non-www) requests.
    expect(code).toContain('delete request.headers.authorization');
  });

  test('CloudFront has short-TTL cache behaviors for public SEO surfaces', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/en/j/*' }),
            Match.objectLike({ PathPattern: '/es/j/*' }),
            Match.objectLike({ PathPattern: '/sitemap.xml' }),
            Match.objectLike({ PathPattern: '/feed.xml' }),
            Match.objectLike({ PathPattern: '/robots.txt' }),
          ]),
        }),
      }),
    );
  });

  test('public SEO surface behaviors use a real cache policy, not CACHING_DISABLED', () => {
    const distros = template.findResources('AWS::CloudFront::Distribution');
    const distro = Object.values(distros)[0] as {
      Properties: {
        DistributionConfig: {
          CacheBehaviors?: Array<{ PathPattern: string; CachePolicyId: string }>;
        };
      };
    };
    const behaviors = distro.Properties.DistributionConfig.CacheBehaviors ?? [];
    const CACHING_DISABLED_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

    for (const pattern of ['/en/j/*', '/sitemap.xml']) {
      const behavior = behaviors.find((b) => b.PathPattern === pattern);
      expect(behavior).toBeDefined();
      expect(behavior?.CachePolicyId).toBeDefined();
      expect(behavior?.CachePolicyId).not.toBe(CACHING_DISABLED_ID);
    }
  });

  test('public SEO surface cache policy caps MaxTTL at 60s (bounds unpublish staleness)', () => {
    // maxTtl was previously 300s, which could leave an unpublished/paused job's
    // page served stale at the edge for up to 5 minutes after the employer
    // acted. Capped at 60s so worst-case staleness (edge + ISR) stays ~2 min.
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        Comment: Match.stringLikeRegexp('Short-TTL cache for public job pages'),
        DefaultTTL: 60,
        MaxTTL: 60,
        MinTTL: 60,
      }),
    });
  });

  test('CloudFront has a /brand/* behavior with the viewer-request function', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/brand/*',
              FunctionAssociations: Match.arrayWith([
                Match.objectLike({ EventType: 'viewer-request' }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  test('/brand/* uses the one-day brand cache policy, not a managed policy', () => {
    const distros = template.findResources('AWS::CloudFront::Distribution');
    const distro = Object.values(distros)[0] as {
      Properties: {
        DistributionConfig: {
          CacheBehaviors?: Array<{ PathPattern: string; CachePolicyId: string }>;
        };
      };
    };
    const behaviors = distro.Properties.DistributionConfig.CacheBehaviors ?? [];
    const CACHING_DISABLED_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
    const CACHING_OPTIMIZED_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6';

    const behavior = behaviors.find((b) => b.PathPattern === '/brand/*');
    expect(behavior).toBeDefined();
    expect(behavior?.CachePolicyId).toBeDefined();
    // CACHING_DISABLED would invoke the Next.js Lambda on every email open, and
    // the managed CACHING_OPTIMIZED policy has minTtl=1s -- Next.js serves
    // public/ with `Cache-Control: public, max-age=0`, so CloudFront would
    // honor that beyond the 1s floor and cache for one second. Neither works.
    expect(behavior?.CachePolicyId).not.toBe(CACHING_DISABLED_ID);
    expect(behavior?.CachePolicyId).not.toBe(CACHING_OPTIMIZED_ID);
  });

  test('brand cache policy pins TTLs at one day and ignores cookies/headers/query strings', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        Comment: Match.stringLikeRegexp('brand'),
        MinTTL: 86400,
        DefaultTTL: 86400,
        MaxTTL: 86400,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          CookiesConfig: Match.objectLike({ CookieBehavior: 'none' }),
          HeadersConfig: Match.objectLike({ HeaderBehavior: 'none' }),
          QueryStringsConfig: Match.objectLike({ QueryStringBehavior: 'none' }),
        }),
      }),
    });
  });

  test('creates Route 53 A and AAAA records', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'example.com.',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'example.com.',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'www.example.com.',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'www.example.com.',
    });
  });

  test('creates ACM certificate with DNS validation', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'example.com',
      SubjectAlternativeNames: ['www.example.com'],
      ValidationMethod: 'DNS',
    });
  });

  // ── SES send health, us-east-1 (sprint 24 A5) ─────────────────────────────
  //
  // These alarms have nothing to do with the frontend. They live here because
  // this is the only stack Jale deploys to us-east-1, `AWS/SES` metrics are
  // REGIONAL, and Cognito's verification and forgot-password emails send from
  // SES in us-east-1 (`sesEmailRegion`). NotificationsStack's identically
  // shaped pair covers us-east-2 and is blind to every one of those messages —
  // so without these, a us-east-1 reputation problem takes out every signup
  // confirmation and password reset while every dashboard stays green. That is
  // the 2026-08-28 silent-bounce failure aimed at the login door.

  test("alarms on the us-east-1 hour's bounce share above a count floor: one stray bounce is quiet, an all-bounce burst pages", () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm', { Properties: { AlarmName: 'SesBounceCountUsEast1' } });
    expect(Object.keys(alarms)).toEqual([expect.stringMatching(/^SesBounceCountUsEast1Alarm[0-9A-F]{8}$/)]);
    const props = (Object.values(alarms)[0] as any).Properties;
    // Metric math, not the plain Bounce sum at a threshold of one.
    expect(props.MetricName).toBeUndefined();
    expect(props.Namespace).toBeUndefined();
    expect(props).toMatchObject({
      Threshold: BOUNCE_SHARE,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
    const expression = (props.Metrics as any[]).find((m) => m.Expression !== undefined);
    expect(expression).toMatchObject({ Expression: BOUNCE_SHARE_EXPRESSION, ReturnData: true });
    const inputs = Object.fromEntries((props.Metrics as any[]).filter((m) => m.MetricStat).map((m) => [m.Id, m.MetricStat]));
    expect(inputs).toEqual({
      m1: { Metric: { Namespace: 'AWS/SES', MetricName: 'Bounce' }, Period: 3600, Stat: 'Sum' },
      m2: { Metric: { Namespace: 'AWS/SES', MetricName: 'Send' }, Period: 3600, Stat: 'Sum' },
    });
    // The deployed expression and threshold, hour by hour.
    const breaches = (hour: { bounces?: number; sends?: number }) => sesBounceAlarmBreaches(hour, expression.Expression, props.Threshold);
    expect(breaches({ bounces: 1, sends: 50 })).toBe(false);
    expect(breaches({ bounces: 6, sends: 6 })).toBe(true);
    expect(breaches({ bounces: 2, sends: 4 })).toBe(true);
    expect(breaches({ bounces: 3 })).toBe(true);
    expect(breaches({})).toBe(false);
  });

  test('alarms on the us-east-1 SES bounce RATE at or above 5%', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'SesReputationBounceRateUsEast1',
      Namespace: 'AWS/SES',
      MetricName: 'Reputation.BounceRate',
      Statistic: 'Maximum',
      Period: 3600,
      Threshold: 0.05,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('the us-east-1 SES alarms are account-wide, with no dimensions', () => {
    // Any dimension on an account-level `AWS/SES` metric yields a metric that
    // never reports a datapoint — an alarm that cannot fire.
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const sesAlarms = Object.values(alarms).filter((a: any) => a.Properties.Namespace === 'AWS/SES'
      || (a.Properties.Metrics ?? []).some((m: any) => m.MetricStat?.Metric?.Namespace === 'AWS/SES'));
    expect(sesAlarms.map((a: any) => a.Properties.AlarmName).sort()).toEqual(['SesBounceCountUsEast1', 'SesReputationBounceRateUsEast1']);
    for (const alarm of sesAlarms as any[]) {
      expect(alarm.Properties.Dimensions).toBeUndefined();
      for (const input of (alarm.Properties.Metrics ?? []) as any[]) {
        if (input.MetricStat) expect(input.MetricStat.Metric.Dimensions).toBeUndefined();
      }
    }
  });

  // ── The us-east-1 alarm topic ─────────────────────────────────────────────
  //
  // An alarm can only notify a topic in its own region, and the shared ops
  // topic is in us-east-2, so this stack owns a topic of its own for the two
  // alarms above. It has no subscriptions in code: they are added outside the
  // repository.

  function onlyResourceOf(type: string): [string, any] {
    const found = Object.entries(template.findResources(type));
    expect(found).toHaveLength(1);
    return found[0] as [string, any];
  }

  test('the us-east-1 SES alarms notify the us-east-1 alarm topic, and the names say which region they watch', () => {
    const [topicId] = onlyResourceOf('AWS::SNS::Topic');
    for (const alarmName of ['SesBounceCountUsEast1', 'SesReputationBounceRateUsEast1']) {
      const alarms = template.findResources('AWS::CloudWatch::Alarm', {
        Properties: { AlarmName: alarmName },
      });
      expect(Object.keys(alarms)).toHaveLength(1);
      const alarm = Object.values(alarms)[0] as any;
      expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
      expect(alarm.Properties.OKActions).toBeUndefined();
      // The suffix is what keeps these distinguishable from
      // NotificationsStack's us-east-2 pair in a single alarm list.
      expect(alarm.Properties.AlarmName).toMatch(/UsEast1$/);
    }
  });

  test('creates one alarm topic, encrypted with its own rotating key, with no subscriptions', () => {
    const [, topic] = onlyResourceOf('AWS::SNS::Topic');
    const [keyId, key] = onlyResourceOf('AWS::KMS::Key');
    expect(topic.Properties.TopicName).toBe('jale-alarms-us-east-1');
    expect(topic.Properties.KmsMasterKeyId).toEqual({ 'Fn::GetAtt': [keyId, 'Arn'] });
    expect(key.Properties.EnableKeyRotation).toBe(true);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    expect(topic.Properties.Subscription).toBeUndefined();
  });

  test("lets this account's alarms in this region use the topic key, and nothing else new", () => {
    const [, key] = onlyResourceOf('AWS::KMS::Key');
    const statements: any[] = key.Properties.KeyPolicy.Statement;
    const forAlarms = statements.filter((st) => st.Principal?.Service === 'cloudwatch.amazonaws.com');
    expect(forAlarms).toHaveLength(1);
    expect(forAlarms[0].Effect).toBe('Allow');
    expect([forAlarms[0].Action].flat().sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey*']);
    expect(flatten(forAlarms[0].Condition)).toEqual({
      StringEquals: { 'aws:SourceAccount': '${AWS::AccountId}' },
      ArnLike: { 'aws:SourceArn': 'arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:*' },
    });
    // The only other principal is the account itself, as every key has.
    const others = statements.filter((st) => st !== forAlarms[0]);
    for (const st of others) {
      expect(st.Principal?.Service).toBeUndefined();
    }
  });

  test("the topic policy refuses plain transport and allows this account's alarms in this region to publish", () => {
    const [topicId] = onlyResourceOf('AWS::SNS::Topic');
    const [, policy] = onlyResourceOf('AWS::SNS::TopicPolicy');
    expect(policy.Properties.Topics).toEqual([{ Ref: topicId }]);
    const statements: any[] = policy.Properties.PolicyDocument.Statement;
    const denyPlain = statements.filter((st) => st.Effect === 'Deny');
    expect(denyPlain).toHaveLength(1);
    expect(denyPlain[0].Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
    const publish = statements.filter((st) => st.Effect === 'Allow');
    expect(publish).toHaveLength(1);
    expect(publish[0].Principal).toEqual({ Service: 'cloudwatch.amazonaws.com' });
    expect(publish[0].Action).toBe('sns:Publish');
    expect(publish[0].Resource).toEqual({ Ref: topicId });
    expect(flatten(publish[0].Condition)).toEqual({
      StringEquals: { 'aws:SourceAccount': '${AWS::AccountId}' },
      ArnLike: { 'aws:SourceArn': 'arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:*' },
    });
  });

  // ── The admin console's CDN ──────────────────────────────────────────────
  //
  // CloudFront publishes its metrics in us-east-1 only, so the admin
  // distribution's error alarm lives here, though the admin stack does not.

  test("alarms on the admin distribution's 5xx rate, on CloudFront's global metric, to the us-east-1 topic", () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { AlarmName: 'jale-admin-cloudfront-5xx' },
    });
    expect(Object.keys(alarms)).toEqual([expect.stringMatching(/^AdminCloudFront5xxAlarm[0-9A-F]{8}$/)]);
    const alarm = Object.values(alarms)[0] as any;
    expect(alarm.Properties).toMatchObject({
      Namespace: 'AWS/CloudFront',
      MetricName: '5xxErrorRate',
      Statistic: 'Average',
      Period: 300,
      Threshold: 5,
      EvaluationPeriods: 2,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect([...alarm.Properties.Dimensions].sort((a: any, b: any) => a.Name.localeCompare(b.Name))).toEqual([
      { Name: 'DistributionId', Value: ADMIN_DISTRIBUTION_ID },
      { Name: 'Region', Value: 'Global' },
    ]);
    const [topicId] = onlyResourceOf('AWS::SNS::Topic');
    expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
    expect(alarm.Properties.OKActions).toBeUndefined();
  });

  test('outputs the alarm topic name, so subscriptions can be added outside the repository', () => {
    const [topicId] = onlyResourceOf('AWS::SNS::Topic');
    template.hasOutput('AlarmTopicName', {
      Value: { 'Fn::GetAtt': [topicId, 'TopicName'] },
    });
  });
});

describeIfDocker('FrontendStack without survey origin', () => {
  test('does NOT create /survey/* behavior when surveyOriginDomain omitted', () => {
    const app = new cdk.App();
    const stack = new FrontendStack(app, 'TestFrontendStack2', {
      env: { account: '111111111111', region: 'us-east-1' },
      apiOriginDomainName: 'abc123.execute-api.us-east-2.amazonaws.com',
      apiStageName: 'production',
      domainName: 'example.com',
      hostedZoneId: 'Z1234567890ABC',
      // surveyOriginDomain omitted
      workerPoolId: 'us-east-1_TEST',
      workerClientId: 'test-worker-client',
      employerPoolId: 'us-east-1_EMPL',
      employerClientId: 'test-employer-client',
      whatsappBusinessNumber: '15551234567',
      teamManagementEnabled: true,
    });

    const tpl = Template.fromStack(stack);
    // This stack also has the team-management flag on (the first one, off).
    expect(imageBuildArgs(app, stack).NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED).toBe('true');

    // Without the admin distribution's id there is no admin CDN alarm.
    expect(Object.keys(tpl.findResources('AWS::CloudWatch::Alarm', {
      Properties: { AlarmName: 'jale-admin-cloudfront-5xx' },
    }))).toEqual([]);

    // CacheBehaviors should not contain survey routing when no origin is configured.
    const distros = tpl.findResources('AWS::CloudFront::Distribution');
    const distro = Object.values(distros)[0] as { Properties: { DistributionConfig: { CacheBehaviors?: Array<{ PathPattern: string }> } } };
    const behaviors = distro.Properties.DistributionConfig.CacheBehaviors ?? [];
    const hasSurvey = behaviors.some((b) =>
      [
        '/survey',
        '/survey/*',
        '/assets/*',
        '/JaleLogo.png',
        '/jale-logo-light.png',
        '/jale-logo-dark.png',
      ].includes(b.PathPattern),
    );
    expect(hasSurvey).toBe(false);
  });
});
