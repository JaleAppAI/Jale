import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';

describe('ApiStack', () => {
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
    // LegalStack must be created so the dual authorizer is attached to a method
    new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });
    template = Template.fromStack(api);
  });

  test('REST API exists', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'jale-api',
    });
  });

  test('Three Cognito authorizers exist (worker, employer, dual)', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 3);
  });

  test('Health Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Health check endpoint',
    });
  });

  test('Worker profile Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Worker profile endpoint',
    });
  });

  test('Employer profile Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Employer profile endpoint',
    });
  });

  test('Token refresh Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Token refresh endpoint',
    });
  });

  test('Logout Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Logout endpoint',
    });
  });

  // Task 2.2 — per-route authorizer verification
  test('GET /worker/profile is protected by WorkerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  test('GET /employer/profile is protected by EmployerAuthorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('EmployerAuthorizer'),
      }),
    });
  });

  test('GET /health has no authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
    });
  });
});
