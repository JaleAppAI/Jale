import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildJaleApp } from '../../../lib/app-composition';

/**
 * ── JaleApiStack's CloudFormation resource ceiling ──────────────────────
 *
 * CloudFormation refuses more than 500 resources in a stack, and CDK enforces
 * it at SYNTH: over the limit, `cdk synth` throws TooManyResourcesInStack and
 * the deploy never starts. That is a release blocker, not a lint — it is
 * exactly what happened at 501.
 *
 * The assertion this replaces (in `metric-filter-patterns.test.ts`) read 499
 * and passed while the real CI synth was failing at 501, because it counted a
 * hand-rolled SUBSET of the app: no MatchingStack, AdminStack, AdminCertStack,
 * BastionStack or FrontendStack, and no `crossRegionReferences: true`. So this
 * file synthesizes the REAL composition — `lib/app-composition.ts`, the same
 * function `bin/jale-app.ts` calls — with the same context the production
 * deploy workflow passes (`.github/workflows/_reusable-deploy.yml`).
 *
 * Guard rails against that failure mode recurring are asserted below: the full
 * stack list, and the cross-region export writer that only exists when
 * FrontendStack is in the app.
 */

// The context `.github/workflows/_reusable-deploy.yml` passes to `cdk synth`
// for a production deploy, with the account-specific values replaced by
// syntactically valid placeholders. None of these change the resource COUNT;
// they are here because several stacks fail closed without them.
const CI_PRODUCTION_CONTEXT: Record<string, unknown> = {
  environment: 'production',
  deletionProtection: 'true',
  emailFromAddress: 'billing@example.com',
  sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:111122223333:identity/example.com',
  sesEmailFromAddress: 'no-reply@example.com',
  sesEmailRegion: 'us-east-1',
  whatsappStatusCallbackUrl: 'https://example.com/whatsapp/status-callback',
  whatsappAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
  billingAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
  whatsappInboundV2TransportEnabled: 'true',
  // Not on the workflow's synth line — the workflow supplies these through
  // the JALE_* env vars the stacks also read. Passed as context here so the
  // test does not depend on the developer's environment.
  publicSiteBaseUrl: 'https://jaleapp.ai',
  whatsappBusinessNumber: '15551234567',
};

// `lib/app-composition.ts` reads these for every stack's `env`, exactly as the
// CDK CLI supplies them (resolved from the ambient AWS credentials/config).
// They must be SET, not absent: AdminStack references AdminCertStack across
// regions and CDK rejects a cross-region reference between env-agnostic
// stacks. The placeholder account/region pair is one that `cdk.context.json`
// already caches availability zones for, so nothing here calls AWS — and the
// resource count is identical to the real account's (verified either way at
// the time the count was 418).
const PLACEHOLDER_ACCOUNT = '111111111111';
const PLACEHOLDER_REGION = 'us-east-2';

const INFRA_ROOT = path.join(__dirname, '../../..');

// The CDK CLI merges `cdk.json`'s `context` (feature flags — several of them
// change what CDK emits) and the cached `cdk.context.json` lookups into the
// App. `new cdk.App()` in jest does NOT, so do it explicitly: without this the
// test would synthesize a DIFFERENT tree than the CLI and its count would mean
// nothing.
function cliContext(): Record<string, unknown> {
  const readJson = (file: string): Record<string, unknown> => {
    const full = path.join(INFRA_ROOT, file);
    return fs.existsSync(full)
      ? JSON.parse(fs.readFileSync(full, 'utf8'))
      : {};
  };
  const cdkJson = readJson('cdk.json');
  return {
    ...(cdkJson.context as Record<string, unknown> ?? {}),
    ...readJson('cdk.context.json'),
    ...CI_PRODUCTION_CONTEXT,
  };
}

// Every stack `bin/jale-app.ts` creates on a full production synth. Pinned so
// that dropping one from the composition — the bug that made the old
// assertion undercount — fails loudly here instead of silently shrinking the
// number this file is guarding.
const EXPECTED_STACKS = [
  'JaleAdminCertStack',
  'JaleAdminStack',
  'JaleAiStack',
  'JaleApiStack',
  'JaleAuthStack',
  'JaleBastionStack',
  'JaleBillingStack',
  'JaleDatabaseStack',
  'JaleDocumentsStack',
  'JaleFrontendStack',
  'JaleLegalStack',
  'JaleMatchingStack',
  'JaleMediaBoardStack',
  'JaleNetworkStack',
  'JaleNotificationsStack',
  'JaleReferralsStack',
  'JaleWhatsAppStack',
];

// CloudFormation's hard limit. Synthesis fails AT this number, so the gate
// sits well below it.
const CFN_MAX_RESOURCES = 500;
// 30 resources of headroom — roughly three more Lambda-backed routes with
// their CORS preflight, or one small feature. Crossing it is the signal to
// SPLIT ApiStack (a nested stack, or a second RestApi for `/worker/*`), not
// to raise this number.
const CEILING = 470;
// The number this composition ACTUALLY synthesizes to, measured with the
// production CI context above. Asserted exactly, not just against the gate,
// so that a route added without noticing shows up as a diff on this line
// instead of quietly eating the headroom: bump it deliberately, in the same
// commit that adds the routes, and only after reading the printed count.
//
// History: 501 (hard synth failure) → 431 once every method on the shared
// RestApi moved to `lambdaIntegration()` → 418 once the 13 path-only
// intermediate resources stopped building a CORS preflight nothing can reach
// (`addPathOnlyResource()`, `lib/api-integration.ts`) → 391 once four
// throttle-free sibling groups collapsed onto single variable resources
// served by dispatcher Lambdas (`lambda/lib/path-dispatch.ts`) and the dead
// `GET /worker/referrals` was deleted. Every deployed URL is unchanged; the
// `RESOLVES_TO` inventory at the bottom of this file is the proof.
// → 399 once other work on this branch added routes ahead of this one → 407
// once `GET /employer/applicants` (function, role/permission, method, CORS
// preflight) was added.
//
// DELIBERATE COUPLING: an exact count also moves when aws-cdk-lib changes what
// it emits, so an `npm update` of the CDK can fail this line with no route
// change at all. That is the intended trade — a bump here is cheap and forces
// someone to look at the diff, whereas silently absorbing +9 resources is how
// the stack reached 501 in the first place.
const MEASURED_RESOURCES = 407;

/**
 * Every `AWS::ApiGateway::Method` in the template, grouped by the resource it
 * hangs off. The key is the resource's logical id for a real
 * `AWS::ApiGateway::Resource`, or `ROOT` for a method on the RestApi's
 * implicit root (`Fn::GetAtt: [..., RootResourceId]`), which is NOT itself a
 * template resource and so cannot be counted or stripped.
 */
function methodsByResource(template: Template): Map<string, string[]> {
  const byResource = new Map<string, string[]>();
  for (const method of Object.values(
    template.findResources('AWS::ApiGateway::Method'),
  ) as Array<{ Properties: Record<string, any> }>) {
    const resourceId = method.Properties?.ResourceId;
    const key: string = resourceId?.Ref ?? (resourceId?.['Fn::GetAtt'] ? 'ROOT' : '?');
    const methods = byResource.get(key) ?? [];
    methods.push(method.Properties.HttpMethod);
    byResource.set(key, methods);
  }
  return byResource;
}

/** `/employer/settings/digest`-style path for a resource's logical id. */
function pathOf(resources: Record<string, { Properties: Record<string, any> }>, id: string): string {
  const resource = resources[id];
  if (!resource) return `?${id}`;
  const parentRef: string | undefined = resource.Properties?.ParentId?.Ref;
  const parent = parentRef ? pathOf(resources, parentRef) : '';
  return `${parent}/${resource.Properties.PathPart}`;
}

/**
 * The ten automatic cross-stack exports of the LEGACY Lambda ARNs — the
 * functions the four dispatchers replace. JaleApiStack's Methods used to
 * integrate with these functions, and CDK published one
 * `ExportsOutputFnGetAtt<ConstructId>Arn<hash>` Output per reference from the
 * producer stack.
 *
 * PHASE 1 (this commit) keeps every one of them alive while JaleApiStack stops
 * importing them, because CloudFormation refuses to delete an export that is
 * still in use and JaleApiStack — the importer — updates AFTER its producers:
 *
 *   Export JaleDocumentsStack:ExportsOutputFnGetAtt…Arn… cannot be deleted as
 *   it is in use by JaleApiStack
 *
 * PHASE 2 deletes the functions and these exports, which is safe only once the
 * deployed JaleApiStack no longer imports them. The names are pinned literally
 * because that is the whole contract: `Stack.exportValue()` must reproduce the
 * name CDK generated automatically, character for character, or the deployed
 * export is dropped anyway and the phase-1 deploy fails exactly as the
 * single-phase one would.
 */
const LEGACY_ARN_EXPORTS: Record<string, string[]> = {
  JaleDocumentsStack: [
    'JaleDocumentsStack:ExportsOutputFnGetAttEmployerWorkerDocsFunction377A9F80Arn3E5A919A',
    'JaleDocumentsStack:ExportsOutputFnGetAttEmployerWorkerProfileFunction5B634FF6Arn7DA6983C',
    'JaleDocumentsStack:ExportsOutputFnGetAttWorkerDocConfirmAuthFunction90C63799ArnEBACD514',
    'JaleDocumentsStack:ExportsOutputFnGetAttWorkerDocConfirmFunction73EEF11EArn67FB04CF',
    'JaleDocumentsStack:ExportsOutputFnGetAttWorkerDocSubmitFunction5B0EA905Arn8CA1238E',
    'JaleDocumentsStack:ExportsOutputFnGetAttWorkerDocUploadUrlAuthFunctionC4F93BBCArn7E68A9E1',
    'JaleDocumentsStack:ExportsOutputFnGetAttWorkerDocUploadUrlFunctionF5456678Arn36F00E66',
  ],
  JaleMediaBoardStack: [
    'JaleMediaBoardStack:ExportsOutputFnGetAttEmployerWorkerPostsFunction0A2C018CArn5030B70E',
    'JaleMediaBoardStack:ExportsOutputFnGetAttWorkerPostUploadUrlsFunction114A4F71Arn3BA53195',
  ],
  JaleReferralsStack: [
    'JaleReferralsStack:ExportsOutputFnGetAttWorkerReferralsLambdaFunction8D918E55Arn904B2B56',
  ],
};

describe('JaleApiStack resource ceiling (real bin/jale-app.ts composition)', () => {
  let apiTemplate: Template;
  let producerTemplates: Record<string, Template>;
  let stackIds: string[];
  let savedEnv: { account?: string; region?: string; renamePhase1?: string };

  beforeAll(() => {
    // Pinned, not inherited: a developer with a different account/region
    // exported must measure the same tree everyone else does.
    savedEnv = {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
      renamePhase1: process.env.JALE_WORKER_JOBS_RENAME_PHASE1,
    };
    process.env.CDK_DEFAULT_ACCOUNT = PLACEHOLDER_ACCOUNT;
    process.env.CDK_DEFAULT_REGION = PLACEHOLDER_REGION;
    // api-stack.ts gates the legacy `/worker/jobs/{jobId}` routes on this flag;
    // a developer with it exported would measure 12 resources fewer.
    delete process.env.JALE_WORKER_JOBS_RENAME_PHASE1;

    const app = new cdk.App({
      context: cliContext(),
      // The CLI turns version reporting on by default, which adds one
      // `AWS::CDK::Metadata` resource to every stack. `new cdk.App()` does
      // not — without this the count is 417 where the deploy sees 418, and
      // the gate would be measuring a template that never ships.
      analyticsReporting: true,
    });
    buildJaleApp(app);

    stackIds = app.node.children
      .filter((child): child is cdk.Stack => cdk.Stack.isStack(child))
      .map((stack) => stack.node.id)
      .sort();
    apiTemplate = Template.fromStack(app.node.findChild('JaleApiStack') as cdk.Stack);
    producerTemplates = Object.fromEntries(
      Object.keys(LEGACY_ARN_EXPORTS).map((id) => [
        id,
        Template.fromStack(app.node.findChild(id) as cdk.Stack),
      ]),
    );
  });

  afterAll(() => {
    if (savedEnv.account === undefined) delete process.env.CDK_DEFAULT_ACCOUNT;
    else process.env.CDK_DEFAULT_ACCOUNT = savedEnv.account;
    if (savedEnv.region === undefined) delete process.env.CDK_DEFAULT_REGION;
    else process.env.CDK_DEFAULT_REGION = savedEnv.region;
    if (savedEnv.renamePhase1 === undefined) delete process.env.JALE_WORKER_JOBS_RENAME_PHASE1;
    else process.env.JALE_WORKER_JOBS_RENAME_PHASE1 = savedEnv.renamePhase1;
  });

  it('composes the full app, not a subset', () => {
    // The old assertion's failure mode. If this list changes deliberately,
    // update it — but the ceiling number below is only meaningful while the
    // app under test is the app that deploys.
    expect(stackIds).toEqual(EXPECTED_STACKS);
  });

  it('includes the FrontendStack cross-region reference that ApiStack pays for', () => {
    // FrontendStack lives in us-east-1 and references this API, which adds a
    // Custom::CrossRegionExportWriter (plus its provider Lambda and role) to
    // JaleApiStack. The old subset app omitted FrontendStack entirely and so
    // undercounted by three.
    apiTemplate.resourceCountIs('Custom::CrossRegionExportWriter', 1);
    // Present only when the App has analytics/version reporting on, as the
    // CLI does. Its absence was a one-resource undercount.
    apiTemplate.resourceCountIs('AWS::CDK::Metadata', 1);
  });

  it(`stays at or under ${CEILING} of CloudFormation's ${CFN_MAX_RESOURCES}-resource maximum`, () => {
    const resources = apiTemplate.toJSON().Resources as Record<string, { Type: string }>;
    const total = Object.keys(resources).length;

    // Printed on every run: this is the number to quote when deciding whether
    // the next feature fits.
    // eslint-disable-next-line no-console
    console.log(`JaleApiStack resources: ${total} / ${CFN_MAX_RESOURCES} (gate ${CEILING})`);

    expect(total).toBeLessThanOrEqual(CEILING);
    // Exact, so the headroom cannot be spent by accident — and explained on
    // failure, because `Expected: 418 Received: 427` tells whoever hits it
    // nothing about what to do next.
    if (total !== MEASURED_RESOURCES) {
      throw new Error(
        `JaleApiStack synthesizes ${total} CloudFormation resources but this test `
        + `pins MEASURED_RESOURCES = ${MEASURED_RESOURCES} `
        + `(${total > MEASURED_RESOURCES ? '+' : ''}${total - MEASURED_RESOURCES}).\n`
        + 'If the new routes are intended, bump MEASURED_RESOURCES in this file in '
        + 'the same commit that adds them, and check the remaining headroom against '
        + `the ${CEILING} gate (max ${CFN_MAX_RESOURCES}).\n`
        + 'If you did NOT add routes, something else grew the stack — an aws-cdk-lib '
        + 'bump, or a helper that stopped being used. Read the synth diff before '
        + 'touching this number.',
      );
    }
  });

  // ── CORS preflight lives on exactly the resources that can be preflighted ──
  //
  // `api-stack.ts` sets `defaultCorsPreflightOptions` on the shared RestApi,
  // so CDK adds an OPTIONS MOCK method to EVERY `addResource()` node — real
  // routes and path-only intermediates alike. A browser only ever preflights
  // the URL of a request it is about to make, so an OPTIONS on a path that
  // carries no real method (`/employer`, `/worker/documents`, …) can never be
  // reached: it is a pure CloudFormation resource tax. `addPathOnlyResource()`
  // in `lib/api-integration.ts` never builds those, and these two assertions
  // are the REAL guard on it — the helper cannot verify its own claim, since
  // the node is empty at creation and the parents ApiStack exports
  // (`/public`, `/worker`, `/employer`) are attached to by downstream stacks
  // only later.

  it('gives every resource with a real method a CORS preflight', () => {
    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource') as Record<
      string,
      { Properties: Record<string, any> }
    >;
    const byResource = methodsByResource(apiTemplate);

    const missingPreflight = Object.keys(resources)
      .filter((id) => {
        const methods = byResource.get(id) ?? [];
        return methods.some((m) => m !== 'OPTIONS') && !methods.includes('OPTIONS');
      })
      .map((id) => pathOf(resources, id));

    // A real route without a preflight breaks every browser call that sends
    // Authorization or Content-Type: application/json.
    expect(missingPreflight).toEqual([]);
  });

  it('carries no resource whose ONLY method is the CORS preflight', () => {
    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource') as Record<
      string,
      { Properties: Record<string, any> }
    >;
    const byResource = methodsByResource(apiTemplate);

    const preflightOnly = Object.keys(resources)
      .filter((id) => {
        const methods = byResource.get(id) ?? [];
        return methods.length > 0 && methods.every((m) => m === 'OPTIONS');
      })
      .map((id) => pathOf(resources, id))
      .sort();

    // 13 of these existed before `addPathOnlyResource()`: /auth,
    // /auth/worker, /billing, /employer, /employer/settings,
    // /employer/workers, /employer/workers/{worker_id}, /legal, /public,
    // /public/employer-digest, /whatsapp, /worker, /worker/documents.
    // Adding an intermediate with a plain `addResource()` fails here; the fix
    // is to switch that call to `addPathOnlyResource(parent, 'seg')`, NOT a
    // carve-out in this list.
    expect(preflightOnly).toEqual([]);

    // The one preflight-only OPTIONS that legitimately remains is the
    // RestApi's implicit root ("/"): `RestApi`'s RootResource applies
    // `defaultCorsPreflightOptions` too, and the root is not an
    // `AWS::ApiGateway::Resource` in the template (methods reference it via
    // `Fn::GetAtt RootResourceId`), so it is invisible to the loop above and
    // there is no `addResource()` call to route through the helper. It costs
    // one Method.
    expect([...(byResource.get('ROOT') ?? [])].sort()).toEqual(['OPTIONS']);

    // Nothing may land in the unbucketed `?` key: a Method whose ResourceId is
    // neither a `Ref` nor a root `Fn::GetAtt` would be invisible to BOTH
    // preflight invariants above, so it must fail loudly here instead.
    expect(byResource.get('?')).toBeUndefined();
  });

  it('emits no DependsOn pointing at a resource that is not in the template', () => {
    // Template integrity, and the reason `addPathOnlyResource()` never
    // CONSTRUCTS the preflight instead of removing it afterwards.
    //
    // `Method`'s constructor registers itself with the RestApi's
    // `latestDeployment` (`node.addDependency(cfnMethod)` +
    // `addToLogicalId(...)`). Deleting the construct from the tree afterwards
    // does NOT retract that: constructs have no removeDependency API, so the
    // Deployment kept a `DependsOn` on 13 logical ids that were no longer
    // emitted. cfn-lint E3005 is an ERROR on that, and CloudFormation rejects
    // it at changeset creation — but CDK only WARNS (the
    // `@aws-cdk/core:validateAgainstDefaultRules` flag is unset), so `cdk
    // synth` and every test here passed while the production deploy would
    // have failed. Building the tree correctly in the first place is the only
    // fix; this assertion is the tripwire.
    const resources = apiTemplate.toJSON().Resources as Record<string, { DependsOn?: string | string[] }>;
    const dangling: string[] = [];
    for (const [id, resource] of Object.entries(resources)) {
      for (const target of [resource.DependsOn ?? []].flat()) {
        if (!resources[target]) dangling.push(`${id} -> ${target}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('emits exactly one Lambda::Permission per Lambda-backed method', () => {
    const json = apiTemplate.toJSON();
    const methods = Object.values(json.Resources as Record<string, any>)
      .filter((r) => r.Type === 'AWS::ApiGateway::Method'
        && r.Properties?.Integration?.Type === 'AWS_PROXY');
    const permissions = apiTemplate.findResources('AWS::Lambda::Permission');

    // CDK's default is TWO: the real stage-scoped grant, plus a
    // `.../test-invoke-stage/...` grant that only serves the API Gateway
    // console's "Test" button. At ~70 methods that console-only half is ~70
    // resources — the difference between 501 (synth fails) and today's 418.
    expect(Object.keys(permissions)).toHaveLength(methods.length);
    expect(JSON.stringify(json)).not.toContain('test-invoke-stage');
  });

  // ── Every deployed URL still resolves, with its method and authorizer ──
  //
  // Four sibling groups were collapsed onto a single variable resource each,
  // with one dispatcher Lambda switching on the path parameter
  // (`lambda/lib/path-dispatch.ts`). So half the URLs below no longer exist as
  // a path in this template at all: `/worker/documents/confirm` is served by
  // `/worker/documents/{action}`, `/worker/vault/upload-url` by the
  // `{doc_type}` node that also serves DELETE, `/worker/posts/upload-urls` by
  // `{post_id}`, and the three `/employer/workers/{worker_id}/*` reads by one
  // `{action}`.
  //
  // A "is this PathPart in the template" assertion therefore proves nothing
  // here. `resolveUrl()` below instead does what API Gateway does at request
  // time — walk the segments from the root, preferring a LITERAL child and
  // falling back to the single variable child — which is precisely the
  // behaviour the consolidation relies on. It fails loudly if a segment
  // resolves nowhere, and if a parent ever has two variable children (which
  // API Gateway rejects outright, and which is the one way a fifth
  // consolidation could break the four already here).
  //
  // The list deliberately includes the routes that must survive UNCHANGED
  // alongside the merged ones: a fumbled consolidation is likelier to break
  // `DELETE /worker/vault/{doc_type}` or `GET /worker/posts` than to lose the
  // route it was aimed at.
  type Auth = 'WorkerAuthorizer' | 'EmployerAuthorizer' | 'NONE';
  const RESOLVES_TO: Array<[method: string, url: string, auth: Auth]> = [
    // Consolidation 1 — /employer/workers/{worker_id}/{action}
    ['GET', '/employer/workers/{worker_id}/profile', 'EmployerAuthorizer'],
    ['GET', '/employer/workers/{worker_id}/documents', 'EmployerAuthorizer'],
    ['GET', '/employer/workers/{worker_id}/posts', 'EmployerAuthorizer'],
    // Consolidation 2 — /worker/documents/{action}, unauthenticated tokenized flow
    ['POST', '/worker/documents/upload-url', 'NONE'],
    ['POST', '/worker/documents/confirm', 'NONE'],
    ['POST', '/worker/documents/submit', 'NONE'],
    // Consolidation 3 — POST on the EXISTING /worker/vault/{doc_type}
    ['POST', '/worker/vault/upload-url', 'WorkerAuthorizer'],
    ['POST', '/worker/vault/confirm', 'WorkerAuthorizer'],
    // …whose DELETE and sibling GET must be untouched by it
    ['GET', '/worker/vault', 'WorkerAuthorizer'],
    ['DELETE', '/worker/vault/{doc_type}', 'WorkerAuthorizer'],
    // Consolidation 4 — POST on the EXISTING /worker/posts/{post_id}
    ['POST', '/worker/posts/upload-urls', 'WorkerAuthorizer'],
    // …and the three post routes deliberately NOT merged (see
    // worker-posts-dispatch.ts for why GET+POST did not become one ANY)
    ['GET', '/worker/posts', 'WorkerAuthorizer'],
    ['POST', '/worker/posts', 'WorkerAuthorizer'],
    ['DELETE', '/worker/posts/{post_id}', 'WorkerAuthorizer'],
    // L1.3 — the child that keeps /worker/referrals alive as a path-only node
    ['POST', '/worker/referrals/claim', 'WorkerAuthorizer'],
  ];

  /**
   * API Gateway's own path resolution, run over the synthesized template.
   * Returns the logical id of the resource a URL binds to, or 'ROOT' for '/'.
   */
  function resolveUrl(url: string): string {
    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource') as Record<
      string,
      { Properties: Record<string, any> }
    >;
    const childrenOf = (parent: string): Array<[string, string]> =>
      Object.entries(resources)
        .filter(([, resource]) => {
          const parentId = resource.Properties?.ParentId;
          // The root resource is not an AWS::ApiGateway::Resource — its
          // children point at it with Fn::GetAtt RootResourceId.
          return parent === 'ROOT'
            ? parentId?.['Fn::GetAtt'] !== undefined
            : parentId?.Ref === parent;
        })
        .map(([id, resource]) => [id, resource.Properties.PathPart as string]);

    let current = 'ROOT';
    for (const segment of url.split('/').filter(Boolean)) {
      const children = childrenOf(current);
      const literal = children.find(([, pathPart]) => pathPart === segment);
      if (literal) {
        current = literal[0];
        continue;
      }
      const variable = children.filter(([, pathPart]) => /^\{.+\}$/.test(pathPart));
      if (variable.length > 1) {
        throw new Error(
          `${url}: '${pathOf(resources, current)}' has ${variable.length} variable children `
          + `(${variable.map(([, pathPart]) => pathPart).join(', ')}). API Gateway rejects that — `
          + 'a parent may have at most ONE {…} child, which is why each consolidation reuses the '
          + "group's existing variable node instead of adding a second one.",
        );
      }
      if (variable.length === 0) {
        throw new Error(
          `${url}: segment '${segment}' resolves nowhere under `
          + `'${current === 'ROOT' ? '/' : pathOf(resources, current)}' — neither a literal child `
          + 'nor a variable one. This URL is DEAD: the frontend calls it by literal path '
          + '(frontend/src/lib/api/{worker,employer}.ts) and would get a 403 "Missing '
          + 'Authentication Token" from API Gateway.',
        );
      }
      current = variable[0][0];
    }
    return current;
  }

  it('PHASE 1: retains the ten legacy ARN exports while ApiStack stops importing them', () => {
    // The two halves of the phase-1 contract, asserted together because
    // either one alone is useless:
    //
    //   (a) every legacy export still EXISTS in its producer stack, with the
    //       exact auto-generated name the deployed template published. This
    //       is what `Stack.exportValue()` in documents-stack.ts,
    //       media-board-stack.ts and referrals-stack.ts buys. Without it the
    //       producer update fails and the release rolls back.
    //   (b) JaleApiStack no longer IMPORTS any of them — the routes really did
    //       move to the dispatchers. Without this the phase-2 deploy would hit
    //       the same in-use-export wall this commit exists to avoid, one
    //       release later.
    //
    // Phase 2 replaces this test with its mirror image: the ten names must be
    // ABSENT from the producers (and still unimported here).
    const missing: string[] = [];
    for (const [stackId, exportNames] of Object.entries(LEGACY_ARN_EXPORTS)) {
      const outputs = (producerTemplates[stackId].toJSON().Outputs ?? {}) as Record<string, any>;
      const present = new Set(
        Object.values(outputs)
          .map((output) => output?.Export?.Name)
          .filter((name): name is string => typeof name === 'string'),
      );
      for (const name of exportNames) if (!present.has(name)) missing.push(`${stackId} lost ${name}`);
    }
    expect(missing).toEqual([]);

    const apiJson = JSON.stringify(apiTemplate.toJSON());
    const stillImported = Object.values(LEGACY_ARN_EXPORTS)
      .flat()
      .filter((name) => apiJson.includes(`"Fn::ImportValue":"${name}"`));
    expect(stillImported).toEqual([]);
  });

  it('gives no resource two variable children', () => {
    // API Gateway rejects a second `{…}` child under one parent outright, and
    // it is the constraint the four consolidations are built around: three of
    // them reuse a group's EXISTING variable node ({doc_type}, {post_id},
    // {worker_id}'s new {action}) precisely because a sibling one could not
    // exist. `resolveUrl` above catches this only for a parent it happens to
    // walk with the variable fallback, which today is a handful of nodes. This
    // asserts it for the WHOLE tree, so the next consolidation cannot break
    // the four already here by adding a `{…}` beside one of them.
    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource') as Record<
      string,
      { Properties: Record<string, any> }
    >;
    const variablesByParent = new Map<string, string[]>();
    for (const resource of Object.values(resources)) {
      const pathPart: string = resource.Properties.PathPart;
      if (!/^\{.+\}$/.test(pathPart)) continue;
      const parentId = resource.Properties?.ParentId;
      const parent: string = parentId?.Ref ?? (parentId?.['Fn::GetAtt'] ? 'ROOT' : '?');
      variablesByParent.set(parent, [...(variablesByParent.get(parent) ?? []), pathPart]);
    }

    const offenders = [...variablesByParent.entries()]
      .filter(([, pathParts]) => pathParts.length > 1)
      .map(([parent, pathParts]) => `${parent === 'ROOT' ? '/' : pathOf(resources, parent)}: ${pathParts.sort().join(' + ')}`)
      .sort();

    expect(offenders).toEqual([]);
    // Sanity: the tree really does contain variable resources, so an empty
    // `offenders` means "checked and clean", not "nothing was inspected".
    expect(variablesByParent.size).toBeGreaterThan(5);
  });

  it('resolves every deployed URL to a method with an unchanged authorizer', () => {
    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource') as Record<
      string,
      { Properties: Record<string, any> }
    >;
    const methods = Object.values(apiTemplate.toJSON().Resources as Record<string, any>)
      .filter((resource) => resource.Type === 'AWS::ApiGateway::Method');

    const failures: string[] = [];
    for (const [httpMethod, url, expectedAuth] of RESOLVES_TO) {
      const resourceId = resolveUrl(url);
      const method = methods.find((candidate) => {
        const target = candidate.Properties?.ResourceId;
        const key = target?.Ref ?? (target?.['Fn::GetAtt'] ? 'ROOT' : '?');
        return key === resourceId && candidate.Properties.HttpMethod === httpMethod;
      });

      if (!method) {
        failures.push(
          `${httpMethod} ${url} -> resolved to ${pathOf(resources, resourceId)}, which has no `
          + `${httpMethod} method`,
        );
        continue;
      }
      const actualAuth: string = method.Properties.AuthorizationType === 'NONE'
        ? 'NONE'
        : (method.Properties.AuthorizerId?.Ref ?? `?${method.Properties.AuthorizationType}`);
      if (!actualAuth.startsWith(expectedAuth)) {
        failures.push(`${httpMethod} ${url} -> authorizer ${actualAuth}, expected ${expectedAuth}`);
      }
      // Every one of these is Lambda-backed; a MOCK integration would mean the
      // URL resolved onto a CORS preflight by accident.
      if (method.Properties.Integration?.Type !== 'AWS_PROXY') {
        failures.push(`${httpMethod} ${url} -> integration ${method.Properties.Integration?.Type}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('no longer serves the dead GET /worker/referrals', () => {
    // The counterpart to the assertion above: /worker/referrals survives ONLY
    // as the path-only parent of /claim.
    const byResource = methodsByResource(apiTemplate);
    expect(byResource.get(resolveUrl('/worker/referrals'))).toBeUndefined();
  });

  it('points every throttle ResourcePath at a path that still exists', () => {
    // Throttles in `api-stack.ts`'s MethodSettings are keyed by a LITERAL
    // ResourcePath string. CloudFormation does not validate them and API
    // Gateway silently ignores a setting whose path it cannot match — so a
    // consolidation that renamed a throttled path would drop the rate limit
    // with no error anywhere. None of the four groups above was throttled, and
    // this is what keeps that true for the next one.
    const stages = Object.values(apiTemplate.findResources('AWS::ApiGateway::Stage')) as Array<{
      Properties: { MethodSettings?: Array<{ ResourcePath: string; HttpMethod: string }> };
    }>;
    expect(stages).toHaveLength(1);
    const settings = stages[0].Properties.MethodSettings ?? [];
    // Sanity: an empty array would make this test vacuous.
    expect(settings.length).toBeGreaterThan(5);

    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource') as Record<
      string,
      { Properties: Record<string, any> }
    >;
    const byResource = methodsByResource(apiTemplate);
    const broken: string[] = [];
    for (const { ResourcePath, HttpMethod } of settings) {
      // A stage-wide wildcard ('/*/*') is not a resource path. There are none
      // today; exempted explicitly rather than by loosening the check.
      if (ResourcePath.includes('*')) continue;
      let resourceId: string;
      try {
        resourceId = resolveUrl(ResourcePath);
      } catch (err) {
        broken.push(`${HttpMethod} ${ResourcePath}: ${(err as Error).message}`);
        continue;
      }
      // Resolution must be EXACT, never through the variable fallback: a
      // throttle on '/public/jobs/{code}' has to name that real node.
      const resolvedPath = resourceId === 'ROOT' ? '/' : pathOf(resources, resourceId);
      if (resolvedPath !== ResourcePath) {
        broken.push(`${HttpMethod} ${ResourcePath}: resolves to ${resolvedPath}`);
        continue;
      }
      if (!(byResource.get(resourceId) ?? []).includes(HttpMethod)) {
        broken.push(`${HttpMethod} ${ResourcePath}: that resource has no ${HttpMethod} method`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('the web onboarding door still costs 8 resources', () => {
    const resources = apiTemplate.toJSON().Resources as Record<string, unknown>;
    const webDoor = Object.keys(resources).filter((id) => /Onboarding/i.test(id));
    // Two Resources, two Methods, two OPTIONS preflights, one permission per
    // Lambda-backed method. Was 10 before `allowTestInvoke: false`.
    expect(webDoor).toHaveLength(8);
  });
});
