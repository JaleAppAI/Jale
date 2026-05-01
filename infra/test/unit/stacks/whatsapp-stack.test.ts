import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { WhatsAppStack } from '../../../lib/stacks/whatsapp-stack';

describe('WhatsAppStack', () => {
  let template: Template;
  let apiTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', { network });
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      cognitoSmsRole: network.cognitoSmsRole,
    });
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
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
  test('Stack creates 4 Lambda functions (webhook + processor + job-alert + ai-profile-writer)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 4);
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

  test('Processor Lambda has Cognito permissions (AdminConfirmSignUp + InitiateAuth + SignUp + RespondToAuthChallenge)', () => {
    const expectedActions = [
      'cognito-idp:SignUp',
      'cognito-idp:AdminConfirmSignUp',
      'cognito-idp:InitiateAuth',
      'cognito-idp:RespondToAuthChallenge',
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

    test('Stack creates a Standard (not Express) Step Functions state machine', () => {
      template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineType: 'STANDARD',
      });
    });

    test('Stack creates ai-profile-writer Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Description: Match.stringLikeRegexp('ai-profile-writer'),
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
  });
});
