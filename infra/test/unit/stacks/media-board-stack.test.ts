import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { WhatsAppStack } from '../../../lib/stacks/whatsapp-stack';
import { DocumentsStack } from '../../../lib/stacks/documents-stack';
import { MediaBoardStack } from '../../../lib/stacks/media-board-stack';

/**
 * Builds the full stack graph MediaBoardStack depends on and returns its
 * synthesized template (plus ApiStack's, since routes live cross-stack).
 * Factored out so the I2 alarm tests below can synth a SECOND app with
 * `alarmTopicArn` set without duplicating this whole dependency chain.
 */
function buildMediaBoardApp(alarmTopicArn?: string): { template: Template; apiTemplate: Template } {
  const app = new cdk.App({
    context: { otpSmsFromNumber: '+13252210992' },
  });
  const network = new NetworkStack(app, 'TestNetworkStack');
  const database = new DatabaseStack(app, 'TestDatabaseStack', { network });
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
    whatsappStatusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
  });
  // LegalStack must be instantiated to satisfy CDK validation: the
  // DualAuthorizer is created in ApiStack but only "attached to a RestApi"
  // when a route uses it (POST /legal/accept in LegalStack). Without this,
  // Template.fromStack() fails with "must be attached to a RestApi".
  new LegalStack(app, 'TestLegalStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    api: api.api,
    dualAuthorizer: api.dualAuthorizer,
  });
  // Stand-in for DocumentsStack's KMS-encrypted bucket, same pattern as
  // whatsapp-stack.test.ts: a separate mini-stack keeps this test
  // independent of DocumentsStack's own Lambda bundling while still
  // exercising a real cross-stack construct reference.
  const docsBucketStack = new cdk.Stack(app, 'TestDocsBucketStack');
  const docsKey = new kms.Key(docsBucketStack, 'TestDocsKey');
  const docsBucket = new s3.Bucket(docsBucketStack, 'TestDocsBucket', {
    encryptionKey: docsKey,
    encryption: s3.BucketEncryption.KMS,
  });

  const whatsapp = new WhatsAppStack(app, 'TestWhatsAppStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    workerPool: auth.workerPool,
    api: api.api,
    workerResource: api.workerResource,
    workerApplicationsResource: api.workerApplicationsResource,
    workerAuthorizer: api.workerAuthorizer,
    questionGeneratorFn: ai.questionGeneratorFn.function,
    aliasGeneratorFn: ai.aliasGeneratorFn.function,
    trustAssessmentQueue: ai.trustAssessmentQueue,
    trustExtractionQueue: ai.trustExtractionQueue,
    statusCallbackUrl: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    alarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:jale-whatsapp-alarms-test',
    documentsBucket: docsBucket,
  });

  // DocumentsStack creates the shared employer/workers/{worker_id} resource
  // that MediaBoardStack's employer {action} route hangs off of — it must
  // exist on the app before MediaBoardStack synthesizes. Its bucket is also
  // MediaBoardStack's `documentsBucket`: the employer-worker-detail dispatcher
  // reads BOTH buckets, which is exactly why that dispatcher lives in
  // MediaBoardStack (DocumentsStack cannot take the media bucket without
  // closing a cycle through WhatsAppStack).
  const documents = new DocumentsStack(app, 'TestDocumentsStack', {
    network,
    api,
    dbSecret: database.dbSecret,
    allowedOrigin: 'https://jaleapp.ai',
    requiredTosVersion: 'v1.0',
  });

  const mediaBoard = new MediaBoardStack(app, 'TestMediaBoardStack', {
    network,
    api,
    dbSecret: database.dbSecret,
    mediaBucket: whatsapp.mediaBucket,
    documentsBucket: documents.bucket,
    allowedOrigin: 'https://jaleapp.ai',
    requiredTosVersion: 'v1.0',
    ...(alarmTopicArn ? { alarmTopicArn } : {}),
  });

  return {
    template: Template.fromStack(mediaBoard),
    apiTemplate: Template.fromStack(api),
  };
}

describe('MediaBoardStack', () => {
  let template: Template;
  // API Gateway resources synthesize into the ApiStack template because the
  // RestApi construct lives there (documents-stack.test.ts:13-15 pattern) —
  // route assertions must target apiTemplate, not template.
  let apiTemplate: Template;

  beforeAll(() => {
    ({ template, apiTemplate } = buildMediaBoardApp());
  });

  it('creates exactly 5 Lambda functions (posts-dispatch, create, list, delete, employer-worker-detail)', () => {
    // Still five after the L1.2 consolidation, but two of them changed job:
    // WorkerPostUploadUrls became WorkerPostsDispatch (POST
    // /worker/posts/{post_id}), and EmployerWorkerPosts became
    // EmployerWorkerDetail, which now also serves the `profile` and
    // `documents` actions that used to be two Lambdas in DocumentsStack.
    template.resourceCountIs('AWS::Lambda::Function', 5);
    for (const description of [
      'worker-posts-dispatch',
      'worker-post-create',
      'worker-posts-list',
      'worker-post-delete',
      'employer-worker-detail',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { Description: description });
    }
  });

  it('create Lambda has rekognition:DetectModerationLabels permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'rekognition:DetectModerationLabels', Effect: 'Allow' }),
        ]),
      },
    });
  });

  it('worker posts routes exist on the ApiStack template', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'posts' });
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{post_id}' });
  });

  it('has no literal upload-urls resource — the POST rides on {post_id}', () => {
    // /worker/posts/upload-urls still RESOLVES (a literal segment binds the
    // variable child when no literal sibling exists); what is gone is the
    // Resource + OPTIONS + Method + Permission it used to cost. The
    // end-to-end URL proof lives in api-stack-resource-ceiling.test.ts, which
    // walks the real composition the way API Gateway does.
    const uploadUrls = Object.values(apiTemplate.toJSON().Resources).filter(
      (resource: any) =>
        resource.Type === 'AWS::ApiGateway::Resource' && resource.Properties.PathPart === 'upload-urls',
    );
    expect(uploadUrls).toEqual([]);
  });

  it('{post_id} carries POST (dispatcher) and DELETE (its own Lambda) plus one OPTIONS', () => {
    const resources = apiTemplate.toJSON().Resources as Record<string, any>;
    const [postIdLogicalId] = Object.entries(resources).find(
      ([, resource]: [string, any]) =>
        resource.Type === 'AWS::ApiGateway::Resource' && resource.Properties.PathPart === '{post_id}',
    )!;
    const methods = Object.values(resources)
      .filter(
        (resource: any) =>
          resource.Type === 'AWS::ApiGateway::Method' &&
          resource.Properties.ResourceId?.Ref === postIdLogicalId,
      )
      .map((resource: any) => resource.Properties.HttpMethod)
      .sort();
    expect(methods).toEqual(['DELETE', 'OPTIONS', 'POST']);
  });

  it('employer posts is no longer its own resource — only /worker/posts remains', () => {
    // Was two resources sharing the PathPart 'posts' (the worker board and
    // employer/workers/{worker_id}/posts). The employer one collapsed into
    // the {action} dispatcher node.
    const postsResources = Object.values(apiTemplate.toJSON().Resources).filter(
      (resource: any) => resource.Type === 'AWS::ApiGateway::Resource' && resource.Properties.PathPart === 'posts',
    );
    expect(postsResources.length).toBe(1);
  });

  it('GET employer/workers/{worker_id}/{action} is protected by EmployerAuthorizer', () => {
    // The Lambda lives in MediaBoardStack while the Method/Resource live in
    // ApiStack, so the integration is a cross-stack Fn::ImportValue rather
    // than an in-stack Fn::GetAtt — match on the resource's logical id
    // (which embeds the route path) instead of the function reference shape.
    const method = Object.entries(apiTemplate.toJSON().Resources).find(
      ([id, resource]: [string, any]) =>
        resource.Type === 'AWS::ApiGateway::Method' &&
        resource.Properties.HttpMethod === 'GET' &&
        /employerworkersworkeridaction/i.test(id),
    );
    expect(method).toBeDefined();
    const [, methodResource]: any = method;
    expect(methodResource.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
    expect(methodResource.Properties.AuthorizerId.Ref).toMatch(/EmployerAuthorizer/);
  });

  // Merging three Lambdas merges three IAM roles. The union must actually be
  // a union: `documents` presigns GETs out of DocumentsStack's bucket and
  // `posts` out of the media bucket, so a role holding only one of the two
  // reads gives a 500 on exactly one of the three actions — the failure mode
  // documents-stack.test.ts's per-role S3 assertions were written to catch.
  it('the employer-worker-detail role can read BOTH the media and documents buckets', () => {
    const statements = Object.values(template.toJSON().Resources)
      .filter((resource: any) => resource.Type === 'AWS::IAM::Policy')
      .filter((resource: any) =>
        JSON.stringify(resource.Properties.Roles).includes('EmployerWorkerDetailFunctionServiceRole'))
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);

    const s3Statements = statements.filter((statement: any) =>
      [].concat(statement.Action ?? []).some((action: any) => String(action).startsWith('s3:')));
    expect(s3Statements.length).toBeGreaterThan(0);

    const resourceArns = JSON.stringify(s3Statements.map((statement: any) => statement.Resource));
    // Two distinct bucket references: the media bucket arrives as a
    // cross-stack Fn::ImportValue from WhatsAppStack, the documents bucket as
    // one from DocumentsStack.
    const importedBuckets = new Set(
      (resourceArns.match(/"Fn::ImportValue":"[^"]+"/g) ?? []).map((match) => match),
    );
    expect(importedBuckets.size).toBeGreaterThanOrEqual(2);
    expect(
      s3Statements.some((statement: any) =>
        [].concat(statement.Action ?? []).includes('s3:GetObject*' as never)),
    ).toBe(true);
  });

  it('has no moderation fail-open metric filter/alarm when alarmTopicArn is absent', () => {
    template.resourceCountIs('AWS::Logs::MetricFilter', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });
});

// I2 (final-review): the create lambda's fail-open MetricFilter/Alarm are
// only wired when `alarmTopicArn` is provided (see the prop's own jsdoc for
// why this stack doesn't fail closed like WhatsAppStack/AiStack). A separate
// app/synth from the base describe block above, which deliberately omits the
// prop to prove the opposite (no alarm resources at all).
describe('MediaBoardStack — moderation fail-open alarm (I2)', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = buildMediaBoardApp('arn:aws:sns:us-east-2:123456789012:jale-media-board-alarms-test'));
  });

  it('moderation fail-open metric filter exists on the create lambda log group, namespace Jale/Moderation', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const [createLogicalId] = Object.entries(fns).find(([, r]: [string, any]) =>
      /worker-post-create/i.test(r.Properties?.Description ?? ''))!;
    const createFnResource = (fns as Record<string, any>)[createLogicalId];
    const createLogGroupId = createFnResource.Properties.LoggingConfig?.LogGroup?.Ref;
    expect(createLogGroupId).toBeDefined();

    const filters = template.findResources('AWS::Logs::MetricFilter');
    const failOpenFilter = Object.values(filters).find((f: any) =>
      f.Properties.MetricTransformations?.some((t: any) =>
        t.MetricName === 'ModerationFailOpen' && t.MetricNamespace === 'Jale/Moderation'));
    expect(failOpenFilter).toBeDefined();
    expect((failOpenFilter as any).Properties.LogGroupName.Ref).toBe(createLogGroupId);
    expect((failOpenFilter as any).Properties.FilterPattern).toContain('moderateImage service fault (fail-open)');
  });

  it('moderation fail-open alarm exists, wired to the alarm topic', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'MediaBoardModerationFailOpen',
      Threshold: 1,
      AlarmActions: Match.anyValue(),
    });
  });
});
