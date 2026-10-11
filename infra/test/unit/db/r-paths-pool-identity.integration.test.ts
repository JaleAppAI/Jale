/**
 * r-paths-pool-identity.integration.test.ts
 *
 * Two pool rules on a real PostgreSQL 16 test bed, over real authenticated
 * connections (never SET ROLE):
 *
 *   1. The boot identity check (lib/db.ts createCheckedPool, which every pool
 *      getter uses) accepts each dedicated login as itself and refuses a
 *      login mismatch, a login row security does not apply to, and the
 *      master login.
 *   2. Transaction hygiene: a pooled client released inside an open or an
 *      aborted transaction is destroyed, so the next checkout is a different
 *      backend and sees none of the previous request's transaction-local
 *      caller context; a client released idle is reused, and its committed
 *      transaction's settings are gone.
 *
 * Runs in every profile. The fixture-free design needs only CONNECT, so it
 * holds whatever else the logins have been granted.
 */
import { Client, Pool } from 'pg';
import { createCheckedPool, assertDbIdentity, DbIdentityCheckError } from '../../../lambda/lib/db';
import { currentDbProfile, loginClient, loginPool, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

if (!databaseUrl) {
  test('CONCERN: the pool identity DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const DEDICATED_LOGINS = [
  'jale_api',
  'jale_api_public',
  'jale_job_email_sender',
  'jale_job_visibility_drain',
  'jale_job_digest',
  'jale_job_ses_feedback',
  'jale_job_retention',
  'jale_posture',
  'jale_whatsapp',
  'jale_public_jobs',
  'jale_matching',
];

function silenceReports(): () => void {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  return () => {
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  };
}

maybeDescribe('the boot identity check on real logins', () => {
  let restore: () => void;
  beforeEach(() => { restore = silenceReports(); });
  afterEach(() => restore());

  it.each(DEDICATED_LOGINS)('accepts %s as itself (row security active)', async (login) => {
    const pool = await createCheckedPool({ connectionString: loginUrl(login), max: 1 }, login, 'test');
    try {
      const { rows } = await pool.query<{ login: string }>('SELECT current_user::text AS login');
      expect(rows[0].login).toBe(login);
    } finally {
      await pool.end();
    }
  });

  it('refuses a pool that signs in as a different login than the workload expects', async () => {
    await expect(
      createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_whatsapp', 'test'),
    ).rejects.toMatchObject({ reason: 'login_mismatch' });
  });

  it('refuses a session whose current role is the expected login but which signed in as another login', async () => {
    // The bed URL's user is a superuser, which may take any role at startup:
    // current_user is then the workload login and session_user is not.
    const superuser = new URL(databaseUrl!).username;
    expect(superuser).not.toBe('jale_api');
    const probe = new Client({ connectionString: databaseUrl, options: '-c role=jale_api' });
    await probe.connect();
    try {
      const { rows } = await probe.query<{ session_login: string; login: string }>(
        'SELECT session_user::text AS session_login, current_user::text AS login',
      );
      expect(rows[0]).toEqual({ session_login: superuser, login: 'jale_api' });
    } finally {
      await probe.end();
    }

    const outcome = await createCheckedPool({ connectionString: databaseUrl, options: '-c role=jale_api', max: 1 }, 'jale_api', 'test')
      .then(async (pool) => { await pool.end(); return 'accepted'; }, (err: unknown) => err);
    expect(outcome).toMatchObject({ reason: 'login_mismatch' });
  });

  it('refuses a login that row security does not apply to (the superuser)', async () => {
    const superuser = new URL(databaseUrl!).username;
    await expect(
      createCheckedPool({ connectionString: databaseUrl, max: 1 }, superuser, 'test'),
    ).rejects.toMatchObject({ reason: 'row_security_inactive' });
  });

  it('refuses the master login as an expected login before connecting', async () => {
    await expect(
      createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_admin', 'test'),
    ).rejects.toMatchObject({ reason: 'master_login_refused' });
  });

  it('refuses an unset expected login', async () => {
    await expect(
      createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, undefined, 'test'),
    ).rejects.toBeInstanceOf(DbIdentityCheckError);
  });

  it('the owner login\'s probe depends on the bed profile, so the owner is refused by name', async () => {
    // standard/request: the bed's jale_admin is a FORCE-RLS table owner, so
    // the probe alone would accept it; that is why it is refused by name.
    // On the owner-unrestricted bed it runs without row policies, and there
    // the probe reads false.
    const client = loginClient('jale_admin');
    await client.connect();
    try {
      const probe = assertDbIdentity(client, 'jale_admin');
      if (currentDbProfile() === 'owner-unrestricted') {
        await expect(probe).rejects.toMatchObject({ reason: 'row_security_inactive' });
      } else {
        await expect(probe).resolves.toBeUndefined();
      }
    } finally {
      await client.end();
    }
  });
});

maybeDescribe('a pooled client released inside a transaction is destroyed', () => {
  let pool: Pool;
  let restore: () => void;

  beforeEach(async () => {
    restore = silenceReports();
    pool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterEach(async () => {
    await pool.end();
    restore();
  });

  async function backendPid(): Promise<number> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return rows[0].pid;
    } finally {
      client.release();
    }
  }

  async function callerContext(client: { query: Pool['query'] }): Promise<Array<string | null>> {
    const { rows } = await client.query<{ sub: string | null; internal: string | null }>(
      `SELECT current_setting('app.current_user_id', true) AS sub,
              current_setting('app.current_internal_user_id', true) AS internal`,
    );
    return [rows[0].sub, rows[0].internal];
  }

  function isEmptySetting(value: string | null): boolean {
    // A custom setting never touched in a session reads NULL; once touched
    // and reverted it reads ''. Either means "no caller".
    return value === null || value === '';
  }

  it('a release inside an OPEN transaction gives the next checkout a new backend with no caller context', async () => {
    const first = await pool.connect();
    await first.query('BEGIN');
    await first.query(`SELECT set_config('app.current_user_id', $1, true)`, ['fixture-sub-open']);
    await first.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, ['fixture-internal-open']);
    const { rows } = await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(first.getTransactionStatus()).toBe('T');
    first.release(); // no COMMIT: the guard must destroy it

    const next = await pool.connect();
    try {
      const after = await next.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(after.rows[0].pid).not.toBe(rows[0].pid);
      expect((await callerContext(next)).every(isEmptySetting)).toBe(true);
    } finally {
      next.release();
    }
  });

  it('a release inside an ABORTED transaction gives the next checkout a new backend', async () => {
    const first = await pool.connect();
    await first.query('BEGIN');
    await first.query(`SELECT set_config('app.current_user_id', $1, true)`, ['fixture-sub-aborted']);
    const { rows } = await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await expect(first.query('SELECT 1 / 0')).rejects.toThrow();
    // pg rejects on the error before the server's ReadyForQuery ('E')
    // arrives, so the status can still read 'T' here: either way it is not
    // idle, and the guard destroys on anything but 'I'.
    expect(first.getTransactionStatus()).not.toBe('I');
    first.release();

    const next = await pool.connect();
    try {
      const after = await next.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(after.rows[0].pid).not.toBe(rows[0].pid);
      expect((await callerContext(next)).every(isEmptySetting)).toBe(true);
    } finally {
      next.release();
    }
  });

  it('a release after COMMIT reuses the backend, and the committed transaction-local settings are gone', async () => {
    const first = await pool.connect();
    await first.query('BEGIN');
    await first.query(`SELECT set_config('app.current_user_id', $1, true)`, ['fixture-sub-committed']);
    await first.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, ['fixture-internal-committed']);
    const { rows } = await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await first.query('COMMIT');
    first.release();

    const next = await pool.connect();
    try {
      const after = await next.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(after.rows[0].pid).toBe(rows[0].pid);
      expect((await callerContext(next)).every(isEmptySetting)).toBe(true);
    } finally {
      next.release();
    }
  });

  it('pool.query (the callback form of connect) is guarded too and leaves the backend reusable', async () => {
    const before = await backendPid();
    await pool.query(`SELECT set_config('app.current_user_id', $1, true)`, ['fixture-sub-autocommit']);
    expect(await backendPid()).toBe(before);
    const client = await pool.connect();
    try {
      expect((await callerContext(client)).every(isEmptySetting)).toBe(true);
    } finally {
      client.release();
    }
  });
});

maybeDescribe('why session-level settings are banned statically: they DO survive a release', () => {
  it('a set_config(..., false) on an unguarded pool leaks into the next checkout of the same backend', async () => {
    // Negative control on a raw pool, not production code: this is the leak
    // transaction-local-settings-guard.test.ts keeps out of infra/lambda.
    const raw = loginPool('jale_api', { max: 1 });
    try {
      const first = await raw.connect();
      await first.query(`SELECT set_config('app.current_internal_user_id', $1, false)`, ['fixture-leaked']);
      first.release();
      const next = await raw.connect();
      try {
        const { rows } = await next.query<{ v: string | null }>(
          `SELECT current_setting('app.current_internal_user_id', true) AS v`,
        );
        expect(rows[0].v).toBe('fixture-leaked');
      } finally {
        next.release();
      }
    } finally {
      await raw.end();
    }
  });
});
