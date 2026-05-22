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

  test('CloudFront has /survey/* behavior when surveyOriginDomain provided', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/survey/*' }),
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

    // CacheBehaviors should not contain /survey/*
    const distros = tpl.findResources('AWS::CloudFront::Distribution');
    const distro = Object.values(distros)[0] as { Properties: { DistributionConfig: { CacheBehaviors?: Array<{ PathPattern: string }> } } };
    const behaviors = distro.Properties.DistributionConfig.CacheBehaviors ?? [];
    const hasSurvey = behaviors.some((b) => b.PathPattern === '/survey/*');
    expect(hasSurvey).toBe(false);
  });
});
