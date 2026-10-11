/**
 * The prepared-login secrets check, run by the deploy job before it deploys
 * (`.github/workflows/_reusable-deploy.yml`, "Check prepared-login secrets"):
 *
 *   cd infra && npx --no-install tsx scripts/check-prepared-login-secrets.ts
 *
 * The stacks import each prepared login's secret by name
 * (lib/constructs/db-login-secrets.ts). Such an import deploys whether or not
 * the secret exists, and a workload whose secret is missing or scheduled for
 * deletion cannot connect. So before the deploy, every one of those secrets
 * must exist and must not be scheduled for deletion; otherwise the job fails.
 *
 * The names come from the stacks' own helpers (`preparedSecretLogins`,
 * `defaultAccessManifest`, `dbLoginSecretName`), never from a second list,
 * so this check and the stacks cannot disagree. DescribeSecret reads a
 * secret's metadata only, never its value.
 *
 * The run log of this repository is public. The check prints counts and
 * fixed sentences only: never a secret or login name, an ARN, the account,
 * or AWS error text, whose AccessDenied messages carry the account, the role
 * and the secret name. The workflow discards the script's stderr as well.
 *
 * It fails closed: an access error, or any other failure to check, fails the
 * job with one fixed sentence.
 */
import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { dbLoginSecretName, defaultAccessManifest, preparedSecretLogins } from '../lib/constructs/db-login-secrets';

/** The one Secrets Manager call the check makes. The SDK client satisfies it; the tests pass a fake. */
export interface SecretsManagerCommandClient {
  send(command: DescribeSecretCommand): Promise<unknown>;
}

export const ACCESS_ERROR = '::error::The deploy role needs secretsmanager:DescribeSecret on the prepared-login secrets.';
export const CHECK_ERROR = '::error::The prepared-login secrets could not be checked, so the deploy stops here.';
const NONE_DERIVED = '::error::No prepared login was derived from the access manifest, so nothing was checked.';

/** Every prepared login's secret name, derived as the stacks derive the names they import. */
export function preparedLoginSecretNames(): string[] {
  return preparedSecretLogins(defaultAccessManifest()).map(dbLoginSecretName);
}

type Found = 'present' | 'scheduled-for-deletion';
type Failure = 'missing' | 'access-denied' | 'error';

/** An SDK error reduced to a kind; its text is never kept. */
function classify(error: unknown): Failure {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'ResourceNotFoundException') return 'missing';
  if (name === 'AccessDeniedException') return 'access-denied';
  return 'error';
}

async function describe(client: SecretsManagerCommandClient, name: string): Promise<Found | Failure> {
  let response: unknown;
  try {
    response = await client.send(new DescribeSecretCommand({ SecretId: name }));
  } catch (error) {
    return classify(error);
  }
  const deletedDate = typeof response === 'object' && response !== null
    ? (response as { DeletedDate?: unknown }).DeletedDate
    : undefined;
  return deletedDate === undefined || deletedDate === null ? 'present' : 'scheduled-for-deletion';
}

export interface CheckOptions {
  readonly client: SecretsManagerCommandClient;
  /** The secret names to check; the deploy job checks `preparedLoginSecretNames()`. */
  readonly names: readonly string[];
  /** Receives each line the check prints. */
  readonly print: (line: string) => void;
}

/** Checks every secret in turn. Returns the exit status: 0 when all are present, 1 otherwise. */
export async function checkPreparedLoginSecrets({ client, names, print }: CheckOptions): Promise<number> {
  let present = 0;
  let missing = 0;
  let scheduled = 0;
  for (const name of names) {
    const outcome = await describe(client, name);
    if (outcome === 'access-denied') {
      print(ACCESS_ERROR);
      return 1;
    }
    if (outcome === 'error') {
      print(CHECK_ERROR);
      return 1;
    }
    if (outcome === 'present') present += 1;
    else if (outcome === 'missing') missing += 1;
    else scheduled += 1;
  }

  print(`prepared-login secrets present: ${present} of ${names.length}`);
  if (names.length === 0) {
    print(NONE_DERIVED);
    return 1;
  }
  if (present !== names.length) {
    print(
      `::error::Prepared-login secrets not ready: ${missing} missing, ${scheduled} scheduled for deletion. `
      + 'Prepare the missing logins (scripts/run-migrations.sh --prepare-logins) and restore any secret '
      + 'scheduled for deletion before deploying.',
    );
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const names = preparedLoginSecretNames();
  const client = new SecretsManagerClient({});
  try {
    return await checkPreparedLoginSecrets({ client, names, print: (line) => process.stdout.write(`${line}\n`) });
  } finally {
    client.destroy();
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write(`${CHECK_ERROR}\n`);
      process.exitCode = 1;
    },
  );
}
