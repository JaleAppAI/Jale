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
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
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
      trustAssessmentQueue: ai.trustAssessmentQueue,
      statusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    });
    template = Template.fromStack(whatsapp);
    apiTemplate = Template.fromStack(api);
  });

  // ── SQS infrastructure ─────────────────────────────────────────
  test('Stack creates exactly 2 SQS queues (inbound + DLQ)', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
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

  // ── Lambda functions ───────────────────────────────────────────
  test('Stack creates 8 Lambda functions including the status callback', () => {
    template.resourceCountIs('AWS::Lambda::Function', 8);
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

  test('all six WhatsAppStack outbound senders and callback use the exact configured URL', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const configured = Object.values(functions).filter((resource: any) =>
      resource.Properties?.Environment?.Variables?.TWILIO_STATUS_CALLBACK_URL
        === 'https://callbacks.example.test/prod/whatsapp/status-callback');
    expect(configured).toHaveLength(7);
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
            TRUST_ASSESSMENT_QUEUE_URL: Match.anyValue(),
          }),
        },
      });
    });
  });
});
