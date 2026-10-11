/**
 * audit-storage.integration.test.ts -- append-only audit storage (migration 109).
 *
 * Proves on a real database, in every test-bed profile:
 *   - the two NOLOGIN owner roles and their schemas, closed to PUBLIC;
 *   - jale_audit.events and jale_audit.changes, exactly as the tests below list
 *     them, with no grant, no row security and no foreign key;
 *   - jale_audit.record_event(jsonb): every rejection (SQLSTATE 22023), the
 *     columns only defaults fill (db_login, db_pid, xact, occurred_at), and
 *     who may call it.
 *
 * Callers sign in as their real logins (helpers/login-pool.ts), never through
 * SET ROLE. Fixtures and read-backs use the superuser URL the bed exports.
 * Every fixture value is synthetic (helpers/audit-events.ts).
 */
import { Client } from 'pg';
import { loadManifest, runtimeLogins } from '../../../db/access/access-manifest';
import { withLoginClient } from './helpers/login-pool';
import {
  AUDIT_CODES, adminRevealEvent, employerReadEvent, fakeUuid, tokenHolderAttemptEvent, without,
  type AuditEvent,
} from './helpers/audit-events';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: audit storage PostgreSQL gate was not run', () => {
    console.warn('[audit-storage] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const RECORDING_LOGINS = ['jale_admin_console', 'jale_api', 'jale_whatsapp'];
const OWNERS = ['jale_audit_owner', 'jale_ops_owner'];

interface PgError { code?: string; message?: string }

async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as PgError).code;
  }
}

async function recordAs(login: string, event: unknown): Promise<string> {
  return withLoginClient(login, async (c) => {
    const { rows } = await c.query<{ seq: string }>('SELECT jale_audit.record_event($1::jsonb) AS seq', [JSON.stringify(event)]);
    return rows[0].seq;
  });
}

/**
 * [label, event, fault] triples record_event must refuse with 22023. `fault`
 * is the key its message must name (`invalid <key>`), or `object` / `unknown
 * key` for the two structural refusals.
 */
function rejectedEvents(): Array<[string, unknown, string]> {
  const read = employerReadEvent();
  const reveal = adminRevealEvent();
  const token = tokenHolderAttemptEvent();
  const tooMany = (n: number) => Array.from({ length: n }, (_, i) => fakeUuid(0x100000 + i));
  return [
    ['a JSON array instead of an object', [read], 'object'],
    ['a JSON string instead of an object', 'read', 'object'],
    ['an unknown key', { ...read, note: 'x' }, 'unknown key'],
    ['a caller-set db_login', { ...read, db_login: 'jale_admin' }, 'unknown key'],
    ['a caller-set db_pid', { ...read, db_pid: 1 }, 'unknown key'],
    ['a caller-set xact', { ...read, xact: '1' }, 'unknown key'],
    ['a caller-set occurred_at', { ...read, occurred_at: '2026-01-01T00:00:00Z' }, 'unknown key'],
    ['a caller-set seq', { ...read, seq: 1 }, 'unknown key'],
    ['a caller-set event_id', { ...read, event_id: fakeUuid(9) }, 'unknown key'],
    ['a missing kind', without(read, 'kind'), 'kind'],
    ['a kind outside the list', { ...read, kind: 'view' }, 'kind'],
    ['a missing outcome', without(read, 'outcome'), 'outcome'],
    ['an outcome that does not pair with its kind', { ...read, outcome: 'denied' }, 'outcome'],
    ['an outcome outside every list', { ...read, kind: 'attempt', outcome: 'blocked' }, 'outcome'],
    ['a missing actor_kind', without(read, 'actor_kind'), 'actor_kind'],
    ['an actor_kind outside the list', { ...read, actor_kind: 'system' }, 'actor_kind'],
    ['a worker actor without an actor_id', without({ ...read, actor_kind: 'worker' }, 'actor_id'), 'actor_id'],
    ['an employer actor without an actor_id', without(read, 'actor_id'), 'actor_id'],
    ['an admin actor without an actor_id', without(reveal, 'actor_id'), 'actor_id'],
    ['a platform actor with an actor_id', { ...token, actor_kind: 'platform', actor_id: fakeUuid(1) }, 'actor_id'],
    ['a token holder with an actor_id', { ...token, actor_id: fakeUuid(1) }, 'actor_id'],
    ['an anonymous actor with an actor_id', { ...token, actor_kind: 'anonymous', actor_id: fakeUuid(1) }, 'actor_id'],
    ['an actor_id that is not a UUID', { ...read, actor_id: 'not-a-uuid' }, 'actor_id'],
    ['an actor_id that is not a string', { ...read, actor_id: 7 }, 'actor_id'],
    ['an admin actor without an actor_role', without(reveal, 'actor_role'), 'actor_role'],
    ['an actor_role outside the list', { ...reveal, actor_role: 'admin_root' }, 'actor_role'],
    ['an actor_role on a non-admin actor', { ...read, actor_role: 'admin_ops' }, 'actor_role'],
    ['an actor_session on a non-admin actor', { ...read, actor_session: fakeUuid(2) }, 'actor_session'],
    ['an actor_session that is not a UUID', { ...reveal, actor_session: 'session-1' }, 'actor_session'],
    ['a missing channel', without(read, 'channel'), 'channel'],
    ['a channel outside the list', { ...read, channel: 'sms' }, 'channel'],
    ['a missing surface', without(read, 'surface'), 'surface'],
    ['a surface with one segment', { ...read, surface: 'employer' }, 'surface'],
    ['a surface with five segments', { ...read, surface: 'a.b.c.d.e' }, 'surface'],
    ['a surface with an upper-case letter', { ...read, surface: 'Employer.worker_profile' }, 'surface'],
    ['a surface with a space', { ...read, surface: 'employer.worker profile' }, 'surface'],
    ['missing categories', without(read, 'categories'), 'categories'],
    ['empty categories', { ...read, categories: [] }, 'categories'],
    ['nine categories', { ...read, categories: AUDIT_CODES.categories.slice(0, 9) }, 'categories'],
    ['a category outside the list', { ...read, categories: ['profile', 'phone_numbers'] }, 'categories'],
    ['a category that is not a string', { ...read, categories: ['profile', 3] }, 'categories'],
    ['categories that are not an array', { ...read, categories: 'profile' }, 'categories'],
    ['501 subject ids', { ...read, subject_user_ids: tooMany(501) }, 'subject_user_ids'],
    ['a subject id that is not a UUID', { ...read, subject_user_ids: ['worker-1'] }, 'subject_user_ids'],
    ['subject ids that are not an array', { ...read, subject_user_ids: fakeUuid(3) }, 'subject_user_ids'],
    ['a record_type outside the list', { ...read, record_type: 'phone' }, 'record_type'],
    ['record ids without a record_type', without(read, 'record_type'), 'record_type'],
    ['501 record ids', { ...read, record_ids: tooMany(501) }, 'record_ids'],
    ['a record id that is not a UUID', { ...read, record_ids: ['application-1'] }, 'record_ids'],
    ['a missing result_count', without(read, 'result_count'), 'result_count'],
    ['a negative result_count', { ...read, result_count: -1 }, 'result_count'],
    ['a fractional result_count', { ...read, result_count: 1.5 }, 'result_count'],
    ['a result_count passed as a string', { ...read, result_count: '1' }, 'result_count'],
    ['a result_count beyond int', { ...read, result_count: 3000000000 }, 'result_count'],
    ['a field name with an upper-case letter', { ...read, field_names: ['fullName'] }, 'field_names'],
    ['a field name starting with a digit', { ...read, field_names: ['1st_name'] }, 'field_names'],
    ['a field name with a hyphen', { ...read, field_names: ['full-name'] }, 'field_names'],
    ['a 64-character field name', { ...read, field_names: [`a${'b'.repeat(63)}`] }, 'field_names'],
    ['101 field names', { ...read, field_names: Array.from({ length: 101 }, (_, i) => `f${i}`) }, 'field_names'],
    ['field names that are not an array', { ...read, field_names: 'full_name' }, 'field_names'],
    ['a purpose_kind outside the list', { ...read, purpose_kind: 'curiosity' }, 'purpose_kind'],
    ['a job purpose without a purpose_id', without(read, 'purpose_id'), 'purpose_id'],
    ['a case purpose without a purpose_id', { ...reveal, purpose_kind: 'case', reason: undefined }, 'purpose_id'],
    ['a self purpose with a purpose_id', { ...read, purpose_kind: 'self' }, 'purpose_id'],
    ['a purpose_id that is not a UUID', { ...read, purpose_id: 'job-1' }, 'purpose_id'],
    ['a reason on a non-admin actor', { ...read, purpose_kind: 'reveal', purpose_id: undefined, reason: 'x' }, 'reason'],
    ['a reason without a reveal purpose', { ...reveal, purpose_kind: 'self', reason: 'Synthetic reason.' }, 'reason'],
    ['a reason over 500 characters', { ...reveal, reason: 'r'.repeat(501) }, 'reason'],
    ['an empty reason', { ...reveal, reason: '' }, 'reason'],
    ['a link_expires_at that is not a timestamp', { ...read, link_expires_at: 'soon' }, 'link_expires_at'],
    ['a link_expires_at without a zone', { ...read, link_expires_at: '2026-10-02T12:00:00' }, 'link_expires_at'],
    ['a link_expires_at that is not a date', { ...read, link_expires_at: '2026-13-45T12:00:00Z' }, 'link_expires_at'],
    ['part 0', { ...read, part: 0, parts: 1 }, 'part'],
    ['part beyond parts', { ...read, part: 3, parts: 2 }, 'part'],
    ['a fractional part', { ...read, part: 1.5, parts: 2 }, 'part'],
    ['a request_id with a space', { ...read, request_id: 'test request' }, 'request_id'],
    ['a request_id over 64 characters', { ...read, request_id: 'r'.repeat(65) }, 'request_id'],
    ['an empty request_id', { ...read, request_id: '' }, 'request_id'],
  ];
}

maybeDescribe('audit storage', () => {
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    await su?.end();
  });

  describe('owner roles and schemas', () => {
    it('both owners are NOLOGIN, NOINHERIT roles with no other attribute', async () => {
      const { rows } = await su.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
           FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
        [OWNERS],
      );
      expect(rows).toEqual(OWNERS.map((rolname) => ({
        rolname, rolcanlogin: false, rolsuper: false, rolinherit: false, rolcreaterole: false,
        rolcreatedb: false, rolreplication: false, rolbypassrls: false,
      })));
    });

    it('the owners belong to nothing, and the master keeps only its ADMIN-only creator row', async () => {
      const { rows } = await su.query(
        `SELECT g.rolname AS granted, m.rolname AS member, am.admin_option, am.inherit_option, am.set_option
           FROM pg_catalog.pg_auth_members am
           JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
           JOIN pg_catalog.pg_roles m ON m.oid = am.member
          WHERE g.rolname = ANY($1::text[]) OR m.rolname = ANY($1::text[])
          ORDER BY 1, 2`,
        [OWNERS],
      );
      expect(rows).toEqual(OWNERS.map((granted) => ({
        granted, member: 'jale_admin', admin_option: true, inherit_option: false, set_option: false,
      })));
    });

    it('each owner owns its schema, and neither schema is open to PUBLIC', async () => {
      const { rows } = await su.query(
        `SELECT n.nspname, pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
                EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                         WHERE a.grantee = 0) AS public_access
           FROM pg_catalog.pg_namespace n
          WHERE n.nspname IN ('jale_audit', 'jale_ops') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { nspname: 'jale_audit', owner: 'jale_audit_owner', public_access: false },
        { nspname: 'jale_ops', owner: 'jale_ops_owner', public_access: false },
      ]);
    });

    it('only the callers hold USAGE on jale_audit (recording logins, the export login, the master for holds, the operator owner for the two counts), and nobody CREATE', async () => {
      const { rows } = await su.query<{ grantee: string; privilege_type: string }>(
        `SELECT pg_catalog.pg_get_userbyid(a.grantee) AS grantee, a.privilege_type
           FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
          WHERE n.nspname = 'jale_audit' AND a.grantee <> n.nspowner
          ORDER BY 1, 2`,
      );
      const sorted = [...rows].sort((a, b) => a.grantee.localeCompare(b.grantee));
      const callers = [...RECORDING_LOGINS, 'jale_job_audit_export', 'jale_admin', 'jale_ops_owner'].sort((a, b) => a.localeCompare(b));
      expect(sorted).toEqual(callers.map((grantee) => ({ grantee, privilege_type: 'USAGE' })));
    });

    it('neither owner holds CREATE on public', async () => {
      const { rows } = await su.query<{ rolname: string; can_create: boolean }>(
        `SELECT r.rolname, pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create
           FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[]) ORDER BY 1`,
        [OWNERS],
      );
      expect(rows).toEqual(OWNERS.map((rolname) => ({ rolname, can_create: false })));
    });
  });

  describe('tables', () => {
    async function columns(table: string): Promise<Array<[string, string, boolean]>> {
      const { rows } = await su.query<{ attname: string; type: string; notnull: boolean }>(
        `SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
           FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [table],
      );
      return rows.map((r) => [r.attname, r.type, r.notnull]);
    }

    it('events carries exactly the expected columns, in order', async () => {
      expect(await columns('jale_audit.events')).toEqual([
        ['seq', 'bigint', true],
        ['event_id', 'uuid', true],
        ['xact', 'xid8', true],
        ['occurred_at', 'timestamp with time zone', true],
        ['kind', 'text', true],
        ['outcome', 'text', true],
        ['actor_kind', 'text', true],
        ['actor_id', 'uuid', false],
        ['actor_role', 'text', false],
        ['actor_session', 'uuid', false],
        ['channel', 'text', true],
        ['surface', 'text', true],
        ['categories', 'text[]', true],
        ['subject_user_ids', 'uuid[]', true],
        ['record_type', 'text', false],
        ['record_ids', 'uuid[]', true],
        ['result_count', 'integer', true],
        ['field_names', 'text[]', true],
        ['purpose_kind', 'text', false],
        ['purpose_id', 'uuid', false],
        ['reason', 'text', false],
        ['link_expires_at', 'timestamp with time zone', false],
        ['part', 'smallint', true],
        ['parts', 'smallint', true],
        ['request_id', 'text', false],
        ['db_login', 'name', true],
        ['db_pid', 'integer', true],
      ]);
    });

    it('changes carries exactly the expected columns, in order', async () => {
      expect(await columns('jale_audit.changes')).toEqual([
        ['seq', 'bigint', true],
        ['event_id', 'uuid', true],
        ['xact', 'xid8', true],
        ['occurred_at', 'timestamp with time zone', true],
        ['table_name', 'text', true],
        ['operation', 'text', true],
        ['row_count', 'integer', true],
        ['record_ids', 'uuid[]', false],
        ['subject_user_ids', 'uuid[]', false],
        ['changed_fields', 'text[]', true],
        ['actor_kind', 'text', false],
        ['actor_id', 'uuid', false],
        ['channel', 'text', false],
        ['surface', 'text', false],
        ['request_id', 'text', false],
        ['context_status', 'text', true],
        ['db_login', 'name', true],
        ['db_pid', 'integer', true],
      ]);
    });

    it('seq is an always-generated identity on both tables, and event_id is unique', async () => {
      const { rows } = await su.query(
        `SELECT c.relname, a.attname, a.attidentity
           FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          WHERE c.oid IN ('jale_audit.events'::regclass, 'jale_audit.changes'::regclass) AND a.attname = 'seq'
          ORDER BY 1`,
      );
      expect(rows).toEqual([
        { relname: 'changes', attname: 'seq', attidentity: 'a' },
        { relname: 'events', attname: 'seq', attidentity: 'a' },
      ]);
      const unique = await su.query(
        `SELECT c.relname FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
           JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE c.relnamespace = 'jale_audit'::regnamespace AND i.indisunique AND i.indnatts = 1
            AND a.attname = 'event_id'
          ORDER BY 1`,
      );
      expect(unique.rows.map((r) => r.relname)).toEqual(['changes', 'events']);
    });

    it('events carries the expected indexes', async () => {
      const { rows } = await su.query<{ def: string }>(
        `SELECT regexp_replace(indexdef, '^.* USING ', '') AS def FROM pg_catalog.pg_indexes
          WHERE schemaname = 'jale_audit' AND tablename = 'events' ORDER BY 1`,
      );
      expect(rows.map((r) => r.def)).toEqual(expect.arrayContaining([
        'btree (xact)', 'btree (occurred_at)', 'btree (actor_id, occurred_at)',
        'gin (subject_user_ids)', 'gin (record_ids)',
      ]));
    });

    it('no role but the owner holds any privilege on a jale_audit table', async () => {
      const { rows } = await su.query(
        `SELECT c.relname, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
                ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                        FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                       WHERE a.grantee <> c.relowner)::text[] AS others,
                EXISTS (SELECT 1 FROM pg_catalog.pg_attribute att
                         WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL) AS column_grants
           FROM pg_catalog.pg_class c
          WHERE c.relnamespace = 'jale_audit'::regnamespace AND c.relkind IN ('r', 'p', 'S')
          ORDER BY 1`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect({ ...row, relname: row.relname }).toEqual({
          relname: row.relname, owner: 'jale_audit_owner', others: [], column_grants: false,
        });
      }
    });

    it('no jale_audit table has row security or a foreign key', async () => {
      const { rows } = await su.query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                         WHERE k.contype = 'f' AND (k.conrelid = c.oid OR k.confrelid = c.oid)) AS has_fk
           FROM pg_catalog.pg_class c
          WHERE c.relnamespace = 'jale_audit'::regnamespace AND c.relkind IN ('r', 'p')
          ORDER BY 1`,
      );
      for (const row of rows) {
        expect(row).toEqual({ relname: row.relname, relrowsecurity: false, relforcerowsecurity: false, has_fk: false });
      }
    });

    it('every runtime login is refused a direct read or insert on both tables', async () => {
      const outcomes: string[] = [];
      for (const login of runtimeLogins(loadManifest())) {
        await withLoginClient(login, async (c) => {
          for (const table of ['jale_audit.events', 'jale_audit.changes']) {
            const read = await sqlState(() => c.query(`SELECT 1 FROM ${table} LIMIT 1`));
            const insert = await sqlState(() => c.query(`INSERT INTO ${table} DEFAULT VALUES`));
            if (read !== '42501' || insert !== '42501') outcomes.push(`${login} ${table}: read ${read}, insert ${insert}`);
          }
        });
      }
      expect(outcomes).toEqual([]);
    });
  });

  describe('record_event', () => {
    it('records an employer read event, as jale_api, and returns its seq', async () => {
      const seq = await recordAs('jale_api', employerReadEvent());
      const { rows } = await su.query(
        `SELECT kind, outcome, actor_kind, actor_id::text, channel, surface, categories, subject_user_ids::text[],
                record_type, record_ids::text[], result_count, field_names, purpose_kind, purpose_id::text,
                reason, part, parts, request_id
           FROM jale_audit.events WHERE seq = $1`,
        [seq],
      );
      expect(rows).toEqual([{
        kind: 'read', outcome: 'allowed', actor_kind: 'employer', actor_id: fakeUuid(0xe1), channel: 'web',
        surface: 'employer.worker_profile', categories: ['profile', 'contact_details'],
        subject_user_ids: [fakeUuid(0xa1)], record_type: 'job_application', record_ids: [fakeUuid(0xb1)],
        result_count: 1, field_names: ['full_name', 'phone'], purpose_kind: 'job', purpose_id: fakeUuid(0xc1),
        reason: null, part: 1, parts: 1, request_id: 'test-request-0001',
      }]);
    });

    it('fills db_login, db_pid, xact and occurred_at from defaults, naming the login and not the owner', async () => {
      const result = await withLoginClient('jale_whatsapp', async (c) => {
        await c.query('BEGIN');
        const before = (await c.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0].t;
        const { rows } = await c.query<{ seq: string; pid: number; xact: string }>(
          `SELECT jale_audit.record_event($1::jsonb) AS seq, pg_backend_pid() AS pid, pg_current_xact_id()::text AS xact`,
          [JSON.stringify(employerReadEvent({ actor_kind: 'worker', surface: 'worker.application_details', purpose_kind: 'self', purpose_id: null }))],
        );
        const after = (await c.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0].t;
        await c.query('COMMIT');
        return { ...rows[0], before, after };
      });
      const { rows } = await su.query<{ db_login: string; db_pid: number; xact: string; occurred_at: Date }>(
        'SELECT db_login, db_pid, xact::text AS xact, occurred_at FROM jale_audit.events WHERE seq = $1',
        [result.seq],
      );
      expect(rows[0].db_login).toBe('jale_whatsapp');
      expect(rows[0].db_pid).toBe(result.pid);
      expect(rows[0].xact).toBe(result.xact);
      expect(rows[0].occurred_at.getTime()).toBeGreaterThanOrEqual(result.before.getTime());
      expect(rows[0].occurred_at.getTime()).toBeLessThanOrEqual(result.after.getTime());
    });

    it.each([
      ['an admin reveal with a reason, from the admin console', 'jale_admin_console', adminRevealEvent()],
      ['a token holder attempt with no actor id', 'jale_api', tokenHolderAttemptEvent()],
      ['an anonymous rejected admin sign-in', 'jale_admin_console', tokenHolderAttemptEvent({
        kind: 'session', outcome: 'sign_in_rejected', actor_kind: 'anonymous', channel: 'admin',
        surface: 'admin.session', categories: ['admin_access'],
      })],
      ['a platform action with JSON nulls for absent keys', 'jale_whatsapp', tokenHolderAttemptEvent({
        kind: 'action', outcome: 'done', actor_kind: 'platform', actor_id: null, record_type: null,
        purpose_kind: null, reason: null, link_expires_at: null, request_id: null,
      })],
      ['a signed-link grant split into parts', 'jale_api', employerReadEvent({
        surface: 'employer.worker_documents', categories: ['documents'], record_type: 'worker_document',
        link_expires_at: '2026-10-02T12:15:00.000Z', part: 2, parts: 3,
      })],
      ['500 subjects and 500 records', 'jale_api', employerReadEvent({
        surface: 'employer.job_applicants',
        subject_user_ids: Array.from({ length: 500 }, (_, i) => fakeUuid(0x200000 + i)),
        record_ids: Array.from({ length: 500 }, (_, i) => fakeUuid(0x300000 + i)),
        result_count: 500,
      })],
      ['a 500-character reason and a 64-character request id', 'jale_admin_console', adminRevealEvent({
        reason: 'r'.repeat(500), request_id: 'R'.repeat(64),
      })],
      ['eight categories and a 63-character field name', 'jale_admin_console', adminRevealEvent({
        purpose_kind: 'audit_review', reason: null,
        categories: AUDIT_CODES.categories.slice(0, 8), field_names: [`a${'b'.repeat(62)}`],
      })],
    ])('accepts %s', async (_label, login, event) => {
      const seq = await recordAs(login, event);
      expect(Number(seq)).toBeGreaterThan(0);
    });

    it.each(rejectedEvents())('rejects %s with 22023', async (_label, event, fault) => {
      const error = await withLoginClient('jale_api', async (c) => {
        try {
          await c.query('SELECT jale_audit.record_event($1::jsonb)', [JSON.stringify(event)]);
          return undefined;
        } catch (err) {
          return err as PgError;
        }
      });
      const expected = fault === 'object' ? 'the event must be a JSON object'
        : fault === 'unknown key' ? 'unknown key' : `invalid ${fault}`;
      expect({ code: error?.code, message: error?.message }).toEqual({ code: '22023', message: `record_event: ${expected}` });
    });

    it('rejects a SQL NULL event with 22023', async () => {
      const code = await withLoginClient('jale_api', (c) => sqlState(() => c.query('SELECT jale_audit.record_event(NULL)')));
      expect(code).toBe('22023');
    });

    it('never echoes a rejected value in its error message', async () => {
      const marker = 'zz-synthetic-marker-zz';
      const refusals: Array<{ code?: string; message: string }> = [];
      for (const event of [
        { ...employerReadEvent(), [marker]: 1 },
        { ...employerReadEvent(), surface: marker },
        { ...employerReadEvent(), actor_id: marker },
        { ...employerReadEvent(), categories: [marker] },
        { ...employerReadEvent(), field_names: [marker] },
        { ...adminRevealEvent(), reason: `${marker}${'r'.repeat(500)}` },
      ]) {
        await withLoginClient('jale_api', async (c) => {
          try {
            await c.query('SELECT jale_audit.record_event($1::jsonb)', [JSON.stringify(event)]);
            refusals.push({ message: 'accepted' });
          } catch (err) {
            refusals.push({ code: (err as PgError).code, message: (err as PgError).message ?? '' });
          }
        });
      }
      expect(refusals).toHaveLength(6);
      for (const refusal of refusals) {
        expect(refusal.code).toBe('22023');
        expect(refusal.message).toMatch(/^record_event: /);
        expect(refusal.message).not.toContain(marker);
      }
    });

    it('stores nothing when it rejects', async () => {
      const before = (await su.query<{ n: string }>('SELECT count(*) AS n FROM jale_audit.events')).rows[0].n;
      for (const [, event] of rejectedEvents()) {
        await withLoginClient('jale_api', (c) => sqlState(() =>
          c.query('SELECT jale_audit.record_event($1::jsonb)', [JSON.stringify(event)])));
      }
      const after = (await su.query<{ n: string }>('SELECT count(*) AS n FROM jale_audit.events')).rows[0].n;
      expect(after).toBe(before);
    });

    it('is executable by exactly the three recording logins, and the owner', async () => {
      const { rows } = await su.query<{ grantee: string }>(
        `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = 'jale_audit.record_event(jsonb)'::regprocedure AND a.privilege_type = 'EXECUTE'
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.grantee).sort()).toEqual([...RECORDING_LOGINS, 'jale_audit_owner'].sort());
    });

    it('is a definer owned by jale_audit_owner with a pinned search_path', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig
           FROM pg_catalog.pg_proc p WHERE p.oid = 'jale_audit.record_event(jsonb)'::regprocedure`,
      );
      expect(rows).toEqual([{ owner: 'jale_audit_owner', prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] }]);
    });

    it('every other runtime login, and the master, is refused with 42501', async () => {
      const others = [...runtimeLogins(loadManifest()).filter((l) => !RECORDING_LOGINS.includes(l)), 'jale_admin'];
      const outcomes: Array<[string, string | undefined]> = [];
      for (const login of others) {
        outcomes.push([login, await withLoginClient(login, (c) => sqlState(() =>
          c.query('SELECT jale_audit.record_event($1::jsonb)', [JSON.stringify(employerReadEvent())])))]);
      }
      expect(outcomes).toEqual(others.map((login) => [login, '42501']));
    });
  });

  describe('the guard', () => {
    /** Every append-only table: the five jale_audit tables (109) and the dashboard's records (110). */
    const AUDIT_TABLES = [
      'jale_audit.changes', 'jale_audit.events', 'jale_audit.export_batches',
      'jale_audit.export_holds', 'jale_audit.export_state',
    ];
    const GUARDED = [...AUDIT_TABLES, 'public.admin_audit_log'];
    /** A no-op assignment to a column each table has. */
    const SET_CLAUSE: Record<string, string> = {
      'jale_audit.changes': 'xact = xact',
      'jale_audit.events': 'xact = xact',
      'jale_audit.export_batches': 'row_count = row_count',
      'jale_audit.export_holds': 'action = action',
      'jale_audit.export_state': 'watermark = watermark',
      'public.admin_audit_log': 'action = action',
    };
    const changes = (table: string) => [`UPDATE ${table} SET ${SET_CLAUSE[table]}`, `DELETE FROM ${table}`, `TRUNCATE ${table}`];

    /** Runs `sql` inside a savepoint: its SQLSTATE on failure, `ok:<rows>` on success. */
    async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<string> {
      await c.query('SAVEPOINT attempt');
      try {
        const result = await c.query(sql, params);
        await c.query('RELEASE SAVEPOINT attempt');
        return `ok:${result.rowCount ?? 0}`;
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT attempt');
        return (err as PgError).code ?? 'error';
      }
    }

    /** Opens a superuser transaction with one fixture row in every guarded table. */
    async function withFixtures<T>(fn: (c: Client, f: Record<string, string>) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: databaseUrl });
      await c.connect();
      await c.query('BEGIN');
      try {
        const f: Record<string, string> = {};
        f.event = (await c.query<{ seq: string }>(
          `INSERT INTO jale_audit.events (kind, outcome, actor_kind, actor_id, actor_role, channel, surface, categories,
                                          result_count, purpose_kind, reason)
           VALUES ('read', 'allowed', 'admin', $1, 'admin_ops', 'admin', 'admin.case_detail', '{contact_details}', 1,
                   'reveal', 'Synthetic reason for a guard test.')
           RETURNING seq`, [fakeUuid(0x9001)])).rows[0].seq;
        f.change = (await c.query<{ seq: string }>(
          `INSERT INTO jale_audit.changes (table_name, operation, row_count, changed_fields, context_status)
           VALUES ('public.users', 'update', 1, '{email}', 'unset') RETURNING seq`)).rows[0].seq;
        f.batch = (await c.query<{ seq: string }>(
          `INSERT INTO jale_audit.export_batches (stream, batch_kind, from_xact, to_xact, row_count)
           VALUES ('changes', 'window', '1', '2', 0) RETURNING seq`)).rows[0].seq;
        f.hold = (await c.query<{ seq: string }>(
          `INSERT INTO jale_audit.export_holds (stream, row_seq, action, batch_seq)
           VALUES ('changes', $1, 'hold', $2) RETURNING seq`, [f.change, f.batch])).rows[0].seq;
        f.legacy = (await c.query<{ id: string }>(
          `INSERT INTO public.admin_audit_log (actor_role, action, target_type, target_id)
           VALUES ('admin_ops', 'resolve_case', 'admin_case', $1) RETURNING id`, [fakeUuid(0x9002)])).rows[0].id;
        return await fn(c, f);
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    }

    it('binds the reject function to every append-only table, before each row change and each truncate, enabled', async () => {
      const { rows } = await su.query<{ tbl: string; timing: string; level: string; events: string; enabled: string }>(
        `SELECT n.nspname || '.' || c.relname AS tbl,
                CASE WHEN t.tgtype & 2 = 2 THEN 'before' ELSE 'after' END AS timing,
                CASE WHEN t.tgtype & 1 = 1 THEN 'row' ELSE 'statement' END AS level,
                concat_ws(',', CASE WHEN t.tgtype & 4 = 4 THEN 'insert' END, CASE WHEN t.tgtype & 8 = 8 THEN 'delete' END,
                               CASE WHEN t.tgtype & 16 = 16 THEN 'update' END, CASE WHEN t.tgtype & 32 = 32 THEN 'truncate' END) AS events,
                t.tgenabled AS enabled
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND t.tgfoid = 'jale_audit.reject_change()'::regprocedure`,
      );
      const got = rows.map((r) => `${r.tbl} ${r.timing} ${r.level} ${r.events} ${r.enabled}`).sort();
      const want = GUARDED.flatMap((t) => [`${t} before row delete,update O`, `${t} before statement truncate O`]).sort();
      expect(got).toEqual(want);
    });

    it('the reject function is a definer owned by jale_audit_owner and executable by nobody else', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee <> p.proowner)::text[] AS others
           FROM pg_catalog.pg_proc p WHERE p.oid = 'jale_audit.reject_change()'::regprocedure`,
      );
      expect(rows).toEqual([{ owner: 'jale_audit_owner', prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], others: [] }]);
    });

    it('every runtime login and the master are refused UPDATE, DELETE and TRUNCATE on every audit table', async () => {
      const problems: string[] = [];
      for (const login of [...runtimeLogins(loadManifest()), 'jale_admin']) {
        await withLoginClient(login, async (c) => {
          for (const table of GUARDED) {
            for (const sql of changes(table)) {
              const code = await sqlState(() => c.query(sql));
              if (code !== '42501') problems.push(`${login}: ${sql} -> ${code}`);
            }
          }
        });
      }
      expect(problems).toEqual([]);
    });

    it('with no flag set, a superuser is refused every UPDATE, DELETE and TRUNCATE with 55000', async () => {
      const outcomes = await withFixtures(async (c) => {
        const out: string[] = [];
        for (const table of GUARDED) for (const sql of changes(table)) out.push(`${sql} -> ${await attempt(c, sql)}`);
        return out;
      });
      expect(outcomes).toEqual(GUARDED.flatMap((table) => changes(table).map((sql) => `${sql} -> 55000`)));
    });

    it('with no flag set, the owner is refused every change; on the row-secured legacy table it sees no row to change', async () => {
      const outcomes = await withFixtures(async (c, f) => {
        await c.query('SET LOCAL ROLE jale_audit_owner');
        const out: string[] = [];
        for (const table of GUARDED) for (const sql of changes(table)) out.push(`${sql} -> ${await attempt(c, sql)}`);
        await c.query('RESET ROLE');
        out.push(`legacy row kept: ${(await c.query('SELECT count(*) FROM public.admin_audit_log WHERE id = $1', [f.legacy])).rows[0].count}`);
        return out;
      });
      expect(outcomes).toEqual([
        ...AUDIT_TABLES.flatMap((table) => changes(table).map((sql) => `${sql} -> 55000`)),
        // FORCE row security: no UPDATE policy, and the DELETE policy needs
        // the purge flag, so both match zero rows; TRUNCATE meets the guard.
        'UPDATE public.admin_audit_log SET action = action -> ok:0',
        'DELETE FROM public.admin_audit_log -> ok:0',
        'TRUNCATE public.admin_audit_log -> 55000',
        'legacy row kept: 1',
      ]);
    });

    it('TRUNCATE is refused even with every flag set', async () => {
      const outcomes = await withFixtures(async (c) => {
        for (const flag of ['purge', 'redact', 'export']) await c.query(`SELECT set_config('jale_audit.${flag}', 'on', true)`);
        const out: string[] = [];
        for (const table of GUARDED) out.push(await attempt(c, `TRUNCATE ${table}`));
        return out;
      });
      expect(outcomes).toEqual(GUARDED.map(() => '55000'));
    });

    // The flag paths run as a superuser: privileges and row security never
    // stop one, so the guard is the only lock it meets.
    it('the redaction flag allows exactly one change: an event reason to [redacted]', async () => {
      const outcomes = await withFixtures(async (c, f) => {
        await c.query(`SELECT set_config('jale_audit.redact', 'on', true)`);
        return {
          otherText: await attempt(c, `UPDATE jale_audit.events SET reason = 'something else' WHERE seq = $1`, [f.event]),
          otherColumn: await attempt(c, `UPDATE jale_audit.events SET result_count = 2 WHERE seq = $1`, [f.event]),
          bothColumns: await attempt(c, `UPDATE jale_audit.events SET reason = '[redacted]', result_count = 2 WHERE seq = $1`, [f.event]),
          change: await attempt(c, `UPDATE jale_audit.changes SET row_count = 2 WHERE seq = $1`, [f.change]),
          legacy: await attempt(c, `UPDATE public.admin_audit_log SET action = 'x' WHERE id = $1`, [f.legacy]),
          deleteEvent: await attempt(c, `DELETE FROM jale_audit.events WHERE seq = $1`, [f.event]),
          redact: await attempt(c, `UPDATE jale_audit.events SET reason = '[redacted]' WHERE seq = $1`, [f.event]),
          stored: (await c.query('SELECT reason FROM jale_audit.events WHERE seq = $1', [f.event])).rows[0].reason,
        };
      });
      expect(outcomes).toEqual({
        otherText: '55000', otherColumn: '55000', bothColumns: '55000', change: '55000', legacy: '55000',
        deleteEvent: '55000', redact: 'ok:1', stored: '[redacted]',
      });
    });

    it('the export flag allows exactly one change: export_state, never moving a watermark back', async () => {
      const outcomes = await withFixtures(async (c, f) => {
        await c.query(`SELECT set_config('jale_audit.export', 'on', true)`);
        const forward = `(pg_current_xact_id()::text::numeric + 1)::text::xid8`;
        return {
          forward: await attempt(c, `UPDATE jale_audit.export_state SET watermark = ${forward} WHERE stream = 'changes'`),
          backward: await attempt(c, `UPDATE jale_audit.export_state SET watermark = '1' WHERE stream = 'changes'`),
          rename: await attempt(c, `UPDATE jale_audit.export_state SET stream = 'events' WHERE stream = 'changes'`),
          deleteState: await attempt(c, `DELETE FROM jale_audit.export_state WHERE stream = 'changes'`),
          batch: await attempt(c, `UPDATE jale_audit.export_batches SET row_count = 1 WHERE seq = $1`, [f.batch]),
          hold: await attempt(c, `UPDATE jale_audit.export_holds SET action = 'release' WHERE seq = $1`, [f.hold]),
          event: await attempt(c, `UPDATE jale_audit.events SET result_count = 2 WHERE seq = $1`, [f.event]),
        };
      });
      expect(outcomes).toEqual({
        forward: 'ok:1', backward: '55000', rename: '55000', deleteState: '55000', batch: '55000', hold: '55000', event: '55000',
      });
    });

    it('the purge flag deletes only rows past 13 months, below the watermark, with no unexported hold', async () => {
      const outcomes = await withFixtures(async (c) => {
        const insertAt = async (age: string) => (await c.query<{ seq: string }>(
          `INSERT INTO jale_audit.changes (table_name, operation, row_count, changed_fields, context_status, occurred_at)
           VALUES ('public.users', 'delete', 1, '{email}', 'unset', now() - $1::interval) RETURNING seq`, [age])).rows[0].seq;
        const old = await insertAt('13 months 1 day');
        const recent = await insertAt('12 months 28 days');
        const held = await insertAt('13 months 2 days');
        const released = await insertAt('13 months 3 days');
        const exported = await insertAt('13 months 4 days');
        const batch = (await c.query<{ seq: string }>(
          `INSERT INTO jale_audit.export_batches (stream, batch_kind, from_xact, to_xact, row_count)
           VALUES ('changes', 'window', '1', '2', 0) RETURNING seq`)).rows[0].seq;
        for (const s of [held, released, exported]) {
          await c.query(`INSERT INTO jale_audit.export_holds (stream, row_seq, action, batch_seq) VALUES ('changes', $1, 'hold', $2)`, [s, batch]);
        }
        for (const s of [released, exported]) {
          await c.query(`INSERT INTO jale_audit.export_holds (stream, row_seq, action) VALUES ('changes', $1, 'release')`, [s]);
        }
        await c.query(`INSERT INTO jale_audit.export_holds (stream, row_seq, action, batch_seq) VALUES ('changes', $1, 'export', $2)`, [exported, batch]);

        await c.query(`SELECT set_config('jale_audit.purge', 'on', true)`);
        const out: Record<string, string> = {};
        // Every fixture was written in this transaction, so its xact is the
        // current one: below no watermark yet.
        out.aboveWatermark = await attempt(c, 'DELETE FROM jale_audit.changes WHERE seq = $1', [old]);
        await c.query(`SELECT set_config('jale_audit.export', 'on', true)`);
        await c.query(`UPDATE jale_audit.export_state SET watermark = (pg_current_xact_id()::text::numeric + 1)::text::xid8
                        WHERE stream = 'changes'`);
        await c.query(`SELECT set_config('jale_audit.export', 'off', true)`);
        out.old = await attempt(c, 'DELETE FROM jale_audit.changes WHERE seq = $1', [old]);
        out.recent = await attempt(c, 'DELETE FROM jale_audit.changes WHERE seq = $1', [recent]);
        out.held = await attempt(c, 'DELETE FROM jale_audit.changes WHERE seq = $1', [held]);
        out.releasedNotExported = await attempt(c, 'DELETE FROM jale_audit.changes WHERE seq = $1', [released]);
        out.releasedAndExported = await attempt(c, 'DELETE FROM jale_audit.changes WHERE seq = $1', [exported]);
        out.otherStreamWatermark = await attempt(c, `DELETE FROM jale_audit.events WHERE occurred_at > now() - interval '1 day'`);
        out.state = await attempt(c, `DELETE FROM jale_audit.export_state WHERE stream = 'changes'`);
        out.remaining = String((await c.query('SELECT count(*) FROM jale_audit.changes WHERE seq = ANY($1::bigint[])',
          [[old, recent, held, released, exported]])).rows[0].count);
        return out;
      });
      expect(outcomes).toEqual({
        aboveWatermark: '55000', old: 'ok:1', recent: '55000', held: '55000', releasedNotExported: '55000',
        releasedAndExported: 'ok:1', otherStreamWatermark: '55000', state: '55000', remaining: '3',
      });
    });

    it('a flag set by a runtime login unlocks nothing', async () => {
      const problems: string[] = [];
      for (const login of runtimeLogins(loadManifest())) {
        await withLoginClient(login, async (c) => {
          for (const flag of ['purge', 'redact', 'export']) await c.query(`SET jale_audit.${flag} = 'on'`);
          for (const sql of ['DELETE FROM jale_audit.events', `UPDATE jale_audit.events SET reason = '[redacted]'`,
            'UPDATE jale_audit.export_state SET watermark = watermark', 'DELETE FROM public.admin_audit_log']) {
            const code = await sqlState(() => c.query(sql));
            if (code !== '42501') problems.push(`${login}: ${sql} -> ${code}`);
          }
        });
      }
      expect(problems).toEqual([]);
    });
  });

  describe('the access-manifest fragment', () => {
    it('lists every jale_audit and jale_ops function with exactly its catalog owner, security, search_path, signature and EXECUTE grantees', async () => {
      const manifest = loadManifest();
      const { rows } = await su.query<{
        name: string; owner: string; definer: boolean; search_path: string | null; arguments: string;
        returns: string | null; kind: string; execute: string[];
      }>(
        `SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS name,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
                (SELECT substr(cfg, length('search_path=') + 1) FROM unnest(p.proconfig) cfg
                  WHERE cfg LIKE 'search\\_path=%' LIMIT 1) AS search_path,
                pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
                CASE p.prokind WHEN 'p' THEN NULL ELSE pg_catalog.pg_get_function_result(p.oid) END AS returns,
                p.prokind::text AS kind,
                ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1)::text[] AS execute
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('jale_audit', 'jale_ops')
          ORDER BY 1`,
      );
      const problems: string[] = [];
      for (const fn of rows) {
        const listed = manifest.functions[fn.name];
        if (!listed) { problems.push(`${fn.name}: not in the manifest`); continue; }
        const got = {
          owner: fn.owner, security: fn.definer ? 'definer' : 'invoker', search_path: fn.search_path,
          arguments: fn.arguments, returns: fn.returns, procedure: fn.kind === 'p', execute: [...fn.execute].sort(),
        };
        const want = {
          owner: listed.owner, security: listed.security, search_path: listed.search_path, arguments: listed.arguments,
          returns: listed.returns, procedure: listed.kind === 'procedure', execute: [...listed.execute].sort(),
        };
        if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${fn.name}: catalog ${JSON.stringify(got)} manifest ${JSON.stringify(want)}`);
      }
      const inCatalog = new Set(rows.map((r) => r.name));
      for (const name of Object.keys(manifest.functions).filter((k) => /^jale_(audit|ops)\./.test(k))) {
        if (!inCatalog.has(name)) problems.push(`${name}: listed but not in the catalog`);
      }
      expect(problems).toEqual([]);
    });

    it('classifies every jale_audit table as excluded, with no row security and no grants', () => {
      const manifest = loadManifest();
      const audit = Object.entries(manifest.tables).filter(([name]) => name.startsWith('jale_audit.'));
      expect(audit.map(([name]) => name).sort()).toEqual([
        'jale_audit.changes', 'jale_audit.events', 'jale_audit.export_batches', 'jale_audit.export_holds', 'jale_audit.export_state',
      ]);
      for (const [, entry] of audit) {
        expect(entry).toMatchObject({ classification: 'excluded', rls: { enabled: false, forced: false }, access: {} });
      }
    });
  });

  describe('history_search and reveal_count signatures', () => {
    it('history_search exists with its final signature, for the admin console only', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
                pg_catalog.has_function_privilege('jale_admin_console', p.oid, 'EXECUTE') AS console,
                pg_catalog.has_function_privilege('jale_api', p.oid, 'EXECUTE') AS api
           FROM pg_catalog.pg_proc p
          WHERE p.oid = 'jale_audit.history_search(jsonb, jsonb, integer, timestamp with time zone)'::regprocedure`,
      );
      expect(rows).toEqual([{
        args: 'p_actor jsonb, p_filter jsonb, p_limit integer, p_before timestamp with time zone',
        owner: 'jale_audit_owner', prosecdef: true, console: true, api: false,
      }]);
    });

    it('reveal_count exists with its final signature, for the admin console only', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                pg_catalog.pg_get_function_result(p.oid) AS result,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
                pg_catalog.has_function_privilege('jale_admin_console', p.oid, 'EXECUTE') AS console,
                pg_catalog.has_function_privilege('jale_api', p.oid, 'EXECUTE') AS api
           FROM pg_catalog.pg_proc p WHERE p.oid = 'jale_audit.reveal_count(integer)'::regprocedure`,
      );
      expect(rows).toEqual([{ args: 'p_days integer', result: 'bigint', owner: 'jale_audit_owner', prosecdef: true, console: true, api: false }]);
    });
  });
});

export type { AuditEvent };
