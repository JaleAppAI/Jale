import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NetworkStack } from './stacks/network-stack';
import { DatabaseStack } from './stacks/database-stack';
import { AuthStack } from './stacks/auth-stack';
import { ApiStack } from './stacks/api-stack';
import { LegalStack } from './stacks/legal-stack';
import { MatchingStack } from './stacks/matching-stack';
import { AiStack } from './stacks/ai-stack';
import { WhatsAppStack } from './stacks/whatsapp-stack';
import { BastionStack } from './stacks/bastion-stack';
import { DocumentsStack } from './stacks/documents-stack';
import { MediaBoardStack } from './stacks/media-board-stack';
import { AdminStack } from './stacks/admin-stack';
import { AdminCertStack } from './stacks/admin-cert-stack';
import { BillingStack } from './stacks/billing-stack';
import { ReferralsStack } from './stacks/referrals-stack';
import { NotificationsStack } from './stacks/notifications-stack';
import { FrontendStack } from './stacks/frontend-stack';
import { resolveWhatsappStatusCallbackUrl } from './whatsapp-status-callback-url';

/**
 * The ONE place JaleApp's stacks are composed and wired together.
 *
 * Extracted from `bin/jale-app.ts` so tests can synthesize the REAL app
 * instead of a hand-rolled subset. `bin/jale-app.ts` is now nothing but
 * `new cdk.App()` + a call to this function, so the CDK CLI and
 * `test/unit/stacks/api-stack-resource-ceiling.test.ts` compose byte-for-byte
 * the same tree — which is the whole warrant of that test's resource-ceiling
 * gate. A ceiling assertion over a subset of these stacks undercounts and is
 * worse than none: that is exactly how JaleApiStack reached 501 resources
 * (`TooManyResourcesInStack`, a synth failure) with a green 499 assertion.
 *
 * Everything is read off `app.node.tryGetContext(...)` and `process.env`, so
 * a caller configures it exactly as the CLI does: `new cdk.App({ context })`.
 */
export function buildJaleApp(app: cdk.App): void {
  const deploymentEnvironment = app.node.tryGetContext('environment');
  if (deploymentEnvironment !== 'dev' && deploymentEnvironment !== 'production') {
    throw new Error(
      'CDK_ENVIRONMENT_REQUIRED: pass -c environment=dev or -c environment=production',
    );
  }
  const skipFrontend = app.node.tryGetContext('skipFrontend') === true
    || app.node.tryGetContext('skipFrontend') === 'true';
  const bastionOnly = app.node.tryGetContext('bastionOnly') === true
    || app.node.tryGetContext('bastionOnly') === 'true';

  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  };

  /**
   * SES configuration set that routes bounce/complaint events to the digest
   * feedback handler. Threaded as a PLAIN STRING to both stacks that need it --
   * NotificationsStack creates the configuration set and the SNS event
   * destination, BillingStack tags the outgoing message with it -- deliberately
   * NOT as a CDK reference: BillingStack is instantiated before
   * NotificationsStack (it has to be; NotificationsStack consumes
   * api.publicResource), and a real cross-stack reference in this direction
   * would be a dependency cycle. A literal both sides compute independently has
   * no ordering constraint at all.
   *
   * OPTIONAL on purpose. Absent (`cdk synth` with no -c sesConfigurationSetName)
   * means: no configuration set, no event destination, no feedback Lambda, and a
   * sweeper that sends without the X-SES-CONFIGURATION-SET header. Mail still
   * goes out; nothing listens for bounces. There is no baked default, because a
   * configuration-set name is account- and region-global and a hardcoded one
   * would collide between dev and production.
   *
   * Resolved from -c first, then JALE_SES_CONFIGURATION_SET_NAME, same shape as
   * ReferralsStack's publicSiteBaseUrl. The EMPTY STRING has to mean "absent",
   * not "a set named ''": the production workflow always passes the flag, as
   * `-c sesConfigurationSetName="$JALE_SES_CONFIGURATION_SET_NAME"`, and an
   * unset GitHub `vars.` entry expands to the empty string. Nullish coalescing
   * alone would keep that '' and wire the whole feedback lane to a nameless
   * configuration set, so both sources go through emptyToUndefined().
   */
  function emptyToUndefined(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  const sesConfigurationSetName = emptyToUndefined(app.node.tryGetContext('sesConfigurationSetName'))
    ?? emptyToUndefined(process.env.JALE_SES_CONFIGURATION_SET_NAME);

  const network = new NetworkStack(app, 'JaleNetworkStack', { env });

  const database = new DatabaseStack(app, 'JaleDatabaseStack', {
    env,
    network,
  });

  // BastionStack - throwaway host for DB migrations & ad-hoc psql. It can be
  // synthesized alone with `-c bastionOnly=true` to avoid unrelated Lambda bundling.
  const bastion = new BastionStack(app, 'JaleBastionStack', {
    env,
    vpc: network.vpc,
    // rdsSg is passed in so the ingress rule can be created INSIDE
    // BastionStack, avoiding a cyclic NetworkStack <-> BastionStack dependency.
    rdsSg: network.rdsSg,
  });

  // Grant the bastion's instance role read on the internal DB secrets.
  // grantRead adds IAM policy statements to the bastion role, referencing the
  // secret ARNs via cross-stack imports - no cycle: BastionStack -> DatabaseStack.
  database.dbSecret.grantRead(bastion.bastionHost.instance.role);
  database.matchingDbSecret.grantRead(bastion.bastionHost.instance.role);
  database.aiDbSecret.grantRead(bastion.bastionHost.instance.role);
  database.adminConsoleDbSecret.grantRead(bastion.bastionHost.instance.role);
  database.billingDbSecret.grantRead(bastion.bastionHost.instance.role);
  database.referralsDbSecret.grantRead(bastion.bastionHost.instance.role);

  // Bastion needs scoped access to internal DB role secrets used by migration and
  // runbook operations. The WhatsApp migration script creates/updates its secret;
  // the matching secret is generated by CDK and used when setting that role password.
  bastion.bastionHost.instance.role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:TagResource',
      ],
      resources: [
        `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:jale/whatsapp/db*`,
        `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:jale/matching/db*`,
        `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:jale/ai/db*`,
        `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:jale/admin-console/db*`,
        `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:jale/billing/db*`,
        `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:jale/referrals/db*`,
      ],
    }),
  );

  if (!bastionOnly) {
  const auth = new AuthStack(app, 'JaleAuthStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
  });

  const ai = new AiStack(app, 'JaleAiStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    aiDbSecret: database.aiDbSecret,
    // Same monitored topic as the WhatsApp lane so the scorer alarms
    // actually page someone (they previously had no action attached).
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
  });

  const matching = new MatchingStack(app, 'JaleMatchingStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    matchingDbSecret: database.matchingDbSecret,
  });

  // Required in every environment that sends WhatsApp messages: Twilio signs
  // its delivery-status callback against this exact URL, and both ApiStack's
  // employer-conversations Lambdas and WhatsAppStack's senders rely on it.
  // Resolved once here (fail closed at synth) instead of each stack silently
  // defaulting to '' when absent.
  const whatsappStatusCallbackUrl = resolveWhatsappStatusCallbackUrl(app);

  const api = new ApiStack(app, 'JaleApiStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    workerPool: auth.workerPool,
    employerPool: auth.employerPool,
    candidateMaterializationQueue: matching.candidateMaterializationQueue,
    employerCandidateRerankQueue: matching.employerCandidateRerankQueue,
    aliasGeneratorFn: ai.aliasGeneratorFn.function,
    whatsappStatusCallbackUrl,
    // FrontendStack lives in us-east-1 (CloudFront ACM requirement) and
    // references this API. Enable cross-region exports.
    crossRegionReferences: true,
  });

  const billing = new BillingStack(app, 'JaleBillingStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    billingLambdaSg: network.billingLambdaSg,
    billingDbSecret: database.billingDbSecret,
    appDbSecret: database.dbSecret,
    api: api.api,
    employerAuthorizer: api.employerAuthorizer,
    employerResource: api.employerResource,
    emailConfigurationSetName: sesConfigurationSetName,
  });

  new ReferralsStack(app, 'JaleReferralsStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    referralsLambdaSg: network.referralsLambdaSg,
    referralsDbSecret: database.referralsDbSecret,
    appDbSecret: database.dbSecret,
    api: api.api,
    publicResource: api.publicResource,
    workerAuthorizer: api.workerAuthorizer,
    workerResource: api.workerResource,
    workerJobResource: api.workerJobResource,
    employerAuthorizer: api.employerAuthorizer,
    employerJobResource: api.employerJobResource,
    // Same shared alarm topic as AiStack/WhatsAppStack -- see ReferralsStack's
    // alarmTopicArn prop doc for why this stack does NOT fail closed like
    // those two when the context/env var is absent.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
  });

  // NotificationsStack -- employer daily-digest producer plus the
  // unauthenticated one-click unsubscribe route. Must come AFTER ApiStack: it
  // consumes api.publicResource, and its route's Method resource lands in the
  // ApiStack template (same relationship ReferralsStack has).
  //
  // No dedicated security group or role secret: the producer is DB-only and runs
  // as jale_admin, so it reuses network.lambdaSg and database.dbSecret exactly
  // like Auth/Ai/Matching. See the stack header for why that is deliberate.
  const notifications = new NotificationsStack(app, 'JaleNotificationsStack', {
    env,
    vpc: network.vpc,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    publicResource: api.publicResource,
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
    emailConfigurationSetName: sesConfigurationSetName,
  });

  // The one ordering constraint the literal-threading above does NOT give us for
  // free. The name is shared, but the SES configuration set is a real resource
  // that only NotificationsStack creates, and BillingStack's sweeper starts
  // naming it the moment EMAIL_CONFIGURATION_SET is set: sending against a set
  // that does not exist yet fails with ConfigurationSetDoesNotExist, which burns
  // outbox attempts on every queued digest until the other stack lands. Neither
  // stack references the other, so this is a pure ordering edge with no cycle.
  // Only added when the name is supplied -- with no configuration set there is
  // nothing to order, and the two stacks stay independent as before.
  //
  // TWO CAVEATS, both accepted rather than defended against:
  //   * `cdk deploy --exclusively` IGNORES this edge. It is the documented use
  //     of the deploy workflow's `cdk-extra-args` input, so a BillingStack-only
  //     `--exclusively` deploy with the name set re-opens the
  //     ConfigurationSetDoesNotExist window. Nothing in CDK can prevent that;
  //     the ordering has to be respected by whoever passes the flag.
  //   * The everyday path does not depend on this edge anyway:
  //     deploy-production.yml's `full_stack_list` already lists
  //     JaleNotificationsStack BEFORE JaleBillingStack. The dependency exists to
  //     make that ordering explicit rather than incidental to the list's order,
  //     and to hold for scoped deploys that contain both stacks.
  //
  // The cost of the edge: with the name set, a BillingStack deploy is coupled to
  // NotificationsStack succeeding. Deliberate -- a sweeper that cannot send is a
  // worse outcome than a billing deploy that waits.
  if (sesConfigurationSetName) {
    billing.addDependency(notifications, 'sweeper sends with a configuration set this stack creates');
  }

  new LegalStack(app, 'JaleLegalStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    api: api.api,
    dualAuthorizer: api.dualAuthorizer,
  });

  // DocumentsStack is instantiated before WhatsAppStack so the processor
  // lambda can be granted put access to the documents bucket (Task 12).
  // DocumentsStack only depends on network/api/dbSecret (all already
  // available above) — it does not consume anything from WhatsAppStack, so
  // this ordering introduces no cycle.
  const documents = new DocumentsStack(app, 'JaleDocumentsStack', {
    env,
    network,
    api,
    dbSecret: database.dbSecret,
    allowedOrigin: app.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai',
    requiredTosVersion: app.node.tryGetContext('requiredTosVersion') ?? 'v1.0',
  });

  // Captured (not just instantiated): MediaBoardStack below consumes
  // `whatsapp.mediaBucket` — that dependency makes ordering load-bearing,
  // this stack must be instantiated before MediaBoardStack.
  const whatsapp = new WhatsAppStack(app, 'JaleWhatsAppStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    workerPool: auth.workerPool,
    api: api.api,
    // S22 R2-C23: the web onboarding door hangs `/worker/onboarding*` off
    // ApiStack's own `/worker` resource and reuses its worker authorizer.
    workerResource: api.workerResource,
    // S23 L2.4: the stage-2 details door hangs
    // `/worker/applications/{applicationId}*` off ApiStack's own
    // `/worker/applications` resource, for the same reason — it needs THIS
    // stack's `jale/whatsapp/db` secret.
    workerApplicationsResource: api.workerApplicationsResource,
    workerAuthorizer: api.workerAuthorizer,
    workerRerankQueue: matching.workerRerankQueue,
    questionGeneratorFn: ai.questionGeneratorFn.function,
    aliasGeneratorFn: ai.aliasGeneratorFn.function,
    trustAssessmentQueue: ai.trustAssessmentQueue,
    trustExtractionQueue: ai.trustExtractionQueue,
    statusCallbackUrl: whatsappStatusCallbackUrl,
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
    documentsBucket: documents.bucket,
  });

  new MediaBoardStack(app, 'JaleMediaBoardStack', {
    env,
    network,
    api,
    dbSecret: database.dbSecret,
    mediaBucket: whatsapp.mediaBucket,
    allowedOrigin: app.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai',
    requiredTosVersion: app.node.tryGetContext('requiredTosVersion') ?? 'v1.0',
    // Same shared alarm topic as AiStack/WhatsAppStack/ReferralsStack so the
    // create-lambda's moderation fail-open alarm (I2, final-review) actually
    // pages someone.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
  });

  // AdminStack - secure internal ops console at admin.jaleapp.ai.
  //
  // The admin Lambda joins the shared VPC and reaches RDS, so AdminStack runs in
  // the main region. CloudFront requires its ACM certificate in us-east-1, so a
  // certificate-only stack owns it and passes the ARN across regions.
  const adminDomainName = app.node.tryGetContext('domainName') ?? 'jaleapp.ai';
  const adminHostedZoneId = app.node.tryGetContext('hostedZoneId') ?? 'Z038537639YVI3ID7S5S3';

  const adminCert = new AdminCertStack(app, 'JaleAdminCertStack', {
    env: { account: env.account, region: 'us-east-1' },
    crossRegionReferences: true,
    domainName: adminDomainName,
    hostedZoneId: adminHostedZoneId,
  });

  new AdminStack(app, 'JaleAdminStack', {
    env,
    crossRegionReferences: true,
    domainName: adminDomainName,
    hostedZoneId: adminHostedZoneId,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    adminDbSecret: database.adminConsoleDbSecret,
    certificate: adminCert.certificate,
    webAclArn: adminCert.webAclArn,
  });

  // FrontendStack — Lambda + CloudFront + Route 53 for jaleapp.ai
  // Deployed to us-east-1 because CloudFront ACM certificates must live there.
  // Pass surveyOriginDomain via context to enable /survey/* routing to Amplify.
  //
  // NEXT_PUBLIC_* values must be present at build time (baked into JS bundle).
  // They can come from:
  //   1. CDK context: -c workerPoolId=us-east-1_xxx -c workerClientId=xxx ...
  //   2. Process env: $env:JALE_WORKER_POOL_ID = '...'
  // For local Docker smoke tests, set them via $env:* in PowerShell.
  const ctx = (key: string, envVar?: string): string =>
    app.node.tryGetContext(key) ?? (envVar ? process.env[envVar] : undefined) ?? '';

  if (!skipFrontend) {
    const apiOriginDomainName = ctx('apiOriginDomainName', 'JALE_API_ORIGIN_DOMAIN_NAME')
      || `${api.api.restApiId}.execute-api.${env.region}.amazonaws.com`;
    const apiStageName = ctx('apiStageName', 'JALE_API_STAGE_NAME')
      || app.node.tryGetContext('environment')
      || 'dev';

    const frontend = new FrontendStack(app, 'JaleFrontendStack', {
      env: { account: env.account, region: 'us-east-1' },
      apiOriginDomainName,
      apiStageName,
      domainName: app.node.tryGetContext('domainName') ?? 'jaleapp.ai',
      hostedZoneId: app.node.tryGetContext('hostedZoneId') ?? 'Z038537639YVI3ID7S5S3',
      surveyOriginDomain: app.node.tryGetContext('surveyOriginDomain'),
      workerPoolId: ctx('workerPoolId', 'JALE_WORKER_POOL_ID'),
      workerClientId: ctx('workerClientId', 'JALE_WORKER_CLIENT_ID'),
      employerPoolId: ctx('employerPoolId', 'JALE_EMPLOYER_POOL_ID'),
      employerClientId: ctx('employerClientId', 'JALE_EMPLOYER_CLIENT_ID'),
      crossRegionReferences: true,
    });
  }
  }
}
