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

  beforeAll(() => {
    const app = new cdk.App();
    const network = new NetworkStack(app, 'TestNetworkStack');
    const database = new DatabaseStack(app, 'TestDatabaseStack', {
      network,
    });
    const auth = new AuthStack(app, 'TestAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      cognitoSmsRole: network.cognitoSmsRole,
    });
    const api = new ApiStack(app, 'TestApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
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

  it('creates exactly 6 Lambda functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 6);
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
});
