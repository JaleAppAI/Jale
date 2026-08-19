import type { PoolClient } from 'pg';
import { setInternalUserRlsContext } from './db';
import { isPlainObject, validateApplicationAnswers } from './application-answers';

export type ApplySurface = 'web' | 'whatsapp';

export type ApplyWorkerResult =
  | { status: 'applied'; application: Record<string, unknown> }
  | { status: 'already_applied'; application?: Record<string, unknown> }
  | { status: 'missing_documents'; missing_docs: string[] }
  | { status: 'missing_answers'; missing_fields: string[] }
  | { status: 'invalid_answers'; error: string }
  | { status: 'job_closed' }
  | { status: 'forbidden' };

interface ApplyWorkerToJobInput {
  workerId: string;
  jobId: string;
  surface: ApplySurface;
  answers?: Record<string, unknown>;
}

// Snapshots the vault/job-scoped worker_documents rows for every doc type in
// `docTypes` (required + optional docs the worker actually has -- a missing
// optional doc is fine and simply doesn't get a row). Split into two
// statements because certification_doc has different copy semantics from
// every other doc type:
//
// - Non-cert types: at most one row per (worker, doc_type) is meaningful,
//   so DISTINCT ON (doc_type) picks the best candidate (same-job row over
//   vault row, most recent upload wins), exactly as before this migration.
//
// - certification_doc: 075_worker_documents_multi_certification.sql (not
//   yet deployable -- see task context) allows multiple certification_doc
//   rows per (worker_id, job_id), capped at MAX_CERTIFICATION_FILES by a
//   trigger. So instead of DISTINCT ON, copy EVERY matching vault/job cert
//   row, deduped by s3_key against rows already snapshotted for this job.
//   The dedup is done with an explicit NOT EXISTS rather than relying only
//   on ON CONFLICT, because a future unique index shape (or none at all,
//   post-075) must not be required for this function's idempotency: the
//   already_applied path calls this again on every re-apply, and it must
//   never insert duplicate rows for docs already copied.
//
//   Under the CURRENT pre-075 UNIQUE (worker_id, job_id, doc_type) index,
//   only the first cert row per job can ever land (later ones collide on
//   that unique key and are silently dropped by ON CONFLICT DO NOTHING) --
//   that is expected, graceful degradation to "single cert", not a bug.
//   Under post-075's widened index, multiple rows land, still capped by
//   the DB-side trigger. ON CONFLICT DO NOTHING (no target) is kept so
//   either index shape is satisfied without this code knowing which one is
//   live.
async function copyRequiredDocumentSnapshots(
  client: PoolClient,
  workerId: string,
  jobId: string,
  docTypes: string[],
): Promise<void> {
  if (docTypes.length === 0) return;

  const nonCertTypes = docTypes.filter((docType) => docType !== 'certification_doc');
  const hasCert = docTypes.includes('certification_doc');

  if (nonCertTypes.length > 0) {
    await client.query(
      `INSERT INTO worker_documents
         (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id)
       SELECT DISTINCT ON (doc_type)
              worker_id, $1::uuid, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id
         FROM worker_documents
        WHERE worker_id = $2
          AND doc_type = ANY($3::text[])
          AND (job_id IS NULL OR job_id = $1::uuid)
        ORDER BY doc_type, (job_id = $1::uuid) DESC, (job_id IS NULL) DESC, uploaded_at DESC
       ON CONFLICT DO NOTHING`,
      [jobId, workerId, nonCertTypes],
    );
  }

  if (hasCert) {
    await client.query(
      `INSERT INTO worker_documents
         (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id)
       SELECT src.worker_id, $1::uuid, src.doc_type, src.s3_key, src.file_name, src.file_size, src.mime_type, src.s3_version_id
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
          )
       ON CONFLICT DO NOTHING`,
      [jobId, workerId],
    );
  }
}

async function missingRequiredDocuments(
  client: PoolClient,
  workerId: string,
  jobId: string,
  requiredDocs: string[],
): Promise<string[]> {
  if (requiredDocs.length === 0) return [];

  const docsRes = await client.query<{ doc_type: string }>(
    `SELECT DISTINCT doc_type
       FROM worker_documents
      WHERE worker_id = $1
        AND doc_type = ANY($2::text[])
        AND (job_id IS NULL OR job_id = $3::uuid)`,
    [workerId, requiredDocs, jobId],
  );
  const present = new Set(docsRes.rows.map((row) => row.doc_type));
  return requiredDocs.filter((docType) => !present.has(docType));
}

export async function applyWorkerToJob(
  client: PoolClient,
  input: ApplyWorkerToJobInput,
): Promise<ApplyWorkerResult> {
  const { workerId, jobId, surface } = input;
  await setInternalUserRlsContext(client, workerId);

  // No FOR UPDATE here: a row lock requires the UPDATE privilege on `jobs`,
  // which the WhatsApp role (jale_whatsapp) deliberately does not have
  // (ADR-W05). Applying from WhatsApp would otherwise fail with
  // "permission denied for table jobs" (42501). The lock is not needed for
  // correctness — the INSERT ... ON CONFLICT (job_id, worker_id) DO NOTHING
  // below makes the apply idempotent under concurrency.
  const jobRes = await client.query<{
    id: string;
    required_docs: string[] | null;
    optional_docs: string[] | null;
    required_fields: string[] | null;
    optional_fields: string[] | null;
  }>(
    `SELECT id, required_docs, optional_docs, required_fields, optional_fields FROM jobs WHERE id = $1 AND status = 'active'`,
    [jobId],
  );
  if (jobRes.rows.length === 0) {
    return { status: 'job_closed' };
  }

  const job = jobRes.rows[0];
  const requiredDocs = job.required_docs ?? [];
  const optionalDocs = job.optional_docs ?? [];
  // Same required_fields/optional_fields column order feeds both this
  // validator and worker-jobs-detail.ts's independent missing_fields /
  // optional_unanswered computation -- the two agree because both filter
  // the same array in place, not because either one is sorted. Keep it
  // that way; don't reorder one without the other.
  const requiredFields = job.required_fields ?? [];
  const optionalFields = job.optional_fields ?? [];

  const missingDocs = await missingRequiredDocuments(client, workerId, jobId, requiredDocs);
  if (missingDocs.length > 0) {
    return { status: 'missing_documents', missing_docs: missingDocs };
  }

  // WhatsApp applies happen BEFORE the bot has had a chance to collect any
  // structured answers -- "accept" is a one-tap reply, not a form. Gating
  // this surface on required_fields would make every WhatsApp accept bounce
  // off missing_answers before the (not-yet-built) conversational fill flow
  // ever runs. So WhatsApp skips the answers gate entirely: it is a
  // transition state that persists whatever (if anything) the caller
  // already has, and defers real collection to a future incremental
  // answers-fill flow that writes application_answers directly (the
  // jale_whatsapp UPDATE grant for that already exists, see
  // 073_job_application_requirements.sql). Remove this bypass once that
  // flow ships and the bot can supply an already-validated `answers` object
  // before calling accept.
  //
  // Only the shape (plain object) is enforced here, not the field-level
  // validator -- an unvalidated non-object value (array/string/etc.) must
  // never reach application_answers, since every reader (worker-jobs-detail,
  // employer-job-applicants) assumes an object to Object.keys()/hasOwnProperty
  // over.
  let answersToStore: Record<string, unknown> = {};
  if (surface === 'whatsapp') {
    if (input.answers !== undefined && isPlainObject(input.answers)) {
      answersToStore = input.answers;
    }
  } else {
    const validated = validateApplicationAnswers(requiredFields, optionalFields, input.answers ?? {});
    if (!validated.ok) {
      // Narrow via `'missing' in validated` rather than `error === 'missing_answers'`:
      // the third union member's `error` is typed as plain `string`, so TS can't
      // discriminate on the literal alone.
      if ('missing' in validated) {
        return { status: 'missing_answers', missing_fields: validated.missing };
      }
      return { status: 'invalid_answers', error: validated.error };
    }
    answersToStore = validated.value;
  }

  const docTypesToSnapshot = Array.from(new Set([...requiredDocs, ...optionalDocs]));

  try {
    const insertRes = await client.query(
      `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
       VALUES ($1, $2, 'pending', $3::jsonb)
       ON CONFLICT (job_id, worker_id) DO NOTHING
       RETURNING id, job_id, status, applied_at`,
      [jobId, workerId, JSON.stringify(answersToStore)],
    );

    if (insertRes.rows.length === 0) {
      // already_applied: NEVER patch application_answers here, even though
      // `answersToStore` may hold freshly-validated data -- the write-once
      // contract for v1 is that answers are set exactly once, at the
      // INSERT that creates the row. This path (re-apply on an existing
      // application) intentionally discards answersToStore. Incremental
      // fills (e.g. a WhatsApp conversational flow topping up missing
      // fields after the fact) are a future separate UPDATE path, not this
      // idempotent re-apply path -- so no UPDATE of any kind runs here.
      await copyRequiredDocumentSnapshots(client, workerId, jobId, docTypesToSnapshot);
      const existingRes = await client.query(
        `SELECT id, job_id, status, applied_at
           FROM job_applications
          WHERE job_id = $1 AND worker_id = $2`,
        [jobId, workerId],
      );
      if (existingRes.rows.length > 0) {
        return { status: 'already_applied', application: existingRes.rows[0] };
      }
      return { status: 'forbidden' };
    }

    await copyRequiredDocumentSnapshots(client, workerId, jobId, docTypesToSnapshot);
    return { status: 'applied', application: insertRes.rows[0] };
  } catch (err: any) {
    if (err?.code === '42501') {
      return { status: 'forbidden' };
    }
    throw err;
  }
}
