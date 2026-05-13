import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AiStack } from '../../../lib/stacks/ai-stack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const harness = new cdk.Stack(app, 'AiHarness', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(harness, 'Vpc', { maxAzs: 2 });
  const lambdaSg = new ec2.SecurityGroup(harness, 'LambdaSg', { vpc });
  const aiDbSecret = new secretsmanager.Secret(harness, 'AiDbSecret');

  const stack = new AiStack(app, 'TestAiStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    vpc,
    privateSubnets: vpc.privateSubnets,
    lambdaSg,
    aiDbSecret,
  });

  return Template.fromStack(stack);
}

describe('AiStack', () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  it('creates trust-assessment-queue with correct visibility timeout', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'trust-assessment-queue',
      VisibilityTimeout: 360,
    });
  });

  it('creates trust-assessment-dlq', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'trust-assessment-dlq',
      MessageRetentionPeriod: 14 * 24 * 3600,
    });
  });

  it('creates SSM scoring rubric parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/jale/ai/scoring-rubric',
      Type: 'String',
    });
  });

  it('creates question-generator Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('question'),
      Timeout: 30,
    });
  });

  it('limits trust-scorer SQS concurrency without reserved concurrency', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Async trust scorer with stale-claim recovery',
      ReservedConcurrentExecutions: Match.absent(),
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      ScalingConfig: {
        MaximumConcurrency: 5,
      },
    });
  });

  it('creates EventBridge recovery rule on 15-min schedule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
    });
  });

  it('creates DLQ depth alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TrustAssessmentDlqDepth',
    });
  });
});
