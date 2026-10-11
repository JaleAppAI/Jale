import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import { loadManifest, type AccessManifest, type LoginEntry } from '../../../db/access/access-manifest';
import { Construct } from 'constructs';
import { buildJaleApp } from '../../../lib/app-composition';
import { PUBLIC_REPORTS_LOGIN } from '../../../lib/stacks/reports-stack';
import {
  appAccessManifest,
  dbLoginSecretName,
  dedicatedDbLogin,
  defaultAccessManifest,
  preparedSecretLogins,
  setAppAccessManifest,
} from '../../../lib/constructs/db-login-secrets';

/** The eight dedicated least-privilege logins. */
const CONTRACT_LOGINS = [
  'jale_api',
  'jale_api_public',
  'jale_job_digest',
  'jale_job_email_sender',
  'jale_job_retention',
  'jale_job_ses_feedback',
  'jale_job_visibility_drain',
  'jale_posture',
];

/** The service logins that predate the dedicated ones; their secrets are managed as before. */
const SERVICE_LOGINS = ['jale_admin_console', 'jale_ai', 'jale_billing', 'jale_matching', 'jale_public_jobs', 'jale_whatsapp'];

function entry(kind: LoginEntry['kind'], prepared: boolean): LoginEntry {
  return {
    kind,
    created_by: prepared ? '104' : 'pre-104',
    connection_limit: 5,
    ...(prepared ? { prepare_secret: true as const } : {}),
    workloads: 'A test workload.',
    reason: 'A test entry.',
  };
}

/** The real manifest with its login list replaced. Only the logins are read. */
function manifestWithLogins(logins: Record<string, LoginEntry>): AccessManifest {
  return { ...loadManifest(), logins };
}

/**
 * The dedicated least-privilege logins' secrets are created outside CDK (by
 * the ops-host credential preparation) and imported here by name, so the name
 * is the whole contract between the two sides. One helper derives it; these
 * tests pin that helper to the naming rule the existing login secrets already
 * follow, without spelling any resulting name out.
 */
describe('dedicated database login secrets', () => {
  it('prepares a secret for exactly the logins the manifest flags, in sorted order', () => {
    const manifest = manifestWithLogins({
      jale_job_zeta: entry('job', true),
      jale_service_old: entry('service', false),
      jale_api: entry('request', true),
    });
    expect(preparedSecretLogins(manifest)).toEqual(['jale_api', 'jale_job_zeta']);
  });

  it('flags the eight dedicated logins in the checked-in manifest, and no service login', () => {
    const prepared = preparedSecretLogins(loadManifest());
    expect(prepared).toEqual(expect.arrayContaining(CONTRACT_LOGINS));
    for (const login of SERVICE_LOGINS) expect(prepared).not.toContain(login);
  });

  it('refuses a flagged login that the naming rule cannot map to a secret name', () => {
    const manifest = manifestWithLogins({ jale_Api: entry('request', true) });
    expect(() => preparedSecretLogins(manifest)).toThrow(/DB_LOGIN_NAME_INVALID/);
  });

  it('reproduces the names the existing service-login secrets already use', () => {
    // The rule is not new: it is the one the existing secrets were named by.
    // Deriving their names back from their logins is what proves the helper
    // follows it rather than inventing a second scheme.
    const existing: Array<[string, string]> = [
      ['jale_whatsapp', ['jale', 'whatsapp', 'db'].join('/')],
      ['jale_matching', ['jale', 'matching', 'db'].join('/')],
      ['jale_ai', ['jale', 'ai', 'db'].join('/')],
      ['jale_billing', ['jale', 'billing', 'db'].join('/')],
      ['jale_admin_console', ['jale', 'admin-console', 'db'].join('/')],
    ];
    for (const [login, name] of existing) {
      expect(dbLoginSecretName(login)).toBe(name);
    }
  });

  it.each(preparedSecretLogins(loadManifest()))('derives the secret name of %s from the login alone', (login) => {
    const slug = login.replace(/^jale_/, '').replace(/_/g, '-');
    expect(dbLoginSecretName(login)).toBe(`jale/${slug}/db`);
  });

  it('gives every prepared login a distinct secret name', () => {
    const prepared = preparedSecretLogins(loadManifest());
    const names = prepared.map((login) => dbLoginSecretName(login));
    expect(new Set(names).size).toBe(prepared.length);
  });

  it.each(['jale_', 'admin', 'jale_Api', 'jale_api-public', 'jale__api', 'jale_api_', ''])(
    'refuses %j, which is not a jale_ login name',
    (bad) => {
      expect(() => dbLoginSecretName(bad)).toThrow(/login/i);
    },
  );

  describe('dedicatedDbLogin()', () => {
    function stack(): cdk.Stack {
      return new cdk.Stack(new cdk.App(), 'S', {
        env: { account: '111111111111', region: 'us-east-2' },
      });
    }

    it('imports the secret by name and creates no secret resource', () => {
      const s = stack();
      const binding = dedicatedDbLogin(s, 'jale_api');
      const fn = new iam.Role(s, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      binding.grantRead(fn);

      const template = Template.fromStack(s);
      template.resourceCountIs('AWS::SecretsManager::Secret', 0);
      expect(binding.login).toBe('jale_api');
      expect(s.resolve(binding.secret.secretName)).toBe(dbLoginSecretName('jale_api'));
    });

    it('feeds the pool getter the secret name and the login the boot check expects', () => {
      const s = stack();
      const binding = dedicatedDbLogin(s, 'jale_job_digest');
      expect(Object.keys(binding.environment).sort()).toEqual(['DB_EXPECTED_LOGIN', 'DB_SECRET_ARN']);
      expect(binding.environment.DB_EXPECTED_LOGIN).toBe('jale_job_digest');
      expect(s.resolve(binding.environment.DB_SECRET_ARN)).toBe(dbLoginSecretName('jale_job_digest'));
    });

    it('grants read on exactly that secret, suffix-wildcarded the way imported secrets are', () => {
      const s = stack();
      const role = new iam.Role(s, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      dedicatedDbLogin(s, 'jale_api_public').grantRead(role);

      const policies = Object.values(Template.fromStack(s).findResources('AWS::IAM::Policy')) as any[];
      const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as any[]);
      const reads = statements.filter((st) => [st.Action].flat().includes('secretsmanager:GetSecretValue'));
      expect(reads).toHaveLength(1);
      const resource = JSON.stringify(s.resolve(reads[0].Resource));
      expect(resource).toContain(`:secret:${dbLoginSecretName('jale_api_public')}-??????`);
    });

    it.each(['jale_whatsapp', 'jale_nobody'])('refuses to bind %s, which has no prepared secret in the manifest', (login) => {
      expect(() => dedicatedDbLogin(stack(), login)).toThrow(/DB_LOGIN_NOT_PREPARED/);
    });

    it('imports each login once per stack, however many workloads bind it', () => {
      const s = stack();
      const first = dedicatedDbLogin(s, 'jale_api');
      const second = dedicatedDbLogin(s, 'jale_api');
      expect(second.secret).toBe(first.secret);
      // A different login in the same stack is a different import.
      expect(dedicatedDbLogin(s, 'jale_api_public').secret).not.toBe(first.secret);
    });

    it('checks a binding against the manifest set on its app, from any scope in it', () => {
      const app = new cdk.App();
      const manifest = manifestWithLogins({ jale_job_zeta: entry('job', true) });
      setAppAccessManifest(app, manifest);
      const s = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'us-east-2' } });

      expect(appAccessManifest(new Construct(s, 'Nested'))).toBe(manifest);
      expect(dedicatedDbLogin(s, 'jale_job_zeta').login).toBe('jale_job_zeta');
      expect(() => dedicatedDbLogin(s, 'jale_api')).toThrow(/DB_LOGIN_NOT_PREPARED/);
      // An app with no manifest set on it reads the checked-in one.
      expect(appAccessManifest(stack())).toBe(defaultAccessManifest());
      expect(dedicatedDbLogin(stack(), 'jale_api').login).toBe('jale_api');
    });
  });

  /**
   * The composition takes an access manifest (only a test passes one), and
   * every workload's login binding in that app is checked against it, the
   * same manifest the posture check and the ops-host secret access use.
   * Composed through the real composition, in dev, with the CI synth's
   * context keys holding fictitious values. Nothing is bundled: a binding is
   * refused while the tree is built, and only the reservation case
   * synthesizes, to read the template.
   */
  describe('the manifest given to the composition', () => {
    const INFRA_ROOT = path.join(__dirname, '../../..');
    const FIXTURE_LOGIN = 'jale_job_fixture';

    function context(): Record<string, unknown> {
      const readJson = (file: string): Record<string, unknown> => {
        const full = path.join(INFRA_ROOT, file);
        return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {};
      };
      return {
        ...(readJson('cdk.json').context as Record<string, unknown> ?? {}),
        ...readJson('cdk.context.json'),
        environment: 'dev',
        skipFrontend: 'true',
        'aws:cdk:bundling-stacks': [],
        emailFromAddress: 'billing@example.com',
        sesVerifiedIdentityArn: 'arn:aws:ses:us-east-2:111122223333:identity/example.com',
        sesEmailFromAddress: 'no-reply@example.com',
        sesEmailRegion: 'us-east-1',
        whatsappStatusCallbackUrl: 'https://example.com/whatsapp/status-callback',
        whatsappAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
        billingAlarmTopicArn: 'arn:aws:sns:us-east-2:111122223333:jale-alarms',
        publicSiteBaseUrl: 'https://example.com',
        sesConfigurationSetName: 'jale-test-employer-email',
        whatsappBusinessNumber: '15551234567',
      };
    }

    /** Composes the whole app, with a placeholder account and region (the audit stacks need a concrete one). */
    function compose(accessManifest?: AccessManifest): cdk.App {
      const saved = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
      process.env.CDK_DEFAULT_ACCOUNT = '111111111111';
      process.env.CDK_DEFAULT_REGION = 'us-east-2';
      try {
        const app = new cdk.App({ context: context() });
        buildJaleApp(app, accessManifest ? { accessManifest } : {});
        return app;
      } finally {
        for (const [key, name] of [['account', 'CDK_DEFAULT_ACCOUNT'], ['region', 'CDK_DEFAULT_REGION']] as const) {
          if (saved[key] === undefined) delete process.env[name];
          else process.env[name] = saved[key];
        }
      }
    }

    /** The checked-in manifest, with no prepared secret for `login`. */
    function withoutPreparedSecret(login: string): AccessManifest {
      const manifest = loadManifest();
      expect(manifest.logins[login]?.prepare_secret).toBe(true);
      const { prepare_secret: _dropped, ...rest } = manifest.logins[login];
      return { ...manifest, logins: { ...manifest.logins, [login]: rest } };
    }

    /** The checked-in manifest, plus one job login that only this copy prepares. */
    function withFixtureLogin(): AccessManifest {
      const manifest = loadManifest();
      expect(manifest.logins[FIXTURE_LOGIN]).toBeUndefined();
      return { ...manifest, logins: { ...manifest.logins, [FIXTURE_LOGIN]: entry('job', true) } };
    }

    function extraStack(app: cdk.App, id: string): cdk.Stack {
      return new cdk.Stack(app, id, { env: { account: '111111111111', region: 'us-east-2' } });
    }

    // Bound by the posture check in the database stack, by the API's
    // functions, and by the digest job in the notifications stack.
    it.each(['jale_posture', 'jale_api', 'jale_job_digest'])(
      'refuses to compose when the given manifest prepares no secret for %s, which a workload binds',
      (login) => {
        expect(() => compose(withoutPreparedSecret(login))).toThrow(`DB_LOGIN_NOT_PREPARED: ${JSON.stringify(login)}`);
      },
    );

    it("reserves the signed-out report intake at the given manifest's connection limit for its login", () => {
      const manifest = loadManifest();
      const entryFor = manifest.logins[PUBLIC_REPORTS_LOGIN];
      const changed = entryFor.connection_limit + 3;
      const app = compose({ ...manifest, logins: { ...manifest.logins, [PUBLIC_REPORTS_LOGIN]: { ...entryFor, connection_limit: changed } } });
      const reports = app.node.findChild('JaleReportsStack') as cdk.Stack;
      const intake = Template.fromStack(reports).findResources('AWS::Lambda::Function', {
        Properties: { Description: 'Report a problem: signed-out intake' },
      });
      expect(Object.values(intake).map((fn: any) => fn.Properties.ReservedConcurrentExecutions)).toEqual([changed]);
    });

    it('binds a login that only the given manifest prepares, in that app and in no other', () => {
      const app = compose(withFixtureLogin());
      expect(dedicatedDbLogin(extraStack(app, 'Extra'), FIXTURE_LOGIN).login).toBe(FIXTURE_LOGIN);
      // Another app in the same process keeps the checked-in manifest.
      expect(() => dedicatedDbLogin(extraStack(compose(), 'Extra'), FIXTURE_LOGIN)).toThrow(/DB_LOGIN_NOT_PREPARED/);
      expect(() => dedicatedDbLogin(extraStack(new cdk.App(), 'Extra'), FIXTURE_LOGIN)).toThrow(/DB_LOGIN_NOT_PREPARED/);
    });
  });
});
