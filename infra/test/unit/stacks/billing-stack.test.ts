import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { BillingStack, resolveInviteSiteBaseUrl, validateBillingEmailConfiguration } from '../../../lib/stacks/billing-stack';
import { dbLoginSecretName } from '../../../lib/constructs/db-login-secrets';

// Phase 3's team Lambdas (Task 11), by description.
const TEAM_DESCRIPTION = "Employer team: owner operations and the caller's membership";
const LOOKUP_DESCRIPTION = 'Public employer invite lookup by token';
const ACCEPT_DESCRIPTION = 'Accepts an employer invite for the signed-in login';
const TEAM_LAMBDA_DESCRIPTIONS = [TEAM_DESCRIPTION, LOOKUP_DESCRIPTION, ACCEPT_DESCRIPTION];

/**
 * Every Cognito grant in a BillingStack template. Exactly four roles: the
 * processor and the sync (billing suspend/restore, catch-up), and the team
 * dispatcher and the accept (invite, revoke, remove, rejoin). The public
 * invite lookup gets none. Run against a flag-off AND a flag-on synth: the
 * processor and the sync are not gated on teamManagementEnabled, because a
 * rollback (flag off) relies on them still converging Cognito.
 */
function expectExactlyTheFourCognitoGrants(template: Template): void {
  const grants: { roles: string; statement: any }[] = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy')) as any[]) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (JSON.stringify(statement.Action).includes('cognito-idp:')) {
        grants.push({ roles: JSON.stringify(policy.Properties.Roles), statement });
      }
    }
  }
  expect(grants).toHaveLength(4);
  expect(grants.map((g) => g.roles).sort()).toEqual([
    expect.stringMatching(/"Ref":"BillingProcessorLambda/),
    expect.stringMatching(/"Ref":"EmployerInviteAcceptLambda/),
    expect.stringMatching(/"Ref":"EmployerTeamLambda/),
    expect.stringMatching(/"Ref":"MemberAccessSyncLambda/),
  ]);
  for (const { statement } of grants) {
    expect(statement.Effect).toBe('Allow');
    expect([...statement.Action].sort()).toEqual([
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminUserGlobalSignOut',
    ]);
    // One resource: the employer pool's ARN, imported from the auth stack.
    expect(Array.isArray(statement.Resource)).toBe(false);
    const resource = JSON.stringify(statement.Resource);
    expect(resource).toMatch(/Fn::ImportValue/);
    expect(resource).toMatch(/EmployerPoolUserPool[0-9A-F]+Arn/);
    expect(resource).not.toMatch(/WorkerPool/);
    expect(resource).not.toContain('*');
  }
}

describe('invite site base URL', () => {
  test('is the https origin without a trailing slash', () => {
    expect(resolveInviteSiteBaseUrl('https://jaleapp.ai')).toBe('https://jaleapp.ai');
    expect(resolveInviteSiteBaseUrl('https://jaleapp.ai//')).toBe('https://jaleapp.ai');
    expect(resolveInviteSiteBaseUrl(' https://staging.jaleapp.ai ')).toBe('https://staging.jaleapp.ai');
  });

  test.each(['', '   ', 'http://jaleapp.ai', 'jaleapp.ai', 'ftp://jaleapp.ai', 'not a url'])(
    'fails the synth for %p: invite links must be https',
    (value) => {
      expect(() => resolveInviteSiteBaseUrl(value)).toThrow(/BillingStack requires an https publicSiteBaseUrl/);
    },
  );
});

describe('billing email configuration', () => {
  test('requires both sender values and rejects missing or partial configuration', () => {
    expect(() => validateBillingEmailConfiguration(undefined, undefined))
      .toThrow('emailFromAddress and sesVerifiedIdentityArn are required for billing email delivery');
    expect(() => validateBillingEmailConfiguration(
      'billing@jaleapp.ai',
      'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
    )).not.toThrow();
    expect(() => validateBillingEmailConfiguration('billing@jaleapp.ai', undefined))
      .toThrow('emailFromAddress and sesVerifiedIdentityArn are required for billing email delivery');
    expect(() => validateBillingEmailConfiguration(
      undefined,
      'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
    )).toThrow('emailFromAddress and sesVerifiedIdentityArn are required for billing email delivery');
  });
});

describe('BillingStack', () => {
  let template: Template;
  let dbTemplate: Template;
  let apiTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        emailFromAddress: 'billing@jaleapp.ai',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', { network });
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
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
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    // LegalStack must be created so the DualAuthorizer is attached to a method
    // (CDK validates this at synth time; Template.fromStack triggers synthesis).
    new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });

    new BillingStack(app, 'TestBillingStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
      employerUserPoolId: auth.employerPool.userPool.userPoolId,
      employerUserPoolArn: auth.employerPool.userPool.userPoolArn,
      teamManagementEnabled: false,
      publicSiteBaseUrl: 'https://jaleapp.ai',
    });
    template = Template.fromStack(app.node.findChild('TestBillingStack') as cdk.Stack);
    dbTemplate = Template.fromStack(database);
    apiTemplate = Template.fromStack(api);
  });

  /**
   * DB_SECRET_ARN for a Lambda is either a CFN intrinsic (Fn::ImportValue)
   * referencing a secret TestDatabaseStack exports — the billing service
   * login's — or the plain name of a dedicated login's secret, imported by name.
   * Distinct secrets therefore have distinct values, so a deep-equal
   * comparison of two Lambdas' DB_SECRET_ARN tells us whether they share one.
   */
  function dbSecretArnFor(description: string): unknown {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: description },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    return (fns[0] as any).Properties.Environment?.Variables?.DB_SECRET_ARN;
  }

  // ── Queue + DLQ ──────────────────────────────────────────────────────────

  test('Billing webhook SQS queue exists with KMS encryption', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'billing-webhook-queue',
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  test('Billing webhook DLQ exists with KMS encryption', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'billing-webhook-dlq',
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  test('Billing webhook queue has DLQ configured with maxReceiveCount 3', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'billing-webhook-queue',
      RedrivePolicy: {
        maxReceiveCount: 3,
      },
    });
  });

  test('Billing webhook queue visibility timeout is at least 6x the processor Lambda timeout', () => {
    // Processor timeout is 60s; visibility must be >= 360s
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'billing-webhook-queue',
      VisibilityTimeout: 360,
    });
  });

  // ── Lambda functions ─────────────────────────────────────────────────────

  test('get-billing Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Returns employer billing status and plan entitlements',
    });
  });

  test('checkout Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Creates Stripe Checkout session for employer subscription',
    });
  });

  test('portal Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Creates Stripe Customer Portal session for billing management',
    });
  });

  test('billing webhook verifier Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Verifies Stripe webhook signature and queues to SQS',
    });
  });

  test('billing processor Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Processes verified Stripe webhook events from SQS',
    });
  });

  test('email outbox sweeper connects as its own job login, with the configured sender and a five-minute schedule', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Sends durable billing email outbox messages through SES',
      Environment: { Variables: Match.objectLike({
        DB_SECRET_ARN: dbLoginSecretName('jale_job_email_sender'),
        DB_EXPECTED_LOGIN: 'jale_job_email_sender',
        EMAIL_FROM_ADDRESS: 'billing@jaleapp.ai',
        ALLOWED_ORIGIN: 'https://jaleapp.ai',
      }) },
    });
    // One sender drains both producers' rows, and its login can only claim and
    // mark outbox rows — so it must not share the request login employer
    // routes use.
    expect(dbSecretArnFor('Sends durable billing email outbox messages through SES'))
      .not.toEqual(dbSecretArnFor('Returns employer billing status and plan entitlements'));
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  /**
   * ses:SendEmail is the action that authorizes SESv2's SendEmail, including
   * the Content.Raw form the sweeper now uses. ses:SendRawEmail is the SESv1
   * action, kept for the transition window so a rollback to the previous
   * Lambda artifact does not also need an IAM change to send mail.
   */
  test('email sweeper IAM permits only the two SES send actions, on the configured identity', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const sesStatements = Object.values(policies).flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => JSON.stringify(statement.Action).includes('ses:'));
    expect(sesStatements).toEqual([expect.objectContaining({
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Effect: 'Allow',
      Resource: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
    })]);
  });

  /**
   * No configuration set was threaded into this harness, which is the dev-synth
   * shape: the sweeper still sends, tags nothing, and grants nothing extra.
   */
  test('omits the configuration-set env var and its ARN when no configuration set is configured', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const sweeper = Object.values(functions).find((fn: any) =>
      fn.Properties.Description === 'Sends durable billing email outbox messages through SES');
    expect(sweeper).toBeDefined();
    expect((sweeper as any).Properties.Environment.Variables.EMAIL_CONFIGURATION_SET).toBeUndefined();
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain('configuration-set/');
  });

  test('email outbox failure logs have metric filters and alarm-topic-backed alarms', () => {
    for (const [literal, metricName, alarmName] of [
      ['email_outbox_retryable_failure', 'EmailOutboxRetryableFailure', 'EmailOutboxRetryableFailureAlarm'],
      ['email_outbox_send_unknown', 'EmailOutboxSendUnknown', 'EmailOutboxSendUnknownAlarm'],
      ['email_outbox_attempt_cap', 'EmailOutboxAttemptCap', 'EmailOutboxAttemptCapAlarm'],
    ]) {
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterPattern: `"${literal}"`,
        MetricTransformations: Match.arrayWith([Match.objectLike({
          MetricNamespace: 'Jale/Billing', MetricName: metricName,
        })]),
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        AlarmActions: Match.anyValue(),
      });
    }
  });

  // ── 1c: the webhook verifier's silent failures ───────────────────
  test('webhook rejections, handler errors, and Lambda errors alarm to the ops topic', () => {
    for (const [literal, metricName, alarmName] of [
      ['BillingWebhookInvalidSignature', 'WebhookInvalidSignature', 'BillingWebhookInvalidSignature'],
      ['[billing-webhook] handler error', 'WebhookHandlerErrors', 'BillingWebhookHandlerErrors'],
    ]) {
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterPattern: `"${literal}"`,
        MetricTransformations: Match.arrayWith([Match.objectLike({
          MetricNamespace: 'Jale/Billing', MetricName: metricName, MetricValue: '1',
        })]),
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        Namespace: 'Jale/Billing',
        MetricName: metricName,
        Statistic: 'Sum',
        Period: 300,
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: Match.anyValue(),
        OKActions: Match.anyValue(),
      });
    }

    for (const [alarmName, functionIdPrefix, period] of [
      ['BillingWebhookLambdaErrors', 'BillingWebhookLambda', 300],
      ['BillingProcessorLambdaErrors', 'BillingProcessorLambda', 300],
      // The sync runs every 15 minutes: a 30-minute period always holds at
      // least one run, so a persistent failure stays in ALARM instead of
      // flapping ALARM -> OK (and paging) between runs.
      ['MemberAccessSyncLambdaErrors', 'MemberAccessSyncLambda', 1800],
    ] as const) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
        Statistic: 'Sum',
        Period: period,
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: Match.anyValue(),
        OKActions: Match.anyValue(),
        // Pin which Lambda this alarm watches: a verifier<->processor swap
        // must fail this test. The construct's Lambda Function child's
        // logical id is "<id>Function<hash>"; anchor the prefix so the
        // regex can only match this Lambda's logical id, not the other's.
        Dimensions: [{
          Name: 'FunctionName',
          Value: { Ref: Match.stringLikeRegexp(`^${functionIdPrefix}`) },
        }],
      });
    }
  });

  // ── Secret isolation matrix ──────────────────────────────────────────────

  test('get-billing Lambda has DB_SECRET_ARN but NOT STRIPE_SECRET_ARN', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Returns employer billing status and plan entitlements',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
    // get-billing must NOT have STRIPE_SECRET_ARN
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Description: 'Returns employer billing status and plan entitlements',
      },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).not.toHaveProperty('STRIPE_SECRET_ARN');
    expect(env).not.toHaveProperty('WEBHOOK_SECRET_ARN');
    expect(env).not.toHaveProperty('QUEUE_URL');
  });

  test('checkout Lambda has DB_SECRET_ARN and STRIPE_SECRET_ARN but NOT WEBHOOK_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Description: 'Creates Stripe Checkout session for employer subscription',
      },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).toHaveProperty('STRIPE_SECRET_ARN');
    expect(env).not.toHaveProperty('WEBHOOK_SECRET_ARN');
    expect(env).not.toHaveProperty('QUEUE_URL');
  });

  test('portal Lambda has DB_SECRET_ARN and STRIPE_SECRET_ARN but NOT WEBHOOK_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Description: 'Creates Stripe Customer Portal session for billing management',
      },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).toHaveProperty('STRIPE_SECRET_ARN');
    expect(env).not.toHaveProperty('WEBHOOK_SECRET_ARN');
  });

  test('webhook verifier Lambda has WEBHOOK_SECRET_ARN and QUEUE_URL but NOT DB_SECRET_ARN or STRIPE_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Description: 'Verifies Stripe webhook signature and queues to SQS',
      },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('WEBHOOK_SECRET_ARN');
    expect(env).toHaveProperty('QUEUE_URL');
    expect(env).not.toHaveProperty('DB_SECRET_ARN');
    expect(env).not.toHaveProperty('STRIPE_SECRET_ARN');
  });

  test('processor Lambda has DB_SECRET_ARN and STRIPE_SECRET_ARN but NOT WEBHOOK_SECRET_ARN', () => {
    const resources = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Description: 'Processes verified Stripe webhook events from SQS',
      },
    });
    const fns = Object.values(resources);
    expect(fns).toHaveLength(1);
    const env = (fns[0] as any).Properties.Environment?.Variables ?? {};
    expect(env).toHaveProperty('DB_SECRET_ARN');
    expect(env).toHaveProperty('STRIPE_SECRET_ARN');
    expect(env).not.toHaveProperty('WEBHOOK_SECRET_ARN');
    expect(env).not.toHaveProperty('QUEUE_URL');
  });

  // ── DB login wiring (migration 034 fix) ───────────────────────────────────
  // jale_billing is processor-only: no billing_operations grant, no users
  // access. The three user-facing Lambdas connect as the request login, the
  // same one every employer route in ApiStack uses.

  test("processor Lambda references the billing service login's secret and expects that login", () => {
    const processorArn = dbSecretArnFor('Processes verified Stripe webhook events from SQS');
    expect(processorArn).toBeDefined();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Processes verified Stripe webhook events from SQS',
      Environment: { Variables: Match.objectLike({ DB_EXPECTED_LOGIN: 'jale_billing' }) },
    });
  });

  test("get-billing, checkout, and portal Lambdas reference the request login's secret, not the billing service login's", () => {
    const processorArn = dbSecretArnFor('Processes verified Stripe webhook events from SQS');
    const getBillingArn = dbSecretArnFor('Returns employer billing status and plan entitlements');
    const checkoutArn = dbSecretArnFor('Creates Stripe Checkout session for employer subscription');
    const portalArn = dbSecretArnFor('Creates Stripe Customer Portal session for billing management');

    expect(getBillingArn).toBeDefined();
    expect(checkoutArn).toBeDefined();
    expect(portalArn).toBeDefined();
    expect(getBillingArn).toEqual(dbLoginSecretName('jale_api'));

    // Each user-facing Lambda's DB_SECRET_ARN must be identical to the others
    // (all point at the request login's secret)...
    expect(getBillingArn).toEqual(checkoutArn);
    expect(checkoutArn).toEqual(portalArn);

    // ...and must differ from the processor's jale_billing secret intrinsic.
    expect(getBillingArn).not.toEqual(processorArn);
    expect(checkoutArn).not.toEqual(processorArn);
    expect(portalArn).not.toEqual(processorArn);
  });

  // ── Phase 3: Cognito follows billing; the member-access sync ────────────

  const PROCESSOR_DESCRIPTION = 'Processes verified Stripe webhook events from SQS';
  const SYNC_DESCRIPTION = 'Converges employer Cognito sign-in with team membership every 15 minutes';

  function lambdaByDescription(description: string): { id: string; props: any } {
    const fns = Object.entries(template.findResources('AWS::Lambda::Function', {
      Properties: { Description: description },
    }));
    expect(fns).toHaveLength(1);
    return { id: fns[0][0], props: (fns[0][1] as any).Properties };
  }

  // One test for every Cognito grant in the stack. Exactly four roles:
  // the processor and the sync (billing suspend/restore, catch-up), and the
  // team dispatcher and the accept (invite, revoke, remove, rejoin). The
  // invite lookup is public and gets none. The processor and the sync are
  // NOT gated on teamManagementEnabled: this harness has the flag off, and a
  // rollback (flag off) relies on them still converging Cognito.
  test('only the team and accept Lambdas get the Cognito admin actions, scoped to the employer pool ARN (with the processor and the sync; flag off here)', () => {
    expectExactlyTheFourCognitoGrants(template);
  });

  test('the sync runs every 15 minutes', () => {
    const sync = lambdaByDescription(SYNC_DESCRIPTION);
    const rules = Object.values(template.findResources('AWS::Events::Rule', {
      Properties: { ScheduleExpression: 'rate(15 minutes)' },
    })) as any[];
    expect(rules).toHaveLength(1);
    expect(rules[0].Properties.Targets).toEqual([
      expect.objectContaining({
        Arn: { 'Fn::GetAtt': [sync.id, 'Arn'] },
        // The next run is the retry: EventBridge does not retry the target...
        RetryPolicy: { MaximumRetryAttempts: 0 },
      }),
    ]);
    expect(sync.id).toMatch(/^MemberAccessSyncLambda/);
    // ...and Lambda does not retry the async invocation.
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: sync.id },
      MaximumRetryAttempts: 0,
    });
  });

  test('the sync runs in the VPC with the billing security group, like the processor', () => {
    const sync = lambdaByDescription(SYNC_DESCRIPTION).props.VpcConfig;
    const processor = lambdaByDescription(PROCESSOR_DESCRIPTION).props.VpcConfig;
    expect(sync.SecurityGroupIds).toHaveLength(1);
    expect(JSON.stringify(sync.SecurityGroupIds)).toMatch(/BillingLambdaSg/);
    expect(sync.SecurityGroupIds).toEqual(processor.SecurityGroupIds);
    expect(sync.SubnetIds).toEqual(processor.SubnetIds);
  });

  test('the sync role can read the jale/billing/db secret', () => {
    const billingSecretIds = Object.keys(dbTemplate.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: 'jale/billing/db' },
    }));
    expect(billingSecretIds).toHaveLength(1);
    const syncPolicies = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes('"Ref":"MemberAccessSyncLambda'));
    const readsSecret = syncPolicies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .some((statement: any) => JSON.stringify(statement.Action).includes('secretsmanager:GetSecretValue')
        && JSON.stringify(statement.Resource).includes(billingSecretIds[0]));
    expect(readsSecret).toBe(true);
  });

  test('the employer pool being unusable from the sync alarms to the ops topic, with recovery', () => {
    const filters = Object.values(template.findResources('AWS::Logs::MetricFilter', {
      Properties: { FilterPattern: '?"member_access_pool_unavailable" ?"member_access_pool_missing"' },
    })) as any[];
    expect(filters).toHaveLength(1);
    expect(filters[0].Properties.LogGroupName).toEqual({ Ref: expect.stringMatching(/^MemberAccessSyncLambda/) });
    expect(filters[0].Properties.MetricTransformations).toEqual([expect.objectContaining({
      MetricNamespace: 'Jale/Billing', MetricName: 'MemberAccessPoolUnavailable', MetricValue: '1',
    })]);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'MemberAccessPoolUnavailable',
      Namespace: 'Jale/Billing',
      MetricName: 'MemberAccessPoolUnavailable',
      Statistic: 'Sum',
      // Two 15-minute sync runs per period: a broken pool stays in ALARM.
      Period: 1800,
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: Match.anyValue(),
      OKActions: Match.anyValue(),
    });
  });

  test('a saturated sync publishes a metric on the sync log group and has no alarm', () => {
    const filters = Object.values(template.findResources('AWS::Logs::MetricFilter', {
      Properties: { FilterPattern: '"member_access_sync_saturated"' },
    })) as any[];
    expect(filters).toHaveLength(1);
    expect(filters[0].Properties.LogGroupName).toEqual({ Ref: expect.stringMatching(/^MemberAccessSyncLambda/) });
    expect(filters[0].Properties.MetricTransformations).toEqual([expect.objectContaining({
      MetricNamespace: 'Jale/Billing', MetricName: 'MemberAccessSyncSaturated', MetricValue: '1',
    })]);
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as any[];
    expect(alarms.filter((alarm) => alarm.Properties.MetricName === 'MemberAccessSyncSaturated')).toEqual([]);
  });

  test('both get EMPLOYER_USER_POOL_ID', () => {
    for (const description of [PROCESSOR_DESCRIPTION, SYNC_DESCRIPTION]) {
      const poolId = JSON.stringify(lambdaByDescription(description).props.Environment.Variables.EMPLOYER_USER_POOL_ID);
      expect(poolId).toMatch(/Fn::ImportValue/);
      expect(poolId).toMatch(/EmployerPoolUserPool[0-9A-F]+/);
      expect(poolId).not.toMatch(/WorkerPool/);
    }
  });

  test('the sync connects as the billing service login, as the processor does, with no Stripe key', () => {
    const sync = lambdaByDescription(SYNC_DESCRIPTION);
    expect(sync.props.Environment.Variables.DB_EXPECTED_LOGIN).toBe('jale_billing');
    expect(dbSecretArnFor(SYNC_DESCRIPTION)).toEqual(dbSecretArnFor(PROCESSOR_DESCRIPTION));
    expect(sync.props.Environment.Variables).not.toHaveProperty('STRIPE_SECRET_ARN');
  });

  // ── Phase 3 team routes (Task 11) ─────────────────────────────────────────

  /** Logical id of the ApiStack resource `pathPart` under `parent` ('ROOT' for the API root). */
  function apiChild(parent: string, pathPart: string): string {
    const matches = Object.entries(apiTemplate.findResources('AWS::ApiGateway::Resource'))
      .filter(([, resource]: [string, any]) => {
        const parentId = resource.Properties.ParentId;
        const parentMatches = parent === 'ROOT' ? parentId['Fn::GetAtt'] !== undefined : parentId.Ref === parent;
        return parentMatches && resource.Properties.PathPart === pathPart;
      });
    expect(matches).toHaveLength(1);
    return matches[0][0];
  }

  /** Method -> { auth, lambda } for every method on one ApiStack resource. */
  function methodsOn(resourceId: string): Record<string, { auth: string; target: string }> {
    const methods: Record<string, { auth: string; target: string }> = {};
    for (const method of Object.values(apiTemplate.findResources('AWS::ApiGateway::Method')) as any[]) {
      if (method.Properties.ResourceId?.Ref !== resourceId) continue;
      const auth = method.Properties.AuthorizationType === 'COGNITO_USER_POOLS'
        ? `COGNITO:${method.Properties.AuthorizerId.Ref.replace(/[0-9A-F]{8}$/, '')}`
        : method.Properties.AuthorizationType;
      const uri = JSON.stringify(method.Properties.Integration?.Uri ?? '');
      const target = /EmployerTeamLambda/.test(uri) ? 'team'
        : /EmployerInviteLookupLambda/.test(uri) ? 'lookup'
          : /EmployerInviteAcceptLambda/.test(uri) ? 'accept'
            : method.Properties.Integration?.Type;
      methods[method.Properties.HttpMethod] = { auth, target };
    }
    return methods;
  }

  test('creates the four resources with the methods and authorization in the table', () => {
    const employer = apiChild('ROOT', 'employer');
    const team = apiChild(employer, 'team');
    const teamAction = apiChild(team, '{action}');
    const invites = apiChild(employer, 'invites');
    const inviteToken = apiChild(invites, '{token}');

    // Path-only: no method, not even a CORS preflight.
    expect(methodsOn(team)).toEqual({});
    expect(methodsOn(invites)).toEqual({});

    expect(methodsOn(teamAction)).toEqual({
      GET: { auth: 'COGNITO:EmployerAuthorizer', target: 'team' },
      POST: { auth: 'COGNITO:EmployerAuthorizer', target: 'team' },
      OPTIONS: { auth: 'NONE', target: 'MOCK' },
    });
    expect(methodsOn(inviteToken)).toEqual({
      // The invite page reads the invite before the person has an account.
      GET: { auth: 'NONE', target: 'lookup' },
      POST: { auth: 'COGNITO:EmployerAuthorizer', target: 'accept' },
      OPTIONS: { auth: 'NONE', target: 'MOCK' },
    });

    // Membership is served by the team dispatcher (/employer/team/membership),
    // not by a resource of its own: JaleApiStack's 470-resource gate.
    const membership = Object.values(apiTemplate.findResources('AWS::ApiGateway::Resource'))
      .filter((resource: any) => resource.Properties.PathPart === 'membership');
    expect(membership).toEqual([]);
  });

  test('the three team Lambdas run in the VPC with the billing security group, like the processor', () => {
    const processor = lambdaByDescription(PROCESSOR_DESCRIPTION).props.VpcConfig;
    for (const description of TEAM_LAMBDA_DESCRIPTIONS) {
      const vpcConfig = lambdaByDescription(description).props.VpcConfig;
      expect(vpcConfig.SecurityGroupIds).toEqual(processor.SecurityGroupIds);
      expect(JSON.stringify(vpcConfig.SecurityGroupIds)).toMatch(/BillingLambdaSg/);
      // The private subnets with NAT egress: the billing SG's HTTPS rule
      // reaches Cognito through the NAT gateway (no cognito-idp endpoint).
      expect(vpcConfig.SubnetIds).toEqual(processor.SubnetIds);
    }
  });

  test('each team Lambda stays under API Gateway\'s 29 s integration cap', () => {
    // 25 s: a remove that moves ~1,000 jobs (statements up to 10 s) still
    // leaves room for the ~10 s Cognito deadline after COMMIT.
    expect(lambdaByDescription(TEAM_DESCRIPTION).props.Timeout).toBe(25);
    expect(lambdaByDescription(ACCEPT_DESCRIPTION).props.Timeout).toBe(20);
    expect(lambdaByDescription(LOOKUP_DESCRIPTION).props.Timeout).toBe(10);
  });

  test('the public lookup has reserved concurrency: a hard cap on its jale_api_public connections', () => {
    // jale_api_public has no connection limit, and the stage throttle is the
    // only other brake on this unauthenticated route.
    expect(lambdaByDescription(LOOKUP_DESCRIPTION).props.ReservedConcurrentExecutions).toBe(10);
    expect(lambdaByDescription(TEAM_DESCRIPTION).props).not.toHaveProperty('ReservedConcurrentExecutions');
    expect(lambdaByDescription(ACCEPT_DESCRIPTION).props).not.toHaveProperty('ReservedConcurrentExecutions');
  });

  // The handlers catch their errors and answer 500, so a Lambda Errors alarm
  // would never move: these filters on each Lambda's own log group are the
  // signal. Terms must match the handlers (metric-filter-patterns.test.ts).
  test.each([
    ['EmployerInviteLookupLambda', '?"invite_lookup_misconfigured" ?"invite_lookup_failed"', 'InviteLookupFailed'],
    ['EmployerInviteAcceptLambda', '"invite_accept_failed"', 'InviteAcceptFailed'],
    ['EmployerTeamLambda', '?"member_access_failed" ?"member_access_deadline"', 'TeamMemberAccessFailed'],
  ])('%s failures alarm to the ops topic, with recovery', (logGroupPrefix, pattern, metricName) => {
    const filters = Object.values(template.findResources('AWS::Logs::MetricFilter', {
      Properties: { FilterPattern: pattern },
    })) as any[];
    expect(filters).toHaveLength(1);
    expect(filters[0].Properties.LogGroupName).toEqual({ Ref: expect.stringMatching(new RegExp(`^${logGroupPrefix}LogGroup`)) });
    expect(filters[0].Properties.MetricTransformations).toEqual([expect.objectContaining({
      MetricNamespace: 'Jale/Billing', MetricName: metricName, MetricValue: '1',
    })]);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: metricName,
      Namespace: 'Jale/Billing',
      MetricName: metricName,
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: Match.anyValue(),
      OKActions: Match.anyValue(),
    });
  });

  test('the team dispatcher env: request login, invite base URL, employer pool, flag, DB timeouts', () => {
    expect(lambdaByDescription(TEAM_DESCRIPTION).props.Environment.Variables).toEqual({
      DB_SECRET_ARN: dbLoginSecretName('jale_api'),
      DB_EXPECTED_LOGIN: 'jale_api',
      // 10 s, not 5: a remove moves every job of the member in one UPDATE.
      DB_STATEMENT_TIMEOUT_MS: '10000',
      DB_LOCK_TIMEOUT_MS: '3000',
      REQUIRED_TOS_VERSION: '1.0',
      ALLOWED_ORIGIN: 'https://jaleapp.ai',
      TEAM_MANAGEMENT_ENABLED: 'false',
      PUBLIC_SITE_BASE_URL: 'https://jaleapp.ai',
      EMPLOYER_USER_POOL_ID: expect.objectContaining({ 'Fn::ImportValue': expect.stringMatching(/EmployerPoolUserPool/) }),
    });
  });

  test('the accept env: request login, employer pool, flag, DB timeouts, no site URL', () => {
    expect(lambdaByDescription(ACCEPT_DESCRIPTION).props.Environment.Variables).toEqual({
      DB_SECRET_ARN: dbLoginSecretName('jale_api'),
      DB_EXPECTED_LOGIN: 'jale_api',
      DB_STATEMENT_TIMEOUT_MS: '5000',
      DB_LOCK_TIMEOUT_MS: '3000',
      REQUIRED_TOS_VERSION: '1.0',
      ALLOWED_ORIGIN: 'https://jaleapp.ai',
      TEAM_MANAGEMENT_ENABLED: 'false',
      EMPLOYER_USER_POOL_ID: expect.objectContaining({ 'Fn::ImportValue': expect.stringMatching(/EmployerPoolUserPool/) }),
    });
  });

  test('the lookup Lambda uses the jale_api_public login', () => {
    expect(lambdaByDescription(LOOKUP_DESCRIPTION).props.Environment.Variables).toEqual({
      DB_SECRET_ARN: dbLoginSecretName('jale_api_public'),
      DB_EXPECTED_LOGIN: 'jale_api_public',
      // One read-only function call: a statement bound, no lock wait to bound,
      // and no ToS check (the caller is signed out).
      DB_STATEMENT_TIMEOUT_MS: '5000',
      ALLOWED_ORIGIN: 'https://jaleapp.ai',
      TEAM_MANAGEMENT_ENABLED: 'false',
    });

    // Its role reads the public login's secret and no other database secret.
    const lookup = lambdaByDescription(LOOKUP_DESCRIPTION);
    const roleRef = lookup.props.Role['Fn::GetAtt'][0];
    const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(`"Ref":"${roleRef}"`))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const secretResources = JSON.stringify(statements
      .filter((statement: any) => JSON.stringify(statement.Action).includes('secretsmanager:GetSecretValue'))
      .map((statement: any) => statement.Resource));
    expect(secretResources).toContain('secret:jale/api-public/db');
    expect(secretResources).not.toContain('secret:jale/api/db');
    expect(secretResources).not.toContain('billing');
  });

  test('the team and accept roles read the request login secret', () => {
    for (const description of [TEAM_DESCRIPTION, ACCEPT_DESCRIPTION]) {
      const roleRef = lambdaByDescription(description).props.Role['Fn::GetAtt'][0];
      const statements = (Object.values(template.findResources('AWS::IAM::Policy')) as any[])
        .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(`"Ref":"${roleRef}"`))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
      const secretResources = JSON.stringify(statements
        .filter((statement: any) => JSON.stringify(statement.Action).includes('secretsmanager:GetSecretValue'))
        .map((statement: any) => statement.Resource));
      expect(secretResources).toContain('secret:jale/api/db');
      expect(secretResources).not.toContain('api-public');
    }
  });

  test('TEAM_MANAGEMENT_ENABLED is false on the three team Lambdas when the flag is off', () => {
    for (const description of TEAM_LAMBDA_DESCRIPTIONS) {
      expect(lambdaByDescription(description).props.Environment.Variables.TEAM_MANAGEMENT_ENABLED).toBe('false');
    }
    // The processor and the sync carry no flag at all: they run either way.
    for (const description of [PROCESSOR_DESCRIPTION, SYNC_DESCRIPTION]) {
      expect(lambdaByDescription(description).props.Environment.Variables).not.toHaveProperty('TEAM_MANAGEMENT_ENABLED');
    }
  });

  test('get-billing, checkout, and portal Lambda roles have NO IAM grant on the jale/billing/db secret', () => {
    // Resolve the jale/billing/db secret's logical id in TestDatabaseStack so we
    // can recognize its ARN reference inside cross-stack IAM policy statements.
    const billingSecretResources = dbTemplate.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: 'jale/billing/db' },
    });
    const billingSecretLogicalIds = Object.keys(billingSecretResources);
    expect(billingSecretLogicalIds.length).toBe(1);

    const descriptions = [
      'Returns employer billing status and plan entitlements',
      'Creates Stripe Checkout session for employer subscription',
      'Creates Stripe Customer Portal session for billing management',
    ];

    for (const description of descriptions) {
      const fnResources = template.findResources('AWS::Lambda::Function', {
        Properties: { Description: description },
      });
      const fnLogicalIds = Object.keys(fnResources);
      expect(fnLogicalIds).toHaveLength(1);

      // Every IAM Policy in this stack whose statements mention the billing
      // secret's cross-stack export must NOT be one of these Lambdas' policies.
      const policies = template.findResources('AWS::IAM::Policy');
      for (const [policyId, policy] of Object.entries(policies)) {
        const policyJson = JSON.stringify((policy as any).Properties);
        const referencesBillingSecret = billingSecretLogicalIds.some((id) => policyJson.includes(id));
        if (referencesBillingSecret) {
          // This policy is for the processor (or another billing-secret reader),
          // not for get-billing/checkout/portal — assert by name convention.
          expect(policyId.toLowerCase()).not.toMatch(/getbilling|checkoutlambda|portallambda/);
        }
      }
    }
  });

  // ── Routes ───────────────────────────────────────────────────────────────
  // NOTE: CDK synthesizes ALL AWS::ApiGateway::Resource and ::Method nodes into
  // the stack that OWNS the RestApi (ApiStack), not BillingStack.  Route
  // assertions for billing endpoints therefore live in api-stack.test.ts.

  // ── Alarms ───────────────────────────────────────────────────────────────

  test('DLQ depth alarm exists for billing webhook DLQ', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'BillingWebhookDlqDepth',
      Threshold: 1,
    });
  });

  test('Processor throttle alarm exists', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'BillingProcessorThrottles',
      Threshold: 5,
    });
  });

  // ── Alarm hygiene (sprint 24 A4) ──────────────────────────────────────────
  //
  // Both of these were declared inline with no `treatMissingData` and so
  // inherited CloudWatch's `missing` default. An idle webhook DLQ and an
  // unthrottled processor emit no datapoints, so each alarm sat flapping
  // OK <-> INSUFFICIENT_DATA — and both carry an OK action, so every flap sent
  // the operator a notification saying nothing had happened.
  //
  // Everything except TreatMissingData is pinned here BECAUSE the migration to
  // `jaleAlarm()` touches these lines: an accidental change to a threshold, a
  // period, an operator or (worst) the AlarmName lands on a live alarm, and an
  // AlarmName change replaces it.
  const BILLING_ALARMS = [
    {
      constructId: 'BillingWebhookDlqAlarm',
      alarmName: 'BillingWebhookDlqDepth',
      threshold: 1,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      metricName: 'ApproximateNumberOfMessagesVisible',
      period: 300,
    },
    {
      constructId: 'BillingProcessorThrottleAlarm',
      alarmName: 'BillingProcessorThrottles',
      threshold: 5,
      // Deliberately `>` and not `>=`: five throttles in five minutes is the
      // tolerated level, six is the problem. Preserved exactly.
      comparisonOperator: 'GreaterThanThreshold',
      metricName: 'Throttles',
      period: 300,
    },
  ] as const;

  test.each(BILLING_ALARMS)(
    '$alarmName treats missing data as notBreaching with its threshold, operator and period unchanged',
    ({ constructId, alarmName, threshold, comparisonOperator, metricName, period }) => {
      const alarms = template.findResources('AWS::CloudWatch::Alarm', {
        Properties: { AlarmName: alarmName },
      });
      expect(Object.keys(alarms)).toHaveLength(1);
      const alarm = Object.values(alarms)[0] as any;

      expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
      expect(alarm.Properties.Threshold).toBe(threshold);
      expect(alarm.Properties.ComparisonOperator).toBe(comparisonOperator);
      expect(alarm.Properties.EvaluationPeriods).toBe(1);
      expect(alarm.Properties.MetricName).toBe(metricName);
      expect(alarm.Properties.Period).toBe(period);
      expect(alarm.Properties.DatapointsToAlarm).toBeUndefined();
      // Both actions survive the migration: ALARM pages, OK closes the page.
      expect(alarm.Properties.AlarmActions).toBeDefined();
      expect(alarm.Properties.OKActions).toBeDefined();

      const [logicalId] = Object.keys(alarms);
      expect(logicalId).toMatch(new RegExp(`^${constructId}[0-9A-F]{8}$`));
    },
  );

  // ── Unknown-customer terminal skip (compensating observability) ──────────
  //
  // processor.ts terminally skips events whose Stripe customer has no
  // billing_customers row: the inbox row goes 'skipped' and the SQS message is
  // deleted, so the event never reaches the DLQ and BillingWebhookDlqDepth
  // stays silent. This metric filter is the ONLY signal that an unmapped
  // customer is sending us events.

  test('BillingUnknownCustomerSkipped metric filter reads the PROCESSOR log group for the skip literal', () => {
    const filters = template.findResources('AWS::Logs::MetricFilter', {
      Properties: { FilterPattern: '"billing_unknown_customer_skipped"' },
    });
    const matching = Object.values(filters);
    expect(matching).toHaveLength(1);
    const props = (matching[0] as any).Properties;

    // Load-bearing: wiring this filter to the email sweeper's log group (the
    // block it is modelled on) would still satisfy a pattern-and-namespace-only
    // assertion while silently never firing in production, because the
    // processor is the only Lambda that emits this literal.
    expect(JSON.stringify(props.LogGroupName)).toMatch(/BillingProcessorLambdaLogGroup/);
    expect(props.MetricTransformations).toEqual([expect.objectContaining({
      MetricNamespace: 'Jale/Billing',
      MetricName: 'BillingUnknownCustomerSkipped',
      MetricValue: '1',
    })]);
  });

  test('BillingUnknownCustomerSkipped alarm fires on >= 1 skip in a 5-minute period, missing data not breaching', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'BillingUnknownCustomerSkipped',
      Threshold: 1,
      EvaluationPeriods: 1,
      Period: 300,
      Statistic: 'Sum',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      MetricName: 'BillingUnknownCustomerSkipped',
      Namespace: 'Jale/Billing',
    });
  });

  // processor.ts terminally skips two recognised events without mirroring
  // them: customer.subscription.trial_will_end, and any event about a
  // subscription that is not the user's current one. Both skips are silent at
  // every level (no DLQ, no inbox reader), so this filter is the only signal
  // that a billing lifecycle event is being dropped on the floor. One filter
  // matches BOTH literals via anyTerm, so a regression that drops either
  // literal from the pattern fails here.

  test('BillingKnownEventSkipped metric filter reads the PROCESSOR log group for both known-skip literals', () => {
    const filters = template.findResources('AWS::Logs::MetricFilter', {
      Properties: { FilterPattern: '?"billing_event_skipped_known" ?"billing_superseded_subscription_event"' },
    });
    const matching = Object.values(filters);
    expect(matching).toHaveLength(1);
    const props = (matching[0] as any).Properties;

    // Load-bearing for the same reason as the unknown-customer filter: the
    // processor is the only Lambda that emits this literal, so pointing this
    // at any other log group would satisfy a pattern-only assertion while
    // never firing in production.
    expect(JSON.stringify(props.LogGroupName)).toMatch(/BillingProcessorLambdaLogGroup/);
    expect(props.MetricTransformations).toEqual([expect.objectContaining({
      MetricNamespace: 'Jale/Billing',
      MetricName: 'BillingKnownEventSkipped',
      MetricValue: '1',
    })]);
  });

  test('BillingKnownEventSkipped alarm fires on >= 1 skip in a 5-minute period, missing data not breaching', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'BillingKnownEventSkipped',
      Threshold: 1,
      EvaluationPeriods: 1,
      Period: 300,
      Statistic: 'Sum',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      MetricName: 'BillingKnownEventSkipped',
      Namespace: 'Jale/Billing',
    });
  });

  // ── Checkout error taxonomy (config vs. provider) ───────────────────────

  test('CheckoutConfigError metric filter matches the configuration-error log literal into Jale/Billing', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"billing-checkout configuration error"',
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricNamespace: 'Jale/Billing',
          MetricName: 'CheckoutConfigError',
        }),
      ]),
    });
  });

  test('CheckoutProviderError metric filter matches the provider-error log literal into Jale/Billing', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"billing-checkout provider error"',
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricNamespace: 'Jale/Billing',
          MetricName: 'CheckoutProviderError',
        }),
      ]),
    });
  });

  test('CheckoutConfigErrorAlarm fires on >= 1 CheckoutConfigError in a single 5-minute period, treating missing data as not breaching', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'CheckoutConfigErrorAlarm',
      Threshold: 1,
      EvaluationPeriods: 1,
      Period: 300,
      Statistic: 'Sum',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      MetricName: 'CheckoutConfigError',
      Namespace: 'Jale/Billing',
    });
  });

  test('CheckoutConfigErrorAlarm is wired to the billing alarm topic', () => {
    const topics = template.findResources('AWS::SNS::Topic', {
      Properties: { TopicName: 'jale-billing-alarms' },
    });
    const topicLogicalIds = Object.keys(topics);
    expect(topicLogicalIds).toHaveLength(1);

    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { AlarmName: 'CheckoutConfigErrorAlarm' },
    });
    const matching = Object.values(alarms);
    expect(matching).toHaveLength(1);
    const alarm = matching[0] as any;
    const alarmActionsJson = JSON.stringify(alarm.Properties.AlarmActions);
    const okActionsJson = JSON.stringify(alarm.Properties.OKActions);
    expect(topicLogicalIds.some((id) => alarmActionsJson.includes(id))).toBe(true);
    expect(topicLogicalIds.some((id) => okActionsJson.includes(id))).toBe(true);
  });

  // ── Alarm notifications ──────────────────────────────────────────────────

  test('billing alarm SNS topic exists', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'jale-billing-alarms',
    });
  });

  test('both alarms have AlarmActions and OKActions referencing the alarm topic', () => {
    const topics = template.findResources('AWS::SNS::Topic', {
      Properties: { TopicName: 'jale-billing-alarms' },
    });
    const topicLogicalIds = Object.keys(topics);
    expect(topicLogicalIds).toHaveLength(1);

    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { AlarmName: Match.anyValue() },
    });
    for (const alarmName of [
      'BillingWebhookDlqDepth',
      'BillingProcessorThrottles',
      'BillingUnknownCustomerSkipped',
      'BillingKnownEventSkipped',
    ]) {
      const matching = Object.values(alarms).filter(
        (a: any) => a.Properties.AlarmName === alarmName,
      );
      expect(matching).toHaveLength(1);
      const alarm = matching[0] as any;
      const alarmActionsJson = JSON.stringify(alarm.Properties.AlarmActions);
      const okActionsJson = JSON.stringify(alarm.Properties.OKActions);
      expect(topicLogicalIds.some((id) => alarmActionsJson.includes(id))).toBe(true);
      expect(topicLogicalIds.some((id) => okActionsJson.includes(id))).toBe(true);
    }
  });
});

describe('BillingStack — alarm email subscription', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        billingAlarmEmail: 'ops-alerts@example.com',
        emailFromAddress: 'billing@jaleapp.ai',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStackEmail');
    const database = new DatabaseStack(app, 'TestDatabaseStackEmail', { network });
    const auth = new AuthStack(app, 'TestAuthStackEmail', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
    });
    const ai = new AiStack(app, 'TestAiStackEmail', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    const api = new ApiStack(app, 'TestApiStackEmail', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    new LegalStack(app, 'TestLegalStackEmail', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });

    new BillingStack(app, 'TestBillingStackEmail', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
      employerUserPoolId: auth.employerPool.userPool.userPoolId,
      employerUserPoolArn: auth.employerPool.userPool.userPoolArn,
      teamManagementEnabled: false,
      publicSiteBaseUrl: 'https://jaleapp.ai',
    });
    template = Template.fromStack(app.node.findChild('TestBillingStackEmail') as cdk.Stack);
  });

  test('an email subscription exists for the configured billingAlarmEmail', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops-alerts@example.com',
    });
  });
});

describe('BillingStack — imported alarm topic', () => {
  let template: Template;
  const importedTopicArn = 'arn:aws:sns:us-east-2:123456789012:jale-ops-alarms';

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        billingAlarmTopicArn: importedTopicArn,
        emailFromAddress: 'billing@jaleapp.ai',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStackImportedTopic');
    const database = new DatabaseStack(app, 'TestDatabaseStackImportedTopic', { network });
    const auth = new AuthStack(app, 'TestAuthStackImportedTopic', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
    });
    const ai = new AiStack(app, 'TestAiStackImportedTopic', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    const api = new ApiStack(app, 'TestApiStackImportedTopic', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    new LegalStack(app, 'TestLegalStackImportedTopic', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });

    new BillingStack(app, 'TestBillingStackImportedTopic', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
      employerUserPoolId: auth.employerPool.userPool.userPoolId,
      employerUserPoolArn: auth.employerPool.userPool.userPoolArn,
      teamManagementEnabled: false,
      publicSiteBaseUrl: 'https://jaleapp.ai',
    });
    template = Template.fromStack(
      app.node.findChild('TestBillingStackImportedTopic') as cdk.Stack,
    );
  });

  test('no new SNS topic is created when billingAlarmTopicArn is set', () => {
    const topics = template.findResources('AWS::SNS::Topic');
    expect(Object.keys(topics)).toHaveLength(0);
  });

  test('alarm actions reference the imported topic ARN', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { AlarmName: Match.anyValue() },
    });
    for (const alarmName of [
      'BillingWebhookDlqDepth',
      'BillingProcessorThrottles',
      'BillingUnknownCustomerSkipped',
      'BillingKnownEventSkipped',
    ]) {
      const matching = Object.values(alarms).filter(
        (a: any) => a.Properties.AlarmName === alarmName,
      );
      expect(matching).toHaveLength(1);
      const alarm = matching[0] as any;
      expect(alarm.Properties.AlarmActions).toContain(importedTopicArn);
      expect(alarm.Properties.OKActions).toContain(importedTopicArn);
    }
  });
});

describe('BillingStack — SES configuration set threaded in', () => {
  let template: Template;
  const CONFIGURATION_SET = 'jale-employer-email';

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        emailFromAddress: 'billing@jaleapp.ai',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStackConfigSet');
    const database = new DatabaseStack(app, 'TestDatabaseStackConfigSet', { network });
    const auth = new AuthStack(app, 'TestAuthStackConfigSet', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
    });
    const ai = new AiStack(app, 'TestAiStackConfigSet', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    const api = new ApiStack(app, 'TestApiStackConfigSet', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    new LegalStack(app, 'TestLegalStackConfigSet', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });

    new BillingStack(app, 'TestBillingStackConfigSet', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
      employerUserPoolId: auth.employerPool.userPool.userPoolId,
      employerUserPoolArn: auth.employerPool.userPool.userPoolArn,
      // The flag on, here only: the main harness keeps it off.
      teamManagementEnabled: true,
      publicSiteBaseUrl: 'https://jaleapp.ai/',
      emailConfigurationSetName: CONFIGURATION_SET,
    });
    template = Template.fromStack(app.node.findChild('TestBillingStackConfigSet') as cdk.Stack);
  });

  test('with teamManagementEnabled, the three team Lambdas get TEAM_MANAGEMENT_ENABLED=true', () => {
    for (const description of TEAM_LAMBDA_DESCRIPTIONS) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: description,
        Environment: { Variables: Match.objectLike({ TEAM_MANAGEMENT_ENABLED: 'true' }) },
      });
    }
  });

  test('with the flag on, the same four roles hold the Cognito grant', () => {
    expectExactlyTheFourCognitoGrants(template);
  });

  test('a trailing slash on the public site base URL is dropped', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: TEAM_DESCRIPTION,
      Environment: { Variables: Match.objectLike({ PUBLIC_SITE_BASE_URL: 'https://jaleapp.ai' }) },
    });
  });

  test('gives the sweeper the configuration-set name so every message is tagged for bounce routing', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Sends durable billing email outbox messages through SES',
      Environment: { Variables: Match.objectLike({ EMAIL_CONFIGURATION_SET: CONFIGURATION_SET }) },
    });
  });

  /**
   * SES checks a send that names a configuration set against BOTH the identity
   * and the configuration-set ARN, so both belong in the one statement.
   */
  test('scopes the SES send grant to the identity AND the configuration set', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const sesStatements = Object.values(policies).flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => JSON.stringify(statement.Action).includes('ses:'));
    expect(sesStatements).toHaveLength(1);
    expect(sesStatements[0].Action).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
    expect(JSON.stringify(sesStatements[0].Resource)).toContain('identity/jaleapp.ai');
    expect(JSON.stringify(sesStatements[0].Resource)).toContain(`configuration-set/${CONFIGURATION_SET}`);
  });
});
