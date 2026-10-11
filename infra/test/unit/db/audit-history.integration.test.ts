/**
 * audit-history.integration.test.ts -- the access history view's functions
 * (migration 109): jale_audit.history_search and jale_audit.reveal_count.
 *
 * history_search runs as the admin console login, inside the page's
 * transaction. It returns events, change records and the dashboard's frozen
 * action records for one filter, newest first, and records its own read event
 * in the same transaction after computing the page, so the read and its
 * record commit or roll back together, and a call never returns its own
 * event.
 *
 * Every id here is synthetic and unique to the run (syntheticUuid), so the
 * filters never match rows another suite wrote.
 */
import { Client } from 'pg';
import { withLoginClient } from './helpers/login-pool';
import { adminRevealEvent, employerReadEvent, syntheticUuid, tokenHolderAttemptEvent } from './helpers/audit-events';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: audit history PostgreSQL gate was not run', () => {
    console.warn('[audit-history] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

interface PgError { code?: string; message?: string }
type Row = Record<string, unknown>;

/** A phone-shaped value in the fictional 555-01xx range. */
const SYNTHETIC_PHONE = '+15555550142';

const SEARCH = 'SELECT h.*, to_char(h.occurred_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS cursor '
  + 'FROM jale_audit.history_search($1::jsonb, $2::jsonb, $3, $4::timestamptz) h';

async function failure(run: () => Promise<unknown>): Promise<PgError | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return { code: (err as PgError).code, message: (err as PgError).message };
  }
}

maybeDescribe('access history', () => {
  let su: Client;
  const admin = { id: syntheticUuid(), email: `history-reviewer-${Date.now()}@example.invalid` };
  const otherAdmin = { id: syntheticUuid(), email: `history-other-${Date.now()}@example.invalid` };
  const actor = (overrides: Row = {}): Row => ({
    actor_id: admin.id, actor_role: 'admin_superadmin', actor_session: syntheticUuid(),
    request_id: `history-${syntheticUuid().slice(-12)}`, ...overrides,
  });

  /** Runs one search as the console, in a transaction it commits. */
  async function search(who: Row, filter: Row | null, limit: number | null = 50, before: string | null = null): Promise<Row[]> {
    return withLoginClient('jale_admin_console', async (c) => {
      await c.query('BEGIN');
      try {
        const { rows } = await c.query(SEARCH, [JSON.stringify(who), filter === null ? null : JSON.stringify(filter), limit, before]);
        await c.query('COMMIT');
        return rows;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
  }

  async function recordAs(login: string, event: Row): Promise<string> {
    return withLoginClient(login, async (c) =>
      (await c.query<{ seq: string }>('SELECT jale_audit.record_event($1::jsonb)::text AS seq', [JSON.stringify(event)])).rows[0].seq);
  }

  async function eventsWithRequest(requestId: string): Promise<Row[]> {
    return (await su.query('SELECT * FROM jale_audit.events WHERE request_id = $1 ORDER BY seq', [requestId])).rows;
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    await su.query(
      `INSERT INTO public.admin_users (id, admin_email, role) VALUES ($1, $2, 'admin_superadmin'), ($3, $4, 'admin_ops')`,
      [admin.id, admin.email, otherAdmin.id, otherAdmin.email],
    );
  });

  afterAll(async () => {
    // Both admins are named by append-only dashboard records (the insert
    // trigger fills actor_admin_id from their emails), so they cannot be
    // removed; their ids and emails are unique to this run.
    await su?.end();
  });

  describe('its own read event', () => {
    it('is recorded in the caller\'s transaction after the page is computed, and never returned by its own call', async () => {
      const subject = syntheticUuid();
      await recordAs('jale_api', employerReadEvent({ subject_user_ids: [subject] }));
      await recordAs('jale_api', employerReadEvent({ subject_user_ids: [subject], surface: 'employer.job_applicants' }));
      const who = actor();

      const first = await search(who, { subject_user_id: subject });
      expect(first.map((r) => [r.source, r.surface])).toEqual([
        ['event', 'employer.job_applicants'], ['event', 'employer.worker_profile'],
      ]);

      const recorded = await eventsWithRequest(who.request_id as string);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        kind: 'read', outcome: 'allowed', actor_kind: 'admin', actor_id: admin.id, actor_role: 'admin_superadmin',
        actor_session: who.actor_session, channel: 'admin', surface: 'admin.access_history',
        categories: ['audit_history'], subject_user_ids: [subject], record_type: null, record_ids: [],
        result_count: 2, field_names: [], purpose_kind: 'audit_review', purpose_id: null, reason: null,
        db_login: 'jale_admin_console',
      });

      // The next call sees the first call's event.
      const second = await search(actor(), { subject_user_id: subject });
      expect(second.map((r) => r.surface)).toEqual(['admin.access_history', 'employer.job_applicants', 'employer.worker_profile']);
    });

    it('carries no subject when the filter names none, and counts the rows it returned', async () => {
      const record = syntheticUuid();
      await recordAs('jale_api', employerReadEvent({ record_ids: [record] }));
      const who = actor();
      const rows = await search(who, { record_id: record });
      expect(rows).toHaveLength(1);
      const [event] = await eventsWithRequest(who.request_id as string);
      expect(event).toMatchObject({ subject_user_ids: [], result_count: 1 });
    });

    it('rolls back with the caller: a search whose transaction is rolled back leaves no event', async () => {
      const who = actor();
      await withLoginClient('jale_admin_console', async (c) => {
        await c.query('BEGIN');
        await c.query(SEARCH, [JSON.stringify(who), '{}', 5, null]);
        await c.query('ROLLBACK');
      });
      expect(await eventsWithRequest(who.request_id as string)).toEqual([]);
    });
  });

  describe('who may search', () => {
    it('refuses every admin role but admin_superadmin with 42501, and records nothing', async () => {
      for (const role of ['admin_readonly', 'admin_ops']) {
        const who = actor({ actor_role: role });
        const err = await failure(() => search(who, {}));
        expect(err?.code).toBe('42501');
        expect(await eventsWithRequest(who.request_id as string)).toEqual([]);
      }
    });

    it('is executable by the admin console only', async () => {
      for (const login of ['jale_api', 'jale_whatsapp', 'jale_job_audit_export', 'jale_admin']) {
        const err = await withLoginClient(login, (c) => failure(() => c.query(SEARCH, [JSON.stringify(actor()), '{}', 5, null])));
        expect([login, err?.code]).toEqual([login, '42501']);
      }
    });
  });

  describe('argument checks', () => {
    const good = () => actor();
    const cases: Array<[string, () => [unknown, unknown, unknown], string]> = [
      ['a NULL actor', () => [null, {}, 10], 'history_search: invalid p_actor'],
      ['an actor that is an array', () => [[], {}, 10], 'history_search: invalid p_actor'],
      ['an unknown actor key', () => [{ ...good(), email: SYNTHETIC_PHONE }, {}, 10], 'history_search: unknown key'],
      ['no actor_id', () => [{ actor_role: 'admin_superadmin' }, {}, 10], 'history_search: invalid actor_id'],
      ['an actor_id that is not a UUID', () => [{ ...good(), actor_id: SYNTHETIC_PHONE }, {}, 10], 'history_search: invalid actor_id'],
      ['an unknown actor_role', () => [{ ...good(), actor_role: 'root' }, {}, 10], 'history_search: invalid actor_role'],
      ['an actor_session that is not a UUID', () => [{ ...good(), actor_session: 'x' }, {}, 10], 'history_search: invalid actor_session'],
      ['a request_id with a space', () => [{ ...good(), request_id: 'a b' }, {}, 10], 'history_search: invalid request_id'],
      ['a filter that is an array', () => [good(), [], 10], 'history_search: invalid p_filter'],
      ['an unknown filter key', () => [good(), { phone: SYNTHETIC_PHONE }, 10], 'history_search: unknown key'],
      ['a subject that is not a UUID', () => [good(), { subject_user_id: SYNTHETIC_PHONE }, 10], 'history_search: invalid subject_user_id'],
      ['an actor filter that is not a UUID', () => [good(), { actor_id: 7 }, 10], 'history_search: invalid actor_id'],
      ['a record that is not a UUID', () => [good(), { record_id: 'r' }, 10], 'history_search: invalid record_id'],
      ['a from that is not an instant', () => [good(), { from: 'yesterday' }, 10], 'history_search: invalid from'],
      ['a to with no zone', () => [good(), { to: '2026-10-02T00:00:00' }, 10], 'history_search: invalid to'],
      ['an unknown category', () => [good(), { category: 'secrets' }, 10], 'history_search: invalid category'],
      ['an unknown outcome', () => [good(), { outcome: 'maybe' }, 10], 'history_search: invalid outcome'],
      ['a limit of 0', () => [good(), {}, 0], 'history_search: invalid p_limit'],
      ['a limit of 201', () => [good(), {}, 201], 'history_search: invalid p_limit'],
      ['a NULL limit', () => [good(), {}, null], 'history_search: invalid p_limit'],
    ];

    it.each(cases)('refuses %s with 22023, naming the key and never the value', async (_label, args, message) => {
      const [who, filter, limit] = args();
      const err = await withLoginClient('jale_admin_console', (c) => failure(() => c.query(SEARCH,
        [who === null ? null : JSON.stringify(who), JSON.stringify(filter), limit, null])));
      expect(err).toEqual({ code: '22023', message });
    });

    it('treats a NULL filter as no filter', async () => {
      const rows = await search(actor(), null, 1);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('filters and columns', () => {
    const subject = syntheticUuid();
    const employer = syntheticUuid();
    const record = syntheticUuid();
    const base = Date.now() - 6 * 3600_000;
    const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      const insertEvent = async (name: string, minutes: number, fields: Row) => {
        const cols = Object.keys(fields);
        const { rows } = await su.query<{ event_id: string }>(
          `INSERT INTO jale_audit.events (occurred_at, ${cols.join(', ')})
           VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING event_id`,
          [at(minutes), ...cols.map((c) => fields[c])],
        );
        ids[name] = rows[0].event_id;
      };
      const read = {
        kind: 'read', outcome: 'allowed', actor_kind: 'employer', actor_id: employer, channel: 'web',
        surface: 'employer.worker_profile', categories: ['profile'], subject_user_ids: [subject],
        record_type: 'job_application', record_ids: [record], result_count: 1, purpose_kind: 'job', purpose_id: syntheticUuid(),
      };
      await insertEvent('read', 10, read);
      await insertEvent('docs', 20, { ...read, surface: 'employer.worker_documents', categories: ['documents'], record_ids: [], record_type: null });
      await insertEvent('denied', 30, {
        kind: 'attempt', outcome: 'denied', actor_kind: 'employer', actor_id: employer, channel: 'web',
        surface: 'employer.worker_profile', categories: ['profile'], subject_user_ids: [subject], result_count: 0,
      });
      await insertEvent('reveal', 40, {
        kind: 'read', outcome: 'allowed', actor_kind: 'admin', actor_id: admin.id, actor_role: 'admin_ops', channel: 'admin',
        surface: 'admin.case_detail.reveal', categories: ['contact_details'], subject_user_ids: [subject],
        record_type: 'admin_case', record_ids: [record], result_count: 1, purpose_kind: 'reveal',
        reason: 'Synthetic reason for a callback.',
      });
      const change = (await su.query<{ event_id: string }>(
        `INSERT INTO jale_audit.changes (occurred_at, table_name, operation, row_count, record_ids, subject_user_ids,
                                         changed_fields, actor_kind, actor_id, channel, surface, request_id, context_status)
         VALUES ($1, 'public.worker_profiles', 'update', 1, $2, $3, '{bio}', 'admin', $4, 'admin', 'admin.case_detail',
                 'history-change-1', 'set')
         RETURNING event_id`,
        [at(50), [record], [subject], admin.id])).rows[0];
      ids.change = change.event_id;
      const legacy = (await su.query<{ id: string }>(
        `INSERT INTO public.admin_audit_log (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata, created_at)
         VALUES ($1, 'admin_ops', 'reveal_contact', 'admin_case', $2, true, $3::jsonb, $4)
         RETURNING id`,
        [admin.email, record, JSON.stringify({
          summary: `${admin.email} requested reveal_contact for admin_case ${record}.`,
          justification: `Calling back on ${SYNTHETIC_PHONE} about the case.`,
          note: 'A reply body that must not survive.',
        }), at(60)])).rows[0];
      ids.legacy = legacy.id;
      const otherLegacy = (await su.query<{ id: string }>(
        `INSERT INTO public.admin_audit_log (actor_email, actor_role, action, target_type, target_id, metadata, created_at)
         VALUES ($1, 'admin_ops', 'resolve_case', 'admin_case', $2, '{}'::jsonb, $3) RETURNING id`,
        [otherAdmin.email, record, at(70)])).rows[0];
      ids.otherLegacy = otherLegacy.id;
    });

    const entryIds = (rows: Row[]) => rows.map((r) => r.entry_id);

    it.each([
      // `to` keeps out the read events this suite's own searches record.
      ['subject', () => ({ subject_user_id: subject, to: at(100) }), ['change', 'reveal', 'denied', 'docs', 'read']],
      ['employer actor', () => ({ actor_id: employer }), ['denied', 'docs', 'read']],
      ['admin actor: events, change records and the legacy rows under that admin\'s email', () => ({ actor_id: admin.id, to: at(100) }),
        ['legacy', 'change', 'reveal']],
      ['record: events, change records and legacy rows targeting it', () => ({ record_id: record }),
        ['otherLegacy', 'legacy', 'change', 'reveal', 'read']],
      ['subject and time range (from inclusive, to exclusive)', () => ({ subject_user_id: subject, from: at(20), to: at(40) }),
        ['denied', 'docs']],
      ['subject and category: events only', () => ({ subject_user_id: subject, category: 'documents' }), ['docs']],
      ['subject and outcome: events only', () => ({ subject_user_id: subject, outcome: 'denied' }), ['denied']],
      ['record and category leave the legacy rows out', () => ({ record_id: record, category: 'contact_details' }), ['reveal']],
    ])('filters by %s', async (_label, filter, expected) => {
      const rows = await search(actor(), filter());
      expect(entryIds(rows)).toEqual(expected.map((name) => ids[name]));
    });

    it('returns each source\'s columns as documented', async () => {
      const rows = await search(actor(), { record_id: record });
      const byId = new Map(rows.map((r) => [r.entry_id, r]));
      const nullAll = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
      const eventOnly = ['kind', 'outcome', 'actor_role', 'actor_session', 'categories', 'record_type', 'result_count',
        'field_names', 'purpose_kind', 'purpose_id', 'reason', 'link_expires_at', 'part', 'parts'];
      const changeOnly = ['table_name', 'operation', 'row_count', 'changed_fields', 'context_status'];
      const legacyOnly = ['action', 'target_type', 'target_id', 'summary', 'pii_reveal'];

      expect(byId.get(ids.reveal)).toMatchObject({
        source: 'event', kind: 'read', outcome: 'allowed', actor_kind: 'admin', actor_id: admin.id, actor_role: 'admin_ops',
        actor_email: admin.email, channel: 'admin', surface: 'admin.case_detail.reveal', categories: ['contact_details'],
        subject_user_ids: [subject], record_type: 'admin_case', record_ids: [record], result_count: 1,
        purpose_kind: 'reveal', reason: 'Synthetic reason for a callback.', part: 1, parts: 1, db_login: 'postgres',
        ...nullAll([...changeOnly, ...legacyOnly]),
      });
      expect(byId.get(ids.read)).toMatchObject({ actor_kind: 'employer', actor_id: employer, actor_email: null });
      expect(byId.get(ids.change)).toMatchObject({
        source: 'change', actor_kind: 'admin', actor_id: admin.id, actor_email: admin.email, channel: 'admin',
        surface: 'admin.case_detail', request_id: 'history-change-1', subject_user_ids: [subject], record_ids: [record],
        table_name: 'public.worker_profiles', operation: 'update', row_count: 1, changed_fields: ['bio'],
        context_status: 'set', db_login: 'postgres',
        ...nullAll([...eventOnly, ...legacyOnly]),
      });
      const legacy = byId.get(ids.legacy)!;
      expect(legacy).toMatchObject({
        source: 'legacy', actor_kind: 'admin', actor_id: admin.id, actor_role: 'admin_ops', actor_email: admin.email,
        action: 'reveal_contact', target_type: 'admin_case', target_id: record, pii_reveal: true,
        summary: 'admin_ops requested reveal_contact for admin_case.',
        channel: null, surface: null, request_id: null, db_login: null, db_pid: null,
        subject_user_ids: null, record_ids: null,
        ...nullAll([...changeOnly, 'kind', 'outcome', 'categories', 'result_count', 'purpose_kind']),
      });
      expect(String(legacy.seq)).toMatch(/^[0-9]+$/);
      expect(legacy.reason).toBe('Calling back on [removed] about the case.');
      expect(JSON.stringify(rows)).not.toContain(SYNTHETIC_PHONE);
      expect(JSON.stringify(rows)).not.toContain('must not survive');
    });
  });

  describe('a legacy record\'s admin', () => {
    // These admins stay: append-only records name them. Ids and emails are unique to the run.
    const tag = syntheticUuid().slice(-12);
    const insertLegacy = async (actorEmail: string, target: string): Promise<string> => (await su.query<{ id: string }>(
      `INSERT INTO public.admin_audit_log (actor_email, actor_role, action, target_type, target_id, metadata)
       VALUES ($1, 'admin_ops', 'resolve_case', 'admin_case', $2, '{}'::jsonb) RETURNING id`,
      [actorEmail, target])).rows[0].id;
    const addAdmin = async (id: string, email: string) =>
      su.query(`INSERT INTO public.admin_users (id, admin_email, role) VALUES ($1, $2, 'admin_ops')`, [id, email]);

    it('stays with the admin whose id the record holds when that admin\'s email moves to another admin', async () => {
      const first = { id: syntheticUuid(), email: `history-moved-${tag}@example.invalid` };
      const second = { id: syntheticUuid() };
      const target = syntheticUuid();
      await addAdmin(first.id, first.email);
      const record = await insertLegacy(first.email, target);
      // The record holds the first admin's id, filled on insert from the unique email match.
      expect((await su.query('SELECT actor_admin_id FROM public.admin_audit_log WHERE id = $1', [record])).rows)
        .toEqual([{ actor_admin_id: first.id }]);
      await su.query('UPDATE public.admin_users SET admin_email = $2 WHERE id = $1', [first.id, `history-renamed-${tag}@example.invalid`]);
      await addAdmin(second.id, first.email);

      expect((await search(actor(), { actor_id: second.id, record_id: target })).map((r) => r.entry_id)).toEqual([]);
      expect((await search(actor(), { actor_id: first.id, record_id: target })).map((r) => [r.entry_id, r.actor_id]))
        .toEqual([[record, first.id]]);
    });

    it('a record without an admin id still matches the admin whose email it names', async () => {
      const later = { id: syntheticUuid(), email: `history-unmatched-${tag}@example.invalid` };
      const target = syntheticUuid();
      // No admin has the email when the record is written, so it keeps no id.
      const record = await insertLegacy(later.email, target);
      expect((await su.query('SELECT actor_admin_id FROM public.admin_audit_log WHERE id = $1', [record])).rows)
        .toEqual([{ actor_admin_id: null }]);
      await addAdmin(later.id, later.email.toUpperCase());
      expect((await search(actor(), { actor_id: later.id, record_id: target })).map((r) => r.entry_id)).toEqual([record]);
    });
  });

  describe('order and paging', () => {
    it('pages newest first with p_before, never losing or repeating a row, even across ties', async () => {
      const subject = syntheticUuid();
      const t0 = Date.now() - 3600_000;
      const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
      const want: string[] = [];
      const event = async (offsetMs: number) => (await su.query<{ event_id: string }>(
        `INSERT INTO jale_audit.events (occurred_at, kind, outcome, actor_kind, channel, surface, categories, subject_user_ids, result_count)
         VALUES ($1, 'action', 'done', 'platform', 'web', 'worker.paging_test', '{profile}', $2, 0) RETURNING event_id`,
        [iso(offsetMs), [subject]])).rows[0].event_id;
      const change = async (offsetMs: number) => (await su.query<{ event_id: string }>(
        `INSERT INTO jale_audit.changes (occurred_at, table_name, operation, row_count, subject_user_ids, changed_fields, context_status)
         VALUES ($1, 'public.users', 'update', 1, $2, '{email}', 'unset') RETURNING event_id`,
        [iso(offsetMs), [subject]])).rows[0].event_id;
      // Newest first, ties in (source, seq DESC) order: change < event, later seq first.
      const e0 = await event(0);
      const tie = [await event(-1000), await event(-1000), await event(-1000)];
      const c1 = await change(-1000);
      const e2 = await event(-2000);
      const c2 = await change(-2000);
      const e3 = [await event(-3000), await event(-3000)];
      want.push(e0, c1, ...tie.reverse(), c2, e2, ...e3.reverse());

      const pages: Row[][] = [];
      let before: string | null = iso(1000);
      for (let i = 0; i < 10; i += 1) {
        const page = await search(actor(), { subject_user_id: subject }, 2, before);
        if (page.length === 0) break;
        pages.push(page);
        before = page[page.length - 1].cursor as string;
      }
      expect(pages.map((p) => p.length)).toEqual([5, 2, 2]);
      expect(pages.flat().map((r) => r.entry_id)).toEqual(want);
    });
  });

  describe('query plan', () => {
    it('a subject search reads the GIN index on seeded volume', async () => {
      const c = new Client({ connectionString: databaseUrl });
      await c.connect();
      const plans: string[] = [];
      c.on('notice', (msg) => { if (/Query Text/.test(String(msg.message))) plans.push(String(msg.message)); });
      await c.query('BEGIN');
      try {
        const subject = syntheticUuid();
        await c.query(
          `INSERT INTO jale_audit.events (kind, outcome, actor_kind, channel, surface, categories, subject_user_ids, result_count)
           SELECT 'read', 'allowed', 'platform', 'web', 'worker.plan_test', '{profile}',
                  ARRAY[('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid], 1
             FROM generate_series(1, 20000) g`,
        );
        await c.query(
          `INSERT INTO jale_audit.events (kind, outcome, actor_kind, channel, surface, categories, subject_user_ids, result_count)
           SELECT 'read', 'allowed', 'platform', 'web', 'worker.plan_test', '{profile}', ARRAY[$1::uuid], 1
             FROM generate_series(1, 3)`, [subject],
        );
        await c.query('ANALYZE jale_audit.events');
        await c.query(`LOAD 'auto_explain'`);
        await c.query(`SET LOCAL auto_explain.log_min_duration = 0`);
        await c.query(`SET LOCAL auto_explain.log_nested_statements = on`);
        await c.query(`SET LOCAL auto_explain.log_format = 'json'`);
        await c.query(`SET LOCAL auto_explain.log_level = 'notice'`);
        const { rows } = await c.query(SEARCH, [JSON.stringify(actor()), JSON.stringify({ subject_user_id: subject }), 50, null]);
        await c.query(`SET LOCAL auto_explain.log_min_duration = -1`);
        expect(rows).toHaveLength(3);
        const usesGin = plans.some((p) => /"Index Name": "events_subjects_idx"/.test(p));
        const seqScanOnEvents = plans.some((p) => /"Node Type": "Seq Scan",[^}]*"Relation Name": "events"/s.test(p));
        expect({ sawPlans: plans.length > 0, usesGin, seqScanOnEvents }).toEqual({ sawPlans: true, usesGin: true, seqScanOnEvents: false });
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    });
  });

  describe('reveal_count', () => {
    async function revealCount(days: number | null): Promise<number> {
      return withLoginClient('jale_admin_console', async (c) =>
        Number((await c.query<{ n: string }>('SELECT jale_audit.reveal_count($1)::text AS n', [days])).rows[0].n));
    }

    it('counts contact reveals in the last p_days days: reveal events and legacy reveal rows, nothing else', async () => {
      const before30 = await revealCount(30);
      const before400 = await revealCount(400);
      await recordAs('jale_admin_console', adminRevealEvent());
      await recordAs('jale_admin_console', adminRevealEvent({ reason: null }));
      await recordAs('jale_admin_console', adminRevealEvent({ purpose_kind: 'case', purpose_id: syntheticUuid(), reason: null }));
      await recordAs('jale_api', tokenHolderAttemptEvent());
      await su.query(
        `INSERT INTO public.admin_audit_log (actor_email, actor_role, action, target_type, target_id, pii_reveal)
         VALUES ($1, 'admin_ops', 'reveal_contact', 'admin_case', $2, true),
                ($1, 'admin_ops', 'resolve_case', 'admin_case', $2, false)`,
        [admin.email, syntheticUuid()],
      );
      await su.query(
        `INSERT INTO jale_audit.events (occurred_at, kind, outcome, actor_kind, actor_id, actor_role, channel, surface,
                                        categories, subject_user_ids, result_count, purpose_kind)
         VALUES (now() - interval '40 days', 'read', 'allowed', 'admin', $1, 'admin_ops', 'admin', 'admin.case_detail.reveal',
                 '{contact_details}', '{}', 1, 'reveal')`,
        [admin.id],
      );
      expect(await revealCount(30)).toBe(before30 + 3);
      expect(await revealCount(400)).toBe(before400 + 4);
    });

    it('rejects p_days outside 1-400 with 22023, and refuses every login but the console', async () => {
      for (const days of [0, 401, null]) {
        const err = await withLoginClient('jale_admin_console', (c) => failure(() => c.query('SELECT jale_audit.reveal_count($1)', [days])));
        expect(err).toEqual({ code: '22023', message: 'reveal_count: invalid p_days' });
      }
      for (const login of ['jale_api', 'jale_whatsapp', 'jale_job_audit_export', 'jale_admin']) {
        const err = await withLoginClient(login, (c) => failure(() => c.query('SELECT jale_audit.reveal_count(7)')));
        expect([login, err?.code]).toEqual([login, '42501']);
      }
    });
  });

  describe('the owner\'s read of admin email addresses', () => {
    it('is exactly SELECT on admin_users (id, admin_email), with one SELECT policy for the owner', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.has_table_privilege('jale_audit_owner', 'public.admin_users', 'SELECT') AS table_select,
                ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                       WHERE a.attrelid = 'public.admin_users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                         AND pg_catalog.has_column_privilege('jale_audit_owner', 'public.admin_users', a.attname, 'SELECT')
                       ORDER BY a.attname) AS columns,
                ARRAY(SELECT p.polname::text || ':' || p.polcmd::text FROM pg_catalog.pg_policy p
                       WHERE p.polrelid = 'public.admin_users'::regclass
                         AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_audit_owner') = ANY (p.polroles)) AS policies`,
      );
      expect(rows[0]).toEqual({ table_select: false, columns: ['admin_email', 'id'], policies: ['admin_users_audit_owner_read:r'] });
    });
  });
});
