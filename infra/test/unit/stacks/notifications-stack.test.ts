import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NotificationsStack } from '../../../lib/stacks/notifications-stack';

const PRODUCER_DESCRIPTION = 'Employer daily digest producer';
const UNSUBSCRIBE_DESCRIPTION = 'Employer digest unsubscribe endpoint (unauthenticated)';
const TOPIC_ARN = 'arn:aws:sns:us-east-2:123456789012:jale-ci-whatsapp-alarms';

/**
 * Harness note: NotificationsStack hangs its unauthenticated route off a
 * `/public` resource that ApiStack owns, so unlike matching-stack.test.ts's
 * bare harness this one needs a real RestApi. Every API Gateway Resource and
 * Method therefore lands in the API HARNESS template (they are children of the
 * RestApi construct), not in the NotificationsStack template — which is
 * exactly why the route/authorizer/throttle assertions for this feature live
 * in api-stack.test.ts.
 *
 * The network/secret harness is a SEPARATE stack from the API harness, which
 * mirrors the real bin/jale-app.ts topology (VPC from NetworkStack, secret
 * from DatabaseStack, RestApi from ApiStack) and is load-bearing here: with all
 * of it in one stack, NotificationsStack imports the VPC from that stack while
 * that stack imports the unsubscribe Lambda's ARN for the Method — a genuine
 * two-stack cycle that CDK rejects. The real app is acyclic for the same reason
 * ReferralsStack is: the reference only ever runs ApiStack -> downstream stack.
 */
function buildStack(options: {
  alarmTopicArn?: string;
  publicSiteBaseUrl?: string | null;
  emailConfigurationSetName?: string;
} = {}) {
  const context: Record<string, unknown> = {};
  if (options.publicSiteBaseUrl !== null) {
    context.publicSiteBaseUrl = options.publicSiteBaseUrl ?? 'https://jaleapp.ai';
  }
  const app = new cdk.App({ context });
  const infraHarness = new cdk.Stack(app, 'NotificationsInfraHarness');
  const vpc = new ec2.Vpc(infraHarness, 'Vpc', { maxAzs: 2 });
  const lambdaSg = new ec2.SecurityGroup(infraHarness, 'LambdaSg', { vpc });
  const dbSecret = new secretsmanager.Secret(infraHarness, 'DbSecret');

  const apiHarness = new cdk.Stack(app, 'NotificationsApiHarness');
  const api = new apigateway.RestApi(apiHarness, 'Api');
  const publicResource = api.root.addResource('public');

  const stack = new NotificationsStack(app, 'TestNotificationsStack', {
    vpc,
    lambdaSg,
    dbSecret,
    publicResource,
    alarmTopicArn: options.alarmTopicArn,
    emailConfigurationSetName: options.emailConfigurationSetName,
  });
  return { app, apiHarness, api, stack };
}

describe('NotificationsStack', () => {
  let template: Template;
  let apiTemplate: Template;

  beforeAll(() => {
    const { stack, apiHarness } = buildStack();
    template = Template.fromStack(stack);
    apiTemplate = Template.fromStack(apiHarness);
  });

  // ── Fail-closed configuration ─────────────────────────────────────────────

  it('throws at synth time when neither publicSiteBaseUrl context nor the env var is present', () => {
    const saved = process.env.JALE_PUBLIC_SITE_BASE_URL;
    delete process.env.JALE_PUBLIC_SITE_BASE_URL;
    try {
      expect(() => buildStack({ publicSiteBaseUrl: null })).toThrow(/publicSiteBaseUrl/);
    } finally {
      if (saved === undefined) delete process.env.JALE_PUBLIC_SITE_BASE_URL;
      else process.env.JALE_PUBLIC_SITE_BASE_URL = saved;
    }
  });

  it('accepts the env-var fallback the CI synth already supplies', () => {
    const saved = process.env.JALE_PUBLIC_SITE_BASE_URL;
    process.env.JALE_PUBLIC_SITE_BASE_URL = 'https://env.example.invalid';
    try {
      expect(() => buildStack({ publicSiteBaseUrl: null })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.JALE_PUBLIC_SITE_BASE_URL;
      else process.env.JALE_PUBLIC_SITE_BASE_URL = saved;
    }
  });

  it('rejects a base URL that is not an absolute http(s) URL', () => {
    expect(() => buildStack({ publicSiteBaseUrl: 'jaleapp.ai' })).toThrow(/absolute http/);
    expect(() => buildStack({ publicSiteBaseUrl: 'ftp://jaleapp.ai' })).toThrow(/absolute http/);
  });

  // ── Lambdas ───────────────────────────────────────────────────────────────

  it('creates the producer and the unsubscribe Lambda, and nothing else', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Description: PRODUCER_DESCRIPTION });
    template.hasResourceProperties('AWS::Lambda::Function', { Description: UNSUBSCRIBE_DESCRIPTION });
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  it('caps the producer at one concurrent execution', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: PRODUCER_DESCRIPTION,
      ReservedConcurrentExecutions: 1,
    });
  });

  it('gives the producer its three env vars and a trailing-slash-free base URL', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: PRODUCER_DESCRIPTION,
      Environment: {
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
          UNSUBSCRIBE_SECRET_ARN: Match.anyValue(),
          PUBLIC_SITE_BASE_URL: 'https://jaleapp.ai',
        }),
      },
    });
  });

  it('strips a trailing slash from the configured base URL', () => {
    const { stack } = buildStack({ publicSiteBaseUrl: 'https://jaleapp.ai/' });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Description: PRODUCER_DESCRIPTION,
      Environment: { Variables: Match.objectLike({ PUBLIC_SITE_BASE_URL: 'https://jaleapp.ai' }) },
    });
  });

  it('does not give the producer a rerank queue URL — the sweep must never enqueue reranks', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Description: PRODUCER_DESCRIPTION },
    });
    const [fn] = Object.values(functions) as any[];
    expect(Object.keys(fn.Properties.Environment.Variables))
      .not.toContain('EMPLOYER_CANDIDATE_RERANK_QUEUE_URL');
  });

  it('gives the unsubscribe Lambda the DB and signing-secret ARNs', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: UNSUBSCRIBE_DESCRIPTION,
      Environment: {
        Variables: Match.objectLike({
          DB_SECRET_ARN: Match.anyValue(),
          UNSUBSCRIBE_SECRET_ARN: Match.anyValue(),
          ALLOWED_ORIGIN: Match.anyValue(),
        }),
      },
    });
  });

  // ── Signing secret ────────────────────────────────────────────────────────

  it('creates the unsubscribe signing secret as a CDK-generated bare string', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'jale/notifications/unsubscribe-signing-secret',
      GenerateSecretString: Match.objectLike({
        PasswordLength: 64,
        ExcludePunctuation: true,
      }),
    });
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  it('does not put the signing secret value into any Lambda environment variable', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions) as any[]) {
      const rendered = JSON.stringify(fn.Properties.Environment?.Variables ?? {});
      // Only the ARN Ref may appear, never a resolved secret value.
      expect(rendered).not.toMatch(/SecretString/);
    }
  });

  // ── Schedule ──────────────────────────────────────────────────────────────

  it('runs the producer on a 15-minute EventBridge schedule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
    });
    template.resourceCountIs('AWS::Events::Rule', 1);
  });

  // ── Async-invoke DLQ ──────────────────────────────────────────────────────

  it('wires the producer to a dead-letter queue with no retries and a one-hour event age', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'jale-employer-digest-producer-dlq',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: PRODUCER_DESCRIPTION,
      DeadLetterConfig: { TargetArn: Match.anyValue() },
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 3600,
    });
  });

  // ── Alarms ────────────────────────────────────────────────────────────────

  it('creates exactly four alarms, all NOT_BREACHING on missing data', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms) as any[]) {
      expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
      expect(alarm.Properties.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
      expect(alarm.Properties.Threshold).toBe(1);
      expect(alarm.Properties.EvaluationPeriods).toBe(1);
    }
  });

  it('alarms on DLQ depth', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'EmployerDigestProducerDlqDepth',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
    });
  });

  it('alarms on producer Lambda errors', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'EmployerDigestProducerErrors',
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
    });
  });

  it('turns the digest_skipped_invalid_email log line into an alarmable metric', () => {
    // The literal must match what employer-digest-producer.ts writes; the skip
    // path returns normally, so the Errors alarm above cannot see it.
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"digest_skipped_invalid_email"',
      MetricTransformations: [
        Match.objectLike({
          MetricNamespace: 'Jale/Notifications',
          MetricName: 'EmployerDigestSkippedInvalidEmail',
          MetricValue: '1',
        }),
      ],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'EmployerDigestSkippedInvalidEmail',
      Namespace: 'Jale/Notifications',
      MetricName: 'EmployerDigestSkippedInvalidEmail',
    });
  });

  it('turns the digest_employer_failed log line into an alarmable metric', () => {
    // Every per-employer failure — a 23514, an idempotency conflict, a Secrets
    // Manager throttle mid-loop — is swallowed by the producer's per-employer
    // catch, which returns normally. metricErrors cannot see it and the DLQ
    // stays empty, so this filter is the ONLY signal.
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"digest_employer_failed"',
      MetricTransformations: [
        Match.objectLike({
          MetricNamespace: 'Jale/Notifications',
          MetricName: 'EmployerDigestEmployerFailed',
          MetricValue: '1',
        }),
      ],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'EmployerDigestEmployerFailed',
      Namespace: 'Jale/Notifications',
      MetricName: 'EmployerDigestEmployerFailed',
    });
  });

  it('uses LITERAL term patterns, never $.metric JSON patterns', () => {
    // A JSON filter pattern requires the whole log EVENT to parse as JSON.
    // Node 20 Lambda's default TEXT log format prefixes every console line with
    // `timestamp<TAB>requestId<TAB>LEVEL<TAB>`, so `{ $.metric = "..." }` never
    // matches and the alarm is silently disarmed. A quoted term matches the
    // substring inside the JSON.stringify output under BOTH log formats.
    // billing-stack.ts:364/392 is the correct precedent.
    const filters = template.findResources('AWS::Logs::MetricFilter');
    expect(Object.keys(filters)).toHaveLength(2);
    for (const filter of Object.values(filters) as any[]) {
      expect(filter.Properties.FilterPattern).not.toContain('$.');
      expect(filter.Properties.FilterPattern).toMatch(/^"[a-z_]+"$/);
    }
  });

  it('synthesizes cleanly with no alarm topic, leaving the alarms actionless but visible', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms) as any[]) {
      expect(alarm.Properties.AlarmActions).toBeUndefined();
      expect(alarm.Properties.OKActions).toBeUndefined();
    }
  });

  describe('with alarmTopicArn supplied', () => {
    let alarmed: Template;
    beforeAll(() => {
      alarmed = Template.fromStack(buildStack({ alarmTopicArn: TOPIC_ARN }).stack);
    });

    it('attaches both alarm and OK actions to the shared topic', () => {
      const alarms = alarmed.findResources('AWS::CloudWatch::Alarm');
      expect(Object.keys(alarms)).toHaveLength(4);
      for (const alarm of Object.values(alarms) as any[]) {
        expect(alarm.Properties.AlarmActions).toEqual([TOPIC_ARN]);
        expect(alarm.Properties.OKActions).toEqual([TOPIC_ARN]);
      }
    });

    it('reuses the shared topic by ARN instead of creating one', () => {
      expect(Object.keys(alarmed.findResources('AWS::SNS::Topic'))).toHaveLength(0);
    });
  });

  // ── No MethodSettings from a downstream stack ─────────────────────────────

  it('does not declare a stage or MethodSettings — ApiStack owns the only array', () => {
    template.resourceCountIs('AWS::ApiGateway::Stage', 0);
    expect(JSON.stringify(template.toJSON())).not.toContain('MethodSettings');
  });

  // ── The route lands on the shared /public node ────────────────────────────

  it('hangs the unsubscribe route off the SHARED /public resource, adding no second one', () => {
    const resources = apiTemplate.findResources('AWS::ApiGateway::Resource');
    const pathParts = Object.values(resources).map((r: any) => r.Properties.PathPart).sort();
    expect(pathParts).toEqual(['employer-digest', 'public', 'unsubscribe']);
    expect(pathParts.filter((p) => p === 'public')).toHaveLength(1);
  });

  it('the unsubscribe method is unauthenticated', () => {
    apiTemplate.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
    });
  });

  // ── SES delivery feedback (sprint 22 R3-E) ───────────────────────────────

  /**
   * The default harness passes no configuration-set name, which is the
   * dev-synth shape this whole prop exists to keep working. Nothing is created
   * and nothing is half-created.
   */
  describe('without a configuration set name', () => {
    it('creates no configuration set, no event destination and no feedback lambda', () => {
      template.resourceCountIs('AWS::SES::ConfigurationSet', 0);
      template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 0);
      template.resourceCountIs('AWS::SNS::Topic', 0);
      const functions = Object.values(template.findResources('AWS::Lambda::Function'));
      expect(functions.map((fn: any) => fn.Properties.Description))
        .not.toContain('SES bounce/complaint handler — switches the employer digest off');
    });
  });

  describe('with a configuration set name threaded in', () => {
    const CONFIGURATION_SET = 'jale-employer-email';
    let feedbackTemplate: Template;

    beforeAll(() => {
      feedbackTemplate = Template.fromStack(
        buildStack({ emailConfigurationSetName: CONFIGURATION_SET, alarmTopicArn: TOPIC_ARN }).stack,
      );
    });

    it('creates the configuration set under the name both stacks compute independently', () => {
      feedbackTemplate.hasResourceProperties('AWS::SES::ConfigurationSet', {
        Name: CONFIGURATION_SET,
      });
    });

    /**
     * BOUNCE and COMPLAINT only. Adding DELIVERY/SEND/OPEN would multiply the
     * topic's traffic by the whole send volume to tell the handler nothing it
     * acts on.
     */
    it('routes only BOUNCE and COMPLAINT to the SNS destination', () => {
      feedbackTemplate.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
        EventDestination: Match.objectLike({
          Enabled: true,
          MatchingEventTypes: ['BOUNCE', 'COMPLAINT'],
          SnsDestination: Match.objectLike({ TopicARN: Match.anyValue() }),
        }),
      });
    });

    it('creates the topic and subscribes the feedback Lambda to it', () => {
      feedbackTemplate.resourceCountIs('AWS::SNS::Topic', 1);
      feedbackTemplate.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: `${CONFIGURATION_SET}-feedback`,
      });
      feedbackTemplate.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'lambda',
      });
    });

    /**
     * The failure this catches is silent in every other signal. SES publishes
     * to the topic as the `ses.amazonaws.com` service principal, and neither
     * `new sns.Topic` nor the L1 event destination writes a resource policy
     * granting it `sns:Publish`. Without one, SES drops every bounce and
     * complaint on its own side: the handler is never invoked, so
     * SesFeedbackHandlerErrors stays flat, ses_feedback_unknown_message stays
     * flat, and the whole lane reads as deployed and healthy while a dead
     * mailbox keeps receiving a daily digest.
     *
     * `aws:SourceAccount` is the confused-deputy guard: without it any other
     * account's SES could publish bounce events into this topic and switch
     * arbitrary employers' digests off.
     */
    it('lets the SES service principal publish to the feedback topic, this account only', () => {
      feedbackTemplate.resourceCountIs('AWS::SNS::TopicPolicy', 1);
      feedbackTemplate.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'sns:Publish',
              Principal: { Service: 'ses.amazonaws.com' },
              Condition: { StringEquals: { 'aws:SourceAccount': Match.anyValue() } },
            }),
          ]),
        }),
      });
    });

    it('runs the handler in the VPC as jale_admin, on the same secret the settings API uses', () => {
      feedbackTemplate.hasResourceProperties('AWS::Lambda::Function', {
        Description: 'SES bounce/complaint handler — switches the employer digest off',
        Timeout: 30,
        Environment: { Variables: Match.objectLike({ DB_SECRET_ARN: Match.anyValue() }) },
        VpcConfig: Match.anyValue(),
      });
    });

    /**
     * The handler holds NO SES permission: a configuration set is a
     * receive-side construct, and the only role that may send is the sweeper's
     * over in BillingStack.
     */
    it('grants the feedback handler no SES permissions at all', () => {
      expect(JSON.stringify(feedbackTemplate.findResources('AWS::IAM::Policy'))).not.toContain('ses:Send');
    });

    it('alarms on handler errors and on the two silent outcomes', () => {
      feedbackTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'SesFeedbackHandlerErrors',
        AlarmActions: [TOPIC_ARN],
      });
      for (const [literal, metricName] of [
        ['ses_feedback_malformed', 'SesFeedbackMalformed'],
        ['ses_feedback_unknown_message', 'SesFeedbackUnknownMessage'],
      ]) {
        feedbackTemplate.hasResourceProperties('AWS::Logs::MetricFilter', {
          FilterPattern: `"${literal}"`,
          MetricTransformations: Match.arrayWith([Match.objectLike({
            MetricNamespace: 'Jale/Notifications', MetricName: metricName,
          })]),
        });
        feedbackTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: metricName });
      }
    });
  });
});
