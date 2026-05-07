import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface VoiceTranscriptionPipelineProps {
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly mediaBucket: s3.IBucket;
  /** Lambda invoked with { status, executionContext } on COMPLETED or FAILED. */
  readonly completionHandler: lambda.IFunction;
  readonly pollIntervalSec?: number;
}

export class VoiceTranscriptionPipeline extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: VoiceTranscriptionPipelineProps) {
    super(scope, id);

    const pollSec = props.pollIntervalSec ?? 10;

    const startTranscribeJob = new tasks.CallAwsService(this, 'StartTranscribeJob', {
      service: 'transcribe',
      action: 'startTranscriptionJob',
      parameters: {
        TranscriptionJobName: sfn.JsonPath.stringAt('$.transcriptionJobName'),
        LanguageCode: sfn.JsonPath.stringAt('$.languageCode'),
        Media: { MediaFileUri: sfn.JsonPath.stringAt('$.mediaS3Uri') },
        OutputBucketName: sfn.JsonPath.stringAt('$.mediaBucketName'),
        OutputKey: sfn.JsonPath.stringAt('$.transcriptOutputKey'),
      },
      iamResources: ['*'],
      resultPath: sfn.JsonPath.DISCARD,
    });

    const waitForTranscribe = new sfn.Wait(this, 'WaitForTranscribe', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(pollSec)),
    });

    const getTranscribeJob = new tasks.CallAwsService(this, 'GetTranscribeJob', {
      service: 'transcribe',
      action: 'getTranscriptionJob',
      parameters: {
        TranscriptionJobName: sfn.JsonPath.stringAt('$.transcriptionJobName'),
      },
      iamResources: ['*'],
      resultPath: '$.transcribeStatus',
    });

    const invokeOnCompleted = new tasks.LambdaInvoke(this, 'InvokeOnCompleted', {
      lambdaFunction: props.completionHandler,
      payload: sfn.TaskInput.fromObject({
        status: 'COMPLETED',
        executionContext: sfn.TaskInput.fromJsonPathAt('$').value,
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const invokeOnFailed = new tasks.LambdaInvoke(this, 'InvokeOnFailed', {
      lambdaFunction: props.completionHandler,
      payload: sfn.TaskInput.fromObject({
        status: 'FAILED',
        executionContext: sfn.TaskInput.fromJsonPathAt('$').value,
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const checkStatus = new sfn.Choice(this, 'CheckTranscribeStatus')
      .when(
        sfn.Condition.stringEquals(
          '$.transcribeStatus.TranscriptionJob.TranscriptionJobStatus',
          'COMPLETED',
        ),
        invokeOnCompleted,
      )
      .when(
        sfn.Condition.stringEquals(
          '$.transcribeStatus.TranscriptionJob.TranscriptionJobStatus',
          'FAILED',
        ),
        invokeOnFailed,
      )
      .otherwise(waitForTranscribe);

    const definition = startTranscribeJob
      .next(waitForTranscribe)
      .next(getTranscribeJob)
      .next(checkStatus);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(15),
    });

    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'transcribe:StartTranscriptionJob',
          'transcribe:GetTranscriptionJob',
        ],
        resources: ['*'],
      }),
    );

    props.mediaBucket.grantReadWrite(this.stateMachine);
    props.mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('transcribe.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${props.mediaBucket.bucketArn}/*`],
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
        },
      }),
    );
  }
}
