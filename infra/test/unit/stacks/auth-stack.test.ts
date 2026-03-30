import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';

describe('AuthStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { environment: 'prod' } });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', {
      network,
    }); 
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      cognitoSmsRole: network.cognitoSmsRole,
    });
    template = Template.fromStack(auth);
  });

  test('Two Cognito UserPools exist', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 2);
  });

  test('Worker pool has MFA required', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'jale-worker-pool',
      MfaConfiguration: 'ON',
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

  // Task 2.1 — Cognito User Groups
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
});
