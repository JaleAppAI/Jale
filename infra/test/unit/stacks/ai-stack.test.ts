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
  // ── R1-X: trust-answer skill extractor ────────────────────────────
  // Every assertion below keys on something UNIQUE to the extractor
  // (queue name, its own Description, its own AlarmName). `hasResourceProperties`
  // matches ANY resource of the type, so a generic assertion such as
  // `{ BatchSize: 1 }` or `{ ScheduleExpression: 'rate(15 minutes)' }` would
  // already be satisfied by the scorer's resources and pass vacuously.
  const EXTRACTOR_DESCRIPTION = 'Trust answer skill extractor with stale-claim recovery';

  it('creates trust-extraction-queue mirroring the assessment pair (KMS-managed, 6x the 60s Lambda timeout, maxReceiveCount 3)', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'trust-extraction-queue',
      VisibilityTimeout: 360,
      KmsMasterKeyId: 'alias/aws/sqs',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('creates trust-extraction-dlq with 14-day retention', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'trust-extraction-dlq',
      MessageRetentionPeriod: 14 * 24 * 3600,
      KmsMasterKeyId: 'alias/aws/sqs',
    });
  });

  it('creates the TrustExtractor Lambda on Node 20 with 512MB, a 60s timeout and its own queue URL', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: EXTRACTOR_DESCRIPTION,
      Runtime: 'nodejs20.x',
      MemorySize: 512,
      Timeout: 60,
      Environment: {
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
          BEDROCK_MODEL_ID: Match.anyValue(),
          TRUST_EXTRACTION_QUEUE_URL: Match.anyValue(),
        }),
      },
    });
  });

  it('does not give the extractor the scorer`s SSM rubric parameter (its prompt lives in code)', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: EXTRACTOR_DESCRIPTION },
    });
    expect(Object.keys(functions)).toHaveLength(1);
    const variables = Object.values(functions)[0].Properties.Environment.Variables;
    expect(variables.SSM_RUBRIC_PARAM).toBeUndefined();
  });

  it('subscribes the extractor to its own queue with batchSize 1', () => {
    const extractor = Object.keys(template.findResources('AWS::Lambda::Function', {
      Properties: { Description: EXTRACTOR_DESCRIPTION },
    }))[0];
    const mappings = Object.values(
      template.findResources('AWS::Lambda::EventSourceMapping'),
    ).filter((mapping: any) => mapping.Properties.FunctionName?.Ref === extractor);
    expect(mappings).toHaveLength(1);
    expect(mappings[0].Properties.BatchSize).toBe(1);
    // Pins the SOURCE queue too: a mapping wired to the assessment queue
    // would otherwise satisfy every other assertion in this test.
    const extractionQueue = Object.keys(template.findResources('AWS::SQS::Queue', {
      Properties: { QueueName: 'trust-extraction-queue' },
    }))[0];
    expect(mappings[0].Properties.EventSourceArn['Fn::GetAtt'])
      .toEqual([extractionQueue, 'Arn']);
  });

  it('creates a dedicated 15-min recovery rule that invokes the EXTRACTOR with {source: cron.recovery}', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Description: 'Reset stale trust extraction claims',
      ScheduleExpression: 'rate(15 minutes)',
      Targets: Match.arrayWith([
        Match.objectLike({ Input: '{"source":"cron.recovery"}' }),
      ]),
    });
  });

  it('alarms on extractor errors and on trust-extraction DLQ depth, both actioned', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TrustExtractorErrors',
      MetricName: 'Errors',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TrustExtractionDlqDepth',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: Match.anyValue(),
    });
  });

  it('exposes trustExtractionQueue so WhatsAppStack can grant the drain send access', () => {
    const app = new cdk.App();
    const harness = new cdk.Stack(app, 'AiHarness2', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const vpc = new ec2.Vpc(harness, 'Vpc', { maxAzs: 2 });
    const stack = new AiStack(app, 'TestAiStackExport', {
      env: { account: '123456789012', region: 'us-east-1' },
      vpc,
      privateSubnets: vpc.privateSubnets,
      lambdaSg: new ec2.SecurityGroup(harness, 'LambdaSg', { vpc }),
      aiDbSecret: new secretsmanager.Secret(harness, 'AiDbSecret'),
      alarmTopicArn: 'arn:aws:sns:us-east-1:123456789012:jale-ai-alarms-test',
    });
    expect(stack.trustExtractionQueue).toBeDefined();
    expect(stack.trustExtractionQueue).not.toBe(stack.trustAssessmentQueue);
  });
});
