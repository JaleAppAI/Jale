import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';

describe('AuthStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        environment: 'prod',
        otpSmsFromNumber: '+15125550123',
        otpSmsRequestTimeoutMs: 3500,
        otpSmsValidityPeriodSeconds: 180,
      },
    });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', {
      network,
    }); 
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    template = Template.fromStack(auth);
  });

  test('Two Cognito UserPools exist', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 2);
  });

  test('Worker pool uses only the custom OTP challenge, with Cognito MFA disabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-worker-pool',
      MfaConfiguration: 'OFF',
    });
  });

  test('UserPoolClients exist with generateSecret false', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  test('UserPoolClients include ALLOW_REFRESH_TOKEN_AUTH', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_REFRESH_TOKEN_AUTH']),
    });
  });

  test('Post-confirmation Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
    });
  });

  test('SQS dead-letter queue exists', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'jale-post-confirmation-dlq',
    });
  });

  // SMS IAM role now lives in NetworkStack (pre-deployed for IAM propagation).
  // See network-stack.test.ts for the cognito-idp trust assertion.

  // Cognito User Groups
  test('Workers group exists in Worker pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Workers',
    });
  });

  test('Employers group exists in Employer pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
      GroupName: 'Employers',
    });
  });

  test('Exactly two user pool groups exist', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
  });

  test('Employer pool has MFA optional', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-employer-pool',
      MfaConfiguration: 'OPTIONAL',
    });
  });

  test('Post-confirmation Lambda has DLQ_URL environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DLQ_URL: Match.anyValue(),
        }),
      }),
    });
  });

  test('Post-confirmation Lambda has scoped AdminAddUserToGroup permission', () => {
    // Policy is scoped to all Cognito pools in this account/region (not '*')
    // to respect least privilege while avoiding CDK circular dependency.
    // CDK serializes a single-element Resource as a Fn::Join, not an array.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cognito-idp:AdminAddUserToGroup',
            Effect: 'Allow',
            Resource: Match.objectLike({
              'Fn::Join': Match.anyValue(),
            }),
          }),
        ]),
      }),
    });
  });

  // ── Custom Auth Challenge (Phase 2) ──────────────────────────────
  test('Stack contains 5 Lambda functions (post-confirmation + 3 auth challenge + OTP callback)', () => {
    template.resourceCountIs('AWS::Lambda::Function', 5);
  });

  test('Worker pool has all 4 Lambda triggers wired', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-worker-pool',
      LambdaConfig: Match.objectLike({
        PostConfirmation: Match.anyValue(),
        DefineAuthChallenge: Match.anyValue(),
        CreateAuthChallenge: Match.anyValue(),
        VerifyAuthChallengeResponse: Match.anyValue(),
      }),
    });
  });

  test('Employer pool has ONLY post-confirmation trigger (no auth challenge triggers)', () => {
    // CDK emits an undefined key as absent from the CFN template.
    // We assert the employer pool has PostConfirmation but NOT the three
    // auth challenge triggers.
    const pools = template.findResources('AWS::Cognito::UserPool', {
      Properties: {
        UserPoolName: 'jale-employer-pool',
      },
    });
    const employerPool = Object.values(pools)[0] as any;
    expect(employerPool.Properties.LambdaConfig).toBeDefined();
    expect(employerPool.Properties.LambdaConfig.PostConfirmation).toBeDefined();
    expect(employerPool.Properties.LambdaConfig.DefineAuthChallenge).toBeUndefined();
    expect(employerPool.Properties.LambdaConfig.CreateAuthChallenge).toBeUndefined();
    expect(employerPool.Properties.LambdaConfig.VerifyAuthChallengeResponse).toBeUndefined();
  });

  test('CreateAuthChallenge Lambda has TWILIO_SECRET_ARN env var pointing at Secrets Manager', () => {
    // Twilio creds are loaded from Secrets Manager at runtime. The only
    // Twilio-related env var is TWILIO_SECRET_ARN; no secret values appear
    // in the synthesized template.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TWILIO_SECRET_ARN: 'jale/whatsapp/otp-twilio',
          TWILIO_FROM_NUMBER: '+15125550123',
          TWILIO_REQUEST_TIMEOUT_MS: '3500',
          TWILIO_VALIDITY_PERIOD_SECONDS: '180',
          OTP_RATE_LIMIT_TABLE_NAME: Match.anyValue(),
          OTP_DELIVERY_STATUS_TABLE_NAME: Match.anyValue(),
          TWILIO_STATUS_CALLBACK_URL: Match.anyValue(),
        }),
      }),
    });
  });

  test('UserPoolClients suppress username-existence errors', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  test('OTP rate limits use a TTL-enabled on-demand DynamoDB table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'subject', KeyType: 'HASH' },
        { AttributeName: 'window', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
  });

  test('OTP delivery status uses a TTL-enabled on-demand DynamoDB table keyed by Twilio MessageSid', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'twilioMessageSid', KeyType: 'HASH' },
      ],
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('OTP status callback Lambda has a public function URL and DynamoDB write access', () => {
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          OTP_DELIVERY_STATUS_TABLE_NAME: Match.anyValue(),
          TWILIO_SECRET_ARN: 'jale/whatsapp/otp-twilio',
        }),
      }),
    });
  });

  test('CreateAuthChallenge Lambda can perform DynamoDB rate-limit transactions', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies)
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);

    const transactStatements = statements.filter((statement: any) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes('dynamodb:TransactWriteItems');
    });

    expect(transactStatements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Effect: 'Allow',
          Resource: expect.anything(),
        }),
      ]),
    );
  });

  test('CreateAuthChallenge errors raise a CloudWatch alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'WorkerOtpSendErrors',
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 1,
    });
  });

  test('CreateAuthChallenge policy keeps partial ARN compatibility allow', () => {
    const secretArnParts = (resourceName: string) => [
      'arn:',
      { Ref: 'AWS::Partition' },
      ':secretsmanager:',
      { Ref: 'AWS::Region' },
      ':',
      { Ref: 'AWS::AccountId' },
      `:secret:${resourceName}`,
    ];

    const policies = template.findResources('AWS::IAM::Policy');
    const secretResources = Object.values(policies)
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes('secretsmanager:GetSecretValue');
      })
      .map((statement: any) => JSON.stringify(statement.Resource));

    expect(secretResources).toContain(JSON.stringify({
      'Fn::Join': ['', secretArnParts('jale/whatsapp/otp-twilio')],
    }));
    expect(secretResources).toContain(JSON.stringify({
      'Fn::Join': ['', secretArnParts('jale/whatsapp/otp-twilio-??????')],
    }));
  });

  test('synthesized template contains no plaintext Twilio credentials', () => {
    // Regression guard: stringify the entire CFN template and assert that
    // none of the pre-v3 plaintext env var names appear. If someone adds
    // them back via CDK context or env fallback, this test fires.
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).not.toContain('TWILIO_ACCOUNT_SID');
    expect(templateJson).not.toContain('TWILIO_AUTH_TOKEN');
  });
});
