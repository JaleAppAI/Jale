import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { FrontendStack } from '../../../lib/stacks/frontend-stack';

// CDK builds the Docker image during synth (DockerImageFunction.fromImageAsset).
// Skip this suite in environments without Docker (set SKIP_DOCKER_TESTS=1).
const describeIfDocker = process.env.SKIP_DOCKER_TESTS ? describe.skip : describe;

describeIfDocker('FrontendStack (Lambda + CloudFront)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    // Minimal API stack (FrontendStack accepts a real RestApi)
    const apiStack = new cdk.Stack(app, 'TestApiStack', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const api = new apigateway.RestApi(apiStack, 'TestApi', {
      restApiName: 'test-api',
    });
    api.root.addMethod(
      'GET',
      new apigateway.MockIntegration({
        integrationResponses: [{ statusCode: '200' }],
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      }),
      { methodResponses: [{ statusCode: '200' }] },
    );

    const stack = new FrontendStack(app, 'TestFrontendStack', {
      env: { account: '111111111111', region: 'us-east-1' },
      api,
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
      }),
    );
  });

  test('creates CloudFront distribution with custom domain', () => {
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          Enabled: true,
          Aliases: ['example.com'],
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
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({ PathPattern: '/api/*' }),
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

  test('creates Route 53 A and AAAA records', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'example.com.',
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'example.com.',
    });
  });

  test('creates ACM certificate with DNS validation', () => {
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'example.com',
      ValidationMethod: 'DNS',
    });
  });
});

describeIfDocker('FrontendStack without survey origin', () => {
  test('does NOT create /survey/* behavior when surveyOriginDomain omitted', () => {
    const app = new cdk.App();
    const apiStack = new cdk.Stack(app, 'TestApiStack2', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const api = new apigateway.RestApi(apiStack, 'TestApi2', {
      restApiName: 'test-api-2',
    });
    api.root.addMethod(
      'GET',
      new apigateway.MockIntegration({
        integrationResponses: [{ statusCode: '200' }],
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      }),
      { methodResponses: [{ statusCode: '200' }] },
    );

    const stack = new FrontendStack(app, 'TestFrontendStack2', {
      env: { account: '111111111111', region: 'us-east-1' },
      api,
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
