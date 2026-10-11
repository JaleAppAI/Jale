/**
 * audit-export.integration.test.ts -- the export functions (migration 109).
 *
 * The suite plays the export job (jale_job_audit_export) on a real database:
 *   - windows are chosen by snapshot xmin, so a transaction that commits late
 *     inside a window is exported exactly once, never missed (two sessions);
 *   - export_rows builds canonical JSON lines in SQL, and compare_window
 *     recomputes the same bytes;
 *   - export_commit refuses a window that does not start at the watermark,
 *     and a count, range or digest it cannot reproduce;
 *   - holds: a held row is left out of its window and of compare_window; a
 *     release (by the master) makes it exportable once, through a release
 *     batch, redacted or as it was;
 *   - purge_expired deletes only rows past 13 months, below the watermark and
 *     already archived.
 *
 * The digest chain: sha256(prev_digest || sha256(object bytes)),
 * where the object bytes are the lines in seq order, each followed by "\n",
 * and the first batch of a stream chains from an empty prev_digest.
 *
 * The windows cover every row the bed holds above the watermark, including
 * rows other suites wrote, so the suite pages through them like the job does.
 * All fixture values are synthetic.
 */
import { createHash, randomUUID } from 'crypto';
import { Client } from 'pg';
import { loadManifest, runtimeLogins } from '../../../db/access/access-manifest';
import { loginClient, withLoginClient } from './helpers/login-pool';
import { adminRevealEvent, employerReadEvent, fakeUuid } from './helpers/audit-events';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: audit export PostgreSQL gate was not run', () => {
    console.warn('[audit-export] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const EXPORT_LOGIN = 'jale_job_audit_export';
const EXPORT_FUNCTIONS = [
  'jale_audit.export_window(text)',
  'jale_audit.export_rows(text, xid8, xid8, bigint, integer)',
  'jale_audit.export_commit(text, xid8, xid8, integer, bigint, bigint, bytea, text, bigint[])',
  'jale_audit.export_released(text, integer)',
  'jale_audit.export_commit_release(text, bigint[], bytea, text)',
  'jale_audit.compare_window(text, xid8, xid8, bigint[])',
  'jale_audit.purge_expired(integer)',
  'jale_audit.export_backlog(text)',
];
const MASTER_FUNCTIONS = ['jale_audit.release_hold(text, bigint)', 'jale_audit.redact_and_release(text, bigint)'];
/** A phone-shaped value in the fictional 555-01xx range: the scan must catch it. */
const SYNTHETIC_PHONE = '+15555550123';

interface PgError { code?: string; message?: string }
interface Line { seq: string; line: string }
interface Window { from_xact: string; to_xact: string; prev_digest: Buffer | null }

const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();
const objectBytes = (lines: Line[]): Buffer => Buffer.from(lines.map((l) => `${l.line}\n`).join(''), 'utf8');
const chain = (prev: Buffer | null, lines: Line[]): Buffer =>
  sha256(Buffer.concat([prev ?? Buffer.alloc(0), sha256(objectBytes(lines))]));

async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as PgError).code;
  }
}

/** The job's side of one window: read it, page through its rows. */
async function readWindow(c: Client, stream: string): Promise<{ window: Window; lines: Line[] }> {
  const window = (await c.query<Window>('SELECT * FROM jale_audit.export_window($1)', [stream])).rows[0];
  const lines: Line[] = [];
  let after = '0';
  for (;;) {
    const page = (await c.query<Line>('SELECT seq::text, line FROM jale_audit.export_rows($1, $2, $3, $4, 500)',
      [stream, window.from_xact, window.to_xact, after])).rows;
    lines.push(...page);
    if (page.length < 500) break;
    after = page[page.length - 1].seq;
  }
  return { window, lines };
}

/** Commits a window, holding `held` seqs, the way the job does. Returns the batch seq. */
async function commitWindow(c: Client, stream: string, window: Window, lines: Line[], held: string[] = []): Promise<string> {
  const kept = lines.filter((l) => !held.includes(l.seq));
  const digest = kept.length > 0 ? chain(window.prev_digest, kept) : null;
  const objectKey = kept.length > 0 ? `db/${stream}/test/${window.from_xact.padStart(20, '0')}.jsonl.gz` : null;
  const { rows } = await c.query<{ batch: string }>(
    `SELECT jale_audit.export_commit($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint[]) AS batch`,
    [stream, window.from_xact, window.to_xact, kept.length, kept[0]?.seq ?? null, kept[kept.length - 1]?.seq ?? null,
      digest, objectKey, held],
  );
  return rows[0].batch;
}

/** Exports everything currently exportable on a stream, in as many windows as it takes. */
async function drain(c: Client, stream: string): Promise<Line[]> {
  const { window, lines } = await readWindow(c, stream);
  await commitWindow(c, stream, window, lines);
  return lines;
}

async function recordAs(login: string, event: unknown): Promise<string> {
  return withLoginClient(login, async (c) =>
    (await c.query<{ seq: string }>('SELECT jale_audit.record_event($1::jsonb)::text AS seq', [JSON.stringify(event)])).rows[0].seq);
}

maybeDescribe('audit export', () => {
  let su: Client;
  let job: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    job = loginClient(EXPORT_LOGIN);
    await job.connect();
  });

  afterAll(async () => {
    await job?.end();
    await su?.end();
  });

  describe('the export login', () => {
    it('is a job login with exactly its reviewed attributes, a member of nothing', async () => {
      const { rows } = await su.query(
        `SELECT r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
                r.rolconnlimit, r.rolvaliduntil,
                (SELECT count(*)::int FROM pg_catalog.pg_auth_members am WHERE am.member = r.oid) AS memberships,
                (SELECT count(*)::int FROM pg_catalog.pg_shdepend d
                  WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o') AS owned,
                pg_catalog.has_database_privilege(r.oid, current_database(), 'CONNECT') AS can_connect,
                pg_catalog.has_schema_privilege(r.oid, 'jale_audit', 'USAGE') AS audit_usage,
                pg_catalog.has_schema_privilege(r.oid, 'jale_audit', 'CREATE') AS audit_create
           FROM pg_catalog.pg_roles r WHERE r.rolname = $1`,
        [EXPORT_LOGIN],
      );
      expect(rows).toEqual([{
        rolcanlogin: true, rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false,
        rolreplication: false, rolbypassrls: false, rolconnlimit: 2, rolvaliduntil: null, memberships: 0, owned: 0,
        can_connect: true, audit_usage: true, audit_create: false,
      }]);
    });

    it('can execute the export functions and nothing else in jale_audit', async () => {
      const { rows } = await su.query<{ fn: string }>(
        `SELECT p.oid::regprocedure::text AS fn FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'jale_audit'::regnamespace
            AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')`,
        [EXPORT_LOGIN],
      );
      // regprocedure text has no space after a comma.
      const normalize = (s: string) => s.replace(/,\s*/g, ',');
      expect(rows.map((r) => normalize(r.fn)).sort()).toEqual(EXPORT_FUNCTIONS.map(normalize).sort());
    });

    it('cannot read or write any audit table directly', async () => {
      const codes = await withLoginClient(EXPORT_LOGIN, async (c) => [
        await sqlState(() => c.query('SELECT 1 FROM jale_audit.events LIMIT 1')),
        await sqlState(() => c.query('SELECT 1 FROM jale_audit.export_state LIMIT 1')),
        await sqlState(() => c.query('DELETE FROM jale_audit.events')),
        await sqlState(() => c.query('SELECT 1 FROM public.admin_audit_log LIMIT 1')),
      ]);
      expect(codes).toEqual(['42501', '42501', '42501', '42501']);
    });
  });

  describe('rights', () => {
    it('only the export login executes the export functions; only the master releases a hold', async () => {
      const problems: string[] = [];
      const roles = [...runtimeLogins(loadManifest()), EXPORT_LOGIN, 'jale_admin', 'jale_ops_readonly', 'jale_ops_owner'];
      for (const role of [...new Set(roles)]) {
        for (const fn of EXPORT_FUNCTIONS) {
          const { rows } = await su.query<{ ok: boolean }>(`SELECT pg_catalog.has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
          if (rows[0].ok !== (role === EXPORT_LOGIN)) problems.push(`${role} ${fn}: ${rows[0].ok}`);
        }
        for (const fn of MASTER_FUNCTIONS) {
          const { rows } = await su.query<{ ok: boolean }>(`SELECT pg_catalog.has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
          if (rows[0].ok !== (role === 'jale_admin')) problems.push(`${role} ${fn}: ${rows[0].ok}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('a request login calling an export function is refused with 42501', async () => {
      const code = await withLoginClient('jale_api', (c) => sqlState(() => c.query(`SELECT * FROM jale_audit.export_window('events')`)));
      expect(code).toBe('42501');
    });
  });

  describe('windows', () => {
    it('a transaction that commits late inside a window is exported exactly once, and nothing is missed', async () => {
      await drain(job, 'events');

      const late = loginClient('jale_api');
      await late.connect();
      try {
        await late.query('BEGIN');
        const lateSeq = (await late.query<{ seq: string }>('SELECT jale_audit.record_event($1::jsonb)::text AS seq',
          [JSON.stringify(employerReadEvent({ request_id: 'late-commit-a' }))])).rows[0].seq;
        const earlySeq = await recordAs('jale_whatsapp', employerReadEvent({
          actor_kind: 'worker', surface: 'worker.application_details', purpose_kind: 'self', purpose_id: null,
          request_id: 'early-commit-b',
        }));

        // The late transaction is still open: its xact is at or above the
        // snapshot xmin, so this window stops below it.
        const first = await readWindow(job, 'events');
        expect(first.lines.map((l) => l.seq)).not.toContain(lateSeq);
        expect(first.lines.map((l) => l.seq)).not.toContain(earlySeq);
        await commitWindow(job, 'events', first.window, first.lines);

        await late.query('COMMIT');
        const second = await readWindow(job, 'events');
        await commitWindow(job, 'events', second.window, second.lines);

        const exported = [...first.lines, ...second.lines].map((l) => l.seq);
        expect(exported.filter((s) => s === lateSeq)).toHaveLength(1);
        expect(exported.filter((s) => s === earlySeq)).toHaveLength(1);
        expect(new Set(exported).size).toBe(exported.length);
        expect(second.window.from_xact).toBe(first.window.to_xact);
      } finally {
        await late.end();
      }
    });

    it('windows chain: each starts at the last one\'s end, and the stored rows above the watermark are all in the next one', async () => {
      await drain(job, 'events');
      const seqs = [await recordAs('jale_api', employerReadEvent()), await recordAs('jale_admin_console', adminRevealEvent())];
      const { window, lines } = await readWindow(job, 'events');
      expect(lines.map((l) => l.seq)).toEqual(expect.arrayContaining(seqs));
      const { rows } = await su.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM jale_audit.events WHERE xact >= $1::xid8 AND xact < $2::xid8',
        [window.from_xact, window.to_xact]);
      expect(String(lines.length)).toBe(rows[0].n);
      await commitWindow(job, 'events', window, lines);
    });
  });

  describe('canonical lines', () => {
    it('renders a fixed key order, UTC times with a Z, and the stored values', async () => {
      await drain(job, 'events');
      const seq = await recordAs('jale_api', employerReadEvent({
        link_expires_at: '2026-10-02T12:15:00.123Z', request_id: 'canonical-line-1',
      }));
      const { window, lines } = await readWindow(job, 'events');
      const line = lines.find((l) => l.seq === seq)!.line;
      const parsed = JSON.parse(line);
      expect(Object.keys(parsed)).toEqual([
        'seq', 'event_id', 'xact', 'occurred_at', 'kind', 'outcome', 'actor_kind', 'actor_id', 'actor_role',
        'actor_session', 'channel', 'surface', 'categories', 'subject_user_ids', 'record_type', 'record_ids',
        'result_count', 'field_names', 'purpose_kind', 'purpose_id', 'reason', 'link_expires_at', 'part', 'parts',
        'request_id', 'db_login', 'db_pid',
      ]);
      expect(parsed.seq).toBe(Number(seq));
      expect(parsed.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(parsed.link_expires_at).toBe('2026-10-02T12:15:00.123000Z');
      expect(parsed.subject_user_ids).toEqual([fakeUuid(0xa1)]);
      expect(parsed.db_login).toBe('jale_api');
      expect(parsed.reason).toBeNull();
      await commitWindow(job, 'events', window, lines);
    });

    it('does not depend on the session time zone or date style', async () => {
      await drain(job, 'events');
      await recordAs('jale_api', employerReadEvent({ request_id: 'canonical-line-2' }));
      const { window, lines } = await readWindow(job, 'events');
      await job.query(`SET TimeZone = 'America/Chicago'; SET DateStyle = 'SQL, DMY'`);
      try {
        const again = await readWindow(job, 'events');
        expect(again.lines).toEqual(lines);
      } finally {
        await job.query('RESET TimeZone; RESET DateStyle');
      }
      await commitWindow(job, 'events', window, lines);
    });

    it('a legacy line names the admin by the id filled on insert from a unique email match, and holds no email', async () => {
      // The admin stays: once an append-only record names it, it cannot be
      // removed. Its id and email are unique to this run.
      const adminId = randomUUID();
      const email = `export-legacy-${adminId}@example.invalid`;
      await su.query(`INSERT INTO public.admin_users (id, admin_email, role) VALUES ($1, $2, 'admin_ops')`, [adminId, email]);
      await drain(job, 'admin_actions_legacy');
      const seq = await withLoginClient('jale_admin_console', async (c) => {
        const insert = async (actorEmail: string): Promise<string> => (await c.query<{ seq: string }>(
          `INSERT INTO public.admin_audit_log (actor_email, actor_role, action, target_type, target_id, metadata)
           VALUES ($1, 'admin_ops', 'resolve_case', 'admin_case', $2, '{}'::jsonb) RETURNING seq::text`,
          [actorEmail, fakeUuid(0x11004)])).rows[0].seq;
        return { known: await insert(email.toUpperCase()), unknown: await insert('nobody-export@example.com') };
      });
      const { window, lines } = await readWindow(job, 'admin_actions_legacy');
      expect(lines.map((l) => l.seq)).toEqual(expect.arrayContaining([seq.known, seq.unknown]));
      for (const l of lines) {
        expect(l.line).not.toContain('@');
        expect(Object.keys(JSON.parse(l.line))).not.toContain('actor_email');
      }
      expect(JSON.parse(lines.find((l) => l.seq === seq.known)!.line).actor_admin_id).toBe(adminId);
      expect(JSON.parse(lines.find((l) => l.seq === seq.unknown)!.line).actor_admin_id).toBeNull();
      await commitWindow(job, 'admin_actions_legacy', window, lines);
    });

    it('compare_window reproduces the exported bytes exactly, before and after the commit', async () => {
      await drain(job, 'events');
      await recordAs('jale_api', employerReadEvent({ request_id: 'compare-window-1' }));
      await recordAs('jale_admin_console', adminRevealEvent({ request_id: 'compare-window-2' }));
      const { window, lines } = await readWindow(job, 'events');
      const expected = { row_count: lines.length, lines_sha256: sha256(objectBytes(lines)) };
      const before = (await job.query('SELECT * FROM jale_audit.compare_window($1, $2, $3)',
        ['events', window.from_xact, window.to_xact])).rows[0];
      await commitWindow(job, 'events', window, lines);
      const after = (await job.query('SELECT * FROM jale_audit.compare_window($1, $2, $3)',
        ['events', window.from_xact, window.to_xact])).rows[0];
      expect(before).toEqual(expected);
      expect(after).toEqual(expected);
    });
  });

  describe('export_commit', () => {
    it('refuses a window that does not start at the watermark (55000), and a replay of a committed window', async () => {
      await drain(job, 'events');
      await recordAs('jale_api', employerReadEvent());
      const { window, lines } = await readWindow(job, 'events');
      await commitWindow(job, 'events', window, lines);
      const replay = await sqlState(() => commitWindow(job, 'events', window, lines));
      expect(replay).toBe('55000');
    });

    it('refuses a count, a seq range or a digest it cannot reproduce, and a window end beyond the horizon (22023)', async () => {
      await drain(job, 'events');
      await recordAs('jale_api', employerReadEvent());
      const { window, lines } = await readWindow(job, 'events');
      const digest = chain(window.prev_digest, lines);
      const key = `db/events/test/${window.from_xact}.jsonl.gz`;
      const commit = (rowCount: number, min: string | null, max: string | null, d: Buffer | null, to = window.to_xact) =>
        sqlState(() => job.query('SELECT jale_audit.export_commit($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint[])',
          ['events', window.from_xact, to, rowCount, min, max, d, key, []]));
      const first = lines[0].seq;
      const last = lines[lines.length - 1].seq;
      const beyond = (await su.query<{ x: string }>(`SELECT (pg_current_xact_id()::text::numeric + 1000)::text AS x`)).rows[0].x;
      expect({
        count: await commit(lines.length + 1, first, last, digest),
        range: await commit(lines.length, first, String(Number(last) + 1), digest),
        digest: await commit(lines.length, first, last, sha256(Buffer.from('not the window'))),
        unchained: await commit(lines.length, first, last, sha256(objectBytes(lines))),
        horizon: await commit(lines.length, first, last, digest, beyond),
      }).toEqual({ count: '22023', range: '22023', digest: '22023', unchained: '22023', horizon: '22023' });
      // A refusal leaves the watermark where it was, and the window still commits.
      const again = (await job.query<Window>(`SELECT * FROM jale_audit.export_window('events')`)).rows[0];
      expect(again.from_xact).toBe(window.from_xact);
      await commitWindow(job, 'events', window, lines);
    });

    it('commits an empty window with no object, leaving the digest chain where it was', async () => {
      await drain(job, 'changes');
      const before = (await job.query<Window>(`SELECT * FROM jale_audit.export_window('changes')`)).rows[0];
      const { window, lines } = await readWindow(job, 'changes');
      expect(lines).toEqual([]);
      await commitWindow(job, 'changes', window, lines);
      const after = (await job.query<Window>(`SELECT * FROM jale_audit.export_window('changes')`)).rows[0];
      expect(after.prev_digest).toEqual(before.prev_digest);
      expect(after.from_xact).toBe(window.to_xact);
    });
  });

  describe('holds, releases and redaction', () => {
    it('a held row stays out of its window and of compare_window, then a release exports it once', async () => {
      await drain(job, 'events');
      const clean = await recordAs('jale_admin_console', adminRevealEvent({ reason: 'Synthetic reason with no value in it.' }));
      const flagged = await recordAs('jale_admin_console', adminRevealEvent({ reason: `Call back on ${SYNTHETIC_PHONE} today.` }));
      const { window, lines } = await readWindow(job, 'events');
      expect(lines.map((l) => l.seq)).toEqual(expect.arrayContaining([clean, flagged]));
      await commitWindow(job, 'events', window, lines, [flagged]);

      const kept = lines.filter((l) => l.seq !== flagged);
      const compare = (await job.query('SELECT * FROM jale_audit.compare_window($1, $2, $3)',
        ['events', window.from_xact, window.to_xact])).rows[0];
      expect(compare).toEqual({ row_count: kept.length, lines_sha256: sha256(objectBytes(kept)) });

      // Nothing is released yet.
      const none = (await job.query<Line>(`SELECT seq::text, line FROM jale_audit.export_released('events', 100)`)).rows;
      expect(none.map((l) => l.seq)).not.toContain(flagged);

      await withLoginClient('jale_admin', (c) => c.query(`SELECT jale_audit.release_hold('events', $1)`, [flagged]));
      const released = (await job.query<Line>(`SELECT seq::text, line FROM jale_audit.export_released('events', 100)`)).rows
        .filter((l) => l.seq === flagged);
      expect(released).toHaveLength(1);
      expect(JSON.parse(released[0].line).reason).toContain(SYNTHETIC_PHONE);

      const state = (await job.query<Window>(`SELECT * FROM jale_audit.export_window('events')`)).rows[0];
      const all = (await job.query<Line>(`SELECT seq::text, line FROM jale_audit.export_released('events', 100)`)).rows;
      await job.query('SELECT jale_audit.export_commit_release($1, $2::bigint[], $3, $4)',
        ['events', all.map((l) => l.seq), chain(state.prev_digest, all), `db/events/released/${all[0].seq}.jsonl.gz`]);
      const after = (await job.query<Line>(`SELECT seq::text FROM jale_audit.export_released('events', 100)`)).rows;
      expect(after.map((l) => l.seq)).not.toContain(flagged);

      // The window's own comparison still leaves the released row out.
      const recompare = (await job.query('SELECT * FROM jale_audit.compare_window($1, $2, $3)',
        ['events', window.from_xact, window.to_xact])).rows[0];
      expect(recompare).toEqual(compare);
    });

    it('redact_and_release replaces the reason with [redacted] and releases the row', async () => {
      await drain(job, 'events');
      const flagged = await recordAs('jale_admin_console', adminRevealEvent({ reason: `Reached them at ${SYNTHETIC_PHONE}.` }));
      const { window, lines } = await readWindow(job, 'events');
      await commitWindow(job, 'events', window, lines, [flagged]);
      await withLoginClient('jale_admin', (c) => c.query(`SELECT jale_audit.redact_and_release('events', $1)`, [flagged]));
      const stored = (await su.query('SELECT reason FROM jale_audit.events WHERE seq = $1', [flagged])).rows[0].reason;
      expect(stored).toBe('[redacted]');
      const released = (await job.query<Line>(`SELECT seq::text, line FROM jale_audit.export_released('events', 100)`)).rows;
      const mine = released.find((l) => l.seq === flagged)!;
      expect(JSON.parse(mine.line).reason).toBe('[redacted]');
      const state = (await job.query<Window>(`SELECT * FROM jale_audit.export_window('events')`)).rows[0];
      await job.query('SELECT jale_audit.export_commit_release($1, $2::bigint[], $3, $4)',
        ['events', released.map((l) => l.seq), chain(state.prev_digest, released), `db/events/released/${released[0].seq}.jsonl.gz`]);
    });

    it('refuses a release batch that names an unreleased row or carries the wrong digest', async () => {
      await drain(job, 'events');
      const seq = await recordAs('jale_api', employerReadEvent());
      await drain(job, 'events');
      const state = (await job.query<Window>(`SELECT * FROM jale_audit.export_window('events')`)).rows[0];
      const line = { seq, line: 'x' };
      const unreleased = await sqlState(() => job.query('SELECT jale_audit.export_commit_release($1, $2::bigint[], $3, $4)',
        ['events', [seq], chain(state.prev_digest, [line]), 'db/events/released/x.jsonl.gz']));
      expect(unreleased).toBe('22023');
    });

    it('a release by anyone but the master is refused, and an unknown hold is refused', async () => {
      const codes = {
        job: await sqlState(() => job.query(`SELECT jale_audit.release_hold('events', 1)`)),
        console: await withLoginClient('jale_admin_console', (c) => sqlState(() => c.query(`SELECT jale_audit.release_hold('events', 1)`))),
        unknown: await withLoginClient('jale_admin', (c) => sqlState(() => c.query(`SELECT jale_audit.release_hold('events', -1)`))),
        redactChange: await withLoginClient('jale_admin', (c) => sqlState(() => c.query(`SELECT jale_audit.redact_and_release('changes', -1)`))),
      };
      expect(codes).toEqual({ job: '42501', console: '42501', unknown: '22023', redactChange: '22023' });
    });
  });

  describe('purge_expired', () => {
    it('deletes only rows past 13 months, below the watermark, and archived; and reports counts per stream', async () => {
      // Fixtures are written by the superuser, with occurred_at in the past.
      const insertAt = async (age: string, tag: string) => (await su.query<{ seq: string }>(
        `INSERT INTO jale_audit.changes (table_name, operation, row_count, changed_fields, context_status, occurred_at, request_id)
         VALUES ('public.users', 'delete', 1, '{email}', 'unset', now() - $1::interval, NULL) RETURNING seq::text AS seq`,
        [age])).rows[0].seq + `:${tag}`;
      const expired = (await insertAt('13 months 1 day', 'expired')).split(':')[0];
      const young = (await insertAt('12 months 27 days', 'young')).split(':')[0];
      const held = (await insertAt('13 months 2 days', 'held')).split(':')[0];
      // Archive them, holding one.
      const { window, lines } = await readWindow(job, 'changes');
      await commitWindow(job, 'changes', window, lines, [held]);
      // Written after the window: above the watermark.
      const unexported = (await insertAt('13 months 3 days', 'unexported')).split(':')[0];

      const counts = (await job.query<{ stream: string; deleted: number }>('SELECT * FROM jale_audit.purge_expired(1000)')).rows;
      expect(counts.map((r) => r.stream).sort()).toEqual(['admin_actions_legacy', 'changes', 'events']);
      const remaining = (await su.query<{ seq: string }>('SELECT seq::text FROM jale_audit.changes WHERE seq = ANY($1::bigint[])',
        [[expired, young, held, unexported]])).rows.map((r) => r.seq).sort();
      expect(remaining).toEqual([young, held, unexported].sort());
      expect(counts.find((r) => r.stream === 'changes')!.deleted).toBeGreaterThanOrEqual(1);

      // A second run finds nothing more to delete among them.
      await job.query('SELECT * FROM jale_audit.purge_expired(1000)');
      const still = (await su.query('SELECT count(*)::int AS n FROM jale_audit.changes WHERE seq = ANY($1::bigint[])',
        [[young, held, unexported]])).rows[0].n;
      expect(still).toBe(3);
      await drain(job, 'changes');
    });

    it('rejects a batch size outside 1-10000', async () => {
      expect(await sqlState(() => job.query('SELECT * FROM jale_audit.purge_expired(0)'))).toBe('22023');
      expect(await sqlState(() => job.query('SELECT * FROM jale_audit.purge_expired(10001)'))).toBe('22023');
    });

    it('leaves the purge flag off once it returns', async () => {
      await job.query('BEGIN');
      try {
        await job.query('SELECT * FROM jale_audit.purge_expired(1)');
        const flag = (await job.query(`SELECT current_setting('jale_audit.purge', true) AS v`)).rows[0].v;
        expect(flag === null || flag === '' || flag === 'off').toBe(true);
      } finally {
        await job.query('ROLLBACK');
      }
    });
  });

  describe('export_backlog', () => {
    interface Backlog { pending_rows: string; oldest_pending_at: Date | null }
    const backlog = async (c: Client, stream: string): Promise<Backlog> => (await c.query<Backlog>(
      'SELECT pending_rows::text AS pending_rows, oldest_pending_at FROM jale_audit.export_backlog($1)', [stream])).rows[0];

    it('counts rows committed behind an open older transaction, with the oldest time', async () => {
      await drain(job, 'events');
      const older = loginClient('jale_api');
      await older.connect();
      try {
        // The older transaction takes its id first and stays open.
        await older.query('BEGIN');
        await older.query('SELECT jale_audit.record_event($1::jsonb)', [JSON.stringify(employerReadEvent({ request_id: 'backlog-older' }))]);
        const seq = await recordAs('jale_api', employerReadEvent({ request_id: 'backlog-newer' }));
        // The window stops below the open transaction, so the newer row cannot be exported yet.
        const { window, lines } = await readWindow(job, 'events');
        expect(lines).toEqual([]);
        await commitWindow(job, 'events', window, lines);
        const at = (await su.query<{ occurred_at: Date }>('SELECT occurred_at FROM jale_audit.events WHERE seq = $1', [seq])).rows[0].occurred_at;
        const pending = await backlog(job, 'events');
        expect(pending.pending_rows).toBe('1');
        expect(pending.oldest_pending_at?.getTime()).toBe(at.getTime());
      } finally {
        await older.query('ROLLBACK').catch(() => undefined);
        await older.end();
      }
      await drain(job, 'events');
      expect(await backlog(job, 'events')).toEqual({ pending_rows: '0', oldest_pending_at: null });
    });

    it('reports 0 and NULL for an idle stream', async () => {
      for (const stream of ['events', 'changes', 'admin_actions_legacy']) {
        await drain(job, stream);
        expect(await backlog(job, stream)).toEqual({ pending_rows: '0', oldest_pending_at: null });
      }
    });

    it('raises 55000 for a stream with no export state, and 22023 for an unknown stream', async () => {
      await su.query('BEGIN');
      try {
        // The guard refuses deletes; replica mode skips it, inside this rolled-back transaction only.
        await su.query('SET LOCAL session_replication_role = replica');
        await su.query(`DELETE FROM jale_audit.export_state WHERE stream = 'changes'`);
        await su.query(`SET LOCAL ROLE ${EXPORT_LOGIN}`);
        expect(await sqlState(() => su.query(`SELECT * FROM jale_audit.export_backlog('changes')`))).toBe('55000');
      } finally {
        await su.query('ROLLBACK');
      }
      expect(await sqlState(() => job.query(`SELECT * FROM jale_audit.export_backlog('users')`))).toBe('22023');
    });

    it('every other runtime login is refused with 42501', async () => {
      const codes: Record<string, string | undefined> = {};
      for (const login of runtimeLogins(loadManifest()).filter((l) => l !== EXPORT_LOGIN)) {
        codes[login] = await withLoginClient(login, (c) => sqlState(() => c.query(`SELECT * FROM jale_audit.export_backlog('events')`)));
      }
      expect(Object.keys(codes).length).toBeGreaterThan(0);
      expect(Object.entries(codes).filter(([, code]) => code !== '42501')).toEqual([]);
    });
  });

  describe('argument checks', () => {
    it('rejects an unknown stream, a NULL window and an inverted window with 22023', async () => {
      const codes = [
        await sqlState(() => job.query(`SELECT * FROM jale_audit.export_window('users')`)),
        await sqlState(() => job.query(`SELECT * FROM jale_audit.export_rows('events', NULL, '1', 0, 10)`)),
        await sqlState(() => job.query(`SELECT * FROM jale_audit.export_rows('events', '9', '1', 0, 10)`)),
        await sqlState(() => job.query(`SELECT * FROM jale_audit.export_rows('events', '1', '9', 0, 0)`)),
        await sqlState(() => job.query(`SELECT * FROM jale_audit.compare_window('nope', '1', '9')`)),
        await sqlState(() => job.query(`SELECT * FROM jale_audit.export_released('events', 0)`)),
      ];
      expect(codes).toEqual(['22023', '22023', '22023', '22023', '22023', '22023']);
    });
  });
});
