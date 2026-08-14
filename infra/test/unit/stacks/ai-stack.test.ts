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
    // Same fail-closed alarm-target contract as WhatsAppStack.
    alarmTopicArn: 'arn:aws:sns:us-east-1:123456789012:jale-ai-alarms-test',
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

  it('creates alias-generator Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('alias'),
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

  // 2026-07-27 observability pass: these alarms existed without any action
  // — red in the console, paging nobody. Every AiStack alarm must carry an
  // SNS action from now on.
  it('every alarm has an alarm action wired (no silent alarms)', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const names = Object.keys(alarms);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const actions = alarms[name].Properties.AlarmActions;
      expect(Array.isArray(actions) && actions.length > 0).toBe(true);
    }
  });

  // T-A1: bedrockArns() was extracted from a private function in this file
  // into the shared infra/lib/bedrock-arns.ts (so ApiStack's new
  // employer-generate-description Lambda can scope an identical IAM policy
  // without duplicating the ARN list). This pins the exact IAM resource ARN
  // set every Bedrock-invoking Lambda in this stack is granted, so a future
  // edit to the shared module cannot silently change AiStack's template.
  it('grants bedrock:InvokeModel scoped to the exact pinned Nova Lite ARN set (extracted to lib/bedrock-arns.ts)', () => {
    // bedrockArns() returns 4 entries, but in this us-east-1 test harness the
    // hardcoded 'us-east-1' literal foundation-model ARN and the region-templated
    // one are byte-identical -- CDK's PolicyDocument rendering dedupes the
    // Resource array, so the synthesized template carries 3 unique ARNs here.
    // (In us-east-2 production this harness's collision does not occur.)
    const expectedResources = [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-lite-v1:0',
      'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
      'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0',
    ];
    const policies = template.findResources('AWS::IAM::Policy');
    const bedrockStatements = Object.values(policies)
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => statement.Action === 'bedrock:InvokeModel');

    expect(bedrockStatements.length).toBeGreaterThanOrEqual(3); // question-generator, alias-generator, trust-scorer
    for (const statement of bedrockStatements) {
      expect(statement.Resource).toEqual(expectedResources);
      expect(statement.Effect).toBe('Allow');
    }
  });

  it('feeds Bedrock parse/validation failures into one alarmed TrustScorerFailures metric', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.metric = "TrustScorerParseFailure" }',
      MetricTransformations: [
        { MetricNamespace: 'Jale/Ai', MetricName: 'TrustScorerFailures', MetricValue: '1' },
      ],
    });
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.metric = "TrustScorerValidationFailure" }',
      MetricTransformations: [
        { MetricNamespace: 'Jale/Ai', MetricName: 'TrustScorerFailures', MetricValue: '1' },
      ],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TrustScorerFailures',
    });
  });
});
