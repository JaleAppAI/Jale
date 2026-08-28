import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { WhatsAppStack } from '../../../lib/stacks/whatsapp-stack';

describe('WhatsAppStack', () => {
  let template: Template;
  let apiTemplate: Template;
  // Task 15 (confirmed blocker): the processor Lambda's bundled asset
  // directory on disk, used to verify the `nodeModules` esbuild-bundling
  // override actually landed the real npm package next to the compiled
  // handler — `nodeModules` has no representation in the CloudFormation
  // template itself (Template.fromStack only sees the final Code.S3Key
  // asset hash), so this is the only way to test it. jest-autoclean
  // (jest.config.js's setupFilesAfterEnv) only wipes these temp directories
  // in a file-level `afterAll`, so they're guaranteed to still be on disk
  // for every test in this file.
  let processorAssetDir: string;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        whatsappStatusCallbackUrl:
          'https://callbacks.example.test/prod/whatsapp/status-callback',
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
      whatsappStatusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    });
    // LegalStack must be instantiated to satisfy CDK validation: the
    // DualAuthorizer is created in ApiStack but only "attached to a RestApi"
    // when a route uses it (POST /legal/accept in LegalStack). Without this,
    // Template.fromStack() fails with "must be attached to a RestApi".
    new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });
    // Stand-in for DocumentsStack's KMS-encrypted bucket (Task 12). A
    // separate mini-stack keeps this test independent of DocumentsStack's
    // own Lambda bundling while still exercising a real cross-stack
    // construct reference, same as production wiring in bin/jale-app.ts.
    const docsBucketStack = new cdk.Stack(app, 'TestDocsBucketStack');
    const docsKey = new kms.Key(docsBucketStack, 'TestDocsKey');
    const docsBucket = new s3.Bucket(docsBucketStack, 'TestDocsBucket', {
      encryptionKey: docsKey,
      encryption: s3.BucketEncryption.KMS,
    });

    const whatsapp = new WhatsAppStack(app, 'TestWhatsAppStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      workerPool: auth.workerPool,
      api: api.api,
      workerResource: api.workerResource,
      workerAuthorizer: api.workerAuthorizer,
      questionGeneratorFn: ai.questionGeneratorFn.function,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      trustAssessmentQueue: ai.trustAssessmentQueue,
      trustExtractionQueue: ai.trustExtractionQueue,
      statusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-whatsapp-alarms-test',
      documentsBucket: docsBucket,
    });
    template = Template.fromStack(whatsapp);
    apiTemplate = Template.fromStack(api);

    const functions = template.findResources('AWS::Lambda::Function');
    const [, processorFn] = Object.entries(functions).find(([, r]: [string, any]) =>
      /SQS processor/.test(r.Properties?.Description ?? '')) as [string, any];
    const processorAssetHash = (processorFn.Properties.Code.S3Key as string).replace(/\.zip$/, '');
    processorAssetDir = path.join(app.outdir, `asset.${processorAssetHash}`);
  });

  // ── SQS infrastructure ─────────────────────────────────────────
  test('Stack creates inbound and wake queues with a DLQ for each lane', () => {
    template.resourceCountIs('AWS::SQS::Queue', 8);
  });

describe('event-driven outbox wake queues', () => {
    test.each([
      ['whatsapp-worker-intent-wake', 360],
      ['whatsapp-domain-outbox-wake', 360],
    ])('%s is KMS encrypted with a recovery DLQ', (queueName, visibilityTimeout) => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: queueName,
        KmsMasterKeyId: 'alias/aws/sqs',
        VisibilityTimeout: visibilityTimeout,
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
      });
    });

    test.each([
      ['whatsapp-worker-intent-wake-dlq'],
      ['whatsapp-domain-outbox-wake-dlq'],
    ])('%s retains failures for 14 days', (queueName) => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: queueName,
        KmsMasterKeyId: 'alias/aws/sqs',
        MessageRetentionPeriod: 1209600,
      });
    });

    test('processor receives both wake queue URLs', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const processor = Object.values(functions).find((resource: any) =>
        /SQS processor/.test(resource.Properties?.Description ?? '')) as any;
      expect(processor.Properties.Environment.Variables.WORKER_INTENT_WAKE_QUEUE_URL).toBeDefined();
      expect(processor.Properties.Environment.Variables.DOMAIN_OUTBOX_WAKE_QUEUE_URL).toBeDefined();
    });

    test('both drains have SQS event-source mappings in addition to recovery schedules', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const workerEntry = Object.entries(functions).find(([, resource]: [string, any]) =>
        /Worker intent outbox drain/.test(resource.Properties?.Description ?? ''))!;
      const domainEntry = Object.entries(functions).find(([, resource]: [string, any]) =>
        /Domain outbox drain/.test(resource.Properties?.Description ?? ''))!;
      const mappings = Object.values(template.findResources('AWS::Lambda::EventSourceMapping')) as any[];

      expect(mappings.some((mapping) => mapping.Properties.FunctionName.Ref === workerEntry[0]
        && mapping.Properties.BatchSize === 1)).toBe(true);
      expect(mappings.some((mapping) => mapping.Properties.FunctionName.Ref === domainEntry[0]
        && mapping.Properties.BatchSize === 1)).toBe(true);
    });

    test.each([
      ['WhatsAppWorkerIntentWakeDlqDepth', 1],
      ['WhatsAppDomainOutboxWakeDlqDepth', 1],
      ['WhatsAppWorkerIntentWakeAge', 15],
      ['WhatsAppDomainOutboxWakeAge', 15],
      ['WhatsAppOutboxWakeFailures', 1],
    ])('%s alarm exists and is actionable', (alarmName, threshold) => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        Threshold: threshold,
        AlarmActions: Match.anyValue(),
      });
    });
  });
  test('Inbound SQS queue exists with 360s visibility timeout', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'whatsapp-inbound-queue',
      VisibilityTimeout: 360,
    });
  });

  test('Inbound queue has DLQ with maxReceiveCount 3', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'whatsapp-inbound-queue',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  test('DLQ exists with KMS-managed encryption', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'whatsapp-inbound-dlq',
      KmsMasterKeyId: 'alias/aws/sqs',
    });
  });

  // ── v2 FIFO SQS infrastructure (additive) ───────────────────────
  describe('v2 FIFO inbound queue and DLQ', () => {
    test('v2 FIFO inbound queue exists with ContentBasedDeduplication false', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2.fifo',
        FifoQueue: true,
        ContentBasedDeduplication: false,
      });
    });

    test('v2 FIFO DLQ exists with 14-day retention', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2-dlq.fifo',
        FifoQueue: true,
        ContentBasedDeduplication: false,
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
    });

    test('v2 queue redrive policy has maxReceiveCount 5', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2.fifo',
        RedrivePolicy: Match.objectLike({
          maxReceiveCount: 5,
        }),
      });
    });

    test('v2 queue and DLQ both use KMS-managed encryption', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2.fifo',
        KmsMasterKeyId: 'alias/aws/sqs',
      });
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2-dlq.fifo',
        KmsMasterKeyId: 'alias/aws/sqs',
      });
    });

    test('v2 queue has a 360s visibility timeout', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2.fifo',
        VisibilityTimeout: 360,
      });
    });

    test('legacy inbound queue is untouched: still exists with maxReceiveCount 3', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-queue',
        RedrivePolicy: Match.objectLike({
          maxReceiveCount: 3,
        }),
      });
    });

    test('EventSourceMapping wires the v2 queue to the processor Lambda with BatchSize 1 and ReportBatchItemFailures', () => {
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BatchSize: 1,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      });
    });

    test('webhook Lambda omits the v2 FIFO URL by default', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const webhook = Object.values(functions).find((resource: any) =>
        resource.Properties?.Description?.includes('webhook receiver')) as any;
      expect(webhook).toBeDefined();
      expect(webhook.Properties.Environment.Variables)
        .not.toHaveProperty('WHATSAPP_INBOUND_V2_QUEUE_URL');
    });

    test('webhook role keeps legacy send permission but has no v2 FIFO send grant by default', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const webhook = Object.values(functions).find((resource: any) =>
        resource.Properties?.Description?.includes('webhook receiver')) as any;
      const webhookRoleId = webhook.Properties.Role['Fn::GetAtt'][0];
      const queues = template.findResources('AWS::SQS::Queue');
      const queueId = (name: string) => Object.entries(queues)
        .find(([, resource]: [string, any]) => resource.Properties?.QueueName === name)?.[0];
      const policies = Object.values(template.findResources('AWS::IAM::Policy'))
        .filter((policy: any) => policy.Properties?.Roles?.some(
          (role: any) => role.Ref === webhookRoleId,
        ));
      const serialized = JSON.stringify(policies);

      expect(serialized).toContain(queueId('whatsapp-inbound-queue'));
      expect(serialized).not.toContain(queueId('whatsapp-inbound-v2.fifo'));
      expect(serialized).toContain('sqs:SendMessage');
    });

    test('WhatsAppInboundV2DlqDepth alarm exists on ApproximateNumberOfMessagesVisible for the v2 DLQ, wired to the alarm topic', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'WhatsAppInboundV2DlqDepth',
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Namespace: 'AWS/SQS',
        AlarmActions: Match.anyValue(),
      });
    });

    test('WhatsAppInboundV2DlqAge alarm exists on ApproximateAgeOfOldestMessage for the v2 DLQ, wired to the alarm topic', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'WhatsAppInboundV2DlqAge',
        MetricName: 'ApproximateAgeOfOldestMessage',
        Namespace: 'AWS/SQS',
        AlarmActions: Match.anyValue(),
      });
    });
  });

  // ── Lambda functions ───────────────────────────────────────────
  // 13 since S22 R2-C23 added the web onboarding door.
  test('Stack creates 13 Lambda functions including the worker-intent drain', () => {
    template.resourceCountIs('AWS::Lambda::Function', 13);
  });

  test('worker-intent outbox drain has Twilio + DB configuration and a one-minute schedule', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('.*Worker intent outbox drain.*'),
      Environment: Match.objectLike({ Variables: Match.objectLike({
        DB_SECRET_ARN: Match.anyValue(), TWILIO_SECRET_ARN: Match.anyValue(),
        TWILIO_STATUS_CALLBACK_URL: Match.anyValue(),
      }) }),
    });
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 minute)' });
  });

  test('job alert outbox drain runs on a 5-minute schedule', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('.*[Jj]ob [Aa]lert outbox drain.*'),
    });
  });

  test('job message outbox sweeper runs on a 5-minute schedule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  test('Admin outbox dispatcher runs on a one-minute schedule', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('.*admin.*outbox.*'),
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
          TWILIO_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      State: 'ENABLED',
    });
  });

  test('Webhook Lambda has TWILIO_SECRET_ARN + SQS_QUEUE_URL env vars', () => {
    // Webhook URL is reconstructed at runtime from event.requestContext to
    // avoid an ApiStack ↔ WhatsAppStack dependency cycle (see whatsapp-stack.ts).
    // So we only assert the Twilio secret + SQS URL env vars are wired.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('.*webhook.*signature.*'),
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TWILIO_SECRET_ARN: Match.anyValue(),
          SQS_QUEUE_URL: Match.anyValue(),
        }),
      }),
    });
  });

  test('defaults WhatsApp Lambda origin to production domain', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          ALLOWED_ORIGIN: 'https://jaleapp.ai',
        }),
      }),
    });
  });

  test('Processor Lambda has 60s timeout (for the new-user call chain)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('.*SQS processor.*'),
      Timeout: 60,
    });
  });

  test('Processor Lambda has DB + Twilio + Cognito env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('.*SQS processor.*'),
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
          TWILIO_SECRET_ARN: Match.anyValue(),
          WORKER_POOL_ID: Match.anyValue(),
          WORKER_CLIENT_ID: Match.anyValue(),
          REQUIRED_TOS_VERSION: Match.anyValue(),
        }),
      }),
    });
  });

  test('Processor Lambda has SQS event source mapping', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    });
  });

  test('Processor Lambda has suppressed account creation and custom auth permissions', () => {
    const expectedActions = [
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:InitiateAuth',
      'cognito-idp:RespondToAuthChallenge',
      // C4: reconcileWorkerCognitoAccount() repair actions must stay granted.
      'cognito-idp:AdminUpdateUserAttributes',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminAddUserToGroup',
    ];
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(expectedActions),
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });

  // ── API Gateway route ──────────────────────────────────────────
  // The route is added to the ApiStack's API, not this stack — assert on
  // the apiTemplate. Also verify it has NO authorizer.
  test('POST /whatsapp/webhook route exists on the API Gateway', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
    });
  });

  test('Webhook route does NOT have a Cognito authorizer', () => {
    // Find all POST methods whose path includes /whatsapp/webhook
    // and assert none has AuthorizerId set.
    const methods = apiTemplate.findResources('AWS::ApiGateway::Method');
    const webhookMethods = Object.values(methods).filter((m: any) => {
      return m.Properties?.HttpMethod === 'POST'
        && !m.Properties?.AuthorizerId;
    });
    // At least one unauthenticated POST method should exist
    expect(webhookMethods.length).toBeGreaterThan(0);
  });

  test('status callback is a sibling unauthenticated API Gateway route', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'status-callback',
    });
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
      MethodResponses: Match.arrayWith([
        Match.objectLike({ StatusCode: '200' }),
        Match.objectLike({ StatusCode: '503' }),
      ]),
    });
  });

  // Review-1 correction: a PathPart match alone doesn't prove the resource
  // is actually mounted under /whatsapp alongside /webhook — it only proves
  // a resource with that PathPart exists somewhere in the tree. Walk the
  // exact ApiGateway::Resource parent chain instead.
  test('status-callback resource shares the exact same parent (/whatsapp) as webhook, both NONE-authorized', () => {
    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource');
    const findByPathPart = (pathPart: string) =>
      Object.entries(resources).find(([, r]: [string, any]) =>
        r.Properties?.PathPart === pathPart);

    const whatsappEntry = findByPathPart('whatsapp');
    const webhookEntry = findByPathPart('webhook');
    const statusCallbackEntry = findByPathPart('status-callback');
    expect(whatsappEntry).toBeDefined();
    expect(webhookEntry).toBeDefined();
    expect(statusCallbackEntry).toBeDefined();

    const [whatsappLogicalId] = whatsappEntry!;
    const [, webhookResource] = webhookEntry!;
    const [, statusCallbackResource] = statusCallbackEntry!;

    const parentRef = (r: any) => r.Properties?.ParentId?.Ref
      ?? r.Properties?.ParentId?.['Fn::GetAtt']?.[0];

    // Both webhook and status-callback are children of the SAME /whatsapp
    // resource — proves they are siblings, not just two resources that
    // happen to exist anywhere in the API tree.
    expect(parentRef(webhookResource)).toBe(whatsappLogicalId);
    expect(parentRef(statusCallbackResource)).toBe(whatsappLogicalId);

    // Both methods on those two resources are unauthenticated.
    const methods = apiTemplate.findResources('AWS::ApiGateway::Method');
    const methodsOnResource = (resourceLogicalId: string) =>
      Object.values(methods).filter((m: any) =>
        (m.Properties?.ResourceId?.Ref) === resourceLogicalId
        && m.Properties?.HttpMethod === 'POST');

    const [webhookLogicalId] = webhookEntry!;
    const [statusCallbackLogicalId] = statusCallbackEntry!;
    for (const m of methodsOnResource(webhookLogicalId)) {
      expect((m as any).Properties.AuthorizationType).toBe('NONE');
    }
    for (const m of methodsOnResource(statusCallbackLogicalId)) {
      expect((m as any).Properties.AuthorizationType).toBe('NONE');
    }
    expect(methodsOnResource(webhookLogicalId).length).toBeGreaterThan(0);
    expect(methodsOnResource(statusCallbackLogicalId).length).toBeGreaterThan(0);
  });

  test('all WhatsAppStack outbound senders and callback use the exact configured URL', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const configured = Object.values(functions).filter((resource: any) =>
      resource.Properties?.Environment?.Variables?.TWILIO_STATUS_CALLBACK_URL
        === 'https://callbacks.example.test/prod/whatsapp/status-callback');
    // 8 since Sprint 22 R1: voice-trust-receiver no longer sends via Twilio.
    expect(configured).toHaveLength(8);
  });

  test('both ApiStack employer-conversation senders use the exact configured URL', () => {
    const functions = apiTemplate.findResources('AWS::Lambda::Function');
    const configured = Object.values(functions).filter((resource: any) =>
      resource.Properties?.Environment?.Variables?.TWILIO_STATUS_CALLBACK_URL
        === 'https://callbacks.example.test/prod/whatsapp/status-callback');
    expect(configured).toHaveLength(2);
  });

  test('delivery failure metric alarms to SNS', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      MetricTransformations: Match.arrayWith([
        Match.objectLike({ MetricName: 'DeliveryFailures', MetricNamespace: 'Jale/WhatsApp' }),
      ]),
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'WhatsAppDeliveryFailures',
      Threshold: 1,
      AlarmActions: Match.anyValue(),
    });
  });

  // I2 (final-review): lib/moderation.ts's moderateImage() fails OPEN and
  // logs a plain-text `console.error` (not the `{ metric: ... }` JSON
  // convention the other filters use) on a Rekognition service fault —
  // previously invisible to any alarm. Installed on the PROCESSOR log group
  // (the processor is the moderation caller in this stack; MediaBoardStack's
  // WorkerPostCreate lambda gets the equivalent filter/alarm separately).
  test('moderation fail-open metric filter + alarm exist on the processor log group', () => {
    const processorLogGroupId = (() => {
      const fns = template.findResources('AWS::Lambda::Function');
      const [logicalId] = Object.entries(fns).find(([, r]: [string, any]) =>
        /SQS processor/i.test(r.Properties?.Description ?? ''))!;
      const fnResource = (fns as Record<string, any>)[logicalId];
      return fnResource.Properties.LoggingConfig?.LogGroup?.Ref;
    })();
    expect(processorLogGroupId).toBeDefined();

    const filters = template.findResources('AWS::Logs::MetricFilter');
    const failOpenFilter = Object.values(filters).find((f: any) =>
      f.Properties.MetricTransformations?.some((t: any) =>
        t.MetricName === 'ModerationFailOpen' && t.MetricNamespace === 'Jale/WhatsApp'));
    expect(failOpenFilter).toBeDefined();
    expect((failOpenFilter as any).Properties.LogGroupName.Ref).toBe(processorLogGroupId);
    expect((failOpenFilter as any).Properties.FilterPattern).toContain('moderateImage service fault (fail-open)');

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'WhatsAppModerationFailOpen',
      Threshold: 1,
      AlarmActions: Match.anyValue(),
    });
  });

  // ── C7: scheduled domain-event drain, release wiring, operational alarms ──
  describe('C7: DomainOutboxDrainLambda', () => {
    const findFunctionByDescription = (regex: RegExp): [string, any] => {
      const fns = template.findResources('AWS::Lambda::Function');
      const entry = Object.entries(fns).find(([, r]: [string, any]) =>
        regex.test(r.Properties?.Description ?? ''));
      if (!entry) throw new Error(`no Lambda function matching ${regex}`);
      return entry as [string, any];
    };

    test('DomainOutboxDrainLambda exists', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('.*[Dd]omain.*outbox.*drain.*'),
      });
    });

    test('DomainOutboxDrainLambda runs on a rate(1 minute) EventBridge schedule', () => {
      const [drainLogicalId] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const rules = template.findResources('AWS::Events::Rule', {
        Properties: { ScheduleExpression: 'rate(1 minute)' },
      });
      const targetsDrain = Object.values(rules).some((rule: any) =>
        (rule.Properties.Targets || []).some((t: any) => t.Arn?.['Fn::GetAtt']?.[0] === drainLogicalId));
      expect(targetsDrain).toBe(true);
    });

    test("drain function's role can read ONLY the WhatsApp DB secret — not the Twilio secret, and no other secretsmanager:GetSecretValue resource", () => {
      const [, drainFn] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const roleLogicalId = drainFn.Properties.Role['Fn::GetAtt'][0];
      const policies: Record<string, any> = template.findResources('AWS::IAM::Policy');
      const rolePolicies = Object.values(policies).filter((p: any) =>
        (p.Properties.Roles || []).some((r: any) => r.Ref === roleLogicalId));

      const secretGetStatements = rolePolicies
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
        .filter((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('secretsmanager:GetSecretValue');
        });

      const resources = secretGetStatements.map((s: any) => JSON.stringify(s.Resource));

      const dbSecretArn = JSON.stringify({
        'Fn::Join': ['', [
          'arn:', { Ref: 'AWS::Partition' }, ':secretsmanager:', { Ref: 'AWS::Region' },
          ':', { Ref: 'AWS::AccountId' }, ':secret:jale/whatsapp/db-??????',
        ]],
      });

      // Exactly the WhatsApp DB secret — no more, no less.
      expect(resources).toEqual([dbSecretArn]);
      for (const r of resources) {
        expect(r).not.toContain('jale/whatsapp/twilio');
      }
    });

    test('drain function has no TWILIO_SECRET_ARN or TWILIO_STATUS_CALLBACK_URL env var (never sends via Twilio)', () => {
      const [, drainFn] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const variables = drainFn.Properties.Environment?.Variables ?? {};
      expect(variables.TWILIO_SECRET_ARN).toBeUndefined();
      expect(variables.TWILIO_STATUS_CALLBACK_URL).toBeUndefined();
    });

    test('drain function has TRUST_ASSESSMENT_QUEUE_URL in its environment', () => {
      const [, drainFn] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const variables = drainFn.Properties.Environment?.Variables ?? {};
      expect(variables.TRUST_ASSESSMENT_QUEUE_URL).toBeDefined();
    });

    // R1-X: the drain fans assessment.requested out to a SECOND queue. The
    // dispatch is fail-open at runtime, so if this env var were missing the
    // only symptom in production would be a metric nobody is watching — these
    // two tests are what makes the misconfiguration impossible instead.
    test('drain function has TRUST_EXTRACTION_QUEUE_URL, distinct from the scorer queue URL', () => {
      const [, drainFn] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const variables = drainFn.Properties.Environment?.Variables ?? {};
      expect(variables.TRUST_EXTRACTION_QUEUE_URL).toBeDefined();
      expect(variables.TRUST_EXTRACTION_QUEUE_URL)
        .not.toEqual(variables.TRUST_ASSESSMENT_QUEUE_URL);
    });

    test('drain role can send to BOTH trust queues (send only — never receive)', () => {
      const [, drainFn] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const roleLogicalId = drainFn.Properties.Role['Fn::GetAtt'][0];
      const policies: Record<string, any> = template.findResources('AWS::IAM::Policy');
      const sendResources = Object.values(policies)
        .filter((p: any) => (p.Properties.Roles || []).some((r: any) => r.Ref === roleLogicalId))
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
        .filter((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('sqs:SendMessage') && !actions.includes('sqs:ReceiveMessage');
        })
        .flatMap((s: any) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))
        .map((r: any) => JSON.stringify(r));

      // Both AiStack queues cross the stack boundary as Fn::ImportValue
      // references whose export names embed the source logical id, so each
      // grant is identifiable — asserting on a COUNT alone would pass on the
      // drain's unrelated worker-intent-wake grant.
      expect(sendResources.some((r: string) => r.includes('TrustAssessmentQueue'))).toBe(true);
      expect(sendResources.some((r: string) => r.includes('TrustExtractionQueue'))).toBe(true);
    });

    test("drain role sends downstream and consumes only its own domain wake queue", () => {
      const [, drainFn] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const roleLogicalId = drainFn.Properties.Role['Fn::GetAtt'][0];
      const policies: Record<string, any> = template.findResources('AWS::IAM::Policy');
      const rolePolicies = Object.values(policies).filter((p: any) =>
        (p.Properties.Roles || []).some((r: any) => r.Ref === roleLogicalId));

      const sqsStatements = rolePolicies
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
        .filter((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.some((a: string) => typeof a === 'string' && a.startsWith('sqs:'));
        });

      expect(sqsStatements.length).toBeGreaterThan(0);
      const allActions = sqsStatements.flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
      expect(allActions).toContain('sqs:SendMessage');
      expect(allActions).toContain('sqs:ReceiveMessage');
      expect(allActions).toContain('sqs:DeleteMessage');

      const consumeStatements = sqsStatements.filter((statement: any) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes('sqs:ReceiveMessage');
      });
      expect(consumeStatements).toHaveLength(1);
      const consumeResources = JSON.stringify(consumeStatements.map((statement: any) => statement.Resource));
      expect(consumeResources).toContain('DomainOutboxWakeQueue');
      expect(consumeResources).not.toContain('WorkerIntentWakeQueue');
      expect(consumeResources).not.toContain('TrustAssessment');
    });

    test('drain function role still reads ONLY the WhatsApp DB secret — the SQS grant adds no additional secretsmanager:GetSecretValue resource', () => {
      const [, drainFn] = findFunctionByDescription(/domain.*outbox.*drain/i);
      const roleLogicalId = drainFn.Properties.Role['Fn::GetAtt'][0];
      const policies: Record<string, any> = template.findResources('AWS::IAM::Policy');
      const rolePolicies = Object.values(policies).filter((p: any) =>
        (p.Properties.Roles || []).some((r: any) => r.Ref === roleLogicalId));

      const secretGetStatements = rolePolicies
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
        .filter((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('secretsmanager:GetSecretValue');
        });
      const resources = secretGetStatements.map((s: any) => JSON.stringify(s.Resource));
      for (const r of resources) {
        expect(r).not.toContain('jale/whatsapp/twilio');
      }
    });

    test.each([
      ['WhatsAppDomainEventsStuck'],
      ['WhatsAppReleaseFailures'],
      ['WhatsAppAssessmentDispatchFailures'],
      ['WhatsAppDeferredBacklogAge'],
      ['WhatsAppOtpLockRate'],
      // 2026-07-27 observability pass
      ['WhatsAppTrustQuestionGenerationFailed'],
      ['WhatsAppProfileVoicePipelineFailed'],
      ['WhatsAppProfileVoicePipelineTimedOut'],
      ['WhatsAppTrustVoicePipelineFailed'],
      ['WhatsAppTrustVoicePipelineTimedOut'],
    ])('%s alarm exists, wired to the alarm topic', (alarmName) => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        AlarmActions: Match.anyValue(),
      });
    });

    test('v2 onboarding funnel metric filters exist on the processor log group', () => {
      for (const metricName of ['OnboardingStepAdvanced', 'OnboardingCompleted', 'TrustQuestionGenerationFailed']) {
        template.hasResourceProperties('AWS::Logs::MetricFilter', {
          MetricTransformations: Match.arrayWith([
            Match.objectLike({ MetricName: metricName, MetricNamespace: 'Jale/WhatsApp' }),
          ]),
        });
      }
    });

    test('WhatsAppOtpLock metric filter is installed on the PROCESSOR log group, not the drain log group', () => {
      // Resolve the LogGroup logical id actually wired to each Lambda Function's
      // LoggingConfig.LogGroup (the JaleLambdaFunction construct passes its own
      // logs.LogGroup explicitly, so this ref is authoritative — unlike guessing
      // logical ids from construct id naming).
      const logGroupLogicalIdForFunction = (description: RegExp): string => {
        const [logicalId] = findFunctionByDescription(description);
        const fnResource = (template.findResources('AWS::Lambda::Function') as Record<string, any>)[logicalId];
        const ref = fnResource.Properties.LoggingConfig?.LogGroup?.Ref;
        if (!ref) throw new Error(`no LoggingConfig.LogGroup ref found for ${logicalId}`);
        return ref;
      };

      const processorLogGroupId = logGroupLogicalIdForFunction(/SQS processor/i);
      const drainLogGroupId = logGroupLogicalIdForFunction(/domain.*outbox.*drain/i);
      expect(processorLogGroupId).not.toEqual(drainLogGroupId);

      const otpFilter = Object.values(template.findResources('AWS::Logs::MetricFilter')).find((f: any) =>
        f.Properties.MetricTransformations?.some((t: any) => t.MetricName === 'OtpLockRate'
          || t.MetricName === 'WhatsAppOtpLockRate'));
      expect(otpFilter).toBeDefined();
      expect((otpFilter as any).Properties.LogGroupName.Ref).toBe(processorLogGroupId);
    });

    test('metric filters for the three drain-owned metrics exist in the Jale/WhatsApp namespace', () => {
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        MetricTransformations: Match.arrayWith([
          Match.objectLike({ MetricName: 'DomainEventStuck', MetricNamespace: 'Jale/WhatsApp' }),
        ]),
      });
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        MetricTransformations: Match.arrayWith([
          Match.objectLike({ MetricName: 'ReleaseFailures', MetricNamespace: 'Jale/WhatsApp' }),
        ]),
      });
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        MetricTransformations: Match.arrayWith([
          Match.objectLike({ MetricName: 'DeferredBacklogAge', MetricNamespace: 'Jale/WhatsApp' }),
        ]),
      });
    });

    test('RetriggerSweepLambda runs on a rate(5 minutes) schedule with only the WhatsApp DB secret', () => {
      const [sweepLogicalId, sweepFn] = findFunctionByDescription(/retrigger.*sweep/i);
      const rules = template.findResources('AWS::Events::Rule', {
        Properties: { ScheduleExpression: 'rate(5 minutes)' },
      });
      const targetsSweep = Object.values(rules).some((rule: any) =>
        (rule.Properties.Targets || []).some((t: any) => t.Arn?.['Fn::GetAtt']?.[0] === sweepLogicalId));
      expect(targetsSweep).toBe(true);
      // No Twilio secret: this Lambda never sends.
      const envVars = sweepFn.Properties?.Environment?.Variables ?? {};
      expect(envVars.TWILIO_SECRET_ARN).toBeUndefined();
      expect(envVars.DB_SECRET_ARN).toBeDefined();
    });
  });

  // ── C5 v2 queue/DLQ resources must remain present and unchanged by C7 ──
  describe('C7 regression: C5 v2 queue/DLQ resources unchanged', () => {
    test('v2 FIFO inbound queue and DLQ still exist with their original properties', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2.fifo',
        FifoQueue: true,
        ContentBasedDeduplication: false,
        VisibilityTimeout: 360,
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
      });
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'whatsapp-inbound-v2-dlq.fifo',
        FifoQueue: true,
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
    });

    test('total SQS queue count includes both durable wake queue/DLQ pairs', () => {
      template.resourceCountIs('AWS::SQS::Queue', 8);
    });
  });

  describe('Sprint 7: AI profile media resources', () => {
    test('Stack creates a private S3 media bucket', () => {
      // BucketName is a Fn::Join token at synth time (account/region are unresolved),
      // so we assert on Block Public Access as the bucket identity signal instead.
      // The name prefix 'jale-worker-media' is validated by the encryption test below.
      template.resourceCountIs('AWS::S3::Bucket', 1);
    });

    test('Media bucket has Block Public Access enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test('Media bucket has server-side encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            }),
          ]),
        },
      });
    });

    // Task 7: worker_post_media.s3_version_id pins moderated bytes — a
    // presigned PUT is multi-use for its 900s TTL, so an unversioned key
    // could be swapped AFTER Rekognition approval without this.
    test('Media bucket has versioning enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    test('Stack creates two Standard (not Express) Step Functions state machines', () => {
      template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'STANDARD',
      });
    });

    // Both pipelines share the VoiceTranscriptionPipeline construct — assert
    // BOTH state machines (Profile + Trust) carry the multi-language
    // identification config and the es-US vocabulary name, not just one.
    test('Both voice pipeline state machines use IdentifyMultipleLanguages and the es-US vocabulary', () => {
      const machines = Object.values(template.findResources('AWS::StepFunctions::StateMachine'));
      expect(machines).toHaveLength(2);
      for (const machine of machines as any[]) {
        const text = JSON.stringify(machine.Properties.DefinitionString);
        // Pin the boolean literal, not just the key name — a regression
        // that stringifies it as `"true"` (string) would otherwise still
        // pass a bare substring-contains check.
        // JSON.stringify(machine.Properties.DefinitionString) runs on top
        // of the ASL fragment's own JSON encoding, so the real string
        // contains a literal backslash before each quote around the key.
        expect(text).toContain('\\"IdentifyMultipleLanguages\\":true');
        expect(text).toContain('LanguageOptions');
        expect(text).toContain('es-US');
        expect(text).toContain('en-US');
        expect(text).toContain('LanguageIdSettings');
        expect(text).toContain('jale-es-us-trades');
        expect(text).not.toContain('LanguageCode');
      }
    });

    test('Stack creates ai-profile-writer Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('ai-profile-writer'),
      });
    });

    test('Stack creates voice-trust-receiver Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('voice-trust-receiver'),
      });
    });

    test('ai-profile-writer Lambda has DB, Twilio, and media env vars', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('ai-profile-writer'),
        Environment: {
          Variables: Match.objectLike({
            DB_SECRET_ARN: Match.anyValue(),
            TWILIO_SECRET_ARN: Match.anyValue(),
            MEDIA_BUCKET_NAME: Match.anyValue(),
          }),
        },
      });
    });

    // Upgrade: Nova Lite -> Claude Haiku 4.5 (Samuel's finding that
    // extraction "omits many aspects"). Pinned to the exact inference
    // profile ID, not Match.anyValue() — a passing "env var exists" test
    // wouldn't catch a wrong/stale model ID.
    test('ai-profile-writer Lambda is pinned to the Claude Haiku 4.5 Bedrock inference profile', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('ai-profile-writer'),
        Environment: {
          Variables: Match.objectLike({
            BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          }),
        },
      });
    });

    // Full Resource-array assertion (not Match.anyValue()) — a vacuous IAM
    // test that only checks the action name was a known defect class here
    // (T-A1). Assert the exact 4-ARN set, mirroring the prior nova-lite
    // pattern: inference-profile (region token) + foundation-model in
    // us-east-1 (literal) + region token + us-west-2 (literal).
    test('ai-profile-writer bedrock:InvokeModel policy grants exactly the 4 Haiku 4.5 ARNs', () => {
      const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
      const bedrockPolicy = policies.find((p) =>
        (p.Properties.PolicyDocument.Statement as any[]).some(
          (stmt) => stmt.Action === 'bedrock:InvokeModel' || (Array.isArray(stmt.Action) && stmt.Action.includes('bedrock:InvokeModel')),
        ));
      expect(bedrockPolicy).toBeDefined();
      const stmt = (bedrockPolicy.Properties.PolicyDocument.Statement as any[]).find(
        (s) => s.Action === 'bedrock:InvokeModel' || (Array.isArray(s.Action) && s.Action.includes('bedrock:InvokeModel')),
      );
      const resources = stmt.Resource as any[];
      expect(resources).toHaveLength(4);
      // inference-profile ARN uses the stack's own region/account tokens
      // (Fn::Join with Ref/GetAtt), so match its literal tail instead of
      // asserting exact equality on the whole intrinsic-function object.
      expect(JSON.stringify(resources[0])).toContain('inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(resources[1]).toBe('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(JSON.stringify(resources[2])).toContain('foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(resources[3]).toBe('arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
      // No leftover nova-lite ARNs.
      for (const r of resources) {
        expect(JSON.stringify(r)).not.toContain('nova-lite');
      }
    });

    // Task 15 (controller-discovered gap): the SQS processor Lambda calls
    // Bedrock ConverseCommand for application-fill field extraction
    // (lib/application-fill-extraction.ts's makeBedrockExtractionClient,
    // wired in processor.ts) but — unlike ai-profile-writer above — had no
    // BEDROCK_MODEL_ID env var and no bedrock IAM grant at all. In
    // production every extraction turn would hit the
    // `process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-lite-v1:0'` fallback
    // AND then fail AccessDenied, surfacing as 'bedrock_error' and a retry
    // loop. Mirrors ai-profile-writer's env value and policy shape exactly.
    test('Processor Lambda is pinned to the Claude Haiku 4.5 Bedrock inference profile', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('SQS processor'),
        Environment: {
          Variables: Match.objectLike({
            BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          }),
        },
      });
    });

    // Scoped to the processor's OWN role (not "any role in the stack") and
    // pinned to the exact 4 Haiku 4.5 ARNs — same role-scoping convention as
    // the 'Processor Lambda role gets kms:GenerateDataKey*...' test below
    // (processorFn.Properties.Role['Fn::GetAtt'][0] + filtering
    // AWS::IAM::Policy by Roles[].Ref), and the same 4-ARN assertion shape
    // as the ai-profile-writer bedrock:InvokeModel test above.
    test('Processor Lambda role gets bedrock:InvokeModel scoped to the exact 4 Haiku 4.5 ARNs', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const [, processorFn] = Object.entries(functions).find(([, r]: [string, any]) =>
        /SQS processor/.test(r.Properties?.Description ?? '')) as [string, any];
      const roleLogicalId = processorFn.Properties.Role['Fn::GetAtt'][0];

      const policies: Record<string, any> = template.findResources('AWS::IAM::Policy');
      const rolePolicies = Object.values(policies).filter((p: any) =>
        (p.Properties.Roles || []).some((r: any) => r.Ref === roleLogicalId));

      const bedrockStatements = rolePolicies
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
        .filter((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('bedrock:InvokeModel');
        });

      expect(bedrockStatements).toHaveLength(1);
      const resources = bedrockStatements[0].Resource as any[];
      expect(resources).toHaveLength(4);
      expect(JSON.stringify(resources[0])).toContain('inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(resources[1]).toBe('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(JSON.stringify(resources[2])).toContain('foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(resources[3]).toBe('arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
      for (const r of resources) {
        expect(JSON.stringify(r)).not.toContain('nova-lite');
      }
    });

    // Task 15 (confirmed blocker, found after the IAM/env fix above):
    // processor.ts -> lib/application-fill.ts -> lib/application-fill-
    // extraction.ts imports '@aws-sdk/client-bedrock-runtime' at module top
    // level, unconditionally. JaleLambdaFunction's default esbuild bundling
    // externalizes ALL '@aws-sdk/*' packages (lambda-function.ts's
    // `externalModules: ['pg-native', '@aws-sdk/*']`), assuming the Node
    // 20.x Lambda runtime provides them -- untrue for client-bedrock-runtime
    // (ai-profile-writer needs the identical `nodeModules` opt-in for the
    // same package). Without it, the compiled bundle's bare
    // `require('@aws-sdk/client-bedrock-runtime')` would throw "Cannot find
    // module" at import time in production -- failing EVERY processor
    // invocation, not just Bedrock-calling ones.
    //
    // `nodeModules` has no CloudFormation footprint (Template.fromStack only
    // sees the final Code.S3Key asset hash), so this can only be verified by
    // inspecting the real bundled asset directory on disk -- which the
    // beforeAll block above locates via that same asset hash into
    // `processorAssetDir`.
    test('Processor Lambda bundle installs the real @aws-sdk/client-bedrock-runtime package (nodeModules opt-in)', () => {
      const pkgJsonPath = path.join(
        processorAssetDir, 'node_modules', '@aws-sdk', 'client-bedrock-runtime', 'package.json',
      );
      expect(fs.existsSync(pkgJsonPath)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      expect(pkg.name).toBe('@aws-sdk/client-bedrock-runtime');

      // The compiled index.js still has a bare require() for it (esbuild
      // externalized it per lambda-function.ts's externalModules) -- proof
      // the installed package above is actually what makes that require()
      // resolve at runtime, not dead weight.
      const indexJs = fs.readFileSync(path.join(processorAssetDir, 'index.js'), 'utf8');
      expect(indexJs).toMatch(/require\(["']@aws-sdk\/client-bedrock-runtime["']\)/);
    });

    // @smithy/node-http-handler (also imported by
    // makeBedrockExtractionClient, application-fill-extraction.ts) does NOT
    // need a nodeModules entry: only 'pg-native' and '@aws-sdk/*' are
    // externalModules (lambda-function.ts), so esbuild inlines
    // '@smithy/*' packages directly into the bundle. Confirmed by asserting
    // there's no bare require() for it in the compiled output -- if it were
    // ever added to externalModules without a matching nodeModules entry,
    // this would catch the same "Cannot find module" class of bug as above.
    test('Processor Lambda bundle inlines @smithy/node-http-handler (not externalized)', () => {
      const indexJs = fs.readFileSync(path.join(processorAssetDir, 'index.js'), 'utf8');
      expect(indexJs).not.toMatch(/require\(["']@smithy\/node-http-handler["']\)/);
    });

    test('Processor Lambda has MEDIA_BUCKET_NAME env var', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('SQS processor'),
        Environment: {
          Variables: Match.objectLike({
            MEDIA_BUCKET_NAME: Match.anyValue(),
          }),
        },
      });
    });

    // Task 12: WhatsApp flow uploads worker documents (e.g. ID, certs)
    // directly to the shared documents bucket via a KMS-default PUT.
    test('Processor Lambda has DOCUMENTS_BUCKET env var', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('SQS processor'),
        Environment: {
          Variables: Match.objectLike({
            DOCUMENTS_BUCKET: Match.anyValue(),
          }),
        },
      });
    });

    // Scoped to the processor's OWN role (not "any role in the stack") and
    // pinned to the docs key's actual Resource reference (not "any
    // resource") — a Resource: '*' grant, or the same statement attached to
    // a different lambda's role, must fail this test. See the sibling
    // role-scoping pattern in the 'C7: DomainOutboxDrainLambda' describe
    // block above (drainFn.Properties.Role['Fn::GetAtt'][0] + filtering
    // AWS::IAM::Policy by Roles[].Ref) for the convention this follows.
    test('Processor Lambda role gets kms:GenerateDataKey* scoped to the documents bucket key (grantPut)', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const [, processorFn] = Object.entries(functions).find(([, r]: [string, any]) =>
        /SQS processor/.test(r.Properties?.Description ?? '')) as [string, any];
      const roleLogicalId = processorFn.Properties.Role['Fn::GetAtt'][0];

      const policies: Record<string, any> = template.findResources('AWS::IAM::Policy');
      const rolePolicies = Object.values(policies).filter((p: any) =>
        (p.Properties.Roles || []).some((r: any) => r.Ref === roleLogicalId));

      const kmsGenerateStatements = rolePolicies
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
        .filter((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('kms:GenerateDataKey*');
        });

      // Exactly one statement, and it must carry a concrete Resource — an
      // Fn::ImportValue naming the TestDocsKey construct from the stand-in
      // TestDocsBucketStack fixture above (this test's beforeAll creates the
      // key as `new kms.Key(docsBucketStack, 'TestDocsKey')`), not a bare
      // '*' wildcard.
      expect(kmsGenerateStatements).toHaveLength(1);
      const resource = kmsGenerateStatements[0].Resource;
      expect(resource).not.toBe('*');
      expect(resource).toHaveProperty('Fn::ImportValue');
      expect(resource['Fn::ImportValue']).toEqual(
        expect.stringMatching(/^TestDocsBucketStack:.*TestDocsKey.*Arn.*$/),
      );
    });

    test('Processor Lambda has AI_PIPELINE_STATE_MACHINE_ARN env var', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('SQS processor'),
        Environment: {
          Variables: Match.objectLike({
            AI_PIPELINE_STATE_MACHINE_ARN: Match.anyValue(),
          }),
        },
      });
    });

    test('Processor Lambda has trust AI env vars', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('SQS processor'),
        Environment: {
          Variables: Match.objectLike({
            TRUST_PIPELINE_STATE_MACHINE_ARN: Match.anyValue(),
            QUESTION_GENERATOR_ARN: Match.anyValue(),
            ALIAS_GENERATOR_ARN: Match.anyValue(),
            TRUST_ASSESSMENT_QUEUE_URL: Match.anyValue(),
          }),
        },
      });
    });

    test('ai-profile-writer Lambda has ALIAS_GENERATOR_ARN env var', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('ai-profile-writer'),
        Environment: {
          Variables: Match.objectLike({
            ALIAS_GENERATOR_ARN: Match.anyValue(),
          }),
        },
      });
    });

    // Task 5: the v2 re-entry queue URL/grant are gated on the SAME
    // transport flag as the webhook's v2 wiring (mirrors the webhook tests
    // in the 'v2 FIFO inbound queue and DLQ' describe above) — by default
    // (flag unset) voice-trust-receiver must not carry the queue URL.
    test('voice-trust-receiver Lambda omits WHATSAPP_INBOUND_V2_QUEUE_URL by default', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const receiver = Object.values(functions).find((resource: any) =>
        resource.Properties?.Description?.includes('voice-trust-receiver')) as any;
      expect(receiver).toBeDefined();
      expect(receiver.Properties.Environment?.Variables ?? {})
        .not.toHaveProperty('WHATSAPP_INBOUND_V2_QUEUE_URL');
    });

    // Stream B (Task 8d): ai-profile-writer's v2 completion branch re-enters
    // the same way voice-trust-receiver does — same transport-flag gate.
    test('ai-profile-writer Lambda omits WHATSAPP_INBOUND_V2_QUEUE_URL by default', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const writer = Object.values(functions).find((resource: any) =>
        resource.Properties?.Description?.includes('ai-profile-writer')) as any;
      expect(writer).toBeDefined();
      expect(writer.Properties.Environment?.Variables ?? {})
        .not.toHaveProperty('WHATSAPP_INBOUND_V2_QUEUE_URL');
    });
  });

  // ── S22 R2-C23: the web onboarding door ────────────────────────
  //
  // The Lambda is a WhatsAppStack resource (it needs this stack's DB secret,
  // generator ARNs and wake queue); the ROUTES are ApiStack resources,
  // because `props.workerResource.addResource()` creates its children in the
  // scope of the resource it hangs off. Hence the two templates.
  describe('web onboarding door', () => {
    function webDoorFn(): any {
      const functions = template.findResources('AWS::Lambda::Function');
      return Object.values(functions).find((resource: any) =>
        /Web worker onboarding/.test(resource.Properties?.Description ?? '')) as any;
    }

    test('a single Lambda serves all four routes, inside the VPC', () => {
      const fn = webDoorFn();
      expect(fn).toBeDefined();
      expect(fn.Properties.VpcConfig).toBeDefined();
      // API Gateway hard-caps a REST integration at 29s; profile.trade can
      // synchronously invoke the question generator.
      expect(fn.Properties.Timeout).toBeLessThanOrEqual(28);
    });

    test('connects as jale_whatsapp — the ONLY role granted the engine tables', () => {
      const env = webDoorFn().Properties.Environment.Variables;
      expect(env.DB_SECRET_ARN).toBe('jale/whatsapp/db');
      expect(env.REQUIRED_TOS_VERSION).toBeDefined();
    });

    test('carries QUESTION_GENERATOR_ARN — without it every trade silently gets FALLBACK questions', () => {
      // seedTrustQuestions swallows a generator failure into the generic
      // fallback set, so a missing ARN is invisible in the flow and only
      // shows up later as un-scorable assessments.
      const env = webDoorFn().Properties.Environment.Variables;
      expect(env.QUESTION_GENERATOR_ARN).toBeDefined();
      expect(env.ALIAS_GENERATOR_ARN).toBeDefined();
    });

    test('carries DOMAIN_OUTBOX_WAKE_QUEUE_URL so completion does not wait for the cron', () => {
      const env = webDoorFn().Properties.Environment.Variables;
      expect(env.DOMAIN_OUTBOX_WAKE_QUEUE_URL).toBeDefined();
    });

    test('its role can read the secret, invoke both generators and send the wake', () => {
      const fn = webDoorFn();
      const roleRef = fn.Properties.Role['Fn::GetAtt'][0];
      const policies = template.findResources('AWS::IAM::Policy');
      const statements = Object.values(policies)
        .filter((policy: any) => JSON.stringify(policy.Properties.Roles ?? []).includes(roleRef))
        .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement as any[]);
      const actions = statements.flatMap((st) =>
        Array.isArray(st.Action) ? st.Action : [st.Action]);

      expect(actions).toEqual(expect.arrayContaining(['secretsmanager:GetSecretValue']));
      expect(actions).toEqual(expect.arrayContaining(['lambda:InvokeFunction']));
      expect(actions).toEqual(expect.arrayContaining(['sqs:SendMessage']));
    });

    test.each([
      ['onboarding', 'GET'],
      // ONE `{action}` resource carries answers/back/language. ApiStack sits
      // at 489 of CloudFormation's 500 resources, and four sibling resources
      // cost 20 (resource + method + CORS OPTIONS + two Lambda permissions
      // each) -- synthesis fails outright. This shape costs 10.
      ['{action}', 'ANY'],
    ])('/worker/onboarding/%s serves %s behind the worker Cognito authorizer', (part, method) => {
      const resources = apiTemplate.findResources('AWS::ApiGateway::Resource');
      const [logicalId] = Object.entries(resources).find(
        ([, r]: [string, any]) => r.Properties.PathPart === part,
      ) as [string, any];

      const methods = apiTemplate.findResources('AWS::ApiGateway::Method');
      const match = Object.values(methods).find((m: any) =>
        m.Properties.HttpMethod === method
        && JSON.stringify(m.Properties.ResourceId) === JSON.stringify({ Ref: logicalId })) as any;

      expect(match).toBeDefined();
      // The legal wall is deliberately absent (accepting the terms is step
      // one of this flow) but authentication is NOT: every route is COGNITO.
      expect(match.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
      expect(match.Properties.AuthorizerId).toBeDefined();
    });

    test('{action} is the ONLY child of /worker/onboarding', () => {
      // ANY on `{action}` matches every single-segment path under
      // /worker/onboarding, so a named sibling added later by another stack
      // would keep its route but lose the traffic to this handler's 404.
      // Nothing hangs anything off `onboarding` today (it is the only
      // `addResource('onboarding')` in the repo) and this keeps it that way.
      const resources = apiTemplate.findResources('AWS::ApiGateway::Resource');
      const [onboardingId] = Object.entries(resources).find(
        ([, r]: [string, any]) => r.Properties.PathPart === 'onboarding',
      ) as [string, any];
      const children = Object.values(resources).filter(
        (r: any) => JSON.stringify(r.Properties.ParentId) === JSON.stringify({ Ref: onboardingId }),
      );
      expect(children.map((c: any) => c.Properties.PathPart)).toEqual(['{action}']);
    });

    test('the door costs ApiStack 10 resources, and the stack has 11 to spare', () => {
      // A regression guard on the thing that actually broke: this stack is
      // one feature away from CloudFormation's hard maximum. If this fails
      // because the count grew, the fix is to SPLIT ApiStack, not to raise
      // the number.
      const all = apiTemplate.toJSON().Resources as Record<string, { Type: string }>;
      const mine = Object.keys(all).filter((id) => /Onboarding/i.test(id));
      expect(mine.length).toBe(10);
      expect(Object.keys(all).length).toBeLessThanOrEqual(500);
    });
  });
});

// ── Task 5: voice-trust-receiver v2 re-entry (transport flag ON) ─────────
//
// Self-contained (own app/stacks/template), same pattern processor.test.ts
// uses for its top-level 'v2 routing branch' describe: this scenario needs
// a DIFFERENT context flag than the rest of the file's shared `template`,
// so it stands up its own stack rather than mutating the shared one.
describe('WhatsAppStack — v2 inbound transport enabled', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        otpSmsFromNumber: '+13252210992',
        whatsappStatusCallbackUrl:
          'https://callbacks.example.test/prod/whatsapp/status-callback',
        whatsappInboundV2TransportEnabled: true,
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStackV2Transport');
    const database = new DatabaseStack(app, 'TestDatabaseStackV2Transport', { network });
    const auth = new AuthStack(app, 'TestAuthStackV2Transport', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    const ai = new AiStack(app, 'TestAiStackV2Transport', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    const api = new ApiStack(app, 'TestApiStackV2Transport', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    });
    new LegalStack(app, 'TestLegalStackV2Transport', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });
    const docsBucketStack = new cdk.Stack(app, 'TestDocsBucketStackV2Transport');
    const docsKey = new kms.Key(docsBucketStack, 'TestDocsKey');
    const docsBucket = new s3.Bucket(docsBucketStack, 'TestDocsBucket', {
      encryptionKey: docsKey,
      encryption: s3.BucketEncryption.KMS,
    });
    const whatsapp = new WhatsAppStack(app, 'TestWhatsAppStackV2Transport', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      workerPool: auth.workerPool,
      api: api.api,
      workerResource: api.workerResource,
      workerAuthorizer: api.workerAuthorizer,
      questionGeneratorFn: ai.questionGeneratorFn.function,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      trustAssessmentQueue: ai.trustAssessmentQueue,
      trustExtractionQueue: ai.trustExtractionQueue,
      statusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-whatsapp-alarms-test',
      documentsBucket: docsBucket,
    });
    template = Template.fromStack(whatsapp);
  });

  test('voice-trust-receiver Lambda gets WHATSAPP_INBOUND_V2_QUEUE_URL when the transport flag is on', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const receiver = Object.values(functions).find((resource: any) =>
      resource.Properties?.Description?.includes('voice-trust-receiver')) as any;
    expect(receiver).toBeDefined();
    expect(receiver.Properties.Environment.Variables)
      .toHaveProperty('WHATSAPP_INBOUND_V2_QUEUE_URL');
  });

  test('voice-trust-receiver role has an sqs:SendMessage grant on the v2 FIFO queue', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const receiver = Object.values(functions).find((resource: any) =>
      resource.Properties?.Description?.includes('voice-trust-receiver')) as any;
    const receiverRoleId = receiver.Properties.Role['Fn::GetAtt'][0];

    const queues = template.findResources('AWS::SQS::Queue');
    const v2QueueId = Object.entries(queues)
      .find(([, resource]: [string, any]) => resource.Properties?.QueueName === 'whatsapp-inbound-v2.fifo')?.[0];
    expect(v2QueueId).toBeDefined();

    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((policy: any) => policy.Properties?.Roles?.some(
        (role: any) => role.Ref === receiverRoleId,
      ));
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain(v2QueueId);
    expect(serialized).toContain('sqs:SendMessage');
  });

  // Stream B (Task 8d): the ai-profile-writer lambda gets the SAME queue
  // URL/grant, gated on the SAME transport flag, for its v2 profile-intake
  // completion branch.
  test('ai-profile-writer Lambda gets WHATSAPP_INBOUND_V2_QUEUE_URL when the transport flag is on', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const writer = Object.values(functions).find((resource: any) =>
      resource.Properties?.Description?.includes('ai-profile-writer')) as any;
    expect(writer).toBeDefined();
    expect(writer.Properties.Environment.Variables)
      .toHaveProperty('WHATSAPP_INBOUND_V2_QUEUE_URL');
  });

  test('ai-profile-writer role has an sqs:SendMessage grant on the v2 FIFO queue', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const writer = Object.values(functions).find((resource: any) =>
      resource.Properties?.Description?.includes('ai-profile-writer')) as any;
    const writerRoleId = writer.Properties.Role['Fn::GetAtt'][0];

    const queues = template.findResources('AWS::SQS::Queue');
    const v2QueueId = Object.entries(queues)
      .find(([, resource]: [string, any]) => resource.Properties?.QueueName === 'whatsapp-inbound-v2.fifo')?.[0];
    expect(v2QueueId).toBeDefined();

    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((policy: any) => policy.Properties?.Roles?.some(
        (role: any) => role.Ref === writerRoleId,
      ));
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain(v2QueueId);
    expect(serialized).toContain('sqs:SendMessage');
  });
});
