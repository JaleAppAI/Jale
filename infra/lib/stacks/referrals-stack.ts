import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { lambdaIntegration, addPathOnlyResource } from '../api-integration';

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
  /**
   * Shared REST API from ApiStack.
   *
   * Now that /public arrives pre-built via `publicResource` below, this stack
   * no longer dereferences `props.api` anywhere. Kept on the interface
   * deliberately rather than removed: it documents that this stack mounts onto
   * ApiStack's API rather than owning one, and dropping it would churn
   * bin/jale-app.ts plus two test harnesses for no behavioural gain. Remove it
   * in a dedicated cleanup if that trade stops being worth it.
   */
  readonly api: apigateway.RestApi;
  /**
   * /public resource from ApiStack — every route in this stack's public lane
   * hangs off it.
   *
   * This stack used to call `props.api.root.addResource('public')` itself. That
   * became unsafe the moment a second stack (NotificationsStack) needed the
   * same node: two stacks calling addResource with the same path part on one
   * RestApi is a construct-id collision at synth, and which stack "owns" it
   * depends entirely on instantiation order in bin/jale-app.ts. Same
   * reuse-don't-redeclare rule as workerJobResource / employerJobResource.
   */
  readonly publicResource: apigateway.Resource;
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
  /**
   * Existing monitored SNS topic for alarm actions — the SAME shared
   * `whatsappAlarmTopicArn` context AiStack/WhatsAppStack read, reused here
   * rather than a new topic (see `bin/jale-app.ts`).
   *
   * Deliberately NOT the same fail-closed contract as AiStack/WhatsAppStack:
   * those two `throw` at synth time when neither `alarmTopicArn` nor
   * `whatsappAlarmEmail` context is present, because they were retrofitted
   * onto stacks with alarms that already existed (2026-07-27 observability
   * pass) and had zero actionable target. ReferralsStack has never had any
   * alarm plumbing until now, and `referrals-stack.test.ts`'s `buildApp()`
   * synths without this prop — so this stack must keep synthesizing (with an
   * unmonitored-but-visible alarm) when the prop is absent instead of
   * breaking every existing caller that doesn't pass it.
   */
  readonly alarmTopicArn?: string;
}

/**
 * ReferralsStack — worker-to-worker job referrals.
 *
 * Routes:
 *   GET  /public/jobs                            → public-jobs-list Lambda (UNAUTHENTICATED)
 *   GET  /public/jobs/{code}                    → public-job Lambda (UNAUTHENTICATED)
 *   POST /public/jobs/{code}/open                 → public-job-open Lambda (UNAUTHENTICATED)
 *   GET  /public/jobs/{code}/referrer             → public-job-referrer Lambda (UNAUTHENTICATED)
 *   POST /public/jobs/{code}/apply-intent        → public-job-apply-intent Lambda (UNAUTHENTICATED)
 *   POST /worker/jobs/{jobId}/share               → worker-job-share Lambda (worker auth)
 *   POST /worker/referrals/claim                 → worker-referral-claim Lambda (worker auth)
 *   POST /employer/jobs/{jobId}/share             → employer-job-share Lambda (employer auth)
 *
 * Secret isolation:
 *   public-job              : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   public-jobs-list         : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   public-job-open          : REFERRALS_DB_SECRET_ARN (jale_public_jobs) plus the
 *                              REFERRAL_VISITOR_SALT_SECRET_ARN (the only Lambda
 *                              that hashes visitors)
 *   public-job-referrer      : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   public-job-apply-intent : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   worker-job-share         : DB_SECRET_ARN (app DB / jale_admin) only
 *   worker-referrals         : DB_SECRET_ARN (app DB / jale_admin) only (phase 1: retained, unrouted)
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
    // jale_public_jobs role only. UNAUTHENTICATED. Pure read -- no `r`
    // parsing, no crawler/device/locale helpers, no visitor hashing. That all
    // moved to public-job-open.ts, so this Lambda no longer needs the
    // visitor-salt secret.
    const publicJobLambda = new JaleLambdaFunction(this, 'PublicJobLambda', {
      entry: path.join(__dirname, '../../lambda/api/public-job.ts'),
      description: 'Public job read endpoint (unauthenticated)',
      environment: {
        REFERRALS_DB_SECRET_ARN: props.referralsDbSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.referralsDbSecret.grantRead(publicJobLambda.function);

    // ── Lambda: public-job-open (POST /public/jobs/{code}/open) ──
    // jale_public_jobs role only. UNAUTHENTICATED. Fire-and-forget open beacon
    // -- crawler filtering, share-link matching, visitor hashing, and the
    // job_share_opens insert/open_count bump (split out of public-job.ts).
    const publicJobOpenLambda = new JaleLambdaFunction(this, 'PublicJobOpenLambda', {
      entry: path.join(__dirname, '../../lambda/api/public-job-open.ts'),
      description: 'Public job open-tracking beacon endpoint (unauthenticated)',
      environment: {
        REFERRALS_DB_SECRET_ARN: props.referralsDbSecret.secretArn,
        REFERRAL_VISITOR_SALT_SECRET_ARN: visitorSaltSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.referralsDbSecret.grantRead(publicJobOpenLambda.function);
    // Only the public-job-open Lambda hashes visitors; nothing else may read the salt.
    visitorSaltSecret.grantRead(publicJobOpenLambda.function);

    // ── Lambda: public-job-referrer (GET /public/jobs/{code}/referrer) ──
    // jale_public_jobs role only. UNAUTHENTICATED. Never hashes a visitor --
    // no visitor-salt secret grant.
    const publicJobReferrerLambda = new JaleLambdaFunction(this, 'PublicJobReferrerLambda', {
      entry: path.join(__dirname, '../../lambda/api/public-job-referrer.ts'),
      description: 'Public job referrer-context lookup endpoint (unauthenticated)',
      environment: {
        REFERRALS_DB_SECRET_ARN: props.referralsDbSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      ...lambdaProps,
    });
    props.referralsDbSecret.grantRead(publicJobReferrerLambda.function);

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

    // ── PHASE 1 ONLY: worker-referrals, the deleted GET /worker/referrals ──
    //
    // The route is gone (dead code: nothing ever called it — see the mount
    // below), but the Lambda is retained for exactly one deploy so its
    // automatic cross-stack ARN export survives the deploy in which
    // JaleApiStack stops importing it. JaleApiStack depends on this stack and
    // so updates second; deleting the function now would fail this stack's
    // changeset with "Export
    // JaleReferralsStack:ExportsOutputFnGetAttWorkerReferralsLambdaFunction...
    // Arn... cannot be deleted as it is in use by JaleApiStack". Phase 2 (the
    // next commit) deletes the Lambda, its handler and its test. See
    // documents-stack.ts for the full note.
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
    this.exportValue(workerReferralsLambda.function.functionArn);
    // ── end phase 1 retention ──────────────────────────────────────────────

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

    // ── Alarms: visibility-outbox-drain observability ──
    // Before this, nothing paged anyone if the Google service-account secret
    // broke (rotated out from under the Lambda, deleted, or malformed) or if
    // the drain itself started throwing. Three failure shapes, three signals:
    //
    //   1. Unhandled Lambda errors (bad DB connection, claim-transaction
    //      failure, etc.) -- the standard Lambda `Errors` metric.
    //   2. The handler's *deliberate* no-op paths -- `getGoogleIndexingServiceAccountKey()`
    //      returning null (secret missing/malformed) or the OAuth token
    //      exchange failing (bad/rotated credentials) -- both log
    //      `{"metric":"VisibilityOutboxDrainSkipped", ...}` and return a
    //      normal, non-throwing result. This is exactly the "secret breaks
    //      and the drain silently no-ops" case called out for this Lambda --
    //      the `Errors` alarm below CANNOT see it, since nothing throws.
    //   3. Rows that exhausted MAX_ATTEMPTS and were marked 'failed' -- an
    //      EMF metric emitted by the handler itself (see Change 2 in
    //      visibility-outbox-drain.ts).
    //
    // Same shared alarm target as AiStack/WhatsAppStack (-c whatsappAlarmTopicArn=),
    // wired via `props.alarmTopicArn` in bin/jale-app.ts -- but NOT the same
    // fail-closed contract; see the prop doc comment for why.
    let referralsAlarmAction: cloudwatchActions.SnsAction | undefined;
    if (props.alarmTopicArn) {
      const referralsAlarmTopic = sns.Topic.fromTopicArn(this, 'ReferralsAlarmTopic', props.alarmTopicArn);
      referralsAlarmAction = new cloudwatchActions.SnsAction(referralsAlarmTopic);
    }

    const referralsAlarm = (id: string, alarmName: string, alarmDescription: string, metric: cloudwatch.IMetric) => {
      const alarm = new cloudwatch.Alarm(this, id, {
        alarmName,
        alarmDescription,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      if (referralsAlarmAction) alarm.addAlarmAction(referralsAlarmAction);
      return alarm;
    };

    // 1. Unhandled Lambda errors on the 5-minute drain schedule.
    referralsAlarm(
      'VisibilityOutboxDrainErrorsAlarm',
      'VisibilityOutboxDrainErrors',
      'visibility-outbox-drain Lambda reported an unhandled error',
      visibilityOutboxDrainLambda.function.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    );

    // 2. Deliberate skip paths -- missing/malformed secret or failed OAuth
    // exchange -- both already log `{"metric":"VisibilityOutboxDrainSkipped"}`;
    // this MetricFilter (same idiom as AiStack's TrustScorerFailures /
    // WhatsAppStack's CallbackErrors) turns that log line into an alarmable
    // metric without any Lambda code change.
    //
    // LITERAL term pattern, NOT `logs.FilterPattern.stringValue('$.metric',
    // ...)`: a JSON selector only matches events that are themselves valid
    // JSON, and Node 20's default TEXT log format prefixes each console line
    // with `timestamp<TAB>requestId<TAB>LEVEL<TAB>`, so the selector this used
    // to carry matched nothing at all. See notifications-stack.ts:260 and
    // test/unit/stacks/metric-filter-patterns.test.ts.
    const skippedMetric = new logs.MetricFilter(this, 'VisibilityOutboxDrainSkippedMetric', {
      logGroup: visibilityOutboxDrainLambda.logGroup,
      filterPattern: logs.FilterPattern.literal('"VisibilityOutboxDrainSkipped"'),
      metricNamespace: 'Jale/Referrals',
      metricName: 'VisibilityOutboxDrainSkipped',
      metricValue: '1',
    });
    referralsAlarm(
      'VisibilityOutboxDrainSkippedAlarm',
      'VisibilityOutboxDrainSkipped',
      'visibility-outbox-drain skipped a cycle -- Google service-account secret missing/malformed or OAuth exchange failed. '
        + 'In an environment where the secret has never been seeded, this fires every cycle by design.',
      skippedMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
    );

    // 3. Rows permanently failed (MAX_ATTEMPTS reached) -- EMF metric emitted
    // directly by the handler (Jale/OTP-style `_aws` block), no MetricFilter
    // needed.
    referralsAlarm(
      'VisibilityOutboxDrainPermanentFailureAlarm',
      'VisibilityOutboxDrainPermanentFailures',
      'A job_visibility_events row exhausted MAX_ATTEMPTS and was marked failed',
      new cloudwatch.Metric({
        namespace: 'Jale/Referrals',
        metricName: 'VisibilityOutboxDrainPermanentFailure',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
    );

    // ── Routes ──

    // GET /public/jobs/{code}
    // POST /public/jobs/{code}/apply-intent
    // Both UNAUTHENTICATED — options argument omitted entirely, matching the
    // DocumentsStack/LegalStack precedent for downstream stacks adding
    // unauthenticated methods to the shared API.
    // /public comes from ApiStack — reused, never re-declared here. See the
    // publicResource prop doc for why the old inline addResource('public') was
    // an order-dependent synth hazard.
    const publicJobsResource = props.publicResource.addResource('jobs');

    // GET /public/jobs — unauthenticated index (SEO/search), on the SAME
    // parent resource as {code} below, not a newly-declared one.
    publicJobsResource.addMethod('GET', lambdaIntegration(publicJobsListLambda.function));

    const publicJobResource = publicJobsResource.addResource('{code}');
    publicJobResource.addMethod('GET', lambdaIntegration(publicJobLambda.function));

    // POST /public/jobs/{code}/open — unauthenticated open-tracking beacon,
    // options argument omitted entirely, matching the DocumentsStack/LegalStack
    // precedent for downstream stacks adding unauthenticated methods.
    const publicJobOpenResource = publicJobResource.addResource('open');
    publicJobOpenResource.addMethod('POST', lambdaIntegration(publicJobOpenLambda.function));

    // GET /public/jobs/{code}/referrer — unauthenticated referrer-context
    // lookup, same unauthenticated shape as the routes above.
    const publicJobReferrerResource = publicJobResource.addResource('referrer');
    publicJobReferrerResource.addMethod('GET', lambdaIntegration(publicJobReferrerLambda.function));

    const publicJobApplyIntentResource = publicJobResource.addResource('apply-intent');
    publicJobApplyIntentResource.addMethod(
      'POST',
      lambdaIntegration(publicJobApplyIntentLambda.function),
    );

    // NOTE: throttles for the routes above (GET {code} 20/10, POST open
    // 20/10, GET referrer 20/10, POST apply-intent 10/5) live in ApiStack's
    // centralized MethodSettings block. ReferralsStack must NOT call
    // addPropertyOverride('MethodSettings').

    // POST /worker/jobs/{jobId}/share — hangs off the EXISTING {jobId} node
    // exported by ApiStack, not a new addResource() call. Absent during a
    // phase-1 rename deploy: the parent node does not exist for that one
    // deploy, so the share route is skipped and restored in phase 2.
    props.workerJobResource
      ?.addResource('share')
      .addMethod('POST', lambdaIntegration(workerJobShareLambda.function), {
        authorizer: props.workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // POST /worker/referrals/claim
    //
    // Path-only parent: `GET /worker/referrals` (a referral-history endpoint
    // and its Lambda) was removed as dead code — nothing in the frontend ever
    // called it, `frontend/src/lib/api/worker.ts` only reaches
    // /worker/referrals/claim. With no method of its own, /worker/referrals
    // must be built with addPathOnlyResource() so its unreachable CORS
    // OPTIONS is never created either: an OPTIONS-only resource fails the
    // JaleApiStack invariant in
    // `test/unit/stacks/api-stack-resource-ceiling.test.ts`.
    const workerReferralsResource = addPathOnlyResource(props.workerResource, 'referrals');
    workerReferralsResource
      .addResource('claim')
      .addMethod('POST', lambdaIntegration(workerReferralClaimLambda.function), {
        authorizer: props.workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // PATCH /employer/jobs/{jobId}/public-listing — employer-authenticated,
    // hangs off the EXISTING employer {jobId} node exported by ApiStack.
    props.employerJobResource
      .addResource('public-listing')
      .addMethod('PATCH', lambdaIntegration(employerJobPublicListingLambda.function), {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // POST /employer/jobs/{jobId}/share — employer-authenticated, hangs off
    // the EXISTING employer {jobId} node exported by ApiStack. Exact mirror
    // of the public-listing mount above.
    props.employerJobResource
      .addResource('share')
      .addMethod('POST', lambdaIntegration(employerJobShareLambda.function), {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
  }
}
