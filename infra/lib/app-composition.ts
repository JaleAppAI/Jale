import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NetworkStack } from './stacks/network-stack';
import { DatabaseStack, engineDefaultLibraries } from './stacks/database-stack';
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
import { ReportsStack } from './stacks/reports-stack';
import { AuditArchiveStack } from './stacks/audit-archive-stack';
import { AuditEdgeStack, EDGE_STACK_IDS, auditEdgeRegions } from './stacks/audit-edge-stack';
import { AuditStack, grantAuditFallback, grantOpsCommandOutput, isDatabaseFunction } from './stacks/audit-stack';
import { dbLoginSecretName, defaultAccessManifest, preparedSecretLogins, setAppAccessManifest } from './constructs/db-login-secrets';
import type { AccessManifest } from '../db/access/access-manifest';
import { resolveWhatsappStatusCallbackUrl } from './whatsapp-status-callback-url';
import { resolveWhatsappBusinessNumber } from './whatsapp-business-number';

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
 * The one exception is `options.accessManifest`, which only a test passes:
 * the CLI always composes against the checked-in access manifest.
 */
export interface JaleAppOptions {
  /**
   * The access manifest (`infra/db/access`) that the ops-host secret access,
   * the posture check and every workload's login binding are derived from.
   * Defaults to the checked-in one.
   */
  readonly accessManifest?: AccessManifest;
}

export function buildJaleApp(app: cdk.App, options: JaleAppOptions = {}): void {
  const accessManifest = options.accessManifest ?? defaultAccessManifest();
  // Before any stack: each `dedicatedDbLogin` in this app checks its login
  // against this same manifest.
  setAppAccessManifest(app, accessManifest);
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
    accessManifest,
    // The same monitored ops topic the other stacks' alarms use.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
    // Required in production, where synth fails without the pre-check value.
    auditPreloadDefault: engineDefaultLibraries(app),
  });

  // The audit system. JaleAuditStack comes right after the
  // database: it creates the fallback group every database Lambda writes
  // attempt events to when the database write fails, so every stack holding
  // such a Lambda deploys after it (the dependencies at the end of this
  // function). It holds Lambdas, so `bastionOnly` leaves it out, like every
  // other stack with bundling.
  let audit: AuditStack | undefined;
  if (!bastionOnly) {
    const auditArchive = new AuditArchiveStack(app, 'JaleAuditArchiveStack', { env });
    audit = new AuditStack(app, 'JaleAuditStack', {
      env,
      network,
      auditKeyArn: auditArchive.key.keyArn,
      // The sentinel's master-secret rule names the secret; it is granted nothing.
      masterSecretArn: database.dbSecret.secretArn,
      auditEngineWindow: database.auditEngineWindow,
      // From window deploy 2 the engine log group is named after the
      // instance, which makes this stack depend on the database stack.
      dbInstanceIdentifier: database.auditEngineWindow >= 2 ? database.dbInstance.instanceIdentifier : undefined,
    });
  }

  // BastionStack - throwaway host for DB migrations & ad-hoc psql. It can be
  // synthesized alone with `-c bastionOnly=true` to avoid unrelated Lambda bundling.
  const bastion = new BastionStack(app, 'JaleBastionStack', {
    env,
    vpc: network.vpc,
    // rdsSg is passed in so the ingress rule can be created INSIDE
    // BastionStack, avoiding a cyclic NetworkStack <-> BastionStack dependency.
    rdsSg: network.rdsSg,
    // F23: optional, and absent on the `deploy-bastion.sh` path, which
    // synthesizes this stack alone with no alarm context.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
  });

  // Grant the bastion's instance role read on the internal DB secrets.
  // grantRead adds IAM policy statements to the bastion role, referencing the
  // secret ARNs via cross-stack imports - no cycle: BastionStack -> DatabaseStack.
  //
  // The ops host is the ONLY principal that can read the master secret: no
  // runtime workload connects as the master, so migrations and the posture
  // control are its only uses.
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

  // The dedicated least-privilege logins' secrets are created by the ops
  // host's credential preparation (`run-migrations.sh --prepare-logins`),
  // which creates a missing secret, or re-reads an existing one to re-sync the
  // login's password from it. It never overwrites a value, so there is no
  // PutSecretValue here. The logins are the access manifest's prepared-secret
  // set, the one the preparation reads too, and the names come from the same
  // helper the stacks import them with, so none of the three can drift.
  bastion.bastionHost.instance.role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ],
      resources: preparedSecretLogins(accessManifest).map((login) =>
        `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:${dbLoginSecretName(login)}*`),
    }),
  );
  // Run Command output from the ops host goes to the audit ops-command group,
  // by its fixed name (the group lives in JaleAuditStack).
  grantOpsCommandOutput(bastion.bastionHost.instance.role);

  // Passwords are generated by AWS, on the ops host, and never seen. This
  // action has no resource form, so '*' is the only expressible grant; it
  // reads and writes nothing.
  bastion.bastionHost.instance.role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetRandomPassword'],
      resources: ['*'],
    }),
  );

  if (!bastionOnly) {
  const auth = new AuthStack(app, 'JaleAuthStack', {
    env,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    // The same monitored ops topic the other stacks' alarms use.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
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
    matchingDbSecret: database.matchingDbSecret,
    dbEndpointAddress: database.dbEndpoint,
    dbEndpointPort: database.dbPort,
    dbName: database.dbName,
    // The same monitored ops topic the other stacks' alarms use.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
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
  // No dedicated security group: it reuses network.lambdaSg like
  // Auth/Ai/Matching. Its Lambdas import their own dedicated login secrets.
  // See the stack header for why that is deliberate.
  const notifications = new NotificationsStack(app, 'JaleNotificationsStack', {
    env,
    vpc: network.vpc,
    lambdaSg: network.lambdaSg,
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
    api: api.api,
    dualAuthorizer: api.dualAuthorizer,
  });

  // DocumentsStack is instantiated before WhatsAppStack so the processor
  // lambda can be granted put access to the documents bucket (Task 12).
  // DocumentsStack only depends on network/api (both already available
  // above) — it does not consume anything from WhatsAppStack, so this
  // ordering introduces no cycle.
  const documents = new DocumentsStack(app, 'JaleDocumentsStack', {
    env,
    network,
    api,
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
    mediaBucket: whatsapp.mediaBucket,
    // Both buckets: MediaBoardStack owns the employer-worker-detail dispatcher
    // (GET /employer/workers/{worker_id}/{profile|documents|posts}), whose one
    // IAM role must read the documents bucket AND the media bucket. It cannot
    // live in DocumentsStack — that stack would then need `whatsapp.
    // mediaBucket` while WhatsAppStack already consumes `documents.bucket`,
    // which is a cycle. This direction is acyclic: DocumentsStack ->
    // WhatsAppStack -> MediaBoardStack, with MediaBoardStack importing from
    // both.
    documentsBucket: documents.bucket,
    allowedOrigin: app.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai',
    requiredTosVersion: app.node.tryGetContext('requiredTosVersion') ?? 'v1.0',
    // Same shared alarm topic as AiStack/WhatsAppStack/ReferralsStack so the
    // create-lambda's moderation fail-open alarm (I2, final-review) actually
    // pages someone.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
  });

  // ReportsStack -- report a problem. After ApiStack: its routes hang off the
  // shared RestApi, so their Methods land in the ApiStack template and ApiStack
  // depends on this stack (the same relationship ReferralsStack has). Before
  // AdminStack, whose Lambda reads the report images.
  const reports = new ReportsStack(app, 'JaleReportsStack', {
    env,
    network,
    api,
    allowedOrigin: app.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai',
    workerUserPoolId: auth.workerPool.userPool.userPoolId,
    employerUserPoolId: auth.employerPool.userPool.userPoolId,
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

  const adminStack = new AdminStack(app, 'JaleAdminStack', {
    env,
    crossRegionReferences: true,
    domainName: adminDomainName,
    hostedZoneId: adminHostedZoneId,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    adminDbSecret: database.adminConsoleDbSecret,
    reportImagesBucket: reports.imagesBucket,
    reportImagesKey: reports.imagesKey,
    // Attachments workers send in WhatsApp support mode; the console reads them.
    supportMediaBucket: whatsapp.supportMediaBucket,
    supportMediaKey: whatsapp.supportMediaKey,
    certificate: adminCert.certificate,
    webAclArn: adminCert.webAclArn,
    // The same monitored ops topic the other stacks' alarms use.
    alarmTopicArn: app.node.tryGetContext('whatsappAlarmTopicArn'),
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

    // Same context key / env var ReferralsStack reads for its own wa.me deep
    // link (whatsappBusinessNumber / JALE_WHATSAPP_BUSINESS_NUMBER) — one
    // operator-set value, shared, fail-closed resolution — see
    // resolveWhatsappBusinessNumber's doc comment. Deliberately NOT built
    // from `ctx(...)` (which defaults to '' and never throws): this value is
    // required, exactly like ReferralsStack's copy, and the frontend's
    // /whatsapp route must never construct a broken wa.me URL.
    const whatsappBusinessNumber = resolveWhatsappBusinessNumber(app, 'FrontendStack');

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
      whatsappBusinessNumber,
      // The admin distribution's 5xx alarm lives in this us-east-1 stack, where
      // CloudFront publishes its metrics. With skipFrontend there is no such
      // alarm.
      adminDistributionId: adminStack.distribution.distributionId,
      crossRegionReferences: true,
    });
  }

  // Events the audit alerts need are also recorded outside the main region:
  // IAM changes and global-endpoint sign-ins and role assumptions in
  // us-east-1, root sign-ins in us-west-2 too. An edge stack in each forwards
  // them to the main region's default bus.
  for (const region of auditEdgeRegions(env.region ?? '')) {
    new AuditEdgeStack(app, EDGE_STACK_IDS[region], {
      env: { account: env.account, region },
      mainRegion: env.region ?? '',
    });
  }

  // The sentinel identifies the app's own roles and functions by the exact
  // names of the app's stacks, which CloudFormation puts first in each.
  audit?.sentinel.function.addEnvironment('AUDIT_APP_STACKS', app.node.children
    .filter((child): child is cdk.Stack => cdk.Stack.isStack(child))
    .map((stack) => stack.stackName)
    .sort()
    .join(','));
  }

  // Every database Lambda, and the admin Lambda, gets the audit fallback
  // group, whichever stack it is in. Applied here, once every
  // stack exists, so no stack has to remember it. The posture check's stack
  // is the database stack itself, which the audit stack may depend on, so it
  // takes no ordering edge.
  const fallbackWriters = new Set<cdk.Stack>();
  // Database functions with a fixed name: their role sessions carry that
  // name instead of the stack's, so the sentinel knows them by it.
  const fixedNameFunctions: string[] = [];
  for (const construct of app.node.findAll()) {
    if (!(construct instanceof lambda.Function) || !isDatabaseFunction(construct)) continue;
    grantAuditFallback(construct);
    fallbackWriters.add(cdk.Stack.of(construct));
    const fixedName = (construct.node.defaultChild as lambda.CfnFunction).functionName;
    if (typeof fixedName === 'string' && !cdk.Token.isUnresolved(fixedName)) {
      fixedNameFunctions.push(`${cdk.Stack.of(construct).stackName}/${fixedName}`);
    }
  }
  audit?.sentinel.function.addEnvironment('AUDIT_FIXED_FUNCTIONS', fixedNameFunctions.sort().join(','));
  if (audit) {
    for (const stack of fallbackWriters) {
      if (stack === audit || stack === database) continue;
      stack.addDependency(audit, 'its functions write attempt events to the audit fallback group');
    }
  }
}
