import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { JaleLambdaFunction } from '../../../lib/constructs/lambda-function';
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
 *  3. Every quoted term is emitted by the Lambda whose log group the filter is
 *     actually attached to — not merely present somewhere under
 *     `infra/lambda/**`. Each filter's `LogGroupName` Ref is resolved back to
 *     the JaleLambdaFunction that owns the log group, and the search runs over
 *     that function's entry file plus its transitive local imports (so
 *     `lib/outbox-wake.ts` counts for the two WhatsAppOutboxWakeFailure filters
 *     and `lib/email-outbox.ts` for the billing sweeper's). A filter installed
 *     on the wrong log group — the mistake WhatsAppOtpLockMetric's comment
 *     warns about — publishes nothing, and a repo-wide grep would not notice.
 *     The term must appear in a string literal on a non-comment line that
 *     either carries the `metric:` JSON convention or calls `console.*`; a
 *     comment naming the metric is not evidence that anything logs it.
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
  /** Entry source of the Lambda that writes to this filter's log group. */
  entry: string;
}

/**
 * Mirrors bin/jale-app.ts for the six stacks that own MetricFilters
 * (WhatsApp, Ai, Referrals, Billing, Notifications, MediaBoard) plus the
 * stacks they depend on. Kept in one app so the audit sees every filter the
 * production synth produces. Returns the Stack objects, not Templates: the
 * construct tree is needed to map log groups back to handler sources.
 */
function buildStacks(): Record<string, cdk.Stack> {
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
    // S22 R2-C23: the web onboarding door hangs /worker/onboarding* off the
    // ApiStack's worker resource, so WhatsAppStack needs both.
    workerResource: api.workerResource,
    workerAuthorizer: api.workerAuthorizer,
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
    AiStack: ai,
    WhatsAppStack: whatsapp,
    MediaBoardStack: mediaBoard,
    BillingStack: billing,
    ReferralsStack: referrals,
    NotificationsStack: notifications,
  };
}

/**
 * Maps every LogGroup logical id in a stack to the handler source of the
 * JaleLambdaFunction that owns it. NodejsFunction keeps `entry` private and the
 * template only carries an asset hash, so this walk over the construct tree is
 * the only way to get from a filter's `LogGroupName` Ref back to source.
 */
function logGroupEntries(stack: cdk.Stack): Map<string, string> {
  const byLogicalId = new Map<string, string>();
  for (const child of stack.node.findAll()) {
    if (!(child instanceof JaleLambdaFunction)) continue;
    const cfnLogGroup = child.logGroup.node.defaultChild as cdk.CfnResource;
    byLogicalId.set(stack.getLogicalId(cfnLogGroup), child.entry);
  }
  return byLogicalId;
}

function collectFilters(): FilterRecord[] {
  const records: FilterRecord[] = [];
  for (const [stackName, stack] of Object.entries(buildStacks())) {
    const entries = logGroupEntries(stack);
    const resources = Template.fromStack(stack).findResources('AWS::Logs::MetricFilter');
    for (const [logicalId, resource] of Object.entries(resources)) {
      const props = (resource as { Properties: Record<string, unknown> }).Properties;
      const logGroupRef = (props.LogGroupName as { Ref?: string } | undefined)?.Ref;
      const entry = logGroupRef === undefined ? undefined : entries.get(logGroupRef);
      if (entry === undefined) {
        // Every filter we own sits on a JaleLambdaFunction log group. A filter
        // on anything else (an imported log group, a raw logs.LogGroup) cannot
        // be audited by this file and must not pass silently.
        throw new Error(
          `${stackName}/${logicalId}: could not resolve LogGroupName `
          + `${JSON.stringify(props.LogGroupName)} to a JaleLambdaFunction entry`,
        );
      }
      records.push({
        stack: stackName,
        logicalId,
        pattern: props.FilterPattern as string,
        metricNames: ((props.MetricTransformations ?? []) as Array<{ MetricName: string }>)
          .map((t) => t.MetricName),
        entry,
      });
    }
  }
  return records.sort((a, b) => `${a.stack}/${a.logicalId}`.localeCompare(`${b.stack}/${b.logicalId}`));
}

/**
 * Resolves a relative import specifier to a real .ts file. Handlers are written
 * with `.js` specifiers (jest.config.js maps them back), so the extension is
 * stripped before probing.
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const closureCache = new Map<string, string[]>();

/**
 * Every line of a handler entry plus every local module it transitively
 * imports — i.e. all the code that can write to that handler's log group.
 * Third-party imports are skipped (only relative specifiers are followed).
 */
function sourceClosure(entry: string): string[] {
  const cached = closureCache.get(entry);
  if (cached !== undefined) return cached;

  const seen = new Set<string>();
  const pending = [path.resolve(entry)];
  const lines: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    lines.push(...text.split('\n'));
    for (const match of text.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const resolved = resolveRelativeImport(file, match[1]);
      if (resolved !== undefined) pending.push(resolved);
    }
  }
  closureCache.set(entry, lines);
  return lines;
}

/** Comment lines are documentation, not evidence that anything is logged. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** The term occurs inside a string literal on this line, not as bare code. */
function inStringLiteral(line: string, term: string): boolean {
  return line.includes(`'${term}`)
    || line.includes(`"${term}`)
    || (line.includes('`') && line.includes(term));
}

/**
 * True when some line in `lines` actually writes `term` to the log: either the
 * `{ metric: '<name>' }` JSON convention or a plain `console.*` message.
 */
function emitsTerm(lines: string[], term: string): boolean {
  return lines.some((line) => !isCommentLine(line)
    && inStringLiteral(line, term)
    && (/\bmetric:/.test(line) || /\bconsole\.\w+\s*\(/.test(line)));
}

/** A single quoted term, e.g. `"WhatsAppOtpLock"`. */
const SINGLE_TERM = /^"[^"]+"$/;
/** An `anyTerm` chain, e.g. `?"a" ?"b"`. */
const ANY_TERM_CHAIN = /^\?"[^"]+"(?: \?"[^"]+")*$/;

function quotedTerms(pattern: string): string[] {
  return [...pattern.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const FILTERS = collectFilters();

describe('CloudWatch MetricFilter patterns', () => {
  // Guards against rot: a new stack that installs a MetricFilter but is not
  // wired into buildStacks() would leave the suite green while going
  // completely unaudited.
  test('buildStacks covers every stack source that installs a MetricFilter', () => {
    const stacksDir = path.join(__dirname, '../../../lib/stacks');
    const withFilters = fs.readdirSync(stacksDir)
      .filter((name) => name.endsWith('-stack.ts'))
      .filter((name) => fs.readFileSync(path.join(stacksDir, name), 'utf8')
        .includes('new logs.MetricFilter'))
      .sort();
    expect(withFilters).toEqual([
      'ai-stack.ts',
      'billing-stack.ts',
      'media-board-stack.ts',
      'notifications-stack.ts',
      'referrals-stack.ts',
      'whatsapp-stack.ts',
    ]);
  });

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

  // Scoped to the filter's OWN log group, so this also catches a filter
  // installed on the wrong Lambda — which publishes nothing even though the
  // pattern and the emitting code are both perfectly correct.
  test.each(FILTERS.map((f) => [`${f.stack}/${f.logicalId}`, f] as const))(
    '%s matches a string its own Lambda logs',
    (_label, filter) => {
      const terms = quotedTerms(filter.pattern);
      expect(terms.length).toBeGreaterThan(0);
      const lines = sourceClosure(filter.entry);
      const relativeEntry = path.relative(path.join(__dirname, '../../..'), filter.entry);
      for (const term of terms) {
        if (!emitsTerm(lines, term)) {
          throw new Error(
            `${filter.stack}/${filter.logicalId} filters on ${JSON.stringify(term)}, but neither `
            + `${relativeEntry} nor anything it imports logs that string — either the filter is `
            + 'dead or it is installed on the wrong log group',
          );
        }
      }
    },
  );
});

// ── S22 R2-C23: the CloudFormation resource ceiling ─────────────────────
//
// The ceiling assertion that used to live here has MOVED to
// `api-stack-resource-ceiling.test.ts`. It was wrong where it stood:
// `buildStacks()` above is a SUBSET of `bin/jale-app.ts` (no MatchingStack,
// AdminStack, AdminCertStack, BastionStack or FrontendStack, and no
// `crossRegionReferences: true`), so it undercounted the deployed ApiStack —
// it read 499 while the real CI synth was at 501 and failing with
// TooManyResourcesInStack. Do not re-add a ceiling assertion here; the
// replacement synthesizes the real `bin/jale-app.ts` composition
// (`lib/app-composition.ts`) with the production CI context.
