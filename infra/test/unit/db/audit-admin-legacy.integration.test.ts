/**
 * audit-admin-legacy.integration.test.ts -- the dashboard's action records
 * (public.admin_audit_log) after migration 110.
 *
 * 110 runs once, so the first part rebuilds its starting point inside a
 * transaction it always rolls back: it takes the table back to its shape
 * before 110, seeds records the way the previous dashboard writes them, runs
 * 110's own text as jale_admin, and checks the result: the printed counts,
 * the scrubbed metadata, the new columns, the owner, the grants, the
 * policies, the guard, and the console's INSERT still working. The live bed
 * keeps 110 exactly as applied.
 *
 * The second part checks the insert trigger on the live bed: every shape of
 * metadata, and the previous dashboard's exact inserts, as the console login
 * (the dashboard's only database login), each in a transaction it rolls
 * back. The trigger and the one-time scrub share one transform, and a test
 * asserts they agree.
 *
 * All values are synthetic (helpers/audit-value-samples.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { withLoginClient } from './helpers/login-pool';
import { fakeUuid } from './helpers/audit-events';
import { VALUE_SCAN_NEGATIVES, VALUE_SCAN_POSITIVES } from './helpers/audit-value-samples';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: dashboard action record PostgreSQL gate was not run', () => {
    console.warn('[audit-admin-legacy] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const MIGRATION = path.join(__dirname, '..', '..', '..', 'db', 'migrations', '110_admin_audit_log_freeze.sql');
const PHONE = '+15555550123';
const EMAIL = 'reviewer-legacy@example.com';
const LINK = 'https://example.com/case/1';

interface PgError { code?: string; message?: string }
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

/** The previous dashboard's summary (admin/src/lib/audit-contract.ts). */
const oldSummary = (actor: string, action: string, targetType: string, targetId: string, justification?: string, note?: string) =>
  [`${actor} requested ${action} for ${targetType} ${targetId}.`,
    ...(justification ? [`Justification: ${justification.replace(/[.!?]+$/, '')}.`] : []),
    ...(note ? [`Note: ${note.replace(/[.!?]+$/, '')}.`] : [])].join(' ');

/** One record as the previous dashboard writes it, plus the metadata 110 must leave. */
interface Shape {
  label: string;
  role: string;
  action: string;
  targetType: string;
  metadata: Json | undefined;
  expected: Record<string, unknown>;
}

function shapes(targetId: string): Shape[] {
  const dispatch = {
    summary: oldSummary(EMAIL, 'reveal_contact', 'admin_case', targetId, `Calling back on ${PHONE} about the case`, 'Reply sent: see you at the site'),
    justification: `Calling back on ${PHONE} about the case.`,
    note: 'Reply sent: see you at the site.',
  };
  return [
    {
      label: 'a reveal with a value in its justification and a reply note', role: 'admin_ops', action: 'reveal_contact',
      targetType: 'admin_case', metadata: dispatch,
      expected: { justification: 'Calling back on [removed] about the case.', summary: 'admin_ops requested reveal_contact for admin_case.' },
    },
    {
      label: 'a resolve with a plain justification and no note', role: 'admin_ops', action: 'resolve_case', targetType: 'admin_case',
      metadata: { summary: oldSummary(EMAIL, 'resolve_case', 'admin_case', targetId, 'Duplicate of an older case'), justification: 'Duplicate of an older case.' },
      expected: { justification: 'Duplicate of an older case.', summary: 'admin_ops requested resolve_case for admin_case.' },
    },
    {
      label: 'a session revocation with a count', role: 'admin_superadmin', action: 'revoke_admin_sessions', targetType: 'admin_user',
      metadata: { revokedCount: 3 },
      expected: { revokedCount: 3, summary: 'admin_superadmin requested revoke_admin_sessions for admin_user.' },
    },
    {
      label: 'an object with an unknown text key and a link', role: 'admin_ops', action: 'request_more_info', targetType: 'admin_case',
      metadata: { other: `See ${LINK}`, flag: true, justification: `Mailed ${EMAIL}` },
      expected: { flag: true, justification: 'Mailed [removed]', summary: 'admin_ops requested request_more_info for admin_case.' },
    },
    {
      label: 'metadata that is an array', role: 'admin_readonly', action: 'view', targetType: 'verification',
      metadata: [`call ${PHONE}`],
      expected: { summary: 'admin_readonly requested view for verification.' },
    },
    {
      label: 'metadata that is a string', role: 'system', action: 'auto_close', targetType: 'admin_case',
      metadata: `call ${PHONE}`,
      expected: { summary: 'system requested auto_close for admin_case.' },
    },
    {
      label: 'empty metadata', role: 'admin_ops', action: 'resolve_case', targetType: 'admin_case',
      metadata: {},
      expected: { summary: 'admin_ops requested resolve_case for admin_case.' },
    },
    {
      label: 'a justification that is not text', role: 'admin_ops', action: 'resolve_case', targetType: 'admin_case',
      metadata: { justification: { text: PHONE } },
      expected: { summary: 'admin_ops requested resolve_case for admin_case.' },
    },
  ];
}

async function failure(run: () => Promise<unknown>): Promise<PgError | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return { code: (err as PgError).code, message: (err as PgError).message };
  }
}

/** Runs `sql` in a savepoint; returns its SQLSTATE, or `ok`. */
async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<string> {
  await c.query('SAVEPOINT attempt');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT attempt');
    return 'ok';
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT attempt');
    return (err as PgError).code ?? 'error';
  }
}

/** The table as it was before 110: what 110 adds is dropped, and jale_admin owns it again. */
async function backToBefore108(c: Client): Promise<void> {
  await c.query(`
    DROP TRIGGER admin_audit_log_scrub ON public.admin_audit_log;
    DROP TRIGGER admin_audit_log_append_only ON public.admin_audit_log;
    DROP TRIGGER admin_audit_log_no_truncate ON public.admin_audit_log;
    DROP POLICY admin_audit_log_audit_owner_read ON public.admin_audit_log;
    DROP POLICY admin_audit_log_audit_owner_purge ON public.admin_audit_log;
    ALTER TABLE public.admin_audit_log OWNER TO jale_admin;
    DROP FUNCTION jale_audit.legacy_line(public.admin_audit_log);
    DROP FUNCTION jale_audit.scrub_legacy_row();
    DROP FUNCTION jale_audit.scrub_legacy_metadata(jsonb, text, text, text);
    DROP FUNCTION jale_audit.legacy_admin_id(text);
    DROP FUNCTION jale_audit.legacy_summary(text, text, text);
    DROP FUNCTION jale_audit.redact_value_spans(text);
    ALTER TABLE public.admin_audit_log DROP COLUMN seq, DROP COLUMN xact;
    DELETE FROM public.admin_audit_log;
  `);
}

/** 110's statements, without its own BEGIN and COMMIT. */
function migrationBody(): string {
  const text = fs.readFileSync(MIGRATION, 'utf8');
  return text.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
}

/** Inserts one record the way the previous dashboard does, as the current role. */
async function insertOld(c: Client, s: Shape, targetId: string, createdAt?: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.admin_audit_log (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata${createdAt ? ', created_at' : ''})
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb${createdAt ? ', $8' : ''}) RETURNING id`,
    [EMAIL, s.role, s.action, s.targetType, targetId, s.action === 'reveal_contact',
      s.metadata === undefined ? null : JSON.stringify(s.metadata), ...(createdAt ? [createdAt] : [])],
  );
  return rows[0].id;
}

maybeDescribe('dashboard action records', () => {
  describe('migration 110 on records the previous dashboard wrote', () => {
    let c: Client;
    const notices: string[] = [];
    const targetId = fakeUuid(0x10801);
    const seeded: Array<{ id: string; shape: Shape }> = [];

    beforeAll(async () => {
      c = new Client({ connectionString: databaseUrl });
      await c.connect();
      c.on('notice', (msg) => notices.push(String(msg.message)));
      await c.query('BEGIN');
      await backToBefore108(c);
      // The previous dashboard writes as the console login.
      await c.query('SET LOCAL ROLE jale_admin_console');
      const base = Date.UTC(2026, 0, 5, 12, 0, 0);
      for (const [i, shape] of shapes(targetId).entries()) {
        // Newest first, so seq numbering by created_at is visible.
        const id = await insertOld(c, shape, targetId, new Date(base - i * 60_000).toISOString());
        seeded.push({ id, shape });
      }
      await c.query('RESET ROLE');
      await c.query('SET SESSION AUTHORIZATION jale_admin');
      await c.query(migrationBody());
      await c.query('RESET SESSION AUTHORIZATION');
    });

    afterAll(async () => {
      await c?.query('ROLLBACK').catch(() => undefined);
      await c?.end();
    });

    it('prints counts only', () => {
      const ours = notices.filter((n) => n.startsWith('migration 110:'));
      expect(ours).toEqual([
        'migration 110: 8 dashboard action records; 1 notes removed; 2 summaries replaced; 2 justifications with value-shaped spans; 4 with other free text dropped',
        'migration 110: 0 admin ids filled from a unique email match; 8 records left without an admin id',
      ]);
      for (const value of [PHONE, EMAIL, LINK, 'Reply sent']) expect(notices.join('\n')).not.toContain(value);
    });

    it('leaves every record with exactly the transform\'s metadata', async () => {
      const { rows } = await c.query<{ id: string; metadata: unknown }>(
        'SELECT id, metadata FROM public.admin_audit_log WHERE id = ANY($1::uuid[])', [seeded.map((s) => s.id)]);
      const byId = new Map(rows.map((r) => [r.id, r.metadata]));
      for (const { id, shape } of seeded) expect([shape.label, byId.get(id)]).toEqual([shape.label, shape.expected]);
      // The metadata only: the record ids are random UUIDs, which may contain '555'.
      expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/555|example\.com|Reply sent/);
    });

    it('numbers the records in created_at order and stamps the migration\'s transaction', async () => {
      const { rows } = await c.query<{ seq: string; xact: string; mine: string }>(
        `SELECT seq::text, xact::text, pg_current_xact_id()::text AS mine FROM public.admin_audit_log ORDER BY created_at, id`);
      expect(rows.map((r) => r.seq)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      expect(new Set(rows.map((r) => r.xact))).toEqual(new Set([rows[0].mine]));
    });

    it('hands the table to jale_audit_owner, keeping every grant and policy', async () => {
      const { rows } = await c.query(
        `SELECT pg_catalog.pg_get_userbyid(cl.relowner) AS owner, cl.relrowsecurity, cl.relforcerowsecurity,
                ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type
                        FROM aclexplode(cl.relacl) a WHERE a.grantee <> cl.relowner ORDER BY 1)::text[] AS grants,
                ARRAY(SELECT p.polname || ':' || p.polcmd::text || ':' || COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '-')
                        FROM pg_catalog.pg_policy p WHERE p.polrelid = cl.oid ORDER BY p.polname)::text[] AS policies,
                ARRAY(SELECT t.tgname || ':' || t.tgenabled::text FROM pg_catalog.pg_trigger t
                       WHERE t.tgrelid = cl.oid AND NOT t.tgisinternal ORDER BY t.tgname)::text[] AS triggers,
                pg_catalog.has_schema_privilege('jale_audit_owner', 'public', 'CREATE') AS owner_create
           FROM pg_catalog.pg_class cl WHERE cl.oid = 'public.admin_audit_log'::regclass`,
      );
      expect(rows[0]).toEqual({
        owner: 'jale_audit_owner', relrowsecurity: true, relforcerowsecurity: true,
        grants: ['jale_admin_console:INSERT', 'jale_admin_console:SELECT'],
        policies: [
          "admin_audit_log_audit_owner_purge:d:(current_setting('jale_audit.purge'::text, true) = 'on'::text)",
          'admin_audit_log_audit_owner_read:r:true',
          'admin_audit_log_insert:a:-',
          'admin_audit_log_select:r:true',
        ],
        triggers: ['admin_audit_log_append_only:O', 'admin_audit_log_no_truncate:O', 'admin_audit_log_scrub:O'],
        owner_create: false,
      });
    });

    it('keeps the previous dashboard working: its inserts are scrubbed on the way in, its /audit read finds a summary', async () => {
      const [first] = shapes(targetId);
      await c.query('SET LOCAL ROLE jale_admin_console');
      const id = await insertOld(c, first, targetId);
      const { rows } = await c.query<{ id: string; metadata: Record<string, unknown> }>(
        `SELECT id, created_at, actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata
           FROM admin_audit_log ORDER BY created_at DESC LIMIT $1`, [200]);
      const count = (await c.query<{ count: string }>('SELECT COUNT(*) AS count FROM admin_audit_log')).rows[0].count;
      await c.query('RESET ROLE');
      expect(rows.find((r) => r.id === id)!.metadata).toEqual(first.expected);
      expect(rows.every((r) => typeof r.metadata.summary === 'string')).toBe(true);
      expect(count).toBe('9');
    });

    it('agrees with the insert trigger: the same record scrubs the same way once and on the way in', async () => {
      for (const { id, shape } of seeded) {
        await c.query('SET LOCAL ROLE jale_admin_console');
        const fresh = await insertOld(c, shape, targetId);
        await c.query('RESET ROLE');
        const { rows } = await c.query<{ id: string; metadata: unknown }>(
          'SELECT id, metadata FROM public.admin_audit_log WHERE id = ANY($1::uuid[])', [[id, fresh]]);
        const byId = new Map(rows.map((r) => [r.id, r.metadata]));
        expect([shape.label, byId.get(fresh)]).toEqual([shape.label, byId.get(id)]);
      }
    });

    it('binds the guard: a superuser cannot UPDATE, DELETE or TRUNCATE a record', async () => {
      expect({
        update: await attempt(c, `UPDATE public.admin_audit_log SET action = 'x'`),
        delete: await attempt(c, 'DELETE FROM public.admin_audit_log'),
        truncate: await attempt(c, 'TRUNCATE public.admin_audit_log'),
      }).toEqual({ update: '55000', delete: '55000', truncate: '55000' });
    });
  });

  describe('migration 110 fills admin ids from a unique email match', () => {
    let c: Client;
    const notices: string[] = [];
    const targetId = fakeUuid(0x11010);
    const admins = {
      unique: fakeUuid(0x11011), dupLower: fakeUuid(0x11012), dupUpper: fakeUuid(0x11013), explicit: fakeUuid(0x11014),
    };
    const rec: Record<string, string> = {};

    beforeAll(async () => {
      c = new Client({ connectionString: databaseUrl });
      await c.connect();
      c.on('notice', (msg) => notices.push(String(msg.message)));
      await c.query('BEGIN');
      await backToBefore108(c);
      await c.query(
        `INSERT INTO public.admin_users (id, admin_email, role) VALUES
           ($1, 'Backfill-Unique@example.com', 'admin_ops'),
           ($2, 'backfill-dup@example.com', 'admin_ops'),
           ($3, 'Backfill-Dup@example.com', 'admin_ops'),
           ($4, 'backfill-explicit@example.com', 'admin_ops')`,
        [admins.unique, admins.dupLower, admins.dupUpper, admins.explicit]);
      // The previous dashboard writes as the console login, with the email only.
      await c.query('SET LOCAL ROLE jale_admin_console');
      const insert = async (adminId: string | null, email: string): Promise<string> => (await c.query<{ id: string }>(
        `INSERT INTO public.admin_audit_log (actor_admin_id, actor_email, actor_role, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'admin_ops', 'resolve_case', 'admin_case', $3, '{}'::jsonb) RETURNING id::text`,
        [adminId, email, targetId])).rows[0].id;
      rec.unique = await insert(null, 'backfill-unique@EXAMPLE.com');
      rec.dup = await insert(null, 'BACKFILL-DUP@example.com');
      rec.unknown = await insert(null, 'backfill-unknown@example.com');
      rec.explicit = await insert(admins.explicit, 'Backfill-Unique@example.com');
      await c.query('RESET ROLE');
      await c.query('SET SESSION AUTHORIZATION jale_admin');
      await c.query(migrationBody());
      await c.query('RESET SESSION AUTHORIZATION');
    });

    afterAll(async () => {
      await c?.query('ROLLBACK').catch(() => undefined);
      await c?.end();
    });

    it('fills a unique case-insensitive match, leaves no match and several matches empty, and keeps a stored id', async () => {
      const { rows } = await c.query<{ id: string; actor_admin_id: string | null }>(
        'SELECT id::text, actor_admin_id::text FROM public.admin_audit_log WHERE id = ANY ($1::uuid[])', [Object.values(rec)]);
      const byId = new Map(rows.map((r) => [r.id, r.actor_admin_id]));
      expect(byId.get(rec.unique)).toBe(admins.unique);
      expect(byId.get(rec.dup)).toBeNull();
      expect(byId.get(rec.unknown)).toBeNull();
      expect(byId.get(rec.explicit)).toBe(admins.explicit);
    });

    it('prints the counts only', () => {
      expect(notices.filter((n) => n.startsWith('migration 110: ') && n.includes('admin id'))).toEqual([
        'migration 110: 1 admin ids filled from a unique email match; 2 records left without an admin id',
      ]);
      expect(notices.join('\n')).not.toContain('@');
    });

    it('renders every line without an email address', async () => {
      const { rows } = await c.query<{ line: string }>(
        'SELECT jale_audit.legacy_line(l) AS line FROM public.admin_audit_log l WHERE l.id = ANY ($1::uuid[])', [Object.values(rec)]);
      expect(rows).toHaveLength(4);
      for (const { line } of rows) expect(line).not.toContain('@');
    });

    it('the backfill and the insert trigger use the same lookup', async () => {
      const { rows } = await c.query<{ src: string }>(
        `SELECT pg_catalog.pg_get_functiondef('jale_audit.scrub_legacy_row()'::regprocedure) AS src`);
      expect(rows[0].src).toContain('jale_audit.legacy_admin_id(NEW.actor_email)');
      expect(fs.readFileSync(MIGRATION, 'utf8')).toContain('SET actor_admin_id = jale_audit.legacy_admin_id(l.actor_email)');
    });
  });

  describe('the insert trigger on the live bed', () => {
    const targetId = fakeUuid(0x10802);

    async function insertAndRead(login: string, sql: string, params: unknown[]): Promise<{ metadata: unknown; xact_is_mine: boolean }> {
      return withLoginClient(login, async (c) => {
        await c.query('BEGIN');
        try {
          const { rows } = await c.query<{ id: string }>(`${sql} RETURNING id`, params);
          const read = await c.query<{ metadata: unknown; xact_is_mine: boolean }>(
            `SELECT metadata, xact = pg_current_xact_id() AS xact_is_mine FROM admin_audit_log WHERE id = $1`, [rows[0].id]);
          return read.rows[0];
        } finally {
          await c.query('ROLLBACK');
        }
      });
    }

    describe.each(['jale_admin_console'])('as %s', (login) => {
      it.each(shapes(targetId).map((s) => [s.label, s] as const))('stores the scrubbed form of %s', async (_label, shape) => {
        const row = await insertAndRead(login,
          `INSERT INTO admin_audit_log (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [EMAIL, shape.role, shape.action, shape.targetType, targetId, false, JSON.stringify(shape.metadata)]);
        expect(row).toEqual({ metadata: shape.expected, xact_is_mine: true });
      });

      it('stores a record whose metadata is NULL, with the summary alone', async () => {
        const row = await insertAndRead(login,
          `INSERT INTO admin_audit_log (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
           VALUES ($1, 'admin_ops', 'resolve_case', 'admin_case', $2, false, NULL)`, [EMAIL, targetId]);
        expect(row.metadata).toEqual({ summary: 'admin_ops requested resolve_case for admin_case.' });
      });

      it('stores the previous dashboard\'s exact action insert (admin-action-dispatch.ts)', async () => {
        const justification = `Calling back on ${PHONE} about the case`;
        const note = 'Reply sent: see you at the site';
        const row = await insertAndRead(login,
          `INSERT INTO admin_audit_log
            (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [EMAIL, 'admin_ops', 'reveal_contact', 'admin_case', targetId, true, JSON.stringify({
            summary: oldSummary(EMAIL, 'reveal_contact', 'admin_case', targetId, justification, note),
            justification: `${justification}.`,
            note: `${note}.`,
          })]);
        expect(row).toEqual({
          metadata: { justification: 'Calling back on [removed] about the case.', summary: 'admin_ops requested reveal_contact for admin_case.' },
          xact_is_mine: true,
        });
      });

      it('stores the previous dashboard\'s exact revoke-all insert (revoke-all/route.ts)', async () => {
        const row = await insertAndRead(login,
          `INSERT INTO admin_audit_log
            (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
           VALUES ($1, $2, 'revoke_admin_sessions', 'admin_user', $3, false, $4::jsonb)`,
          [EMAIL, 'admin_superadmin', fakeUuid(0x10803), JSON.stringify({ revokedCount: 2 })]);
        expect(row.metadata).toEqual({ revokedCount: 2, summary: 'admin_superadmin requested revoke_admin_sessions for admin_user.' });
      });
    });

    it('only the console writes and reads the records: jale_admin holds no privilege on them', async () => {
      const codes = await withLoginClient('jale_admin', async (c) => ({
        insert: (await failure(() => c.query(
          `INSERT INTO admin_audit_log (actor_email, actor_role, action, target_type, target_id, metadata)
           VALUES ($1, 'admin_ops', 'resolve_case', 'admin_case', $2, '{}'::jsonb)`, [EMAIL, targetId])))?.code,
        select: (await failure(() => c.query('SELECT 1 FROM admin_audit_log LIMIT 1')))?.code,
      }));
      expect(codes).toEqual({ insert: '42501', select: '42501' });
    });

    it('ignores an xact the writer passes: the record is stamped with the writing transaction', async () => {
      const row = await insertAndRead('jale_admin_console',
        `INSERT INTO admin_audit_log (actor_email, actor_role, action, target_type, target_id, metadata, xact)
         VALUES ($1, 'admin_ops', 'resolve_case', 'admin_case', $2, '{}'::jsonb, '3'::xid8)`, [EMAIL, targetId]);
      expect(row.xact_is_mine).toBe(true);
    });

    it('the trigger and the one-time scrub call the same transform', async () => {
      const su = new Client({ connectionString: databaseUrl });
      await su.connect();
      try {
        const { rows } = await su.query<{ src: string }>(
          `SELECT pg_catalog.pg_get_functiondef('jale_audit.scrub_legacy_row()'::regprocedure) AS src`);
        expect(rows[0].src).toContain('jale_audit.scrub_legacy_metadata(NEW.metadata, NEW.actor_role, NEW.action, NEW.target_type)');
        const migration = fs.readFileSync(MIGRATION, 'utf8');
        expect(migration).toContain('SET metadata = jale_audit.scrub_legacy_metadata(l.metadata, l.actor_role, l.action, l.target_type)');
      } finally {
        await su.end();
      }
    });

    /** Runs `body` in one superuser transaction that is rolled back, with the given admins in place. */
    async function withAdmins<T>(admins: Array<[string, string]>, body: (su: Client) => Promise<T>): Promise<T> {
      const su = new Client({ connectionString: databaseUrl });
      await su.connect();
      try {
        await su.query('BEGIN');
        for (const [id, email] of admins) {
          await su.query(`INSERT INTO public.admin_users (id, admin_email, role) VALUES ($1, $2, 'admin_ops')`, [id, email]);
        }
        return await body(su);
      } finally {
        await su.query('ROLLBACK').catch(() => undefined);
        await su.end();
      }
    }

    /** One record the way the previous dashboard writes it (email only), inserted as the console. */
    async function insertAsConsole(su: Client, email: string, adminId: string | null = null): Promise<{ id: string; actor_admin_id: string | null }> {
      await su.query('SET LOCAL ROLE jale_admin_console');
      try {
        return (await su.query<{ id: string; actor_admin_id: string | null }>(
          `INSERT INTO admin_audit_log (actor_admin_id, actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
           VALUES ($1, $2, 'admin_ops', 'resolve_case', 'admin_case', $3, false, '{}'::jsonb)
           RETURNING id::text, actor_admin_id::text`, [adminId, email, targetId])).rows[0];
      } finally {
        await su.query('RESET ROLE');
      }
    }

    const lineOf = async (su: Client, id: string): Promise<string> =>
      (await su.query<{ line: string }>('SELECT jale_audit.legacy_line(l) AS line FROM public.admin_audit_log l WHERE l.id = $1', [id])).rows[0].line;

    it('fills the admin id of an email-only insert from exactly one matching admin', async () => {
      const admin = fakeUuid(0x11021);
      const explicit = fakeUuid(0x11022);
      await withAdmins([[admin, 'Trigger-Unique@example.com'], [explicit, 'trigger-explicit@example.com']], async (su) => {
        expect((await insertAsConsole(su, 'TRIGGER-UNIQUE@example.com')).actor_admin_id).toBe(admin);
        expect((await insertAsConsole(su, 'trigger-unknown@example.com')).actor_admin_id).toBeNull();
        expect((await insertAsConsole(su, 'Trigger-Unique@example.com', explicit)).actor_admin_id).toBe(explicit);
      });
    });

    it('leaves the id empty, and still stores the record, when admins differ only by case', async () => {
      await withAdmins([[fakeUuid(0x11023), 'trigger-dup@example.com'], [fakeUuid(0x11024), 'Trigger-Dup@example.com']], async (su) => {
        const row = await insertAsConsole(su, 'TRIGGER-DUP@example.com');
        expect(row.actor_admin_id).toBeNull();
        const line = await lineOf(su, row.id);
        expect(JSON.parse(line).actor_admin_id).toBeNull();
        expect(line).not.toContain('@');
      });
    });

    it('a line stays byte-identical when the matching admin\'s email changes', async () => {
      const admin = fakeUuid(0x11025);
      await withAdmins([[admin, 'trigger-stable@example.com']], async (su) => {
        const row = await insertAsConsole(su, 'trigger-stable@example.com');
        const before = await lineOf(su, row.id);
        await su.query(`UPDATE public.admin_users SET admin_email = 'trigger-renamed@example.com' WHERE id = $1`, [admin]);
        const after = await lineOf(su, row.id);
        expect(after).toBe(before);
        expect(JSON.parse(after).actor_admin_id).toBe(admin);
        expect(Object.keys(JSON.parse(after))).not.toContain('actor_email');
        expect(after).not.toContain('@');
      });
    });
  });

  describe('the value-span rule (shared samples)', () => {
    let su: Client;
    beforeAll(async () => {
      su = new Client({ connectionString: databaseUrl });
      await su.connect();
    });
    afterAll(async () => {
      await su?.end();
    });
    const redact = async (text: string) =>
      (await su.query<{ out: string }>('SELECT jale_audit.redact_value_spans($1) AS out', [text])).rows[0].out;

    it.each(VALUE_SCAN_NEGATIVES.map(([label, sample]) => [label, sample]))('leaves %s alone', async (_label, sample) => {
      expect(await redact(sample)).toBe(sample);
    });

    it.each(VALUE_SCAN_POSITIVES.map(([label, sample, value]) => [label, sample, value]))(
      'removes %s', async (_label, sample, value) => {
        const out = await redact(sample);
        expect(out).toContain('[removed]');
        expect(out).not.toContain(value);
        expect(out).toBe(sample.replace(value, '[removed]'));
      },
    );

    it('is executable by its owner only', async () => {
      for (const login of ['jale_admin_console', 'jale_admin', 'jale_api']) {
        const err = await withLoginClient(login, (c) => failure(() => c.query(`SELECT jale_audit.redact_value_spans('x')`)));
        expect([login, err?.code]).toEqual([login, '42501']);
      }
    });
  });
});
