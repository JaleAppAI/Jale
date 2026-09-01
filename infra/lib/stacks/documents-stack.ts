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
import { lambdaIntegration } from '../api-integration';

export interface DocumentsStackProps extends cdk.StackProps {
  readonly network: NetworkStack;
  readonly api: ApiStack;
  readonly dbSecret: secretsmanager.ISecret;
  readonly allowedOrigin: string;
  readonly requiredTosVersion: string;
}

export class DocumentsStack extends cdk.Stack {
  /** KMS key encrypting the worker documents bucket. */
  public readonly key: kms.Key;
  /** Worker documents bucket — exposed so other stacks (e.g. WhatsAppStack's
   * processor lambda) can be granted scoped access (see Task 12). */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DocumentsStackProps) {
    super(scope, id, props);

    const docsKey = new kms.Key(this, 'DocsKey', {
      enableKeyRotation: true,
      description: 'KMS key for Jale worker documents',
    });
    this.key = docsKey;

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
    this.bucket = docsBucket;

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

    // Worker doc upload URL (authenticated) — worker auth, DB + S3 write
    const workerDocUploadUrlAuthFn = new JaleLambdaFunction(this, 'WorkerDocUploadUrlAuth', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-upload-url-auth.ts'),
      description: 'worker-doc-upload-url-auth',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });

    // Worker doc confirm (authenticated) — worker auth, DB + S3 read.
    // S3 read is NOT optional: the handler HeadObjects the uploaded key to
    // verify content type, encryption and non-zero length before recording the
    // row. This comment previously read "DB access only", which is how the
    // missing grantRead below went unnoticed.
    const workerDocConfirmAuthFn = new JaleLambdaFunction(this, 'WorkerDocConfirmAuth', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-confirm-auth.ts'),
      description: 'worker-doc-confirm-auth',
      environment: commonEnv,
      ...lambdaProps,
    });

    // Worker documents list (authenticated) — worker auth, DB + S3 read
    const workerDocumentsListFn = new JaleLambdaFunction(this, 'WorkerDocumentsList', {
      entry: path.join(__dirname, '../../lambda/api/worker-documents-list.ts'),
      description: 'worker-documents-list',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });

    // Worker doc delete (authenticated) — worker auth, DB + S3 delete
    const workerDocDeleteFn = new JaleLambdaFunction(this, 'WorkerDocDelete', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-delete.ts'),
      description: 'worker-doc-delete',
      environment: commonEnv,
      ...lambdaProps,
    });

    // Grant S3 + KMS permissions
    docsBucket.grantPut(uploadUrlFn.function); // kms:GenerateDataKey
    docsBucket.grantRead(confirmFn.function); // HeadObject verification
    docsBucket.grantRead(workerDocsFn.function); // kms:Decrypt
    props.dbSecret.grantRead(uploadUrlFn.function);
    props.dbSecret.grantRead(confirmFn.function);
    props.dbSecret.grantRead(submitFn.function);
    props.dbSecret.grantRead(workerProfileFn.function);
    props.dbSecret.grantRead(workerDocsFn.function);
    props.dbSecret.grantRead(uploadTokenFn.function);

    // Authenticated worker doc Lambda permissions
    docsBucket.grantPut(workerDocUploadUrlAuthFn.function); // PUT presigned URL generation
    // HeadObject verification. Without this the confirm step cannot read back
    // the object the browser just PUT, so s3:HeadObject fails with AccessDenied
    // and the handler reports it as `uploaded_object_not_found` — an upload that
    // succeeds in S3 but can never be confirmed. grantRead also supplies the
    // kms:Decrypt that HeadObject needs on an SSE-KMS object.
    docsBucket.grantRead(workerDocConfirmAuthFn.function);
    docsBucket.grantRead(workerDocumentsListFn.function); // GET presigned URL generation
    docsBucket.grantDelete(workerDocDeleteFn.function); // DELETE object
    props.dbSecret.grantRead(workerDocUploadUrlAuthFn.function);
    props.dbSecret.grantRead(workerDocConfirmAuthFn.function);
    props.dbSecret.grantRead(workerDocumentsListFn.function);
    props.dbSecret.grantRead(workerDocDeleteFn.function);

    // Wire API Gateway routes
    const restApi = props.api.api;
    const employerAuth = props.api.employerAuthorizer;
    const workerAuth = props.api.workerAuthorizer;

    // Worker document routes (unauthenticated tokenized flow). /worker already exists from ApiStack.
    const workerResource = restApi.root.getResource('worker')!;
    const workerDocs = workerResource.addResource('documents');

    // POST /worker/documents/upload-url — no auth (employer-shared-link / pre-account tokenized flow)
    workerDocs
      .addResource('upload-url')
      .addMethod('POST', lambdaIntegration(uploadUrlFn.function));

    // POST /worker/documents/confirm — no auth (tokenized flow)
    workerDocs
      .addResource('confirm')
      .addMethod('POST', lambdaIntegration(confirmFn.function));

    // POST /worker/documents/submit — no auth (legacy WhatsApp onboarding flow)
    workerDocs
      .addResource('submit')
      .addMethod('POST', lambdaIntegration(submitFn.function));

    // Authenticated vault routes under /worker/vault (no path collision with tokenized flow)
    const workerVault = workerResource.addResource('vault');

    // POST /worker/vault/upload-url — worker auth (authenticated presigned URL)
    workerVault
      .addResource('upload-url')
      .addMethod('POST', lambdaIntegration(workerDocUploadUrlAuthFn.function), {
        authorizer: workerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // POST /worker/vault/confirm — worker auth
    workerVault
      .addResource('confirm')
      .addMethod('POST', lambdaIntegration(workerDocConfirmAuthFn.function), {
        authorizer: workerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // GET /worker/vault — worker auth (list own docs with presigned GET URLs)
    workerVault.addMethod('GET', lambdaIntegration(workerDocumentsListFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // DELETE /worker/vault/{doc_type} — worker auth
    workerVault
      .addResource('{doc_type}')
      .addMethod('DELETE', lambdaIntegration(workerDocDeleteFn.function), {
        authorizer: workerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    // Employer routes (Cognito auth). /employer already exists from ApiStack.
    const employerRoot = restApi.root.getResource('employer')!;
    const employerWorkers = employerRoot.addResource('workers');
    const workerById = employerWorkers.addResource('{worker_id}');
    workerById
      .addResource('profile')
      .addMethod('GET', lambdaIntegration(workerProfileFn.function), {
        authorizer: employerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
    workerById
      .addResource('documents')
      .addMethod('GET', lambdaIntegration(workerDocsFn.function), {
        authorizer: employerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });

    employerRoot
      .addResource('upload-tokens')
      .addMethod('POST', lambdaIntegration(uploadTokenFn.function), {
        authorizer: employerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
  }
}
