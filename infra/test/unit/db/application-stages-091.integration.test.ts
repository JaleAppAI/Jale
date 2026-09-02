/**
 * application-stages-091.integration.test.ts
 *
 * Real-PostgreSQL contract for migration 091_application_stages.sql. Nothing
 * here can be covered by a mocked pool, for the same reason the rest of
 * scripts/run-whatsapp-v2-db-tests.sh exists: a mocked pool has no planner,
 * no policies and no triggers.
 *
 * Specifically:
 *
 *  - The hire gate (`enforce_job_application_hire_requirements`) is
 *    deliberately NOT SECURITY DEFINER. It reads `jobs` and `worker_documents`
 *    under the CALLER's RLS, which is the whole point: an employer session
 *    cannot see vault (`job_id IS NULL`) documents at all (018's
 *    worker_documents_employer_select requires `job_id IS NOT NULL`), so the
 *    gate must count job-scoped snapshot rows only. Only a real database with
 *    real policies can distinguish "the gate ignored a doc that exists" from
 *    "there was no doc".
 *
 *  - The jale_whatsapp column grants are column-scoped on top of 028's
 *    row-scoped `jobapp_whatsapp_update` policy. BOTH must line up, and
 *    `details_requested_at` is withheld on purpose. A mocked pool would let
 *    every one of those writes through.
 *
 *  - `jobs_pre_application_prompts_valid` delegates to an IMMUTABLE SQL
 *    function; its per-entry rules (exact keys, id pattern, 1..500 chars,
 *    distinct ids) live in SQL, not in TypeScript.
 *
 * ── ON THE `job_unreadable` BRANCH ──────────────────────────────────
 * 091's gate raises 23514 with `reason: job_unreadable` when its `jobs`
 * SELECT returns no row. That branch is NOT exercised here because it is
 * structurally unreachable for both roles that can attempt a hire:
 *   * jale_admin (employer): `applications_employer_update`'s USING clause is
 *     `job_id IN (SELECT id FROM jobs WHERE employer_id = <me>)` -- the very
 *     same subquery the gate runs. An unreadable job means an unreachable
 *     application row, so the UPDATE affects 0 rows and the trigger never
 *     fires (asserted below as the cross-employer case).
 *   * jale_whatsapp: 004's `jobs_read_wa` is `USING (true)`, so every job row
 *     is readable.
 * The branch is a fail-closed backstop for a future role, and it is pinned by
 * 091's own DO block (prosrc must contain `job_unreadable`) plus the literal
 * assertion in migrations.test.ts. Reaching it from a test would require
 * creating a cluster-wide role or dropping a shipped policy, neither of which
 * a disposable-testbed suite may do.
 *
 * Fixture/role-switching pattern copied from
 * whatsapp-application-fill-080.integration.test.ts and
 * web-onboarding-hostile-inputs.integration.test.ts: one Client per logical
 * operation, BEGIN, `SET LOCAL ROLE <role>` (transaction-scoped, reverts at
 * COMMIT/ROLLBACK), assertions, then COMMIT or ROLLBACK. The connecting URL
 * must be a SUPERUSER (the fail-closed runner checks this) so fixtures can be
 * inserted past FORCE RLS.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: migration 091 PostgreSQL gate was not run', () => {
    console.warn(
      '[application-stages-091] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped',
    );
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const HIRE_CONSTRAINT = 'job_applications_hire_requirements_check';

interface HireGateDetail {
  fields: string[];
  docs: string[];
  certifications: string[];
  reason?: string;
}

maybeDescribe('migration 091 application-stages DB contract', () => {
  let setup: Client;

  const employerId = randomUUID();
  const employerSub = `s23-employer-${employerId}`;
  const otherEmployerId = randomUUID();
  const otherEmployerSub = `s23-other-employer-${otherEmployerId}`;

  // One worker per scenario so no test can be perturbed by another's writes.
  const workerGuardWa = randomUUID();
  const workerGuardAdmin = randomUUID();
  const workerHire = randomUUID();
  const workerVault = randomUUID();
  const workerNoop = randomUUID();
  const workerWaHire = randomUUID();
  const workerPrompt = randomUUID();
  const workerOther = randomUUID();
  const workerDefaults = randomUUID();
  const workerDefaultsOther = randomUUID();

  const workerIds = [
    workerGuardWa, workerGuardAdmin, workerHire, workerVault, workerNoop,
    workerWaHire, workerPrompt, workerOther, workerDefaults, workerDefaultsOther,
  ];
  const workerSub = (id: string) => `s23-worker-${id}`;

  const jobPlain = randomUUID();
  const jobDocsRequired = randomUUID();
  const jobHire = randomUUID();
  const jobVault = randomUUID();
  const jobNoop = randomUUID();
  const jobWaHire = randomUUID();
  const jobPublic = randomUUID();
  const jobPrompts = randomUUID();
  const jobOtherEmployer = randomUUID();

  const jobIds = [
    jobPlain, jobDocsRequired, jobHire, jobVault, jobNoop, jobWaHire,
    jobPublic, jobPrompts, jobOtherEmployer,
  ];

  const appStatus = randomUUID();
  const appHire = randomUUID();
  const appVault = randomUUID();
  const appNoop = randomUUID();
  const appWaHire = randomUUID();
  const appPrompt = randomUUID();
  const appOther = randomUUID();
  const appCrossEmployer = randomUUID();

  // Part (g)'s Nova -> Haiku trade_questions cache purge.
  const tradeNova = `s23-nova-${randomUUID()}`;
  const tradeNovaSeeded = `s23-seeded-${randomUUID()}`;
  const tradeHaiku = `s23-haiku-${randomUUID()}`;
  const tradeUnknownModel = `s23-unknown-${randomUUID()}`;
  const tradeKeys = [tradeNova, tradeNovaSeeded, tradeHaiku, tradeUnknownModel];

  // ── session helpers ────────────────────────────────────────────
  async function connectAs(role: string): Promise<Client> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    return client;
  }

  /** WhatsApp / web stage-2 door: jale_whatsapp + the INTERNAL users.id GUC. */
  async function connectAsWhatsapp(workerId: string): Promise<Client> {
    const client = await connectAs('jale_whatsapp');
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);
    return client;
  }

  /** Web session: jale_admin + the COGNITO-sub GUC (employer or worker). */
  async function connectAsWebUser(sub: string): Promise<Client> {
    const client = await connectAs('jale_admin');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [sub]);
    return client;
  }

  async function close(client: Client, commit: boolean): Promise<void> {
    await client.query(commit ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
    await client.end();
  }

  /** Attempt the hire as an employer web session; return the raised error. */
  async function attemptHire(applicationId: string, sub = employerSub): Promise<{
    code?: string; constraint?: string; detail?: string; rowCount?: number | null;
  }> {
    const client = await connectAsWebUser(sub);
    try {
      const result = await client.query(
        `UPDATE job_applications SET status = 'hired', updated_at = now() WHERE id = $1`,
        [applicationId],
      );
      await close(client, false);
      return { rowCount: result.rowCount };
    } catch (error: any) {
      await close(client, false);
      return { code: error?.code, constraint: error?.constraint, detail: error?.detail };
    }
  }

  function parseDetail(detail: string | undefined): HireGateDetail {
    expect(typeof detail).toBe('string');
    return JSON.parse(detail as string) as HireGateDetail;
  }

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();

    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       VALUES ($1, $2, 'employer'), ($3, $4, 'employer')`,
      [employerId, employerSub, otherEmployerId, otherEmployerSub],
    );
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       SELECT id, 's23-worker-' || id::text, 'worker' FROM unnest($1::uuid[]) AS id`,
      [workerIds],
    );

    // number_of_workers_needed = 5 everywhere so 023's hired-count sync never
    // flips a job to 'filled' mid-suite (it recounts and compares against the
    // headcount on every status change).
    await setup.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status,
                         number_of_workers_needed, required_fields, required_docs,
                         certification_requirements)
       VALUES
         ($1, $10, 'S23 plain',      'Austin', 'full-time', 'active', 5, '{}', '{}', NULL),
         ($2, $10, 'S23 docs',       'Austin', 'full-time', 'active', 5, '{}', '{resume}', NULL),
         ($3, $10, 'S23 hire gate',  'Austin', 'full-time', 'active', 5,
            '{home_address,date_available}', '{resume,ssn}', $11::jsonb),
         ($4, $10, 'S23 vault only', 'Austin', 'full-time', 'active', 5, '{}', '{driver_license}', NULL),
         ($5, $10, 'S23 no-op',      'Austin', 'full-time', 'active', 5, '{home_address}', '{}', NULL),
         ($6, $10, 'S23 wa hire',    'Austin', 'full-time', 'active', 5, '{home_address}', '{}', NULL),
         ($7, $10, 'S23 public',     'Austin', 'full-time', 'active', 5, '{}', '{}', NULL),
         ($8, $10, 'S23 prompts',    'Austin', 'full-time', 'active', 5, '{}', '{}', NULL),
         ($9, $12, 'S23 other emp',  'Austin', 'full-time', 'active', 5, '{}', '{}', NULL)`,
      [
        jobPlain, jobDocsRequired, jobHire, jobVault, jobNoop, jobWaHire,
        jobPublic, jobPrompts, jobOtherEmployer, employerId,
        JSON.stringify([
          // required, no proof needed -> a bare has=true satisfies it.
          { name: 'OSHA 10', tier: 'required', proof_required: false },
          // required + proof -> has=true is not enough; doc_ids must be non-empty.
          { name: 'Forklift', tier: 'required', proof_required: true },
          // optional NEVER blocks, even with proof_required (certification-claims.ts).
          { name: 'CPR', tier: 'optional', proof_required: true },
        ]),
        otherEmployerId,
      ],
    );

    await setup.query(
      `UPDATE jobs SET public_listing_enabled = true,
                       pre_application_prompts = $2::jsonb
        WHERE id = $1`,
      [jobPublic, JSON.stringify([{ id: 'why-you', text: '¿Por qué te interesa este trabajo?' }])],
    );

    // Applications. INSERTs never fire the hire trigger (BEFORE UPDATE OF
    // status only), so an intentionally-incomplete 'hired' row can be seeded
    // directly -- which is exactly what the hired -> hired no-op case needs.
    await setup.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status, application_answers)
       VALUES
         ($1, $9,  $10, 'pending',  '{}'::jsonb),
         ($2, $11, $12, 'talking',  '{}'::jsonb),
         ($3, $13, $14, 'talking',  '{}'::jsonb),
         ($4, $15, $16, 'hired',    '{}'::jsonb),
         ($5, $17, $18, 'talking',  '{}'::jsonb),
         ($6, $19, $20, 'pending',  '{}'::jsonb),
         ($7, $19, $21, 'pending',  '{}'::jsonb),
         ($8, $22, $23, 'talking',  '{}'::jsonb)`,
      [
        appStatus, appHire, appVault, appNoop, appWaHire, appPrompt, appOther, appCrossEmployer,
        jobPlain, workerGuardAdmin,
        jobHire, workerHire,
        jobVault, workerVault,
        jobNoop, workerNoop,
        jobWaHire, workerWaHire,
        jobPlain, workerPrompt, workerOther,
        jobOtherEmployer, workerDefaults,
      ],
    );
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    await setup.query('DELETE FROM trade_questions WHERE profession_key = ANY($1::text[])', [tradeKeys]);
    await setup.query('DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])', [workerIds]);
    await setup.query('DELETE FROM worker_application_defaults WHERE worker_id = ANY($1::uuid[])', [workerIds]);
    await setup.query(
      'DELETE FROM job_applications WHERE worker_id = ANY($1::uuid[]) OR job_id = ANY($2::uuid[])',
      [workerIds, jobIds],
    );
    await setup.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    await setup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [employerId, otherEmployerId, ...workerIds],
    ]);
    await setup.end();
  });

  // ── (1) the widened status CHECK ───────────────────────────────
  it('job_applications_status_check admits details_requested and still rejects reviewed', async () => {
    const admitted = await setup.query(
      `UPDATE job_applications SET status = 'details_requested', updated_at = now()
        WHERE id = $1 RETURNING status`,
      [appStatus],
    );
    expect(admitted.rows).toEqual([{ status: 'details_requested' }]);

    // 024 collapsed 'reviewed' into 'contacted' and the domain has never
    // re-admitted it; 091 widens the CHECK without reopening the old values.
    await expect(setup.query(
      `UPDATE job_applications SET status = 'reviewed' WHERE id = $1`,
      [appStatus],
    )).rejects.toMatchObject({ code: '23514', constraint: 'job_applications_status_check' });

    // Restore, so the row is a normal pending application for later reads.
    await setup.query(
      `UPDATE job_applications SET status = 'pending' WHERE id = $1`,
      [appStatus],
    );
  });

  // ── (2) the 022/080 INSERT guard is gone on BOTH roles ─────────
  it('a doc-less application INSERT succeeds with NO GUC as jale_whatsapp (022/080 guard retired)', async () => {
    // Before 091 this raised 23514/job_applications_required_docs_check unless
    // the caller first set app.allow_incomplete_docs -- see the 080 suite's
    // former GUC cases. Stage 1 collects nothing, so every apply is
    // incomplete by design and the guard had to go.
    const client = await connectAsWhatsapp(workerGuardWa);
    try {
      const inserted = await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
         VALUES ($1, $2, 'pending', '{}'::jsonb)
         RETURNING id, prompt_answers, details_requested_at, details_completed_at`,
        [jobDocsRequired, workerGuardWa],
      );
      expect(inserted.rows).toHaveLength(1);
      // 091's defaults land on the new row without the caller naming them.
      expect(inserted.rows[0].prompt_answers).toEqual({});
      expect(inserted.rows[0].details_requested_at).toBeNull();
      expect(inserted.rows[0].details_completed_at).toBeNull();
      await close(client, true);
    } catch (error) {
      await close(client, false);
      throw error;
    }

    const persisted = await setup.query<{ count: string }>(
      `SELECT count(*) FROM job_applications WHERE worker_id = $1 AND job_id = $2`,
      [workerGuardWa, jobDocsRequired],
    );
    expect(persisted.rows).toEqual([{ count: '1' }]);

    // The trigger really is gone -- not merely bypassed by some ambient GUC.
    const trg = await setup.query<{ count: string }>(
      `SELECT count(*) FROM pg_trigger
        WHERE tgname = 'job_applications_required_docs_guard'
          AND tgrelid = 'public.job_applications'::regclass
          AND NOT tgisinternal`,
    );
    expect(trg.rows).toEqual([{ count: '0' }]);
  });

  it('a doc-less application INSERT succeeds with NO GUC as jale_admin under a worker web session', async () => {
    // The web apply path: jale_admin + app.current_user_id, gated by 003's
    // applications_worker_insert WITH CHECK. Proves the retired guard was a
    // table-wide trigger, not a per-role one.
    const client = await connectAsWebUser(workerSub(workerGuardAdmin));
    try {
      const inserted = await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
         VALUES ($1, $2, 'pending', '{}'::jsonb)
         RETURNING id`,
        [jobDocsRequired, workerGuardAdmin],
      );
      expect(inserted.rows).toHaveLength(1);
      await close(client, true);
    } catch (error) {
      await close(client, false);
      throw error;
    }

    const persisted = await setup.query<{ count: string }>(
      `SELECT count(*) FROM job_applications WHERE worker_id = $1 AND job_id = $2`,
      [workerGuardAdmin, jobDocsRequired],
    );
    expect(persisted.rows).toEqual([{ count: '1' }]);
  });

  // ── (3) the hire gate matrix ───────────────────────────────────
  it('hire is blocked with every missing requirement enumerated in the DETAIL JSON', async () => {
    const failure = await attemptHire(appHire);

    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe(HIRE_CONSTRAINT);

    const detail = parseDetail(failure.detail);
    // Both required fields, sorted.
    expect(detail.fields).toEqual(['date_available', 'home_address']);
    // 'resume' is missing; legacy 'ssn' is on the job's required_docs and is
    // deliberately skipped -- no worker can supply one since 032/073.
    expect(detail.docs).toEqual(['resume']);
    expect(detail.docs).not.toContain('ssn');
    // Both REQUIRED-tier certs are unclaimed. The optional 'CPR' (which even
    // sets proof_required) must never appear.
    expect(detail.certifications).toEqual(['Forklift', 'OSHA 10']);
    expect(detail.certifications).not.toContain('CPR');
    expect(detail.reason).toBeUndefined();

    // A blocked hire is a rolled-back transaction, not a partial write.
    const unchanged = await setup.query<{ status: string }>(
      `SELECT status FROM job_applications WHERE id = $1`,
      [appHire],
    );
    expect(unchanged.rows).toEqual([{ status: 'talking' }]);
  });

  it('a claimed-but-unproven required certification still blocks the hire', async () => {
    // has=true satisfies 'OSHA 10' (proof_required false) but NOT 'Forklift'
    // (proof_required true) while doc_ids is empty. One field is now answered,
    // the doc is still missing -- so the DETAIL narrows on all three axes at
    // once, which an always-the-same-arrays bug could not fake.
    await setup.query(
      `UPDATE job_applications SET application_answers = $2::jsonb WHERE id = $1`,
      [appHire, JSON.stringify({
        home_address: '1 Main St',
        certifications: [
          { name: 'OSHA 10', has: true },
          { name: 'Forklift', has: true, doc_ids: [] },
        ],
      })],
    );

    const failure = await attemptHire(appHire);
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe(HIRE_CONSTRAINT);

    const detail = parseDetail(failure.detail);
    expect(detail.fields).toEqual(['date_available']);
    expect(detail.docs).toEqual(['resume']);
    expect(detail.certifications).toEqual(['Forklift']);
  });

  it('hire succeeds once every field, the job-scoped doc and every required claim are present', async () => {
    const proofDoc = randomUUID();
    await setup.query(
      `INSERT INTO worker_documents (id, worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
       VALUES ($1, $2, $3, 'certification_doc', 's23-forklift', 'forklift.pdf', 100, 'application/pdf', 'Forklift')`,
      [proofDoc, workerHire, jobHire],
    );
    // The required 'resume' as a JOB-SCOPED snapshot row -- what
    // copyRequiredDocumentSnapshots produces, and the only shape an employer
    // session can see (018).
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, $2, 'resume', 's23-resume', 'resume.pdf', 100, 'application/pdf')`,
      [workerHire, jobHire],
    );
    await setup.query(
      `UPDATE job_applications SET application_answers = $2::jsonb WHERE id = $1`,
      [appHire, JSON.stringify({
        home_address: '1 Main St',
        date_available: '2026-09-15',
        certifications: [
          { name: 'OSHA 10', has: true },
          { name: 'Forklift', has: true, doc_ids: [proofDoc] },
        ],
      })],
    );

    const result = await attemptHire(appHire);
    expect(result.code).toBeUndefined();
    expect(result.rowCount).toBe(1);

    // attemptHire rolls back on purpose (so the fixture stays reusable), so
    // the committed row is still 'talking'. Re-run inside a committing session
    // to prove the AFTER-trigger cascade also survives the gate.
    const client = await connectAsWebUser(employerSub);
    try {
      const updated = await client.query<{ status: string }>(
        `UPDATE job_applications SET status = 'hired', updated_at = now()
          WHERE id = $1 RETURNING status`,
        [appHire],
      );
      expect(updated.rows).toEqual([{ status: 'hired' }]);
      await close(client, true);
    } catch (error) {
      await close(client, false);
      throw error;
    }

    const hired = await setup.query<{ status: string; workers_hired: number }>(
      `SELECT ja.status, j.workers_hired
         FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
        WHERE ja.id = $1`,
      [appHire],
    );
    expect(hired.rows).toEqual([{ status: 'hired', workers_hired: 1 }]);
  });

  it('a vault-only (job_id NULL) document does NOT satisfy the hire gate', async () => {
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, NULL, 'driver_license', 's23-vault-dl', 'dl.pdf', 100, 'application/pdf')`,
      [workerVault],
    );

    // Discriminating precondition: the document really exists (the superuser
    // sees it), so a 23514 below proves the gate IGNORED a present doc rather
    // than there being none. 022's predicate accepted `job_id IS NULL`; 091's
    // must not, because an employer session cannot see such a row at all.
    const vaultRows = await setup.query<{ count: string }>(
      `SELECT count(*) FROM worker_documents
        WHERE worker_id = $1 AND job_id IS NULL AND doc_type = 'driver_license'`,
      [workerVault],
    );
    expect(vaultRows.rows).toEqual([{ count: '1' }]);

    const failure = await attemptHire(appVault);
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe(HIRE_CONSTRAINT);
    expect(parseDetail(failure.detail).docs).toEqual(['driver_license']);

    // Copying the same file into the job slot -- the snapshot the engine takes
    // on every stage-2 read/write -- is what actually clears the gate.
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, $2, 'driver_license', 's23-vault-dl', 'dl.pdf', 100, 'application/pdf')`,
      [workerVault, jobVault],
    );
    const cleared = await attemptHire(appVault);
    expect(cleared.code).toBeUndefined();
    expect(cleared.rowCount).toBe(1);
  });

  it('hired -> hired is a no-op that passes even on an incomplete application, and hired -> talking -> hired re-fires the gate', async () => {
    // appNoop was seeded 'hired' with empty answers on a job that requires
    // home_address, so it is deliberately incomplete. The WHEN clause
    // (OLD.status IS DISTINCT FROM 'hired') is the only thing that keeps this
    // rewrite from raising -- without it, every employer PATCH that re-sends
    // the current status would 409.
    const noop = await attemptHire(appNoop);
    expect(noop.code).toBeUndefined();
    expect(noop.rowCount).toBe(1);

    // Now move it off 'hired' and back. The second transition must raise.
    const client = await connectAsWebUser(employerSub);
    try {
      const back = await client.query<{ status: string }>(
        `UPDATE job_applications SET status = 'talking', updated_at = now()
          WHERE id = $1 RETURNING status`,
        [appNoop],
      );
      expect(back.rows).toEqual([{ status: 'talking' }]);
      await close(client, true);
    } catch (error) {
      await close(client, false);
      throw error;
    }

    const refired = await attemptHire(appNoop);
    expect(refired.code).toBe('23514');
    expect(refired.constraint).toBe(HIRE_CONSTRAINT);
    expect(parseDetail(refired.detail).fields).toEqual(['home_address']);
  });

  it('the gate also blocks a jale_whatsapp session hiring its own worker (invoker rights, not employer-only)', async () => {
    // 028 grants jale_whatsapp UPDATE (status, updated_at) row-scoped to its
    // own worker, so a worker-driven session could otherwise self-hire past
    // every requirement. The gate is table-wide, not employer-path-only.
    const client = await connectAsWhatsapp(workerWaHire);
    let caught: { code?: string; constraint?: string; detail?: string } | undefined;
    try {
      await client.query(
        `UPDATE job_applications SET status = 'hired', updated_at = now() WHERE id = $1`,
        [appWaHire],
      );
    } catch (error: any) {
      caught = { code: error?.code, constraint: error?.constraint, detail: error?.detail };
    }
    await close(client, false);

    expect(caught?.code).toBe('23514');
    expect(caught?.constraint).toBe(HIRE_CONSTRAINT);
    expect(parseDetail(caught?.detail).fields).toEqual(['home_address']);
  });

  it('a cross-employer hire attempt is filtered to 0 rows by RLS before the gate ever runs', async () => {
    // The other employer's session cannot reach the row at all: 003/045's
    // applications_employer_update USING clause is the same jobs subquery the
    // gate would run, which is why the gate's fail-closed job_unreadable
    // branch is unreachable from this role (see the file header).
    const attempt = await attemptHire(appCrossEmployer, employerSub);
    expect(attempt.code).toBeUndefined();
    expect(attempt.rowCount).toBe(0);
  });

  // ── (4) jale_whatsapp column grants ────────────────────────────
  it('jale_whatsapp can UPDATE prompt_answers and details_completed_at for its own worker only', async () => {
    const own = await connectAsWhatsapp(workerPrompt);
    try {
      const updated = await own.query(
        `UPDATE job_applications
            SET prompt_answers = $2::jsonb, details_completed_at = now(), updated_at = now()
          WHERE id = $1 AND worker_id = $3
          RETURNING prompt_answers, details_completed_at IS NOT NULL AS completed`,
        [appPrompt, JSON.stringify({ 'why-you': 'Tengo cinco años de experiencia.' }), workerPrompt],
      );
      expect(updated.rows).toEqual([{
        prompt_answers: { 'why-you': 'Tengo cinco años de experiencia.' },
        completed: true,
      }]);
      await close(own, true);
    } catch (error) {
      await close(own, false);
      throw error;
    }

    // Cross-worker: 028's jobapp_whatsapp_update row-scopes the UPDATE, so
    // this is a silent 0-row filter rather than an error.
    const cross = await connectAsWhatsapp(workerPrompt);
    try {
      const blocked = await cross.query(
        `UPDATE job_applications SET prompt_answers = $2::jsonb WHERE id = $1`,
        [appOther, JSON.stringify({ 'why-you': 'hostile' })],
      );
      expect(blocked.rowCount).toBe(0);
    } finally {
      await close(cross, false);
    }

    const untouched = await setup.query(
      `SELECT prompt_answers FROM job_applications WHERE id = $1`,
      [appOther],
    );
    expect(untouched.rows).toEqual([{ prompt_answers: {} }]);
  });

  it('jale_whatsapp cannot UPDATE details_requested_at (column grant withheld, 42501)', async () => {
    // The identity GUC is set to THIS row's own worker, so
    // jobapp_whatsapp_update's row-scoping is satisfied and the rejection is
    // provably the missing column grant, not RLS filtering the row out first
    // (the 080 suite's `job_id` negative control makes the same point).
    const client = await connectAsWhatsapp(workerPrompt);
    try {
      await expect(client.query(
        `UPDATE job_applications SET details_requested_at = now() WHERE id = $1`,
        [appPrompt],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await close(client, false);
    }

    const stillNull = await setup.query<{ details_requested_at: Date | null }>(
      `SELECT details_requested_at FROM job_applications WHERE id = $1`,
      [appPrompt],
    );
    expect(stillNull.rows[0].details_requested_at).toBeNull();
  });

  // ── (5) write-once prompt-answer merge ─────────────────────────
  it('the write-once merge $1::jsonb || prompt_answers keeps the value already stored', async () => {
    // Operand order is the whole contract: the RIGHT side of || wins on a key
    // collision, so the existing answer survives and only new keys land.
    const client = await connectAsWhatsapp(workerPrompt);
    try {
      const merged = await client.query(
        `UPDATE job_applications
            SET prompt_answers = $2::jsonb || prompt_answers, updated_at = now()
          WHERE id = $1 AND worker_id = $3
          RETURNING prompt_answers`,
        [
          appPrompt,
          JSON.stringify({ 'why-you': 'OVERWRITE ATTEMPT', 'when-start': 'La próxima semana' }),
          workerPrompt,
        ],
      );
      expect(merged.rows).toEqual([{
        prompt_answers: {
          'why-you': 'Tengo cinco años de experiencia.',
          'when-start': 'La próxima semana',
        },
      }]);
      await close(client, true);
    } catch (error) {
      await close(client, false);
      throw error;
    }
  });

  // ── (6) the prompts CHECK ──────────────────────────────────────
  it('jobs_pre_application_prompts_valid rejects every malformed prompt array and accepts the empty one', async () => {
    const setPrompts = (value: unknown) => setup.query(
      `UPDATE jobs SET pre_application_prompts = $2::jsonb WHERE id = $1`,
      [jobPrompts, JSON.stringify(value)],
    );
    const reject = async (label: string, value: unknown) => {
      await expect(setPrompts(value)).rejects.toMatchObject({
        code: '23514',
        constraint: 'jobs_pre_application_prompts_valid',
      });
      expect(label).toBeTruthy();
    };

    const prompt = (n: number) => ({ id: `p${n}`, text: `Pregunta ${n}` });

    // 11 items: one past the cap.
    await reject('11 prompts', Array.from({ length: 11 }, (_, i) => prompt(i)));
    // 501 characters: one past the text cap (chars, not bytes).
    await reject('501-char text', [{ id: 'p1', text: 'a'.repeat(501) }]);
    // Missing id / missing text: the exact-two-keys rule catches both.
    await reject('missing id', [{ text: 'Pregunta' }]);
    await reject('missing text', [{ id: 'p1' }]);
    // Duplicate ids would make one answer unaddressable in prompt_answers.
    await reject('duplicate ids', [{ id: 'dup', text: 'Uno' }, { id: 'dup', text: 'Dos' }]);
    // Any extra key is rejected -- the shape is exact, not "at least".
    await reject('extra key', [{ id: 'p1', text: 'Pregunta', required: true }]);
    // Boundary/shape negatives around the same validator.
    await reject('empty text', [{ id: 'p1', text: '' }]);
    await reject('id with a forbidden character', [{ id: 'p 1', text: 'Pregunta' }]);
    await reject('41-char id', [{ id: 'a'.repeat(41), text: 'Pregunta' }]);
    await reject('non-string text', [{ id: 'p1', text: 42 }]);
    await reject('object instead of array', { id: 'p1', text: 'Pregunta' });
    await reject('array of strings', ['Pregunta']);

    // The empty array is the column default and must stay valid.
    await expect(setPrompts([])).resolves.toMatchObject({ rowCount: 1 });

    // And the two boundaries that must PASS: exactly 10 prompts, and text of
    // exactly 500 characters.
    await expect(setPrompts(Array.from({ length: 10 }, (_, i) => prompt(i))))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(setPrompts([{ id: 'p_1-A', text: 'a'.repeat(500) }]))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it('job_applications_prompt_answers_valid enforces the object shape and the byte cap', async () => {
    await expect(setup.query(
      `UPDATE job_applications SET prompt_answers = $2::jsonb WHERE id = $1`,
      [appStatus, JSON.stringify(['not', 'an', 'object'])],
    )).rejects.toMatchObject({
      code: '23514', constraint: 'job_applications_prompt_answers_valid',
    });

    await expect(setup.query(
      `UPDATE job_applications SET prompt_answers = $2::jsonb WHERE id = $1`,
      [appStatus, JSON.stringify({ big: 'x'.repeat(12289) })],
    )).rejects.toMatchObject({
      code: '23514', constraint: 'job_applications_prompt_answers_valid',
    });
  });

  // ── (7) read/write grants around the new column and defaults ───
  it('jale_public_jobs can SELECT jobs.pre_application_prompts and still reaches no application data', async () => {
    const client = await connectAs('jale_public_jobs');
    try {
      // 056's jobs_public_read is USING (public_listing_enabled).
      const read = await client.query(
        `SELECT id, pre_application_prompts FROM jobs WHERE id = $1`,
        [jobPublic],
      );
      expect(read.rows).toEqual([{
        id: jobPublic,
        pre_application_prompts: [{ id: 'why-you', text: '¿Por qué te interesa este trabajo?' }],
      }]);

      // 056 grants this role nothing at all on job_applications, and 091 did
      // not change that -- prompt ANSWERS are never public.
      await expect(client.query(
        `SELECT prompt_answers FROM job_applications WHERE id = $1`,
        [appPrompt],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await close(client, false);
    }
  });

  it('jale_whatsapp can INSERT and UPDATE worker_application_defaults for its own worker only', async () => {
    // 081 granted SELECT and asserted INSERT/UPDATE were absent; 091 lifts
    // that deferral and adds the row-scoped write policy the grant needs to
    // reach any row at all under 079's FORCE RLS.
    const own = await connectAsWhatsapp(workerDefaults);
    try {
      const inserted = await own.query(
        `INSERT INTO worker_application_defaults (worker_id, answers, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (worker_id) DO UPDATE SET answers = EXCLUDED.answers, updated_at = now()
         RETURNING answers`,
        [workerDefaults, JSON.stringify({ home_address: '1 Main St' })],
      );
      expect(inserted.rows).toEqual([{ answers: { home_address: '1 Main St' } }]);

      const updated = await own.query(
        `UPDATE worker_application_defaults
            SET answers = answers || $2::jsonb, updated_at = now()
          WHERE worker_id = $1
          RETURNING answers`,
        [workerDefaults, JSON.stringify({ date_of_birth: '1990-01-01' })],
      );
      expect(updated.rows).toEqual([{
        answers: { home_address: '1 Main St', date_of_birth: '1990-01-01' },
      }]);
      await close(own, true);
    } catch (error) {
      await close(own, false);
      throw error;
    }

    // Another worker's row: pre-seed it as the superuser, then prove the
    // WhatsApp session can neither create nor modify it.
    await setup.query(
      `INSERT INTO worker_application_defaults (worker_id, answers)
       VALUES ($1, $2::jsonb)`,
      [workerDefaultsOther, JSON.stringify({ home_address: 'victim' })],
    );

    const cross = await connectAsWhatsapp(workerDefaults);
    try {
      // WITH CHECK rejects an INSERT for a foreign worker outright.
      await expect(cross.query(
        `INSERT INTO worker_application_defaults (worker_id, answers)
         VALUES ($1, $2::jsonb)`,
        [randomUUID(), JSON.stringify({ home_address: 'hostile' })],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await close(cross, false);
    }

    const crossUpdate = await connectAsWhatsapp(workerDefaults);
    try {
      // USING filters the foreign row out: silent 0 rows, no error.
      const blocked = await crossUpdate.query(
        `UPDATE worker_application_defaults SET answers = $2::jsonb WHERE worker_id = $1`,
        [workerDefaultsOther, JSON.stringify({ home_address: 'hostile' })],
      );
      expect(blocked.rowCount).toBe(0);
    } finally {
      await close(crossUpdate, false);
    }

    const victim = await setup.query(
      `SELECT answers FROM worker_application_defaults WHERE worker_id = $1`,
      [workerDefaultsOther],
    );
    expect(victim.rows).toEqual([{ answers: { home_address: 'victim' } }]);

    // No DELETE was granted, so the write policy cannot be turned into one.
    const deleter = await connectAsWhatsapp(workerDefaults);
    try {
      await expect(deleter.query(
        `DELETE FROM worker_application_defaults WHERE worker_id = $1`,
        [workerDefaults],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await close(deleter, false);
    }
  });

  it('079 worker_application_defaults_self still works for a jale_admin web session', async () => {
    // 091 only ADDED a policy. Permissive policies are OR'd, so the web lane
    // (cognito_sub via app.current_user_id) must be untouched.
    const client = await connectAsWebUser(workerSub(workerDefaults));
    try {
      const read = await client.query(
        `SELECT answers FROM worker_application_defaults WHERE worker_id = $1`,
        [workerDefaults],
      );
      expect(read.rows).toEqual([{
        answers: { home_address: '1 Main St', date_of_birth: '1990-01-01' },
      }]);

      const written = await client.query(
        `UPDATE worker_application_defaults
            SET answers = answers || $2::jsonb, updated_at = now()
          WHERE worker_id = $1
          RETURNING answers`,
        [workerDefaults, JSON.stringify({ emergency_contact: 'Ana 555-0100' })],
      );
      expect(written.rows).toEqual([{
        answers: {
          home_address: '1 Main St',
          date_of_birth: '1990-01-01',
          emergency_contact: 'Ana 555-0100',
        },
      }]);

      // Cross-worker read is still invisible on the web lane too.
      const foreign = await client.query(
        `SELECT answers FROM worker_application_defaults WHERE worker_id = $1`,
        [workerDefaultsOther],
      );
      expect(foreign.rows).toHaveLength(0);
      await close(client, true);
    } catch (error) {
      await close(client, false);
      throw error;
    }
  });

  // ── (g) the Nova -> Claude Haiku 4.5 trade_questions cache purge ──
  it('the trade_questions purge drops only the non-seeded Nova rows', async () => {
    // The migration already ran when this testbed was bootstrapped, so the
    // purge cannot be observed by applying the chain again. Instead the DELETE
    // is EXTRACTED FROM 091 ITSELF and re-executed here -- the file's own
    // statement text, not a hand-copied paraphrase that could drift from it
    // (same reason employer-worker-reads.integration.test.ts runs the
    // handlers' exported query text rather than a copy).
    const migration = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'db', 'migrations', '091_application_stages.sql'),
      'utf8',
    );
    const purge = migration.match(
      /DELETE FROM public\.trade_questions\s+WHERE is_seeded = false AND model_id LIKE '%nova%';/,
    )?.[0];
    expect(purge).toBeDefined();

    const questions = JSON.stringify([
      { q_en: 'What do you specialize in?', q_es: '¿En qué te especializas?' },
    ]);
    await setup.query(
      `INSERT INTO trade_questions (profession_key, profession_raw, questions, is_seeded, model_id)
       VALUES
         ($1, 's23 nova custom',   $5::jsonb, false, 'us.amazon.nova-lite-v1:0'),
         ($2, 's23 seeded trade',  $5::jsonb, true,  NULL),
         ($3, 's23 haiku custom',  $5::jsonb, false, 'us.anthropic.claude-haiku-4-5-20251001-v1:0'),
         ($4, 's23 unknown model', $5::jsonb, false, NULL)`,
      [tradeNova, tradeNovaSeeded, tradeHaiku, tradeUnknownModel, questions],
    );

    const deleted = await setup.query(purge as string);
    expect(deleted.rowCount).toBe(1);

    const survivors = await setup.query<{ profession_key: string }>(
      `SELECT profession_key FROM trade_questions
        WHERE profession_key = ANY($1::text[])
        ORDER BY profession_key`,
      [tradeKeys],
    );
    const keys = survivors.rows.map((r) => r.profession_key);
    // The Nova cache row is gone; the SEEDED standard-trade row survives, and
    // so do the Haiku row and the row whose model_id was never recorded
    // (NULL LIKE '%nova%' is NULL, not true -- see 091 part (g)).
    expect(keys).not.toContain(tradeNova);
    expect(keys.slice().sort()).toEqual(
      [tradeNovaSeeded, tradeHaiku, tradeUnknownModel].slice().sort(),
    );

    // And the end state 091's own DO block asserts: no non-seeded Nova rows
    // anywhere in the table.
    const remaining = await setup.query<{ count: string }>(
      `SELECT count(*) FROM trade_questions WHERE is_seeded = false AND model_id LIKE '%nova%'`,
    );
    expect(remaining.rows).toEqual([{ count: '0' }]);

    // The five hand-written seeded trades from 012 are still present -- the
    // purge must never have reached them.
    const seeded = await setup.query<{ count: string }>(
      `SELECT count(*) FROM trade_questions WHERE is_seeded = true`,
    );
    expect(Number(seeded.rows[0].count)).toBeGreaterThanOrEqual(5);
  });
});
