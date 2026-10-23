/**
 * audit-change-log.integration.test.ts -- the sensitive-write change log.
 *
 * infra/db/access/audit-change-log.json lists the covered tables and columns;
 * the change-record triggers are generated from it. This suite checks:
 *   - the file against the catalog: every column of a covered table is
 *     either covered or excluded with a reason, keys and subjects are uuid
 *     columns, and the match columns are the primary key;
 *   - the live triggers against the file;
 *   - what each statement records, on every covered table: one record per
 *     statement naming the covered columns that changed, nothing when none
 *     did (other columns, the same values, no rows, an upsert that changed
 *     nothing), the rows whose covered columns changed with their ids and
 *     subjects up to 100, the login (session_user) and the audit context in
 *     its three states, which never fails the write;
 *   - a write through a definer records the login, not the function owner;
 *   - jobs deleted by an employer record the cascade to their applications
 *     under the employer, in one record for the statement.
 *
 * Fixtures are written inside transactions that are rolled back, except the
 * definer case, which needs committed rows for a second login and removes
 * them afterwards. All values are synthetic.
 */
import { Client } from 'pg';
import { CHANGE_LOG_PATH, TRIGGER_EVENTS, loadChangeLog, triggerArgs, triggerName } from './helpers/audit-change-log';
import { withLoginClient } from './helpers/login-pool';
import { syntheticUuid } from './helpers/audit-events';
import { ensureOwnerCompany } from './helpers/org-fixtures';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: audit change-log PostgreSQL gate was not run', () => {
    console.warn('[audit-change-log] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Row = Record<string, unknown>;

interface Base {
  worker: string;
  employer: string;
  job: string;
  job2: string;
  application: string;
  post: string;
}

interface Change {
  table_name: string;
  operation: string;
  row_count: number;
  record_ids: string[] | null;
  subject_user_ids: string[] | null;
  changed_fields: string[];
  actor_kind: string | null;
  actor_id: string | null;
  channel: string | null;
  surface: string | null;
  request_id: string | null;
  context_status: string;
  db_login: string;
}

const log = loadChangeLog();
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

async function seedBase(c: Client): Promise<Base> {
  const users = (await c.query<{ id: string; user_type: string }>(
    `INSERT INTO public.users (cognito_sub, user_type, email, full_name)
     VALUES ($1, 'worker', $2, 'Synthetic Worker'), ($3, 'employer', $4, 'Synthetic Employer')
     RETURNING id, user_type`,
    [`test-sub-${hex(12)}`, `worker-${hex(8)}@example.invalid`, `test-sub-${hex(12)}`, `employer-${hex(8)}@example.invalid`],
  )).rows;
  const worker = users.find((u) => u.user_type === 'worker')!.id;
  const employer = users.find((u) => u.user_type === 'employer')!.id;
  // The billing cases pay as this employer: since 127 a payer must own a company.
  await ensureOwnerCompany(c, employer, 'Synthetic Co');
  const jobs = (await c.query<{ id: string }>(
    `INSERT INTO public.jobs (employer_id, title, location, job_type)
     VALUES ($1, 'Synthetic job', 'Austin, TX', 'contract'), ($1, 'Synthetic job 2', 'Austin, TX', 'contract') RETURNING id`,
    [employer])).rows;
  const application = (await c.query<{ id: string }>(
    `INSERT INTO public.job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
    [jobs[0].id, worker])).rows[0].id;
  const post = (await c.query<{ id: string }>(
    `INSERT INTO public.worker_posts (worker_id, source, caption) VALUES ($1, 'web', 'Synthetic post') RETURNING id`,
    [worker])).rows[0].id;
  return { worker, employer, job: jobs[0].id, job2: jobs[1].id, application, post };
}

/** Runs `fn` in a superuser transaction with the base fixtures, then rolls back. */
async function inTx<T>(fn: (c: Client, b: Base) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  await c.query('BEGIN');
  try {
    const base = await seedBase(c);
    return await fn(c, base);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

async function lastSeq(c: Client): Promise<number> {
  return Number((await c.query<{ s: string }>('SELECT COALESCE(max(seq), 0)::text AS s FROM jale_audit.changes')).rows[0].s);
}

async function changesAfter(c: Client, seq: number, table?: string): Promise<Change[]> {
  const { rows } = await c.query<Change>(
    `SELECT table_name, operation, row_count, record_ids::text[] AS record_ids, subject_user_ids::text[] AS subject_user_ids,
            changed_fields, actor_kind, actor_id::text AS actor_id, channel, surface, request_id, context_status,
            db_login::text AS db_login
       FROM jale_audit.changes WHERE seq > $1 AND ($2::text IS NULL OR table_name = $2) ORDER BY seq`,
    [seq, table ?? null]);
  return rows;
}

/** One covered table's fixture: an insert, an update of a covered column, and one of an uncovered column. */
interface Case {
  insert: (b: Base) => [string, unknown[]];
  covered: string;
  coveredColumn: string;
  uncovered: string;
}

const CASES: Record<string, Case> = {
  'public.admin_cases': {
    insert: (b) => [`INSERT INTO public.admin_cases (case_type, status, summary, user_id, employer_id)
                     VALUES ('help_request', 'open', 'Synthetic case', $1, $2) RETURNING *`, [b.worker, b.employer]],
    covered: `SET status = 'resolved'`, coveredColumn: 'status', uncovered: 'SET resolved_at = now()',
  },
  'public.admin_users': {
    insert: () => [`INSERT INTO public.admin_users (admin_email, role) VALUES ($1, 'admin_ops') RETURNING *`,
      [`synthetic-admin-${hex(8)}@example.invalid`]],
    covered: `SET role = 'admin_readonly'`, coveredColumn: 'role', uncovered: `SET updated_at = now() - interval '1 day'`,
  },
  'public.billing_customers': {
    insert: (b) => [`INSERT INTO public.billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2) RETURNING *`,
      [b.employer, `test_customer_${hex(10)}`]],
    covered: `SET provider_customer_id = provider_customer_id || '_x'`, coveredColumn: 'provider_customer_id',
    uncovered: `SET updated_at = now() - interval '1 day'`,
  },
  'public.document_upload_tokens': {
    insert: (b) => [`INSERT INTO public.document_upload_tokens (token_hash, worker_id, job_id, expires_at)
                     VALUES ($1, $2, $3, now() + interval '1 day') RETURNING *`, [hex(64), b.worker, b.job]],
    covered: 'SET used = true', coveredColumn: 'used', uncovered: `SET expires_at = expires_at + interval '1 hour'`,
  },
  'public.employer_profiles': {
    insert: (b) => [`INSERT INTO public.employer_profiles (user_id, company_name) VALUES ($1, 'Synthetic Co') RETURNING *`, [b.employer]],
    covered: `SET company_name = 'Changed Co'`, coveredColumn: 'company_name', uncovered: `SET updated_at = now() - interval '1 day'`,
  },
  'public.job_applications': {
    insert: (b) => [`INSERT INTO public.job_applications (job_id, worker_id, status, application_answers)
                     VALUES ($1, $2, 'pending', '{"q": "a"}') RETURNING *`, [b.job2, b.worker]],
    covered: `SET prompt_answers = '{"p": "x"}'`, coveredColumn: 'prompt_answers', uncovered: 'SET details_requested_at = now()',
  },
  'public.subscriptions': {
    insert: (b) => [`INSERT INTO public.subscriptions (user_id, plan_code, status, provider_subscription_id)
                     VALUES ($1, 'employer_pro', 'active', $2) RETURNING *`, [b.employer, `test_subscription_${hex(10)}`]],
    covered: `SET provider_subscription_id = provider_subscription_id || '_x'`, coveredColumn: 'provider_subscription_id',
    uncovered: `SET status = 'past_due'`,
  },
  'public.users': {
    insert: () => [`INSERT INTO public.users (cognito_sub, user_type, email, phone, full_name)
                    VALUES ($1, 'worker', $2, '+15555550161', 'Synthetic Person') RETURNING *`,
      [`test-sub-${hex(12)}`, `person-${hex(8)}@example.invalid`]],
    covered: `SET email = 'changed-' || email`, coveredColumn: 'email', uncovered: `SET city = 'Austin'`,
  },
  'public.worker_application_defaults': {
    insert: (b) => [`INSERT INTO public.worker_application_defaults (worker_id, answers) VALUES ($1, '{"a": 1}') RETURNING *`, [b.worker]],
    covered: `SET answers = '{"a": 2}'`, coveredColumn: 'answers', uncovered: `SET updated_at = now() - interval '1 day'`,
  },
  'public.worker_documents': {
    insert: (b) => [`INSERT INTO public.worker_documents (worker_id, doc_type, s3_key, file_name, file_size, mime_type)
                     VALUES ($1, 'resume', 'documents/test/resume.pdf', 'resume.pdf', 1000, 'application/pdf') RETURNING *`, [b.worker]],
    covered: `SET file_name = 'cv.pdf'`, coveredColumn: 'file_name', uncovered: `SET uploaded_at = uploaded_at - interval '1 day'`,
  },
  'public.worker_post_media': {
    insert: (b) => [`INSERT INTO public.worker_post_media (post_id, worker_id, s3_key, sort_order, content_type, file_size, moderation_status)
                     VALUES ($1, $2, 'posts/test/1.jpg', 1, 'image/jpeg', 100, 'approved') RETURNING *`, [b.post, b.worker]],
    covered: `SET moderation_status = 'flagged'`, coveredColumn: 'moderation_status', uncovered: `SET created_at = created_at - interval '1 day'`,
  },
  'public.worker_posts': {
    insert: (b) => [`INSERT INTO public.worker_posts (worker_id, source, caption) VALUES ($1, 'web', 'Another post') RETURNING *`, [b.worker]],
    covered: `SET caption = 'Changed'`, coveredColumn: 'caption', uncovered: `SET created_at = created_at - interval '1 day'`,
  },
  'public.worker_preferred_cities': {
    insert: (b) => [`INSERT INTO public.worker_preferred_cities (user_id, city_key, city, state) VALUES ($1, 'austin-tx', 'Austin', 'TX') RETURNING *`,
      [b.worker]],
    covered: `SET city = 'Austin City'`, coveredColumn: 'city', uncovered: `SET created_at = created_at - interval '1 day'`,
  },
  'public.worker_profile_media': {
    insert: (b) => [`INSERT INTO public.worker_profile_media (user_id, media_type, s3_key, content_type)
                     VALUES ($1, 'profile_photo', 'profiles/test/photo.jpg', 'image/jpeg') RETURNING *`, [b.worker]],
    covered: `SET content_type = 'image/png'`, coveredColumn: 'content_type', uncovered: `SET created_at = created_at - interval '1 day'`,
  },
  'public.worker_profiles': {
    insert: (b) => [`INSERT INTO public.worker_profiles (user_id, full_name, phone) VALUES ($1, 'Synthetic Worker', '+15555550162') RETURNING *`,
      [b.worker]],
    covered: `SET bio = 'Changed bio'`, coveredColumn: 'bio', uncovered: `SET updated_at = now() - interval '1 day'`,
  },
  'public.worker_skills': {
    insert: (b) => [`INSERT INTO public.worker_skills (worker_id, skill) VALUES ($1, 'framing') RETURNING *`, [b.worker]],
    covered: `SET skill = 'roofing'`, coveredColumn: 'skill', uncovered: `SET created_at = created_at - interval '1 day'`,
  },
};

/** The covered columns a row holds a value in. */
const setColumns = (table: string, row: Row) => log.tables[table].columns.filter((col) => row[col] !== null && row[col] !== undefined);
const idsOf = (values: unknown[]) => [...new Set(values.filter((v) => v !== null && v !== undefined).map(String))].sort();

maybeDescribe('the change log', () => {
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    await su?.end();
  });

  describe('the change-log file against the catalog', () => {
    it('names only existing tables and accounts for every column exactly once, with a reason when excluded', async () => {
      const problems: string[] = [];
      for (const [table, spec] of Object.entries(log.tables)) {
        const { rows } = await su.query<{ attname: string }>(
          `SELECT a.attname FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table]);
        if (rows.length === 0) { problems.push(`${table}: no such table`); continue; }
        const catalog = rows.map((r) => r.attname);
        const excluded = log.excluded_columns[table] ?? {};
        for (const col of catalog) {
          const covered = spec.columns.includes(col);
          const reason = excluded[col];
          if (covered && reason) problems.push(`${table}.${col}: both covered and excluded`);
          if (!covered && !reason) problems.push(`${table}.${col}: neither covered nor excluded`);
          if (reason !== undefined && !reason.trim()) problems.push(`${table}.${col}: excluded without a reason`);
        }
        for (const col of [...spec.columns, ...Object.keys(excluded)]) {
          if (!catalog.includes(col)) problems.push(`${table}.${col}: listed but not in the catalog`);
        }
        if (new Set(spec.columns).size !== spec.columns.length || spec.columns.length === 0) problems.push(`${table}: covered columns empty or repeated`);
      }
      for (const table of Object.keys(log.excluded_columns)) {
        if (!log.tables[table]) problems.push(`${table}: excluded columns for a table that is not covered`);
      }
      expect(problems).toEqual([]);
    });

    it('keys and subjects are uuid columns, and the match columns are the primary key', async () => {
      const problems: string[] = [];
      for (const [table, spec] of Object.entries(log.tables)) {
        for (const col of [...(spec.key ? [spec.key] : []), ...spec.subject]) {
          const { rows } = await su.query<{ type: string }>(
            `SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS type FROM pg_catalog.pg_attribute a
              WHERE a.attrelid = to_regclass($1) AND a.attname = $2 AND NOT a.attisdropped`, [table, col]);
          if (rows[0]?.type !== 'uuid') problems.push(`${table}.${col}: not a uuid column`);
        }
        const { rows } = await su.query<{ cols: string[] }>(
          `SELECT ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, i)
                          JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i) AS cols
             FROM pg_catalog.pg_constraint k WHERE k.conrelid = to_regclass($1) AND k.contype = 'p'`, [table]);
        if (JSON.stringify(rows[0]?.cols) !== JSON.stringify(spec.match)) problems.push(`${table}: match ${spec.match} is not the primary key`);
        if (spec.key && !(spec.match.length === 1 && spec.match[0] === spec.key)) problems.push(`${table}: the key is not the primary key`);
        if (!spec.reason.trim()) problems.push(`${table}: no reason`);
      }
      expect(problems).toEqual([]);
    });

    it('every excluded table exists and carries no change-record trigger', async () => {
      const { rows } = await su.query<{ name: string; triggers: number }>(
        `SELECT t.name, (SELECT count(*)::int FROM pg_catalog.pg_trigger g
                          WHERE g.tgrelid = to_regclass(t.name) AND g.tgfoid = 'jale_audit.capture_change()'::regprocedure) AS triggers
           FROM unnest($1::text[]) t(name) WHERE to_regclass(t.name) IS NOT NULL`, [Object.keys(log.excluded_tables)]);
      expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(log.excluded_tables).sort());
      expect(rows.filter((r) => r.triggers > 0)).toEqual([]);
    });
  });

  describe('the triggers', () => {
    it('each covered table carries exactly its four statement triggers, enabled, with the file\'s arguments', async () => {
      const { rows } = await su.query<{ tbl: string; name: string; tgtype: number; enabled: string; args: string[]; oldtable: string | null; newtable: string | null }>(
        `SELECT n.nspname || '.' || c.relname AS tbl, t.tgname AS name, t.tgtype, t.tgenabled::text AS enabled,
                (string_to_array(encode(t.tgargs, 'escape'), '\\000'))[1:t.tgnargs] AS args,
                t.tgoldtable::text AS oldtable, t.tgnewtable::text AS newtable
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND t.tgfoid = 'jale_audit.capture_change()'::regprocedure
          ORDER BY 1, 2`,
      );
      const bits: Record<string, number> = { INSERT: 4, DELETE: 8, UPDATE: 16, TRUNCATE: 32 };
      const want = Object.keys(log.tables).sort().flatMap((table) => TRIGGER_EVENTS.map((e) => ({
        tbl: table, name: triggerName(table, e.suffix), tgtype: bits[e.event], enabled: 'O', args: triggerArgs(log.tables[table]),
        oldtable: e.event === 'UPDATE' || e.event === 'DELETE' ? 'old_rows' : null,
        newtable: e.event === 'UPDATE' || e.event === 'INSERT' ? 'new_rows' : null,
      }))).sort((a, b) => `${a.tbl} ${a.name}`.localeCompare(`${b.tbl} ${b.name}`));
      const got = [...rows].sort((a, b) => `${a.tbl} ${a.name}`.localeCompare(`${b.tbl} ${b.name}`));
      expect(got).toEqual(want);
    });

    it('capture_change is a definer owned by jale_audit_owner, executable by nobody else', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee <> p.proowner)::text[] AS others
           FROM pg_catalog.pg_proc p WHERE p.oid = 'jale_audit.capture_change()'::regprocedure`,
      );
      expect(rows).toEqual([{ owner: 'jale_audit_owner', prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], others: [] }]);
    });

    it('the file the suites read is the one in the repo', () => {
      expect(CHANGE_LOG_PATH).toMatch(/infra\/db\/access\/audit-change-log\.json$/);
    });
  });

  describe('what a statement records', () => {
    it.each(Object.keys(CASES).sort())('%s: an insert, an update and a delete each leave one record; an uncovered update leaves none', async (table) => {
      const spec = log.tables[table];
      const fixture = CASES[table];
      const result = await inTx(async (c, b) => {
        const out: Record<string, unknown> = {};
        let mark = await lastSeq(c);
        const [sql, params] = fixture.insert(b);
        const inserted = (await c.query<Row>(sql, params)).rows[0];
        const where = spec.match.map((col, i) => `${col} = $${i + 1}`).join(' AND ');
        const matchValues = () => spec.match.map((col) => inserted[col]);
        out.insert = await changesAfter(c, mark, table);
        out.insertWant = [{
          table_name: table, operation: 'insert', row_count: 1,
          record_ids: spec.key ? [String(inserted[spec.key])] : [],
          subject_user_ids: idsOf(spec.subject.map((s) => inserted[s])),
          changed_fields: setColumns(table, inserted),
          actor_kind: null, actor_id: null, channel: null, surface: null, request_id: null, context_status: 'unset', db_login: 'postgres',
        }];

        mark = await lastSeq(c);
        await c.query(`UPDATE ${table} ${fixture.uncovered} WHERE ${where}`, matchValues());
        out.uncovered = await changesAfter(c, mark, table);

        mark = await lastSeq(c);
        const updated = (await c.query<Row>(`UPDATE ${table} ${fixture.covered} WHERE ${where} RETURNING *`, matchValues())).rows[0];
        const updates = await changesAfter(c, mark, table);
        out.update = updates.map((u) => [u.operation, u.row_count, u.changed_fields, u.record_ids, u.subject_user_ids, u.context_status]);
        out.updateWant = [['update', 1, [fixture.coveredColumn], spec.key ? [String(updated[spec.key])] : [],
          idsOf(spec.subject.flatMap((s) => [inserted[s], updated[s]])), 'unset']];

        mark = await lastSeq(c);
        const newWhere = spec.match.map((col, i) => `${col} = $${i + 1}`).join(' AND ');
        await c.query(`DELETE FROM ${table} WHERE ${newWhere}`, spec.match.map((col) => updated[col]));
        const deletes = await changesAfter(c, mark, table);
        out.delete = deletes.map((d) => [d.operation, d.row_count, d.changed_fields, d.record_ids, d.subject_user_ids]);
        out.deleteWant = [['delete', 1, setColumns(table, updated), spec.key ? [String(updated[spec.key])] : [],
          idsOf(spec.subject.map((s) => updated[s]))]];
        return out;
      });
      expect(result.insert).toEqual(result.insertWant);
      expect(result.uncovered).toEqual([]);
      expect(result.update).toEqual(result.updateWant);
      expect(result.delete).toEqual(result.deleteWant);
    });

    it('a bulk statement leaves one summary record, with ids only up to 100', async () => {
      const result = await inTx(async (c, b) => {
        let mark = await lastSeq(c);
        await c.query(`INSERT INTO public.worker_skills (worker_id, skill) SELECT $1, 'skill-' || g FROM generate_series(1, 150) g`, [b.worker]);
        const skills = await changesAfter(c, mark, 'public.worker_skills');
        mark = await lastSeq(c);
        await c.query(
          `INSERT INTO public.users (cognito_sub, user_type, email)
           SELECT 'test-bulk-' || g || '-' || $1, 'worker', 'bulk-' || g || '-' || $1 || '@example.invalid' FROM generate_series(1, 101) g`,
          [hex(8)]);
        const users = await changesAfter(c, mark, 'public.users');
        mark = await lastSeq(c);
        await c.query(`UPDATE public.users SET full_name = 'Bulk' WHERE cognito_sub LIKE 'test-bulk-%'`);
        const updated = await changesAfter(c, mark, 'public.users');
        return { skills, users, updated };
      });
      expect(result.skills.map((s) => [s.operation, s.row_count, s.record_ids, s.subject_user_ids?.length, s.changed_fields]))
        .toEqual([['insert', 150, [], 1, ['skill']]]);
      expect(result.users.map((s) => [s.operation, s.row_count, s.record_ids, s.subject_user_ids])).toEqual([['insert', 101, null, null]]);
      expect(result.updated.map((s) => [s.operation, s.row_count, s.changed_fields])).toEqual([['update', 101, ['full_name']]]);
    });

    it('a truncate leaves one record naming every covered column', async () => {
      const result = await inTx(async (c) => {
        const mark = await lastSeq(c);
        await c.query('TRUNCATE public.worker_skills');
        return changesAfter(c, mark, 'public.worker_skills');
      });
      expect(result.map((r) => [r.operation, r.row_count, r.record_ids, r.subject_user_ids, r.changed_fields]))
        .toEqual([['truncate', 0, null, null, log.tables['public.worker_skills'].columns]]);
    });

    it('a statement that changes no covered value leaves no record: no rows, the same values, an upsert that did nothing', async () => {
      const result = await inTx(async (c, b) => {
        await c.query(`INSERT INTO public.worker_skills (worker_id, skill) VALUES ($1, 'framing')`, [b.worker]);
        await c.query(`INSERT INTO public.worker_profiles (user_id, bio) VALUES ($1, 'Synthetic bio')`, [b.worker]);
        const mark = await lastSeq(c);
        const nobody = syntheticUuid();
        await c.query(`UPDATE public.users SET email = email || '.x' WHERE id = $1`, [nobody]);
        await c.query('DELETE FROM public.users WHERE id = $1', [nobody]);
        await c.query('UPDATE public.users SET email = email, full_name = full_name WHERE id = $1', [b.worker]);
        await c.query(`INSERT INTO public.worker_skills (worker_id, skill) VALUES ($1, 'framing') ON CONFLICT DO NOTHING`, [b.worker]);
        await c.query(`INSERT INTO public.worker_profiles (user_id, bio) VALUES ($1, 'Synthetic bio')
                       ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio`, [b.worker]);
        // The control: one covered change, so the triggers are known to be live.
        await c.query(`UPDATE public.users SET full_name = 'Control' WHERE id = $1`, [b.worker]);
        return changesAfter(c, mark);
      });
      expect(result.map((r) => [r.table_name, r.operation, r.changed_fields])).toEqual([['public.users', 'update', ['full_name']]]);
    });

    it('an upsert leaves one record for what it did: an update of an existing row, or an insert', async () => {
      const result = await inTx(async (c, b) => {
        await c.query(`INSERT INTO public.worker_profiles (user_id, bio) VALUES ($1, 'Synthetic bio')`, [b.worker]);
        let mark = await lastSeq(c);
        await c.query(`INSERT INTO public.worker_profiles (user_id, bio) VALUES ($1, 'Changed bio')
                       ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio`, [b.worker]);
        const updated = await changesAfter(c, mark);
        mark = await lastSeq(c);
        await c.query(`INSERT INTO public.worker_application_defaults (worker_id, answers) VALUES ($1, '{"a": 1}')
                       ON CONFLICT (worker_id) DO UPDATE SET answers = EXCLUDED.answers`, [b.worker]);
        const inserted = await changesAfter(c, mark);
        return { updated, inserted, worker: b.worker };
      });
      expect(result.updated.map((r) => [r.table_name, r.operation, r.row_count, r.changed_fields, r.record_ids]))
        .toEqual([['public.worker_profiles', 'update', 1, ['bio'], [result.worker]]]);
      expect(result.inserted.map((r) => [r.table_name, r.operation, r.row_count, r.changed_fields, r.record_ids]))
        .toEqual([['public.worker_application_defaults', 'insert', 1, ['answers'], [result.worker]]]);
    });

    it('an update names only the rows whose covered columns changed', async () => {
      const result = await inTx(async (c) => {
        const ids = (await c.query<{ id: string }>(
          `INSERT INTO public.users (cognito_sub, user_type, email, full_name)
           SELECT 'test-part-' || g || '-' || $1, 'worker', 'part-' || g || '-' || $1 || '@example.invalid',
                  CASE WHEN g = 1 THEN 'Same Name' ELSE 'Other Name' END
             FROM generate_series(1, 3) g RETURNING id`, [hex(8)])).rows.map((r) => r.id);
        const unchanged = (await c.query<{ id: string }>(`SELECT id FROM public.users WHERE id = ANY($1::uuid[]) AND full_name = 'Same Name'`,
          [ids])).rows[0].id;
        const mark = await lastSeq(c);
        await c.query(`UPDATE public.users SET full_name = 'Same Name' WHERE id = ANY($1::uuid[])`, [ids]);
        return { rows: await changesAfter(c, mark), changed: ids.filter((id) => id !== unchanged).sort() };
      });
      expect(result.rows.map((r) => [r.operation, r.row_count, r.changed_fields, r.record_ids, r.subject_user_ids]))
        .toEqual([['update', 2, ['full_name'], result.changed, result.changed]]);
    });

    it('a subject that changes names both users', async () => {
      const result = await inTx(async (c, b) => {
        const other = (await c.query<{ id: string }>(
          `INSERT INTO public.users (cognito_sub, user_type, email) VALUES ($1, 'worker', $2) RETURNING id`,
          [`test-sub-${hex(12)}`, `other-${hex(8)}@example.invalid`])).rows[0].id;
        const caseId = (await c.query<{ id: string }>(
          `INSERT INTO public.admin_cases (case_type, status, summary, user_id) VALUES ('help_request', 'open', 'Synthetic case', $1) RETURNING id`,
          [b.worker])).rows[0].id;
        const mark = await lastSeq(c);
        await c.query('UPDATE public.admin_cases SET user_id = $1 WHERE id = $2', [other, caseId]);
        return { rows: await changesAfter(c, mark), caseId, subjects: [b.worker, other].sort() };
      });
      expect(result.rows.map((r) => [r.operation, r.row_count, r.changed_fields, r.record_ids, r.subject_user_ids]))
        .toEqual([['update', 1, ['user_id'], [result.caseId], result.subjects]]);
    });

    it.each([
      ['public.worker_posts', 'worker_id'],
      ['public.worker_profile_media', 'user_id'],
    ])('%s: a statement that only moves a row to another user leaves one record naming both users', async (table, subjectColumn) => {
      const result = await inTx(async (c, b) => {
        const other = (await c.query<{ id: string }>(
          `INSERT INTO public.users (cognito_sub, user_type, email) VALUES ($1, 'worker', $2) RETURNING id`,
          [`test-sub-${hex(12)}`, `moved-${hex(8)}@example.invalid`])).rows[0].id;
        const [sql, params] = CASES[table].insert(b);
        const row = (await c.query<Row>(sql, params)).rows[0];
        const mark = await lastSeq(c);
        await c.query(`UPDATE ${table} SET ${subjectColumn} = $1 WHERE id = $2`, [other, row.id]);
        return { rows: await changesAfter(c, mark, table), id: String(row.id), subjects: [String(row[subjectColumn]), other].sort() };
      });
      expect(result.rows.map((r) => [r.operation, r.row_count, r.changed_fields, r.record_ids, r.subject_user_ids]))
        .toEqual([['update', 1, [subjectColumn], [result.id], result.subjects]]);
    });

    it('a row whose primary key changes is compared with no row', async () => {
      const result = await inTx(async (c, b) => {
        await c.query(`INSERT INTO public.worker_preferred_cities (user_id, city_key, city, state) VALUES ($1, 'austin-tx', 'Austin', 'TX')`,
          [b.worker]);
        const mark = await lastSeq(c);
        await c.query(`UPDATE public.worker_preferred_cities SET city_key = 'austin-tx-2' WHERE user_id = $1`, [b.worker]);
        return { rows: await changesAfter(c, mark), worker: b.worker };
      });
      expect(result.rows.map((r) => [r.operation, r.row_count, r.changed_fields, r.record_ids, r.subject_user_ids]))
        .toEqual([['update', 1, ['city_key', 'city', 'state'], [], [result.worker]]]);
    });
  });

  describe('the audit context', () => {
    const employerId = syntheticUuid();
    // The longest values the context accepts: a 100-character surface and a 64-character request id.
    const LONGEST_SURFACE = `admin.${'s'.repeat(94)}`;
    const LONGEST_REQUEST = 'r'.repeat(64);
    const context = (kind: string, id: string, channel: string, surface: string, requestId: string) =>
      [kind, id, channel, surface, requestId] as const;
    const setContext = `SELECT set_config('app.audit_actor_kind', $1, true), set_config('app.audit_actor_id', $2, true),
                               set_config('app.audit_channel', $3, true), set_config('app.audit_surface', $4, true),
                               set_config('app.audit_request_id', $5, true)`;

    async function recordWith(values: readonly string[] | null): Promise<Change> {
      return inTx(async (c, b) => {
        if (values) await c.query(setContext, [...values]);
        const mark = await lastSeq(c);
        await c.query(`UPDATE public.users SET full_name = 'Context Test' WHERE id = $1`, [b.worker]);
        const rows = await changesAfter(c, mark, 'public.users');
        expect(rows).toHaveLength(1);
        return rows[0];
      });
    }
    const pick = (r: Change) => ({
      context_status: r.context_status, actor_kind: r.actor_kind, actor_id: r.actor_id, channel: r.channel, surface: r.surface,
      request_id: r.request_id,
    });

    it('records a valid context as set, with its values', async () => {
      expect(pick(await recordWith(context('employer', employerId, 'web', 'employer.profile_edit', 'req-0001')))).toEqual({
        context_status: 'set', actor_kind: 'employer', actor_id: employerId, channel: 'web', surface: 'employer.profile_edit', request_id: 'req-0001',
      });
      expect(pick(await recordWith(context('token_holder', '', 'web', 'worker.document_upload', '')))).toEqual({
        context_status: 'set', actor_kind: 'token_holder', actor_id: null, channel: 'web', surface: 'worker.document_upload', request_id: null,
      });
      expect(pick(await recordWith(context('admin', employerId.toUpperCase(), 'admin', LONGEST_SURFACE, LONGEST_REQUEST)))).toEqual({
        context_status: 'set', actor_kind: 'admin', actor_id: employerId, channel: 'admin', surface: LONGEST_SURFACE, request_id: LONGEST_REQUEST,
      });
    });

    it('records no context as unset', async () => {
      const unset = { context_status: 'unset', actor_kind: null, actor_id: null, channel: null, surface: null, request_id: null };
      expect(pick(await recordWith(null))).toEqual(unset);
      expect(pick(await recordWith(context('', '', '', '', '')))).toEqual(unset);
    });

    it.each([
      ['a worker without an id', context('worker', '', 'web', 'worker.profile_edit', '')],
      ['a platform actor with an id', context('platform', employerId, 'web', 'worker.profile_edit', '')],
      ['an unknown actor kind', context('robot', '', 'web', 'worker.profile_edit', '')],
      ['an actor id that is not a UUID', context('employer', '+15555550163', 'web', 'employer.profile_edit', '')],
      ['an unknown channel', context('employer', employerId, 'email', 'employer.profile_edit', '')],
      ['a surface outside the pattern', context('employer', employerId, 'web', 'Employer Profile', '')],
      ['a request id with a space', context('employer', employerId, 'web', 'employer.profile_edit', 'a b')],
      ['a request id alone', context('', '', '', '', 'req-0002')],
      ['a surface of 101 characters', context('admin', employerId, 'admin', `${'admin.'}${'s'.repeat(95)}`, '')],
      ['a request id of 65 characters', context('admin', employerId, 'admin', 'admin.reveal', 'r'.repeat(65))],
      ['an actor id in braces', context('employer', `{${employerId}}`, 'web', 'employer.profile_edit', '')],
    ])('records %s as invalid, keeps no field, and never fails the write', async (_label, values) => {
      expect(pick(await recordWith(values))).toEqual({
        context_status: 'invalid', actor_kind: null, actor_id: null, channel: null, surface: null, request_id: null,
      });
    });
  });

  describe('the writing login', () => {
    it('a write through a definer records the login, not the function owner', async () => {
      // create_admin_support_case is a definer owned by jale_admin that
      // jale_whatsapp may execute; it inserts the support case.
      const sub = `test-sub-changelog-${hex(10)}`;
      const number = '+15555550188';
      await su.query('BEGIN');
      let worker = '';
      let conversation = '';
      try {
        worker = (await su.query<{ id: string }>(
          `INSERT INTO public.users (cognito_sub, user_type, email) VALUES ($1, 'worker', $2) RETURNING id`,
          [sub, `changelog-${hex(8)}@example.invalid`])).rows[0].id;
        conversation = (await su.query<{ id: string }>(
          `INSERT INTO public.whatsapp_conversations (user_id, whatsapp_number, conversation_state) VALUES ($1, $2, 'idle') RETURNING id`,
          [worker, number])).rows[0].id;
        await su.query('COMMIT');
      } catch (err) {
        await su.query('ROLLBACK');
        throw err;
      }
      try {
        const mark = await lastSeq(su);
        const caseId = await withLoginClient('jale_whatsapp', async (c) => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [sub]);
          await c.query(`SELECT set_config('app.audit_actor_kind', 'worker', true), set_config('app.audit_actor_id', $1, true),
                                set_config('app.audit_channel', 'whatsapp', true), set_config('app.audit_surface', 'whatsapp.support_command', true),
                                set_config('app.audit_request_id', '', true)`, [worker]);
          const { rows } = await c.query<{ case_id: string; created: boolean }>(
            'SELECT case_id, created FROM public.create_admin_support_case($1, $2, $3, $4)', [worker, conversation, 'Synthetic', 'support']);
          await c.query('COMMIT');
          expect(rows[0].created).toBe(true);
          return rows[0].case_id;
        });
        const rows = await changesAfter(su, mark, 'public.admin_cases');
        expect(rows.map((r) => [r.operation, r.db_login, r.record_ids, r.subject_user_ids, r.context_status, r.actor_kind, r.channel]))
          .toEqual([['insert', 'jale_whatsapp', [caseId], [worker], 'set', 'worker', 'whatsapp']]);
      } finally {
        await su.query('DELETE FROM public.admin_cases WHERE user_id = $1', [worker]);
        await su.query('DELETE FROM public.whatsapp_conversations WHERE id = $1', [conversation]);
        await su.query('DELETE FROM public.users WHERE id = $1', [worker]);
      }
    });
  });

  describe('a cascade', () => {
    it('an employer deleting two jobs records the cascade to their applications under the employer, in one record', async () => {
      const result = await inTx(async (c, b) => {
        const second = (await c.query<{ id: string }>(
          `INSERT INTO public.job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`, [b.job2, b.worker])).rows[0].id;
        await c.query(`SELECT set_config('app.audit_actor_kind', 'employer', true), set_config('app.audit_actor_id', $1, true),
                              set_config('app.audit_channel', 'web', true), set_config('app.audit_surface', 'employer.job_delete', true),
                              set_config('app.audit_request_id', 'req-cascade-1', true)`, [b.employer]);
        const mark = await lastSeq(c);
        await c.query('DELETE FROM public.jobs WHERE id = ANY($1::uuid[])', [[b.job, b.job2]]);
        return { rows: await changesAfter(c, mark, 'public.job_applications'), ids: [b.application, second], b };
      });
      expect(result.rows.map((r) => [r.operation, r.row_count, r.record_ids, r.subject_user_ids, r.actor_kind, r.actor_id, r.context_status,
        r.surface])).toEqual([
        ['delete', 2, [...result.ids].sort(), [result.b.worker], 'employer', result.b.employer, 'set', 'employer.job_delete'],
      ]);
    });
  });
});
