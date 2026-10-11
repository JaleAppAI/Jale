import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { buildJaleApp } from '../../../lib/app-composition';
import { DB_AUDIT_ENGINE_WINDOW } from '../../../lib/stacks/database-stack';
import { flatten, resourcesOf, statements } from './audit-template-helpers';
import { EXPECTED_DB_LOGIN } from './db-lambda-logins';

/**
 * The audit system's wiring across the REAL composition:
 * the three audit stacks, the fallback variable and grant on every database
 * Lambda and the admin Lambda, the deploy ordering, and the ops host's grants
 * on the ops-command group.
 */

const INFRA_ROOT = path.join(__dirname, '../../..');
const PLACEHOLDER_ACCOUNT = '111111111111';
const PLACEHOLDER_REGION = 'us-east-2';

const PRODUCTION_CONTEXT: Record<string, unknown> = {
  environment: 'production',
  deletionProtection: 'true',
  emailFromAddress: 'billing@example.com',
  sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:111122223333:identity/example.com',
  sesEmailFromAddress: 'no-reply@example.com',
  sesEmailRegion: 'us-east-1',
  whatsappStatusCallbackUrl: 'https://example.com/whatsapp/status-callback',
  whatsappAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
  billingAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
  whatsappInboundV2TransportEnabled: 'true',
  sesConfigurationSetName: 'jale-test-employer-email',
  publicSiteBaseUrl: 'https://jaleapp.ai',
  whatsappBusinessNumber: '15551234567',
  guardDutyMode: 'create',
  securityHubMode: 'create',
  configMode: 'create',
  dbSharedPreloadLibrariesDefault: 'pg_stat_statements',
};

function cliContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const readJson = (file: string): Record<string, unknown> => {
    const full = path.join(INFRA_ROOT, file);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {};
  };
  return {
    ...(readJson('cdk.json').context as Record<string, unknown> ?? {}),
    ...readJson('cdk.context.json'),
    ...PRODUCTION_CONTEXT,
    'aws:cdk:enable-path-metadata': true,
    ...extra,
  };
}

const DB_SECRET_ENV_VARS = ['DB_SECRET_ARN', 'REFERRALS_DB_SECRET_ARN', 'MATCHING_DB_SECRET_ARN'];
const FALLBACK_GROUP = '/jale/audit/fallback';
// With a concrete region CDK writes the partition literally; the account and
// region stay pseudo-parameters, as the names helper builds them.
const FALLBACK_ARN = 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/jale/audit/fallback';
const OPS_COMMAND_ARN = 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/jale/audit/ops-command';

type Json = any;

function withPlaceholderEnv<T>(fn: () => T): T {
  const saved = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION, phase: process.env.JALE_WORKER_JOBS_RENAME_PHASE1 };
  process.env.CDK_DEFAULT_ACCOUNT = PLACEHOLDER_ACCOUNT;
  process.env.CDK_DEFAULT_REGION = PLACEHOLDER_REGION;
  delete process.env.JALE_WORKER_JOBS_RENAME_PHASE1;
  try {
    return fn();
  } finally {
    for (const [key, name] of [['account', 'CDK_DEFAULT_ACCOUNT'], ['region', 'CDK_DEFAULT_REGION'], ['phase', 'JALE_WORKER_JOBS_RENAME_PHASE1']] as const) {
      const value = saved[key];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('audit wiring (real composition)', () => {
  let templates: Record<string, Json>;
  let dependencies: Record<string, string[]>;
  let regions: Record<string, string | undefined>;

  beforeAll(() => {
    withPlaceholderEnv(() => {
      const app = new cdk.App({ context: cliContext() });
      buildJaleApp(app);
      const assembly = app.synth();
      templates = Object.fromEntries(assembly.stacks.map((s) => [s.stackName, flatten(s.template)]));
      dependencies = Object.fromEntries(assembly.stacks.map((s) => [s.stackName, s.dependencies.map((d) => d.id)]));
      regions = Object.fromEntries(assembly.stacks.map((s) => [s.stackName, s.environment.region]));
    });
  });

  /** Every Lambda (a database one or not), with its stack, logical id, env and role statements. */
  function lambdas(): Array<{ stack: string; id: string; path: string; env: Record<string, Json>; statements: Json[] }> {
    const out = [];
    for (const [stack, template] of Object.entries(templates)) {
      for (const [id, fn] of Object.entries(resourcesOf(template, 'AWS::Lambda::Function'))) {
        const roleId = /^\$\{(.+)\.Arn\}$/.exec(String(fn.Properties.Role ?? ''))?.[1];
        const policies = Object.values(resourcesOf(template, 'AWS::IAM::Policy'))
          .filter((p) => roleId && (p.Properties.Roles as string[]).includes(`\${${roleId}}`));
        out.push({
          stack,
          id,
          path: String(template.Resources[id].Metadata?.['aws:cdk:path'] ?? ''),
          env: fn.Properties.Environment?.Variables ?? {},
          statements: policies.flatMap((p) => statements(p.Properties.PolicyDocument)),
        });
      }
    }
    return out;
  }

  const isDbLambda = (env: Record<string, Json>) => DB_SECRET_ENV_VARS.some((name) => name in env);

  /** A Lambda's `<stack>/<construct id>`, the key of the login table. */
  const tableKey = (cdkPath: string) => cdkPath.split('/').slice(0, 2).join('/');

  it('composes the audit stacks: archive and audit in the main region, an edge stack in us-east-1 and us-west-2', () => {
    expect(regions.JaleAuditArchiveStack).toBe(PLACEHOLDER_REGION);
    expect(regions.JaleAuditStack).toBe(PLACEHOLDER_REGION);
    expect(regions.JaleAuditEdgeStack).toBe('us-east-1');
    expect(regions.JaleAuditEdgeUsWest2Stack).toBe('us-west-2');
  });

  it('gives the sentinel every database function that has a fixed name, by stack and exact name, and no other', () => {
    const fixed = Object.entries(templates).flatMap(([stack, template]) => Object.values(resourcesOf(template, 'AWS::Lambda::Function'))
      .filter((fn) => typeof fn.Properties.FunctionName === 'string')
      .filter((fn) => DB_SECRET_ENV_VARS.some((name) => name in (fn.Properties.Environment?.Variables ?? {})))
      .map((fn) => `${stack}/${fn.Properties.FunctionName}`)).sort();
    expect(fixed).toContain('JaleAdminStack/jale-admin-nextjs');
    const sentinel = lambdas().find((l) => l.stack === 'JaleAuditStack' && 'AUDIT_ADMIN_POOL_NAME' in l.env)!;
    expect(sentinel.env.AUDIT_FIXED_FUNCTIONS.split(',').sort()).toEqual(fixed);
  });

  it("gives the sentinel the exact names of the app's stacks", () => {
    const sentinel = lambdas().find((l) => l.stack === 'JaleAuditStack' && 'AUDIT_ADMIN_POOL_NAME' in l.env)!;
    expect(sentinel.env.AUDIT_APP_STACKS.split(',')).toEqual(Object.keys(templates).sort());
  });

  it('names the master secret in the sentinel configuration only, and grants the audit stack nothing on it', () => {
    // The master secret's export (the instance identifier is imported too, from window 2).
    const imports = [...new Set(JSON.stringify(templates.JaleAuditStack).match(/\$\{import:JaleDatabaseStack:ExportsOutputRefDatabaseSecretAttachment[^}]+\}/g) ?? [])];
    const sentinel = lambdas().find((l) => l.stack === 'JaleAuditStack' && 'AUDIT_ADMIN_POOL_NAME' in l.env)!;
    expect(imports).toHaveLength(1);
    for (const imported of imports) {
      expect(JSON.stringify(sentinel.env.AUDIT_MASTER_SECRET_ARN)).toContain(imported);
      const inPolicies = Object.values(resourcesOf(templates.JaleAuditStack, 'AWS::IAM::Policy')).some((p) => JSON.stringify(p).includes(imported));
      expect(inPolicies).toBe(false);
    }
  });

  it('gives every database Lambda and the admin Lambda the fallback group, and only those', () => {
    const all = lambdas();
    const db = all.filter((l) => isDbLambda(l.env));
    // Exactly the login table's set (and so its count), the one the
    // least-privilege suite pins, so a Lambda that loses its database
    // variable fails here too.
    expect(db.map((l) => tableKey(l.path)).sort()).toEqual(Object.keys(EXPECTED_DB_LOGIN).sort());
    expect(db.map((l) => l.path)).toEqual(expect.arrayContaining([expect.stringMatching(/^JaleAdminStack\/AdminNextjsFunction\//)]));
    const missing = db.filter((l) => l.env.AUDIT_FALLBACK_LOG_GROUP !== FALLBACK_GROUP).map((l) => l.path);
    expect(missing).toEqual([]);
    const extra = all.filter((l) => !isDbLambda(l.env) && 'AUDIT_FALLBACK_LOG_GROUP' in l.env).map((l) => l.path);
    expect(extra).toEqual([]);
  });

  it('lets each of them create a stream and put events in the fallback group, and nothing more there', () => {
    const problems: string[] = [];
    for (const l of lambdas().filter((x) => isDbLambda(x.env))) {
      const onGroup = l.statements.filter((s) => JSON.stringify(s.Resource).includes('/jale/audit/fallback'));
      const expected = [{ Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Effect: 'Allow', Resource: `${FALLBACK_ARN}:*` }];
      const found = onGroup.map(({ Sid: _s, ...rest }) => rest);
      if (JSON.stringify(found) !== JSON.stringify(expected)) problems.push(`${l.path}: ${JSON.stringify(found)}`);
    }
    expect(problems).toEqual([]);
  });

  it('deploys every stack whose functions write to the fallback group after the audit stack', () => {
    const writers = new Set(lambdas().filter((l) => isDbLambda(l.env)).map((l) => l.stack));
    writers.delete('JaleDatabaseStack');
    writers.delete('JaleAuditStack');
    const tableStacks = new Set(Object.keys(EXPECTED_DB_LOGIN).map((key) => key.split('/')[0]));
    tableStacks.delete('JaleDatabaseStack');
    tableStacks.delete('JaleAuditStack');
    expect([...writers].sort()).toEqual([...tableStacks].sort());
    for (const stack of writers) expect([stack, dependencies[stack]]).toEqual([stack, expect.arrayContaining(['JaleAuditStack'])]);
    expect(dependencies.JaleAuditStack).toEqual(expect.arrayContaining(['JaleAuditArchiveStack']));
    expect(dependencies.JaleDatabaseStack ?? []).not.toContain('JaleAuditStack');
  });

  describe('the ops host', () => {
    /** Every statement on the ops host's role: the one role its instance profile carries. */
    function opsHostStatements(): Json[] {
      const template = templates.JaleBastionStack;
      const profiles = Object.values(resourcesOf(template, 'AWS::IAM::InstanceProfile'));
      expect(profiles).toHaveLength(1);
      const [roleRef] = profiles[0].Properties.Roles as string[];
      expect(roleRef).toMatch(/^\$\{[A-Za-z0-9]+\}$/);
      const found = Object.values(resourcesOf(template, 'AWS::IAM::Policy'))
        .filter((p) => (p.Properties.Roles as string[]).includes(roleRef))
        .flatMap((p) => statements(p.Properties.PolicyDocument));
      expect(found.length).toBeGreaterThan(0);
      return found;
    }

    it('writes Run Command output to the ops-command group, can describe it, and can never create a group', () => {
      const logs = opsHostStatements().filter((s) => [s.Action].flat().some((a: string) => a.startsWith('logs:')));
      expect(logs.map(({ Sid: _s, ...rest }) => rest)).toEqual([
        { Action: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'], Effect: 'Allow', Resource: [OPS_COMMAND_ARN, `${OPS_COMMAND_ARN}:*`] },
        { Action: 'logs:DescribeLogGroups', Effect: 'Allow', Resource: '*' },
      ]);
      const actions = opsHostStatements().flatMap((s) => [s.Action].flat());
      expect(actions).not.toContain('logs:CreateLogGroup');
      expect(actions).not.toContain('logs:*');
    });

    it("can read no personal login's secret", () => {
      const secretArn = `arn:aws:secretsmanager:${PLACEHOLDER_REGION}:${PLACEHOLDER_ACCOUNT}:secret:jale/person-example/db-AbCdEf`;
      const toRegex = (pattern: string) => new RegExp(`^${pattern
        .replace(/\$\{AWS::Partition\}/g, 'aws').replace(/\$\{AWS::Region\}/g, PLACEHOLDER_REGION).replace(/\$\{AWS::AccountId\}/g, PLACEHOLDER_ACCOUNT)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      const reads = opsHostStatements().filter((s) => s.Effect === 'Allow'
        && [s.Action].flat().some((a: string) => ['*', 'secretsmanager:*', 'secretsmanager:GetSecretValue', 'secretsmanager:BatchGetSecretValue'].includes(a)));
      const resources = reads.flatMap((s) => [s.Resource].flat());
      // Not vacuous: the host reads the prepared logins' secrets, and the
      // pattern turns ARNs into matchers that do match their own secrets.
      expect(resources.length).toBeGreaterThan(0);
      const ownSecret = `arn:aws:secretsmanager:${PLACEHOLDER_REGION}:${PLACEHOLDER_ACCOUNT}:secret:jale/job-audit-export/db-AbCdEf`;
      expect(resources.some((r) => typeof r === 'string' && toRegex(r).test(ownSecret))).toBe(true);
      const matching = resources.filter((r) => typeof r === 'string' && toRegex(r).test(secretArn));
      expect(matching).toEqual([]);
    });
  });

  it('names the report-images bucket the same way in the reports stack and in the audit trail', () => {
    const buckets = Object.values(resourcesOf(templates.JaleReportsStack, 'AWS::S3::Bucket')).map((b) => b.Properties.BucketName);
    expect(buckets).toEqual([expect.stringMatching(/^jale-report-images-/)]);
    const trails = Object.values(resourcesOf(templates.JaleAuditStack, 'AWS::CloudTrail::Trail'));
    expect(trails).toHaveLength(1);
    const objectReads = (trails[0].Properties.AdvancedEventSelectors as Json[])
      .flatMap((selector) => selector.FieldSelectors as Json[])
      .filter((field) => field.Field === 'resources.ARN')
      .flatMap((field) => field.StartsWith as string[])
      .map((prefix) => /^arn:(?:\$\{AWS::Partition\}|[a-z-]+):s3:::([^/]+)\/$/.exec(prefix)?.[1]);
    expect(objectReads.every((name) => name !== undefined)).toBe(true);
    expect(objectReads).toContain(buckets[0]);
  });

  it('spells the report-images bucket name once, in the builder the reports stack exports', () => {
    const source = (file: string) => fs.readFileSync(path.join(INFRA_ROOT, 'lib', 'stacks', file), 'utf8');
    expect(source('reports-stack.ts').match(/jale-report-images-/g)).toHaveLength(1);
    expect(source('reports-stack.ts')).toMatch(/^export function reportImagesBucketName\(\): string \{$/m);
    expect(source('audit-stack.ts')).not.toMatch(/jale-report-images-/);
    expect(source('audit-stack.ts')).toMatch(/^import \{[^}]*\breportImagesBucketName\b[^}]*\} from '\.\/reports-stack';$/m);
  });

  it("keeps the sentinel's environment inside Lambda's 4 KB, with every reference at its longest", () => {
    // Lambda measures the variables as one JSON object and refuses more than
    // 4 KB at deploy time; a synth never notices. Each pseudo-parameter is
    // sized at its longest value, and every other reference (a name, an ARN,
    // an import) at 256 characters, more than any of them can resolve to.
    const sentinel = lambdas().find((l) => l.stack === 'JaleAuditStack' && 'AUDIT_ADMIN_POOL_NAME' in l.env)!;
    const longest: Record<string, number> = { 'AWS::Partition': 10, 'AWS::Region': 14, 'AWS::AccountId': 12, 'AWS::URLSuffix': 16 };
    const sized = Object.fromEntries(Object.entries(sentinel.env).map(([name, value]) => {
      if (typeof value !== 'string') throw new Error(`${name}: an intrinsic this check cannot size`);
      return [name, value.replace(/\$\{([^}]+)\}/g, (_match, token: string) => 'x'.repeat(longest[token] ?? 256))];
    }));
    // Not vacuous: the app's stacks and the sentinel's names are in it.
    expect(Object.keys(sized)).toEqual(expect.arrayContaining(['AUDIT_APP_STACKS', 'AUDIT_ALERT_TOPIC_ARN', 'AUDIT_MASTER_SECRET_ARN']));
    expect(JSON.stringify(sized).length).toBeLessThanOrEqual(4096);
  });

  it("names the admin pool the sentinel looks up exactly as AdminStack names it", () => {
    const pools = Object.values(resourcesOf(templates.JaleAdminStack, 'AWS::Cognito::UserPool')).map((p) => p.Properties.UserPoolName);
    const sentinel = lambdas().find((l) => l.stack === 'JaleAuditStack' && 'AUDIT_ADMIN_POOL_NAME' in l.env)!;
    expect(pools).toEqual([sentinel.env.AUDIT_ADMIN_POOL_NAME]);
  });

  it('puts no email address, subscription or person into any audit template', () => {
    for (const stack of ['JaleAuditArchiveStack', 'JaleAuditStack', 'JaleAuditEdgeStack', 'JaleAuditEdgeUsWest2Stack']) {
      const text = JSON.stringify(templates[stack]);
      expect(text).not.toMatch(/[\w.-]+@[\w-]+\.[A-Za-z]{2,}/);
      expect(text).not.toMatch(/:(user|group)\//);
      expect(Object.keys(resourcesOf(templates[stack], 'AWS::SNS::Subscription'))).toEqual([]);
    }
  });

  it('creates the engine log group only from window 2, named after the instance', () => {
    const groups = Object.values(resourcesOf(templates.JaleAuditStack, 'AWS::Logs::LogGroup')).map((g) => String(g.Properties.LogGroupName));
    const engine = groups.filter((n) => n.startsWith('/aws/rds/instance/'));
    if (DB_AUDIT_ENGINE_WINDOW >= 2) {
      expect(engine).toEqual([expect.stringMatching(/^\/aws\/rds\/instance\/\$\{import:JaleDatabaseStack:[A-Za-z0-9]+\}\/postgresql$/)]);
      expect(dependencies.JaleAuditStack).toContain('JaleDatabaseStack');
    } else {
      expect(engine).toEqual([]);
    }
  });

  it('fails a production synth with a detection flag unset', () => {
    withPlaceholderEnv(() => {
      const app = new cdk.App({ context: cliContext({ guardDutyMode: undefined, 'aws:cdk:bundling-stacks': [] }) });
      expect(() => buildJaleApp(app)).toThrow('AUDIT_MODE_REQUIRED');
    });
  });

  it('fails a production synth without the preload pre-check value', () => {
    withPlaceholderEnv(() => {
      const app = new cdk.App({ context: cliContext({ dbSharedPreloadLibrariesDefault: undefined, 'aws:cdk:bundling-stacks': [] }) });
      expect(() => buildJaleApp(app)).toThrow('AUDIT_PRELOAD_DEFAULT_REQUIRED');
    });
  });
});
