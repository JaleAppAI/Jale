import * as crypto from 'node:crypto';
import {
  DescribeSecretCommand,
  ResourceNotFoundException,
  SecretsManagerServiceException,
} from '@aws-sdk/client-secrets-manager';
import {
  dbLoginSecretName,
  defaultAccessManifest,
  preparedSecretLogins,
} from '../../../lib/constructs/db-login-secrets';
import {
  ACCESS_ERROR,
  CHECK_ERROR,
  checkPreparedLoginSecrets,
  preparedLoginSecretNames,
  type SecretsManagerCommandClient,
} from '../../../scripts/check-prepared-login-secrets';

/**
 * The deploy job's prepared-login secrets check
 * (scripts/check-prepared-login-secrets.ts), driven with a fake Secrets
 * Manager client: no credentials and no network.
 *
 * The names are the real ones, derived from the checked-in access manifest
 * by the stacks' own helpers, because they are exactly what must never reach
 * the run log of a public repository. The account and the role in the fake
 * AWS error text are made up at run time.
 */

const NAMES = preparedLoginSecretNames();
const LOGINS = preparedSecretLogins(defaultAccessManifest());
const ACCOUNT = Array.from(crypto.randomBytes(12), (b) => String(b % 10)).join('');
const ROLE = `deploy-role-${crypto.randomBytes(6).toString('hex')}`;
const arnOf = (name: string) => `arn:aws:secretsmanager:us-east-2:${ACCOUNT}:secret:${name}-${crypto.randomBytes(3).toString('hex')}`;

/** What DescribeSecret answers for one secret: present, scheduled for deletion, or an error. */
type Answer = 'present' | 'scheduled' | Error;

function fakeClient(answers: Record<string, Answer> = {}) {
  const asked: string[] = [];
  const client: SecretsManagerCommandClient = {
    send: async (command: unknown) => {
      if (!(command instanceof DescribeSecretCommand)) throw new Error('the check sent a command other than DescribeSecret');
      const name = String(command.input.SecretId);
      asked.push(name);
      const answer = answers[name] ?? 'present';
      if (answer instanceof Error) throw answer;
      // The real response carries the name and the ARN, which must never be printed.
      return answer === 'scheduled'
        ? { ARN: arnOf(name), Name: name, DeletedDate: new Date() }
        : { ARN: arnOf(name), Name: name };
    },
  };
  return { client, asked };
}

/** An AccessDenied the way Secrets Manager words one: the account, the role and the secret name. */
const accessDenied = (name: string) => new SecretsManagerServiceException({
  name: 'AccessDeniedException',
  $fault: 'client',
  $metadata: { httpStatusCode: 400 },
  message: `User: arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}/GitHubActions is not authorized to perform: `
    + `secretsmanager:DescribeSecret on resource: ${name} because no identity-based policy allows the `
    + 'secretsmanager:DescribeSecret action',
});
const notFound = () => new ResourceNotFoundException({
  message: "Secrets Manager can't find the specified secret.",
  $metadata: { httpStatusCode: 400 },
});
const throttled = (name: string) => new SecretsManagerServiceException({
  name: 'ThrottlingException',
  $fault: 'client',
  $metadata: { httpStatusCode: 400 },
  message: `Rate exceeded for ${arnOf(name)}`,
});

async function run(answers: Record<string, Answer> = {}, names: readonly string[] = NAMES) {
  const { client, asked } = fakeClient(answers);
  const lines: string[] = [];
  const exitCode = await checkPreparedLoginSecrets({ client, names, print: (line) => lines.push(line) });
  return { exitCode, lines, asked };
}

/** Every line the check may print: counts, or a fixed sentence. Digits are its only variable parts. */
const PRINTABLE = [
  /^prepared-login secrets present: \d+ of \d+$/,
  /^::error::Prepared-login secrets not ready: \d+ missing, \d+ scheduled for deletion\. [^0-9]+$/,
  /^::error::No prepared login was derived from the access manifest, so nothing was checked\.$/,
];

describe('the prepared-login secrets check', () => {
  it('derives the secret names with the stacks\' own helpers, one per prepared login', () => {
    expect(NAMES).toEqual(LOGINS.map(dbLoginSecretName));
    expect(NAMES.length).toBeGreaterThan(0);
    expect(new Set(NAMES).size).toBe(NAMES.length);
  });

  it('passes when every secret is present, printing the count only', async () => {
    const { exitCode, lines, asked } = await run();
    expect(exitCode).toBe(0);
    expect(lines).toEqual([`prepared-login secrets present: ${NAMES.length} of ${NAMES.length}`]);
    // Every derived name is described, once.
    expect(asked).toEqual(NAMES);
  });

  it('fails when a secret is missing, and still counts every secret', async () => {
    const { exitCode, lines, asked } = await run({ [NAMES[0]]: notFound() });
    expect(exitCode).toBe(1);
    expect(asked).toEqual(NAMES);
    expect(lines[0]).toBe(`prepared-login secrets present: ${NAMES.length - 1} of ${NAMES.length}`);
    expect(lines[1]).toMatch(/^::error::Prepared-login secrets not ready: 1 missing, 0 scheduled for deletion\. /);
    expect(lines).toHaveLength(2);
  });

  it('fails when a secret is scheduled for deletion', async () => {
    const { exitCode, lines } = await run({ [NAMES[NAMES.length - 1]]: 'scheduled' });
    expect(exitCode).toBe(1);
    expect(lines[0]).toBe(`prepared-login secrets present: ${NAMES.length - 1} of ${NAMES.length}`);
    expect(lines[1]).toMatch(/^::error::Prepared-login secrets not ready: 0 missing, 1 scheduled for deletion\. /);
    expect(lines).toHaveLength(2);
  });

  it.each([
    ['the first secret', 0],
    ['a later secret', NAMES.length - 1],
  ])('fails closed on an access error at %s, with one fixed sentence naming the permission', async (_where, at) => {
    const { exitCode, lines, asked } = await run({ [NAMES[at]]: accessDenied(NAMES[at]) });
    expect(exitCode).toBe(1);
    expect(lines).toEqual([ACCESS_ERROR]);
    expect(ACCESS_ERROR).toBe('::error::The deploy role needs secretsmanager:DescribeSecret on the prepared-login secrets.');
    // It stops at the error: no partial count, no further calls.
    expect(asked).toEqual(NAMES.slice(0, at + 1));
  });

  it.each([
    ['a throttled call', () => throttled(NAMES[0])],
    ['a network failure', () => Object.assign(new Error(`getaddrinfo ENOTFOUND secretsmanager.us-east-2.amazonaws.com`), { code: 'ENOTFOUND' })],
    ['a credentials failure', () => Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' })],
  ])('fails closed when the check cannot run (%s), with one fixed sentence', async (_case, error) => {
    const { exitCode, lines, asked } = await run({ [NAMES[0]]: error() });
    expect(exitCode).toBe(1);
    expect(lines).toEqual([CHECK_ERROR]);
    expect(asked).toEqual(NAMES.slice(0, 1));
  });

  it('fails when no prepared login is derived, without calling AWS', async () => {
    const { exitCode, lines, asked } = await run({}, []);
    expect(exitCode).toBe(1);
    expect(asked).toEqual([]);
    expect(lines[0]).toBe('prepared-login secrets present: 0 of 0');
    expect(lines).toHaveLength(2);
  });

  it('never prints a name, an ARN, the account, the role or AWS error text', async () => {
    const scenarios: Array<Record<string, Answer>> = [
      {},
      { [NAMES[0]]: notFound(), [NAMES[1]]: 'scheduled' },
      { [NAMES[1]]: accessDenied(NAMES[1]) },
      { [NAMES[0]]: throttled(NAMES[0]) },
    ];
    const printed: string[] = [];
    for (const answers of scenarios) printed.push(...(await run(answers)).lines);
    printed.push(...(await run({}, [])).lines);

    const text = printed.join('\n');
    for (const value of [...NAMES, ...LOGINS, ACCOUNT, ROLE]) expect(text).not.toContain(value);
    expect(text).not.toMatch(/arn:|jale\/|jale_|\d{12}|not authorized|Rate exceeded|can't find/);
    // Counts and fixed sentences only.
    for (const line of printed) {
      const fixed = line === ACCESS_ERROR || line === CHECK_ERROR || PRINTABLE.some((shape) => shape.test(line));
      expect({ line, fixed }).toEqual({ line, fixed: true });
    }
  });
});
