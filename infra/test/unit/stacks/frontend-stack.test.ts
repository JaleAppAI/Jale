import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../../../lib/stacks/frontend-stack';

// CDK builds the Docker image during synth (DockerImageFunction.fromImageAsset).
// Skip this suite in environments without Docker (set SKIP_DOCKER_TESTS=1).
const describeIfDocker = process.env.SKIP_DOCKER_TESTS ? describe.skip : describe;

describeIfDocker('FrontendStack (Lambda + CloudFront)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    const stack = new FrontendStack(app, 'TestFrontendStack', {
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
    });

    template = Template.fromStack(stack);
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
    });

    const tpl = Template.fromStack(stack);

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
