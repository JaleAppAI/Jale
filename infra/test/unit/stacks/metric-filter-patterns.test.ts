import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../../../lib/stacks/network-stack';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { AuthStack } from '../../../lib/stacks/auth-stack';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { LegalStack } from '../../../lib/stacks/legal-stack';
import { AiStack } from '../../../lib/stacks/ai-stack';
import { WhatsAppStack } from '../../../lib/stacks/whatsapp-stack';
import { DocumentsStack } from '../../../lib/stacks/documents-stack';
import { MediaBoardStack } from '../../../lib/stacks/media-board-stack';
import { BillingStack } from '../../../lib/stacks/billing-stack';
import { ReferralsStack } from '../../../lib/stacks/referrals-stack';
import { NotificationsStack } from '../../../lib/stacks/notifications-stack';

/**
 * Repo-wide audit of every `AWS::Logs::MetricFilter` we synthesize.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two idioms were in use for turning a Lambda log line into an alarmable
 * metric:
 *
 *   A. `logs.FilterPattern.stringValue('$.metric', '=', 'X')`
 *      -> synthesizes the JSON *selector* pattern `{ $.metric = "X" }`.
 *   B. `logs.FilterPattern.literal('"X"')`
 *      -> synthesizes the quoted *term* pattern `"X"`.
 *
 * CloudWatch Logs only evaluates a JSON selector pattern against log events
 * that are *themselves* a valid JSON object. Every one of our functions runs
 * on the Node 20 managed runtime with the DEFAULT (TEXT) log format — nothing
 * in `infra/lib` sets `loggingFormat`/`LoggingFormat` — so the runtime writes
 *
 *     <ISO timestamp>\t<requestId>\tINFO\t{"metric":"X",...}\n
 *
 * for a `console.log(JSON.stringify({ metric: 'X', ... }))`. That event is not
 * a JSON object, so idiom A matches NOTHING: the metric stays at zero and any
 * alarm on it is silently disarmed forever. Idiom B is a term match over the
 * raw event text and matches the substring inside the JSON regardless of the
 * prefix, under both the TEXT and JSON log formats.
 *
 * `notifications-stack.ts:260` documents the same conclusion, and
 * `notifications-stack.test.ts` already guards that one stack. This file makes
 * the guard repo-wide.
 *
 * WHAT IT ASSERTS
 * ---------------
 *  1. No synthesized FilterPattern contains a JSON selector (`$.`).
 *  2. Every pattern is one of the two accepted term idioms: a single quoted
 *     term, or an `anyTerm` chain (`?"a" ?"b"`).
 *  3. Every quoted term in every pattern actually appears in the Lambda source
 *     under `infra/lambda/**` on a line that emits it — either the
 *     `metric: '<name>'` JSON convention or a plain `console.*` message. A
 *     filter keyed off a string the code never logs is a dead filter.
 */

const ALARM_TOPIC_ARN = 'arn:aws:sns:us-east-2:123456789012:jale-ci-alarms';
const STATUS_CALLBACK_URL = 'https://callbacks.example.test/prod/whatsapp/status-callback';

interface FilterRecord {
  /** Stack the filter is synthesized into. */
  stack: string;
  /** CloudFormation logical id — the only stable per-filter key (metric names repeat). */
  logicalId: string;
  /** Pattern exactly as it lands in the template. */
  pattern: string;
  /** Metric names the filter publishes. */
  metricNames: string[];
}

/**
 * Mirrors bin/jale-app.ts for the six stacks that own MetricFilters
 * (WhatsApp, Ai, Referrals, Billing, Notifications, MediaBoard) plus the
 * stacks they depend on. Kept in one app so the audit sees every filter the
 * production synth produces.
 */
function buildTemplates(): Record<string, Template> {
  const app = new cdk.App({
    context: {
      environment: 'production',
      otpSmsFromNumber: '+13252210992',
      whatsappStatusCallbackUrl: STATUS_CALLBACK_URL,
      emailFromAddress: 'billing@jaleapp.ai',
      sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:123456789012:identity/jaleapp.ai',
      publicSiteBaseUrl: 'https://jaleapp.ai',
      whatsappBusinessNumber: '15551234567',
      whatsappInboundV2TransportEnabled: 'true',
    },
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
    alarmTopicArn: ALARM_TOPIC_ARN,
  });
  const api = new ApiStack(app, 'TestApiStack', {
    workerPool: auth.workerPool,
    employerPool: auth.employerPool,
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    aliasGeneratorFn: ai.aliasGeneratorFn.function,
    whatsappStatusCallbackUrl: STATUS_CALLBACK_URL,
  });
  // LegalStack must exist so ApiStack's DualAuthorizer is attached to a
  // method; CDK rejects synthesis otherwise.
  new LegalStack(app, 'TestLegalStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    api: api.api,
    dualAuthorizer: api.dualAuthorizer,
  });

  // Real DocumentsStack, not the KMS-bucket stand-in the WhatsApp/MediaBoard
  // tests use: MediaBoardStack hangs /employer/workers/{worker_id}/posts off
  // the API resource tree DocumentsStack creates, exactly as in bin/jale-app.ts.
  const documents = new DocumentsStack(app, 'TestDocumentsStack', {
    network,
    api,
    dbSecret: database.dbSecret,
    allowedOrigin: 'https://jaleapp.ai',
    requiredTosVersion: 'v1.0',
  });

  const whatsapp = new WhatsAppStack(app, 'TestWhatsAppStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    workerPool: auth.workerPool,
    api: api.api,
    questionGeneratorFn: ai.questionGeneratorFn.function,
    aliasGeneratorFn: ai.aliasGeneratorFn.function,
    trustAssessmentQueue: ai.trustAssessmentQueue,
    trustExtractionQueue: ai.trustExtractionQueue,
    statusCallbackUrl: STATUS_CALLBACK_URL,
    alarmTopicArn: ALARM_TOPIC_ARN,
    documentsBucket: documents.bucket,
  });

  const mediaBoard = new MediaBoardStack(app, 'TestMediaBoardStack', {
    network,
    api,
    dbSecret: database.dbSecret,
    mediaBucket: whatsapp.mediaBucket,
    allowedOrigin: 'https://jaleapp.ai',
    requiredTosVersion: 'v1.0',
    alarmTopicArn: ALARM_TOPIC_ARN,
  });

  const billing = new BillingStack(app, 'TestBillingStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    billingLambdaSg: network.billingLambdaSg,
    billingDbSecret: database.billingDbSecret,
    appDbSecret: database.dbSecret,
    api: api.api,
    employerAuthorizer: api.employerAuthorizer,
    employerResource: api.employerResource,
  });

  const referrals = new ReferralsStack(app, 'TestReferralsStack', {
    vpc: network.vpc,
    privateSubnets: network.privateSubnets,
    referralsLambdaSg: network.referralsLambdaSg,
    referralsDbSecret: database.referralsDbSecret,
    appDbSecret: database.dbSecret,
    api: api.api,
    publicResource: api.publicResource,
    workerAuthorizer: api.workerAuthorizer,
    workerResource: api.workerResource,
    workerJobResource: api.workerJobResource,
    employerAuthorizer: api.employerAuthorizer,
    employerJobResource: api.employerJobResource,
    alarmTopicArn: ALARM_TOPIC_ARN,
  });

  const notifications = new NotificationsStack(app, 'TestNotificationsStack', {
    vpc: network.vpc,
    lambdaSg: network.lambdaSg,
    dbSecret: database.dbSecret,
    publicResource: api.publicResource,
    alarmTopicArn: ALARM_TOPIC_ARN,
  });

  return {
    AiStack: Template.fromStack(ai),
    WhatsAppStack: Template.fromStack(whatsapp),
    MediaBoardStack: Template.fromStack(mediaBoard),
    BillingStack: Template.fromStack(billing),
    ReferralsStack: Template.fromStack(referrals),
    NotificationsStack: Template.fromStack(notifications),
  };
}

function collectFilters(): FilterRecord[] {
  const records: FilterRecord[] = [];
  for (const [stack, template] of Object.entries(buildTemplates())) {
    const resources = template.findResources('AWS::Logs::MetricFilter');
    for (const [logicalId, resource] of Object.entries(resources)) {
      const props = (resource as { Properties: Record<string, unknown> }).Properties;
      records.push({
        stack,
        logicalId,
        pattern: props.FilterPattern as string,
        metricNames: ((props.MetricTransformations ?? []) as Array<{ MetricName: string }>)
          .map((t) => t.MetricName),
      });
    }
  }
  return records.sort((a, b) => `${a.stack}/${a.logicalId}`.localeCompare(`${b.stack}/${b.logicalId}`));
}

/** Every line of every TypeScript source file under infra/lambda. */
function readLambdaSourceLines(): string[] {
  const root = path.join(__dirname, '../../../lambda');
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        lines.push(...fs.readFileSync(full, 'utf8').split('\n'));
      }
    }
  };
  walk(root);
  return lines;
}

/** A single quoted term, e.g. `"WhatsAppOtpLock"`. */
const SINGLE_TERM = /^"[^"]+"$/;
/** An `anyTerm` chain, e.g. `?"a" ?"b"`. */
const ANY_TERM_CHAIN = /^\?"[^"]+"(?: \?"[^"]+")*$/;

function quotedTerms(pattern: string): string[] {
  return [...pattern.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const FILTERS = collectFilters();
const LAMBDA_LINES = readLambdaSourceLines();

describe('CloudWatch MetricFilter patterns', () => {
  test('the audit found every stack that owns metric filters', () => {
    expect(FILTERS.length).toBeGreaterThan(0);
    const stacks = new Set(FILTERS.map((f) => f.stack));
    for (const expected of [
      'AiStack',
      'WhatsAppStack',
      'MediaBoardStack',
      'BillingStack',
      'ReferralsStack',
      'NotificationsStack',
    ]) {
      expect(stacks).toContain(expected);
    }
  });

  // The regression guard. A `$.` selector pattern cannot match a Node 20
  // TEXT-format Lambda log event (timestamp/requestId/level prefix), so the
  // filter publishes nothing and its alarm never fires.
  test('no metric filter uses a JSON selector pattern', () => {
    const offenders = FILTERS
      .filter((f) => f.pattern.includes('$.'))
      .map((f) => `${f.stack}/${f.logicalId}: ${f.pattern}`);
    expect(offenders).toEqual([]);
  });

  test.each(FILTERS.map((f) => [`${f.stack}/${f.logicalId}`, f] as const))(
    '%s uses an accepted term idiom',
    (_label, filter) => {
      expect(filter.pattern).not.toContain('$.');
      const accepted = SINGLE_TERM.test(filter.pattern) || ANY_TERM_CHAIN.test(filter.pattern);
      if (!accepted) {
        throw new Error(
          `${filter.stack}/${filter.logicalId} pattern ${JSON.stringify(filter.pattern)} is neither a `
          + 'single quoted term nor an anyTerm chain',
        );
      }
    },
  );

  test.each(FILTERS.map((f) => [`${f.stack}/${f.logicalId}`, f] as const))(
    '%s matches a string the Lambda code actually logs',
    (_label, filter) => {
      const terms = quotedTerms(filter.pattern);
      expect(terms.length).toBeGreaterThan(0);
      for (const term of terms) {
        // Accept either the `{ metric: '<name>' }` JSON convention or a plain
        // `console.*` message literal (moderation fail-open, the two
        // billing-checkout errors and the email-outbox tokens are logged as
        // plain console messages, not as a `metric` field).
        const emitted = LAMBDA_LINES.some((line) =>
          line.includes(`'${term}'`) && (/\bmetric:/.test(line) || /\bconsole\./.test(line)));
        const emittedAsText = LAMBDA_LINES.some((line) =>
          line.includes(term) && /\bconsole\./.test(line));
        if (!emitted && !emittedAsText) {
          throw new Error(
            `${filter.stack}/${filter.logicalId} filters on ${JSON.stringify(term)}, but no line under `
            + 'infra/lambda/** logs that string — the filter is dead',
          );
        }
      }
    },
  );
});
