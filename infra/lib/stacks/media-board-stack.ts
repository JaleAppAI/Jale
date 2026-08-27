import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { ApiStack } from './api-stack';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface MediaBoardStackProps extends cdk.StackProps {
  readonly network: NetworkStack;
  readonly api: ApiStack;
  readonly dbSecret: secretsmanager.ISecret;
  /** WhatsAppStack's jale-worker-media bucket — posts share it (spec §1). */
  readonly mediaBucket: s3.Bucket;
  readonly allowedOrigin: string;
  readonly requiredTosVersion: string;
  /**
   * I2 (final-review): same shared SNS topic AiStack/WhatsAppStack/
   * ReferralsStack consume (wired via `app.node.tryGetContext(
   * 'whatsappAlarmTopicArn')` in bin/jale-app.ts) — lets this stack's
   * moderation fail-open alarm (below) actually page someone. Optional and
   * NOT fail-closed like WhatsAppStack/AiStack: this stack had zero alarm
   * plumbing until now, and `media-board-stack.test.ts`'s synth helper
   * builds without this prop, so absence must not break existing callers —
   * it just means the create-lambda's fail-open MetricFilter/Alarm are
   * skipped (see the ReferralsStack `alarmTopicArn` prop doc for the same
   * reasoning).
   */
  readonly alarmTopicArn?: string;
}

export class MediaBoardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MediaBoardStackProps) {
    super(scope, id, props);

    const commonEnv = {
      DB_SECRET_ARN: props.dbSecret.secretArn,
      ALLOWED_ORIGIN: props.allowedOrigin,
      REQUIRED_TOS_VERSION: props.requiredTosVersion,
      MEDIA_BUCKET: props.mediaBucket.bucketName,
    };
    const lambdaProps = {
      vpc: props.network.vpc,
      securityGroups: [props.network.lambdaSg],
    };

    const uploadUrlsFn = new JaleLambdaFunction(this, 'WorkerPostUploadUrls', {
      entry: path.join(__dirname, '../../lambda/api/worker-post-upload-urls.ts'),
      description: 'worker-post-upload-urls',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });
    const createFn = new JaleLambdaFunction(this, 'WorkerPostCreate', {
      entry: path.join(__dirname, '../../lambda/api/worker-post-create.ts'),
      description: 'worker-post-create',
      environment: commonEnv,
      // C1 (final-review, critical): worker-post-create.ts imports
      // lib/moderation.ts, which imports '@aws-sdk/client-rekognition' at
      // module top level. JaleLambdaFunction's default bundling externalizes
      // ALL '@aws-sdk/*' packages (lambda-function.ts:74) on the assumption
      // the Node 20.x Lambda runtime provides them -- untrue for
      // client-rekognition (see the processor lambda's identical
      // nodeModules override in whatsapp-stack.ts, ~line 264, for the same
      // failure mode this fixes: an unresolvable require() at import time,
      // failing EVERY invocation of this lambda, not just moderation calls).
      nodeModules: ['@aws-sdk/client-rekognition'],
      ...lambdaProps,
    });
    const listFn = new JaleLambdaFunction(this, 'WorkerPostsList', {
      entry: path.join(__dirname, '../../lambda/api/worker-posts-list.ts'),
      description: 'worker-posts-list',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });
    const deleteFn = new JaleLambdaFunction(this, 'WorkerPostDelete', {
      entry: path.join(__dirname, '../../lambda/api/worker-post-delete.ts'),
      description: 'worker-post-delete',
      environment: commonEnv,
      ...lambdaProps,
    });
    const employerPostsFn = new JaleLambdaFunction(this, 'EmployerWorkerPosts', {
      entry: path.join(__dirname, '../../lambda/api/employer-worker-posts.ts'),
      description: 'employer-worker-posts',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });

    props.mediaBucket.grantPut(uploadUrlsFn.function);
    // create: HeadObject verification + Rekognition reads via caller perms
    props.mediaBucket.grantRead(createFn.function);
    createFn.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['rekognition:DetectModerationLabels'],
      resources: ['*'], // Rekognition detect APIs don't support resource scoping
    }));
    props.mediaBucket.grantRead(listFn.function);
    props.mediaBucket.grantRead(employerPostsFn.function);
    for (const fn of [uploadUrlsFn, createFn, listFn, deleteFn, employerPostsFn]) {
      props.dbSecret.grantRead(fn.function);
    }

    const restApi = props.api.api;
    const workerAuth = props.api.workerAuthorizer;
    const workerResource = restApi.root.getResource('worker')!;
    const posts = workerResource.addResource('posts');

    posts.addMethod('GET', new apigateway.LambdaIntegration(listFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    posts.addMethod('POST', new apigateway.LambdaIntegration(createFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    posts.addResource('upload-urls').addMethod('POST', new apigateway.LambdaIntegration(uploadUrlsFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    posts.addResource('{post_id}').addMethod('DELETE', new apigateway.LambdaIntegration(deleteFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // employer/workers/{worker_id} was created by DocumentsStack on the shared API.
    const workerById = restApi.root.getResource('employer')!.getResource('workers')!.getResource('{worker_id}')!;
    workerById.addResource('posts').addMethod('GET', new apigateway.LambdaIntegration(employerPostsFn.function), {
      authorizer: props.api.employerAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // ── I2 (final-review): moderation fail-open alarm ────────────
    // Mirrors WhatsAppStack's identical `WhatsAppModerationFailOpen` filter/
    // alarm (whatsapp-stack.ts) on lib/moderation.ts's plain-text
    // `console.error` fail-open log line -- this lambda (WorkerPostCreate)
    // is the OTHER caller of `moderateImage()` besides the WhatsApp
    // processor. Only wired when `alarmTopicArn` is provided (see the prop
    // doc above for why this stack doesn't fail closed like WhatsAppStack).
    // Namespace deliberately 'Jale/Moderation', NOT WhatsAppStack's
    // 'Jale/WhatsApp' -- this stack has no pre-existing custom-metric
    // namespace convention to match, and reusing 'Jale/WhatsApp' with the
    // same metric name would merge both lambdas' fail-open counts into one
    // CloudWatch metric (same namespace + metric name + no distinguishing
    // dimension = the same metric), making each alarm fire on the OTHER
    // lambda's failures too.
    if (props.alarmTopicArn) {
      const alarmTopic = sns.Topic.fromTopicArn(this, 'MediaBoardAlarmTopic', props.alarmTopicArn);
      const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
      const moderationFailOpenMetric = new logs.MetricFilter(this, 'MediaBoardModerationFailOpenMetric', {
        logGroup: createFn.logGroup,
        filterPattern: logs.FilterPattern.literal('"moderateImage service fault (fail-open)"'),
        metricNamespace: 'Jale/Moderation',
        metricName: 'ModerationFailOpen',
        metricValue: '1',
      });
      new cloudwatch.Alarm(this, 'MediaBoardModerationFailOpenAlarm', {
        alarmName: 'MediaBoardModerationFailOpen',
        metric: moderationFailOpenMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);
    }
  }
}
