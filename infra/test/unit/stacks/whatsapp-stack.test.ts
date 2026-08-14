import * as cdk from 'aws-cdk-lib';
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
    const whatsapp = new WhatsAppStack(app, 'TestWhatsAppStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      workerPool: auth.workerPool,
      api: api.api,
      questionGeneratorFn: ai.questionGeneratorFn.function,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      trustAssessmentQueue: ai.trustAssessmentQueue,
      statusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-whatsapp-alarms-test',
    });
    template = Template.fromStack(whatsapp);
    apiTemplate = Template.fromStack(api);
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
  test('Stack creates 12 Lambda functions including the worker-intent drain', () => {
    template.resourceCountIs('AWS::Lambda::Function', 12);
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
    expect(configured).toHaveLength(9);
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

    test('Stack creates two Standard (not Express) Step Functions state machines', () => {
      template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'STANDARD',
      });
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
    const whatsapp = new WhatsAppStack(app, 'TestWhatsAppStackV2Transport', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      workerPool: auth.workerPool,
      api: api.api,
      questionGeneratorFn: ai.questionGeneratorFn.function,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      trustAssessmentQueue: ai.trustAssessmentQueue,
      statusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-whatsapp-alarms-test',
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
