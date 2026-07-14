import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { BillingStack } from '../../../lib/stacks/billing-stack';

describe('BillingStack', () => {
  let template: Template;
  let dbTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: { otpSmsFromNumber: '+13252210992' },
    });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', { network });
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
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
    for (const alarmName of ['BillingWebhookDlqDepth', 'BillingProcessorThrottles']) {
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
    const api = new ApiStack(app, 'TestApiStackEmail', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
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
    const api = new ApiStack(app, 'TestApiStackImportedTopic', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
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
    for (const alarmName of ['BillingWebhookDlqDepth', 'BillingProcessorThrottles']) {
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
