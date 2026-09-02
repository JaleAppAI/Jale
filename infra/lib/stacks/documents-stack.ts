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
import { lambdaIntegration, addPathOnlyResource } from '../api-integration';

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

    // Worker-facing dispatcher (no Cognito auth) — ONE Lambda behind
    // `POST /worker/documents/{action}`, delegating to worker-doc-upload-url,
    // worker-doc-confirm and worker-doc-submit. Those three modules and their
    // tests are unchanged; what went away is their three literal API Gateway
    // resources (12 CloudFormation resources in ApiStack, now 4). See
    // `lambda/api/worker-documents-dispatch.ts` and `lambda/lib/
    // path-dispatch.ts`. Environment is the union of the three, which is
    // `commonEnv` — all three read exactly that.
    const workerDocumentsDispatchFn = new JaleLambdaFunction(this, 'WorkerDocumentsDispatch', {
      entry: path.join(__dirname, '../../lambda/api/worker-documents-dispatch.ts'),
      description: 'worker-documents-dispatch',
      environment: commonEnv,
      // From the upload-url delegate; the other two bundle no extra SDK.
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });

    // ── PHASE 1 ONLY: the seven Lambdas the dispatchers above replace ──────
    //
    // Nothing routes to these any more — every URL they used to serve now
    // lands on `WorkerDocumentsDispatch`, `WorkerVaultDispatch` or
    // MediaBoardStack's `EmployerWorkerDetail`. They are retained for exactly
    // one deploy, unchanged down to their logical ids, grants and env, for a
    // CloudFormation reason and no other.
    //
    // WHY: JaleApiStack's Methods integrate with these functions by ARN, which
    // CDK publishes as an automatic cross-stack export from THIS stack
    // (`ExportsOutputFnGetAtt<Id>Arn<hash>`). JaleApiStack depends on
    // DocumentsStack, so CDK updates DocumentsStack FIRST — and CloudFormation
    // refuses to delete an export while any stack still imports it:
    //
    //   Export JaleDocumentsStack:ExportsOutputFnGetAtt...Arn... cannot be
    //   deleted as it is in use by JaleApiStack
    //
    // Deleting the functions in the same deploy that repoints the routes would
    // therefore fail the DocumentsStack update and roll the release back. So
    // phase 1 lands the dispatchers and drops ApiStack's imports while the
    // exports stay alive (see `exportValue` below), and phase 2 — the next
    // commit — deletes these seven and their exports, which is safe once no
    // deployed template imports them.
    //
    // They cost JaleApiStack NOTHING: with no Method pointing at them there is
    // no Lambda::Permission either, so the 500-resource ceiling this whole
    // change is about is unaffected (the ceiling test still measures 391).
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

    const workerDocUploadUrlAuthFn = new JaleLambdaFunction(this, 'WorkerDocUploadUrlAuth', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-upload-url-auth.ts'),
      description: 'worker-doc-upload-url-auth',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
      ...lambdaProps,
    });

    const workerDocConfirmAuthFn = new JaleLambdaFunction(this, 'WorkerDocConfirmAuth', {
      entry: path.join(__dirname, '../../lambda/api/worker-doc-confirm-auth.ts'),
      description: 'worker-doc-confirm-auth',
      environment: commonEnv,
      ...lambdaProps,
    });

    // Holds the seven `ExportsOutputFnGetAtt<Id>Arn<hash>` Outputs alive with
    // their EXACT auto-generated export names. `Stack.exportValue()` exists
    // for precisely this migration: it runs the same name generator CDK used
    // when the reference was automatic, so the Output survives the removal of
    // the reference that created it. Phase 2 deletes these calls with the
    // functions. `api-stack-resource-ceiling.test.ts` asserts all ten names
    // (these seven plus MediaBoardStack's two and ReferralsStack's one) are
    // present AND that no JaleApiStack Fn::ImportValue still names them.
    const legacyFns = [
      uploadUrlFn,
      confirmFn,
      submitFn,
      workerProfileFn,
      workerDocsFn,
      workerDocUploadUrlAuthFn,
      workerDocConfirmAuthFn,
    ];
    for (const legacyFn of legacyFns) {
      this.exportValue(legacyFn.function.functionArn);
    }

    // Grants, unchanged from before the consolidation, so these functions and
    // their roles are a no-op in the phase 1 changeset.
    docsBucket.grantPut(uploadUrlFn.function); // kms:GenerateDataKey
    docsBucket.grantRead(confirmFn.function); // HeadObject verification
    docsBucket.grantRead(workerDocsFn.function); // kms:Decrypt
    docsBucket.grantPut(workerDocUploadUrlAuthFn.function); // PUT presigned URL generation
    docsBucket.grantRead(workerDocConfirmAuthFn.function); // HeadObject verification
    for (const legacyFn of legacyFns) {
      props.dbSecret.grantRead(legacyFn.function);
    }
    // ── end phase 1 retention ──────────────────────────────────────────────

    const uploadTokenFn = new JaleLambdaFunction(this, 'EmployerUploadToken', {
      entry: path.join(__dirname, '../../lambda/api/employer-upload-token.ts'),
      description: 'employer-upload-token',
      environment: commonEnv,
      ...lambdaProps,
    });

    // Authenticated vault dispatcher — worker auth, ONE Lambda behind
    // `POST /worker/vault/{doc_type}`, delegating to
    // worker-doc-upload-url-auth (`{doc_type} = 'upload-url'`) and
    // worker-doc-confirm-auth (`'confirm'`). It hangs off the resource that
    // already served `DELETE /worker/vault/{doc_type}`, so it costs a Method +
    // Permission and no Resource/OPTIONS, and the two literal siblings it
    // replaces are gone. See `lambda/api/worker-vault-dispatch.ts`.
    //
    // BOTH S3 grants below are required and neither is optional:
    //   - grantPut, for the upload-url delegate's presigned PUT.
    //   - grantRead, because the confirm delegate HeadObjects the uploaded key
    //     to verify content type, encryption and non-zero length before
    //     recording the row (grantRead also supplies the kms:Decrypt that
    //     HeadObject needs on an SSE-KMS object). The comment on the old
    //     WorkerDocConfirmAuth Lambda once read "DB access only", which is how
    //     a missing grantRead went unnoticed and turned every confirm into
    //     `uploaded_object_not_found` — an upload that succeeds in S3 and can
    //     never be confirmed. `documents-stack.test.ts` asserts both actions
    //     on this one role now that the two Lambdas are one.
    const workerVaultDispatchFn = new JaleLambdaFunction(this, 'WorkerVaultDispatch', {
      entry: path.join(__dirname, '../../lambda/api/worker-vault-dispatch.ts'),
      description: 'worker-vault-dispatch',
      environment: commonEnv,
      nodeModules: ['@aws-sdk/s3-request-presigner'],
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

    // Grant S3 + KMS permissions.
    //
    // A dispatcher's role carries the UNION of its delegates' grants — that is
    // the price of collapsing N routes onto one Lambda, so each union is
    // spelled out per delegate below and asserted per role in
    // `documents-stack.test.ts`. Note what is NOT in a union: workerDocDelete
    // keeps its own Lambda, so `grantDelete` is never handed to an
    // upload/confirm path.
    docsBucket.grantPut(workerDocumentsDispatchFn.function); // upload-url: kms:GenerateDataKey
    docsBucket.grantRead(workerDocumentsDispatchFn.function); // confirm: HeadObject verification
    props.dbSecret.grantRead(workerDocumentsDispatchFn.function); // all three delegates
    props.dbSecret.grantRead(uploadTokenFn.function);

    // Authenticated worker doc Lambda permissions
    docsBucket.grantPut(workerVaultDispatchFn.function); // upload-url-auth: PUT presigned URL
    docsBucket.grantRead(workerVaultDispatchFn.function); // confirm-auth: HeadObject verification
    props.dbSecret.grantRead(workerVaultDispatchFn.function);
    docsBucket.grantRead(workerDocumentsListFn.function); // GET presigned URL generation
    docsBucket.grantDelete(workerDocDeleteFn.function); // DELETE object
    props.dbSecret.grantRead(workerDocumentsListFn.function);
    props.dbSecret.grantRead(workerDocDeleteFn.function);

    // Wire API Gateway routes
    const restApi = props.api.api;
    const employerAuth = props.api.employerAuthorizer;
    const workerAuth = props.api.workerAuthorizer;

    // Worker document routes (unauthenticated tokenized flow). /worker already exists from ApiStack.
    const workerResource = restApi.root.getResource('worker')!;
    // Path-only: nothing on /worker/documents itself, only the {action} POST.
    const workerDocs = addPathOnlyResource(workerResource, 'documents');

    // POST /worker/documents/{action} — no auth (employer-shared-link /
    // pre-account tokenized flow). {action} is `upload-url`, `confirm` or
    // `submit`; anything else 404s in the dispatcher. The three deployed URLs
    // are byte-identical to the three literal resources this replaces —
    // API Gateway only prefers a literal child when one exists, and none does
    // any more.
    workerDocs
      .addResource('{action}')
      .addMethod('POST', lambdaIntegration(workerDocumentsDispatchFn.function));

    // Authenticated vault routes under /worker/vault (no path collision with tokenized flow)
    const workerVault = workerResource.addResource('vault');

    // GET /worker/vault — worker auth (list own docs with presigned GET URLs)
    workerVault.addMethod('GET', lambdaIntegration(workerDocumentsListFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /worker/vault/{doc_type} — worker auth, TWO methods on ONE resource.
    //
    // DELETE takes a real doc type. POST is the dispatcher for what used to be
    // the literal `/worker/vault/upload-url` and `/worker/vault/confirm`
    // siblings: API Gateway forbids a second variable child under
    // /worker/vault, so the actions ride in the `{doc_type}` slot rather than
    // in a new `{action}` node — which is also why this consolidation costs
    // no Resource and no OPTIONS, and why the DELETE method's logical id (and
    // therefore the live delete route) is untouched.
    const workerVaultDocType = workerVault.addResource('{doc_type}');
    workerVaultDocType.addMethod('DELETE', lambdaIntegration(workerDocDeleteFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    workerVaultDocType.addMethod('POST', lambdaIntegration(workerVaultDispatchFn.function), {
      authorizer: workerAuth,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Employer routes (Cognito auth). /employer already exists from ApiStack.
    const employerRoot = restApi.root.getResource('employer')!;
    // Path-only: nothing on /employer/workers itself, only under {worker_id}.
    const employerWorkers = addPathOnlyResource(employerRoot, 'workers');
    // Path-only: nothing on {worker_id} itself. Its single child — the
    // `{action}` node serving GET /profile, /documents and /posts — is added
    // by MediaBoardStack, which is the only stack that can hold all three
    // delegates' grants without closing a DocumentsStack <-> WhatsAppStack
    // cycle (the media bucket is WhatsAppStack's, and WhatsAppStack already
    // consumes `this.bucket`). See `lambda/api/employer-worker-detail.ts`.
    // These two nodes stay here, unmoved: MediaBoardStack getResource()s them
    // and app-composition.ts already builds DocumentsStack first.
    addPathOnlyResource(employerWorkers, '{worker_id}');

    employerRoot
      .addResource('upload-tokens')
      .addMethod('POST', lambdaIntegration(uploadTokenFn.function), {
        authorizer: employerAuth,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
  }
}
