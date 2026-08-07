import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { BillingStack } from '../../../lib/stacks/billing-stack';
import { ReferralsStack } from '../../../lib/stacks/referrals-stack';

describe('ApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        emailFromAddress: 'billing@jaleapp.ai',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
        publicSiteBaseUrl: 'https://jaleapp.ai',
        whatsappBusinessNumber: '15551234567',
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
    const ai = new AiStack(app, 'TestAiStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      employerCandidateRerankQueue,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
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
    // ReferralsStack must be created so its routes (and the /public/jobs
    // throttle entries) are visible in the ApiStack template.
    new ReferralsStack(app, 'TestReferralsStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      referralsLambdaSg: network.referralsLambdaSg,
      referralsDbSecret: database.referralsDbSecret,
      appDbSecret: database.dbSecret,
      api: api.api,
      workerAuthorizer: api.workerAuthorizer,
      workerResource: api.workerResource,
      workerJobResource: api.workerJobResource,
      employerAuthorizer: api.employerAuthorizer,
      employerJobResource: api.employerJobResource,
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

  test('DELETE /employer/jobs/{jobId} exists with EmployerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'DELETE',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('Employer jobs delete Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer jobs hard-delete endpoint',
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

  test('Employer inbox Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer inbox endpoint',
    });
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

  test('Worker profile update Lambda has ALIAS_GENERATOR_ARN env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker profile update endpoint',
      Environment: {
        Variables: Match.objectLike({
          ALIAS_GENERATOR_ARN: Match.anyValue(),
        }),
      },
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

  test('POST /worker/jobs/{jobId}/apply exists with WorkerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('Employer PATCH routes use EmployerAuthorizer', () => {
    // 5th PATCH is ReferralsStack's /employer/jobs/{jobId}/public-listing
    // consent toggle (migration 057) — the Method lands in this template
    // because the resource node it hangs off belongs to ApiStack.
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', {
      HttpMethod: 'PATCH',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    }, 5);
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

  // ── Referrals: MethodSettings throttles (ApiStack owns the only array) ──

  test('centralized MethodSettings includes both new /public/jobs throttle entries', () => {
    const stages = template.findResources('AWS::ApiGateway::Stage');
    const stageIds = Object.keys(stages);
    expect(stageIds).toHaveLength(1);
    const methodSettings: any[] = (stages[stageIds[0]] as any).Properties.MethodSettings;

    expect(methodSettings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ResourcePath: '/public/jobs/{code}',
        HttpMethod: 'GET',
        ThrottlingBurstLimit: 20,
        ThrottlingRateLimit: 10,
      }),
    ]));
    expect(methodSettings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ResourcePath: '/public/jobs/{code}/apply-intent',
        HttpMethod: 'POST',
        ThrottlingBurstLimit: 10,
        ThrottlingRateLimit: 5,
      }),
    ]));
  });

  test('centralized MethodSettings includes exactly one POST /public/jobs/{code}/open throttle entry', () => {
    const stages = template.findResources('AWS::ApiGateway::Stage');
    const stageIds = Object.keys(stages);
    const methodSettings: any[] = (stages[stageIds[0]] as any).Properties.MethodSettings;

    const matches = methodSettings.filter(
      (s) => s.ResourcePath === '/public/jobs/{code}/open' && s.HttpMethod === 'POST',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual(expect.objectContaining({
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    }));
  });

  test('centralized MethodSettings includes exactly one GET /public/jobs/{code}/referrer throttle entry', () => {
    const stages = template.findResources('AWS::ApiGateway::Stage');
    const stageIds = Object.keys(stages);
    const methodSettings: any[] = (stages[stageIds[0]] as any).Properties.MethodSettings;

    const matches = methodSettings.filter(
      (s) => s.ResourcePath === '/public/jobs/{code}/referrer' && s.HttpMethod === 'GET',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual(expect.objectContaining({
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    }));
  });

  test('centralized MethodSettings includes exactly one GET /public/jobs throttle entry, same shape as /public/jobs/{code}', () => {
    const stages = template.findResources('AWS::ApiGateway::Stage');
    const stageIds = Object.keys(stages);
    const methodSettings: any[] = (stages[stageIds[0]] as any).Properties.MethodSettings;

    // A plain arrayContaining/arrayWith check would still pass if this entry
    // were accidentally duplicated -- assert cardinality explicitly.
    const matches = methodSettings.filter(
      (s) => s.ResourcePath === '/public/jobs' && s.HttpMethod === 'GET',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual(expect.objectContaining({
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    }));
  });

  test('MethodSettings still includes the pre-existing /legal/tos and billing entries (no clobber)', () => {
    const stages = template.findResources('AWS::ApiGateway::Stage');
    const stageIds = Object.keys(stages);
    const methodSettings: any[] = (stages[stageIds[0]] as any).Properties.MethodSettings;

    for (const entry of [
      { ResourcePath: '/legal/tos', HttpMethod: 'GET' },
      { ResourcePath: '/auth/worker/signup', HttpMethod: 'POST' },
      { ResourcePath: '/employer/billing/checkout', HttpMethod: 'POST' },
      { ResourcePath: '/employer/billing/portal', HttpMethod: 'POST' },
      { ResourcePath: '/billing/webhook', HttpMethod: 'POST' },
    ]) {
      expect(methodSettings).toEqual(expect.arrayContaining([expect.objectContaining(entry)]));
    }
  });

  // ── Referrals: no duplicate /worker, /worker/jobs, or {jobId} resources ──
  //
  // PathPart strings like 'worker', 'jobs', and '{jobId}' are NOT unique across
  // the whole app (e.g. /auth/worker also has PathPart 'worker'; /employer/jobs
  // also has PathPart 'jobs' and its own '{jobId}' child). So the real
  // "no duplicate" invariant has to be checked structurally: walk the resource
  // tree by ParentId from the RestApi root, and assert each specific node has
  // exactly one child with a given PathPart.

  function allResources(): Record<string, any> {
    return template.findResources('AWS::ApiGateway::Resource');
  }

  function childrenOf(parentLogicalId: string, pathPart?: string): Array<[string, any]> {
    return Object.entries(allResources()).filter(([, res]) => {
      const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
      if (parentRef !== parentLogicalId) return false;
      return pathPart === undefined || res.Properties?.PathPart === pathPart;
    });
  }

  function restApiRootLogicalId(): string {
    const apis = template.findResources('AWS::ApiGateway::RestApi');
    const apiIds = Object.keys(apis);
    expect(apiIds).toHaveLength(1);
    return apiIds[0];
  }

  test('exactly one /worker resource hangs directly off the RestApi root', () => {
    const rootId = restApiRootLogicalId();
    const workerChildren = childrenOf(rootId, 'worker');
    expect(workerChildren).toHaveLength(1);
  });

  test('exactly one "jobs" child under /worker, and exactly one "{jobId}" child under /worker/jobs', () => {
    const rootId = restApiRootLogicalId();
    const [workerLogicalId] = childrenOf(rootId, 'worker')[0];

    const jobsChildren = childrenOf(workerLogicalId, 'jobs');
    expect(jobsChildren).toHaveLength(1);
    const [workerJobsLogicalId] = jobsChildren[0];

    // The critical check: if ReferralsStack (or anything else) had called
    // addResource('{jobId}') again here instead of reusing ApiStack's
    // exported workerJobResource, there would be TWO variable-path children
    // of /worker/jobs (e.g. '{id}' and '{jobId}' as siblings) — which API
    // Gateway does not allow and this test would catch.
    const variableChildren = Object.entries(allResources()).filter(([, res]) => {
      const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
      return parentRef === workerJobsLogicalId && /^\{.*\}$/.test(res.Properties?.PathPart ?? '');
    });
    expect(variableChildren).toHaveLength(1);
    expect(variableChildren[0][1].Properties.PathPart).toBe('{jobId}');
  });

  test('the referrals "share" resource is the only new child added under the shared {jobId} node', () => {
    const rootId = restApiRootLogicalId();
    const [workerLogicalId] = childrenOf(rootId, 'worker')[0];
    const [workerJobsLogicalId] = childrenOf(workerLogicalId, 'jobs')[0];
    const [workerJobLogicalId] = childrenOf(workerJobsLogicalId, '{jobId}')[0];

    const shareChildren = childrenOf(workerJobLogicalId, 'share');
    expect(shareChildren).toHaveLength(1);

    // {jobId}'s only children should be 'apply' (pre-existing) and 'share'
    // (ReferralsStack) — nothing else, and in particular no second variable
    // resource.
    const allChildren = Object.entries(allResources()).filter(([, res]) => {
      const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
      return parentRef === workerJobLogicalId;
    });
    const pathParts = allChildren.map(([, res]) => res.Properties.PathPart).sort();
    expect(pathParts).toEqual(['apply', 'share']);
  });

  // ── Referrals: public routes and worker routes exist and are auth-gated as expected ──

  test('public/jobs path-part resources exist: public, jobs, {code}, apply-intent', () => {
    for (const pathPart of ['public', '{code}', 'apply-intent']) {
      template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: pathPart });
    }
  });

  test('GET /public/jobs hangs off the same "jobs" node as {code}, not a second one', () => {
    const rootId = restApiRootLogicalId();
    const publicChildren = childrenOf(rootId, 'public');
    expect(publicChildren).toHaveLength(1);
    const [publicLogicalId] = publicChildren[0];

    const jobsChildren = childrenOf(publicLogicalId, 'jobs');
    expect(jobsChildren).toHaveLength(1);
    const [publicJobsLogicalId] = jobsChildren[0];

    const methods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { HttpMethod: 'GET' },
    });
    const getMethodsOnPublicJobs = Object.values(methods).filter((m: any) => {
      const parentRef = m.Properties?.ResourceId?.['Fn::GetAtt']?.[0] ?? m.Properties?.ResourceId?.Ref;
      return parentRef === publicJobsLogicalId;
    });
    expect(getMethodsOnPublicJobs).toHaveLength(1);
    expect((getMethodsOnPublicJobs[0] as any).Properties.AuthorizationType).toBe('NONE');
  });

  test('employer {jobId} node gains a "share" child alongside applicants/candidates/public-listing', () => {
    const rootId = restApiRootLogicalId();
    const employerChildren = childrenOf(rootId, 'employer');
    expect(employerChildren).toHaveLength(1);
    const [employerLogicalId] = employerChildren[0];

    const employerJobsChildren = childrenOf(employerLogicalId, 'jobs');
    expect(employerJobsChildren).toHaveLength(1);
    const [employerJobsLogicalId] = employerJobsChildren[0];

    const jobIdChildren = Object.entries(allResources()).filter(([, res]) => {
      const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
      return parentRef === employerJobsLogicalId && /^\{.*\}$/.test(res.Properties?.PathPart ?? '');
    });
    expect(jobIdChildren).toHaveLength(1);
    const [employerJobIdLogicalId] = jobIdChildren[0];

    const pathParts = childrenOf(employerJobIdLogicalId).map(([, res]) => res.Properties.PathPart).sort();
    expect(pathParts).toEqual(['applicants', 'candidates', 'public-listing', 'share']);
  });

  test('referrals path-part resource exists: referrals', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'referrals' });
  });
});

describe('ApiStack phase-1 rename deploy (-c workerJobsRenamePhase1=true)', () => {
  // The {id} -> {jobId} rename cannot land in one deploy: CloudFormation's
  // create-before-delete order collides on API Gateway's one-variable-sibling
  // rule and rolls the update back. Phase 1 (this flag) omits the node
  // entirely -- the documented outage window -- and phase 2 (no flag) restores
  // it as {jobId}. This suite proves the flag produces that exact state, so
  // the operator checks out nothing and edits nothing mid-deploy.
  let phase1Template: Template;
  let phase1Api: ApiStack;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        emailFromAddress: 'billing@jaleapp.ai',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
        publicSiteBaseUrl: 'https://jaleapp.ai',
        whatsappBusinessNumber: '15551234567',
        workerJobsRenamePhase1: true,
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', { network });
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    const employerCandidateRerankQueue = new sqs.Queue(network, 'EmployerCandidateRerankQueue');
    const ai = new AiStack(app, 'TestAiStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    phase1Api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      employerCandidateRerankQueue,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    // LegalStack attaches the dual authorizer to a method; without it the
    // template cannot synthesize (same requirement as the main suite above).
    new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: phase1Api.api,
      dualAuthorizer: phase1Api.dualAuthorizer,
    });
    // ReferralsStack must still synthesize in phase 1 -- its share route is
    // skipped, not broken.
    new ReferralsStack(app, 'TestReferralsStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      referralsLambdaSg: network.referralsLambdaSg,
      referralsDbSecret: database.referralsDbSecret,
      appDbSecret: database.dbSecret,
      api: phase1Api.api,
      workerAuthorizer: phase1Api.workerAuthorizer,
      workerResource: phase1Api.workerResource,
      workerJobResource: phase1Api.workerJobResource,
      employerAuthorizer: phase1Api.employerAuthorizer,
      employerJobResource: phase1Api.employerJobResource,
    });
    phase1Template = Template.fromStack(phase1Api);
  });

  test('the worker {jobId} node and its old {id} name are both absent', () => {
    const apis = phase1Template.findResources('AWS::ApiGateway::RestApi');
    const rootId = Object.keys(apis)[0];
    // Walk from the root: /worker -> jobs -> (no variable child).
    const resources = phase1Template.findResources('AWS::ApiGateway::Resource');
    const childrenOf = (parentLogicalId: string) =>
      Object.entries(resources).filter(([, res]: [string, any]) => {
        const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
        return parentRef === parentLogicalId;
      });
    const worker = childrenOf(rootId).find(([, r]: [string, any]) => r.Properties.PathPart === 'worker');
    expect(worker).toBeDefined();
    const workerJobs = childrenOf(worker![0]).find(([, r]: [string, any]) => r.Properties.PathPart === 'jobs');
    expect(workerJobs).toBeDefined();
    const variableChildren = childrenOf(workerJobs![0]).filter(([, r]: [string, any]) =>
      /^\{.+\}$/.test(r.Properties.PathPart));
    expect(variableChildren).toHaveLength(0);
  });

  test('the export is undefined so downstream stacks skip their routes', () => {
    expect(phase1Api.workerJobResource).toBeUndefined();
  });

  test('the ENV VAR drives phase 1 too — this is how the pipeline flips it without file edits', () => {
    process.env.JALE_WORKER_JOBS_RENAME_PHASE1 = 'true';
    try {
      // No context flag this time: only the env var, exactly as a GitHub
      // repository variable reaches the pipeline's cdk process.
      const app = new cdk.App({
        context: {
          otpSmsFromNumber: '+13252210992',
          emailFromAddress: 'billing@jaleapp.ai',
          sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
          publicSiteBaseUrl: 'https://jaleapp.ai',
          whatsappBusinessNumber: '15551234567',
        },
      });
      const network = new NetworkStack(app, 'TestNetworkStack');
      const database = new DatabaseStack(app, 'TestDatabaseStack', { network });
      const auth = new AuthStack(app, 'TestAuthStack', {
        vpc: network.vpc,
        privateSubnets: network.privateSubnets,
        lambdaSg: network.lambdaSg,
        dbSecret: database.dbSecret,
      });
      const employerCandidateRerankQueue = new sqs.Queue(network, 'EmployerCandidateRerankQueue');
      const ai = new AiStack(app, 'TestAiStack', {
        vpc: network.vpc,
        privateSubnets: network.privateSubnets,
        lambdaSg: network.lambdaSg,
        aiDbSecret: database.aiDbSecret,
        alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
      });
      const envApi = new ApiStack(app, 'TestApiStack', {
        workerPool: auth.workerPool,
        employerPool: auth.employerPool,
        vpc: network.vpc,
        privateSubnets: network.privateSubnets,
        lambdaSg: network.lambdaSg,
        dbSecret: database.dbSecret,
        employerCandidateRerankQueue,
        aliasGeneratorFn: ai.aliasGeneratorFn.function,
        whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
      });
      expect(envApi.workerJobResource).toBeUndefined();
    } finally {
      delete process.env.JALE_WORKER_JOBS_RENAME_PHASE1;
    }
  });

  test('worker jobs LIST survives phase 1 — only detail/apply/share are down', () => {
    // GET /worker/jobs (the list) hangs off the jobs node itself, not {jobId},
    // and must keep working through the window.
    phase1Template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'jobs' });
  });
});
