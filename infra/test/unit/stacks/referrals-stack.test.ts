import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { ReferralsStack } from '../../../lib/stacks/referrals-stack';

describe('ReferralsStack', () => {
  let template: Template;
  let dbTemplate: Template;
  let apiTemplate: Template;
  let networkTemplate: Template;

  function buildApp() {
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
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
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
      workerAuthorizer: api.workerAuthorizer,
      workerResource: api.workerResource,
      workerJobResource: api.workerJobResource,
      employerAuthorizer: api.employerAuthorizer,
      employerJobResource: api.employerJobResource,
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

  test('worker-referrals Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker referral history endpoint',
    });
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

  test('worker-referrals Lambda has DB_SECRET_ARN and PUBLIC_SITE_BASE_URL but NOT REFERRALS_DB_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Worker referral history endpoint' },
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

    for (const description of ['Worker job share-link minting endpoint', 'Worker referral history endpoint']) {
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

  test('GET /worker/referrals is protected by WorkerAuthorizer', () => {
    expect(authorizationTypeForLambda('Worker referral history endpoint')).toBe('COGNITO_USER_POOLS');
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
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
    expect(env).toHaveProperty('REQUIRED_TOS_VERSION');
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

  test('only the public-job Lambda reads the visitor-salt secret', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Public job read endpoint (unauthenticated)',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          REFERRAL_VISITOR_SALT_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
    // And no other Lambda gets the ARN.
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
    for (const pathPart of ['public', 'jobs', '{code}', 'apply-intent']) {
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
});
