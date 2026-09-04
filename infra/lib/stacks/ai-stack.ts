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
import { jaleAlarm } from '../constructs/jale-alarm';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { BEDROCK_MODEL_ID, bedrockArns } from '../bedrock-arns';

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
  /** R1-X: skill-extraction lane. Separate queue from the scoring lane so a
   *  extraction backlog or DLQ can never stall or dead-letter a trust score. */
  readonly trustExtractionQueue: sqs.IQueue;
}

export class AiStack extends cdk.Stack implements AiStackOutputs {
  public readonly questionGeneratorFn: JaleLambdaFunction;
  public readonly aliasGeneratorFn: JaleLambdaFunction;
  public readonly trustAssessmentQueue: sqs.IQueue;
  public readonly trustExtractionQueue: sqs.IQueue;

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

    // R1-X: the extraction lane gets its OWN queue + DLQ rather than sharing
    // the assessment pair. Two consumers on one queue would make each one's
    // retries and dead-letters the other's problem, and the whole point of
    // this lane is that it cannot affect scoring.
    const trustExtractionDlq = new sqs.Queue(this, 'TrustExtractionDlq', {
      queueName: 'trust-extraction-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.trustExtractionQueue = new sqs.Queue(this, 'TrustExtractionQueue', {
      queueName: 'trust-extraction-queue',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      // 6x the extractor's 60s timeout, matching the assessment queue.
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: trustExtractionDlq,
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

    // ── R1-X: trust-answer skill extractor ───────────────────────────
    // Same Bedrock model and the same SQS payload as the scorer, but a
    // wholly separate lane: no SSM rubric (its prompt is versioned in code
    // alongside the parsing contract), no write access to
    // worker_trust_assessments or users, and its own queue/DLQ/alarms.
    const trustExtractorLambda = new JaleLambdaFunction(this, 'TrustExtractorLambda', {
      entry: path.join(__dirname, '../../lambda/ai/trust-extractor.ts'),
      description: 'Trust answer skill extractor with stale-claim recovery',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 60,
      // Larger than the repo default (256): the extractor validates and
      // re-serializes a multi-array JSON document per invocation, and the
      // extra CPU that comes with the memory bump keeps it well inside the
      // 60s timeout that sizes the queue's visibility window.
      memorySize: 512,
      environment: {
        DB_SECRET_ARN: props.aiDbSecret.secretName,
        BEDROCK_MODEL_ID,
        TRUST_EXTRACTION_QUEUE_URL: this.trustExtractionQueue.queueUrl,
      },
      nodeModules: ['@aws-sdk/client-bedrock-runtime'],
    });
    props.aiDbSecret.grantRead(trustExtractorLambda.function);
    trustExtractorLambda.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: bedrockArns(region, account),
      }),
    );
    this.trustExtractionQueue.grantConsumeMessages(trustExtractorLambda.function);
    // Send, too: the recovery cron re-queues its own stale claims.
    this.trustExtractionQueue.grantSendMessages(trustExtractorLambda.function);

    trustExtractorLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(this.trustExtractionQueue, {
        batchSize: 1,
        maxConcurrency: 5,
      }),
    );

    new events.Rule(this, 'TrustExtractorRecoveryCron', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      description: 'Reset stale trust extraction claims',
      targets: [
        new targets.LambdaFunction(trustExtractorLambda.function, {
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

    // `jaleAlarm` here and for TrustExtractionDlqAlarm below, for the one
    // property all three were missing: `treatMissingData`. An idle trust queue
    // and an unthrottled scorer publish NO datapoints, so each of these sat
    // flapping OK <-> INSUFFICIENT_DATA on CloudWatch's `missing` default —
    // while TrustScorerFailuresAlarm and TrustExtractorErrorsAlarm, written
    // later in this same file, already set NOT_BREACHING. The inconsistency is
    // what made the flapping read as a quirk of particular alarms rather than
    // as a missing default; across this stack and BillingStack/MatchingStack it
    // was 64 of 87 alarm state transitions in one week.
    //
    // Thresholds, operators, periods and alarmNames are preserved exactly.
    jaleAlarm(this, 'TrustAssessmentDlqAlarm', {
      metric: trustAssessmentDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'TrustAssessmentDlqDepth',
      actions: [aiAlarmAction],
    });

    jaleAlarm(this, 'TrustScorerThrottleAlarm', {
      metric: trustScorerLambda.function.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      // `>` 5, not `>=`: five throttles in a five-minute window is the
      // tolerated level here, six is the signal. Passed explicitly rather than
      // left to the helper's `>=` default — the semantics are the alarm's, not
      // the helper's.
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmName: 'TrustScorerThrottles',
      actions: [aiAlarmAction],
    });

    // Bedrock parse/validation failures previously retried into the DLQ with
    // zero log signal about WHY. The scorer now emits structured
    // TrustScorerParseFailure / TrustScorerValidationFailure lines; both
    // feed one metric so a single alarm covers "the scorer is producing
    // unusable model output".
    // LITERAL term pattern, NOT `logs.FilterPattern.stringValue('$.metric',
    // ...)`: a JSON selector only matches log events that are themselves valid
    // JSON, and Node 20's default TEXT log format prefixes every console line
    // with `timestamp<TAB>requestId<TAB>LEVEL<TAB>`. The selector this used to
    // carry matched nothing, so TrustScorerFailures never left zero and
    // TrustScorerFailuresAlarm could not fire. See notifications-stack.ts:260
    // and test/unit/stacks/metric-filter-patterns.test.ts.
    const scorerFailureFilter = (id: string, metricValueEquals: string) =>
      new logs.MetricFilter(this, id, {
        logGroup: trustScorerLambda.logGroup,
        filterPattern: logs.FilterPattern.literal(`"${metricValueEquals}"`),
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

    // R1-X extractor alarms. The extractor deliberately logs no model output
    // and no answer text, so unlike the scorer there is no log-metric-filter
    // alarm here: a bad model response marks the row failed and rethrows, so
    // Lambda Errors + DLQ depth are the two signals that matter.
    new cloudwatch.Alarm(this, 'TrustExtractorErrorsAlarm', {
      metric: trustExtractorLambda.function.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmName: 'TrustExtractorErrors',
    }).addAlarmAction(aiAlarmAction);

    jaleAlarm(this, 'TrustExtractionDlqAlarm', {
      metric: trustExtractionDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmName: 'TrustExtractionDlqDepth',
      actions: [aiAlarmAction],
    });
  }
}
