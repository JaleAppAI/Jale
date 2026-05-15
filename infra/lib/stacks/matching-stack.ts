import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'node:path';
import { Construct } from 'constructs';
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

    const bedrockModelId = 'us.amazon.nova-lite-v1:0';
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
        BEDROCK_MODEL_ID: bedrockModelId,
      },
      nodeModules: ['@aws-sdk/client-bedrock-runtime'],
    });
    props.dbSecret.grantRead(employerCandidateRerankLambda.function);
    props.matchingDbSecret.grantRead(employerCandidateRerankLambda.function);
    this.employerCandidateRerankQueue.grantConsumeMessages(employerCandidateRerankLambda.function);
    employerCandidateRerankLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${region}:${account}:inference-profile/${bedrockModelId}`,
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
        `arn:aws:bedrock:${region}::foundation-model/amazon.nova-lite-v1:0`,
        'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0',
      ],
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

    new cloudwatch.Alarm(this, 'CandidateMaterializationDlqAlarm', {
      metric: materializationDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Candidate materialization DLQ has messages',
    });

    new cloudwatch.Alarm(this, 'WorkerRerankDlqAlarm', {
      metric: rerankDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Worker rerank DLQ has messages',
    });

    new cloudwatch.Alarm(this, 'EmployerCandidateRerankDlqAlarm', {
      metric: employerCandidateRerankDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Employer candidate rerank DLQ has messages',
    });
  }
}
