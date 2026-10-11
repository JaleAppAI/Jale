import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { loadManifest, type AccessManifest } from '../../db/access/access-manifest';

/**
 * The dedicated least-privilege database logins whose credentials CDK does
 * NOT generate: every login the access manifest (`infra/db/access`) flags
 * with `prepare_secret: true`.
 *
 * Each one's secret is created, and the login's password set from it, by the
 * ops-host credential preparation (`scripts/run-migrations.sh
 * --prepare-logins`), which reads the same flag. CDK only imports the secret
 * by name, which is the pattern WhatsAppStack has always used for its own
 * login. An import by name deploys fine before the secret exists; the
 * workload simply cannot connect until the preparation has run, and that
 * ordering is part of the release runbook.
 *
 * The manifest is the one list. A login added later (its entry plus its
 * migration) gets its ops-host secret access from this function, with no
 * second list to update. Sorted, so the synthesized IAM is stable.
 */
export function preparedSecretLogins(manifest: AccessManifest): string[] {
  const logins = Object.entries(manifest.logins)
    .filter(([, entry]) => entry.prepare_secret === true)
    .map(([name]) => name)
    .sort();
  // A flagged login whose name the naming rule cannot map fails the synth
  // here, rather than producing a secret name nothing else would derive.
  for (const login of logins) dbLoginSecretName(login);
  return logins;
}

let checkedInManifest: AccessManifest | undefined;

/** The checked-in access manifest, read once per process. */
export function defaultAccessManifest(): AccessManifest {
  checkedInManifest ??= loadManifest();
  return checkedInManifest;
}

/**
 * The access manifest each app composes against, keyed by the root of the
 * app's construct tree; an app with no entry reads the checked-in one. The
 * keys are weak, so apps built one after another in the same process (as
 * tests do) never see each other's manifest.
 */
const appManifests = new WeakMap<object, AccessManifest>();

/**
 * Makes `manifest` the one every login binding in `scope`'s app is checked
 * against. The composition calls this once, before it builds any stack, with
 * the manifest it composes against.
 */
export function setAppAccessManifest(scope: Construct, manifest: AccessManifest): void {
  appManifests.set(scope.node.root, manifest);
}

/** The access manifest `scope`'s app composes against: the one set on the app, or else the checked-in one. */
export function appAccessManifest(scope: Construct): AccessManifest {
  return appManifests.get(scope.node.root) ?? defaultAccessManifest();
}

/** `jale_` followed by lowercase words joined by single underscores. */
const LOGIN_NAME = /^jale_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Login → Secrets Manager secret name. The ONE place the rule lives, so the
 * stacks, the ops-host IAM patterns and the credential preparation cannot
 * drift apart.
 *
 * It is the rule the existing login secrets were already named by: drop the
 * `jale_` prefix, turn underscores into hyphens, and put the result in the
 * `jale/<slug>/db` shape (so `jale_admin_console` gives the `admin-console`
 * slug). The public-jobs login is the one historical exception, and it is not
 * derived here.
 */
export function dbLoginSecretName(login: string): string {
  if (!LOGIN_NAME.test(login)) {
    throw new Error(
      `DB_LOGIN_NAME_INVALID: ${JSON.stringify(login)} is not a database login name `
      + '(expected jale_ followed by lowercase words joined by single underscores)',
    );
  }
  const slug = login.slice('jale_'.length).replace(/_/g, '-');
  return `jale/${slug}/db`;
}

/** What a workload needs to connect as one dedicated login. */
export interface DbLoginBinding {
  /** The login the workload must connect as. */
  readonly login: string;
  /** The login's secret, imported by name into the consuming stack. */
  readonly secret: secretsmanager.ISecret;
  /**
   * The two variables `getDbPool()` reads: which secret to fetch, and which
   * login its boot identity check must find. Spread it into a Lambda's
   * `environment`.
   */
  readonly environment: { readonly DB_SECRET_ARN: string; readonly DB_EXPECTED_LOGIN: string };
  /** Read access on this login's secret, and nothing else. */
  grantRead(grantee: iam.IGrantable): iam.Grant;
}

function pascalCase(login: string): string {
  return login
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Binds a workload in `scope`'s stack to one dedicated login.
 *
 * Only a login that the app's access manifest flags for a prepared secret can
 * be bound: any other login's secret would never be created, and the workload
 * could never connect. That manifest is the checked-in one, unless the
 * composition was given another (see `setAppAccessManifest`).
 *
 * The secret is imported INSIDE the consuming stack, once per stack, rather
 * than created in one stack and passed around: an imported secret is only an
 * ARN pattern, so importing it locally adds no cross-stack export, and every
 * stack that grants it stays independently deployable.
 */
export function dedicatedDbLogin(scope: Construct, login: string): DbLoginBinding {
  if (!preparedSecretLogins(appAccessManifest(scope)).includes(login)) {
    throw new Error(
      `DB_LOGIN_NOT_PREPARED: ${JSON.stringify(login)} has no prepared secret in the access manifest `
      + '(infra/db/access); a workload can only bind a login whose secret credential preparation creates',
    );
  }
  const stack = cdk.Stack.of(scope);
  const id = `DbLoginSecret${pascalCase(login)}`;
  const secret = (stack.node.tryFindChild(id) as secretsmanager.ISecret | undefined)
    ?? secretsmanager.Secret.fromSecretNameV2(stack, id, dbLoginSecretName(login));

  return {
    login,
    secret,
    environment: {
      // The NAME, not `secretArn`: an import by name only knows a partial ARN
      // (no random suffix), while Secrets Manager resolves a name exactly.
      // WhatsAppStack made the same choice for its own login.
      DB_SECRET_ARN: secret.secretName,
      DB_EXPECTED_LOGIN: login,
    },
    grantRead: (grantee) => secret.grantRead(grantee),
  };
}
