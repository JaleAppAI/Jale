import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
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
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
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

  it('creates exactly 10 Lambda functions', () => {
    // 6 original (uploadUrl, confirm, submit, workerProfile, workerDocs, uploadToken)
    // + 4 authenticated vault Lambdas (uploadUrlAuth, confirmAuth, documentsList, docDelete)
    template.resourceCountIs('AWS::Lambda::Function', 10);
  });

  it('worker-doc-upload-url Lambda has DOCUMENTS_BUCKET env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ DOCUMENTS_BUCKET: Match.anyValue() }),
      },
      Description: Match.stringLikeRegexp('worker-doc-upload-url'),
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
  it('POST /worker/vault/upload-url is protected by WorkerAuthorizer', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
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

  it('DELETE /worker/vault/{doc_type} is protected by WorkerAuthorizer', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'DELETE',
      AuthorizationType: 'COGNITO_USER_POOLS',
      AuthorizerId: Match.objectLike({
        Ref: Match.stringLikeRegexp('WorkerAuthorizer'),
      }),
    });
  });

  it('worker-doc-upload-url-auth Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'worker-doc-upload-url-auth',
    });
  });

  it('worker-documents-list Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'worker-documents-list',
    });
  });

  // Asserted per role, not against every WorkerDocConfirm* policy merged
  // together. The previous revision filtered on Roles containing
  // 'WorkerDocConfirm' -- which also matches 'WorkerDocConfirmAuth' -- and then
  // searched the combined JSON, so the token-based Lambda's grant satisfied the
  // assertion while WorkerDocConfirmAuth in fact had no S3 permissions at all.
  // Both confirm handlers call HeadObject and both need the grant.
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

  it('worker-doc-confirm Lambda can read S3 objects for HeadObject verification', () => {
    expect(s3ActionsForRole('WorkerDocConfirm')).toContain('s3:GetObject*');
  });

  it('worker-doc-confirm-auth Lambda can read S3 objects for HeadObject verification', () => {
    // Regression guard: without this grant the browser PUT succeeds and the
    // confirm call returns 400 uploaded_object_not_found forever.
    expect(s3ActionsForRole('WorkerDocConfirmAuth')).toContain('s3:GetObject*');
  });

  it('worker-doc-delete Lambda exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'worker-doc-delete',
    });
  });
});
