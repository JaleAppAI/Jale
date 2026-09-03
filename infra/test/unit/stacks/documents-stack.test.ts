import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { DocumentsStack } from '../../../lib/stacks/documents-stack';

describe('DocumentsStack', () => {
  let template: Template;
  // API methods added by DocumentsStack are synthesized into the ApiStack template
  // because the RestApi construct lives there. Capture it separately for route assertions.
  let apiTemplate: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: { otpSmsFromNumber: '+13252210992' },
    });
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', {
      network,
    });
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    const ai = new AiStack(app, 'TestAiStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });
    const documents = new DocumentsStack(app, 'TestDocumentsStack', {
      network,
      api,
      dbSecret: database.dbSecret,
      allowedOrigin: 'https://jaleapp.ai',
      requiredTosVersion: 'v1.0',
    });
    template = Template.fromStack(documents);
    apiTemplate = Template.fromStack(api);
  });

  it('creates an S3 bucket with KMS encryption and versioning', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' },
          },
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('creates a KMS key with rotation enabled', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('creates exactly 12 Lambda functions (5 live + 7 retained for phase 1)', () => {
    // PHASE 1 count. Phase 2 drops the seven retained legacy Lambdas and this
    // becomes 5. They are unrouted here and exist only to keep their
    // cross-stack ARN exports alive for one deploy -- see the block in
    // documents-stack.ts for why deleting them in the same deploy that
    // repoints the routes would fail the changeset.
    //
    // The five that actually serve traffic: the route consolidation collapsed
    // seven Lambdas into two dispatchers and moved one pair out of this stack
    // entirely:
    //   workerDocumentsDispatch  <- uploadUrl + confirm + submit
    //                               (POST /worker/documents/{action})
    //   workerVaultDispatch      <- uploadUrlAuth + confirmAuth
    //                               (POST /worker/vault/{doc_type})
    //   workerProfile + workerDocs -> MediaBoardStack's EmployerWorkerDetail,
    //     which is where the third delegate (posts) already was and the only
    //     stack that can grant both buckets without a cycle.
    // Unmerged and still their own Lambdas: uploadToken, documentsList and
    // docDelete (whose grantDelete must not join a dispatcher's union).
    template.resourceCountIs('AWS::Lambda::Function', 12);
    for (const description of [
      'worker-documents-dispatch',
      'worker-vault-dispatch',
      'employer-upload-token',
      'worker-documents-list',
      'worker-doc-delete',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { Description: description });
    }
    // Retained, unrouted, byte-for-byte as before the consolidation.
    for (const description of [
      'worker-doc-upload-url',
      'worker-doc-confirm',
      'worker-doc-submit',
      'employer-worker-profile',
      'employer-worker-docs',
      'worker-doc-upload-url-auth',
      'worker-doc-confirm-auth',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { Description: description });
    }
  });

  it('the worker-documents dispatcher has the DOCUMENTS_BUCKET env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ DOCUMENTS_BUCKET: Match.anyValue() }),
      },
      Description: 'worker-documents-dispatch',
    });
  });

  it('creates S3 bucket CORS configuration allowing PUT', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ['PUT'],
            AllowedOrigins: ['https://jaleapp.ai'],
          }),
        ],
      },
    });
  });

  it('creates lifecycle rule transitioning to IA after 90 days', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            Transitions: [Match.objectLike({ StorageClass: 'STANDARD_IA' })],
          }),
        ],
      },
    });
  });

  // Task 12 — vault route assertions
  // Note: AWS::ApiGateway::Method resources are synthesized into the ApiStack template
  // (the RestApi construct lives there); apiTemplate is used for these assertions.
  // Methods on the {doc_type} node, by logical id. `hasResourceProperties`
  // alone proves only that SOME method in the whole API has that verb and
  // authorizer, which after the consolidation is far too weak: the POST and
  // the DELETE now share one resource, and the assertion has to distinguish
  // them.
  function vaultDocTypeMethods(): Record<string, any> {
    const resources = apiTemplate.toJSON().Resources as Record<string, any>;
    return Object.fromEntries(
      Object.entries(resources)
        .filter(([id, resource]: [string, any]) =>
          resource.Type === 'AWS::ApiGateway::Method' && /workervaultdoctype/i.test(id))
        .map(([, resource]: [string, any]) => [resource.Properties.HttpMethod, resource.Properties]),
    );
  }

  it('POST /worker/vault/{doc_type} (the upload-url|confirm dispatcher) is protected by WorkerAuthorizer', () => {
    // POST /worker/vault/upload-url and /worker/vault/confirm resolve here now
    // that their literal resources are gone — same URLs, same authorizer.
    const post = vaultDocTypeMethods().POST;
    expect(post).toBeDefined();
    expect(post.AuthorizationType).toBe('COGNITO_USER_POOLS');
    expect(post.AuthorizerId.Ref).toMatch(/WorkerAuthorizer/);
  });

  it('has no literal upload-url or confirm resource under /worker/vault', () => {
    const resources = apiTemplate.toJSON().Resources as Record<string, any>;
    const strays = Object.keys(resources).filter(
      (id) => /workervault(uploadurl|confirm)/i.test(id) && resources[id].Type === 'AWS::ApiGateway::Resource',
    );
    expect(strays).toEqual([]);
  });

  it('GET /worker/vault is protected by WorkerAuthorizer', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  it('DELETE /worker/vault/{doc_type} is protected by WorkerAuthorizer and shares the resource with POST', () => {
    const methods = vaultDocTypeMethods();
    // The DELETE keeps its own method and its own Lambda; adding the POST
    // beside it must not have disturbed it.
    expect(methods.DELETE).toBeDefined();
    expect(methods.DELETE.AuthorizationType).toBe('COGNITO_USER_POOLS');
    expect(methods.DELETE.AuthorizerId.Ref).toMatch(/WorkerAuthorizer/);
    expect(Object.keys(methods).sort()).toEqual(['DELETE', 'OPTIONS', 'POST']);
  });

  it('has no literal resource left under /worker/documents — one {action} node serves all three', () => {
    const resources = apiTemplate.toJSON().Resources as Record<string, any>;
    const children = Object.keys(resources).filter(
      (id) => resources[id].Type === 'AWS::ApiGateway::Resource' && /workerdocuments/i.test(id),
    );
    // Exactly two: /worker/documents itself and its {action} child.
    expect(children).toHaveLength(2);
    expect(children.some((id) => /workerdocumentsaction/i.test(id))).toBe(true);
  });

  it('POST /worker/documents/{action} has NO authorizer (tokenized flow)', () => {
    const resources = apiTemplate.toJSON().Resources as Record<string, any>;
    const [, method] = Object.entries(resources).find(
      ([id, resource]: [string, any]) =>
        resource.Type === 'AWS::ApiGateway::Method' &&
        /workerdocumentsaction/i.test(id) &&
        resource.Properties.HttpMethod === 'POST',
    )!;
    expect((method as any).Properties.AuthorizationType).toBe('NONE');
    expect((method as any).Properties.AuthorizerId).toBeUndefined();
  });

  it('worker-documents-list Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'worker-documents-list',
    });
  });

  // Asserted per role, never against several roles' policies merged together.
  // An earlier revision filtered on Roles containing 'WorkerDocConfirm' --
  // which also matches 'WorkerDocConfirmAuth' -- and then searched the combined
  // JSON, so the token-based Lambda's grant satisfied the assertion while
  // WorkerDocConfirmAuth in fact had no S3 permissions at all: every
  // authenticated confirm returned uploaded_object_not_found.
  //
  // The consolidation makes that failure mode WORSE, not better, which is why
  // these assertions were retargeted rather than deleted. Each dispatcher's
  // role is now the UNION of its delegates' grants, so a single missing grant
  // breaks one action out of two or three while the others keep working --
  // put for upload-url, read (HeadObject, plus the kms:Decrypt grantRead
  // carries) for confirm. Both halves of each union are asserted below.
  function s3ActionsForRole(roleFragment: string): string[] {
    return Object.values(template.toJSON().Resources)
      .filter((resource: any) => resource.Type === 'AWS::IAM::Policy')
      .filter((resource: any) => {
        // Exact-ish match: 'WorkerDocConfirmFunctionServiceRole' must not be
        // satisfied by 'WorkerDocConfirmAuthFunctionServiceRole' or vice versa.
        const roles = JSON.stringify(resource.Properties.Roles);
        return roles.includes(`${roleFragment}FunctionServiceRole`);
      })
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement)
      .flatMap((statement: any) => [].concat(statement.Action ?? []))
      .filter((action: any) => typeof action === 'string' && action.startsWith('s3:'));
  }

  it('the worker-documents dispatcher holds BOTH halves of its union (put + read)', () => {
    const actions = s3ActionsForRole('WorkerDocumentsDispatch');
    // upload-url presigns a PUT; confirm HeadObjects the uploaded key.
    expect(actions).toContain('s3:PutObject');
    expect(actions).toContain('s3:GetObject*');
    // submit needs no bucket access, and nothing in this union may delete.
    expect(actions).not.toContain('s3:DeleteObject*');
  });

  it('the worker-vault dispatcher holds BOTH halves of its union (put + read)', () => {
    // Regression guard: without the read half the browser PUT succeeds and
    // the confirm call returns 400 uploaded_object_not_found forever.
    const actions = s3ActionsForRole('WorkerVaultDispatch');
    expect(actions).toContain('s3:PutObject');
    expect(actions).toContain('s3:GetObject*');
    // worker-doc-delete stays a SEPARATE Lambda precisely so the vault
    // upload/confirm path never gets grantDelete folded into it.
    expect(actions).not.toContain('s3:DeleteObject*');
  });

  it('keeps grantDelete on the delete Lambda alone', () => {
    expect(s3ActionsForRole('WorkerDocDelete')).toContain('s3:DeleteObject*');
  });

  it('worker-doc-delete Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'worker-doc-delete',
    });
  });
});
