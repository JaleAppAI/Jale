import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { AuthStack } from '../lib/stacks/auth-stack';

describe('AuthStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
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

  test('IAM role for SMS exists with cognito-idp trust', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: {
              Service: 'cognito-idp.amazonaws.com',
            },
          }),
        ]),
      }),
    });
  });

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

  test('Post-confirmation Lambda has AdminAddUserToGroup permission', () => {
    // CloudFormation serializes a single-action policy as a string, not an array
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cognito-idp:AdminAddUserToGroup',
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      }),
    });
  });
});
