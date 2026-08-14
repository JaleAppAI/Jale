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
  /**
   * Name of an operator-created es-US custom vocabulary (see
   * infra/scripts/transcribe/create-vocabulary.sh). Optional so stacks can
   * deploy before the vocabulary exists in the target account/region — when
   * unset, LanguageIdSettings is omitted entirely rather than referencing a
   * vocabulary name that doesn't exist yet (which would fail every job at
   * StartTranscriptionJob time).
   */
  readonly esVocabularyName?: string;
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
        // Language is now identified per-job rather than hardcoded from the
        // chat's language setting (which produced garbage transcripts for
        // Spanish audio in an English-set conversation and never handled
        // code-switching). es-US (not es-MX) is deliberate: es-MX is not on
        // AWS's documented multi-language-identification support list and
        // silently falls back to a different Spanish dialect, dropping any
        // es-MX vocabulary with no error. All values here are deploy-time
        // static (baked into the ASL at synth) — they never vary per
        // message, so no execution-input field carries them.
        IdentifyMultipleLanguages: true,
        LanguageOptions: ['es-US', 'en-US'],
        ...(props.esVocabularyName
          ? { LanguageIdSettings: { 'es-US': { VocabularyName: props.esVocabularyName } } }
          : {}),
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

    // executionArn ($$.Execution.Id) is threaded as a top-level sibling of
    // executionContext (not merged into it) — this construct is shared by
    // both the trust and profile-intake pipelines, and only the latter's v2
    // completion branch (ai-profile-writer.ts) reads it, to embed a
    // deterministic staleness anchor in the outbound ProfileIntakeVoiceEventV2
    // (see onboarding/steps/voice.ts's handleVoiceIntakeResult).
    const invokeOnCompleted = new tasks.LambdaInvoke(this, 'InvokeOnCompleted', {
      lambdaFunction: props.completionHandler,
      payload: sfn.TaskInput.fromObject({
        status: 'COMPLETED',
        executionContext: sfn.TaskInput.fromJsonPathAt('$').value,
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const invokeOnFailed = new tasks.LambdaInvoke(this, 'InvokeOnFailed', {
      lambdaFunction: props.completionHandler,
      payload: sfn.TaskInput.fromObject({
        status: 'FAILED',
        executionContext: sfn.TaskInput.fromJsonPathAt('$').value,
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
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
