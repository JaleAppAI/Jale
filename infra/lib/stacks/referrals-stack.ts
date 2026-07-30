import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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
   * GRANTs plus the jobs_public_read RLS policy (migration 055), nothing more.
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
   */
  readonly workerJobResource: apigateway.Resource;
}

/**
 * ReferralsStack — worker-to-worker job referrals.
 *
 * Routes:
 *   GET  /public/jobs/{code}                    → public-job Lambda (UNAUTHENTICATED)
 *   POST /public/jobs/{code}/apply-intent        → public-job-apply-intent Lambda (UNAUTHENTICATED)
 *   POST /worker/jobs/{jobId}/share               → worker-job-share Lambda (worker auth)
 *   GET  /worker/referrals                       → worker-referrals Lambda (worker auth)
 *
 * Secret isolation:
 *   public-job              : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   public-job-apply-intent : REFERRALS_DB_SECRET_ARN (jale_public_jobs) only
 *   worker-job-share         : DB_SECRET_ARN (app DB / jale_admin) only
 *   worker-referrals         : DB_SECRET_ARN (app DB / jale_admin) only
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

    // Optional — public-job.ts falls back to storing a null visitor hash when
    // absent. Never invent a value; only pass through if the operator set one.
    const referralVisitorSalt = this.node.tryGetContext('referralVisitorSalt')
      ?? process.env.JALE_REFERRAL_VISITOR_SALT;

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
        ALLOWED_ORIGIN: allowedOrigin,
        ...(referralVisitorSalt ? { REFERRAL_VISITOR_SALT: referralVisitorSalt } : {}),
      },
      ...lambdaProps,
    });
    props.referralsDbSecret.grantRead(publicJobLambda.function);

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

    // ── Routes ──

    // GET /public/jobs/{code}
    // POST /public/jobs/{code}/apply-intent
    // Both UNAUTHENTICATED — options argument omitted entirely, matching the
    // DocumentsStack/LegalStack precedent for downstream stacks adding
    // unauthenticated methods to the shared API.
    const publicResource = props.api.root.addResource('public');
    const publicJobsResource = publicResource.addResource('jobs');
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
    // exported by ApiStack, not a new addResource() call.
    props.workerJobResource
      .addResource('share')
      .addMethod('POST', new apigateway.LambdaIntegration(workerJobShareLambda.function), {
        authorizer: props.workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // GET /worker/referrals
    props.workerResource
      .addResource('referrals')
      .addMethod('GET', new apigateway.LambdaIntegration(workerReferralsLambda.function), {
        authorizer: props.workerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
  }
}
