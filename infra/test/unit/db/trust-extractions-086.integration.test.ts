/**
 * trust-extractions-086.integration.test.ts
 *
 * PostgreSQL-backed gate for migration 086 against REAL PostgreSQL 16 with
 * the full chain 001-086 applied:
 *
 *   Part 1  worker_trust_extractions -- FORCE RLS, the four lanes
 *           (jale_ai write, worker internal-id, worker cognito-sub,
 *           employer-with-an-application), and the per-(assessment,
 *           extractor_version) uniqueness the extractor Lambda retries on.
 *   Part 2  resolve_worker_internal_id / start_web_onboarding_workflow --
 *           the web door's two SECURITY DEFINER entry points, including the
 *           app.onboarding_bind_user_id guard and idempotency.
 *   Part 3  jobs.certification_requirements default + backfill.
 *   Part 4  the five reseeded, open-ended trade_questions rows and the
 *           purge of the AI-generated (is_seeded = false) cache rows.
 *
 * Roles are assumed with SET LOCAL ROLE from one superuser connection, the
 * same approach as web-worker-whatsapp-crossover.integration.test.ts: a superuser
 * that has SET ROLE'd to a non-superuser role is subject to RLS, so this
 * exercises the policies exactly as the Lambdas hit them, with no role
 * passwords involved.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an
 * isolated, disposable database (see db/local/bootstrap-testbed.sh).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: migration 086 PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[trust-extractions-086] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 database with migrations 001-086 applied to run the ' +
        'real-PostgreSQL trust-extraction and web-onboarding gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

const migrationPath = path.join(
  __dirname, '..', '..', '..', 'db', 'migrations',
  '086_trust_extractions_and_web_onboarding.sql',
);

type Guc = { key: string; value: string };

/**
 * Runs `fn` in one transaction with `SET LOCAL ROLE <role>` and the given
 * transaction-local GUCs applied, then rolls back unless `commit` is set.
 */
async function asRole<T>(
  role: string,
  gucs: Guc[],
  fn: (client: Client) => Promise<T>,
  commit = false,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    for (const guc of gucs) {
      await client.query('SELECT set_config($1, $2, true)', [guc.key, guc.value]);
    }
    const result = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: { code?: string } | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as { code?: string };
  }
  expect(caught?.code).toBe(code);
}

maybeDescribe('migration 086: trust extractions and the web onboarding door', () => {
  const EXTRACTOR_VERSION = 'v086-test';

  let setup: Client;
  let employerRelated: string;
  let employerUnrelated: string;
  let worker: string;
  let workerOther: string;
  let workerReady: string;
  let workerFresh: string;
  let workerSuspended: string;
  let workerReadyNoRun: string;
  let workerRace: string;
  let jobId: string;
  let assessmentId: string;
  let extractionId: string;
  let readyRunId: string;

  const subs = {
    employerRelated: `t86-employer-related-${randomUUID().slice(0, 8)}`,
    employerUnrelated: `t86-employer-unrelated-${randomUUID().slice(0, 8)}`,
    worker: `t86-worker-${randomUUID().slice(0, 8)}`,
    workerOther: `t86-worker-other-${randomUUID().slice(0, 8)}`,
    workerReady: `t86-worker-ready-${randomUUID().slice(0, 8)}`,
    workerFresh: `t86-worker-fresh-${randomUUID().slice(0, 8)}`,
    workerSuspended: `t86-worker-suspended-${randomUUID().slice(0, 8)}`,
    workerReadyNoRun: `t86-worker-readynorun-${randomUUID().slice(0, 8)}`,
    workerRace: `t86-worker-race-${randomUUID().slice(0, 8)}`,
  };

  async function one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> {
    const result = await setup.query<T>(sql, params);
    return result.rows[0];
  }

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();

    const insertUser = async (sub: string, type: 'worker' | 'employer'): Promise<string> =>
      (await one<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type) VALUES ($1, $2) RETURNING id`,
        [sub, type],
      )).id;

    employerRelated = await insertUser(subs.employerRelated, 'employer');
    employerUnrelated = await insertUser(subs.employerUnrelated, 'employer');
    worker = await insertUser(subs.worker, 'worker');
    workerOther = await insertUser(subs.workerOther, 'worker');
    workerReady = await insertUser(subs.workerReady, 'worker');
    workerFresh = await insertUser(subs.workerFresh, 'worker');
    workerSuspended = await insertUser(subs.workerSuspended, 'worker');
    workerReadyNoRun = await insertUser(subs.workerReadyNoRun, 'worker');
    workerRace = await insertUser(subs.workerRace, 'worker');

    jobId = (await one<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'T86 active job', 'Austin', 'full-time', 'active') RETURNING id`,
      [employerRelated],
    )).id;
    await setup.query(
      `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending')`,
      [jobId, worker],
    );

    assessmentId = (await one<{ id: string }>(
      `INSERT INTO worker_trust_assessments (user_id, profession_key, answers, status)
       VALUES ($1, 'electrician', '[]'::jsonb, 'scored') RETURNING id`,
      [worker],
    )).id;

    // The ready/completed fixture for the idempotent web-start path.
    await setup.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle, ready_at, lifecycle_changed_at)
       VALUES ($1, 'ready', now(), now())`,
      [workerReady],
    );
    readyRunId = (await one<{ id: string }>(
      `INSERT INTO worker_workflow_runs
         (user_id, workflow_version, current_step_key, status, preferred_language, completed_at)
       VALUES ($1, 1, 'legal.review', 'completed', 'es', now()) RETURNING id`,
      [workerReady],
    )).id;

    // An operator-suspended worker, and a 'ready' worker whose run row is
    // missing (a data anomaly the function must refuse rather than paper over).
    await setup.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at)
       VALUES ($1, 'suspended', now())`,
      [workerSuspended],
    );
    await setup.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle, ready_at, lifecycle_changed_at)
       VALUES ($1, 'ready', now(), now())`,
      [workerReadyNoRun],
    );
  });

  afterAll(async () => {
    if (!setup) return;
    try {
      await setup.query(`DELETE FROM job_applications WHERE job_id = $1`, [jobId]);
      await setup.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
      // users cascades to worker_trust_assessments -> worker_trust_extractions
      // and to worker_onboarding_state / worker_workflow_runs -> transitions.
      await setup.query(
        `DELETE FROM users WHERE cognito_sub = ANY($1::text[])`,
        [Object.values(subs)],
      );
    } finally {
      await setup.end();
    }
  });

  // ── Part 1: the table itself ──────────────────────────────────────────

  it('creates worker_trust_extractions with ENABLE + FORCE row level security', async () => {
    const row = await one<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'public.worker_trust_extractions'::regclass`,
    );
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('names an explicit role on every policy (no policy applies to PUBLIC)', async () => {
    const result = await setup.query<{ policyname: string; cmd: string; roles: string[] }>(
      `SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'worker_trust_extractions'
        ORDER BY policyname`,
    );
    expect(result.rows.map((r) => r.policyname)).toEqual([
      'wte_ai_service_rows',
      'wte_employer_applicant_read',
      'wte_worker_own_internal',
      'wte_worker_own_sub',
    ]);
    for (const row of result.rows) {
      expect(row.roles).not.toContain('public');
      expect(row.roles.length).toBeGreaterThan(0);
    }
    const byName = new Map(result.rows.map((r) => [r.policyname, r]));
    expect(byName.get('wte_ai_service_rows')).toMatchObject({ cmd: 'ALL', roles: ['jale_ai'] });
    expect(byName.get('wte_worker_own_internal')).toMatchObject({ cmd: 'SELECT', roles: ['jale_admin', 'jale_whatsapp'] });
    expect(byName.get('wte_employer_applicant_read')).toMatchObject({ cmd: 'SELECT', roles: ['jale_admin'] });
    expect(byName.get('wte_worker_own_sub')).toMatchObject({ cmd: 'SELECT', roles: ['jale_admin'] });
  });

  it('lets jale_ai insert and update an extraction row', async () => {
    extractionId = await asRole('jale_ai', [], async (client) => {
      const inserted = await client.query<{ id: string; status: string; extracted: unknown }>(
        `INSERT INTO worker_trust_extractions
           (assessment_id, user_id, status, extracted, summary_en, summary_es,
            model_id, extractor_version)
         VALUES ($1, $2, 'completed',
                 '{"skills":[{"label_en":"panel work","label_es":"trabajo de tableros","source":[0]}]}'::jsonb,
                 'Panel and circuit work.', 'Trabajo de tableros y circuitos.',
                 'test-model', $3)
         RETURNING id, status, extracted`,
        [assessmentId, worker, EXTRACTOR_VERSION],
      );
      expect(inserted.rows).toHaveLength(1);

      const updated = await client.query<{ status: string }>(
        `UPDATE worker_trust_extractions SET status = 'completed', model_id = 'test-model-2'
          WHERE id = $1 RETURNING status`,
        [inserted.rows[0].id],
      );
      expect(updated.rowCount).toBe(1);
      return inserted.rows[0].id;
    }, true);

    expect(extractionId).toBeTruthy();
  });

  it('enforces one row per (assessment_id, extractor_version)', async () => {
    await expectSqlState(
      asRole('jale_ai', [], (client) =>
        client.query(
          `INSERT INTO worker_trust_extractions (assessment_id, user_id, extractor_version)
           VALUES ($1, $2, $3)`,
          [assessmentId, worker, EXTRACTOR_VERSION],
        )),
      '23505',
    );

    // A different extractor_version for the same assessment is allowed.
    await asRole('jale_ai', [], async (client) => {
      const result = await client.query(
        `INSERT INTO worker_trust_extractions (assessment_id, user_id, extractor_version)
         VALUES ($1, $2, $3) RETURNING id`,
        [assessmentId, worker, `${EXTRACTOR_VERSION}-next`],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it('refuses an extraction whose user_id does not match its assessment (composite FK)', async () => {
    await expectSqlState(
      asRole('jale_ai', [], (client) =>
        client.query(
          `INSERT INTO worker_trust_extractions (assessment_id, user_id, extractor_version)
           VALUES ($1, $2, 'mismatched')`,
          [assessmentId, workerOther],
        )),
      '23503',
    );
  });

  it('points the foreign key at (id, user_id) on worker_trust_assessments', async () => {
    const fk = await one<{ conname: string; ncols: number; parent: string }>(
      `SELECT c.conname, array_length(c.conkey, 1) AS ncols,
              c.confrelid::regclass::text AS parent
         FROM pg_constraint c
        WHERE c.conrelid = 'public.worker_trust_extractions'::regclass
          AND c.contype = 'f'
          AND c.confrelid = 'public.worker_trust_assessments'::regclass`,
    );
    expect(fk).toEqual({
      conname: 'worker_trust_extractions_assessment_fk',
      ncols: 2,
      parent: 'worker_trust_assessments',
    });
  });

  it('shows a jale_whatsapp session only its own worker rows', async () => {
    const own = await asRole(
      'jale_whatsapp',
      [{ key: 'app.current_internal_user_id', value: worker }],
      (client) => client.query<{ id: string }>('SELECT id FROM worker_trust_extractions'),
    );
    expect(own.rows.map((r) => r.id)).toEqual([extractionId]);

    const other = await asRole(
      'jale_whatsapp',
      [{ key: 'app.current_internal_user_id', value: workerOther }],
      (client) => client.query('SELECT id FROM worker_trust_extractions'),
    );
    expect(other.rows).toEqual([]);
  });

  it('shows nothing to a jale_whatsapp session with app.current_internal_user_id unset', async () => {
    const blind = await asRole('jale_whatsapp', [], (client) =>
      client.query('SELECT id FROM worker_trust_extractions'));
    expect(blind.rows).toEqual([]);
  });

  it('lets jale_admin read own rows on the internal-id lane too (mirrors 083)', async () => {
    const own = await asRole(
      'jale_admin',
      [{ key: 'app.current_internal_user_id', value: worker }],
      (client) => client.query<{ id: string }>(
        'SELECT id FROM worker_trust_extractions WHERE id = $1', [extractionId]),
    );
    expect(own.rows.map((r) => r.id)).toEqual([extractionId]);
  });

  it('shows nothing to a jale_admin session with both GUCs unset', async () => {
    const blind = await asRole('jale_admin', [], (client) =>
      client.query('SELECT id FROM worker_trust_extractions'));
    expect(blind.rows).toEqual([]);
  });

  it('refuses a jale_whatsapp INSERT into worker_trust_extractions', async () => {
    await expectSqlState(
      asRole(
        'jale_whatsapp',
        [{ key: 'app.current_internal_user_id', value: worker }],
        (client) => client.query(
          `INSERT INTO worker_trust_extractions (assessment_id, user_id, extractor_version)
           VALUES ($1, $2, 'forged')`,
          [assessmentId, worker],
        ),
      ),
      '42501',
    );
  });

  it('lets the related employer read the extraction and shows nothing to an unrelated one', async () => {
    const related = await asRole(
      'jale_admin',
      [
        { key: 'app.current_user_id', value: subs.employerRelated },
        { key: 'app.current_internal_user_id', value: employerRelated },
      ],
      (client) => client.query<{ id: string }>(
        'SELECT id FROM worker_trust_extractions WHERE user_id = $1', [worker]),
    );
    expect(related.rows.map((r) => r.id)).toContain(extractionId);

    const unrelated = await asRole(
      'jale_admin',
      [
        { key: 'app.current_user_id', value: subs.employerUnrelated },
        { key: 'app.current_internal_user_id', value: employerUnrelated },
      ],
      (client) => client.query('SELECT id FROM worker_trust_extractions WHERE user_id = $1', [worker]),
    );
    expect(unrelated.rows).toEqual([]);
  });

  it('lets the worker read its own extraction through the cognito-sub lane', async () => {
    const own = await asRole(
      'jale_admin',
      [{ key: 'app.current_user_id', value: subs.worker }],
      (client) => client.query<{ id: string }>(
        'SELECT id FROM worker_trust_extractions WHERE id = $1', [extractionId]),
    );
    expect(own.rows.map((r) => r.id)).toEqual([extractionId]);
  });

  it('grants jale_whatsapp a column-scoped read and jale_ai full write access', async () => {
    const row = await one<Record<string, boolean>>(`SELECT
      has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'SELECT') AS wa_table_select,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'extracted', 'SELECT') AS wa_extracted,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'summary_es', 'SELECT') AS wa_summary,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'error', 'SELECT') AS wa_error,
      has_column_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'model_id', 'SELECT') AS wa_model,
      has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'INSERT') AS wa_insert,
      has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'UPDATE') AS wa_update,
      has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'DELETE') AS wa_delete,
      has_table_privilege('jale_ai', 'public.worker_trust_extractions', 'SELECT') AS ai_select,
      has_table_privilege('jale_ai', 'public.worker_trust_extractions', 'INSERT') AS ai_insert,
      has_table_privilege('jale_ai', 'public.worker_trust_extractions', 'UPDATE') AS ai_update`);

    expect(row).toEqual({
      // Column-scoped, so there is deliberately no table-wide SELECT.
      wa_table_select: false,
      wa_extracted: true, wa_summary: true,
      wa_error: false, wa_model: false,
      wa_insert: false, wa_update: false, wa_delete: false,
      ai_select: true, ai_insert: true, ai_update: true,
    });
  });

  it('refuses jale_whatsapp the error and model_id columns at query time', async () => {
    await expectSqlState(
      asRole('jale_whatsapp', [{ key: 'app.current_internal_user_id', value: worker }],
        (client) => client.query('SELECT error FROM worker_trust_extractions')),
      '42501',
    );
    await expectSqlState(
      asRole('jale_whatsapp', [{ key: 'app.current_internal_user_id', value: worker }],
        (client) => client.query('SELECT model_id FROM worker_trust_extractions')),
      '42501',
    );
    // SELECT * is refused too -- readers must name their columns.
    await expectSqlState(
      asRole('jale_whatsapp', [{ key: 'app.current_internal_user_id', value: worker }],
        (client) => client.query('SELECT * FROM worker_trust_extractions')),
      '42501',
    );
  });

  // jale_admin OWNS the table, and an owner's implicit privileges cannot be
  // revoked or narrowed -- `SELECT error` as jale_admin therefore SUCCEEDS no
  // matter what is granted (verified on PostgreSQL 16), exactly as its
  // implicit INSERT/UPDATE does. What IS assertable, and what a future move of
  // the API lane onto a non-owner role would rely on, is the declared ACL in
  // pg_attribute.attacl.
  it('declares a column-scoped jale_admin grant that excludes error and model_id', async () => {
    const rows = await setup.query<{ attname: string; granted: boolean }>(
      `SELECT a.attname, COALESCE(a.attacl::text LIKE '%jale_admin=%', false) AS granted
         FROM pg_attribute a
        WHERE a.attrelid = 'public.worker_trust_extractions'::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
    );
    const granted = rows.rows.filter((r) => r.granted).map((r) => r.attname).sort();
    expect(granted).toEqual([
      'assessment_id', 'created_at', 'extracted', 'extractor_version', 'id',
      'status', 'summary_en', 'summary_es', 'updated_at', 'user_id',
    ]);
    expect(granted).not.toContain('error');
    expect(granted).not.toContain('model_id');

    // The owner really can still read them -- documented, not asserted away.
    const ownerRead = await asRole(
      'jale_admin',
      [{ key: 'app.current_internal_user_id', value: worker }],
      (client) => client.query('SELECT error, model_id FROM worker_trust_extractions'),
    );
    expect(ownerRead.rowCount).toBeGreaterThanOrEqual(0);
  });

  // jale_admin OWNS the table, so has_table_privilege() reports INSERT/UPDATE
  // for it no matter what is granted -- an owner's implicit privileges cannot
  // be revoked. What actually keeps the API lane read-only here is FORCE RLS
  // plus the deliberate absence of any INSERT/UPDATE policy for jale_admin.
  it('blocks jale_admin writes through RLS even though it owns the table', async () => {
    const owner = await one<{ owner: string }>(
      `SELECT r.rolname AS owner FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.oid = 'public.worker_trust_extractions'::regclass`);
    expect(owner.owner).toBe('jale_admin');

    await expectSqlState(
      asRole(
        'jale_admin',
        [{ key: 'app.current_user_id', value: subs.worker }],
        (client) => client.query(
          `INSERT INTO worker_trust_extractions (assessment_id, user_id, extractor_version)
           VALUES ($1, $2, 'admin-forged')`,
          [assessmentId, worker],
        ),
      ),
      '42501',
    );

    // No UPDATE policy for jale_admin: the row is simply invisible to the
    // update, so it affects zero rows rather than raising.
    const updated = await asRole(
      'jale_admin',
      [{ key: 'app.current_user_id', value: subs.worker }],
      (client) => client.query(
        `UPDATE worker_trust_extractions SET summary_en = 'tampered' WHERE id = $1`,
        [extractionId]),
    );
    expect(updated.rowCount).toBe(0);
  });

  // ── Part 2: resolve_worker_internal_id ────────────────────────────────

  it('resolves a worker cognito_sub to its internal id', async () => {
    const result = await asRole('jale_whatsapp', [], (client) =>
      client.query<{ id: string | null }>(
        'SELECT public.resolve_worker_internal_id($1) AS id', [subs.worker]));
    expect(result.rows[0].id).toBe(worker);
  });

  it('returns NULL for an unknown sub and for a non-worker', async () => {
    const unknown = await asRole('jale_whatsapp', [], (client) =>
      client.query<{ id: string | null }>(
        'SELECT public.resolve_worker_internal_id($1) AS id', ['t86-nobody-at-all']));
    expect(unknown.rows[0].id).toBeNull();

    const employer = await asRole('jale_whatsapp', [], (client) =>
      client.query<{ id: string | null }>(
        'SELECT public.resolve_worker_internal_id($1) AS id', [subs.employerRelated]));
    expect(employer.rows[0].id).toBeNull();
  });

  it('rejects an empty cognito_sub with 22023', async () => {
    await expectSqlState(
      asRole('jale_whatsapp', [], (client) =>
        client.query('SELECT public.resolve_worker_internal_id($1)', ['   '])),
      '22023',
    );
  });

  // ── Part 2: start_web_onboarding_workflow ─────────────────────────────
  // The function is addressed by COGNITO SUB, never by internal uuid: a
  // caller can only name an identity it already holds a sub for, which is why
  // there is no GUC "gate" to test. The old draft's
  // app.onboarding_bind_user_id check was caller-settable (app.* is
  // unreserved) and has been replaced by this signature.

  const START_SQL = 'SELECT * FROM public.start_web_onboarding_workflow($1, $2, $3)';

  interface StartRow {
    onboarding_state_id: string;
    run_id: string;
    created: boolean;
    current_step_key: string;
    preferred_language: string;
    workflow_version: number;
    lifecycle: string;
  }

  it('takes a cognito sub, not an internal id, so no caller can name another worker', async () => {
    const signature = await one<{ args: string }>(
      `SELECT pg_get_function_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'start_web_onboarding_workflow'`,
    );
    expect(signature.args).toBe(
      'p_cognito_sub text, p_preferred_language text, p_workflow_version integer');

    // Passing a uuid string where a sub is expected simply resolves nothing.
    await expectSqlState(
      asRole('jale_whatsapp', [], (client) => client.query(START_SQL, [workerFresh, 'es', 1])),
      '23503',
    );
  });

  it('rejects an unknown sub with 23503 and bad inputs with 22023', async () => {
    await expectSqlState(
      asRole('jale_whatsapp', [], (client) =>
        client.query(START_SQL, ['t86-nobody-at-all', 'es', 1])),
      '23503',
    );
    // An employer's sub resolves to NULL through resolve_worker_internal_id.
    await expectSqlState(
      asRole('jale_whatsapp', [], (client) =>
        client.query(START_SQL, [subs.employerRelated, 'es', 1])),
      '23503',
    );
    const badArgs: unknown[][] = [
      [subs.workerFresh, 'fr', 1],
      [subs.workerFresh, 'es', 0],
      ['   ', 'es', 1],
    ];
    for (const args of badArgs) {
      await expectSqlState(
        asRole('jale_whatsapp', [], (client) => client.query(START_SQL, args)),
        '22023',
      );
    }
  });

  it('creates the state, run and transition on the first call and returns the full run shape', async () => {
    const first = await asRole('jale_whatsapp', [],
      (client) => client.query<StartRow>(START_SQL, [subs.workerFresh, 'es', 3]), true);

    expect(first.rows).toHaveLength(1);
    // Item 4: everything the web Lambda needs, in one round trip.
    expect(first.rows[0]).toMatchObject({
      created: true,
      current_step_key: 'legal.review',
      preferred_language: 'es',
      workflow_version: 3,
      lifecycle: 'onboarding',
    });

    const run = await one<{
      current_step_key: string; status: string; preferred_language: string;
      workflow_version: number; lock_version: number; user_id: string;
    }>(
      `SELECT current_step_key, status, preferred_language, workflow_version, lock_version, user_id
         FROM worker_workflow_runs WHERE id = $1`,
      [first.rows[0].run_id],
    );
    expect(run).toMatchObject({
      current_step_key: 'legal.review',
      status: 'active',
      preferred_language: 'es',
      workflow_version: 3,
      lock_version: 0,
      user_id: workerFresh,
    });

    const state = await one<{ lifecycle: string; user_id: string }>(
      'SELECT lifecycle, user_id FROM worker_onboarding_state WHERE id = $1',
      [first.rows[0].onboarding_state_id],
    );
    expect(state).toEqual({ lifecycle: 'onboarding', user_id: workerFresh });

    const transitions = await setup.query<{
      from_step_key: string | null; to_step_key: string;
      inbound_message_sid: string | null; reason: string;
    }>(
      `SELECT from_step_key, to_step_key, inbound_message_sid, reason
         FROM worker_workflow_transitions WHERE run_id = $1`,
      [first.rows[0].run_id],
    );
    expect(transitions.rows).toEqual([{
      from_step_key: null, to_step_key: 'legal.review',
      inbound_message_sid: null, reason: 'web_start',
    }]);

    // Second call adopts the active run: same ids, created = false, and the
    // run's own language/version win over the new arguments.
    const second = await asRole('jale_whatsapp', [],
      (client) => client.query<StartRow>(START_SQL, [subs.workerFresh, 'en', 4]), true);
    expect(second.rows[0]).toEqual({
      onboarding_state_id: first.rows[0].onboarding_state_id,
      run_id: first.rows[0].run_id,
      created: false,
      current_step_key: 'legal.review',
      preferred_language: 'es',
      workflow_version: 3,
      lifecycle: 'onboarding',
    });

    const counts = await one<{ runs: string; transitions: string }>(
      `SELECT (SELECT count(*) FROM worker_workflow_runs WHERE user_id = $1) AS runs,
              (SELECT count(*) FROM worker_workflow_transitions t
                 JOIN worker_workflow_runs r ON r.id = t.run_id
                WHERE r.user_id = $1) AS transitions`,
      [workerFresh],
    );
    expect(counts).toEqual({ runs: '1', transitions: '1' });
  });

  it('returns the completed run for a worker already at lifecycle=ready, without creating another', async () => {
    const result = await asRole('jale_whatsapp', [],
      (client) => client.query<StartRow>(START_SQL, [subs.workerReady, 'es', 1]), true);
    expect(result.rows[0]).toMatchObject({
      run_id: readyRunId, created: false, lifecycle: 'ready',
      current_step_key: 'legal.review',
    });

    const after = await one<{ runs: string; lifecycle: string }>(
      `SELECT (SELECT count(*) FROM worker_workflow_runs WHERE user_id = $1) AS runs,
              (SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1) AS lifecycle`,
      [workerReady],
    );
    // lifecycle must NOT have been dragged back to 'onboarding'.
    expect(after).toEqual({ runs: '1', lifecycle: 'ready' });
  });

  it('refuses a suspended worker with 55000 and leaves the state alone', async () => {
    await expectSqlState(
      asRole('jale_whatsapp', [], (client) =>
        client.query(START_SQL, [subs.workerSuspended, 'es', 1])),
      '55000',
    );
    const after = await one<{ lifecycle: string; runs: string }>(
      `SELECT (SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1) AS lifecycle,
              (SELECT count(*) FROM worker_workflow_runs WHERE user_id = $1) AS runs`,
      [workerSuspended],
    );
    expect(after).toEqual({ lifecycle: 'suspended', runs: '0' });
  });

  it('refuses lifecycle=ready with no completed run (55000) rather than minting one', async () => {
    await expectSqlState(
      asRole('jale_whatsapp', [], (client) =>
        client.query(START_SQL, [subs.workerReadyNoRun, 'es', 1])),
      '55000',
    );
    const after = await one<{ runs: string; lifecycle: string }>(
      `SELECT (SELECT count(*) FROM worker_workflow_runs WHERE user_id = $1) AS runs,
              (SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1) AS lifecycle`,
      [workerReadyNoRun],
    );
    expect(after).toEqual({ runs: '0', lifecycle: 'ready' });
  });

  // The advisory lock is keyed on user_id; 047's WhatsApp bind path keys on
  // phone hash, so the two do not exclude each other. This reproduces that
  // race DETERMINISTICALLY rather than asserting on the code path: session A
  // inserts an active run and holds the transaction open, so session B's
  // in-function SELECT cannot see it, B's INSERT blocks on
  // worker_workflow_one_active, and A's COMMIT converts B's wait into the
  // unique_violation the handler is written for.
  it('adopts a run created by a concurrent WhatsApp bind instead of raising 23505', async () => {
    const a = new Client({ connectionString: databaseUrl });
    const b = new Client({ connectionString: databaseUrl });
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      const planted = await a.query<{ id: string }>(
        `INSERT INTO worker_workflow_runs
           (user_id, workflow_version, current_step_key, status, preferred_language)
         VALUES ($1, 9, 'legal.review', 'active', 'en') RETURNING id`,
        [workerRace],
      );
      const plantedRunId = planted.rows[0].id;

      await b.query('BEGIN');
      await b.query('SET LOCAL ROLE jale_whatsapp');
      // Not awaited: this blocks on the uncommitted unique index entry.
      const pending = b.query<StartRow>(START_SQL, [subs.workerRace, 'es', 2]);
      await new Promise((resolve) => setTimeout(resolve, 500));

      await a.query('COMMIT');
      const result = await pending;

      expect(result.rows[0]).toMatchObject({
        run_id: plantedRunId,
        created: false,
        preferred_language: 'en',
        workflow_version: 9,
      });
      await b.query('COMMIT');

      const runs = await one<{ count: string }>(
        'SELECT count(*)::text AS count FROM worker_workflow_runs WHERE user_id = $1',
        [workerRace]);
      expect(runs.count).toBe('1');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await a.end();
      await b.end();
    }
  });

  it('restores app.onboarding_bind_user_id and app.worker_reconcile_sub to their prior values', async () => {
    const probe = await asRole(
      'jale_whatsapp',
      [
        { key: 'app.onboarding_bind_user_id', value: 'prior-bind' },
        { key: 'app.worker_reconcile_sub', value: 'prior-sub' },
      ],
      async (client) => {
        await client.query(START_SQL, [subs.workerReady, 'es', 1]);
        return client.query<{ bind: string; sub: string }>(
          `SELECT current_setting('app.onboarding_bind_user_id', true) AS bind,
                  current_setting('app.worker_reconcile_sub', true) AS sub`);
      },
    );
    expect(probe.rows[0]).toEqual({ bind: 'prior-bind', sub: 'prior-sub' });
  });

  it('leaves both GUCs harmless (empty, not another worker) when they were unset', async () => {
    const probe = await asRole('jale_whatsapp', [], async (client) => {
      await client.query(START_SQL, [subs.workerReady, 'es', 1]);
      return client.query<{ bind: string; sub: string }>(
        `SELECT current_setting('app.onboarding_bind_user_id', true) AS bind,
                current_setting('app.worker_reconcile_sub', true) AS sub`);
    });
    // set_config cannot restore "never set"; '' matches no id and no sub.
    expect(probe.rows[0]).toEqual({ bind: '', sub: '' });
  });

  it('keeps both definers jale_admin-owned, SECURITY DEFINER, search_path-pinned and off PUBLIC', async () => {
    const result = await setup.query<{
      proname: string; owner: string; prosecdef: boolean;
      proconfig: string[] | null; public_execute: boolean; whatsapp_execute: boolean;
    }>(
      `SELECT p.proname, r.rolname AS owner, p.prosecdef, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
              has_function_privilege('jale_whatsapp', p.oid, 'EXECUTE') AS whatsapp_execute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'public'
          AND p.proname IN ('resolve_worker_internal_id', 'start_web_onboarding_workflow')
        ORDER BY p.proname`,
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.owner).toBe('jale_admin');
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(row.public_execute).toBe(false);
      expect(row.whatsapp_execute).toBe(true);
    }
  });

  // ── Part 3: jobs.certification_requirements ───────────────────────────

  it('defaults jobs.certification_requirements to an empty JSON array and leaves no NULLs', async () => {
    const def = await one<{ default_expr: string | null }>(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS default_expr
         FROM pg_attrdef d
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'public.jobs'::regclass
          AND a.attname = 'certification_requirements'`,
    );
    expect(def.default_expr).toBe("'[]'::jsonb");

    const remaining = await one<{ count: string }>(
      'SELECT count(*)::text AS count FROM jobs WHERE certification_requirements IS NULL',
    );
    expect(remaining.count).toBe('0');

    const inserted = await one<{ certification_requirements: unknown }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'T86 default probe', 'Austin', 'full-time', 'active')
       RETURNING certification_requirements`,
      [employerRelated],
    );
    expect(inserted.certification_requirements).toEqual([]);
    await setup.query(
      `DELETE FROM jobs WHERE employer_id = $1 AND title = 'T86 default probe'`,
      [employerRelated],
    );
  });

  it('backfills pre-existing NULL certification_requirements rows', () => {
    // The rows that needed backfilling were written before 086 ran, so the
    // observable end state is asserted above. This pins the statement that
    // produces it -- and, critically, that it runs inside the backfill role
    // (jobs is FORCE RLS: as plain jale_admin the UPDATE matches 0 rows,
    // which is exactly how migration 065 silently did nothing).
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('SET ROLE jale_location_backfill;');
    expect(sql).toMatch(
      /UPDATE jobs SET certification_requirements = '\[\]'::jsonb\s*\n\s*WHERE certification_requirements IS NULL;/,
    );
    expect(sql).toContain('RESET ROLE;');
    expect(sql).toContain('REVOKE UPDATE ON jobs FROM jale_location_backfill;');
    expect(sql).not.toMatch(/ALTER TABLE jobs ALTER COLUMN certification_requirements SET NOT NULL/i);
  });

  // The 065 -> 067 regression guard. Every other Part-3 assertion is
  // satisfied by an EMPTY jobs table, which is exactly the failure mode 065
  // shipped with: the UPDATE matched nothing and nobody could tell. This
  // plants a NULL row and replays the migration's own mechanism against it,
  // with a plain-jale_admin negative control proving the helper role is
  // load-bearing rather than decoration.
  it('actually updates NULL rows through the backfill role (065 -> 067 regression guard)', async () => {
    const planted = await one<{ id: string; updated_at: Date }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status, certification_requirements)
       VALUES ($1, 'T86 backfill probe', 'Austin', 'full-time', 'active', NULL)
       RETURNING id, updated_at`,
      [employerRelated],
    );

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');

      // Negative control: the migration's UPDATE as plain jale_admin. jobs is
      // FORCE RLS and no jobs policy is satisfied without app.current_user_id,
      // so this must match zero rows.
      await client.query('SET LOCAL ROLE jale_admin');
      const control = await client.query(
        `UPDATE jobs SET certification_requirements = '[]'::jsonb
          WHERE certification_requirements IS NULL`,
      );
      expect(control.rowCount).toBe(0);
      await client.query('RESET ROLE');

      // Replay the migration's mechanism verbatim.
      await client.query('GRANT SELECT, UPDATE ON jobs TO jale_location_backfill');
      await client.query(
        `CREATE POLICY jobs_cert_backfill_update ON jobs
           FOR UPDATE TO jale_location_backfill USING (true) WITH CHECK (true)`,
      );
      await client.query('ALTER TABLE jobs DISABLE TRIGGER jobs_updated_at');

      await client.query('SET LOCAL ROLE jale_location_backfill');
      const backfilled = await client.query(
        `UPDATE jobs SET certification_requirements = '[]'::jsonb
          WHERE certification_requirements IS NULL`,
      );
      expect(backfilled.rowCount).toBeGreaterThanOrEqual(1);
      await client.query('RESET ROLE');

      const after = await client.query<{ certification_requirements: unknown; updated_at: Date }>(
        'SELECT certification_requirements, updated_at FROM jobs WHERE id = $1',
        [planted.id],
      );
      expect(after.rows[0].certification_requirements).toEqual([]);
      // Disabling jobs_updated_at is what keeps a pre-077 job from looking
      // freshly edited just because it acquired its default.
      expect(after.rows[0].updated_at.getTime()).toBe(planted.updated_at.getTime());

      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
      await setup.query('DELETE FROM jobs WHERE id = $1', [planted.id]);
    }
  });

  it('leaves the one-shot backfill grant and policy revoked, and the jobs trigger enabled', async () => {
    const row = await one<{ can_update: boolean; policy_count: string; trigger_enabled: string }>(
      `SELECT has_table_privilege('jale_location_backfill', 'public.jobs', 'UPDATE') AS can_update,
              (SELECT count(*)::text FROM pg_policies
                WHERE tablename = 'jobs' AND policyname = 'jobs_cert_backfill_update') AS policy_count,
              (SELECT tgenabled FROM pg_trigger
                WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_updated_at') AS trigger_enabled`,
    );
    expect(row).toEqual({ can_update: false, policy_count: '0', trigger_enabled: 'O' });
  });

  // ── Part 4: reseeded trade_questions ──────────────────────────────────

  it('reseeds the five seeded trades with three open q_en/q_es questions each', async () => {
    const result = await setup.query<{ profession_key: string; questions: { q_en?: string; q_es?: string }[] }>(
      `SELECT profession_key, questions FROM trade_questions
        WHERE is_seeded = true
          AND profession_key IN ('electrician','plumber','carpenter','concrete','painting')
        ORDER BY profession_key`,
    );
    expect(result.rows.map((r) => r.profession_key)).toEqual([
      'carpenter', 'concrete', 'electrician', 'painting', 'plumber',
    ]);

    const forbiddenEn = /years|how long|seniority|\b[1-3]\.\s/i;
    // The seed text is deliberately ASCII (matching every migration 001-085),
    // so accented literals like /años/ could never fire. `.` stands in for the
    // accent so the guard matches BOTH spellings -- same patterns migration
    // 086's own self-audit uses. \b would not anchor "anos" inside
    // "cuentanos"/"planos", hence the explicit boundaries.
    const forbiddenEs = /(?:^|[^a-z])a.os(?![a-z])|cu.nto tiempo|antig.edad|\b[1-3]\.\s/i;

    for (const row of result.rows) {
      expect(row.questions).toHaveLength(3);
      for (const question of row.questions) {
        expect(typeof question.q_en).toBe('string');
        expect(typeof question.q_es).toBe('string');
        expect(question.q_en!.length).toBeGreaterThan(20);
        expect(question.q_es!.length).toBeGreaterThan(20);
        expect(question.q_en).not.toMatch(forbiddenEn);
        expect(question.q_es).not.toMatch(forbiddenEs);
        // Open questions, not multiple choice.
        expect(question.q_en).toMatch(/\?$/);
        expect(question.q_es).toMatch(/\?$/);
      }
    }
  });

  it('leaves no AI-generated cache row behind (Part 4 purge end state)', async () => {
    const counts = await one<{ generated: string; seeded: string }>(
      `SELECT count(*) FILTER (WHERE NOT is_seeded)::text AS generated,
              count(*) FILTER (WHERE is_seeded)::text     AS seeded
         FROM trade_questions`,
    );
    // The AI cache refills itself from the question-generator Lambda on the
    // next cache miss, so an empty non-seeded set is the correct end state.
    expect(counts).toEqual({ generated: '0', seeded: '5' });
  });

  // Same class of gap as the jobs backfill: the end-state assertion above is
  // satisfied by a table that never had a non-seeded row to begin with. This
  // plants one and replays Part 4's DELETE against it, then confirms the five
  // seeded rows are untouched collateral.
  it('deletes stale AI-generated rows while leaving the five seeded rows intact', async () => {
    const probeKey = `t86-stale-${randomUUID().slice(0, 8)}`;
    await setup.query(
      `INSERT INTO trade_questions (profession_key, profession_raw, questions, is_seeded, model_id)
       VALUES ($1, $1,
               '[{"q_en":"What is your seniority level?","q_es":"Cual es tu nivel de experiencia?"}]'::jsonb,
               false, 'us.amazon.nova-lite-v1:0')`,
      [probeKey],
    );

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM trade_questions WHERE is_seeded = false');
      expect(before.rows[0].count).toBe('1');

      const deleted = await client.query('DELETE FROM trade_questions WHERE is_seeded = false');
      expect(deleted.rowCount).toBe(1);

      const after = await client.query<{ profession_key: string; n: number }>(
        `SELECT profession_key, jsonb_array_length(questions) AS n
           FROM trade_questions ORDER BY profession_key`);
      expect(after.rows.map((r) => r.profession_key)).toEqual([
        'carpenter', 'concrete', 'electrician', 'painting', 'plumber',
      ]);
      expect(after.rows.every((r) => r.n === 3)).toBe(true);

      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
      await setup.query('DELETE FROM trade_questions WHERE profession_key = $1', [probeKey]);
    }
  });
});
