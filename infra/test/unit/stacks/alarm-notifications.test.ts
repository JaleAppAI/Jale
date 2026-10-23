import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { buildJaleApp } from '../../../lib/app-composition';
import { EDGE_STACK_IDS } from '../../../lib/stacks/audit-edge-stack';

/**
 * Where the alarms of the REAL composition send their ALARM state.
 *
 * An alarm with no action changes state in the console and notifies no one.
 * The app's monitored ops topic reaches the stacks the way the production
 * deploy passes it, as the `whatsappAlarmTopicArn` context, so this composes
 * `lib/app-composition.ts` with the production deploy's context keys
 * (fictitious values) rather than handing each stack the prop directly.
 * Nothing is bundled: only the alarms are read.
 */

type Json = any;

const INFRA_ROOT = path.join(__dirname, '../../..');
const PLACEHOLDER_ACCOUNT = '111111111111';
const PLACEHOLDER_REGION = 'us-east-2';
const ALARM_TOPIC_ARN = 'arn:aws:sns:us-east-2:111122223333:jale-alarms';

const PRODUCTION_CONTEXT: Record<string, unknown> = {
  environment: 'production',
  deletionProtection: 'true',
  emailFromAddress: 'billing@example.com',
  sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:111122223333:identity/example.com',
  sesEmailFromAddress: 'no-reply@example.com',
  sesEmailRegion: 'us-east-1',
  whatsappStatusCallbackUrl: 'https://example.com/whatsapp/status-callback',
  whatsappAlarmTopicArn: ALARM_TOPIC_ARN,
  billingAlarmTopicArn: ALARM_TOPIC_ARN,
  whatsappInboundV2TransportEnabled: 'true',
  sesConfigurationSetName: 'jale-test-employer-email',
  publicSiteBaseUrl: 'https://jaleapp.ai',
  whatsappBusinessNumber: '15551234567',
  guardDutyMode: 'create',
  securityHubMode: 'create',
  configMode: 'create',
  dbSharedPreloadLibrariesDefault: 'pg_stat_statements',
};

function cliContext(): Record<string, unknown> {
  const readJson = (file: string): Record<string, unknown> => {
    const full = path.join(INFRA_ROOT, file);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {};
  };
  return {
    ...(readJson('cdk.json').context as Record<string, unknown> ?? {}),
    ...readJson('cdk.context.json'),
    ...PRODUCTION_CONTEXT,
    'aws:cdk:bundling-stacks': [],
  };
}

interface ComposedStack {
  region: string | undefined;
  template: Json;
}

/** Composes the whole app, frontend included, with a placeholder account and region. */
function compose(): Record<string, ComposedStack> {
  const saved = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
  process.env.CDK_DEFAULT_ACCOUNT = PLACEHOLDER_ACCOUNT;
  process.env.CDK_DEFAULT_REGION = PLACEHOLDER_REGION;
  try {
    const app = new cdk.App({ context: cliContext() });
    buildJaleApp(app);
    const assembly = app.synth();
    return Object.fromEntries(assembly.stacks.map((s) => [
      s.stackName,
      { region: s.environment.region, template: s.template },
    ]));
  } finally {
    for (const [key, name] of [['account', 'CDK_DEFAULT_ACCOUNT'], ['region', 'CDK_DEFAULT_REGION']] as const) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
}

/** Every alarm in a template, keyed by logical id. */
function alarmsOf(template: Json): Record<string, Json> {
  return Object.fromEntries(Object.entries(template.Resources ?? {})
    .filter(([, r]: [string, Json]) => r.Type === 'AWS::CloudWatch::Alarm'));
}

/** The one alarm whose logical id is `<constructId><8 hex>`. */
function alarmByConstructId(template: Json, constructId: string): Json {
  const found = Object.entries(alarmsOf(template))
    .filter(([id]) => new RegExp(`^${constructId}[0-9A-F]{8}$`).test(id));
  expect(found).toHaveLength(1);
  return found[0][1];
}

// The us-east-2 alarms that used to carry no action, by stack and construct id.
const OPS_TOPIC_ALARMS: Array<[stack: string, constructId: string]> = [
  ['JaleAuthStack', 'WorkerOtpSendErrorAlarm'],
  ['JaleAuthStack', 'WorkerOtpThrottleAlarm'],
  ['JaleAuthStack', 'WorkerOtpTwilioFailureAlarm'],
  ['JaleAuthStack', 'EmployerCustomMessageErrorAlarm'],
  ['JaleMatchingStack', 'CandidateMaterializationDlqAlarm'],
  ['JaleMatchingStack', 'WorkerRerankDlqAlarm'],
  ['JaleMatchingStack', 'EmployerCandidateRerankDlqAlarm'],
  ['JaleAdminStack', 'AdminLambdaErrorsAlarm'],
  ['JaleAdminStack', 'AdminLambdaThrottlesAlarm'],
];

/** Whether an alarm reads a metric in a namespace, directly or through metric math. */
function readsNamespace(alarm: Json, namespace: string): boolean {
  return alarm.Properties.Namespace === namespace
    || (alarm.Properties.Metrics ?? []).some((m: Json) => m.MetricStat?.Metric?.Namespace === namespace);
}

describe('alarm notifications (real composition)', () => {
  let stacks: Record<string, ComposedStack>;

  beforeAll(() => {
    stacks = compose();
  });

  it.each(OPS_TOPIC_ALARMS)('%s %s notifies the ops topic from the alarm-topic context', (stack, constructId) => {
    expect(stacks[stack].region).toBe(PLACEHOLDER_REGION);
    const alarm = alarmByConstructId(stacks[stack].template, constructId);
    expect(alarm.Properties.AlarmActions).toEqual([ALARM_TOPIC_ARN]);
  });

  it('the us-east-1 SES alarms notify the topic their own stack creates in that region', () => {
    // An alarm can only notify a topic in its own region, and the ops topic
    // is in the main region.
    const frontend = stacks.JaleFrontendStack;
    expect(frontend.region).toBe('us-east-1');
    const topics = Object.entries(frontend.template.Resources as Record<string, Json>)
      .filter(([, r]) => r.Type === 'AWS::SNS::Topic');
    expect(topics).toHaveLength(1);
    const [topicId] = topics[0];
    for (const constructId of ['SesBounceCountUsEast1Alarm', 'SesReputationBounceRateUsEast1Alarm']) {
      expect(alarmByConstructId(frontend.template, constructId).Properties.AlarmActions).toEqual([{ Ref: topicId }]);
    }
  });

  it("owns the admin CDN error alarm in a us-east-1 stack, on CloudFront's global metric, notifying that region's topic", () => {
    const owners = Object.entries(stacks).flatMap(([stackName, { region, template }]) => Object.values(alarmsOf(template))
      .filter((alarm) => alarm.Properties.AlarmName === 'jale-admin-cloudfront-5xx')
      .map((alarm) => ({ stackName, region, template, alarm })));
    expect(owners).toHaveLength(1);
    const [{ region, template, alarm }] = owners;
    expect(region).toBe('us-east-1');
    expect(alarm.Properties).toMatchObject({
      Namespace: 'AWS/CloudFront',
      MetricName: '5xxErrorRate',
      Statistic: 'Average',
      Period: 300,
      Threshold: 5,
      EvaluationPeriods: 2,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
    const dimensions = Object.fromEntries((alarm.Properties.Dimensions as Json[]).map((d) => [d.Name, d.Value]));
    expect(Object.keys(dimensions).sort()).toEqual(['DistributionId', 'Region']);
    expect(dimensions.Region).toBe('Global');
    // The admin distribution's id, carried over from the admin stack.
    expect(JSON.stringify(dimensions.DistributionId)).toMatch(/JaleAdminStack/);
    const topics = Object.entries(template.Resources as Record<string, Json>).filter(([, r]) => r.Type === 'AWS::SNS::Topic');
    expect(topics).toHaveLength(1);
    expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topics[0][0] }]);
  });

  it('keeps every CloudFront alarm in a us-east-1 stack, the one region CloudFront publishes its metrics to', () => {
    const cloudFront = Object.entries(stacks).flatMap(([stackName, { region, template }]) => Object.values(alarmsOf(template))
      .filter((alarm) => readsNamespace(alarm, 'AWS/CloudFront'))
      .map((alarm) => ({ name: `${stackName}/${alarm.Properties.AlarmName}`, region })));
    expect(cloudFront.length).toBeGreaterThan(0);
    expect(cloudFront.filter((a) => a.region !== 'us-east-1').map((a) => a.name)).toEqual([]);
  });

  it('leaves only the deliberately action-less alarms without an action', () => {
    // The edge stacks' alarms are covered by the daily edge check. Any other
    // alarm without an action is one nobody would hear.
    const edgeStacks = new Set<string>(Object.values(EDGE_STACK_IDS));
    const silent: string[] = [];
    let total = 0;
    for (const [stackName, { template }] of Object.entries(stacks)) {
      for (const [id, alarm] of Object.entries(alarmsOf(template))) {
        total += 1;
        if ((alarm.Properties.AlarmActions ?? []).length > 0) continue;
        if (edgeStacks.has(stackName)) continue;
        silent.push(`${stackName}/${alarm.Properties.AlarmName ?? id}`);
      }
    }
    expect(total).toBeGreaterThan(100);
    expect(silent).toEqual([]);
  });
});
