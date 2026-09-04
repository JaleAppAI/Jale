import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';

describe('LegalStack', () => {
  let template: Template;
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
    const legal = new LegalStack(app, 'TestLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });
    template = Template.fromStack(legal);
    apiTemplate = Template.fromStack(api);
  });

  // ── One legal-document mechanism (sprint 24 D-legal) ──────────────────────
  //
  // This stack used to create `jale-legal-docs-<account>` and grant get-tos
  // read on it so the Lambda could presign `tos.md` and `privacy-policy.md`.
  // Nothing ever uploaded either key: the bucket was EMPTY in production, so
  // signup handed users a valid presigned URL to a missing object and rendered
  // S3's `NoSuchKey` XML where the terms of service belonged. The documents
  // people actually read are the PDFs behind the Next.js `/legal/terms` and
  // `/legal/privacy` routes — already the URLs in the emails and the WhatsApp
  // flow — so the S3 path is deleted rather than populated.

  test('owns no S3 bucket — the empty legal-docs bucket is gone, not merely unused', () => {
    template.resourceCountIs('AWS::S3::Bucket', 0);
    // The auto-delete custom resource and its singleton Lambda went with it.
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  test('get-tos Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Returns the ToS and privacy policy document URLs',
    });
  });

  test('get-tos is handed the frontend origin and no bucket name', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: 'Returns the ToS and privacy policy document URLs' },
    });
    expect(Object.keys(functions)).toHaveLength(1);
    const variables = (Object.values(functions)[0] as any).Properties.Environment.Variables;

    expect(variables.FRONTEND_BASE_URL).toBe('https://jaleapp.ai');
    expect(variables.REQUIRED_TOS_VERSION).toBe('1.0');
    expect(variables.LEGAL_BUCKET_NAME).toBeUndefined();
  });

  test('FRONTEND_BASE_URL follows the allowedOrigin context, not a hardcoded domain', () => {
    const app = new cdk.App({
      context: { otpSmsFromNumber: '+13252210992', allowedOrigin: 'https://dev.jaleapp.ai' },
    });
    const network = new NetworkStack(app, 'OriginNetworkStack');
    const database = new DatabaseStack(app, 'OriginDatabaseStack', { network });
    const auth = new AuthStack(app, 'OriginAuthStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
    });
    const ai = new AiStack(app, 'OriginAiStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      aiDbSecret: database.aiDbSecret,
      alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-ai-alarms-test',
    });
    const api = new ApiStack(app, 'OriginApiStack', {
      workerPool: auth.workerPool,
      employerPool: auth.employerPool,
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      aliasGeneratorFn: ai.aliasGeneratorFn.function,
      whatsappStatusCallbackUrl: 'https://api.example.com/whatsapp/status-callback',
    });
    const legal = new LegalStack(app, 'OriginLegalStack', {
      vpc: network.vpc,
      privateSubnets: network.privateSubnets,
      lambdaSg: network.lambdaSg,
      dbSecret: database.dbSecret,
      api: api.api,
      dualAuthorizer: api.dualAuthorizer,
    });

    Template.fromStack(legal).hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Returns the ToS and privacy policy document URLs',
      Environment: Match.objectLike({
        Variables: Match.objectLike({ FRONTEND_BASE_URL: 'https://dev.jaleapp.ai' }),
      }),
    });
  });

  test('nothing in the stack grants S3 read on a legal-docs bucket any more', () => {
    // The grant is the thing that made the dead mechanism look alive: as long
    // as an IAM policy referenced the bucket, deleting it looked risky.
    expect(JSON.stringify(template.toJSON())).not.toContain('jale-legal-docs');
    expect(JSON.stringify(template.toJSON())).not.toContain('s3:GetObject');
  });

  test('accept-tos Lambda function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'Records user acceptance of ToS and privacy policy',
    });
  });

  test('defaults legal Lambda origin to production domain', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          ALLOWED_ORIGIN: 'https://jaleapp.ai',
        }),
      }),
    });
  });

  // The /legal/accept method is added to ApiStack's API, so the Method resource
  // lives in ApiStack's template, not LegalStack's. Verify via the API template.
  test('POST /legal/accept is protected by Cognito authorizer (via ApiStack)', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
    });
  });
});
