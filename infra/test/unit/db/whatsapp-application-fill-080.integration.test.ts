import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: migration 080 PostgreSQL gate was not run', () => {
    console.warn('[whatsapp-application-fill-080] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

async function setWorkerIdentity(client: Client, workerId: string): Promise<void> {
  await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);
}

// Mirrors retrigger-sweep-definer.integration.test.ts's role-switching
// pattern: one Client per logical operation, BEGIN, SET LOCAL ROLE
// jale_whatsapp (transaction-scoped -- reverts automatically at
// COMMIT/ROLLBACK), then the caller runs its assertions, commits or rolls
// back, and ends the connection.
async function connectAsWhatsapp(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE jale_whatsapp');
  return client;
}

maybeDescribe('migration 080 WhatsApp application-fill DB contract', () => {
  let setup: Client;

  const employerId = randomUUID();

  const workerOwnRow = randomUUID();
  const workerCrossTarget = randomUUID();
  const workerAnswers = randomUUID();
  const workerGuard = randomUUID();
  const workerGuardTxLocalA = randomUUID();
  const workerGuardTxLocalB = randomUUID();
  const workerNameCap = randomUUID();
  const workerTotalCap = randomUUID();
  const workerFootgun = randomUUID();
  const workerSavepoint = randomUUID();

  const workerIds = [
    workerOwnRow, workerCrossTarget, workerAnswers, workerGuard,
    workerGuardTxLocalA, workerGuardTxLocalB, workerNameCap, workerTotalCap,
    workerFootgun, workerSavepoint,
  ];

  const jobGeneralId = randomUUID();
  const jobRequireResumeId = randomUUID();
  const jobCertsId = randomUUID();
  const jobIds = [jobGeneralId, jobRequireResumeId, jobCertsId];

  const mergeApplicationId = randomUUID();

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();

    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'employer')`,
      [employerId, `t13-employer-${employerId}`],
    );
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       SELECT id, 't13-worker-' || id::text, 'worker' FROM unnest($1::uuid[]) AS id`,
      [workerIds],
    );

    await setup.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status, required_docs)
       VALUES
         ($1, $4, 'T13 general', 'Austin', 'full-time', 'active', '{}'),
         ($2, $4, 'T13 requires resume', 'Austin', 'full-time', 'active', '{resume}'),
         ($3, $4, 'T13 certs', 'Austin', 'full-time', 'active', '{}')`,
      [jobGeneralId, jobRequireResumeId, jobCertsId, employerId],
    );

    // Pre-existing row for the cross-worker RLS assertions in test 1 -- must
    // survive every other worker's attempt to touch it.
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, $2, 'resume', 'workerb-original', 'workerb-original.pdf', 100, 'application/pdf')`,
      [workerCrossTarget, jobGeneralId],
    );

    // Pre-existing application for the 073 column-grant merge test. job
    // requires no docs, so the 022 guard trigger is a no-op regardless of
    // the GUC -- no bypass needed to seed this fixture.
    await setup.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status, application_answers)
       VALUES ($1, $2, $3, 'pending', '{"home_address":"1 Main St"}'::jsonb)`,
      [mergeApplicationId, jobGeneralId, workerAnswers],
    );
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    await setup.query('DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])', [workerIds]);
    await setup.query(
      'DELETE FROM job_applications WHERE worker_id = ANY($1::uuid[]) OR job_id = ANY($2::uuid[])',
      [workerIds, jobIds],
    );
    await setup.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    await setup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[employerId, ...workerIds]]);
    await setup.end();
  });

  it('DELETE then INSERT on worker_documents succeeds for own row and fails RLS for another worker', async () => {
    // Own row: DELETE-then-INSERT (the fill's write pattern, mirroring
    // worker-doc-confirm.ts) under app.current_internal_user_id succeeds end
    // to end and the new row persists.
    const own = await connectAsWhatsapp();
    try {
      await setWorkerIdentity(own, workerOwnRow);
      await own.query(
        `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
         VALUES ($1, $2, 'resume', 'own-old-key', 'old.pdf', 100, 'application/pdf')`,
        [workerOwnRow, jobGeneralId],
      );
      const del = await own.query(
        `DELETE FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'resume'`,
        [workerOwnRow, jobGeneralId],
      );
      expect(del.rowCount).toBe(1);
      const ins = await own.query(
        `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
         VALUES ($1, $2, 'resume', 'own-new-key', 'new.pdf', 200, 'application/pdf')
         RETURNING s3_key`,
        [workerOwnRow, jobGeneralId],
      );
      expect(ins.rows).toEqual([{ s3_key: 'own-new-key' }]);
      await own.query('COMMIT');
    } catch (error) {
      await own.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await own.end();
    }
    const persisted = await setup.query(
      `SELECT s3_key FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'resume'`,
      [workerOwnRow, jobGeneralId],
    );
    expect(persisted.rows).toEqual([{ s3_key: 'own-new-key' }]);

    // Cross-worker: still identified as workerOwnRow, target workerCrossTarget's
    // row. DELETE is a silent RLS row filter (0 rows affected, no error);
    // INSERT is a hard RLS rejection (WITH CHECK, 42501).
    const cross = await connectAsWhatsapp();
    try {
      await setWorkerIdentity(cross, workerOwnRow);
      const crossDelete = await cross.query(
        `DELETE FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'resume'`,
        [workerCrossTarget, jobGeneralId],
      );
      expect(crossDelete.rowCount).toBe(0);

      await expect(cross.query(
        `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
         VALUES ($1, $2, 'resume', 'hostile-key', 'hostile.pdf', 100, 'application/pdf')`,
        [workerCrossTarget, jobGeneralId],
      )).rejects.toMatchObject({ code: '42501' });
      await cross.query('ROLLBACK');
    } finally {
      await cross.end();
    }

    const untouched = await setup.query(
      `SELECT s3_key FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'resume'`,
      [workerCrossTarget, jobGeneralId],
    );
    expect(untouched.rows).toEqual([{ s3_key: 'workerb-original' }]);
  });

  it('application_answers || merge succeeds under the 073 column grant', async () => {
    // 028_job_messaging_hardening.sql DROPPED 004's permissive
    // jobapp_whatsapp_all (USING(true)/WITH CHECK(true)) and replaced the
    // UPDATE path with jobapp_whatsapp_update, row-scoped to
    // worker_id::text = current_setting('app.current_internal_user_id', true)
    // -- that policy, not 004's, is what actually gates UPDATE today. The 073
    // grant (`GRANT UPDATE (application_answers, updated_at)`) is a separate,
    // column-level privilege layered on top of that row-scoped RLS policy, so
    // both the identity GUC AND the column grant must line up for the merge
    // to succeed.
    const client = await connectAsWhatsapp();
    try {
      await setWorkerIdentity(client, workerAnswers);
      const merged = await client.query(
        `UPDATE job_applications
            SET application_answers = application_answers || $2::jsonb, updated_at = now()
          WHERE id = $1
          RETURNING application_answers`,
        [mergeApplicationId, JSON.stringify({ date_available: '2026-09-01' })],
      );
      expect(merged.rows).toEqual([{
        application_answers: { home_address: '1 Main St', date_available: '2026-09-01' },
      }]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }

    // Negative control, in a fresh transaction: the grant is column-scoped,
    // not table-wide. `status` is NOT a valid ungranted-column probe -- 028
    // itself grants UPDATE (status, updated_at) to jale_whatsapp -- so this
    // targets `job_id`, a column no migration has ever granted UPDATE on to
    // jale_whatsapp. The identity GUC is set to the row's own worker here too,
    // so jobapp_whatsapp_update's row-scoping is satisfied and the rejection
    // is provably the column grant, not RLS filtering the row out first.
    const negative = await connectAsWhatsapp();
    try {
      await setWorkerIdentity(negative, workerAnswers);
      await expect(negative.query(
        `UPDATE job_applications SET job_id = $2 WHERE id = $1`,
        [mergeApplicationId, jobGeneralId],
      )).rejects.toMatchObject({ code: '42501' });
      await negative.query('ROLLBACK');
    } finally {
      await negative.end();
    }
  });

  // ── MIGRATION 091 SUPERSEDED THE TWO TESTS THAT USED TO LIVE HERE ──
  // 080 taught the 022 BEFORE INSERT required-docs guard an
  // `app.allow_incomplete_docs` GUC bypass so the WhatsApp accept could create
  // an application before docs were collected. The two cases removed here
  // asserted (1) that the guard raised 23514/job_applications_required_docs_check
  // without the GUC and passed with it, and (2) that the GUC was
  // transaction-local so the next transaction was guarded again.
  //
  // 091_application_stages.sql DROPPED the trigger outright: the stage model
  // collects nothing from the requirement vocabulary at apply time, so EVERY
  // application is incomplete by design on both doors, and the equivalent
  // enforcement moved to the transition to 'hired'
  // (job_applications_hire_requirements_guard, covered by
  // application-stages-091.integration.test.ts). The GUC is now dead code.
  //
  // What still needs a real database on THIS file's side is the inverse
  // property: the doc-less INSERT that 080 could only reach through a GUC now
  // succeeds with no GUC at all, and the bypass has become inert rather than
  // load-bearing. 091 deliberately KEPT the function (only 092 drops it), so
  // that is asserted too -- a premature function drop would make reverting 091
  // more than one CREATE TRIGGER.
  it('the 022/080 guard trigger is gone (091): a doc-less INSERT succeeds with no GUC, and the GUC is inert', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // No GUC. workerGuard has zero worker_documents rows and
      // jobRequireResumeId requires 'resume' -- before 091 this raised
      // 23514/job_applications_required_docs_check.
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await setWorkerIdentity(client, workerGuard);
      const noGuc = await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
         VALUES ($1, $2, 'pending', '{}'::jsonb)
         RETURNING id`,
        [jobRequireResumeId, workerGuard],
      );
      expect(noGuc.rows).toHaveLength(1);
      await client.query('COMMIT');

      // The bypass GUC is now inert: setting it changes nothing, and NOT
      // setting it in the following transaction changes nothing either (what
      // the deleted transaction-locality test proved about a live guard).
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await setWorkerIdentity(client, workerGuardTxLocalA);
      await client.query(`SELECT set_config('app.allow_incomplete_docs', 'on', true)`);
      const withGuc = await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
         VALUES ($1, $2, 'pending', '{}'::jsonb)
         RETURNING id`,
        [jobRequireResumeId, workerGuardTxLocalA],
      );
      expect(withGuc.rows).toHaveLength(1);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await setWorkerIdentity(client, workerGuardTxLocalB);
      const nextTx = await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
         VALUES ($1, $2, 'pending', '{}'::jsonb)
         RETURNING id`,
        [jobRequireResumeId, workerGuardTxLocalB],
      );
      expect(nextTx.rows).toHaveLength(1);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    // The trigger is really gone, and 091 kept the function on purpose.
    const trigger = await setup.query<{ count: string }>(
      `SELECT count(*) FROM pg_trigger
        WHERE tgname = 'job_applications_required_docs_guard'
          AND tgrelid = 'public.job_applications'::regclass
          AND NOT tgisinternal`,
    );
    expect(trigger.rows).toEqual([{ count: '0' }]);

    const fn = await setup.query<{ count: string }>(
      `SELECT count(*) FROM pg_proc
        WHERE proname = 'enforce_job_application_required_docs'`,
    );
    expect(fn.rows).toEqual([{ count: '1' }]);
  });

  it('6th certification INSERT under one cert_name raises 23514 certification_document_name_limit under RLS context', async () => {
    // 078 widened the 075 trigger to two independently-reachable caps: a
    // per-slot total (20) and a per-cert_name total (5, unchanged from 075's
    // original single cap). Five rows sharing a cert_name is now bound by the
    // NAME cap, not the slot cap -- see 078_worker_documents_cert_name.sql.
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
       SELECT $1, $2, 'certification_doc', 'name-cap-' || g::text, 'name-cap-' || g::text || '.pdf', 100, 'application/pdf', 'OSHA 30'
         FROM generate_series(1, 5) AS g`,
      [workerNameCap, jobCertsId],
    );

    const client = await connectAsWhatsapp();
    try {
      await setWorkerIdentity(client, workerNameCap);
      await expect(client.query(
        `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
         VALUES ($1, $2, 'certification_doc', 'name-cap-6', 'name-cap-6.pdf', 100, 'application/pdf', 'OSHA 30')`,
        [workerNameCap, jobCertsId],
      )).rejects.toMatchObject({ code: '23514', constraint: 'certification_document_name_limit' });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('21st certification INSERT across distinct cert_names raises 23514 certification_document_limit under RLS context', async () => {
    // 20 rows under 20 distinct cert_names never trips the per-name cap (each
    // name's own count stays at 1), so the 21st row is bound by the raised
    // per-slot total (078: 5 -> 20), not the per-name cap.
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
       SELECT $1, $2, 'certification_doc', 'total-cap-' || g::text, 'total-cap-' || g::text || '.pdf', 100, 'application/pdf', 'Cert-' || g::text
         FROM generate_series(1, 20) AS g`,
      [workerTotalCap, jobCertsId],
    );

    const client = await connectAsWhatsapp();
    try {
      await setWorkerIdentity(client, workerTotalCap);
      await expect(client.query(
        `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
         VALUES ($1, $2, 'certification_doc', 'total-cap-21', 'total-cap-21.pdf', 100, 'application/pdf', 'Cert-21')`,
        [workerTotalCap, jobCertsId],
      )).rejects.toMatchObject({ code: '23514', constraint: 'certification_document_limit' });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('cert-cap COUNT is RLS-scoped: with GUC identity unset the cap does not fire (documents the footgun)', async () => {
    // 075's own migration comment documents this exactly: "this function
    // runs with invoker rights, so the COUNT below is RLS-scoped to rows
    // visible under the inserting session's app.current_internal_user_id
    // ... On a hypothetical insert path where that setting is unset, the
    // count reads 0 and the cap does not fire." Verify that literally.
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
       SELECT $1, $2, 'certification_doc', 'footgun-' || g::text, 'footgun-' || g::text || '.pdf', 100, 'application/pdf', 'Footgun'
         FROM generate_series(1, 5) AS g`,
      [workerFootgun, jobCertsId],
    );

    const client = await connectAsWhatsapp();
    let caught: { code?: string; constraint?: string } | undefined;
    try {
      // Deliberately do NOT call setWorkerIdentity: app.current_internal_user_id
      // stays unset for this transaction, so the trigger's own
      // SELECT count(*) FROM worker_documents WHERE worker_id = NEW.worker_id
      // is RLS-filtered down to zero rows regardless of the 5 rows seeded
      // above -- the cap's own 23514/certification_document_*_limit never
      // raises.
      try {
        await client.query(
          `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
           VALUES ($1, $2, 'certification_doc', 'footgun-6', 'footgun-6.pdf', 100, 'application/pdf', 'Footgun')`,
          [workerFootgun, jobCertsId],
        );
      } catch (error: any) {
        caught = { code: error?.code, constraint: error?.constraint };
      }
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    // The write is still blocked overall -- but by the SEPARATE,
    // identity-scoped worker_documents_worker_insert RLS policy (005), whose
    // WITH CHECK rejects any insert whose worker_id doesn't match the
    // (unset -> NULL) current_internal_user_id. No data corruption occurs;
    // the specific cap error is simply masked behind a generic RLS
    // violation, which is exactly the footgun worth documenting: code that
    // pattern-matches on CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS
    // (infra/lambda/lib/applications.ts) would never see this path as a cap
    // violation.
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('42501');
    expect(caught?.constraint).not.toBe('certification_document_limit');
    expect(caught?.constraint).not.toBe('certification_document_name_limit');

    const after = await setup.query<{ count: string }>(
      `SELECT count(*) FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND cert_name = 'Footgun'`,
      [workerFootgun, jobCertsId],
    );
    expect(after.rows).toEqual([{ count: '5' }]);
  });

  it('savepoint rollback leaves nothing: doc INSERT + snapshot copy inside a SAVEPOINT, force cert-cap 23514, ROLLBACK TO SAVEPOINT', async () => {
    // Job slot already holds 5 'Savepoint'-named cert rows -- the per-name
    // cap (078) is already saturated for that slot.
    await setup.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
       SELECT $1, $2, 'certification_doc', 'sp-preexisting-' || g::text, 'sp-preexisting-' || g::text || '.pdf', 100, 'application/pdf', 'Savepoint'
         FROM generate_series(1, 5) AS g`,
      [workerSavepoint, jobCertsId],
    );

    const client = await connectAsWhatsapp();
    let sawCapError = false;
    try {
      await setWorkerIdentity(client, workerSavepoint);
      await client.query('SAVEPOINT doc_write');
      try {
        // "Doc INSERT": a fresh vault upload (job_id NULL), mirroring the
        // fill's DELETE-then-INSERT for a certification file.
        await client.query(
          `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
           VALUES ($1, NULL, 'certification_doc', 'sp-vault-new', 'sp-vault-new.pdf', 100, 'application/pdf', 'Savepoint')`,
          [workerSavepoint],
        );
        // "Snapshot copy": copyRequiredDocumentSnapshots's cert branch
        // (infra/lambda/lib/applications.ts), copying every not-yet-copied
        // vault/job cert row into the job slot. The one new vault row above
        // is the only uncopied source row and pushes the already-full
        // 'Savepoint' name group to 6 -> 23514.
        await client.query(
          `INSERT INTO worker_documents
             (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name)
           SELECT src.worker_id, $1::uuid, src.doc_type, src.s3_key, src.file_name, src.file_size, src.mime_type, src.s3_version_id, src.cert_name
             FROM worker_documents src
            WHERE src.worker_id = $2
              AND src.doc_type = 'certification_doc'
              AND (src.job_id IS NULL OR src.job_id = $1::uuid)
              AND NOT EXISTS (
                SELECT 1 FROM worker_documents dst
                 WHERE dst.worker_id = $2
                   AND dst.job_id = $1::uuid
                   AND dst.doc_type = 'certification_doc'
                   AND dst.s3_key = src.s3_key
              )`,
          [jobCertsId, workerSavepoint],
        );
        throw new Error('expected the snapshot copy to raise a cert-cap 23514');
      } catch (error: any) {
        if (error?.code === '23514' && error?.constraint === 'certification_document_name_limit') {
          sawCapError = true;
          await client.query('ROLLBACK TO SAVEPOINT doc_write');
        } else {
          throw error;
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }

    expect(sawCapError).toBe(true);

    // Neither the vault doc INSERT nor the snapshot-copy row survives.
    const vaultRow = await setup.query(
      `SELECT 1 FROM worker_documents WHERE worker_id = $1 AND job_id IS NULL AND s3_key = 'sp-vault-new'`,
      [workerSavepoint],
    );
    expect(vaultRow.rows).toHaveLength(0);

    const jobSlot = await setup.query<{ count: string }>(
      `SELECT count(*) FROM worker_documents
        WHERE worker_id = $1 AND job_id = $2 AND cert_name = 'Savepoint'`,
      [workerSavepoint, jobCertsId],
    );
    expect(jobSlot.rows).toEqual([{ count: '5' }]);
  });
});
