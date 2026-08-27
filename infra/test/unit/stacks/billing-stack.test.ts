import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { BillingStack, validateBillingEmailConfiguration } from '../../../lib/stacks/billing-stack';

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
      dbSecret: database.dbSecret,
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
      dbSecret: database.dbSecret,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
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

    new BillingStack(app, 'TestBillingStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      appDbSecret: database.dbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
    });
    template = Template.fromStack(app.node.findChild('TestBillingStack') as cdk.Stack);
    dbTemplate = Template.fromStack(database);
  });

  /**
   * DB_SECRET_ARN for a Lambda is a CFN intrinsic (Fn::ImportValue or Fn::Sub)
   * referencing the exported secret ARN from TestDatabaseStack. jale_admin
   * (appDbSecret) and jale_billing (billingDbSecret) are distinct Secrets
   * Manager resources with distinct logical ids/export names, so a deep-equal
   * comparison of the two Lambdas' DB_SECRET_ARN intrinsics tells us which
   * secret each one actually points at.
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

  test('email outbox sweeper uses jale_admin DB, configured sender, and a five-minute schedule', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Sends durable billing email outbox messages through SES',
      Environment: { Variables: Match.objectLike({
        DB_SECRET_ARN: dbSecretArnFor('Sends durable billing email outbox messages through SES'),
        EMAIL_FROM_ADDRESS: 'billing@jaleapp.ai',
        ALLOWED_ORIGIN: 'https://jaleapp.ai',
      }) },
    });
    expect(dbSecretArnFor('Sends durable billing email outbox messages through SES'))
      .toEqual(dbSecretArnFor('Returns employer billing status and plan entitlements'));
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  test('email sweeper IAM permits only ses:SendEmail on the configured identity', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Action: 'ses:SendEmail',
        Effect: 'Allow',
        Resource: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
      })]) },
    });
    const policies = template.findResources('AWS::IAM::Policy');
    const sesStatements = Object.values(policies).flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => JSON.stringify(statement.Action).includes('ses:'));
    expect(sesStatements).toEqual([expect.objectContaining({
      Action: 'ses:SendEmail',
      Resource: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
    })]);
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

  // ── DB role wiring (migration 034 fix) ────────────────────────────────────
  // jale_billing (jale/billing/db) is processor-only: no billing_operations
  // grant, no users access; owner RLS policies on the owned tables are TO
  // jale_admin. The three user-facing Lambdas must use the app DB credential
  // (jale_admin / database.dbSecret), the same one ApiStack Lambdas use.

  test('processor Lambda references the jale/billing/db (jale_billing) secret', () => {
    const processorArn = dbSecretArnFor('Processes verified Stripe webhook events from SQS');
    expect(processorArn).toBeDefined();
  });

  test('get-billing, checkout, and portal Lambdas reference the app DB secret, NOT jale/billing/db', () => {
    const processorArn = dbSecretArnFor('Processes verified Stripe webhook events from SQS');
    const getBillingArn = dbSecretArnFor('Returns employer billing status and plan entitlements');
    const checkoutArn = dbSecretArnFor('Creates Stripe Checkout session for employer subscription');
    const portalArn = dbSecretArnFor('Creates Stripe Customer Portal session for billing management');

    expect(getBillingArn).toBeDefined();
    expect(checkoutArn).toBeDefined();
    expect(portalArn).toBeDefined();

    // Each user-facing Lambda's DB_SECRET_ARN intrinsic must be identical to
    // the others (all point at the same app DB secret)...
    expect(getBillingArn).toEqual(checkoutArn);
    expect(checkoutArn).toEqual(portalArn);

    // ...and must differ from the processor's jale_billing secret intrinsic.
    expect(getBillingArn).not.toEqual(processorArn);
    expect(checkoutArn).not.toEqual(processorArn);
    expect(portalArn).not.toEqual(processorArn);
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

  // processor.ts recognises customer.subscription.trial_will_end and
  // deliberately mirrors nothing for it. That skip is silent at every level
  // (no DLQ, no inbox reader), so this filter is the only signal that a
  // billing lifecycle event is being dropped on the floor.

  test('BillingKnownEventSkipped metric filter reads the PROCESSOR log group for the known-skip literal', () => {
    const filters = template.findResources('AWS::Logs::MetricFilter', {
      Properties: { FilterPattern: '"billing_event_skipped_known"' },
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
      dbSecret: database.dbSecret,
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
      dbSecret: database.dbSecret,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    new LegalStack(app, 'TestLegalStackEmail', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });

    new BillingStack(app, 'TestBillingStackEmail', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      appDbSecret: database.dbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
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
      dbSecret: database.dbSecret,
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
      dbSecret: database.dbSecret,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    new LegalStack(app, 'TestLegalStackImportedTopic', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });

    new BillingStack(app, 'TestBillingStackImportedTopic', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      billingLambdaSg: network.billingLambdaSg,
      billingDbSecret: database.billingDbSecret,
      appDbSecret: database.dbSecret,
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
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
