import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

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
}

export class MatchingStack extends cdk.Stack implements MatchingStackOutputs {
  readonly candidateMaterializationQueue: sqs.IQueue;
  readonly workerRerankQueue: sqs.IQueue;

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
  }
}
