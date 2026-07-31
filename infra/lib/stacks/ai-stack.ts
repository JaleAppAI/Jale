import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface AiStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly aiDbSecret: secretsmanager.ISecret;
  /** Existing monitored SNS topic for alarm actions (same contract as
   * WhatsAppStack: pass this or `-c whatsappAlarmEmail=` to subscribe a
   * CDK-created topic; the stack fails closed with neither). */
  readonly alarmTopicArn?: string;
}

export interface AiStackOutputs {
  readonly questionGeneratorFn: JaleLambdaFunction;
  readonly aliasGeneratorFn: JaleLambdaFunction;
  readonly trustAssessmentQueue: sqs.IQueue;
}

const BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0';

function bedrockArns(region: string, account: string): string[] {
  return [
    `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_MODEL_ID}`,
    'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
    `arn:aws:bedrock:${region}::foundation-model/amazon.nova-lite-v1:0`,
    'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0',
  ];
}

export class AiStack extends cdk.Stack implements AiStackOutputs {
  public readonly questionGeneratorFn: JaleLambdaFunction;
  public readonly aliasGeneratorFn: JaleLambdaFunction;
  public readonly trustAssessmentQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: AiStackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    const rubricParam = new ssm.StringParameter(this, 'ScoringRubric', {
      parameterName: '/jale/ai/scoring-rubric',
      description: 'Versioned trust assessment scoring rubric JSON',
      stringValue: JSON.stringify({
        version: '1.0',
        total_points: 100,
        system_instruction:
          "Score a blue-collar worker's answers for demonstrated trade knowledge and real experience. " +
          'English and Spanish answers are equally valid. Return only valid JSON.',
        dimensions: [
          { key: 'specific_knowledge', max_points: 30 },
          { key: 'practical_experience', max_points: 30 },
          { key: 'safety_awareness', max_points: 20 },
          { key: 'communication_clarity', max_points: 20 },
        ],
        output_format: {
          competency_score: 'integer 0-100, exact sum of all dimension scores',
          score_components: {
            specific_knowledge: 'integer 0-30',
            practical_experience: 'integer 0-30',
            safety_awareness: 'integer 0-20',
            communication_clarity: 'integer 0-20',
          },
          score_rationale: {
            specific_knowledge: 'one sentence explaining this dimension score',
            practical_experience: 'one sentence explaining this dimension score',
            safety_awareness: 'one sentence explaining this dimension score',
            communication_clarity: 'one sentence explaining this dimension score',
          },
        },
      }),
    });

    const trustAssessmentDlq = new sqs.Queue(this, 'TrustAssessmentDlq', {
      queueName: 'trust-assessment-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.trustAssessmentQueue = new sqs.Queue(this, 'TrustAssessmentQueue', {
      queueName: 'trust-assessment-queue',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: trustAssessmentDlq,
        maxReceiveCount: 3,
      },
    });

    this.questionGeneratorFn = new JaleLambdaFunction(this, 'QuestionGeneratorLambda', {
      entry: path.join(__dirname, '../../lambda/ai/question-generator.ts'),
      description: 'Bedrock question generator for custom trades',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 30,
      environment: {
        DB_SECRET_ARN: props.aiDbSecret.secretName,
        BEDROCK_MODEL_ID,
      },
      nodeModules: ['@aws-sdk/client-bedrock-runtime'],
    });
    props.aiDbSecret.grantRead(this.questionGeneratorFn.function);
    this.questionGeneratorFn.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockArns(region, account),
      }),
    );

    this.aliasGeneratorFn = new JaleLambdaFunction(this, 'AliasGeneratorLambda', {
      entry: path.join(__dirname, '../../lambda/ai/alias-generator.ts'),
      description: 'Bedrock bilingual alias generator for trades',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 30,
      environment: {
        DB_SECRET_ARN: props.aiDbSecret.secretName,
        BEDROCK_MODEL_ID,
      },
      nodeModules: ['@aws-sdk/client-bedrock-runtime'],
    });
    props.aiDbSecret.grantRead(this.aliasGeneratorFn.function);
    this.aliasGeneratorFn.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockArns(region, account),
      }),
    );

    const trustScorerLambda = new JaleLambdaFunction(this, 'TrustScorerLambda', {
      entry: path.join(__dirname, '../../lambda/ai/trust-scorer.ts'),
      description: 'Async trust scorer with stale-claim recovery',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 60,
      environment: {
        DB_SECRET_ARN: props.aiDbSecret.secretName,
        BEDROCK_MODEL_ID,
        SSM_RUBRIC_PARAM: rubricParam.parameterName,
        TRUST_ASSESSMENT_QUEUE_URL: this.trustAssessmentQueue.queueUrl,
      },
      nodeModules: [
        '@aws-sdk/client-bedrock-runtime',
        '@aws-sdk/client-ssm',
      ],
    });
    props.aiDbSecret.grantRead(trustScorerLambda.function);
    trustScorerLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockArns(region, account),
      }),
    );
    trustScorerLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [rubricParam.parameterArn],
      }),
    );
    this.trustAssessmentQueue.grantConsumeMessages(trustScorerLambda.function);
    this.trustAssessmentQueue.grantSendMessages(trustScorerLambda.function);

    trustScorerLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(this.trustAssessmentQueue, {
        batchSize: 1,
        maxConcurrency: 5,
      }),
    );

    new events.Rule(this, 'TrustScorerRecoveryCron', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      description: 'Reset stale trust assessment scoring claims',
      targets: [
        new targets.LambdaFunction(trustScorerLambda.function, {
          event: events.RuleTargetInput.fromObject({ source: 'cron.recovery' }),
        }),
      ],
    });

    // ── Alarm actions (2026-07-27 observability pass) ────────────────
    // These alarms existed since C-lane but had NO action attached — they
    // turned red in the console and paged nobody, so a Bedrock parse
    // failure or DLQ redrive was invisible. Same fail-closed contract as
    // WhatsAppStack: an alarm with no reachable subscriber is not
    // actionable.
    const aiAlarmEmail = this.node.tryGetContext('whatsappAlarmEmail');
    if (!props.alarmTopicArn && !aiAlarmEmail) {
      throw new Error(
        'AiStack requires an actionable alarm target: pass alarmTopicArn '
        + '(-c whatsappAlarmTopicArn=<existing SNS topic ARN>) or -c whatsappAlarmEmail=<address> '
        + 'to subscribe a new topic.',
      );
    }
    const aiAlarmTopic = props.alarmTopicArn
      ? sns.Topic.fromTopicArn(this, 'AiAlarmTopic', props.alarmTopicArn)
      : new sns.Topic(this, 'AiAlarmTopic', { topicName: 'jale-ai-alarms' });
    if (!props.alarmTopicArn && aiAlarmEmail) {
      (aiAlarmTopic as sns.Topic).addSubscription(
        new snsSubscriptions.EmailSubscription(aiAlarmEmail),
      );
    }
    const aiAlarmAction = new cloudwatchActions.SnsAction(aiAlarmTopic);

    new cloudwatch.Alarm(this, 'TrustAssessmentDlqAlarm', {
      metric: trustAssessmentDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'TrustAssessmentDlqDepth',
    }).addAlarmAction(aiAlarmAction);

    new cloudwatch.Alarm(this, 'TrustScorerThrottleAlarm', {
      metric: trustScorerLambda.function.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmName: 'TrustScorerThrottles',
    }).addAlarmAction(aiAlarmAction);

    // Bedrock parse/validation failures previously retried into the DLQ with
    // zero log signal about WHY. The scorer now emits structured
    // TrustScorerParseFailure / TrustScorerValidationFailure lines; both
    // feed one metric so a single alarm covers "the scorer is producing
    // unusable model output".
    const scorerFailureFilter = (id: string, metricValueEquals: string) =>
      new logs.MetricFilter(this, id, {
        logGroup: trustScorerLambda.logGroup,
        filterPattern: logs.FilterPattern.stringValue('$.metric', '=', metricValueEquals),
        metricNamespace: 'Jale/Ai',
        metricName: 'TrustScorerFailures',
        metricValue: '1',
      });
    scorerFailureFilter('TrustScorerParseFailureMetric', 'TrustScorerParseFailure');
    scorerFailureFilter('TrustScorerValidationFailureMetric', 'TrustScorerValidationFailure');
    new cloudwatch.Alarm(this, 'TrustScorerFailuresAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'Jale/Ai',
        metricName: 'TrustScorerFailures',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'TrustScorerFailures',
    }).addAlarmAction(aiAlarmAction);
  }
}
