import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface ReferralsStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  /** Dedicated referrals security group (referralsLambdaSg from NetworkStack) */
  readonly referralsLambdaSg: ec2.ISecurityGroup;
  /** jale/referrals/db secret (CDK-created in DatabaseStack) — jale_public_jobs role ONLY */
  readonly referralsDbSecret: secretsmanager.ISecret;
  /**
   * App DB credential (jale_admin role) — same secret ApiStack Lambdas use.
   * jale_public_jobs is a restricted, unauthenticated-path role: column-scoped
   * GRANTs plus the jobs_public_read RLS policy (migration 056), nothing more.
   * The two worker-authenticated Lambdas (worker-job-share, worker-referrals)
   * read/write tables whose owner RLS policies are TO jale_admin, so they must
   * use this credential, not referralsDbSecret.
   */
  readonly appDbSecret: secretsmanager.ISecret;
  /** Shared REST API from ApiStack */
  readonly api: apigateway.RestApi;
  /** Worker Cognito authorizer from ApiStack */
  readonly workerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  /** /worker resource from ApiStack — worker-referrals hangs off it */
  readonly workerResource: apigateway.Resource;
  /**
   * /worker/jobs/{jobId} resource from ApiStack — worker-job-share hangs off
   * it. Reused rather than re-declared: see the comment on ApiStack's
   * workerJobResource export for why a second {jobId}-shaped resource cannot
   * be created here.
   *
   * Undefined during a phase-1 rename deploy (-c workerJobsRenamePhase1=true):
   * the share route is skipped for that one deploy and restored in phase 2.
   */
  readonly workerJobResource?: apigateway.Resource;
  /** Employer Cognito authorizer from ApiStack */
  readonly employerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  /**
   * /employer/jobs/{jobId} resource from ApiStack — the public-listing consent
   * toggle hangs off it. Same reuse-don't-redeclare rule as workerJobResource.
   */
  readonly employerJobResource: apigateway.Resource;
}

/**
 * ReferralsStack — worker-to-worker job referrals.
 *
 * Routes:
 *   GET  /public/jobs                            → public-jobs-list Lambda (UNAUTHENTICATED)
 *   GET  /public/jobs/{code}                    → public-job Lambda (UNAUTHENTICATED)
 *   POST /public/jobs/{code}/apply-intent        → public-job-apply-intent Lambda (UNAUTHENTICATED)
 *   POST /worker/jobs/{jobId}/share               → worker-job-share Lambda (worker auth)
 *   GET  /worker/referrals                       → worker-referrals Lambda (worker auth)
 *   POST /worker/referrals/claim                 → worker-referral-claim Lambda (worker auth)
 *   POST /employer/jobs/{jobId}/share             → employer-job-share Lambda (employer auth)
 *
 * Secret isolation:
 *   public-job              : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   public-jobs-list         : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   public-job-apply-intent : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   worker-job-share         : DB_SECRET_ARN (app DB / jale_admin) only
 *   worker-referrals         : DB_SECRET_ARN (app DB / jale_admin) only
 *   worker-referral-claim    : DB_SECRET_ARN (app DB / jale_admin) only
 *   employer-job-share       : DB_SECRET_ARN (app DB / jale_admin) only
 *   visibility-outbox-drain  : DB_SECRET_ARN (app DB / jale_admin) plus the
 *                              read-only jale/referrals/google-indexing-key secret
 *
 * Per the recorded BillingStack correction (applies here too): user-facing
 * Lambdas use appDbSecret (jale_admin) because owner RLS policies are TO
 * jale_admin. Only the unauthenticated public read/apply-intent path uses the
 * restricted jale_public_jobs role.
 *
 * Per-method throttles for the two /public/jobs routes live in ApiStack's
 * single centralized MethodSettings array — this stack must NOT call
 * addPropertyOverride('MethodSettings').
 */
export class ReferralsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ReferralsStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';

    // Required — worker-job-share.ts and worker-referrals.ts both return 500
    // (share_url_misconfigured) without a valid absolute URL, so fail closed
    // at synth rather than deploying a Lambda that can never succeed.
    const publicSiteBaseUrlRaw = this.node.tryGetContext('publicSiteBaseUrl')
      ?? process.env.JALE_PUBLIC_SITE_BASE_URL;
    if (!publicSiteBaseUrlRaw) {
      throw new Error(
        'ReferralsStack requires publicSiteBaseUrl context (or JALE_PUBLIC_SITE_BASE_URL env var) — '
        + 'pass -c publicSiteBaseUrl=https://jaleapp.ai',
      );
    }
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(publicSiteBaseUrlRaw);
    } catch {
      throw new Error('publicSiteBaseUrl must be a valid absolute http(s) URL');
    }
    if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
      throw new Error('publicSiteBaseUrl must be a valid absolute http(s) URL');
    }
    const publicSiteBaseUrl = publicSiteBaseUrlRaw.replace(/\/+$/, '');

    // Required — public-job-apply-intent.ts builds the wa.me deep link from
    // this number on every successful mint; there is no fallback.
    const whatsappBusinessNumber = this.node.tryGetContext('whatsappBusinessNumber')
      ?? process.env.JALE_WHATSAPP_BUSINESS_NUMBER;
    if (!whatsappBusinessNumber) {
      throw new Error(
        'ReferralsStack requires whatsappBusinessNumber context (or JALE_WHATSAPP_BUSINESS_NUMBER env var) — '
        + 'pass -c whatsappBusinessNumber=15551234567 (E.164, no leading +)',
      );
    }

    // The visitor salt lives in Secrets Manager, NOT a Lambda env var: an env
    // var lands in the CloudFormation template, cdk diff output, and every
    // lambda:GetFunctionConfiguration response, and this salt is the only
    // thing making hashVisitor(salt, ip, userAgent) non-invertible — the IP+UA
    // input space is small enough to brute-force once the salt is known.
    // Auto-generated; rotating it only resets open de-duplication for the
    // 30-minute window, which is harmless.
    const visitorSaltSecret = new secretsmanager.Secret(this, 'ReferralVisitorSaltSecret', {
      secretName: 'jale/referrals/visitor-salt',
      description: 'Salt for the public job page visitor hash (IP+UA de-duplication only)',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    const lambdaProps = {
      vpc: props.vpc,
      securityGroups: [props.referralsLambdaSg],
    };

    // ── Lambda: public-job (GET /public/jobs/{code}) ──
    // jale_public_jobs role only. UNAUTHENTICATED.
    const publicJobLambda = new JaleLambdaFunction(this, 'PublicJobLambda', {
      entry: path.join(__dirname, '../../lambda/api/public-job.ts'),
      description: 'Public job read endpoint (unauthenticated)',
      environment: {
        REFERRALS_DB_SECRET_ARN: props.referralsDbSecret.secretArn,
        REFERRAL_VISITOR_SALT_SECRET_ARN: visitorSaltSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.referralsDbSecret.grantRead(publicJobLambda.function);
    // Only the public-job Lambda hashes visitors; nothing else may read the salt.
    visitorSaltSecret.grantRead(publicJobLambda.function);

    // ── Lambda: public-job-apply-intent (POST /public/jobs/{code}/apply-intent) ──
    // jale_public_jobs role only. UNAUTHENTICATED.
    const publicJobApplyIntentLambda = new JaleLambdaFunction(this, 'PublicJobApplyIntentLambda', {
      entry: path.join(__dirname, '../../lambda/api/public-job-apply-intent.ts'),
      description: 'Public job apply-intent endpoint (unauthenticated)',
      environment: {
        REFERRALS_DB_SECRET_ARN: props.referralsDbSecret.secretArn,
        WHATSAPP_BUSINESS_NUMBER: whatsappBusinessNumber,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.referralsDbSecret.grantRead(publicJobApplyIntentLambda.function);

    // ── Lambda: worker-job-share (POST /worker/jobs/{jobId}/share) ──
    // App DB (jale_admin) only. Worker-authenticated.
    const workerJobShareLambda = new JaleLambdaFunction(this, 'WorkerJobShareLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-job-share.ts'),
      description: 'Worker job share-link minting endpoint',
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        PUBLIC_SITE_BASE_URL: publicSiteBaseUrl,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.appDbSecret.grantRead(workerJobShareLambda.function);

    // ── Lambda: worker-referrals (GET /worker/referrals) ──
    // App DB (jale_admin) only. Worker-authenticated.
    const workerReferralsLambda = new JaleLambdaFunction(this, 'WorkerReferralsLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-referrals.ts'),
      description: 'Worker referral history endpoint',
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        PUBLIC_SITE_BASE_URL: publicSiteBaseUrl,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.appDbSecret.grantRead(workerReferralsLambda.function);

    // ── Lambda: worker-referral-claim (POST /worker/referrals/claim) ──
    // App DB (jale_admin) only. Worker-authenticated. Writes worker_attribution
    // for the web referral-apply flow (as opposed to worker-job-share, which
    // mints the link; this Lambda claims it once the referred worker signs up).
    const workerReferralClaimLambda = new JaleLambdaFunction(this, 'WorkerReferralClaimLambda', {
      entry: path.join(__dirname, '../../lambda/api/worker-referral-claim.ts'),
      description: 'Worker referral claim endpoint',
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.appDbSecret.grantRead(workerReferralClaimLambda.function);

    // ── Lambda: employer-job-public-listing (PATCH .../public-listing) ──
    // The single write path for jobs.public_listing_enabled — the employer's
    // opt-IN to a public job page (migration 057). App DB (jale_admin) only;
    // ownership is enforced inside the statement.
    const employerJobPublicListingLambda = new JaleLambdaFunction(this, 'EmployerJobPublicListingLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-job-public-listing.ts'),
      description: 'Employer opt-in toggle for the public job page',
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.appDbSecret.grantRead(employerJobPublicListingLambda.function);

    // ── Lambda: retention sweeper (EventBridge, daily) ──
    // The two public routes write a row per unauthenticated request and
    // nothing else ever deletes them; this bounds that growth. Runs as
    // jale_admin (appDbSecret): jale_public_jobs deliberately has no DELETE
    // grant anywhere and must never get one.
    const retentionSweeperLambda = new JaleLambdaFunction(this, 'ReferralRetentionSweeperLambda', {
      entry: path.join(__dirname, '../../lambda/referrals/retention-sweeper.ts'),
      description: 'Referral retention sweeper (tokens, claims, aged opens)',
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
      },
      ...lambdaProps,
    });
    props.appDbSecret.grantRead(retentionSweeperLambda.function);

    new events.Rule(this, 'ReferralRetentionSweepRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      targets: [new eventTargets.LambdaFunction(retentionSweeperLambda.function)],
    });

    // ── Lambda: public-jobs-list (GET /public/jobs) ──
    // jale_public_jobs role only. UNAUTHENTICATED. Mirrors public-job's
    // secret/env wiring exactly -- same restricted DB role, same absence of
    // DB_SECRET_ARN. No visitor-salt secret: this Lambda never hashes a
    // visitor (that only happens on the single-job read/open path).
    const publicJobsListLambda = new JaleLambdaFunction(this, 'PublicJobsListLambda', {
      entry: path.join(__dirname, '../../lambda/api/public-jobs-list.ts'),
      description: 'Public job index endpoint (unauthenticated, SEO/search)',
      environment: {
        REFERRALS_DB_SECRET_ARN: props.referralsDbSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.referralsDbSecret.grantRead(publicJobsListLambda.function);

    // ── Lambda: employer-job-share (POST /employer/jobs/{jobId}/share) ──
    // App DB (jale_admin) only. Employer-authenticated. Exact mirror of
    // worker-job-share's env wiring -- same TOS gate, same absolute-base-URL
    // requirement for the minted share link.
    const employerJobShareLambda = new JaleLambdaFunction(this, 'EmployerJobShareLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-job-share.ts'),
      description: 'Employer job share-link minting endpoint',
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        PUBLIC_SITE_BASE_URL: publicSiteBaseUrl,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.appDbSecret.grantRead(employerJobShareLambda.function);

    // ── Secret: Google Indexing API service-account key ──
    // jale/referrals/google-indexing-key holds a real Google Cloud
    // service-account JSON key (client_email + private_key) issued OUTSIDE
    // this AWS account -- CDK cannot generate a value for it the way it does
    // for `jale/referrals/db`'s CDK-managed DB password. That makes this an
    // OPERATOR-CREATED secret, the same category as `jale/whatsapp/twilio` /
    // `jale/whatsapp/db` / `jale/whatsapp/otp-twilio` (see WhatsAppStack and
    // CLAUDE.md's secrets inventory), not the same category as
    // `jale/referrals/db` despite the shared `jale/referrals/*` name prefix.
    // So this follows the WhatsAppStack precedent -- `fromSecretNameV2`
    // import, `.secretName` (not `.secretArn`) into the env var -- rather
    // than `new secretsmanager.Secret(...)`. It also matches
    // GOOGLE_INDEXING_SECRET_NAME's own name: a secret NAME, not an ARN.
    // The operator must create the real secret out-of-band (empty/placeholder
    // until seeded) before the first scheduled drain can send anything;
    // visibility-outbox-drain.ts already treats a missing/malformed value as
    // "skip this cycle", never a hard failure.
    const googleIndexingKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoogleIndexingKeySecret',
      'jale/referrals/google-indexing-key',
    );

    // ── Lambda: visibility-outbox-drain (EventBridge, every 5 minutes) ──
    // Drains job_visibility_events (migration 062) and notifies Google's
    // Indexing API. Runs as jale_admin (appDbSecret) -- see the table's RLS
    // comment for why the drain path is a narrow direct SELECT/UPDATE policy
    // rather than a SECURITY DEFINER pair. Only this Lambda gets the Google
    // service-account secret grant.
    const visibilityOutboxDrainLambda = new JaleLambdaFunction(this, 'VisibilityOutboxDrainLambda', {
      entry: path.join(__dirname, '../../lambda/referrals/visibility-outbox-drain.ts'),
      description: 'Job visibility outbox drain — Google Indexing API notifications',
      environment: {
        DB_SECRET_ARN: props.appDbSecret.secretArn,
        GOOGLE_INDEXING_SECRET_NAME: googleIndexingKeySecret.secretName,
        PUBLIC_SITE_BASE_URL: publicSiteBaseUrl,
      },
      // Caps this Lambda to one concurrent invocation. The handler's own
      // concurrency note documents why: its claim transaction commits (and
      // releases row locks) before the per-row network I/O and UPDATEs run,
      // so FOR UPDATE SKIP LOCKED alone does not protect against a second
      // invocation started by an overlapping EventBridge trigger (e.g. a
      // retried/duplicate scheduled invoke) claiming and double-processing
      // rows mid-batch. This assumes a single scheduled invocation at a time,
      // which reservedConcurrentExecutions: 1 now enforces instead of leaving
      // it as an unenforced assumption.
      reservedConcurrentExecutions: 1,
      ...lambdaProps,
    });
    props.appDbSecret.grantRead(visibilityOutboxDrainLambda.function);
    googleIndexingKeySecret.grantRead(visibilityOutboxDrainLambda.function);

    new events.Rule(this, 'VisibilityOutboxDrainRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(visibilityOutboxDrainLambda.function)],
    });

    // ── Routes ──

    // GET /public/jobs/{code}
    // POST /public/jobs/{code}/apply-intent
    // Both UNAUTHENTICATED — options argument omitted entirely, matching the
    // DocumentsStack/LegalStack precedent for downstream stacks adding
    // unauthenticated methods to the shared API.
    const publicResource = props.api.root.addResource('public');
    const publicJobsResource = publicResource.addResource('jobs');

    // GET /public/jobs — unauthenticated index (SEO/search), on the SAME
    // parent resource as {code} below, not a newly-declared one.
    publicJobsResource.addMethod('GET', new apigateway.LambdaIntegration(publicJobsListLambda.function));

    const publicJobResource = publicJobsResource.addResource('{code}');
    publicJobResource.addMethod('GET', new apigateway.LambdaIntegration(publicJobLambda.function));

    const publicJobApplyIntentResource = publicJobResource.addResource('apply-intent');
    publicJobApplyIntentResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(publicJobApplyIntentLambda.function),
    );

    // NOTE: throttles for the two routes above (20/10 GET, 10/5 POST) live in
    // ApiStack's centralized MethodSettings block. ReferralsStack must NOT
    // call addPropertyOverride('MethodSettings').

    // POST /worker/jobs/{jobId}/share — hangs off the EXISTING {jobId} node
    // exported by ApiStack, not a new addResource() call. Absent during a
    // phase-1 rename deploy: the parent node does not exist for that one
    // deploy, so the share route is skipped and restored in phase 2.
    props.workerJobResource
      ?.addResource('share')
      .addMethod('POST', new apigateway.LambdaIntegration(workerJobShareLambda.function), {
        authorizer: props.workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // GET  /worker/referrals
    // POST /worker/referrals/claim
    const workerReferralsResource = props.workerResource.addResource('referrals');
    workerReferralsResource.addMethod('GET', new apigateway.LambdaIntegration(workerReferralsLambda.function), {
      authorizer: props.workerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    workerReferralsResource
      .addResource('claim')
      .addMethod('POST', new apigateway.LambdaIntegration(workerReferralClaimLambda.function), {
        authorizer: props.workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // PATCH /employer/jobs/{jobId}/public-listing — employer-authenticated,
    // hangs off the EXISTING employer {jobId} node exported by ApiStack.
    props.employerJobResource
      .addResource('public-listing')
      .addMethod('PATCH', new apigateway.LambdaIntegration(employerJobPublicListingLambda.function), {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // POST /employer/jobs/{jobId}/share — employer-authenticated, hangs off
    // the EXISTING employer {jobId} node exported by ApiStack. Exact mirror
    // of the public-listing mount above.
    props.employerJobResource
      .addResource('share')
      .addMethod('POST', new apigateway.LambdaIntegration(employerJobShareLambda.function), {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
  }
}
