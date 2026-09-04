import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'node:path';
import { Construct } from 'constructs';
import { BEDROCK_MODEL_ID, bedrockArns } from '../bedrock-arns';
import { jaleAlarm } from '../constructs/jale-alarm';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface MatchingStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  lambdaSg: ec2.ISecurityGroup;
  dbSecret: secretsmanager.ISecret;
  matchingDbSecret: secretsmanager.ISecret;
}

export interface MatchingStackOutputs {
  candidateMaterializationQueue: sqs.IQueue;
  workerRerankQueue: sqs.IQueue;
  employerCandidateRerankQueue: sqs.IQueue;
}

export class MatchingStack extends cdk.Stack implements MatchingStackOutputs {
  readonly candidateMaterializationQueue: sqs.IQueue;
  readonly workerRerankQueue: sqs.IQueue;
  readonly employerCandidateRerankQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: MatchingStackProps) {
    super(scope, id, props);

    const materializationDlq = new sqs.Queue(this, 'CandidateMaterializationDlq', {
      queueName: 'jale-candidate-materialization-dlq.fifo',
      fifo: true,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.candidateMaterializationQueue = new sqs.Queue(this, 'CandidateMaterializationQueue', {
      queueName: 'jale-candidate-materialization.fifo',
      fifo: true,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.minutes(4),
      deadLetterQueue: { queue: materializationDlq, maxReceiveCount: 3 },
    });

    const rerankDlq = new sqs.Queue(this, 'WorkerRerankDlq', {
      queueName: 'jale-worker-rerank-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.workerRerankQueue = new sqs.Queue(this, 'WorkerRerankQueue', {
      queueName: 'jale-worker-rerank',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      deadLetterQueue: { queue: rerankDlq, maxReceiveCount: 3 },
    });

    const employerCandidateRerankDlq = new sqs.Queue(this, 'EmployerCandidateRerankDlq', {
      queueName: 'jale-employer-candidate-rerank-dlq',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.employerCandidateRerankQueue = new sqs.Queue(this, 'EmployerCandidateRerankQueue', {
      queueName: 'jale-employer-candidate-rerank',
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: employerCandidateRerankDlq, maxReceiveCount: 3 },
    });

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    const employerCandidateRerankLambda = new JaleLambdaFunction(this, 'EmployerCandidateRerankLambda', {
      entry: path.join(__dirname, '../../lambda/matching/employer-candidate-rerank.ts'),
      description: 'Async employer candidate Bedrock reranker',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      timeout: 60,
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        MATCHING_DB_SECRET_ARN: props.matchingDbSecret.secretArn,
        BEDROCK_MODEL_ID,
      },
      nodeModules: ['@aws-sdk/client-bedrock-runtime'],
    });
    props.dbSecret.grantRead(employerCandidateRerankLambda.function);
    props.matchingDbSecret.grantRead(employerCandidateRerankLambda.function);
    this.employerCandidateRerankQueue.grantConsumeMessages(employerCandidateRerankLambda.function);
    employerCandidateRerankLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      // Shared with AiStack/ApiStack/WhatsAppStack via lib/bedrock-arns.ts.
      // This stack used to declare its own model id and its own copy of this
      // ARN list, which is how it stayed on the retired Nova Lite id after
      // WhatsAppStack moved to Claude Haiku 4.5.
      resources: bedrockArns(region, account),
    }));
    employerCandidateRerankLambda.function.addEventSource(
      new lambdaEventSources.SqsEventSource(this.employerCandidateRerankQueue, {
        batchSize: 1,
        maxConcurrency: 3,
      }),
    );

    new events.Rule(this, 'ScheduledRerankRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      enabled: false,
      description: 'Periodic worker rerank refresh - target wired in V1',
    });

    // ── DLQ depth alarms ──
    // `jaleAlarm`, not `new cloudwatch.Alarm`, for one property: these three
    // carried no `treatMissingData`, so an EMPTY dead-letter queue — which
    // publishes no datapoints at all — put each of them into
    // INSUFFICIENT_DATA and then back to OK on the next datapoint, forever.
    // Together with the BillingStack/AiStack five that was 64 of 87 alarm
    // state transitions in one week, i.e. the alarm channel training its
    // operator to ignore it. `notBreaching` (the helper's default) says the
    // true thing: an empty DLQ is healthy, not unknown.
    //
    // Everything else is byte-identical on purpose. In particular the operator
    // stays `>= 1` — the helper's default is the same value CDK itself
    // defaults `comparisonOperator` to, so these alarms have always been
    // ">= 1 message", and `> 1` would quietly mean one dead-lettered message
    // no longer alarms. And no `alarmName`: CloudFormation generates the
    // physical name for these, and introducing one would REPLACE a live alarm.
    jaleAlarm(this, 'CandidateMaterializationDlqAlarm', {
      metric: materializationDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Candidate materialization DLQ has messages',
    });

    jaleAlarm(this, 'WorkerRerankDlqAlarm', {
      metric: rerankDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Worker rerank DLQ has messages',
    });

    jaleAlarm(this, 'EmployerCandidateRerankDlqAlarm', {
      metric: employerCandidateRerankDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Employer candidate rerank DLQ has messages',
    });
  }
}
