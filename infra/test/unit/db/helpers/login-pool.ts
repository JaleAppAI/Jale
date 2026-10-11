/**
 * login-pool.ts -- connect test code as a real database login on the local
 * test bed (infra/db/local/bootstrap-testbed.sh).
 *
 * WHY. A suite that drives handler code as the superuser, or through
 * `SET ROLE`, proves nothing about the grants and policies the deployed login
 * will meet: a superuser is not subject to row security, and `SET ROLE`
 * keeps the session's other settings. The `request` profile runs code under
 * test over a real authenticated connection as the login it uses when deployed
 * (`jale_api`, `jale_api_public`, a job login, `jale_whatsapp` ...), while
 * fixtures still go through the superuser URL the bed exports.
 *
 * PASSWORDS. Every login of the merged access manifest (manifest.json plus
 * its manifest.d fragments) gets a fixed test password on the bed, set in
 * step 8 of bootstrap-testbed.sh by infra/db/local/testbed-login-passwords.mjs:
 * `test-<name>-pw`, where <name> is the login without its `jale_` prefix and
 * without underscores (`jale_admin_console` -> `test-adminconsole-pw`). They
 * exist only on a disposable local container and are never secret-shaped.
 * login-pool.test.ts asserts that step 8 and `testPasswordFor` agree for every
 * login.
 *
 * SAFETY. Only a loopback test bed is accepted, and no URL is ever printed.
 *
 * PROFILES (JALE_TEST_DB_PROFILE, exported by bootstrap-testbed.sh):
 *   standard  the default bed.
 *   request   same database; code under test connects as its real login.
 *   owner-unrestricted
 *             handlers' own SQL scoping is exercised without depending on
 *             row policies.
 * Suites that apply to some profiles only declare it with
 * `describeInProfiles`, which records an explicit passing "not applicable"
 * test elsewhere instead of a skip, so a skipped test always means a missing
 * database rather than a profile choice.
 */
import { Client, Pool, type ClientConfig, type PoolConfig } from 'pg';
import { loadManifest } from '../../../../db/access/access-manifest';

export type DbProfile = 'standard' | 'request' | 'owner-unrestricted';
export const DB_PROFILES: readonly DbProfile[] = ['standard', 'request', 'owner-unrestricted'];

/**
 * Every login bootstrap-testbed.sh step 8 gives a test password: the logins
 * of the merged access manifest, fragments included, sorted. The master
 * (`jale_admin`) is not one of them: its password comes from the bootstrap's
 * own owner step.
 */
export const TEST_LOGINS: readonly string[] = Object.freeze(Object.keys(loadManifest().logins).sort());

const LOGIN_NAME = /^jale_[a-z]+(?:_[a-z]+)*$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The bed's fixed test password for `login`: `test-<name>-pw`. */
export function testPasswordFor(login: string): string {
  if (!LOGIN_NAME.test(login)) {
    throw new Error('login-pool: not a test-bed login name');
  }
  return `test-${login.slice('jale_'.length).replace(/_/g, '')}-pw`;
}

/** The profile the bed was bootstrapped with (default `standard`). */
export function currentDbProfile(env: NodeJS.ProcessEnv = process.env): DbProfile {
  const raw = env.JALE_TEST_DB_PROFILE ?? '';
  if (raw === '') return 'standard';
  if ((DB_PROFILES as readonly string[]).includes(raw)) return raw as DbProfile;
  throw new Error('login-pool: unknown test-bed profile in JALE_TEST_DB_PROFILE');
}

/**
 * A connection URL for `login` on the same local bed as `baseUrl` (by default
 * JALE_TEST_DATABASE_URL). Only the user and password change.
 */
export function loginUrl(login: string, baseUrl: string | undefined = process.env.JALE_TEST_DATABASE_URL): string {
  if (!baseUrl) {
    throw new Error('login-pool: JALE_TEST_DATABASE_URL is not set');
  }
  const url = new URL(baseUrl);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('login-pool: refusing a database that is not a local test bed');
  }
  url.username = login;
  url.password = testPasswordFor(login);
  return url.toString();
}

/** A pool whose every connection signs in as `login`. The caller ends it. */
export function loginPool(login: string, config: Omit<PoolConfig, 'connectionString'> = {}): Pool {
  return new Pool({ max: 2, ...config, connectionString: loginUrl(login) });
}

/** A single client signed in as `login`. The caller ends it. */
export function loginClient(login: string, config: Omit<ClientConfig, 'connectionString'> = {}): Client {
  return new Client({ ...config, connectionString: loginUrl(login) });
}

/** Connects as `login`, runs `fn`, and always disconnects. */
export async function withLoginClient<T>(login: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = loginClient(login);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** True when the current profile is one of `profiles`. */
export function profileApplies(profiles: readonly DbProfile[], env: NodeJS.ProcessEnv = process.env): boolean {
  return profiles.includes(currentDbProfile(env));
}

export type ProfileMode = 'skip' | 'run' | 'not-applicable';

/**
 * Whether a profile-scoped suite or test runs here: `skip` without a database
 * URL (like every other DB suite), `run` in a listed profile, and
 * `not-applicable` in any other profile.
 */
export function profileMode(profiles: readonly DbProfile[], env: NodeJS.ProcessEnv = process.env): ProfileMode {
  if (!env.JALE_TEST_DATABASE_URL) return 'skip';
  return profiles.includes(currentDbProfile(env)) ? 'run' : 'not-applicable';
}

function notApplicableName(profiles: readonly DbProfile[], profile: DbProfile): string {
  return `does not apply to the ${profile} profile (applies to: ${profiles.join(', ')})`;
}

/**
 * `describe` for a suite that applies to some profiles only. Without a
 * database URL it skips, like every other DB suite. In a profile it does not
 * apply to, it registers one explicit passing test that names the profile, so
 * the run records the choice instead of a skip.
 */
export function describeInProfiles(profiles: readonly DbProfile[], name: string, fn: () => void): void {
  const mode = profileMode(profiles);
  if (mode === 'skip') {
    describe.skip(name, fn);
  } else if (mode === 'run') {
    describe(name, fn);
  } else {
    const profile = currentDbProfile();
    describe(name, () => {
      it(notApplicableName(profiles, profile), () => {
        expect(profiles).not.toContain(profile);
      });
    });
  }
}

/**
 * `it` for one test that applies to some profiles only, with the same rules
 * as describeInProfiles: in any other profile it registers an explicit
 * passing "does not apply" test under the same name, never a skip.
 */
export function itInProfiles(
  profiles: readonly DbProfile[],
  name: string,
  fn: () => unknown,
  timeout?: number,
): void {
  const mode = profileMode(profiles);
  if (mode === 'skip') {
    it.skip(name, fn as () => void);
  } else if (mode === 'run') {
    it(name, fn as () => void, timeout);
  } else {
    const profile = currentDbProfile();
    it(`${name} -- ${notApplicableName(profiles, profile)}`, () => {
      expect(profiles).not.toContain(profile);
    });
  }
}
