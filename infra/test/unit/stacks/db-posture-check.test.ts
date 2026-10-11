import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { buildJaleApp } from '../../../lib/app-composition';
import { dbLoginSecretName } from '../../../lib/constructs/db-login-secrets';
import { loadManifest, manifestDigest, parseManifest, type AccessManifest } from '../../../db/access/access-manifest';
import { CHANGE_LOG_FILE, loadChangeLog } from '../../../db/access/posture-audit';

/**
 * The database posture check's resources in JaleDatabaseStack:
 * the function and the merged access manifest its bundle carries, the daily
 * rule, the three alarms, the deploy role's managed policy and the outputs
 * the deploy gate reads.
 *
 * Synthesized through the real composition, narrowed with `bastionOnly`
 * (network, database and ops host only), once against the checked-in
 * manifest and once against a copy with a fixture fragment, which proves a
 * login that exists only in a fragment reaches both the posture bundle and
 * the ops host's secret access.
 */

type Json = any;
type Templates = Record<string, Json>;

const INFRA_ROOT = path.join(__dirname, '../../..');
const ACCESS_DIR = path.join(INFRA_ROOT, 'db/access');
const PLACEHOLDER_ACCOUNT = '111111111111';
const PLACEHOLDER_REGION = 'us-east-2';
const ALARM_TOPIC = 'arn:aws:sns:us-east-2:111122223333:jale-alarms';
const FIXTURE_LOGIN = 'jale_job_fixture';

interface Synth {
  templates: Templates;
  assemblyDir: string;
}

function cliContext(extra: Record<string, unknown>): Record<string, unknown> {
  const readJson = (file: string): Record<string, unknown> => {
    const full = path.join(INFRA_ROOT, file);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {};
  };
  return {
    ...(readJson('cdk.json').context as Record<string, unknown> ?? {}),
    ...readJson('cdk.context.json'),
    environment: 'dev',
    bastionOnly: 'true',
    'aws:cdk:enable-path-metadata': true,
    'aws:cdk:enable-asset-metadata': true,
    ...extra,
  };
}

function synth(context: Record<string, unknown>, accessManifest?: AccessManifest): Synth {
  const app = new cdk.App({ context: cliContext(context) });
  buildJaleApp(app, accessManifest ? { accessManifest } : {});
  const assembly = app.synth();
  return {
    templates: Object.fromEntries(assembly.stacks.map((s) => [s.stackName, s.template])),
    assemblyDir: assembly.directory,
  };
}

function postureFunction(s: Synth): { logicalId: string; resource: Json } {
  const resources = s.templates.JaleDatabaseStack.Resources;
  const ids = Object.keys(resources).filter((id) =>
    resources[id].Type === 'AWS::Lambda::Function'
    && resources[id].Metadata?.['aws:cdk:path'] === 'JaleDatabaseStack/DbPosture/Function/Function/Resource');
  expect(ids).toHaveLength(1);
  return { logicalId: ids[0], resource: resources[ids[0]] };
}

function bundleDir(s: Synth): string {
  const assetPath = postureFunction(s).resource.Metadata?.['aws:asset:path'];
  expect(typeof assetPath).toBe('string');
  return path.join(s.assemblyDir, assetPath);
}

function bundledManifest(s: Synth): Json {
  return JSON.parse(fs.readFileSync(path.join(bundleDir(s), 'access-manifest.json'), 'utf8'));
}

function alarm(s: Synth, name: string): Json {
  const found = Object.values(s.templates.JaleDatabaseStack.Resources as Record<string, Json>)
    .filter((r) => r.Type === 'AWS::CloudWatch::Alarm' && r.Properties.AlarmName === name);
  expect(found).toHaveLength(1);
  return found[0].Properties;
}

function roleStatements(s: Synth, roleLogicalId: string): Json[] {
  return Object.values(s.templates.JaleDatabaseStack.Resources as Record<string, Json>)
    .filter((r) => r.Type === 'AWS::IAM::Policy'
      && (r.Properties.Roles ?? []).some((role: Json) => role.Ref === roleLogicalId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement);
}

function bastionSecretStatements(s: Synth): Json[] {
  const resources = s.templates.JaleBastionStack.Resources as Record<string, Json>;
  const roleId = Object.keys(resources).find((id) =>
    resources[id].Type === 'AWS::IAM::Role'
    && resources[id].Metadata?.['aws:cdk:path'] === 'JaleBastionStack/Bastion/Resource/InstanceRole/Resource');
  expect(roleId).toBeDefined();
  return Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && (r.Properties.Roles ?? []).some((role: Json) => role.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement);
}

/** A copy of the checked-in manifest with one extra job login in a fragment. */
function fixtureManifestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-manifest-fixture-'));
  fs.copyFileSync(path.join(ACCESS_DIR, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.mkdirSync(path.join(dir, 'manifest.d'));
  const checkedInFragments = path.join(ACCESS_DIR, 'manifest.d');
  if (fs.existsSync(checkedInFragments)) {
    for (const name of fs.readdirSync(checkedInFragments).filter((n) => n.endsWith('.json'))) {
      fs.copyFileSync(path.join(checkedInFragments, name), path.join(dir, 'manifest.d', name));
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.d', 'zz-test-fixture.json'), JSON.stringify({
    logins: {
      [FIXTURE_LOGIN]: {
        kind: 'job',
        created_by: '999',
        connection_limit: 5,
        prepare_secret: true,
        workloads: 'A fixture job that exists only in a fragment.',
        reason: 'Proves fragment logins reach the posture bundle and the ops host.',
      },
    },
  }));
  return dir;
}

describe('database posture check resources', () => {
  let saved: { account?: string; region?: string };
  let checkedIn: Synth;
  let withFragment: Synth;
  let fixtureDir: string;

  beforeAll(() => {
    saved = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
    process.env.CDK_DEFAULT_ACCOUNT = PLACEHOLDER_ACCOUNT;
    process.env.CDK_DEFAULT_REGION = PLACEHOLDER_REGION;

    checkedIn = synth({ whatsappAlarmTopicArn: ALARM_TOPIC });
    fixtureDir = fixtureManifestDir();
    withFragment = synth({}, loadManifest(fixtureDir));
  });

  afterAll(() => {
    if (saved.account === undefined) delete process.env.CDK_DEFAULT_ACCOUNT;
    else process.env.CDK_DEFAULT_ACCOUNT = saved.account;
    if (saved.region === undefined) delete process.env.CDK_DEFAULT_REGION;
    else process.env.CDK_DEFAULT_REGION = saved.region;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  describe('the bundled manifest', () => {
    it('is the merged manifest from disk, so its digest is the synth-time digest', () => {
      const bundled = bundledManifest(checkedIn);
      expect(bundled).toEqual(loadManifest());
      expect(manifestDigest(parseManifest(bundled))).toBe(manifestDigest(loadManifest()));
    });

    it("carries a fragment's entry", () => {
      const bundled = bundledManifest(withFragment);
      expect(bundled.logins[FIXTURE_LOGIN]).toMatchObject({ kind: 'job', prepare_secret: true });
      expect(bundled).toEqual(loadManifest(fixtureDir));
    });

    it('sits next to the handler with the RDS CA bundle', () => {
      const files = fs.readdirSync(bundleDir(checkedIn)).sort();
      expect(files).toEqual(expect.arrayContaining(['access-manifest.json', 'index.js', 'rds-ca-bundle.pem']));
    });

    it('carries the audit change-log file next to the handler, byte for byte, where the audit checks read it', () => {
      const bundled = path.join(bundleDir(checkedIn), CHANGE_LOG_FILE);
      expect(fs.readFileSync(bundled, 'utf8')).toBe(fs.readFileSync(path.join(ACCESS_DIR, CHANGE_LOG_FILE), 'utf8'));
      expect(() => loadChangeLog(bundleDir(checkedIn))).not.toThrow();
    });
  });

  describe('the ops host', () => {
    it("can prepare a login that exists only in a fragment, under the helper's name", () => {
      const pattern = `arn:aws:secretsmanager:${PLACEHOLDER_REGION}:${PLACEHOLDER_ACCOUNT}:secret:${dbLoginSecretName(FIXTURE_LOGIN)}*`;
      const preparing = bastionSecretStatements(withFragment).filter((st) =>
        [st.Action].flat().includes('secretsmanager:CreateSecret')
        && ![st.Action].flat().includes('secretsmanager:PutSecretValue'));
      expect(preparing).toHaveLength(1);
      const resources = [preparing[0].Resource].flat();
      expect(resources.filter((r: string) => r === pattern)).toHaveLength(1);
      // And the checked-in manifest has no such login.
      expect(JSON.stringify(bastionSecretStatements(checkedIn))).not.toContain(dbLoginSecretName(FIXTURE_LOGIN));
    });
  });

  describe('the function', () => {
    it('connects as the posture login through its own secret only', () => {
      const { resource } = postureFunction(checkedIn);
      expect(resource.Properties.Environment.Variables).toEqual({
        DB_SECRET_ARN: dbLoginSecretName('jale_posture'),
        DB_EXPECTED_LOGIN: 'jale_posture',
        // Every database Lambda gets the audit fallback group.
        AUDIT_FALLBACK_LOG_GROUP: '/jale/audit/fallback',
      });

      const roleId = resource.Properties.Role['Fn::GetAtt'][0];
      const secretStatements = roleStatements(checkedIn, roleId)
        .filter((st) => [st.Action].flat().some((a: string) => a.startsWith('secretsmanager:')));
      expect(secretStatements).toHaveLength(1);
      expect(JSON.stringify(secretStatements[0].Resource)).toContain(`:secret:${dbLoginSecretName('jale_posture')}-??????`);
      expect([secretStatements[0].Resource].flat()).toHaveLength(1);
    });

    it('runs in the VPC like the other database Lambdas, on the runtime and timeout it was given', () => {
      const props = postureFunction(checkedIn).resource.Properties;
      expect(props.Runtime).toBe('nodejs24.x');
      expect(props.VpcConfig.SubnetIds.length).toBeGreaterThan(0);
      expect(JSON.stringify(props.VpcConfig.SecurityGroupIds)).toMatch(/LambdaSg/);
      expect(props.Timeout).toBe(60);
    });

    it('does not reference the database instance, whose logical id is unchanged', () => {
      const resources = checkedIn.templates.JaleDatabaseStack.Resources;
      expect(resources.DatabaseB269D8BB?.Type).toBe('AWS::RDS::DBInstance');
      expect(JSON.stringify(postureFunction(checkedIn).resource)).not.toContain('DatabaseB269D8BB');
    });
  });

  describe('the daily rule', () => {
    it('invokes the function once a day as a daily run, outside the maintenance window', () => {
      const { logicalId } = postureFunction(checkedIn);
      const rules = Object.values(checkedIn.templates.JaleDatabaseStack.Resources as Record<string, Json>)
        .filter((r) => r.Type === 'AWS::Events::Rule');
      expect(rules).toHaveLength(1);
      const rule = rules[0].Properties;
      expect(rule.ScheduleExpression).toBe('cron(0 10 * * ? *)');
      expect(rule.State).toBe('ENABLED');
      expect(rule.Targets).toHaveLength(1);
      expect(rule.Targets[0].Arn).toEqual({ 'Fn::GetAtt': [logicalId, 'Arn'] });
      expect(JSON.parse(rule.Targets[0].Input)).toEqual({ trigger: 'daily' });

      const permissions = Object.values(checkedIn.templates.JaleDatabaseStack.Resources as Record<string, Json>)
        .filter((r) => r.Type === 'AWS::Lambda::Permission' && r.Properties.Principal === 'events.amazonaws.com');
      expect(permissions).toHaveLength(1);
    });
  });

  describe('the alarms', () => {
    it('alarms on any not-clean run', () => {
      expect(alarm(checkedIn, 'DbPostureRunNotClean')).toMatchObject({
        Namespace: 'Jale/Database',
        MetricName: 'DbPostureRunNotClean',
        Statistic: 'Sum',
        Period: 3600,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [ALARM_TOPIC],
      });
      expect(alarm(checkedIn, 'DbPostureRunNotClean').Dimensions).toBeUndefined();
    });

    it('alarms when no clean run has landed for 26 hours, counting silence as a breach', () => {
      expect(alarm(checkedIn, 'DbPostureNoCleanRun')).toMatchObject({
        Namespace: 'Jale/Database',
        MetricName: 'DbPostureRunClean',
        Statistic: 'Sum',
        Period: 3600,
        EvaluationPeriods: 26,
        DatapointsToAlarm: 26,
        Threshold: 1,
        ComparisonOperator: 'LessThanThreshold',
        TreatMissingData: 'breaching',
        AlarmActions: [ALARM_TOPIC],
      });
      expect(alarm(checkedIn, 'DbPostureNoCleanRun').Dimensions).toBeUndefined();
    });

    it("alarms on any workload's failed boot identity check", () => {
      expect(alarm(checkedIn, 'DbIdentityCheckFailed')).toMatchObject({
        Namespace: 'Jale/Database',
        MetricName: 'DbIdentityCheckFailed',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [ALARM_TOPIC],
      });
      expect(alarm(checkedIn, 'DbIdentityCheckFailed').Dimensions).toBeUndefined();
    });

    it('still creates the alarms without a topic, with no actions', () => {
      for (const name of ['DbPostureRunNotClean', 'DbPostureNoCleanRun', 'DbIdentityCheckFailed']) {
        expect(alarm(withFragment, name).AlarmActions).toBeUndefined();
      }
    });
  });

  describe('the deploy role policy and the outputs', () => {
    it('grants exactly what the gate needs, attached to nothing', () => {
      const { logicalId } = postureFunction(checkedIn);
      const policies = Object.values(checkedIn.templates.JaleDatabaseStack.Resources as Record<string, Json>)
        .filter((r) => r.Type === 'AWS::IAM::ManagedPolicy');
      expect(policies).toHaveLength(1);
      const props = policies[0].Properties;
      expect(props.ManagedPolicyName).toBe('JaleDbPostureGate');
      expect(props.Roles).toBeUndefined();
      expect(props.Users).toBeUndefined();
      expect(props.Groups).toBeUndefined();

      const statements = props.PolicyDocument.Statement.map((st: Json) => ({
        Action: st.Action,
        Resource: st.Resource,
        Effect: st.Effect,
      }));
      expect(statements).toEqual(expect.arrayContaining([
        { Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [logicalId, 'Arn'] }, Effect: 'Allow' },
        { Action: 'cloudwatch:GetMetricData', Resource: '*', Effect: 'Allow' },
        {
          Action: 'cloudformation:DescribeStacks',
          Resource: `arn:aws:cloudformation:${PLACEHOLDER_REGION}:${PLACEHOLDER_ACCOUNT}:stack/JaleDatabaseStack/*`,
          Effect: 'Allow',
        },
      ]));
      expect(statements).toHaveLength(3);
    });

    it('outputs the function name and the policy name, and exports neither', () => {
      const { logicalId } = postureFunction(checkedIn);
      const outputs = checkedIn.templates.JaleDatabaseStack.Outputs;
      expect(outputs.DbPostureFunctionName.Value).toEqual({ Ref: logicalId });
      expect(outputs.DbPostureGatePolicyName.Value).toBe('JaleDbPostureGate');
      expect(outputs.DbPostureFunctionName.Export).toBeUndefined();
      expect(outputs.DbPostureGatePolicyName.Export).toBeUndefined();
    });
  });
});
