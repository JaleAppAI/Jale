import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MatchingStack } from '../../../lib/stacks/matching-stack';

describe('MatchingStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const harness = new cdk.Stack(app, 'MatchingHarness');
    const vpc = new ec2.Vpc(harness, 'Vpc', { maxAzs: 2 });
    const lambdaSg = new ec2.SecurityGroup(harness, 'LambdaSg', { vpc });
    const dbSecret = new secretsmanager.Secret(harness, 'DbSecret');
    const matchingDbSecret = new secretsmanager.Secret(harness, 'MatchingDbSecret');

    const stack = new MatchingStack(app, 'TestMatchingStack', {
      vpc,
      privateSubnets: vpc.privateSubnets,
      lambdaSg,
      dbSecret,
      matchingDbSecret,
    });

    template = Template.fromStack(stack);
  });

  it('creates materialization and rerank queues plus DLQs', () => {
    template.resourceCountIs('AWS::SQS::Queue', 4);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'jale-candidate-materialization.fifo',
      FifoQueue: true,
      VisibilityTimeout: 240,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'jale-worker-rerank',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('creates a disabled scheduled rerank rule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      State: 'DISABLED',
      ScheduleExpression: 'rate(1 hour)',
    });
  });

  it('alarms when either DLQ has visible messages', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 1,
      EvaluationPeriods: 1,
      MetricName: 'ApproximateNumberOfMessagesVisible',
    });
  });
});
