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
// resource count is identical to the real account's (verified: 431 either
// way).
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

describe('JaleApiStack resource ceiling (real bin/jale-app.ts composition)', () => {
  let apiTemplate: Template;
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
      // not — without this the count is 430 where the deploy sees 431, and
      // the gate would be measuring a template that never ships.
      analyticsReporting: true,
    });
    buildJaleApp(app);

    stackIds = app.node.children
      .filter((child): child is cdk.Stack => cdk.Stack.isStack(child))
      .map((stack) => stack.node.id)
      .sort();
    apiTemplate = Template.fromStack(app.node.findChild('JaleApiStack') as cdk.Stack);
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
    // Measured 2026-08-29 with the production CI context: 431. It was 501 —
    // a hard synth failure — until every method on the shared RestApi moved
    // to `lambdaIntegration()` (`lib/api-integration.ts`).
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
    // resources — the difference between 501 (synth fails) and 431.
    expect(Object.keys(permissions)).toHaveLength(methods.length);
    expect(JSON.stringify(json)).not.toContain('test-invoke-stage');
  });

  it('the web onboarding door still costs 8 resources', () => {
    const resources = apiTemplate.toJSON().Resources as Record<string, unknown>;
    const webDoor = Object.keys(resources).filter((id) => /Onboarding/i.test(id));
    // Two Resources, two Methods, two OPTIONS preflights, one permission per
    // Lambda-backed method. Was 10 before `allowTestInvoke: false`.
    expect(webDoor).toHaveLength(8);
  });
});
