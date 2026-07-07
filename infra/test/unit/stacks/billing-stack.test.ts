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
      api: api.api,
      employerAuthorizer: api.employerAuthorizer,
      employerResource: api.employerResource,
    });
    template = Template.fromStack(app.node.findChild('TestBillingStack') as cdk.Stack);
  });

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
});
