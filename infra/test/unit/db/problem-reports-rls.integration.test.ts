/**
 * problem-reports-rls.integration.test.ts -- report a problem: who can reach
 * the report tables, on a real database (migrations 107-108).
 *
 * Reports live in four tables that no runtime login holds any right on. The
 * jale_cap report functions are the only way in; each runs as a NOLOGIN
 * capability owner whose grants and policies admit only what its functions
 * need. In every test-bed profile this suite proves:
 *   - every runtime login in the merged access manifest is refused every
 *     command on every report table and on the report-number sequence, and
 *     the rows are unchanged afterwards;
 *   - the report tables carry exactly the reviewed policies, each TO one
 *     capability owner, and the five on users and email_outbox are the only
 *     report policies on existing tables;
 *   - the intake owner sees reports from the last 24 hours only;
 *   - the admin console owner reads only the accounts that have a report;
 *   - deleting an account removes its reports' personal content and keeps the
 *     header for counting;
 *   - the signed-out intake login and the clean-up login reach their own
 *     functions and no other definer.
 *
 * Function calls go over real authenticated connections as the caller login
 * (helpers/login-pool). Fixtures go through the superuser URL the bed
 * exports. The capability owners are NOLOGIN roles and cannot sign in, so
 * their row visibility is probed with SET LOCAL ROLE inside a superuser
 * transaction that is always rolled back.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { loadManifest, runtimeLogins } from '../../../db/access/access-manifest';
import { DB_PROFILES, describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: problem-reports RLS PostgreSQL gate was not run', () => {
    console.warn('[problem-reports-rls] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}

const INTAKE = 'jale_cap_problem_reports';
const CONSOLE = 'jale_cap_problem_reports_admin';
const CLEANUP = 'jale_cap_report_cleanup';
const CONSOLE_GATE = 'app.problem_report_console';

const REPORT_TABLES = [
  'public.problem_reports',
  'public.problem_report_contents',
  'public.problem_report_rate_buckets',
  'public.problem_report_settings',
] as const;

/** A column each table has, for the UPDATE probe. */
const UPDATE_COLUMN: Record<(typeof REPORT_TABLES)[number], string> = {
  'public.problem_reports': 'status',
  'public.problem_report_contents': 'internal_note',
  'public.problem_report_rate_buckets': 'request_count',
  'public.problem_report_settings': 'reporting_enabled',
};

/** The reviewed policy set: [table, policy, command, role]. */
const EXPECTED_POLICIES: Array<[string, string, string, string]> = [
  ['email_outbox', 'email_outbox_problem_report_cleanup_delete', 'DELETE', CLEANUP],
  ['email_outbox', 'email_outbox_problem_report_cleanup_read', 'SELECT', CLEANUP],
  ['email_outbox', 'email_outbox_problem_report_insert', 'INSERT', INTAKE],
  ['problem_report_contents', 'problem_report_contents_cleanup_delete', 'DELETE', CLEANUP],
  ['problem_report_contents', 'problem_report_contents_cleanup_read', 'SELECT', CLEANUP],
  ['problem_report_contents', 'problem_report_contents_cleanup_update', 'UPDATE', CLEANUP],
  ['problem_report_contents', 'problem_report_contents_console_read', 'SELECT', CONSOLE],
  ['problem_report_contents', 'problem_report_contents_console_update', 'UPDATE', CONSOLE],
  ['problem_report_contents', 'problem_report_contents_intake_insert', 'INSERT', INTAKE],
  ['problem_report_contents', 'problem_report_contents_intake_read', 'SELECT', INTAKE],
  ['problem_report_contents', 'problem_report_contents_intake_update', 'UPDATE', INTAKE],
  ['problem_report_rate_buckets', 'problem_report_rate_buckets_cleanup_delete', 'DELETE', CLEANUP],
  ['problem_report_rate_buckets', 'problem_report_rate_buckets_cleanup_read', 'SELECT', CLEANUP],
  ['problem_report_rate_buckets', 'problem_report_rate_buckets_intake_insert', 'INSERT', INTAKE],
  ['problem_report_rate_buckets', 'problem_report_rate_buckets_intake_read', 'SELECT', INTAKE],
  ['problem_report_rate_buckets', 'problem_report_rate_buckets_intake_update', 'UPDATE', INTAKE],
  ['problem_report_settings', 'problem_report_settings_console_read', 'SELECT', CONSOLE],
  ['problem_report_settings', 'problem_report_settings_console_update', 'UPDATE', CONSOLE],
  ['problem_report_settings', 'problem_report_settings_intake_read', 'SELECT', INTAKE],
  ['problem_reports', 'problem_reports_cleanup_read', 'SELECT', CLEANUP],
  ['problem_reports', 'problem_reports_cleanup_update', 'UPDATE', CLEANUP],
  ['problem_reports', 'problem_reports_console_read', 'SELECT', CONSOLE],
  ['problem_reports', 'problem_reports_console_update', 'UPDATE', CONSOLE],
  ['problem_reports', 'problem_reports_intake_insert', 'INSERT', INTAKE],
  ['problem_reports', 'problem_reports_intake_read', 'SELECT', INTAKE],
  ['problem_reports', 'problem_reports_intake_update', 'UPDATE', INTAKE],
  ['users', 'users_problem_reports_admin_read', 'SELECT', CONSOLE],
  ['users', 'users_problem_reports_intake_read', 'SELECT', INTAKE],
];

const PUBLIC_REPORT_FUNCTIONS = [
  'jale_cap.problem_report_attach(uuid,text,text,text,text,integer)',
  'jale_cap.problem_report_config()',
  'jale_cap.problem_report_create_unverified(uuid,text,text,text,boolean,text,text,boolean,jsonb,text,text)',
  'jale_cap.problem_report_pending_upload(uuid,text)',
  'jale_cap.problem_report_upload_grant(uuid,text,text)',
];

const tokenHash = (): string => createHash('sha256').update(randomBytes(32)).digest('hex');

interface SeedOptions {
  /** How long ago the report was created. */
  age?: string;
  verified?: boolean;
  role?: 'worker' | 'employer' | 'unknown';
  category?: string;
  userId?: string | null;
  sub?: string | null;
  attachTokenHash?: string | null;
}

/** Inserts a header and its contents as the superuser; returns the report id. */
async function seedReport(su: Client, options: SeedOptions = {}): Promise<string> {
  const id = randomUUID();
  const verified = options.verified ?? true;
  await su.query(
    `WITH header AS (
       INSERT INTO public.problem_reports
         (id, client_key, role, verified, category, locale, include_technical, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'en', true, now() - $6::interval, now() - $6::interval)
       RETURNING id, created_at)
     INSERT INTO public.problem_report_contents
       (report_id, created_at, reporter_user_id, reporter_sub, description, attach_token_hash)
     SELECT header.id, header.created_at, $7, $8, 'The page stopped loading.', $9 FROM header`,
    [id, randomUUID(), options.role ?? 'worker', verified, options.category ?? 'finding_jobs',
      options.age ?? '0 seconds', options.userId ?? null, options.sub ?? null, options.attachTokenHash ?? null],
  );
  return id;
}

async function insertUser(su: Client, userType: 'worker' | 'employer'): Promise<{ id: string; sub: string }> {
  const sub = randomUUID();
  const { rows } = await su.query<{ id: string }>(
    'INSERT INTO public.users (cognito_sub, user_type, full_name) VALUES ($1, $2, $3) RETURNING id',
    [sub, userType, 'Fixture Reporter'],
  );
  return { id: rows[0].id, sub };
}

async function resetReports(su: Client): Promise<void> {
  await su.query('DELETE FROM public.problem_reports');
  await su.query('DELETE FROM public.problem_report_rate_buckets');
  await su.query("DELETE FROM public.email_outbox WHERE source_type = 'problem_report'");
  await su.query(
    `UPDATE public.problem_report_settings
        SET reporting_enabled = true, signed_out_enabled = true, screenshots_enabled = true,
            team_email_enabled = true, signed_out_daily_cap = 200, team_recipient = NULL,
            admin_base_url = NULL, updated_by_admin = NULL, updated_at = now()`,
  );
}

/** Runs `fn` as `role` inside a superuser transaction that is always rolled back. */
async function asOwner<T>(su: Client, role: string, fn: () => Promise<T>, gate = false): Promise<T> {
  await su.query('BEGIN');
  try {
    await su.query(`SET LOCAL ROLE ${role}`);
    if (gate) await su.query(`SELECT pg_catalog.set_config('${CONSOLE_GATE}', 'on', true)`);
    return await fn();
  } finally {
    await su.query('ROLLBACK');
  }
}

/** Every row of every report table, as text, for a before/after comparison. */
async function snapshot(su: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of REPORT_TABLES) {
    const { rows } = await su.query<{ digest: string | null; n: number }>(
      `SELECT count(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest FROM ${table} t`,
    );
    out[table] = `${rows[0].n}:${rows[0].digest ?? ''}`;
  }
  const seq = await su.query<{ last_value: string }>('SELECT last_value::text FROM public.problem_report_number_seq');
  out.sequence = seq.rows[0].last_value;
  return out;
}

async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'error';
  }
}

describeInProfiles(DB_PROFILES, 'problem reports: row-level security and reach', () => {
  let su: Client;
  const users: Record<string, { id: string; sub: string }> = {};

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    await resetReports(su);
    users.reporter = await insertUser(su, 'worker');
    users.lateAccount = await insertUser(su, 'employer');
    users.bystander = await insertUser(su, 'worker');
    users.leaving = await insertUser(su, 'worker');
  });

  afterAll(async () => {
    await resetReports(su);
    await su.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [Object.values(users).map((u) => u.id)]);
    await su.end();
  });

  describe('runtime logins', () => {
    it('every runtime login is refused every command on every report table and the sequence, settings or not, and nothing changes', async () => {
      await seedReport(su, { userId: users.reporter.id, attachTokenHash: tokenHash() });
      await su.query(
        `INSERT INTO public.problem_report_rate_buckets (address_hash, window_kind, bucket_start, request_count)
         VALUES ($1, 'hour', date_trunc('hour', now(), 'UTC'), 1)`,
        [randomBytes(32).toString('hex')],
      );
      const before = await snapshot(su);
      const logins = runtimeLogins(loadManifest());
      expect(logins).toEqual(expect.arrayContaining(['jale_api', 'jale_api_public_reports', 'jale_job_report_cleanup']));

      const outcomes: string[] = [];
      for (const login of logins) {
        await withLoginClient(login, async (c) => {
          // Once as the login is, and once with the console's setting and a
          // reporter's caller id set by the login itself: neither unlocks anything.
          for (const flags of [false, true]) {
            if (flags) {
              await c.query(`SELECT pg_catalog.set_config('${CONSOLE_GATE}', 'on', false)`);
              await c.query("SELECT pg_catalog.set_config('app.current_user_id', $1, false)", [users.reporter.sub]);
            }
            const mode = flags ? 'with settings' : 'plain';
            for (const table of REPORT_TABLES) {
              const column = UPDATE_COLUMN[table];
              const probes: Record<string, string> = {
                select: `SELECT 1 FROM ${table} LIMIT 1`,
                insert: `INSERT INTO ${table} DEFAULT VALUES`,
                update: `UPDATE ${table} SET ${column} = ${column}`,
                delete: `DELETE FROM ${table}`,
                truncate: `TRUNCATE ${table}`,
              };
              for (const [command, sql] of Object.entries(probes)) {
                outcomes.push(`${login} ${mode} ${command} ${table}: ${await sqlState(() => c.query(sql))}`);
              }
            }
            for (const sql of [
              "SELECT nextval('public.problem_report_number_seq')",
              "SELECT setval('public.problem_report_number_seq', 5000)",
              'SELECT last_value FROM public.problem_report_number_seq',
            ]) {
              outcomes.push(`${login} ${mode} sequence ${sql.slice(7, 14)}: ${await sqlState(() => c.query(sql))}`);
            }
          }
        });
      }
      expect(outcomes.filter((line) => !line.endsWith(': 42501'))).toEqual([]);
      expect(outcomes).toHaveLength(2 * logins.length * (REPORT_TABLES.length * 5 + 3));
      expect(await snapshot(su)).toEqual(before);
    });

    it('no runtime login holds any privilege on a report table, column or the sequence', async () => {
      const { rows } = await su.query<{ grantee: string; object: string; privilege: string }>(
        `SELECT pg_catalog.pg_get_userbyid(a.grantee) AS grantee, c.relname AS object, a.privilege_type AS privilege
           FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relname IN ('problem_reports', 'problem_report_contents', 'problem_report_rate_buckets',
                              'problem_report_settings', 'problem_report_number_seq')
            AND pg_catalog.pg_get_userbyid(a.grantee) = ANY($1::text[])
         UNION ALL
         SELECT pg_catalog.pg_get_userbyid(a.grantee), c.relname || '.' || att.attname, a.privilege_type
           FROM pg_catalog.pg_attribute att
           JOIN pg_catalog.pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relname IN ('problem_reports', 'problem_report_contents', 'problem_report_rate_buckets',
                              'problem_report_settings')
            AND pg_catalog.pg_get_userbyid(a.grantee) = ANY($1::text[])`,
        [runtimeLogins(loadManifest())],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('policies', () => {
    it('the report tables carry exactly the reviewed policies, each permissive and TO one capability owner', async () => {
      const { rows } = await su.query<{ table: string; policy: string; command: string; roles: string[] }>(
        `SELECT p.tablename AS table, p.policyname AS policy, p.cmd AS command, p.roles::text[] AS roles
           FROM pg_catalog.pg_policies p
          WHERE p.schemaname = 'public'
            AND (p.tablename LIKE 'problem\\_report%'
                 OR p.policyname LIKE '%problem\\_report%')
            AND p.permissive = 'PERMISSIVE'
          ORDER BY p.tablename, p.policyname`,
      );
      // Sorted here, not in SQL, so the order never depends on the bed's collation.
      const actual = rows.map((r) => [r.table, r.policy, r.command, r.roles.join(',')].join(' ')).sort();
      expect(actual).toEqual(EXPECTED_POLICIES.map((row) => row.join(' ')).sort());
      const restrictive = await su.query(
        `SELECT 1 FROM pg_catalog.pg_policies
          WHERE schemaname = 'public' AND tablename LIKE 'problem\\_report%' AND permissive <> 'PERMISSIVE'`,
      );
      expect(restrictive.rows).toEqual([]);
    });

    it('the intake owner policies admit the last 24 hours only, and the console owner policies only its own functions', async () => {
      const { rows } = await su.query<{ policy: string; qual: string | null; check: string | null }>(
        `SELECT policyname AS policy, qual, with_check AS check FROM pg_catalog.pg_policies
          WHERE schemaname = 'public' AND tablename IN ('problem_reports', 'problem_report_contents')
          ORDER BY policyname`,
      );
      for (const row of rows) {
        const expressions = [row.qual, row.check].filter((e): e is string => e !== null);
        expect({ policy: row.policy, hasExpression: expressions.length > 0 }).toEqual({ policy: row.policy, hasExpression: true });
        for (const expression of expressions) {
          if (row.policy.includes('_intake_')) expect(expression).toBe("(created_at > (now() - '24:00:00'::interval))");
          if (row.policy.includes('_console_')) expect(expression).toBe(`(current_setting('${CONSOLE_GATE}'::text, true) = 'on'::text)`);
          if (row.policy.includes('_cleanup_')) expect(expression).toMatch(/^\(created_at < \(now\(\) - '[^']+'::interval\)\)$/);
        }
      }
    });
  });

  describe('the intake owner', () => {
    it('sees reports and contents from the last 24 hours only', async () => {
      await resetReports(su);
      const fresh = await seedReport(su, { age: '1 minute' });
      const day = await seedReport(su, { age: '23 hours' });
      const stale = await seedReport(su, { age: '25 hours' });
      const visible = await asOwner(su, INTAKE, async () => ({
        headers: (await su.query<{ id: string }>('SELECT id FROM public.problem_reports ORDER BY created_at DESC')).rows.map((r) => r.id),
        contents: (await su.query<{ report_id: string }>('SELECT report_id FROM public.problem_report_contents ORDER BY created_at DESC')).rows.map((r) => r.report_id),
      }));
      expect(visible).toEqual({ headers: [fresh, day], contents: [fresh, day] });
      expect((await su.query('SELECT 1 FROM public.problem_reports WHERE id = $1', [stale])).rows).toHaveLength(1);
    });

    it('so an upload for a report older than 24 hours is not found, while a 23-hour-old one is only expired', async () => {
      await resetReports(su);
      const token = tokenHash();
      const day = await seedReport(su, { age: '23 hours', attachTokenHash: token });
      const stale = await seedReport(su, { age: '25 hours', attachTokenHash: token });
      const grant = (id: string) => withLoginClient('jale_api_public_reports', async (c) =>
        (await c.query<{ outcome: string }>(
          "SELECT outcome FROM jale_cap.problem_report_upload_grant($1, $2, 'image/png')", [id, token],
        )).rows[0].outcome);
      expect(await grant(day)).toBe('upload_expired');
      expect(await grant(stale)).toBe('not_found');
    });

    it('holds no read right on the words, the contact, the context or the note', async () => {
      const { rows } = await su.query<{ column: string; readable: boolean }>(
        `SELECT c AS column, pg_catalog.has_column_privilege($1, 'public.problem_report_contents', c, 'SELECT') AS readable
           FROM unnest(ARRAY['description', 'typed_contact', 'context', 'internal_note']) AS c`,
        [INTAKE],
      );
      expect(rows.filter((r) => r.readable)).toEqual([]);
      expect(await asOwner(su, INTAKE, () => sqlState(() => su.query('SELECT description FROM public.problem_report_contents'))))
        .toBe('42501');
    });
  });

  describe('the admin console owner', () => {
    it('reads only the accounts that have a report, and only inside its own functions', async () => {
      await resetReports(su);
      await seedReport(su, { userId: users.reporter.id });
      // A sign-in without an account at report time; its account exists now.
      await seedReport(su, { sub: users.lateAccount.sub, role: 'employer', category: 'billing' });
      const read = (gate: boolean) => asOwner(su, CONSOLE, async () =>
        (await su.query<{ id: string }>('SELECT id FROM public.users ORDER BY id')).rows.map((r) => r.id), gate);
      expect(await read(true)).toEqual([users.reporter.id, users.lateAccount.id].sort());
      expect(await read(false)).toEqual([]);
      expect(await asOwner(su, CONSOLE, () => sqlState(() => su.query('SELECT full_name FROM public.users')), true))
        .toBe('42501');
    });

    it('sees every report header only while one of its functions has opened its gate', async () => {
      await resetReports(su);
      const old = await seedReport(su, { age: '400 days' });
      const fresh = await seedReport(su, { age: '1 minute' });
      const read = (gate: boolean) => asOwner(su, CONSOLE, async () =>
        (await su.query<{ id: string }>('SELECT id FROM public.problem_reports ORDER BY created_at')).rows.map((r) => r.id), gate);
      expect(await read(true)).toEqual([old, fresh]);
      expect(await read(false)).toEqual([]);
    });
  });

  describe('account deletion', () => {
    it("removes the account's report content through the foreign key and keeps the header for counting", async () => {
      await resetReports(su);
      const id = await seedReport(su, { userId: users.leaving.id });
      await su.query('DELETE FROM public.users WHERE id = $1', [users.leaving.id]);
      expect((await su.query('SELECT 1 FROM public.problem_report_contents WHERE report_id = $1', [id])).rows).toEqual([]);
      expect((await su.query<{ verified: boolean }>('SELECT verified FROM public.problem_reports WHERE id = $1', [id])).rows)
        .toEqual([{ verified: true }]);
      const detail = await withLoginClient('jale_admin_console', async (c) =>
        (await c.query<{ content_erased: boolean; description: string | null; contact_kind: string }>(
          'SELECT content_erased, description, contact_kind FROM jale_cap.problem_report_detail($1)', [id],
        )).rows);
      expect(detail).toEqual([{ content_erased: true, description: null, contact_kind: 'none' }]);
    });
  });

  describe('function reach', () => {
    /** Definers anywhere, plus every function in a jale_* schema, that `login` may execute. */
    async function reachable(login: string): Promise<string[]> {
      const { rows } = await su.query<{ fn: string }>(
        `SELECT p.oid::regprocedure::text AS fn
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND (p.prosecdef OR n.nspname LIKE 'jale\\_%')
            AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE')
          ORDER BY 1`,
        [login],
      );
      return rows.map((r) => r.fn);
    }

    it('the signed-out intake login reaches its five report functions and no other definer', async () => {
      expect(await reachable('jale_api_public_reports')).toEqual(PUBLIC_REPORT_FUNCTIONS);
    });

    it('the clean-up login reaches the clean-up function and no other definer', async () => {
      expect(await reachable('jale_job_report_cleanup')).toEqual(['jale_cap.problem_report_cleanup(integer)']);
    });

    it('neither login has USAGE on any schema but public and jale_cap', async () => {
      for (const login of ['jale_api_public_reports', 'jale_job_report_cleanup']) {
        const { rows } = await su.query<{ name: string }>(
          `SELECT n.nspname AS name FROM pg_catalog.pg_namespace n
            WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
              AND pg_catalog.has_schema_privilege($1, n.oid, 'USAGE')
            ORDER BY 1`,
          [login],
        );
        expect({ login, schemas: rows.map((r) => r.name) }).toEqual({ login, schemas: ['jale_cap', 'public'] });
      }
    });

    it('a call outside its own functions is refused for each report login', async () => {
      const calls: Array<[string, string]> = [
        ['jale_api_public_reports', 'SELECT * FROM jale_cap.problem_report_counts()'],
        ['jale_api_public_reports', 'SELECT * FROM jale_cap.problem_report_cleanup(1)'],
        ['jale_api_public_reports', `SELECT * FROM jale_cap.problem_report_create_verified('${randomUUID()}', 'worker', 'other', 'x', NULL, 'en', true, '{}', '${tokenHash()}')`],
        ['jale_api_public_reports', "SELECT jale_cap.problem_report_mask_email('x')"],
        ['jale_job_report_cleanup', 'SELECT * FROM jale_cap.problem_report_config()'],
        ['jale_job_report_cleanup', 'SELECT * FROM jale_cap.problem_report_settings_get()'],
        ['jale_api', 'SELECT * FROM jale_cap.problem_report_config()'],
        ['jale_api', 'SELECT * FROM jale_cap.problem_report_inbox(NULL, NULL, NULL, NULL, NULL, 10, NULL)'],
        ['jale_admin_console', `SELECT jale_cap.problem_report_enqueue_team_email('${randomUUID()}')`],
        ['jale_admin_console', 'SELECT * FROM jale_cap.problem_report_cleanup(1)'],
      ];
      const outcomes: string[] = [];
      for (const [login, sql] of calls) {
        outcomes.push(`${login}: ${await withLoginClient(login, (c) => sqlState(() => c.query(sql)))}`);
      }
      expect(outcomes).toEqual(calls.map(([login]) => `${login}: 42501`));
    });
  });
});
