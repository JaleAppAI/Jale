import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';
import { ApiStack } from './api-stack';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface DocumentsStackProps extends cdk.StackProps {
  readonly network: NetworkStack;
  readonly api: ApiStack;
  readonly dbSecret: secretsmanager.ISecret;
  readonly allowedOrigin: string;
  readonly requiredTosVersion: string;
}

export class DocumentsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DocumentsStackProps) {
    super(scope, id, props);

    const docsKey = new kms.Key(this, 'DocsKey', {
      enableKeyRotation: true,
      description: 'KMS key for Jale worker documents',
    });

    const docsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `jale-worker-documents-${this.account}`,
      encryptionKey: docsKey,
      encryption: s3.BucketEncryption.KMS,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [props.allowedOrigin],
          allowedHeaders: ['*'],
        },
      ],
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    const commonEnv = {
      DB_SECRET_ARN: props.dbSecret.secretArn,
      ALLOWED_ORIGIN: props.allowedOrigin,
      REQUIRED_TOS_VERSION: props.requiredTosVersion,
      DOCUMENTS_BUCKET: docsBucket.bucketName,
      FRONTEND_BASE_URL: props.allowedOrigin,
    };

    const lambdaProps = {
      vpc: props.network.vpc,
      securityGroups: [props.network.lambdaSg],
    };

    // Worker-facing Lambdas (no Cognito auth)
    const uploadUrlFn = new JaleLambdaFunction(this, 'WorkerDocUploadUrl', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-upload-url.ts'),
      description: 'worker-doc-upload-url',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });

    const confirmFn = new JaleLambdaFunction(this, 'WorkerDocConfirm', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-confirm.ts'),
      description: 'worker-doc-confirm',
      environment: commonEnv,
      ...lambdaProps,
    });

    const submitFn = new JaleLambdaFunction(this, 'WorkerDocSubmit', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-submit.ts'),
      description: 'worker-doc-submit',
      environment: commonEnv,
      ...lambdaProps,
    });

    // Employer-facing Lambdas (Cognito auth)
    const workerProfileFn = new JaleLambdaFunction(this, 'EmployerWorkerProfile', {
      entry: path.join(__dirname, '../../lambda/api/employer-worker-profile.ts'),
      description: 'employer-worker-profile',
      environment: commonEnv,
      ...lambdaProps,
    });

    const workerDocsFn = new JaleLambdaFunction(this, 'EmployerWorkerDocs', {
      entry: path.join(__dirname, '../../lambda/api/employer-worker-docs.ts'),
      description: 'employer-worker-docs',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });

    const uploadTokenFn = new JaleLambdaFunction(this, 'EmployerUploadToken', {
      entry: path.join(__dirname, '../../lambda/api/employer-upload-token.ts'),
      description: 'employer-upload-token',
      environment: commonEnv,
      ...lambdaProps,
    });

    // Grant S3 + KMS permissions
    docsBucket.grantPut(uploadUrlFn.function); // kms:GenerateDataKey
    docsBucket.grantRead(workerDocsFn.function); // kms:Decrypt
    props.dbSecret.grantRead(uploadUrlFn.function);
    props.dbSecret.grantRead(confirmFn.function);
    props.dbSecret.grantRead(submitFn.function);
    props.dbSecret.grantRead(workerProfileFn.function);
    props.dbSecret.grantRead(workerDocsFn.function);
    props.dbSecret.grantRead(uploadTokenFn.function);

    // Wire API Gateway routes
    const restApi = props.api.api;
    const employerAuth = props.api.employerAuthorizer;

    // Worker routes (no auth). /worker already exists from ApiStack.
    const workerDocs = restApi.root.getResource('worker')!.addResource('documents');
    workerDocs
      .addResource('upload-url')
      .addMethod('POST', new apigateway.LambdaIntegration(uploadUrlFn.function));
    workerDocs
      .addResource('confirm')
      .addMethod('POST', new apigateway.LambdaIntegration(confirmFn.function));
    workerDocs
      .addResource('submit')
      .addMethod('POST', new apigateway.LambdaIntegration(submitFn.function));

    // Employer routes (Cognito auth). /employer already exists from ApiStack.
    const employerRoot = restApi.root.getResource('employer')!;
    const employerWorkers = employerRoot.addResource('workers');
    const workerById = employerWorkers.addResource('{worker_id}');
    workerById
      .addResource('profile')
      .addMethod('GET', new apigateway.LambdaIntegration(workerProfileFn.function), {
        authorizer: employerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
    workerById
      .addResource('documents')
      .addMethod('GET', new apigateway.LambdaIntegration(workerDocsFn.function), {
        authorizer: employerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    employerRoot
      .addResource('upload-tokens')
      .addMethod('POST', new apigateway.LambdaIntegration(uploadTokenFn.function), {
        authorizer: employerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
  }
}
