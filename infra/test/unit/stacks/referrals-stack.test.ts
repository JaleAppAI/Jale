import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { ReferralsStack } from '../../../lib/stacks/referrals-stack';

describe('ReferralsStack', () => {
  let template: Template;
  let dbTemplate: Template;
  let apiTemplate: Template;
  let networkTemplate: Template;

  function buildApp(alarmTopicArn?: string) {
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
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    // LegalStack must be created so the DualAuthorizer is attached to a method
    // (CDK validates this at synth time; Template.fromStack triggers synthesis).
    new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });
    const referrals = new ReferralsStack(app, 'TestReferralsStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      referralsLambdaSg: network.referralsLambdaSg,
      referralsDbSecret: database.referralsDbSecret,
      appDbSecret: database.dbSecret,
      api: api.api,
      // /public is owned and exported by ApiStack now: this stack must reuse
      // the node, never call addResource('public') itself.
      publicResource: api.publicResource,
      workerAuthorizer: api.workerAuthorizer,
      workerResource: api.workerResource,
      workerJobResource: api.workerJobResource,
      employerAuthorizer: api.employerAuthorizer,
      employerJobResource: api.employerJobResource,
      alarmTopicArn,
    });
    return { app, network, database, auth, api, referrals };
  }

  beforeAll(() => {
    const { network, database, api, referrals } = buildApp();
    template = Template.fromStack(referrals);
    dbTemplate = Template.fromStack(database);
    apiTemplate = Template.fromStack(api);
    networkTemplate = Template.fromStack(network);
  });

  /**
   * Finds the ApiGateway::Method whose Lambda integration targets the
   * function with the given Description, and returns its AuthorizationType.
   * Disambiguates from every other NONE/COGNITO method in the shared API
   * (there are many), which a bare hasResourceProperties() check would not.
   */
  function authorizationTypeForLambda(description: string): string {
    const fnResources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: description },
    });
    const fnLogicalIds = Object.keys(fnResources);
    expect(fnLogicalIds).toHaveLength(1);
    const fnLogicalId = fnLogicalIds[0];

    const methods = apiTemplate.findResources('AWS::ApiGateway::Method');
    const matches = Object.values(methods).filter((method: any) => {
      const uri = JSON.stringify(method.Properties?.Integration?.Uri ?? {});
      return uri.includes(fnLogicalId);
    });
    expect(matches).toHaveLength(1);
    return (matches[0] as any).Properties.AuthorizationType;
  }

  // ── Lambda functions exist ───────────────────────────────────────────────

  test('public-job Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Public job read endpoint (unauthenticated)',
    });
  });

  test('public-job-apply-intent Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Public job apply-intent endpoint (unauthenticated)',
    });
  });

  test('worker-job-share Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker job share-link minting endpoint',
    });
  });

  // GET /worker/referrals and its Lambda were deleted as dead code (L1.3):
  // nothing ever called the route -- `frontend/src/lib/api/worker.ts` only
  // reaches /worker/referrals/claim -- and it cost JaleApiStack a Method + a
  // Permission plus four resources here. Asserted as an ABSENCE so the route
  // cannot quietly come back without someone reading this note.
  test('worker-referrals history Lambda no longer exists', () => {
    expect(
      Object.keys(template.findResources('AWS::Lambda::Function', {
        Properties: { Description: 'Worker referral history endpoint' },
      })),
    ).toEqual([]);
  });

  // ── Secret isolation: each Lambda gets ONLY its own secret ───────────────

  test('public-job Lambda has REFERRALS_DB_SECRET_ARN but NOT DB_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Public job read endpoint (unauthenticated)' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('REFERRALS_DB_SECRET_ARN');
    expect(env).not.toHaveProperty('DB_SECRET_ARN');
    // The salt moved to public-job-open.ts: this Lambda is now a pure read
    // and no longer hashes visitors.
    expect(env).not.toHaveProperty('REFERRAL_VISITOR_SALT_SECRET_ARN');
  });

  test('public-job-open Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Public job open-tracking beacon endpoint (unauthenticated)',
    });
  });

  test('public-job-open Lambda has REFERRALS_DB_SECRET_ARN and REFERRAL_VISITOR_SALT_SECRET_ARN but NOT DB_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Public job open-tracking beacon endpoint (unauthenticated)' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('REFERRALS_DB_SECRET_ARN');
    expect(env).toHaveProperty('REFERRAL_VISITOR_SALT_SECRET_ARN');
    expect(env).not.toHaveProperty('DB_SECRET_ARN');
  });

  test('public-job-referrer Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Public job referrer-context lookup endpoint (unauthenticated)',
    });
  });

  test('public-job-referrer Lambda has REFERRALS_DB_SECRET_ARN but NOT DB_SECRET_ARN or the visitor salt', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Public job referrer-context lookup endpoint (unauthenticated)' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('REFERRALS_DB_SECRET_ARN');
    expect(env).not.toHaveProperty('DB_SECRET_ARN');
    expect(env).not.toHaveProperty('REFERRAL_VISITOR_SALT_SECRET_ARN');
  });

  test('public-job-apply-intent Lambda has REFERRALS_DB_SECRET_ARN and WHATSAPP_BUSINESS_NUMBER but NOT DB_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Public job apply-intent endpoint (unauthenticated)' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('REFERRALS_DB_SECRET_ARN');
    expect(env).toHaveProperty('WHATSAPP_BUSINESS_NUMBER');
    expect(env).not.toHaveProperty('DB_SECRET_ARN');
  });

  test('worker-job-share Lambda has DB_SECRET_ARN and PUBLIC_SITE_BASE_URL but NOT REFERRALS_DB_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Worker job share-link minting endpoint' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).toHaveProperty('PUBLIC_SITE_BASE_URL', 'https://jaleapp.ai');
    expect(env).not.toHaveProperty('REFERRALS_DB_SECRET_ARN');
  });

  test('worker-facing Lambdas reference the app DB secret (jale_admin), NOT jale/referrals/db', () => {
    const referralsSecretResources = dbTemplate.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: 'jale/referrals/db' },
    });
    const referralsSecretLogicalIds = Object.keys(referralsSecretResources);
    expect(referralsSecretLogicalIds.length).toBe(1);

    for (const description of ['Worker job share-link minting endpoint', 'Worker referral claim endpoint']) {
      const fnResources = template.findResources('AWS::Lambda::Function', {
        Properties: { Description: description },
      });
      const fnLogicalIds = Object.keys(fnResources);
      expect(fnLogicalIds).toHaveLength(1);

      const policies = template.findResources('AWS::IAM::Policy');
      for (const [policyId, policy] of Object.entries(policies)) {
        const policyJson = JSON.stringify((policy as any).Properties);
        const referencesReferralsSecret = referralsSecretLogicalIds.some((id) => policyJson.includes(id));
        if (referencesReferralsSecret) {
          expect(policyId.toLowerCase()).not.toMatch(/workerjobshare|workerreferrals/);
        }
      }
    }
  });

  // ── Routes: authorizers (Method resources land in ApiStack, per A6 precedent) ──

  test('GET /public/jobs/{code} has NO authorizer', () => {
    expect(authorizationTypeForLambda('Public job read endpoint (unauthenticated)')).toBe('NONE');
  });

  test('POST /public/jobs/{code}/apply-intent has NO authorizer', () => {
    expect(authorizationTypeForLambda('Public job apply-intent endpoint (unauthenticated)')).toBe('NONE');
  });

  test('POST /public/jobs/{code}/open has NO authorizer', () => {
    expect(authorizationTypeForLambda('Public job open-tracking beacon endpoint (unauthenticated)')).toBe('NONE');
  });

  test('GET /public/jobs/{code}/referrer has NO authorizer', () => {
    expect(authorizationTypeForLambda('Public job referrer-context lookup endpoint (unauthenticated)')).toBe('NONE');
  });

  test('open and referrer resources hang off the existing /public/jobs/{code} node', () => {
    function allResources(): Record<string, any> {
      return apiTemplate.findResources('AWS::ApiGateway::Resource');
    }
    function childrenOf(parentLogicalId: string, pathPart?: string): Array<[string, any]> {
      return Object.entries(allResources()).filter(([, res]) => {
        const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
        if (parentRef !== parentLogicalId) return false;
        return pathPart === undefined || res.Properties?.PathPart === pathPart;
      });
    }
    const apis = apiTemplate.findResources('AWS::ApiGateway::RestApi');
    const apiIds = Object.keys(apis);
    expect(apiIds).toHaveLength(1);
    const rootId = apiIds[0];

    const publicChildren = childrenOf(rootId, 'public');
    expect(publicChildren).toHaveLength(1);
    const [publicLogicalId] = publicChildren[0];

    const publicJobsChildren = childrenOf(publicLogicalId, 'jobs');
    expect(publicJobsChildren).toHaveLength(1);
    const [publicJobsLogicalId] = publicJobsChildren[0];

    const codeChildren = childrenOf(publicJobsLogicalId, '{code}');
    expect(codeChildren).toHaveLength(1);
    const [codeLogicalId] = codeChildren[0];

    // {code}'s children are exactly 'apply-intent', 'open' and 'referrer' —
    // nothing else, and no duplicates.
    const codeChildResources = childrenOf(codeLogicalId);
    const pathParts = codeChildResources.map(([, res]) => res.Properties.PathPart).sort();
    expect(pathParts).toEqual(['apply-intent', 'open', 'referrer']);
  });

  test('POST /worker/jobs/{jobId}/share is protected by WorkerAuthorizer', () => {
    expect(authorizationTypeForLambda('Worker job share-link minting endpoint')).toBe('COGNITO_USER_POOLS');
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('/worker/referrals carries NO method of its own -- not even a CORS preflight', () => {
    // With GET gone the node exists only to carry /claim, so it is built with
    // addPathOnlyResource(): no method at all, OPTIONS included. An OPTIONS
    // there could never be reached (a browser preflights the URL of a request
    // it is about to send, and no request can target a path with no method)
    // and an OPTIONS-only resource fails the JaleApiStack invariant in
    // test/unit/stacks/api-stack-resource-ceiling.test.ts.
    const resources = apiTemplate.toJSON().Resources as Record<string, any>;
    const [referralsLogicalId] = Object.entries(resources).find(
      ([, resource]: [string, any]) =>
        resource.Type === 'AWS::ApiGateway::Resource' && resource.Properties.PathPart === 'referrals',
    )!;
    const methods = Object.values(resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::ApiGateway::Method' &&
        resource.Properties.ResourceId?.Ref === referralsLogicalId,
    );
    expect(methods).toEqual([]);
  });

  test('worker-referral-claim Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker referral claim endpoint',
    });
  });

  test('POST /worker/referrals/claim is protected by WorkerAuthorizer', () => {
    expect(authorizationTypeForLambda('Worker referral claim endpoint')).toBe('COGNITO_USER_POOLS');
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('worker-referral-claim Lambda uses the app DB secret, not the referrals secret', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Worker referral claim endpoint' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    // Deliberately NO REQUIRED_TOS_VERSION: the claim endpoint has no
    // compliance gate (it fires post-OTP, pre-legal-wall -- see the handler's
    // inline note). Its absence here pins that design.
    expect(env).not.toHaveProperty('REQUIRED_TOS_VERSION');
    expect(env).not.toHaveProperty('REFERRALS_DB_SECRET_ARN');
  });

  test('claim resource hangs off the existing /worker/referrals node', () => {
    function allResources(): Record<string, any> {
      return apiTemplate.findResources('AWS::ApiGateway::Resource');
    }
    function childrenOf(parentLogicalId: string, pathPart?: string): Array<[string, any]> {
      return Object.entries(allResources()).filter(([, res]) => {
        const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
        if (parentRef !== parentLogicalId) return false;
        return pathPart === undefined || res.Properties?.PathPart === pathPart;
      });
    }
    const apis = apiTemplate.findResources('AWS::ApiGateway::RestApi');
    const apiIds = Object.keys(apis);
    expect(apiIds).toHaveLength(1);
    const rootId = apiIds[0];

    const workerChildren = childrenOf(rootId, 'worker');
    expect(workerChildren).toHaveLength(1);
    const [workerLogicalId] = workerChildren[0];

    const referralsChildren = childrenOf(workerLogicalId, 'referrals');
    expect(referralsChildren).toHaveLength(1);
    const [referralsLogicalId] = referralsChildren[0];

    const claimChildren = childrenOf(referralsLogicalId, 'claim');
    expect(claimChildren).toHaveLength(1);
  });

  test('PATCH /employer/jobs/{jobId}/public-listing is protected by EmployerAuthorizer', () => {
    expect(authorizationTypeForLambda('Employer opt-in toggle for the public job page')).toBe('COGNITO_USER_POOLS');
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'PATCH',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('public-listing Lambda uses the app DB secret only — consent writes go through jale_admin', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Employer opt-in toggle for the public job page' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).not.toHaveProperty('REFERRALS_DB_SECRET_ARN');
  });

  test('no Lambda carries the visitor salt as a plaintext env var', () => {
    // The salt is the only thing making the visitor hash non-invertible; an env
    // var would put it in the CFN template and every GetFunctionConfiguration
    // response. It must reach the Lambda only as a Secrets Manager ARN.
    const fns = template.findResources('AWS::Lambda::Function');
    for (const [id, fn] of Object.entries(fns)) {
      const env = (fn as any).Properties?.Environment?.Variables ?? {};
      expect({ id, has: 'REFERRAL_VISITOR_SALT' in env }).toEqual({ id, has: false });
    }
  });

  test('only the public-job-open Lambda reads the visitor-salt secret', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Public job open-tracking beacon endpoint (unauthenticated)',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          REFERRAL_VISITOR_SALT_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
    // And no other Lambda gets the ARN -- specifically not public-job (the
    // salt moved out of it) and not public-job-referrer (never hashes a visitor).
    const fns = template.findResources('AWS::Lambda::Function');
    const withArn = Object.values(fns).filter((fn: any) =>
      'REFERRAL_VISITOR_SALT_SECRET_ARN' in (fn.Properties?.Environment?.Variables ?? {}));
    expect(withArn).toHaveLength(1);
  });

  test('retention sweeper runs on a daily schedule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 day)',
    });
  });

  test('retention sweeper uses the app DB secret — jale_public_jobs must never hold DELETE', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Referral retention sweeper (tokens, claims, aged opens)' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).not.toHaveProperty('REFERRALS_DB_SECRET_ARN');
  });

  test('public/jobs/{code} path resources exist', () => {
    for (const pathPart of ['public', 'jobs', '{code}', 'apply-intent', 'open', 'referrer']) {
      apiTemplate.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: pathPart });
    }
  });

  test('share resource hangs off the existing /worker/jobs/{jobId} node, not a newly created one', () => {
    // PathPart strings like 'worker', 'jobs', and '{jobId}' are NOT unique
    // across the whole API (e.g. /employer/jobs/{jobId} also exists), so the
    // real invariant has to be checked structurally by walking ParentId from
    // the RestApi root, not by counting PathPart matches app-wide.
    function allResources(): Record<string, any> {
      return apiTemplate.findResources('AWS::ApiGateway::Resource');
    }
    function childrenOf(parentLogicalId: string, pathPart?: string): Array<[string, any]> {
      return Object.entries(allResources()).filter(([, res]) => {
        const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
        if (parentRef !== parentLogicalId) return false;
        return pathPart === undefined || res.Properties?.PathPart === pathPart;
      });
    }
    const apis = apiTemplate.findResources('AWS::ApiGateway::RestApi');
    const apiIds = Object.keys(apis);
    expect(apiIds).toHaveLength(1);
    const rootId = apiIds[0];

    const workerChildren = childrenOf(rootId, 'worker');
    expect(workerChildren).toHaveLength(1);
    const [workerLogicalId] = workerChildren[0];

    const jobsChildren = childrenOf(workerLogicalId, 'jobs');
    expect(jobsChildren).toHaveLength(1);
    const [workerJobsLogicalId] = jobsChildren[0];

    // No second, divergent variable-path sibling (e.g. '{id}' alongside
    // '{jobId}') was created under /worker/jobs.
    const variableChildren = Object.entries(allResources()).filter(([, res]) => {
      const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
      return parentRef === workerJobsLogicalId && /^\{.*\}$/.test(res.Properties?.PathPart ?? '');
    });
    expect(variableChildren).toHaveLength(1);
    const [workerJobLogicalId, workerJobResourceProps] = variableChildren[0];
    expect(workerJobResourceProps.Properties.PathPart).toBe('{jobId}');

    // {jobId}'s children are exactly 'apply' (pre-existing) and 'share'
    // (this stack) — nothing else.
    const jobIdChildren = childrenOf(workerJobLogicalId);
    const pathParts = jobIdChildren.map(([, res]) => res.Properties.PathPart).sort();
    expect(pathParts).toEqual(['apply', 'share']);
  });

  // ── Security group: no allow-all egress ──────────────────────────────────

  // ── Sprint 19: public-jobs-list, employer-job-share, visibility-outbox-drain ──

  test('public-jobs-list Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Public job index endpoint (unauthenticated, SEO/search)',
    });
  });

  test('public-jobs-list Lambda has REFERRALS_DB_SECRET_ARN but NOT DB_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Public job index endpoint (unauthenticated, SEO/search)' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('REFERRALS_DB_SECRET_ARN');
    expect(env).not.toHaveProperty('DB_SECRET_ARN');
    // Never hashes a visitor -- must not carry the visitor-salt ARN (that
    // stays exclusive to public-job, per the test below).
    expect(env).not.toHaveProperty('REFERRAL_VISITOR_SALT_SECRET_ARN');
  });

  test('GET /public/jobs has NO authorizer', () => {
    expect(authorizationTypeForLambda('Public job index endpoint (unauthenticated, SEO/search)')).toBe('NONE');
  });

  test('employer-job-share Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer job share-link minting endpoint',
    });
  });

  test('employer-job-share Lambda has DB_SECRET_ARN, REQUIRED_TOS_VERSION and PUBLIC_SITE_BASE_URL but NOT REFERRALS_DB_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Employer job share-link minting endpoint' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).toHaveProperty('REQUIRED_TOS_VERSION');
    expect(env).toHaveProperty('PUBLIC_SITE_BASE_URL', 'https://jaleapp.ai');
    expect(env).not.toHaveProperty('REFERRALS_DB_SECRET_ARN');
  });

  test('POST /employer/jobs/{jobId}/share is protected by EmployerAuthorizer', () => {
    expect(authorizationTypeForLambda('Employer job share-link minting endpoint')).toBe('COGNITO_USER_POOLS');
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('share resource hangs off the existing /employer/jobs/{jobId} node, not a newly created one', () => {
    function allApiResources(): Record<string, any> {
      return apiTemplate.findResources('AWS::ApiGateway::Resource');
    }
    function childrenOf(parentLogicalId: string, pathPart?: string): Array<[string, any]> {
      return Object.entries(allApiResources()).filter(([, res]) => {
        const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
        if (parentRef !== parentLogicalId) return false;
        return pathPart === undefined || res.Properties?.PathPart === pathPart;
      });
    }
    const apis = apiTemplate.findResources('AWS::ApiGateway::RestApi');
    const apiIds = Object.keys(apis);
    expect(apiIds).toHaveLength(1);
    const rootId = apiIds[0];

    const employerChildren = childrenOf(rootId, 'employer');
    expect(employerChildren).toHaveLength(1);
    const [employerLogicalId] = employerChildren[0];

    const employerJobsChildren = childrenOf(employerLogicalId, 'jobs');
    expect(employerJobsChildren).toHaveLength(1);
    const [employerJobsLogicalId] = employerJobsChildren[0];

    const variableChildren = Object.entries(allApiResources()).filter(([, res]) => {
      const parentRef = res.Properties?.ParentId?.['Fn::GetAtt']?.[0] ?? res.Properties?.ParentId?.Ref;
      return parentRef === employerJobsLogicalId && /^\{.*\}$/.test(res.Properties?.PathPart ?? '');
    });
    expect(variableChildren).toHaveLength(1);
    const [employerJobLogicalId] = variableChildren[0];

    const jobIdChildren = childrenOf(employerJobLogicalId);
    const pathParts = jobIdChildren.map(([, res]) => res.Properties.PathPart).sort();
    expect(pathParts).toEqual(['applicants', 'candidates', 'public-listing', 'share']);
  });

  test('visibility-outbox-drain Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Job visibility outbox drain — Google Indexing API notifications',
    });
  });

  test('visibility-outbox-drain Lambda has DB_SECRET_ARN, GOOGLE_INDEXING_SECRET_NAME and PUBLIC_SITE_BASE_URL, no ALLOWED_ORIGIN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Job visibility outbox drain — Google Indexing API notifications' },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).toHaveProperty('GOOGLE_INDEXING_SECRET_NAME');
    expect(env).toHaveProperty('PUBLIC_SITE_BASE_URL', 'https://jaleapp.ai');
    // Never calls corsHeaders() -- it's not an API Gateway-fronted handler.
    expect(env).not.toHaveProperty('ALLOWED_ORIGIN');
    expect(env).not.toHaveProperty('REFERRALS_DB_SECRET_ARN');
  });

  test('visibility-outbox-drain Lambda has reservedConcurrentExecutions=1 (overlap guard)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Job visibility outbox drain — Google Indexing API notifications',
      ReservedConcurrentExecutions: 1,
    });
  });

  test('no other referrals Lambda has ReservedConcurrentExecutions set', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: Match.not('Job visibility outbox drain — Google Indexing API notifications') },
    });
    for (const [id, fn] of Object.entries(fns)) {
      expect({ id, reserved: (fn as any).Properties?.ReservedConcurrentExecutions }).toEqual({ id, reserved: undefined });
    }
  });

  test('visibility outbox drain runs every 5 minutes, targeting the drain Lambda specifically', () => {
    const fnResources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Job visibility outbox drain — Google Indexing API notifications' },
    });
    const fnLogicalIds = Object.keys(fnResources);
    expect(fnLogicalIds).toHaveLength(1);
    const [drainFnLogicalId] = fnLogicalIds;

    const rules = template.findResources('AWS::Events::Rule', {
      Properties: { ScheduleExpression: 'rate(5 minutes)' },
    });
    const matches = Object.values(rules).filter((rule: any) => {
      const targets = rule.Properties?.Targets ?? [];
      return targets.some((t: any) => {
        const arnRef = t.Arn?.['Fn::GetAtt']?.[0];
        return arnRef === drainFnLogicalId;
      });
    });
    expect(matches).toHaveLength(1);
  });

  test('retention sweeper (daily) and visibility drain (5 min) are two distinct rules', () => {
    const dailyRules = template.findResources('AWS::Events::Rule', {
      Properties: { ScheduleExpression: 'rate(1 day)' },
    });
    const fiveMinRules = template.findResources('AWS::Events::Rule', {
      Properties: { ScheduleExpression: 'rate(5 minutes)' },
    });
    expect(Object.keys(dailyRules)).toHaveLength(1);
    expect(Object.keys(fiveMinRules)).toHaveLength(1);
  });

  test('the Google indexing secret grant is scoped to the drain Lambda only', () => {
    const fnResources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Job visibility outbox drain — Google Indexing API notifications' },
    });
    const fnLogicalIds = Object.keys(fnResources);
    expect(fnLogicalIds).toHaveLength(1);
    const [drainFnLogicalId] = fnLogicalIds;

    // fromSecretNameV2 does not synthesize an AWS::SecretsManager::Secret
    // resource in THIS stack (it's an operator-created secret referenced by
    // name, matching the WhatsAppStack precedent) -- so the only synth-time
    // evidence of the grant is the secret name appearing in an IAM policy.
    // Assert it appears in exactly one policy, and that policy belongs to
    // the drain Lambda's role.
    const policies = template.findResources('AWS::IAM::Policy');
    const matchingPolicies = Object.entries(policies).filter(([, policy]) => {
      const policyJson = JSON.stringify((policy as any).Properties);
      return policyJson.includes('jale/referrals/google-indexing-key');
    });
    expect(matchingPolicies).toHaveLength(1);
    const [, matchingPolicy] = matchingPolicies[0];
    const roleRefs: string[] = (matchingPolicy as any).Properties.Roles.map(
      (r: any) => r.Ref ?? JSON.stringify(r),
    );

    // The drain Lambda's role is a sibling resource named after its logical
    // id with a Role suffix pattern; assert via the function's DependsOn/role
    // relationship instead of guessing the exact logical id string --
    // find the function resource and compare its Role reference.
    const drainFnRoleRef = (fnResources[drainFnLogicalId] as any).Properties.Role['Fn::GetAtt'][0];
    expect(roleRefs).toContain(drainFnRoleRef);

    // And no OTHER Lambda's role policy references the secret name.
    const otherFnLogicalIds = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id !== drainFnLogicalId);
    for (const id of otherFnLogicalIds) {
      const roleRef = (template.findResources('AWS::Lambda::Function')[id] as any).Properties.Role?.['Fn::GetAtt']?.[0];
      if (!roleRef) continue;
      expect(roleRefs).not.toContain(roleRef);
    }
  });

  test('referrals Lambda security group has no allow-all outbound egress', () => {
    const sgResources = networkTemplate.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: Match.stringLikeRegexp('referrals Lambdas') },
    });
    const sgs = Object.values(sgResources);
    expect(sgs).toHaveLength(1);
    const egress = (sgs[0] as any).Properties.SecurityGroupEgress ?? [];
    // CDK emits a synthetic "disallow all traffic" rule (0.0.0.0/255.255.255.255)
    // when allowAllOutbound is false; assert no rule allows all IPv4 on all ports.
    for (const rule of egress) {
      const isAllTraffic = rule.IpProtocol === '-1' && rule.CidrIp === '0.0.0.0/0';
      expect(isAllTraffic).toBe(false);
    }
  });

  // ── Observability: visibility-outbox-drain alarms ──────────────────────
  // The main `template` (from `buildApp()` with no `alarmTopicArn`) already
  // proves the "must still synth cleanly when the prop is absent" contract
  // for every test above; these assert the alarm resources/shape directly.

  test('creates the drain Errors alarm following the AiStack GTE/NOT_BREACHING convention', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'VisibilityOutboxDrainErrors',
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
  });

  test('creates a MetricFilter + alarm for the deliberate VisibilityOutboxDrainSkipped no-op path', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"VisibilityOutboxDrainSkipped"',
      MetricTransformations: [
        { MetricNamespace: 'Jale/Referrals', MetricName: 'VisibilityOutboxDrainSkipped', MetricValue: '1' },
      ],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'VisibilityOutboxDrainSkipped',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
  });

  test('creates the permanent-failure alarm on the Jale/Referrals EMF metric', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'VisibilityOutboxDrainPermanentFailures',
      Namespace: 'Jale/Referrals',
      MetricName: 'VisibilityOutboxDrainPermanentFailure',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    });
  });

  test('none of the three drain alarms carry an SNS action when alarmTopicArn is absent (synths cleanly)', () => {
    for (const alarmName of [
      'VisibilityOutboxDrainErrors',
      'VisibilityOutboxDrainSkipped',
      'VisibilityOutboxDrainPermanentFailures',
    ]) {
      const alarms = template.findResources('AWS::CloudWatch::Alarm', { Properties: { AlarmName: alarmName } });
      const [alarm] = Object.values(alarms) as any[];
      expect(alarm.Properties.AlarmActions).toBeUndefined();
    }
  });

  describe('with alarmTopicArn supplied', () => {
    let alarmedTemplate: Template;
    const topicArn = 'arn:aws:sns:us-east-2:123456789012:jale-referrals-alarms-test';

    beforeAll(() => {
      const { referrals } = buildApp(topicArn);
      alarmedTemplate = Template.fromStack(referrals);
    });

    test('all three drain alarms fire into the shared alarm topic', () => {
      for (const alarmName of [
        'VisibilityOutboxDrainErrors',
        'VisibilityOutboxDrainSkipped',
        'VisibilityOutboxDrainPermanentFailures',
      ]) {
        const alarms = alarmedTemplate.findResources('AWS::CloudWatch::Alarm', { Properties: { AlarmName: alarmName } });
        const [alarm] = Object.values(alarms) as any[];
        expect(alarm.Properties.AlarmActions).toEqual([topicArn]);
      }
    });

    test('does not create a new SNS topic — reuses the shared topic ARN by reference', () => {
      const topics = alarmedTemplate.findResources('AWS::SNS::Topic');
      expect(Object.keys(topics)).toHaveLength(0);
    });
  });
});
