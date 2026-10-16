/**
 * admin-access-120.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 120 (sprint 28, admin access):
 *   - admin_trusted_devices: its columns, checks, the one live row per admin
 *     and device, FORCE row security, and the console's rights through its
 *     own policies and column grants (read, record a trust, end one; never
 *     reopen, rewrite or delete one);
 *   - the Admins definers admin_user_invite_record, admin_user_set_role and
 *     admin_user_set_active, called as jale_admin_console: what each writes
 *     and returns, the documented errors, and the two guards (never zero
 *     active superadmins, never a change to oneself) under concurrency;
 *   - deactivation ends the admin's live trusted browsers.
 *
 * The superadmin guard counts every active superadmin in the database, so
 * the suite runs early (SUITES section 2b), sets any active superadmin it did
 * not create inactive for its own run, and restores them afterwards. Its own
 * admins are removed at the end.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser (bootstrap-testbed.sh exports it). When
 * absent the suite is explicitly skipped and says so.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { loginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping the 120 admin access integration tests');
}

type AdminRow = { id: string; email: string; sub: string };
type PgError = Error & { code?: string };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const FUNCTIONS = [
  ['public.admin_user_invite_record(uuid,text,text,text)',
    'TABLE(admin_user_id uuid, email text, role text, active boolean, created_at timestamp with time zone)'],
  ['public.admin_user_set_role(uuid,uuid,text)',
    'TABLE(admin_user_id uuid, email text, role text, active boolean, created_at timestamp with time zone)'],
  ['public.admin_user_set_active(uuid,uuid,boolean)',
    'TABLE(admin_user_id uuid, email text, role text, active boolean, created_at timestamp with time zone)'],
] as const;

maybeDescribe('120 admin access', () => {
  const su = new Client({ connectionString: databaseUrl });
  let consoleClient: Client;
  const created: string[] = [];
  let parked: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function createAdmin(role: string, active = true): Promise<AdminRow> {
    const n = created.length + 1;
    const email = `it-120-${tag}-${n}@example.test`;
    const sub = `it-120-sub-${tag}-${n}`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO public.admin_users (cognito_sub, admin_email, role, active)
       VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [sub, email, role, active],
    );
    created.push(rows[0].id);
    return { id: rows[0].id, email, sub };
  }

  async function adminState(id: string): Promise<{ role: string; active: boolean }> {
    const { rows } = await su.query('SELECT role, active FROM public.admin_users WHERE id = $1', [id]);
    return rows[0];
  }

  async function activeSuperadmins(): Promise<string[]> {
    const { rows } = await su.query<{ id: string }>(
      `SELECT id::text FROM public.admin_users WHERE active AND role = 'admin_superadmin' ORDER BY id`,
    );
    return rows.map((row) => row.id);
  }

  async function expectError(promise: Promise<unknown>, message: string, code: string): Promise<void> {
    let caught: PgError | undefined;
    try {
      await promise;
    } catch (error) {
      caught = error as PgError;
    }
    expect(caught).toBeDefined();
    expect({ message: caught?.message, code: caught?.code }).toEqual({ message, code });
  }

  async function waitForLock(pid: number): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await su.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (rows[0]?.wait_event_type === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the second call never waited on a lock');
  }

  beforeAll(async () => {
    await su.connect();
    // The superadmin guard is whole-database: park every active superadmin
    // this suite did not create, and restore them in afterAll.
    const { rows } = await su.query<{ id: string }>(
      `UPDATE public.admin_users SET active = false
        WHERE active AND role = 'admin_superadmin'
       RETURNING id::text`,
    );
    parked = rows.map((row) => row.id);
    consoleClient = loginClient('jale_admin_console');
    await consoleClient.connect();
  });

  // Each test starts with no active superadmin but the ones it creates.
  beforeEach(async () => {
    await su.query(`UPDATE public.admin_users SET active = false WHERE active AND role = 'admin_superadmin'`);
  });

  afterAll(async () => {
    await consoleClient?.end().catch(() => undefined);
    if (created.length > 0) {
      await su.query('DELETE FROM public.admin_users WHERE id = ANY ($1::uuid[])', [created]);
    }
    if (parked.length > 0) {
      await su.query('UPDATE public.admin_users SET active = true WHERE id = ANY ($1::uuid[])', [parked]);
    }
    await su.end();
  });

  describe('admin_trusted_devices', () => {
    it('has the reviewed columns, checks and live-row index, with FORCE row security', async () => {
      const { rows: columns } = await su.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'admin_trusted_devices'
          ORDER BY ordinal_position`,
      );
      expect(columns.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
        ['id', 'uuid', 'NO'],
        ['admin_user_id', 'uuid', 'NO'],
        ['device_key_hash', 'character', 'NO'],
        ['trusted_at', 'timestamp with time zone', 'NO'],
        ['expires_at', 'timestamp with time zone', 'NO'],
        ['ended_at', 'timestamp with time zone', 'YES'],
        ['end_reason', 'text', 'YES'],
      ]);
      const { rows: [rls] } = await su.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.admin_trusted_devices'::regclass`,
      );
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const { rows: [index] } = await su.query(
        `SELECT pg_get_indexdef('public.admin_trusted_devices_live_key'::regclass) AS def`,
      );
      expect(index.def).toBe(
        'CREATE UNIQUE INDEX admin_trusted_devices_live_key ON public.admin_trusted_devices '
        + 'USING btree (admin_user_id, device_key_hash) WHERE (ended_at IS NULL)',
      );
      const { rows: [fk] } = await su.query(
        `SELECT confdeltype FROM pg_constraint
          WHERE conrelid = 'public.admin_trusted_devices'::regclass AND contype = 'f'`,
      );
      expect(fk.confdeltype).toBe('c');
    });

    it('gives the console read, a trust record and its ending, and nothing else', async () => {
      const { rows } = await su.query(
        `SELECT privilege_type, column_name FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'admin_trusted_devices' AND grantee = 'jale_admin_console'
          ORDER BY privilege_type, column_name`,
      );
      const byPrivilege = (privilege: string) => rows.filter((r) => r.privilege_type === privilege).map((r) => r.column_name);
      expect(byPrivilege('INSERT')).toEqual(['admin_user_id', 'device_key_hash', 'expires_at']);
      expect(byPrivilege('UPDATE')).toEqual(['end_reason', 'ended_at']);
      expect(byPrivilege('SELECT')).toHaveLength(7);
      expect(byPrivilege('DELETE')).toEqual([]);
      const { rows: [table] } = await su.query(
        `SELECT has_table_privilege('jale_admin_console', 'public.admin_trusted_devices', 'DELETE') AS del,
                has_table_privilege('jale_admin_console', 'public.admin_trusted_devices', 'TRUNCATE') AS trunc`,
      );
      expect(table).toEqual({ del: false, trunc: false });
    });

    it('lets the console record a 7-day trust, keep one live row per device, and end it once', async () => {
      const admin = await createAdmin('admin_ops');
      const hash = sha256(`it-120-device-${tag}-a`);
      const insert = (expires: string) => consoleClient.query(
        `INSERT INTO public.admin_trusted_devices (admin_user_id, device_key_hash, expires_at)
         VALUES ($1, $2, ${expires}) RETURNING id::text, expires_at - trusted_at AS span`,
        [admin.id, hash],
      );
      const { rows: [trust] } = await insert(`now() + interval '7 days'`);
      expect(trust.span).toEqual({ days: 7 });

      // One live row per admin and device.
      await expectError(insert(`now() + interval '7 days'`),
        'duplicate key value violates unique constraint "admin_trusted_devices_live_key"', '23505');
      // The window is exactly seven days from the trust.
      const other = sha256(`it-120-device-${tag}-b`);
      await expectError(consoleClient.query(
        `INSERT INTO public.admin_trusted_devices (admin_user_id, device_key_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 days')`, [admin.id, other]),
      'new row for relation "admin_trusted_devices" violates check constraint "admin_trusted_devices_seven_days"', '23514');
      // A raw device key is not a hash.
      await expectError(consoleClient.query(
        `INSERT INTO public.admin_trusted_devices (admin_user_id, device_key_hash, expires_at)
         VALUES ($1, $2, now() + interval '7 days')`, [admin.id, 'z'.repeat(64)]),
      'new row for relation "admin_trusted_devices" violates check constraint "admin_trusted_devices_device_key_hash_check"', '23514');
      // The console cannot record an ended row, or choose the trust time.
      await expectError(consoleClient.query(
        `INSERT INTO public.admin_trusted_devices (admin_user_id, device_key_hash, expires_at, ended_at, end_reason)
         VALUES ($1, $2, now() + interval '7 days', now(), 'expired')`, [admin.id, other]),
      'permission denied for table admin_trusted_devices', '42501');

      // Ending it: once, with a reason; an ended row is never reopened.
      const end = () => consoleClient.query(
        `UPDATE public.admin_trusted_devices SET ended_at = now(), end_reason = 'expired'
          WHERE id = $1 AND ended_at IS NULL`, [trust.id]);
      expect((await end()).rowCount).toBe(1);
      expect((await end()).rowCount).toBe(0);
      expect((await consoleClient.query(
        `UPDATE public.admin_trusted_devices SET ended_at = NULL, end_reason = NULL WHERE id = $1`, [trust.id])).rowCount).toBe(0);
      await expectError(consoleClient.query(
        `UPDATE public.admin_trusted_devices SET expires_at = now() WHERE id = $1`, [trust.id]),
      'permission denied for table admin_trusted_devices', '42501');
      await expectError(consoleClient.query('DELETE FROM public.admin_trusted_devices WHERE id = $1', [trust.id]),
        'permission denied for table admin_trusted_devices', '42501');

      // A live row cannot be ended without a reason, or with an unknown one.
      const { rows: [again] } = await insert(`now() + interval '7 days'`);
      await expectError(consoleClient.query(
        `UPDATE public.admin_trusted_devices SET ended_at = now() WHERE id = $1`, [again.id]),
      'new row for relation "admin_trusted_devices" violates check constraint "admin_trusted_devices_ending"', '23514');
      await expectError(consoleClient.query(
        `UPDATE public.admin_trusted_devices SET ended_at = now(), end_reason = 'other' WHERE id = $1`, [again.id]),
      'new row for relation "admin_trusted_devices" violates check constraint "admin_trusted_devices_end_reason_check"', '23514');
    });
  });

  describe('the Admins definers', () => {
    it('are hardened definers owned by jale_admin that only the console may execute', async () => {
      for (const [signature, result] of FUNCTIONS) {
        const { rows: [fn] } = await su.query(
          `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                  pg_get_function_result(p.oid) AS result,
                  has_function_privilege('jale_admin_console', p.oid, 'EXECUTE') AS console,
                  has_function_privilege('jale_api', p.oid, 'EXECUTE') AS api,
                  ARRAY(SELECT a.grantee::regrole::text
                          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE' ORDER BY 1) AS executors
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [signature],
        );
        expect(fn).toEqual({
          prosecdef: true,
          owner: 'jale_admin',
          proconfig: ['search_path=pg_catalog, pg_temp'],
          result,
          console: true,
          api: false,
          executors: ['jale_admin', 'jale_admin_console'],
        });
      }
    });

    it('records an invite with the email lower-cased, once per email and sign-in id', async () => {
      const actor = await createAdmin('admin_superadmin');
      const sub = `it-120-invite-${tag}`;
      const email = `It-120-Invite-${tag}@Example.Test`;
      const { rows } = await consoleClient.query(
        'SELECT * FROM public.admin_user_invite_record($1, $2, $3, $4)',
        [actor.id, ` ${email} `, 'admin_ops', sub],
      );
      expect(rows).toHaveLength(1);
      created.push(rows[0].admin_user_id);
      expect(rows[0]).toMatchObject({ email: email.toLowerCase(), role: 'admin_ops', active: true });
      const { rows: [stored] } = await su.query(
        'SELECT cognito_sub, admin_email, role, active FROM public.admin_users WHERE id = $1', [rows[0].admin_user_id]);
      expect(stored).toEqual({ cognito_sub: sub, admin_email: email.toLowerCase(), role: 'admin_ops', active: true });

      await expectError(consoleClient.query('SELECT * FROM public.admin_user_invite_record($1, $2, $3, $4)',
        [actor.id, email.toUpperCase(), 'admin_ops', `${sub}-2`]), 'admin_already_exists', '23505');
      await expectError(consoleClient.query('SELECT * FROM public.admin_user_invite_record($1, $2, $3, $4)',
        [actor.id, `other-${tag}@example.test`, 'admin_ops', sub]), 'admin_already_exists', '23505');
      for (const [mail, role, sign] of [
        ['not-an-email', 'admin_ops', `${sub}-3`],
        [`fine-${tag}@example.test`, 'superuser', `${sub}-3`],
        [`fine-${tag}@example.test`, 'admin_ops', '  '],
        [null, 'admin_ops', `${sub}-3`],
      ]) {
        await expectError(consoleClient.query('SELECT * FROM public.admin_user_invite_record($1, $2, $3, $4)',
          [actor.id, mail, role, sign]), 'admin_invalid_input', '22023');
      }
      // Only an active superadmin may invite.
      const ops = await createAdmin('admin_ops');
      await expectError(consoleClient.query('SELECT * FROM public.admin_user_invite_record($1, $2, $3, $4)',
        [ops.id, `by-ops-${tag}@example.test`, 'admin_ops', `${sub}-4`]), 'admin_forbidden', '42501');
    });

    it('changes a role, refuses a change to oneself, and keeps one active superadmin', async () => {
      const a = await createAdmin('admin_superadmin');
      const b = await createAdmin('admin_superadmin');
      const target = await createAdmin('admin_readonly');

      const { rows: [changed] } = await consoleClient.query(
        'SELECT * FROM public.admin_user_set_role($1, $2, $3)', [a.id, target.id, 'admin_ops']);
      expect(changed).toMatchObject({ admin_user_id: target.id, role: 'admin_ops', active: true });
      expect(await adminState(target.id)).toEqual({ role: 'admin_ops', active: true });

      await expectError(consoleClient.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)',
        [a.id, a.id, 'admin_ops']), 'admin_self_change', '55000');
      await expectError(consoleClient.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)',
        [a.id, target.id, 'root']), 'admin_invalid_input', '22023');
      await expectError(consoleClient.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)',
        [a.id, randomUUID(), 'admin_ops']), 'admin_not_found', 'P0002');
      await expectError(consoleClient.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)',
        [target.id, b.id, 'admin_ops']), 'admin_forbidden', '42501');

      // a demotes b: a is left, the last active superadmin.
      await consoleClient.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)', [a.id, b.id, 'admin_ops']);
      expect(await activeSuperadmins()).toEqual([a.id]);
    });

    it('lets two concurrent demotions of the last two superadmins leave one', async () => {
      const a = await createAdmin('admin_superadmin');
      const b = await createAdmin('admin_superadmin');
      expect(await activeSuperadmins()).toEqual([a.id, b.id].sort());

      const first = loginClient('jale_admin_console');
      const second = loginClient('jale_admin_console');
      await first.connect();
      await second.connect();
      try {
        await first.query('BEGIN');
        await second.query('BEGIN');
        await first.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)', [a.id, b.id, 'admin_ops']);
        const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const pending = second.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)', [b.id, a.id, 'admin_ops'])
          .then(() => undefined, (error: PgError) => error);
        await waitForLock(pid);
        await first.query('COMMIT');
        const error = await pending;
        expect({ message: error?.message, code: error?.code }).toEqual({ message: 'admin_last_superadmin', code: '55000' });
        await second.query('ROLLBACK');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        await first.end();
        await second.end();
      }
      expect(await activeSuperadmins()).toEqual([a.id]);
    });

    it('lets two concurrent deactivations of the last two superadmins leave one', async () => {
      const a = await createAdmin('admin_superadmin');
      const b = await createAdmin('admin_superadmin');

      const first = loginClient('jale_admin_console');
      const second = loginClient('jale_admin_console');
      await first.connect();
      await second.connect();
      try {
        await first.query('BEGIN');
        await second.query('BEGIN');
        await first.query('SELECT * FROM public.admin_user_set_active($1, $2, false)', [a.id, b.id]);
        const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const pending = second.query('SELECT * FROM public.admin_user_set_active($1, $2, false)', [b.id, a.id])
          .then(() => undefined, (error: PgError) => error);
        await waitForLock(pid);
        await first.query('COMMIT');
        const error = await pending;
        expect({ message: error?.message, code: error?.code }).toEqual({ message: 'admin_last_superadmin', code: '55000' });
        await second.query('ROLLBACK');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        await first.end();
        await second.end();
      }
      expect(await activeSuperadmins()).toEqual([a.id]);
      expect(await adminState(b.id)).toEqual({ role: 'admin_superadmin', active: false });
    });

    it('deactivates, ending live trusted browsers only, and reactivates; never oneself', async () => {
      const actor = await createAdmin('admin_superadmin');
      const target = await createAdmin('admin_ops');
      const live = sha256(`it-120-live-${tag}`);
      const ended = sha256(`it-120-ended-${tag}`);
      await su.query(
        `INSERT INTO public.admin_trusted_devices (admin_user_id, device_key_hash, trusted_at, expires_at, ended_at, end_reason)
         VALUES ($1, $2, now(), now() + interval '7 days', NULL, NULL),
                ($1, $3, now() - interval '8 days', now() - interval '1 day', now() - interval '1 day', 'expired')`,
        [target.id, live, ended],
      );

      await expectError(consoleClient.query('SELECT * FROM public.admin_user_set_active($1, $2, false)',
        [actor.id, actor.id]), 'admin_self_change', '55000');
      await expectError(consoleClient.query('SELECT * FROM public.admin_user_set_active($1, $2, NULL)',
        [actor.id, target.id]), 'admin_invalid_input', '22023');

      const { rows: [off] } = await consoleClient.query(
        'SELECT * FROM public.admin_user_set_active($1, $2, false)', [actor.id, target.id]);
      expect(off).toMatchObject({ admin_user_id: target.id, active: false, role: 'admin_ops' });
      const { rows: trust } = await su.query(
        `SELECT device_key_hash, end_reason, ended_at IS NOT NULL AS ended
           FROM public.admin_trusted_devices WHERE admin_user_id = $1 ORDER BY trusted_at`,
        [target.id],
      );
      expect(trust).toEqual([
        { device_key_hash: ended, end_reason: 'expired', ended: true },
        { device_key_hash: live, end_reason: 'admin_deactivated', ended: true },
      ]);
      // A retry is a no-op that still answers with the row.
      const { rows: [again] } = await consoleClient.query(
        'SELECT * FROM public.admin_user_set_active($1, $2, false)', [actor.id, target.id]);
      expect(again).toMatchObject({ admin_user_id: target.id, active: false });

      const { rows: [on] } = await consoleClient.query(
        'SELECT * FROM public.admin_user_set_active($1, $2, true)', [actor.id, target.id]);
      expect(on).toMatchObject({ admin_user_id: target.id, active: true });
      expect(await adminState(target.id)).toEqual({ role: 'admin_ops', active: true });
    });

    it('leaves a change record with the console\'s audit context', async () => {
      const actor = await createAdmin('admin_superadmin');
      const target = await createAdmin('admin_readonly');
      const requestId = randomUUID();
      await consoleClient.query('BEGIN');
      try {
        await consoleClient.query(
          `SELECT set_config('app.audit_actor_kind', 'admin', true),
                  set_config('app.audit_actor_id', $1, true),
                  set_config('app.audit_channel', 'admin', true),
                  set_config('app.audit_surface', 'admin.admin_role_change', true),
                  set_config('app.audit_request_id', $2, true)`,
          [actor.id, requestId],
        );
        await consoleClient.query('SELECT * FROM public.admin_user_set_role($1, $2, $3)', [actor.id, target.id, 'admin_ops']);
        await consoleClient.query('COMMIT');
      } catch (error) {
        await consoleClient.query('ROLLBACK');
        throw error;
      }
      const { rows } = await su.query(
        `SELECT table_name, operation, changed_fields, actor_id::text, surface, context_status, record_ids::text[]
           FROM jale_audit.changes WHERE request_id = $1`,
        [requestId],
      );
      expect(rows).toEqual([{
        table_name: 'public.admin_users',
        operation: 'update',
        changed_fields: ['role'],
        actor_id: actor.id,
        surface: 'admin.admin_role_change',
        context_status: 'set',
        record_ids: [target.id],
      }]);
    });

    it('is closed to every other runtime login', async () => {
      const { rows } = await su.query<{ login: string }>(
        `SELECT r.rolname AS login FROM pg_roles r
          WHERE r.rolcanlogin AND r.rolname LIKE 'jale\\_%' AND r.rolname NOT IN ('jale_admin', 'jale_admin_console')
            AND (has_function_privilege(r.oid, 'public.admin_user_invite_record(uuid,text,text,text)', 'EXECUTE')
              OR has_function_privilege(r.oid, 'public.admin_user_set_role(uuid,uuid,text)', 'EXECUTE')
              OR has_function_privilege(r.oid, 'public.admin_user_set_active(uuid,uuid,boolean)', 'EXECUTE')
              OR has_table_privilege(r.oid, 'public.admin_trusted_devices', 'SELECT'))`,
      );
      expect(rows).toEqual([]);
    });
  });
});
