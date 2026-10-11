/**
 * testbed-login-passwords.integration.test.ts -- step 8 of
 * bootstrap-testbed.sh gives every login of the MERGED access manifest its
 * test password, so a login that only a manifest.d fragment declares can sign
 * in on the bed without anyone editing the bootstrap script.
 *
 * The fixture login is created the way a migration creates one (by the
 * non-superuser owner, with no password), the step-8 helper runs on a copy of
 * the manifest directory with one extra fragment, its SQL runs as the owner
 * exactly as the bootstrap runs it, and the login then signs in over a real
 * authenticated connection. The login is dropped afterwards.
 *
 * Runs in the `request` profile, where code under test connects as its real
 * login; other profiles record a passing "does not apply" test.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from 'pg';
import { loadManifest } from '../../../db/access/access-manifest';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: test-bed login password PostgreSQL gate was not run', () => {
    console.warn('[testbed-login-passwords] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}

const infraRoot = path.join(__dirname, '..', '..', '..');
const helper = path.join(infraRoot, 'db', 'local', 'testbed-login-passwords.mjs');
const shippedAccessDir = path.join(infraRoot, 'db', 'access');
const FIXTURE = 'jale_job_fragment_fixture';

describeInProfiles(['request'], 'test-bed passwords come from the merged access manifest', () => {
  let su: Client;
  let dir: string;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    await su.query(`DROP ROLE IF EXISTS ${FIXTURE}`);
    await withLoginClient('jale_admin', (admin) => admin.query(
      `CREATE ROLE ${FIXTURE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5`,
    ));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-testbed-passwords-'));
    fs.copyFileSync(path.join(shippedAccessDir, 'manifest.json'), path.join(dir, 'manifest.json'));
    fs.mkdirSync(path.join(dir, 'manifest.d'));
    const shippedFragments = path.join(shippedAccessDir, 'manifest.d');
    if (fs.existsSync(shippedFragments)) {
      for (const name of fs.readdirSync(shippedFragments)) {
        fs.copyFileSync(path.join(shippedFragments, name), path.join(dir, 'manifest.d', name));
      }
    }
    fs.writeFileSync(path.join(dir, 'manifest.d', 'zz-fixture.json'), JSON.stringify({
      logins: {
        [FIXTURE]: {
          kind: 'job',
          created_by: 'fixture',
          connection_limit: 5,
          prepare_secret: true,
          workloads: 'A fixture job declared only by a fragment.',
          reason: 'Proves step 8 reads the merged manifest.',
        },
      },
    }));
  });

  afterAll(async () => {
    await su?.query(`DROP ROLE IF EXISTS ${FIXTURE}`);
    await su?.end();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the fixture fragment is part of the merged manifest', () => {
    expect(Object.keys(loadManifest(dir).logins)).toContain(FIXTURE);
  });

  it('a login only a fragment declares cannot sign in before step 8, and signs in after it', async () => {
    await expect(withLoginClient(FIXTURE, (c) => c.query('SELECT 1'))).rejects.toThrow(/password authentication failed/);
    const sql = execFileSync(process.execPath, [helper, dir], { encoding: 'utf8' });
    await withLoginClient('jale_admin', (admin) => admin.query(sql));
    const { rows } = await withLoginClient(FIXTURE, (c) => c.query<{ who: string }>('SELECT current_user AS who'));
    expect(rows).toEqual([{ who: FIXTURE }]);
  });
});
