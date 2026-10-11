/**
 * scram-verifier.integration.test.ts
 *
 * scripts/lib/scram-verifier.py turns a password (read on stdin) into the
 * SCRAM-SHA-256 verifier PostgreSQL stores. `scripts/run-migrations.sh` uses it
 * on the ops host so a login's password reaches the database only as a
 * verifier: `ALTER ROLE ... WITH PASSWORD 'SCRAM-SHA-256$...'` is stored as
 * given, and the plaintext never appears in a statement, an argument or a log.
 *
 * Two layers:
 *   - The helper's own contract, with no database: the RFC 7677 test vector,
 *     the output format, and the inputs it must refuse without echoing them.
 *   - A functional check against the disposable test bed (JALE_TEST_DATABASE_URL,
 *     a SUPERUSER url): parity with the verifier PostgreSQL itself computes, a
 *     scratch login whose password is set from the helper's verifier signing in
 *     with the plaintext, and a wrong password being rejected.
 *
 * Scratch roles only: the suite never touches a real login, so it is safe in
 * the shared database runner. Test passwords follow the test-<name>-pw pattern.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { Client } from 'pg';

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const helperPath = path.join(repoRoot, 'scripts', 'lib', 'scram-verifier.py');

const VERIFIER_FORMAT = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/;

interface Verifier {
  iterations: number;
  salt: Buffer;
  storedKey: Buffer;
  serverKey: Buffer;
}

function runHelper(password: string, args: string[] = []): string {
  return execFileSync('python3', [helperPath, ...args], {
    input: password,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function parseVerifier(verifier: string): Verifier {
  const m = verifier.match(VERIFIER_FORMAT);
  if (!m) throw new Error('not a SCRAM-SHA-256 verifier');
  return {
    iterations: Number(m[1]),
    salt: Buffer.from(m[2], 'base64'),
    storedKey: Buffer.from(m[3], 'base64'),
    serverKey: Buffer.from(m[4], 'base64'),
  };
}

const hmac = (key: Buffer, msg: string): Buffer => createHmac('sha256', key).update(msg, 'utf8').digest();

describe('scram-verifier.py (no database)', () => {
  /**
   * RFC 7677 section 3: user "user", password "pencil", salt
   * W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations. The RFC publishes the exchange,
   * not the keys, so both halves of the verifier are checked through it: the
   * server key must reproduce the server signature, and the stored key must be
   * the hash of the client key recovered from the published client proof.
   */
  it('reproduces the RFC 7677 SCRAM-SHA-256 test vector', () => {
    const v = parseVerifier(runHelper('pencil', ['--salt-b64', 'W22ZaJ0SNY7soEsUEjb6gQ==', '--iterations', '4096']));
    expect(v.iterations).toBe(4096);
    expect(v.salt.toString('base64')).toBe('W22ZaJ0SNY7soEsUEjb6gQ==');

    const clientFirstBare = 'n=user,r=rOprNGfwEbeRWgbNEkqO';
    const serverFirst = 'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
    const clientFinalNoProof = 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;

    expect(hmac(v.serverKey, authMessage).toString('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');

    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const clientSignature = hmac(v.storedKey, authMessage);
    const clientKey = Buffer.alloc(proof.length);
    for (let i = 0; i < proof.length; i += 1) clientKey[i] = proof[i] ^ clientSignature[i];
    expect(createHash('sha256').update(clientKey).digest().equals(v.storedKey)).toBe(true);
  });

  it('emits PostgreSQL\'s verifier format: 4096 iterations, a fresh 16-byte salt, 32-byte keys', () => {
    const first = runHelper('test-scram-format-pw');
    const second = runHelper('test-scram-format-pw');

    expect(first).toMatch(VERIFIER_FORMAT);
    const a = parseVerifier(first);
    const b = parseVerifier(second);
    expect(a.iterations).toBe(4096);
    expect(a.salt).toHaveLength(16);
    expect(a.storedKey).toHaveLength(32);
    expect(a.serverKey).toHaveLength(32);
    // A random salt per call: the same password never yields the same verifier.
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(first).not.toBe(second);
    // The output is the verifier and nothing else -- never the password.
    expect(first).not.toContain('test-scram-format-pw');
  });

  it('strips exactly one trailing newline, so `echo` and `printf %s` agree', () => {
    const salt = randomBytes(16).toString('base64');
    const plain = runHelper('test-scram-newline-pw', ['--salt-b64', salt]);
    expect(runHelper('test-scram-newline-pw\n', ['--salt-b64', salt])).toBe(plain);
    expect(runHelper('test-scram-newline-pw\r\n', ['--salt-b64', salt])).toBe(plain);
  });

  // Exit 3 is the helper refusing its input; exit 2 is a usage error. Both
  // messages start with the helper's own prefix, so an interpreter failure
  // ("can't open file", also exit 2) can never pass for a refusal.
  it.each([
    ['an empty password', ''],
    ['a bare newline', '\n'],
    ['a non-ASCII password', 'test-scram-ñ-pw'],
    ['a control character', 'test-scram-\u0007-pw'],
    ['an embedded space', 'test-space-in marker-pw'],
    ['two lines', 'test-scram-one-pw\ntest-scram-two-pw'],
  ])('refuses %s without echoing it', (_label, input) => {
    const r = spawnSync('python3', [helperPath], { input, encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^scram-verifier: refused: /m);
    // No distinctive fragment of the input is ever printed back.
    for (const part of input.split(/\s+/).filter((p) => p.length >= 6)) {
      expect(r.stderr).not.toContain(part);
    }
  });

  it('takes the password on stdin only: a positional argument is a usage error that is not echoed', () => {
    const r = spawnSync('python3', [helperPath, 'test-scram-argv-pw'], { input: '', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^scram-verifier: error: /m);
    expect(r.stderr).not.toContain('test-scram-argv-pw');
  });

  it.each([
    ['fewer than 4096 iterations', ['--iterations', '1024']],
    ['a non-numeric iteration count', ['--iterations', 'many']],
    ['a salt that is not base64', ['--salt-b64', '!!!not-base64!!!']],
    ['a salt shorter than 16 bytes', ['--salt-b64', Buffer.from('short').toString('base64')]],
  ])('refuses %s', (_label, args) => {
    const r = spawnSync('python3', [helperPath, ...args], { input: 'test-scram-args-pw', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^scram-verifier: error: /m);
  });
});

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: the SCRAM verifier test-bed check was not run', () => {
    console.warn('[scram-verifier] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

function urlFor(base: string, user: string, password: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function connectAs(base: string, user: string, password: string): Promise<Client> {
  const client = new Client({ connectionString: urlFor(base, user, password), connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
}

maybeDescribe('scram-verifier.py against the test bed', () => {
  const suffix = randomBytes(4).toString('hex');
  const parityRole = `jale_scram_parity_${suffix}`;
  const loginRole = `jale_scram_login_${suffix}`;
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const su = await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (su.rows[0]?.rolsuper !== true) {
      throw new Error('JALE_TEST_DATABASE_URL must be a superuser url: the suite reads pg_authid');
    }
    for (const role of [parityRole, loginRole]) {
      await admin.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5`,
      );
    }
    const db = new URL(databaseUrl!).pathname.replace(/^\//, '');
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${loginRole}`);
  });

  afterAll(async () => {
    if (!admin) return;
    const db = new URL(databaseUrl!).pathname.replace(/^\//, '');
    await admin.query(`REVOKE CONNECT ON DATABASE ${db} FROM ${loginRole}`).catch(() => {});
    for (const role of [parityRole, loginRole]) {
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
    await admin.end();
  });

  async function storedVerifier(role: string): Promise<string> {
    const r = await admin.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [role]);
    return r.rows[0].rolpassword as string;
  }

  it('computes byte-for-byte the verifier PostgreSQL computes for the same salt', async () => {
    // Let the server derive the verifier from a plaintext test password, then
    // ask the helper for the same password with the server's salt and count.
    await admin.query(`SET password_encryption = 'scram-sha-256'`);
    await admin.query(`ALTER ROLE ${parityRole} WITH PASSWORD 'test-scram-parity-pw'`);
    const serverVerifier = await storedVerifier(parityRole);
    const parsed = parseVerifier(serverVerifier);

    const ours = runHelper('test-scram-parity-pw', [
      '--salt-b64', parsed.salt.toString('base64'),
      '--iterations', String(parsed.iterations),
    ]);
    expect(ours).toBe(serverVerifier);
  });

  it('is stored exactly as given and lets the login sign in with the plaintext', async () => {
    const verifier = runHelper('test-scram-login-pw');
    // The statement carries the verifier, never the plaintext.
    await admin.query(`ALTER ROLE ${loginRole} WITH PASSWORD '${verifier}'`);
    expect(await storedVerifier(loginRole)).toBe(verifier);

    const client = await connectAs(databaseUrl!, loginRole, 'test-scram-login-pw');
    try {
      const r = await client.query('SELECT current_user AS who');
      expect(r.rows[0].who).toBe(loginRole);
    } finally {
      await client.end();
    }
  });

  it('rejects a wrong password (proves the test bed really checks SCRAM here)', async () => {
    const verifier = runHelper('test-scram-login-pw');
    await admin.query(`ALTER ROLE ${loginRole} WITH PASSWORD '${verifier}'`);

    let code: string | undefined;
    try {
      const client = await connectAs(databaseUrl!, loginRole, 'test-scram-wrong-pw');
      await client.end();
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('28P01');
  });
});

/**
 * The catalog queries `scripts/run-migrations.sh` decides from, executed
 * verbatim against the test bed. The script compares their psql -At output
 * with fixed strings ("t|f|f|f|f|f|f|-1|0", "<login>|t", "f|16xxxx"), so a
 * query that drifts from what PostgreSQL returns would refuse every login, or
 * pass a wrong one. Scratch roles only.
 */
const scriptText = (): string =>
  require('node:fs').readFileSync(path.join(repoRoot, 'scripts', 'run-migrations.sh'), 'utf8') as string;

function scriptSql(name: string): string {
  const m = scriptText().match(new RegExp(`^${name}="(.*)"$`, 'm'));
  if (!m) throw new Error(`${name} not found in run-migrations.sh`);
  return m[1];
}

/** psql -At rendering: booleans as t/f, everything else as text, joined by |. */
function asPsqlRow(row: Record<string, unknown>): string {
  return Object.values(row).map((v) => (typeof v === 'boolean' ? (v ? 't' : 'f') : String(v))).join('|');
}

maybeDescribe("run-migrations.sh's catalog queries against the test bed", () => {
  const suffix = randomBytes(4).toString('hex');
  const lpRole = `jale_scram_lp_${suffix}`;
  const bypassRole = `jale_scram_bypass_${suffix}`;
  const groupRole = `jale_scram_group_${suffix}`;
  let admin: Client;
  let db: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    db = new URL(databaseUrl!).pathname.replace(/^\//, '');
    await admin.query(
      `CREATE ROLE ${lpRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5`,
    );
    await admin.query(`CREATE ROLE ${bypassRole} LOGIN NOSUPERUSER NOINHERIT BYPASSRLS`);
    await admin.query(`CREATE ROLE ${groupRole} NOLOGIN`);
    for (const role of [lpRole, bypassRole]) {
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
      await admin.query(`ALTER ROLE ${role} WITH PASSWORD '${runHelper(`test-scram-${role.slice(11, 17)}-pw`)}'`);
    }
  });

  afterAll(async () => {
    if (!admin) return;
    for (const role of [lpRole, bypassRole]) {
      await admin.query(`REVOKE CONNECT ON DATABASE ${db} FROM ${role}`).catch(() => {});
    }
    for (const role of [lpRole, bypassRole, groupRole]) {
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
    await admin.end();
  });

  const rolePassword = (role: string) => `test-scram-${role.slice(11, 17)}-pw`;

  it('ROLE_ATTRS_SQL renders a least-privilege login exactly as --prepare-logins expects it', async () => {
    // The script feeds this through psql with -v login=...; here the same
    // variable becomes a bind parameter.
    const sql = scriptSql('ROLE_ATTRS_SQL').replace(":'login'", '$1');
    const r = await admin.query(sql, [lpRole]);
    expect(asPsqlRow(r.rows[0])).toBe('t|f|f|f|f|f|f|5|0');

    // A membership is counted, which is how the script refuses one.
    await admin.query(`GRANT ${groupRole} TO ${lpRole}`);
    try {
      const after = await admin.query(sql, [lpRole]);
      expect(asPsqlRow(after.rows[0])).toBe('t|f|f|f|f|f|f|5|1');
    } finally {
      await admin.query(`REVOKE ${groupRole} FROM ${lpRole}`);
    }

    // An unknown role yields no row: the script's "role not found".
    expect((await admin.query(sql, [`jale_scram_absent_${suffix}`])).rows).toHaveLength(0);
  });

  it('LOGIN_PROBE_SQL proves the login and tells an enforced login from a BYPASSRLS one', async () => {
    const sql = scriptSql('LOGIN_PROBE_SQL');
    for (const [role, expected] of [[lpRole, 't'], [bypassRole, 'f']] as const) {
      const client = await connectAs(databaseUrl!, role, rolePassword(role));
      try {
        const r = await client.query(sql);
        expect(asPsqlRow(r.rows[0])).toBe(`${role}|${expected}`);
      } finally {
        await client.end();
      }
    }
  });

  it('POSTURE_SQL reads row_security_active on public.users and the engine version', async () => {
    const sql = scriptSql('POSTURE_SQL');
    // The superuser test connection is not subject to row-level security: f.
    const su = await admin.query(sql);
    const [rls, versionNum] = asPsqlRow(su.rows[0]).split('|');
    expect(rls).toBe('f');
    expect(versionNum).toMatch(/^16\d{4}$/);

    // An ordinary login does not: t.
    const client = await connectAs(databaseUrl!, lpRole, rolePassword(lpRole));
    try {
      expect(asPsqlRow((await client.query(sql)).rows[0]).split('|')[0]).toBe('t');
    } finally {
      await client.end();
    }
  });
});
