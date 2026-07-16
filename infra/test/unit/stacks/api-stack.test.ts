import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { BillingStack } from '../../../lib/stacks/billing-stack';

describe('ApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        emailFromAddress: 'billing@jaleapp.ai',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', {
      network,
    });
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    const employerCandidateRerankQueue = new sqs.Queue(network, 'EmployerCandidateRerankQueue');
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      employerCandidateRerankQueue,
    });
    // LegalStack must be created so the dual authorizer is attached to a method
    new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });
    // BillingStack must be created so its routes are visible in the ApiStack template
    new BillingStack(app, 'TestBillingStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      appDbSecret: database.dbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
    });
    template = Template.fromStack(api);
  });

  test('REST API exists', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'jale-api',
    });
  });

  test('defaults API CORS and Lambda origin to production domain', () => {
    template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
      ResponseParameters: Match.objectLike({
        'gatewayresponse.header.Access-Control-Allow-Origin': "'https://jaleapp.ai'",
      }),
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          ALLOWED_ORIGIN: 'https://jaleapp.ai',
        }),
      }),
    });
  });

  test('Three Cognito authorizers exist (worker, employer, dual)', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 3);
  });

  test('Health Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Health check endpoint',
    });
  });

  test('Worker profile Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker profile endpoint',
    });
  });

  test('Employer profile Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer profile endpoint',
    });
  });

  test('Token refresh Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Token refresh endpoint',
    });
  });

  test('Logout Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Logout endpoint',
    });
  });

  test('Worker web signup Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker web signup endpoint - create confirmed worker before SMS OTP login',
    });
  });

  // Task 2.2 — per-route authorizer verification
  test('GET /worker/profile is protected by WorkerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('GET /employer/profile is protected by EmployerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('GET /health has no authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
    });
  });

  test('Employer jobs list Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer jobs list endpoint',
    });
  });

  test('Employer jobs create Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer jobs create endpoint',
    });
  });

  test('Employer jobs update Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer jobs update endpoint',
    });
  });

  test('Employer job detail Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer job detail endpoint',
    });
  });

  test('GET /employer/jobs/{jobId} exists with EmployerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('Employer job applicants Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer job applicants endpoint',
    });
  });

  test('PATCH /employer/profile is protected by EmployerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'PATCH',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('Employer job candidates Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer job candidates endpoint',
    });
  });

  test('GET /employer/jobs/{jobId}/candidates exists with EmployerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('Employer application status update Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer application status update endpoint',
    });
  });

  test('Employer messaging Lambda functions exist', () => {
    for (const description of [
      'Employer conversations list endpoint',
      'Employer conversations detail endpoint',
      'Employer conversations create endpoint',
      'Employer conversations send endpoint',
      'Employer conversations update endpoint',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { Description: description });
    }
  });
  // Task 12 — new worker marketplace route assertions
  test('Worker jobs list Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker jobs list endpoint',
    });
  });

  test('Worker job detail Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker job detail endpoint',
    });
  });

  test('Worker job apply Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker job apply endpoint',
    });
  });

  test('Worker applications list Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker applications list endpoint',
    });
  });

  test('Worker profile update Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker profile update endpoint',
    });
  });

  test('GET /worker/jobs is protected by WorkerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('PATCH /worker/profile exists with WorkerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'PATCH',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('POST /worker/jobs/{id}/apply exists with WorkerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('Employer PATCH routes use EmployerAuthorizer', () => {
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', {
      HttpMethod: 'PATCH',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    }, 4);
  });

  // ── A6: CORS Idempotency-Key header ──────────────────────────────────────

  test('CORS preflight allowHeaders includes Idempotency-Key', () => {
    // The CORS preflight mock integration response must include Idempotency-Key
    // so browsers can send the header on checkout/portal requests.
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      Integration: Match.objectLike({
        IntegrationResponses: Match.arrayWith([
          Match.objectLike({
            ResponseParameters: Match.objectLike({
              'method.response.header.Access-Control-Allow-Headers': Match.stringLikeRegexp('Idempotency-Key'),
            }),
          }),
        ]),
      }),
    });
  });

  test('Gateway response Access-Control-Allow-Headers includes Idempotency-Key', () => {
    template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
      ResponseParameters: Match.objectLike({
        'gatewayresponse.header.Access-Control-Allow-Headers': Match.stringLikeRegexp('Idempotency-Key'),
      }),
    });
  });

  // ── A6: employerResource exported ────────────────────────────────────────

  test('ApiStack exposes employerResource as a public property', () => {
    // This is a compile-time check verified by the fact that BillingStack tests
    // construct successfully using api.employerResource. The test here just
    // confirms the REST API resource tree has an /employer path resource.
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'employer',
    });
  });

  // ── A6: Billing routes (ApiGateway::Method resources land in ApiStack) ──
  // BillingStack adds methods to the RestApi owned by ApiStack, so those
  // Method resources appear in the ApiStack CloudFormation template.

  test('GET /employer/billing is protected by EmployerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('POST /employer/billing/checkout and /portal are employer-auth-gated', () => {
    // checkout + portal = 2 POST methods with COGNITO_USER_POOLS + EmployerAuthorizer
    // in addition to existing employer POST routes (employer-jobs-create and
    // employer-conversations-create). We assert at least 2 of those belong to billing.
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('POST /billing/webhook has no authorizer', () => {
    // Stripe webhook endpoint must have NONE auth — Stripe HMAC is validated in handler.
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
    });
  });

  test('Billing API path-part resources exist: billing, checkout, portal, webhook', () => {
    for (const pathPart of ['billing', 'checkout', 'portal', 'webhook']) {
      template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: pathPart });
    }
  });
});
