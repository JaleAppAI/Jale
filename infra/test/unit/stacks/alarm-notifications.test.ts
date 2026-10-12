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
  ['JaleAdminStack', 'AdminCloudFront5xxAlarm'],
];

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

  it('leaves only the deliberately action-less alarms without an action', () => {
    // The edge stacks' alarms are covered by the daily edge check, and the
    // report capture share is report-only. Any other alarm without an action
    // is one nobody would hear.
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
    expect(silent).toEqual(['JaleReportsStack/ReportCaptureSuccessShare']);
  });
});
