import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { buildJaleApp } from '../../../lib/app-composition';
import { DatabaseStack } from '../../../lib/stacks/database-stack';
import { dbLoginSecretName } from '../../../lib/constructs/db-login-secrets';
import { loadManifest } from '../../../db/access/access-manifest';
import { EXPECTED_DB_LOGIN } from './db-lambda-logins';

/**
 * ── Least-privilege database wiring, asserted over the REAL composition ──
 *
 * Which database login a Lambda uses is decided by one thing: the secret its
 * environment names. Every assertion here therefore reads the synthesized app
 * `bin/jale-app.ts` deploys (`lib/app-composition.ts`), never a per-stack
 * harness with stand-in secrets: a harness that hands a stack a fake secret
 * proves nothing about which real secret the deployed role can read.
 *
 * The context mirrors the production deploy workflow, plus an SES
 * configuration set name so the conditional SES feedback handler exists and
 * is checked like every other database Lambda.
 */

const INFRA_ROOT = path.join(__dirname, '../../..');
const PLACEHOLDER_ACCOUNT = '111111111111';
const PLACEHOLDER_REGION = 'us-east-2';

const PRODUCTION_LIKE_CONTEXT: Record<string, unknown> = {
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
  // The audit stacks' required production context. Placeholder
  // values: the pre-checks decide the real ones.
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
    ...PRODUCTION_LIKE_CONTEXT,
    // The CLI sets this; `new cdk.App()` does not. Without it no resource
    // carries its `aws:cdk:path`, which is how Lambdas are named below and
    // what the CLI-synthesized base template of the matching secret carries.
    'aws:cdk:enable-path-metadata': true,
  };
}

/** One environment variable per pool getter. */
const DB_SECRET_ENV_VARS = ['DB_SECRET_ARN', 'REFERRALS_DB_SECRET_ARN', 'MATCHING_DB_SECRET_ARN'] as const;

type Json = any;
type Templates = Record<string, { Resources: Record<string, Json>; Outputs?: Record<string, Json> }>;

interface DbLambda {
  key: string;
  stack: string;
  logicalId: string;
  env: Record<string, Json>;
  roleLogicalId: string;
}

/**
 * The logins whose secrets credential preparation creates, read straight off
 * the access manifest's flag rather than through the helper under test.
 */
function preparedLogins(): string[] {
  return Object.entries(loadManifest().logins)
    .filter(([, entry]) => entry.prepare_secret === true)
    .map(([name]) => name)
    .sort();
}

function readActions(statement: Json): boolean {
  const actions: string[] = [statement.Action].flat();
  return statement.Effect === 'Allow' && actions.some((a) =>
    a === '*' || a === 'secretsmanager:*' || a === 'secretsmanager:GetSecretValue');
}

/** Every statement granted to `roleLogicalId`, from attached policies and inline policies. */
function roleStatements(templates: Templates, stack: string, roleLogicalId: string): Json[] {
  const resources = templates[stack].Resources;
  const statements: Json[] = [];
  const role = resources[roleLogicalId];
  for (const inline of role?.Properties?.Policies ?? []) {
    statements.push(...[inline.PolicyDocument.Statement].flat());
  }
  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::IAM::Policy' && resource.Type !== 'AWS::IAM::ManagedPolicy') continue;
    const roles: Json[] = resource.Properties?.Roles ?? [];
    if (roles.some((r) => r?.Ref === roleLogicalId)) {
      statements.push(...[resource.Properties.PolicyDocument.Statement].flat());
    }
  }
  return statements;
}

function findImportValues(value: Json, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) findImportValues(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'Fn::ImportValue' && typeof v === 'string') out.push(v);
      else findImportValues(v, out);
    }
  }
  return out;
}

describe('least-privilege database wiring (real bin/jale-app.ts composition)', () => {
  let templates: Templates;
  let database: DatabaseStack;
  let masterLogicalIds: Set<string>;
  let masterExports: Set<string>;
  let dbLambdas: DbLambda[];
  let savedEnv: { account?: string; region?: string; renamePhase1?: string };

  /** Logical id a DatabaseStack export resolves to (`Ref` or `Fn::GetAtt`). */
  function exportTarget(exportName: string): { logicalId: string; attribute?: string } | undefined {
    for (const output of Object.values(templates.JaleDatabaseStack.Outputs ?? {})) {
      if (output?.Export?.Name !== exportName) continue;
      if (output.Value?.Ref) return { logicalId: output.Value.Ref };
      const getAtt = output.Value?.['Fn::GetAtt'];
      if (getAtt) return { logicalId: getAtt[0], attribute: getAtt[1] };
    }
    return undefined;
  }

  /** The login a DatabaseStack secret (or secret attachment) was generated for. */
  function loginOfGeneratedSecret(logicalId: string): string | undefined {
    const resources = templates.JaleDatabaseStack.Resources;
    let resource = resources[logicalId];
    if (resource?.Type === 'AWS::SecretsManager::SecretTargetAttachment') {
      resource = resources[resource.Properties.SecretId.Ref];
    }
    if (resource?.Type !== 'AWS::SecretsManager::Secret') return undefined;
    const raw = JSON.stringify(resource.Properties?.GenerateSecretString?.SecretStringTemplate ?? '');
    return /username\\*"\s*:\s*\\*"([a-z_]+)/.exec(raw)?.[1];
  }

  /** Imported-by-name secrets the app knows, mapped to their logins. */
  function loginOfSecretName(name: string): string | undefined {
    const known = [...preparedLogins(), 'jale_whatsapp'];
    return known.find((login) => dbLoginSecretName(login) === name);
  }

  /** The login whose secret an environment-variable value names. */
  function loginOfEnvValue(value: Json): string | undefined {
    if (typeof value === 'string') return loginOfSecretName(value);
    const imports = findImportValues(value);
    if (imports.length !== 1) return undefined;
    const target = exportTarget(imports[0]);
    return target ? loginOfGeneratedSecret(target.logicalId) : undefined;
  }

  /** Database logins whose secrets a role can read. */
  function readableLogins(stack: string, roleLogicalId: string): string[] {
    const logins = new Set<string>();
    for (const statement of roleStatements(templates, stack, roleLogicalId)) {
      if (!readActions(statement)) continue;
      for (const resource of [statement.Resource].flat()) {
        const raw = JSON.stringify(resource);
        for (const match of raw.matchAll(/:secret:([a-z0-9/-]+)-\?{6}/g)) {
          const login = loginOfSecretName(match[1]);
          if (login) logins.add(login);
        }
        for (const exportName of findImportValues(resource)) {
          const target = exportTarget(exportName);
          const login = target ? loginOfGeneratedSecret(target.logicalId) : undefined;
          if (login) logins.add(login);
        }
        if (stack === 'JaleDatabaseStack' && resource?.Ref) {
          const login = loginOfGeneratedSecret(resource.Ref);
          if (login) logins.add(login);
        }
      }
    }
    return [...logins].sort();
  }

  /** True when a resource entry could match the master secret. */
  function coversMaster(stack: string, resource: Json): boolean {
    if (resource === '*') return true;
    const raw = JSON.stringify(resource);
    if (/:secret:\*/.test(raw)) return true;
    if (findImportValues(resource).some((name) => masterExports.has(name))) return true;
    return stack === 'JaleDatabaseStack' && masterLogicalIds.has(resource?.Ref);
  }

  beforeAll(() => {
    savedEnv = {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
      renamePhase1: process.env.JALE_WORKER_JOBS_RENAME_PHASE1,
    };
    process.env.CDK_DEFAULT_ACCOUNT = PLACEHOLDER_ACCOUNT;
    process.env.CDK_DEFAULT_REGION = PLACEHOLDER_REGION;
    delete process.env.JALE_WORKER_JOBS_RENAME_PHASE1;

    const app = new cdk.App({ context: cliContext() });
    buildJaleApp(app);
    const assembly = app.synth();
    templates = Object.fromEntries(assembly.stacks.map((s) => [s.stackName, s.template]));

    database = app.node.findChild('JaleDatabaseStack') as DatabaseStack;
    const masterRef = cdk.Stack.of(database).resolve(database.dbSecret.secretArn);
    const attachment = templates.JaleDatabaseStack.Resources[masterRef.Ref];
    masterLogicalIds = new Set([masterRef.Ref, attachment?.Properties?.SecretId?.Ref].filter(Boolean));
    masterExports = new Set(
      Object.values(templates.JaleDatabaseStack.Outputs ?? {})
        .filter((o: Json) => masterLogicalIds.has(o?.Value?.Ref))
        .map((o: Json) => o.Export.Name),
    );

    dbLambdas = [];
    for (const [stack, template] of Object.entries(templates)) {
      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== 'AWS::Lambda::Function') continue;
        const env: Record<string, Json> = resource.Properties?.Environment?.Variables ?? {};
        if (!DB_SECRET_ENV_VARS.some((name) => name in env)) continue;
        const cdkPath: string = resource.Metadata?.['aws:cdk:path'] ?? '';
        dbLambdas.push({
          key: cdkPath.split('/').slice(0, 2).join('/'),
          stack,
          logicalId,
          env,
          roleLogicalId: resource.Properties.Role['Fn::GetAtt'][0],
        });
      }
    }
  });

  afterAll(() => {
    if (savedEnv.account === undefined) delete process.env.CDK_DEFAULT_ACCOUNT;
    else process.env.CDK_DEFAULT_ACCOUNT = savedEnv.account;
    if (savedEnv.region === undefined) delete process.env.CDK_DEFAULT_REGION;
    else process.env.CDK_DEFAULT_REGION = savedEnv.region;
    if (savedEnv.renamePhase1 === undefined) delete process.env.JALE_WORKER_JOBS_RENAME_PHASE1;
    else process.env.JALE_WORKER_JOBS_RENAME_PHASE1 = savedEnv.renamePhase1;
  });

  it('finds the master secret and its export, so the checks below are not vacuous', () => {
    expect(masterLogicalIds.size).toBeGreaterThan(0);
    expect(masterExports.size).toBe(1);
    expect(dbLambdas.length).toBeGreaterThan(50);
  });

  // ── The master secret ─────────────────────────────────────────────────

  it('lets no role read the master database secret except the ops host', () => {
    const readers: string[] = [];
    for (const [stack, template] of Object.entries(templates)) {
      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== 'AWS::IAM::Role') continue;
        const reads = roleStatements(templates, stack, logicalId)
          .some((st) => readActions(st) && [st.Resource].flat().some((r: Json) => coversMaster(stack, r)));
        if (reads) readers.push(resource.Metadata?.['aws:cdk:path'] ?? `${stack}/${logicalId}`);
      }
    }
    // The ops host keeps it: migrations and the posture control run there.
    expect(readers).toEqual(['JaleBastionStack/Bastion/Resource/InstanceRole/Resource']);
  });

  it('no Lambda execution role can read the master database secret', () => {
    const offenders: string[] = [];
    for (const [stack, template] of Object.entries(templates)) {
      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        if (resource.Type !== 'AWS::Lambda::Function') continue;
        const roleId = resource.Properties?.Role?.['Fn::GetAtt']?.[0];
        if (!roleId) continue;
        const reads = roleStatements(templates, stack, roleId)
          .some((st) => readActions(st) && [st.Resource].flat().some((r: Json) => coversMaster(stack, r)));
        if (reads) offenders.push(`${stack}/${logicalId}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('leaves the master secret referenced only by its own stack and the ops host', () => {
    const referencing = Object.entries(templates)
      .filter(([stack]) => stack !== 'JaleDatabaseStack')
      .filter(([, template]) => findImportValues(template).some((name) => masterExports.has(name)))
      .map(([stack]) => stack)
      .sort();
    // JaleAuditStack names it in the sentinel's configuration and is granted
    // nothing on it (audit-wiring.test.ts proves both).
    expect(referencing).toEqual(['JaleAuditStack', 'JaleBastionStack']);
  });

  it('keeps every DatabaseStack export that a deployed stack may still import', () => {
    // CloudFormation refuses to delete an export that is still in use, and
    // DatabaseStack deploys BEFORE the stacks that stop importing it. Dropping
    // any of these in the same release would fail the deploy at DatabaseStack.
    const exported = new Set(
      Object.values(templates.JaleDatabaseStack.Outputs ?? {}).map((o: Json) => o?.Export?.Name),
    );
    for (const name of [
      'JaleDatabaseStack:ExportsOutputRefDatabaseSecretAttachmentE5D1B020633AEB73',
      'JaleDatabaseStack:ExportsOutputRefMatchingDbSecret6775445F8BEC9BB8',
      'JaleDatabaseStack:ExportsOutputRefAiDbSecret99D8A326A1877543',
      'JaleDatabaseStack:ExportsOutputRefAdminConsoleDbSecretDC8F3B6BB24A4DD8',
      'JaleDatabaseStack:ExportsOutputRefBillingDbSecret2A67594FED41CCA0',
      'JaleDatabaseStack:ExportsOutputRefReferralsDbSecretFDE19E5E58F7A3B8',
    ]) {
      expect(exported.has(name)).toBe(true);
    }
  });

  // ── One login per Lambda ─────────────────────────────────────────────

  it('lists every database Lambda in the login table, and nothing else', () => {
    const found = dbLambdas.map((l) => l.key).sort();
    expect(found).toEqual(Object.keys(EXPECTED_DB_LOGIN).sort());
  });

  it('gives each database Lambda exactly one database secret variable and the login its boot check expects', () => {
    const problems: string[] = [];
    for (const lambda of dbLambdas) {
      const secretVars = DB_SECRET_ENV_VARS.filter((name) => name in lambda.env);
      if (secretVars.length !== 1) problems.push(`${lambda.key}: ${secretVars.length} database secret variables`);
      const expected = lambda.env.DB_EXPECTED_LOGIN;
      if (expected !== EXPECTED_DB_LOGIN[lambda.key]) {
        problems.push(`${lambda.key}: DB_EXPECTED_LOGIN ${JSON.stringify(expected)}, want ${EXPECTED_DB_LOGIN[lambda.key]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('points each database Lambda at the secret of the login it expects', () => {
    const problems: string[] = [];
    for (const lambda of dbLambdas) {
      for (const name of DB_SECRET_ENV_VARS.filter((n) => n in lambda.env)) {
        const login = loginOfEnvValue(lambda.env[name]);
        if (login !== EXPECTED_DB_LOGIN[lambda.key]) {
          problems.push(`${lambda.key}: ${name} belongs to ${login ?? 'an unknown secret'}, want ${EXPECTED_DB_LOGIN[lambda.key]}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("lets each database Lambda's role read its own login's secret and no other login's", () => {
    const problems: string[] = [];
    for (const lambda of dbLambdas) {
      const readable = readableLogins(lambda.stack, lambda.roleLogicalId);
      const expected = [EXPECTED_DB_LOGIN[lambda.key]];
      if (JSON.stringify(readable) !== JSON.stringify(expected)) {
        problems.push(`${lambda.key}: reads ${JSON.stringify(readable)}, want ${JSON.stringify(expected)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('matches the expected per-login counts', () => {
    const counts: Record<string, number> = {};
    for (const login of Object.values(EXPECTED_DB_LOGIN)) counts[login] = (counts[login] ?? 0) + 1;
    expect(counts).toEqual({
      jale_api: 49,
      jale_api_public: 3,
      jale_api_public_reports: 1,
      jale_job_report_cleanup: 1,
      jale_job_email_sender: 1,
      jale_job_visibility_drain: 1,
      jale_job_digest: 1,
      jale_job_ses_feedback: 1,
      jale_job_retention: 1,
      jale_job_audit_export: 1,
      jale_posture: 1,
      jale_whatsapp: 12,
      jale_ai: 4,
      jale_public_jobs: 5,
      jale_billing: 1,
      jale_matching: 1,
      jale_admin_console: 1,
    });
  });

  it('gives the rerank Lambda the instance endpoint instead of any master-secret field', () => {
    const rerank = dbLambdas.find((l) => l.key === 'JaleMatchingStack/EmployerCandidateRerankLambda');
    expect(rerank).toBeDefined();
    const env = rerank!.env;
    expect(env.DB_SECRET_ARN).toBeUndefined();
    expect(loginOfEnvValue(env.MATCHING_DB_SECRET_ARN)).toBe('jale_matching');
    expect(env.DB_EXPECTED_LOGIN).toBe('jale_matching');

    const host = findImportValues(env.DB_HOST);
    const port = findImportValues(env.DB_PORT);
    expect(host).toHaveLength(1);
    expect(port).toHaveLength(1);
    const instanceId = cdk.Stack.of(database).resolve(database.dbInstance.instanceIdentifier).Ref;
    expect(exportTarget(host[0])).toEqual({ logicalId: instanceId, attribute: 'Endpoint.Address' });
    expect(exportTarget(port[0])).toEqual({ logicalId: instanceId, attribute: 'Endpoint.Port' });
    expect(env.DB_NAME).toBe('jale');
  });

  // ── The ops host ─────────────────────────────────────────────────────

  describe('ops-host IAM', () => {
    function bastionStatements(): Json[] {
      const resources = templates.JaleBastionStack.Resources;
      const roleId = Object.keys(resources).find((id) =>
        resources[id].Type === 'AWS::IAM::Role'
        && resources[id].Metadata?.['aws:cdk:path'] === 'JaleBastionStack/Bastion/Resource/InstanceRole/Resource');
      expect(roleId).toBeDefined();
      return roleStatements(templates, 'JaleBastionStack', roleId!);
    }

    const pattern = (name: string): string =>
      `arn:aws:secretsmanager:${PLACEHOLDER_REGION}:${PLACEHOLDER_ACCOUNT}:secret:${name}*`;

    it('gives every prepared-secret login exactly one secret name in the ops-host statement, and no others', () => {
      const statements = bastionStatements().filter((st) =>
        [st.Action].flat().includes('secretsmanager:CreateSecret')
        && ![st.Action].flat().includes('secretsmanager:PutSecretValue'));
      expect(statements).toHaveLength(1);
      const statement = statements[0];
      const resources = [statement.Resource].flat() as string[];
      expect(new Set(resources).size).toBe(resources.length);
      expect([...resources].sort()).toEqual(preparedLogins().map((login) => pattern(dbLoginSecretName(login))).sort());
      expect([statement.Action].flat().sort()).toEqual([
        'secretsmanager:CreateSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:TagResource',
      ]);
      expect(statement.Effect).toBe('Allow');
    });

    it('can never overwrite a dedicated login secret', () => {
      // --prepare-logins reuses an existing secret or creates a missing one;
      // it never rotates implicitly, so it needs no PutSecretValue there.
      const dedicated = new Set(preparedLogins().map((login) => pattern(dbLoginSecretName(login))));
      const overwriting = bastionStatements().filter((st) =>
        [st.Action].flat().some((a: string) => a === 'secretsmanager:PutSecretValue' || a === 'secretsmanager:*')
        && [st.Resource].flat().some((r: Json) => dedicated.has(r)));
      expect(overwriting).toEqual([]);
    });

    it('can ask Secrets Manager for a random password, which has no resource form', () => {
      const generators = bastionStatements().filter((st) =>
        [st.Action].flat().includes('secretsmanager:GetRandomPassword'));
      expect(generators).toHaveLength(1);
      expect(generators[0].Resource).toBe('*');
    });

    it('keeps the existing service-secret statement exactly as it was', () => {
      const existing = ['admin-console', 'ai', 'billing', 'matching', 'referrals', 'whatsapp']
        .map((slug) => pattern(['jale', slug, 'db'].join('/')));
      const statement = bastionStatements().find((st) =>
        [st.Action].flat().includes('secretsmanager:PutSecretValue'));
      expect(statement).toEqual({
        Action: [
          'secretsmanager:CreateSecret',
          'secretsmanager:DescribeSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:TagResource',
        ],
        Effect: 'Allow',
        Resource: existing,
      });
    });
  });

  // ── The instance ─────────────────────────────────────────────────────

  describe('database instance engine settings', () => {
    function instance(): { logicalId: string; resource: Json } {
      const resources = templates.JaleDatabaseStack.Resources;
      const ids = Object.keys(resources).filter((id) => resources[id].Type === 'AWS::RDS::DBInstance');
      expect(ids).toHaveLength(1);
      return { logicalId: ids[0], resource: resources[ids[0]] };
    }

    /** Minutes since Sunday 00:00 UTC for a `ddd:hh:mm` (or daily `hh:mm`) point. */
    function weekMinute(point: string, day?: string): number {
      const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const parts = point.split(':');
      const [d, h, m] = parts.length === 3 ? parts : [day!, ...parts];
      return days.indexOf(d.toLowerCase()) * 1440 + Number(h) * 60 + Number(m);
    }

    it('turns automatic minor-version upgrades off', () => {
      expect(instance().resource.Properties.AutoMinorVersionUpgrade).toBe(false);
    });

    it('pins the maintenance window to Sunday 08:00-09:00 UTC and backups to 06:00-06:30 UTC daily', () => {
      const props = instance().resource.Properties;
      expect(props.PreferredMaintenanceWindow).toBe('sun:08:00-sun:09:00');
      expect(props.PreferredBackupWindow).toBe('06:00-06:30');
    });

    it('keeps the backup window clear of the maintenance window on every day of the week', () => {
      const props = instance().resource.Properties;
      const [mStart, mEnd] = props.PreferredMaintenanceWindow.split('-');
      const maintenance = [weekMinute(mStart), weekMinute(mEnd)];
      const [bStart, bEnd] = props.PreferredBackupWindow.split('-');
      for (const day of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
        const backup = [weekMinute(bStart, day), weekMinute(bEnd, day)];
        const overlaps = backup[0] < maintenance[1] && maintenance[0] < backup[1];
        expect(overlaps).toBe(false);
      }
      // RDS's own minimums: both windows are at least 30 minutes.
      expect(maintenance[1] - maintenance[0]).toBeGreaterThanOrEqual(30);
      expect(weekMinute(bEnd, 'sun') - weekMinute(bStart, 'sun')).toBeGreaterThanOrEqual(30);
    });

    it('keeps the instance, its master secret and the secret attachment under their existing logical ids', () => {
      const resources = templates.JaleDatabaseStack.Resources;
      expect(instance().logicalId).toBe('DatabaseB269D8BB');
      expect(resources.DatabaseSecretAttachmentE5D1B020).toMatchObject({
        Type: 'AWS::SecretsManager::SecretTargetAttachment',
        Properties: {
          SecretId: { Ref: 'JaleDatabaseStackDatabaseSecret89088DC33fdaad7efa858a3daf9490cf0a702aeb' },
          TargetId: { Ref: 'DatabaseB269D8BB' },
          TargetType: 'AWS::RDS::DBInstance',
        },
      });
      expect(resources.JaleDatabaseStackDatabaseSecret89088DC33fdaad7efa858a3daf9490cf0a702aeb?.Type)
        .toBe('AWS::SecretsManager::Secret');
    });
  });

  // ── The matching secret ──────────────────────────────────────────────

  it('leaves the matching secret byte-identical to the base commit', () => {
    // Captured from the base commit's synthesized template. Changing this
    // resource's generation settings would regenerate its value and break the
    // matching login's password, so any difference at all is a failure.
    expect(templates.JaleDatabaseStack.Resources.MatchingDbSecret6775445F).toEqual({
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Description: 'jale_matching role DB credentials for matching engine reads/writes',
        GenerateSecretString: {
          ExcludePunctuation: true,
          GenerateStringKey: 'password',
          SecretStringTemplate: '{"username":"jale_matching"}',
        },
        Name: ['jale', 'matching', 'db'].join('/'),
      },
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
      Metadata: { 'aws:cdk:path': 'JaleDatabaseStack/MatchingDbSecret/Resource' },
    });
  });
});
