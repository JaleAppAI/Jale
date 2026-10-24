import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { dedicatedDbLogin } from '../constructs/db-login-secrets';
import { jaleAlarm } from '../constructs/jale-alarm';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { lambdaIntegration, addPathOnlyResource } from '../api-integration';

export interface BillingStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  /** Dedicated billing security group (billingLambdaSg from NetworkStack) */
  readonly billingLambdaSg: ec2.ISecurityGroup;
  /** The billing service login's secret (CDK-created in DatabaseStack) — the processor ONLY */
  readonly billingDbSecret: secretsmanager.ISecret;
  /** Shared REST API from ApiStack */
  readonly api: apigateway.RestApi;
  /** Employer Cognito authorizer from ApiStack */
  readonly employerAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
  /** /employer resource from ApiStack — billing routes hang off it */
  readonly employerResource: apigateway.Resource;
  /**
   * SES configuration set NotificationsStack creates, passed as a literal from
   * bin/jale-app.ts (see the note there for why it is not a CDK reference).
   *
   * Present  => the sweeper tags every message with it, so bounces and
   *             complaints reach the feedback handler, and the send is
   *             authorized against the configuration-set ARN as well as the
   *             identity.
   * Absent   => today's behaviour exactly: mail sends, nothing listens.
   */
  readonly emailConfigurationSetName?: string;
  /**
   * The employer user pool (AuthStack), for member access (Phase 3): the
   * processor and the member-access sync make its users' sign-in follow
   * billing suspension, restore, removal and invite revocation. Passed from
   * `auth.employerPool.userPool`; AuthStack depends on nothing here, so the
   * reference adds no cycle.
   */
  readonly employerUserPoolId: string;
  readonly employerUserPoolArn: string;
  /**
   * Team management (Phase 3). Resolved once in the composition from
   * `-c teamManagementEnabled` / `JALE_TEAM_MANAGEMENT_ENABLED`, off unless
   * exactly 'true'. It becomes the three team Lambdas' TEAM_MANAGEMENT_ENABLED;
   * with it off they answer 404 on every route. It does NOT gate the
   * processor or the member-access sync: a rollback (flag off) relies on
   * them still converging Cognito.
   */
  readonly teamManagementEnabled: boolean;
  /**
   * The frontend's public origin (`publicSiteBaseUrl` context or
   * JALE_PUBLIC_SITE_BASE_URL), for the invite link the team dispatcher mails.
   * Must be https; the synth fails otherwise (see resolveInviteSiteBaseUrl).
   */
  readonly publicSiteBaseUrl: string;
}

/**
 * The invite link's base: an absolute https URL, trailing slashes dropped.
 * Fail closed at synth, as NotificationsStack does for its own links, and
 * stricter: lambda/lib/org-team.ts's inviteUrl() refuses anything but https,
 * so an http base would turn every invite into a 500 at runtime.
 */
export function resolveInviteSiteBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  let parsed: URL | undefined;
  try {
    parsed = value ? new URL(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || parsed.protocol !== 'https:') {
    throw new Error(
      'BillingStack requires an https publicSiteBaseUrl (context publicSiteBaseUrl or '
      + 'JALE_PUBLIC_SITE_BASE_URL) for the team invite link — pass -c publicSiteBaseUrl=https://jaleapp.ai',
    );
  }
  return value.replace(/\/+$/, '');
}

/**
 * The member-access sync runs every 15 minutes. Its alarms use a 30-minute
 * period so every period holds at least one run (see the pool alarm).
 */
const MEMBER_ACCESS_SYNC_ALARM_PERIOD = cdk.Duration.minutes(30);

/**
 * The request pool's session timeouts for the invite accept
 * (lambda/lib/db.ts): a wait on a company lock ends at 3 s and any one
 * statement at 5 s, so the database leg errors out well inside its 20 s
 * Lambda timeout and API Gateway's 29 s cap, leaving room for the post-COMMIT
 * Cognito calls (bounded at about 10 s by member-access.ts's deadline).
 *
 * The team dispatcher overrides the statement bound to 10 s (TEAM_DISPATCHER_DB_TIMEOUTS)
 * and runs 25 s: a remove moves every job of the member in one UPDATE (about
 * 1,000 jobs at the far end), and still needs the Cognito deadline after it.
 */
const TEAM_DB_TIMEOUTS = {
  DB_STATEMENT_TIMEOUT_MS: '5000',
  DB_LOCK_TIMEOUT_MS: '3000',
} as const;

export const TEAM_DISPATCHER_DB_TIMEOUTS = {
  ...TEAM_DB_TIMEOUTS,
  DB_STATEMENT_TIMEOUT_MS: '10000',
} as const;

/**
 * The public invite lookup: one read-only function call, so a statement
 * bound and nothing else (it waits on no lock).
 */
const INVITE_LOOKUP_DB_TIMEOUTS = {
  DB_STATEMENT_TIMEOUT_MS: '5000',
} as const;

/**
 * Hard cap on the unauthenticated invite lookup's concurrent executions, and
 * so on its jale_api_public connections (one per container; that login has no
 * connection limit). The stage throttle in ApiStack is the other brake.
 */
const INVITE_LOOKUP_RESERVED_CONCURRENCY = 10;

/**
 * What lambda/lib/member-access.ts calls, on the employer pool's own ARN only
 * (never userpool/*): read a user, then enable, or sign out and disable.
 * The one statement every member-access caller gets: the processor, the
 * sync, the team dispatcher and the invite accept.
 */
function memberAccessStatement(employerUserPoolArn: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: [
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminUserGlobalSignOut',
    ],
    resources: [employerUserPoolArn],
  });
}

export function validateBillingEmailConfiguration(
  emailFromAddress: string | undefined,
  sesVerifiedIdentityArn: string | undefined,
): void {
  if (!emailFromAddress || !sesVerifiedIdentityArn) {
    throw new Error('emailFromAddress and sesVerifiedIdentityArn are required for billing email delivery');
  }
}

/**
 * BillingStack — Stripe subscription management for employers.
 *
 * Routes:
 *   GET  /employer/billing              → get-billing Lambda (employer auth)
 *   POST /employer/billing/checkout     → checkout Lambda  (employer auth, Idempotency-Key)
 *   POST /employer/billing/portal       → portal Lambda    (employer auth)
 *   POST /billing/webhook               → webhook verifier Lambda (no auth, Stripe HMAC)
 *   GET, POST /employer/team/{action}   → team dispatcher (employer auth; Phase 3)
 *   GET  /employer/invites/{token}      → invite lookup   (no auth; Phase 3)
 *   POST /employer/invites/{token}      → invite accept   (employer auth; Phase 3)
 *
 * Secret isolation (rule 9 of the A6 spec):
 *   get-billing : DB_SECRET_ARN (request login) only
 *   checkout    : DB_SECRET_ARN (request login) + STRIPE_SECRET_ARN
 *   portal      : DB_SECRET_ARN (request login) + STRIPE_SECRET_ARN
 *   webhook     : WEBHOOK_SECRET_ARN + QUEUE_URL (no DB, no Stripe API key)
 *   processor   : DB_SECRET_ARN (billing service login) + STRIPE_SECRET_ARN (SQS consumer)
 *                 + EMPLOYER_USER_POOL_ID (member access)
 *   sweeper     : DB_SECRET_ARN (the email-sender job login) + SES send
 *   member sync : DB_SECRET_ARN (billing service login) + EMPLOYER_USER_POOL_ID
 *   team        : DB_SECRET_ARN (request login) + EMPLOYER_USER_POOL_ID + PUBLIC_SITE_BASE_URL
 *   lookup      : DB_SECRET_ARN (public login) only
 *   accept      : DB_SECRET_ARN (request login) + EMPLOYER_USER_POOL_ID
 *
 * Member access (Phase 3): the processor, the member-access sync, the team
 * dispatcher and the invite accept, and no other Lambda here, may get,
 * enable, disable and globally sign out users of the employer pool, and of no
 * other pool. The public invite lookup gets no Cognito grant.
 *
 * DB login split: jale_billing is a processor-only service login (migration
 * 034) — granted billing_plans/billing_customers/subscriptions/
 * billing_webhook_events but NOT billing_operations, and no users access. The
 * three user-facing Lambdas (get-billing, checkout, portal) connect as the
 * request login every employer route uses, and the outbox sweeper as its own
 * dedicated job login, which may only claim and mark outbox rows.
 *
 * Secrets imported by name (operator-created, never CDK-created):
 *   jale/billing/stripe-api  — Stripe API secret key
 *   jale/billing/webhook     — Stripe webhook signing secret
 */
export class BillingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const billingAlarmEmail = this.node.tryGetContext('billingAlarmEmail');
    const billingAlarmTopicArn = this.node.tryGetContext('billingAlarmTopicArn');
    const emailFromAddress = this.node.tryGetContext('emailFromAddress') as string | undefined;
    const sesVerifiedIdentityArn = this.node.tryGetContext('sesVerifiedIdentityArn') as string | undefined;
    validateBillingEmailConfiguration(emailFromAddress, sesVerifiedIdentityArn);
    const requiredEmailFromAddress = emailFromAddress!;
    const requiredSesVerifiedIdentityArn = sesVerifiedIdentityArn!;
    const inviteSiteBaseUrl = resolveInviteSiteBaseUrl(props.publicSiteBaseUrl);
    const teamManagementEnabled = props.teamManagementEnabled ? 'true' : 'false';

    // ── Import operator-created secrets by name ──
    // These secrets are never CDK-managed; CDK only imports the ARN reference.
    const stripeApiSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'StripeApiSecret',
      'jale/billing/stripe-api',
    );
    const webhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'WebhookSecret',
      'jale/billing/webhook',
    );

    // ── Database logins ──
    const apiDb = dedicatedDbLogin(this, 'jale_api');
    // The public invite lookup only: 133 grants org_team_invite_lookup to this
    // EXECUTE-only login and to no other.
    const apiPublicDb = dedicatedDbLogin(this, 'jale_api_public');
    const emailSenderDb = dedicatedDbLogin(this, 'jale_job_email_sender');

    // ── DLQ + main queue ──
    // Processor Lambda timeout = 60 s → visibilityTimeout must be >= 6× = 360 s.
    const webhookDlq = new sqs.Queue(this, 'BillingWebhookDlq', {
      queueName: 'billing-webhook-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    const webhookQueue = new sqs.Queue(this, 'BillingWebhookQueue', {
      queueName: 'billing-webhook-queue',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: webhookDlq,
        maxReceiveCount: 3,
      },
    });

    // ── Lambda: get-billing ──
    // Request login only — no Stripe secrets. jale_billing is processor-only.
    const getBillingLambda = new JaleLambdaFunction(this, 'GetBillingLambda', {
      entry: path.join(__dirname, '../../lambda/billing/get-billing.ts'),
      description: 'Returns employer billing status and plan entitlements',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        ...apiDb.environment,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(getBillingLambda.function);

    // ── Lambda: checkout ──
    // Request login + Stripe API key. jale_billing is processor-only.
    const checkoutLambda = new JaleLambdaFunction(this, 'CheckoutLambda', {
      entry: path.join(__dirname, '../../lambda/billing/checkout.ts'),
      description: 'Creates Stripe Checkout session for employer subscription',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        ...apiDb.environment,
        STRIPE_SECRET_ARN: stripeApiSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(checkoutLambda.function);
    stripeApiSecret.grantRead(checkoutLambda.function);

    // ── Lambda: portal ──
    // Request login + Stripe API key. jale_billing is processor-only.
    const portalLambda = new JaleLambdaFunction(this, 'PortalLambda', {
      entry: path.join(__dirname, '../../lambda/billing/portal.ts'),
      description: 'Creates Stripe Customer Portal session for billing management',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        ...apiDb.environment,
        STRIPE_SECRET_ARN: stripeApiSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    apiDb.grantRead(portalLambda.function);
    stripeApiSecret.grantRead(portalLambda.function);

    // ── Lambda: webhook verifier ──
    // Webhook secret + queue URL ONLY.  No DB access, no Stripe API key.
    // Must run outside the VPC? No — billingLambdaSg is already HTTPS-egress only,
    // which is fine for SQS calls via the S3 gateway / NAT.  Keep it in VPC for
    // consistency and to avoid a public function URL footprint.
    const webhookVerifierLambda = new JaleLambdaFunction(this, 'BillingWebhookLambda', {
      entry: path.join(__dirname, '../../lambda/billing/webhook.ts'),
      description: 'Verifies Stripe webhook signature and queues to SQS',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      environment: {
        WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        QUEUE_URL: webhookQueue.queueUrl,
      },
    });
    webhookSecret.grantRead(webhookVerifierLambda.function);
    webhookQueue.grantSendMessages(webhookVerifierLambda.function);

    // ── Lambda: processor (SQS consumer) ──
    // DB + Stripe API key.
    const processorLambda = new JaleLambdaFunction(this, 'BillingProcessorLambda', {
      entry: path.join(__dirname, '../../lambda/billing/processor.ts'),
      description: 'Processes verified Stripe webhook events from SQS',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      timeout: 60,
      environment: {
        DB_SECRET_ARN: props.billingDbSecret.secretArn,
        DB_EXPECTED_LOGIN: 'jale_billing',
        STRIPE_SECRET_ARN: stripeApiSecret.secretArn,
        ALLOWED_ORIGIN: allowedOrigin,
        EMPLOYER_USER_POOL_ID: props.employerUserPoolId,
      },
    });
    props.billingDbSecret.grantRead(processorLambda.function);
    stripeApiSecret.grantRead(processorLambda.function);
    processorLambda.function.addToRolePolicy(memberAccessStatement(props.employerUserPoolArn));

    webhookQueue.grantConsumeMessages(processorLambda.function);
    processorLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(webhookQueue, {
        batchSize: 1,
        maxConcurrency: 3,
        reportBatchItemFailures: true,
      }),
    );

    const emailSweeperLambda = new JaleLambdaFunction(this, 'EmailOutboxSweeperLambda', {
        entry: path.join(__dirname, '../../lambda/billing/email-outbox-sweeper.ts'),
        description: 'Sends durable billing email outbox messages through SES',
        vpc: props.vpc,
        securityGroups: [props.billingLambdaSg],
        environment: {
          ...emailSenderDb.environment,
          EMAIL_FROM_ADDRESS: requiredEmailFromAddress,
          ALLOWED_ORIGIN: allowedOrigin,
          // Read by lambda/lib/email-outbox.ts. Unset is a supported state:
          // the message is built and sent without the X-SES-CONFIGURATION-SET
          // header and produces no delivery events.
          ...(props.emailConfigurationSetName
            ? { EMAIL_CONFIGURATION_SET: props.emailConfigurationSetName }
            : {}),
        },
    });
    emailSenderDb.grantRead(emailSweeperLambda.function);
    // ses:SendEmail is what authorizes SESv2's SendEmail, INCLUDING the
    // Content.Raw form the sweeper now uses -- the action name follows the
    // API, not the payload shape. ses:SendRawEmail is the SESv1 action and is
    // kept for the transition window: a rollback to the previous Lambda
    // artifact must not also need an IAM change to send mail again.
    //
    // Two resources in ONE statement, which is what SES's authorization model
    // wants: a send that names a configuration set is checked against BOTH the
    // identity ARN and the configuration-set ARN, and a request that satisfies
    // neither is denied either way.
    emailSweeperLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: [
        requiredSesVerifiedIdentityArn,
        ...(props.emailConfigurationSetName
          ? [this.formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: props.emailConfigurationSetName,
          })]
          : []),
      ],
    }));
    new events.Rule(this, 'EmailOutboxSweepSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(emailSweeperLambda.function)],
    });

    // ── Lambda: member-access sync (Phase 3) ──
    // Every 15 minutes, as the billing service login: re-applies the Cognito
    // state of every foreman whose access changed in the last 7 days (a failed
    // or late call after COMMIT, an expired re-invite) and purges sent invite
    // mail. The handler stops calling Cognito 5 s before the timeout.
    const memberAccessSyncLambda = new JaleLambdaFunction(this, 'MemberAccessSyncLambda', {
      entry: path.join(__dirname, '../../lambda/billing/member-access-sync.ts'),
      description: 'Converges employer Cognito sign-in with team membership every 15 minutes',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      timeout: 300,
      // No retries, neither Lambda's async ones nor EventBridge's: the next
      // 15-minute run is the retry, and a retried failure would only page twice.
      retryAttempts: 0,
      environment: {
        DB_SECRET_ARN: props.billingDbSecret.secretArn,
        DB_EXPECTED_LOGIN: 'jale_billing',
        EMPLOYER_USER_POOL_ID: props.employerUserPoolId,
      },
    });
    props.billingDbSecret.grantRead(memberAccessSyncLambda.function);
    memberAccessSyncLambda.function.addToRolePolicy(memberAccessStatement(props.employerUserPoolArn));
    new events.Rule(this, 'MemberAccessSyncSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new eventTargets.LambdaFunction(memberAccessSyncLambda.function, { retryAttempts: 0 })],
    });

    // ── Lambdas: team management (Phase 3) ──
    // Three Lambdas, all on the billing security group (HTTPS egress through
    // NAT, which is how Cognito is reached: the VPC has no cognito-idp
    // endpoint) and the private subnets with egress. Each carries
    // TEAM_MANAGEMENT_ENABLED; with it off every route answers 404. Timeouts
    // stay under API Gateway's 29 s integration cap (team 25 s, accept 20 s,
    // lookup 10 s), and the database leg is bounded by the *_DB_TIMEOUTS above.
    //
    // The team dispatcher (lambda/api/employer-team.ts) serves every
    // /employer/team/{action} route, including the caller's membership
    // (GET/POST membership): one resource instead of three keeps JaleApiStack
    // under its 470-resource gate. The invite, revoke and remove delegates
    // call Cognito after COMMIT (member access), and invite/resend mail a link
    // built on the site's public origin.
    const employerTeamLambda = new JaleLambdaFunction(this, 'EmployerTeamLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-team.ts'),
      description: "Employer team: owner operations and the caller's membership",
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      timeout: 25,
      environment: {
        ...apiDb.environment,
        ...TEAM_DISPATCHER_DB_TIMEOUTS,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        TEAM_MANAGEMENT_ENABLED: teamManagementEnabled,
        PUBLIC_SITE_BASE_URL: inviteSiteBaseUrl,
        EMPLOYER_USER_POOL_ID: props.employerUserPoolId,
      },
    });
    apiDb.grantRead(employerTeamLambda.function);
    employerTeamLambda.function.addToRolePolicy(memberAccessStatement(props.employerUserPoolArn));

    // Public: the invite page reads the invite before the person has an
    // account. The public login, no Cognito, and a stage throttle (ApiStack).
    const employerInviteLookupLambda = new JaleLambdaFunction(this, 'EmployerInviteLookupLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-invite-lookup.ts'),
      description: 'Public employer invite lookup by token',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      timeout: 10,
      reservedConcurrentExecutions: INVITE_LOOKUP_RESERVED_CONCURRENCY,
      environment: {
        ...apiPublicDb.environment,
        ...INVITE_LOOKUP_DB_TIMEOUTS,
        ALLOWED_ORIGIN: allowedOrigin,
        TEAM_MANAGEMENT_ENABLED: teamManagementEnabled,
      },
    });
    apiPublicDb.grantRead(employerInviteLookupLambda.function);

    // The signed-in accept. A removed member who rejoins is enabled in
    // Cognito after COMMIT.
    const employerInviteAcceptLambda = new JaleLambdaFunction(this, 'EmployerInviteAcceptLambda', {
      entry: path.join(__dirname, '../../lambda/api/employer-invite-accept.ts'),
      description: 'Accepts an employer invite for the signed-in login',
      vpc: props.vpc,
      securityGroups: [props.billingLambdaSg],
      timeout: 20,
      environment: {
        ...apiDb.environment,
        ...TEAM_DB_TIMEOUTS,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        TEAM_MANAGEMENT_ENABLED: teamManagementEnabled,
        EMPLOYER_USER_POOL_ID: props.employerUserPoolId,
      },
    });
    apiDb.grantRead(employerInviteAcceptLambda.function);
    employerInviteAcceptLambda.function.addToRolePolicy(memberAccessStatement(props.employerUserPoolArn));

    // ── Routes ──
    // /employer/team/{action} — the team dispatcher, employer auth. Both
    // nodes are created whatever the flag, so the resource count is the same
    // with it on and off (api-stack-resource-ceiling.test.ts).
    const employerAuth = {
      authorizer: props.employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };
    const teamActionResource = addPathOnlyResource(props.employerResource, 'team').addResource('{action}');
    teamActionResource.addMethod('GET', lambdaIntegration(employerTeamLambda.function), employerAuth);
    teamActionResource.addMethod('POST', lambdaIntegration(employerTeamLambda.function), employerAuth);

    // /employer/invites/{token} — GET public (lookup), POST employer auth (accept).
    const inviteTokenResource = addPathOnlyResource(props.employerResource, 'invites').addResource('{token}');
    inviteTokenResource.addMethod('GET', lambdaIntegration(employerInviteLookupLambda.function));
    inviteTokenResource.addMethod('POST', lambdaIntegration(employerInviteAcceptLambda.function), employerAuth);

    // /employer/billing — employer-auth routes
    const billingResource = props.employerResource.addResource('billing');

    billingResource.addMethod(
      'GET',
      lambdaIntegration(getBillingLambda.function),
      {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    billingResource.addResource('checkout').addMethod(
      'POST',
      lambdaIntegration(checkoutLambda.function),
      {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    billingResource.addResource('portal').addMethod(
      'POST',
      lambdaIntegration(portalLambda.function),
      {
        authorizer: props.employerAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      },
    );

    // POST /billing/webhook — public, no Cognito auth; Stripe HMAC validated in handler
    // Path-only: nothing on /billing itself, only /billing/webhook.
    const publicBillingResource = addPathOnlyResource(props.api.root, 'billing');
    publicBillingResource
      .addResource('webhook')
      .addMethod('POST', lambdaIntegration(webhookVerifierLambda.function));

    // ── Alarm notifications ──
    // billingAlarmTopicArn (if set) imports an existing monitored ops topic and
    // takes precedence over creating a new one. billingAlarmEmail only applies
    // to the CDK-created topic — subscribing to an imported topic from this
    // stack's account context isn't reliable, so that case is left to the
    // operator to wire up out-of-band.
    const alarmTopic = billingAlarmTopicArn
      ? sns.Topic.fromTopicArn(this, 'BillingAlarmTopic', billingAlarmTopicArn)
      : new sns.Topic(this, 'BillingAlarmTopic', { topicName: 'jale-billing-alarms' });

    if (!billingAlarmTopicArn && billingAlarmEmail) {
      (alarmTopic as sns.Topic).addSubscription(
        new subscriptions.EmailSubscription(billingAlarmEmail),
      );
    }

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    // ── CloudWatch Alarms ──
    // Both of these go through `jaleAlarm` for the one property they were
    // missing: `treatMissingData`. An idle webhook DLQ and an unthrottled
    // processor publish NO datapoints, so on CloudWatch's `missing` default
    // each alarm dropped to INSUFFICIENT_DATA the moment things were healthy
    // and climbed back to OK on the next datapoint. These two carry an OK
    // action, so every one of those flaps NOTIFIED THE OPERATOR that nothing
    // had happened — 64 of 87 alarm state transitions in one week, across this
    // stack and AiStack/MatchingStack.
    //
    // Thresholds, operators, periods and alarmNames are unchanged: an
    // alarmName change would make CloudFormation replace a live alarm.
    //
    // OK actions stay `addOkAction` calls on the returned alarm rather than a
    // second helper prop — recovery notification is this stack's policy, not
    // something every Jale alarm wants (AiStack's siblings deliberately have
    // none).
    const dlqDepthAlarm = jaleAlarm(this, 'BillingWebhookDlqAlarm', {
      metric: webhookDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'BillingWebhookDlqDepth',
      actions: [alarmAction],
    });
    dlqDepthAlarm.addOkAction(alarmAction);

    const processorThrottleAlarm = jaleAlarm(this, 'BillingProcessorThrottleAlarm', {
      metric: processorLambda.function.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      // `>` 5, not `>=`: five throttles in a five-minute window is tolerated,
      // six is the signal. Passed explicitly rather than left to the helper's
      // `>=` default, because the semantics belong to this alarm.
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmName: 'BillingProcessorThrottles',
      actions: [alarmAction],
    });
    processorThrottleAlarm.addOkAction(alarmAction);

    // ── Checkout error taxonomy metrics ──
    // Distinguish permanent Stripe configuration errors (checkout.ts logs
    // "billing-checkout configuration error: <reason>") from retryable
    // provider outages (checkout.ts logs "billing-checkout provider error:
    // <code>") so on-call sees a config break as a hard page, not noise
    // indistinguishable from Stripe having a bad day.
    const checkoutConfigErrorFilter = new logs.MetricFilter(this, 'CheckoutConfigErrorMetricFilter', {
      logGroup: checkoutLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'CheckoutConfigError',
      filterPattern: logs.FilterPattern.literal('"billing-checkout configuration error"'),
      metricValue: '1',
    });

    // Available for dashboards/ad-hoc alarms even though no alarm currently
    // keys off it directly.
    new logs.MetricFilter(this, 'CheckoutProviderErrorMetricFilter', {
      logGroup: checkoutLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'CheckoutProviderError',
      filterPattern: logs.FilterPattern.literal('"billing-checkout provider error"'),
      metricValue: '1',
    });

    const checkoutConfigErrorAlarm = new cloudwatch.Alarm(this, 'CheckoutConfigErrorAlarm', {
      metric: checkoutConfigErrorFilter.metric({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'CheckoutConfigErrorAlarm',
    });
    checkoutConfigErrorAlarm.addAlarmAction(alarmAction);
    checkoutConfigErrorAlarm.addOkAction(alarmAction);

    for (const [id, literal, metricName, alarmName] of [
      ['EmailOutboxRetryable', 'email_outbox_retryable_failure', 'EmailOutboxRetryableFailure', 'EmailOutboxRetryableFailureAlarm'],
      ['EmailOutboxUnknown', 'email_outbox_send_unknown', 'EmailOutboxSendUnknown', 'EmailOutboxSendUnknownAlarm'],
      ['EmailOutboxAttemptCap', 'email_outbox_attempt_cap', 'EmailOutboxAttemptCap', 'EmailOutboxAttemptCapAlarm'],
    ] as const) {
      const metricFilter = new logs.MetricFilter(this, `${id}MetricFilter`, {
        logGroup: emailSweeperLambda.logGroup,
        metricNamespace: 'Jale/Billing',
        metricName,
        filterPattern: logs.FilterPattern.literal(`"${literal}"`),
        metricValue: '1',
      });
      const alarm = new cloudwatch.Alarm(this, `${id}Alarm`, {
        metric: metricFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmName,
      });
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    // ── Unknown-customer terminal skip ──
    // processor.ts terminally skips a Stripe event whose customer has no
    // billing_customers row: the inbox row goes 'skipped' and the SQS message
    // is deleted, so the event never reaches the DLQ and
    // BillingWebhookDlqDepth stays silent. Nothing reads
    // billing_webhook_events either, so this filter over the PROCESSOR's log
    // group (not the sweeper's) is the only signal that an unmapped customer
    // is sending us events. The literal must match the console.warn payload in
    // lambda/billing/processor.ts.
    const unknownCustomerSkipFilter = new logs.MetricFilter(this, 'BillingUnknownCustomerSkippedMetricFilter', {
      logGroup: processorLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'BillingUnknownCustomerSkipped',
      filterPattern: logs.FilterPattern.literal('"billing_unknown_customer_skipped"'),
      metricValue: '1',
    });
    const unknownCustomerSkipAlarm = new cloudwatch.Alarm(this, 'BillingUnknownCustomerSkippedAlarm', {
      metric: unknownCustomerSkipFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'BillingUnknownCustomerSkipped',
    });
    unknownCustomerSkipAlarm.addAlarmAction(alarmAction);
    unknownCustomerSkipAlarm.addOkAction(alarmAction);

    // ── Known-but-skipped subscription events ──
    // processor.ts recognises two events it deliberately mirrors nothing for,
    // marking the inbox row 'skipped' and letting SQS delete the message:
    //   billing_event_skipped_known         — customer.subscription.trial_will_end
    //   billing_superseded_subscription_event — an event about a subscription
    //       that is NOT the user's current one (the user holds two live Stripe
    //       subscriptions and Stripe is still dunning the stale one)
    // Like the unknown-customer skip above, both are silent at every level —
    // no DLQ, no inbox reader — so this filter over the PROCESSOR's log group
    // is the only signal that a billing lifecycle event is being dropped. One
    // metric covers both: the operator response is the same (look at why a
    // lifecycle event went unmirrored), so a second alarm would only add
    // noise. (invoice.finalized is skipped too but intentionally NOT logged:
    // it fires on every invoice and would keep this alarm permanently
    // breached.) Both literals must match the console.warn calls in
    // lambda/billing/processor.ts.
    const knownEventSkipFilter = new logs.MetricFilter(this, 'BillingKnownEventSkippedMetricFilter', {
      logGroup: processorLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'BillingKnownEventSkipped',
      filterPattern: logs.FilterPattern.anyTerm('billing_event_skipped_known', 'billing_superseded_subscription_event'),
      metricValue: '1',
    });
    const knownEventSkipAlarm = new cloudwatch.Alarm(this, 'BillingKnownEventSkippedAlarm', {
      metric: knownEventSkipFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'BillingKnownEventSkipped',
    });
    knownEventSkipAlarm.addAlarmAction(alarmAction);
    knownEventSkipAlarm.addOkAction(alarmAction);

    // ── Member access (Phase 3): the sync cannot reach the employer pool ──
    // lambda/lib/member-access.ts logs member_access_pool_missing (no
    // EMPLOYER_USER_POOL_ID) or member_access_pool_unavailable (access denied,
    // pool not found, bad credentials) once per batch and fails the rest of
    // it without throwing, so the sync Lambda's Errors metric never moves. On
    // the SYNC's log group: it runs every 15 minutes, so a broken pool shows
    // up here within one period whatever the billing traffic.
    //
    // The period is 30 minutes, not 5: with one run every 15 minutes a 5-minute
    // period has no datapoint between runs, notBreaching turns that into OK,
    // and a persistent failure flapped ALARM -> OK -> ALARM, paging every run.
    // Every 30-minute period holds at least one run, so it stays in ALARM.
    const memberAccessPoolFilter = new logs.MetricFilter(this, 'MemberAccessPoolUnavailableMetricFilter', {
      logGroup: memberAccessSyncLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'MemberAccessPoolUnavailable',
      filterPattern: logs.FilterPattern.anyTerm('member_access_pool_unavailable', 'member_access_pool_missing'),
      metricValue: '1',
    });
    const memberAccessPoolAlarm = jaleAlarm(this, 'MemberAccessPoolUnavailableAlarm', {
      metric: memberAccessPoolFilter.metric({ period: MEMBER_ACCESS_SYNC_ALARM_PERIOD, statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmName: 'MemberAccessPoolUnavailable',
      actions: [alarmAction],
    });
    memberAccessPoolAlarm.addOkAction(alarmAction);

    // More changes in 7 days than one sync run reads (500): a metric for
    // dashboards, no alarm (the newest changes still converge first).
    new logs.MetricFilter(this, 'MemberAccessSyncSaturatedMetricFilter', {
      logGroup: memberAccessSyncLambda.logGroup,
      metricNamespace: 'Jale/Billing',
      metricName: 'MemberAccessSyncSaturated',
      filterPattern: logs.FilterPattern.literal('"member_access_sync_saturated"'),
      metricValue: '1',
    });

    // ── Team management (Phase 3): the API Lambdas' silent failures ──
    // Each handler catches its errors and answers 500 (or, after COMMIT,
    // answers success with accessUpdated:false), so its Errors metric never
    // moves. These filters on each Lambda's OWN log group are the signal; the
    // terms must match the handlers (metric-filter-patterns.test.ts):
    //   lookup : invite_lookup_misconfigured (wrong DB login: every lookup
    //            fails) and invite_lookup_failed (a DB error) —
    //            lambda/api/employer-invite-lookup.ts;
    //   accept : invite_accept_failed — lambda/api/employer-invite-accept.ts;
    //   team   : member_access_failed (a change whose Cognito attempts ran
    //            out) and member_access_deadline (changes left when the
    //            deadline hit) — lambda/lib/member-access.ts. A removed
    //            foreman may still be signed in until the 15-minute sync
    //            converges it; the DB membership check still answers 403.
    for (const [id, fn, terms, metricName] of [
      ['InviteLookupFailed', employerInviteLookupLambda, ['invite_lookup_misconfigured', 'invite_lookup_failed'], 'InviteLookupFailed'],
      ['InviteAcceptFailed', employerInviteAcceptLambda, ['invite_accept_failed'], 'InviteAcceptFailed'],
      ['TeamMemberAccessFailed', employerTeamLambda, ['member_access_failed', 'member_access_deadline'], 'TeamMemberAccessFailed'],
    ] as const) {
      const metricFilter = new logs.MetricFilter(this, `${id}MetricFilter`, {
        logGroup: fn.logGroup,
        metricNamespace: 'Jale/Billing',
        metricName,
        filterPattern: terms.length === 1
          ? logs.FilterPattern.literal(`"${terms[0]}"`)
          : logs.FilterPattern.anyTerm(...terms),
        metricValue: '1',
      });
      const teamAlarm = jaleAlarm(this, `${id}Alarm`, {
        metric: metricFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        alarmName: metricName,
        actions: [alarmAction],
      });
      teamAlarm.addOkAction(alarmAction);
    }

    // ── 1c: the webhook verifier's silent failures (roadmap 2026-10-01) ──
    // The verifier catches everything: a bad signature returns 400 (and logs
    // a bare BillingWebhookInvalidSignature line), any other error returns
    // 500 after logging "[billing-webhook] handler error". Neither throws, so
    // Lambda's own Errors metric never sees them, and a wrong or rotated
    // signing secret would reject every Stripe event unnoticed.
    for (const [id, literal, metricName, alarmName] of [
      ['BillingWebhookInvalidSignature', 'BillingWebhookInvalidSignature', 'WebhookInvalidSignature', 'BillingWebhookInvalidSignature'],
      ['BillingWebhookHandlerError', '[billing-webhook] handler error', 'WebhookHandlerErrors', 'BillingWebhookHandlerErrors'],
    ] as const) {
      const metricFilter = new logs.MetricFilter(this, `${id}MetricFilter`, {
        logGroup: webhookVerifierLambda.logGroup,
        metricNamespace: 'Jale/Billing',
        metricName,
        filterPattern: logs.FilterPattern.literal(`"${literal}"`),
        metricValue: '1',
      });
      const verifierAlarm = jaleAlarm(this, `${id}Alarm`, {
        metric: metricFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        alarmName,
        actions: [alarmAction],
      });
      verifierAlarm.addOkAction(alarmAction);
    }

    // Uncaught failures in the billing Lambdas: the processor throws on a
    // retryable error so SQS redelivers; the verifier catches every handler
    // error, so its Errors metric only moves on an init failure, a timeout,
    // or running out of memory.
    for (const [id, fn, alarmName, period] of [
      ['BillingWebhookLambdaErrorsAlarm', webhookVerifierLambda, 'BillingWebhookLambdaErrors', cdk.Duration.minutes(5)],
      ['BillingProcessorLambdaErrorsAlarm', processorLambda, 'BillingProcessorLambdaErrors', cdk.Duration.minutes(5)],
      // The sync throws only on a database failure (read or purge). Its
      // period matches its 15-minute schedule (see the pool alarm above).
      ['MemberAccessSyncLambdaErrorsAlarm', memberAccessSyncLambda, 'MemberAccessSyncLambdaErrors', MEMBER_ACCESS_SYNC_ALARM_PERIOD],
    ] as const) {
      const errorsAlarm = jaleAlarm(this, id, {
        metric: fn.function.metricErrors({ period, statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        alarmName,
        actions: [alarmAction],
      });
      errorsAlarm.addOkAction(alarmAction);
    }
  }
}
