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

  it('creates materialization, worker rerank, and employer candidate rerank queues plus DLQs', () => {
    template.resourceCountIs('AWS::SQS::Queue', 6);
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
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'jale-employer-candidate-rerank',
      VisibilityTimeout: 360,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('creates employer candidate rerank worker with SQS event source', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Async employer candidate Bedrock reranker',
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      ScalingConfig: {
        MaximumConcurrency: 3,
      },
    });
  });

  // Pinned to the shared lib/bedrock-arns.ts baseline (Claude Haiku 4.5), not
  // Match.anyValue(): this stack used to carry its OWN `const bedrockModelId`
  // and its own copy-pasted 4-ARN list, which is exactly how it stayed on the
  // retired Nova Lite id after WhatsAppStack moved to Haiku. An "env var
  // exists" assertion would not have caught that.
  it('pins the employer rerank worker to the shared Claude Haiku 4.5 model id', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Async employer candidate Bedrock reranker',
      Environment: {
        Variables: Match.objectLike({
          BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        }),
      },
    });
  });

  // Full Resource-array assertion, mirroring whatsapp-stack.test.ts's shape.
  // This harness stack is env-agnostic (no `env:` in beforeAll), so the
  // region/account-bearing ARNs render as Fn::Join intrinsics and CDK cannot
  // dedupe the `${region}` foundation-model entry against the us-east-1
  // literal -- all 4 ARNs survive into the template here.
  it('grants Bedrock invoke permission to employer rerank worker on exactly the 4 Haiku 4.5 ARNs', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
    const bedrockStatements = policies
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[])
      .filter((s: any) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('bedrock:InvokeModel');
      });

    expect(bedrockStatements).toHaveLength(1);
    expect(bedrockStatements[0].Effect).toBe('Allow');
    const resources = bedrockStatements[0].Resource as any[];
    expect(resources).toHaveLength(4);
    // Slots 0 and 2 carry region/account tokens (Fn::Join with Ref), so match
    // their literal tails; slots 1 and 3 are plain strings.
    expect(JSON.stringify(resources[0])).toContain('inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(resources[1]).toBe('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(JSON.stringify(resources[2])).toContain('foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(resources[3]).toBe('arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0');
    for (const r of resources) {
      expect(JSON.stringify(r)).not.toContain('nova-lite');
    }
  });

  it('creates a disabled scheduled rerank rule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      State: 'DISABLED',
      ScheduleExpression: 'rate(1 hour)',
    });
  });

  it('alarms when either DLQ has visible messages', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 1,
      EvaluationPeriods: 1,
      MetricName: 'ApproximateNumberOfMessagesVisible',
    });
  });
});
