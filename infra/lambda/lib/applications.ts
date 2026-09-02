import type { PoolClient } from 'pg';
import { setInternalUserRlsContext } from './db';
import { parsePreApplicationPromptList, validatePromptAnswers } from './pre-application-prompts';

export type ApplySurface = 'web' | 'whatsapp';

// STAGE 1 ONLY (sprint 23). An apply now creates the row and nothing more:
// the questionnaire answers, certification claims and documents that used to
// gate this call are collected in stage 2, through
// lib/application-requirements.ts, after the employer requests details.
// Every result that belonged to those gates -- missing_documents,
// missing_answers, invalid_answers, the three certification-claim codes, and
// guard_blocked -- is gone with them.
export type ApplyWorkerResult =
  | { status: 'applied'; application: Record<string, unknown> }
  | { status: 'already_applied'; application: Record<string, unknown> }
  | { status: 'missing_prompt_answers'; missing: string[] }
  | { status: 'invalid_prompt_answers' }
  | { status: 'certification_document_limit' }
  | { status: 'job_closed' }
  | { status: 'forbidden' }
  // DEPRECATED, NEVER PRODUCED. Retained in the union for ONE release only
  // so the Ivan-owned `else if (applyResult.status === 'guard_blocked')`
  // branch at whatsapp/processor.ts:2202 keeps typechecking -- removing the
  // member would make that comparison a TS2367 "no overlap" error in a file
  // this lane does not own. The 022 trigger that raised it
  // (`job_applications_required_docs_guard`, 23514
  // `job_applications_required_docs_check`) is DROPPED by 091, so nothing
  // can return this any more; the mapping in the catch block below is gone.
  // DELETE together with that processor branch in the WhatsApp lane.
  | { status: 'guard_blocked' };

interface ApplyWorkerToJobInput {
  workerId: string;
  jobId: string;
  surface: ApplySurface;
  // WEB SURFACE ONLY. Raw, unvalidated request value: shape, known-id and
  // completeness checks all happen in validatePromptAnswers
  // (pre-application-prompts.ts), never here. WhatsApp ignores this field
  // entirely -- see the surface split in applyWorkerToJob.
  promptAnswers?: unknown;
}

// Both 078_worker_documents_cert_name.sql trigger caps raise ERRCODE 23514
// with these exact CONSTRAINT names -- see that migration's header for why
// they're two distinct names (a per-slot total cap and an independently-
// reachable per-cert-name cap) rather than one. Both map to the same
// graceful apply-level result here: from this flow's perspective (a
// snapshot COPY, not a fresh worker upload) neither is something the
// worker can act on from the apply screen, so there is no value in
// surfacing them as two different codes.
export const CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS = new Set([
  'certification_document_limit',
  'certification_document_name_limit',
]);

// Snapshots the vault/job-scoped worker_documents rows for every doc type in
// `docTypes` (required + optional docs the worker actually has -- a missing
// doc is fine and simply doesn't get a row; as of sprint 23 EVERY apply is
// document-incomplete by design, so this is routinely a partial copy).
// Split into two statements because certification_doc has different copy
// semantics from every other doc type:
//
// - Non-cert types: at most one row per (worker, doc_type) is meaningful,
//   so DISTINCT ON (doc_type) picks the best candidate (same-job row over
//   vault row, most recent upload wins), exactly as before this migration.
//
// - certification_doc: 075_worker_documents_multi_certification.sql allows
//   multiple certification_doc rows per (worker_id, job_id), capped by a
//   trigger -- raised from 5 to 20 total-per-slot by
//   078_worker_documents_cert_name.sql, which also added an independently-
//   reachable per-cert-name cap of 5 (see CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS
//   above and the catch block below for how both map to a graceful result
//   instead of an unhandled 500). So instead of DISTINCT ON, copy EVERY
//   matching vault/job cert row, deduped by s3_key against rows already
//   snapshotted for this job. The dedup is done with an explicit NOT EXISTS
//   rather than relying only on ON CONFLICT, because a future unique index
//   shape (or none at all) must not be required for this function's
//   idempotency: the already_applied path calls this again on every
//   re-apply, and the stage-2 engine
//   (application-requirements.ts loadRequirementSnapshot, with
//   syncDocumentSnapshots) calls it on every worker-side read and write --
//   it must never insert duplicate rows for docs already copied.
//
//   KNOWN LATENT ISSUE, not fixed here (out of this function's scope, flagged
//   in 078's header): this dedup is by s3_key only and this function never
//   DELETEs a stale snapshot row. Vault churn (upload, delete, re-upload
//   under a new s3_key) followed by a re-apply can accumulate rows in a
//   job's cert slot over time, eventually reaching one of the two 078
//   trigger caps on an ordinary re-apply. That failure mode is exactly what
//   the catch block below turns into 'certification_document_limit' instead
//   of a 500 -- a mitigation for the symptom, not a fix for the underlying
//   accumulation.
//
//   `cert_name` (078) rides along as a plain passthrough column in both
//   INSERTs below, same as every other worker_documents column here: this
//   function only ever copies existing rows verbatim, never invents or
//   edits a label.
export async function copyRequiredDocumentSnapshots(
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
         (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name)
       SELECT DISTINCT ON (doc_type)
              worker_id, $1::uuid, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name
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
          )
       ON CONFLICT DO NOTHING`,
      [jobId, workerId],
    );
  }
}

// The DB half of a certification claim -- the ONE thing the pure validators
// in certification-claims.ts cannot do without a connection: confirm every
// claimed doc id is a worker_documents row OWNED BY THIS WORKER with
// doc_type = 'certification_doc'. A legacy unlabeled cert file (cert_name
// IS NULL) is still a VALID proof attachment, so cert_name is deliberately
// never part of the filter.
//
// Returns the surviving ids as a Set so the caller can DROP the ones that
// failed from a claim's doc_ids -- not reject the claim outright -- letting
// a claim with at least one other valid id still stand. That filtering is
// what keeps a stray or hostile id (another worker's document, or a
// non-certification upload) out of
// job_applications.application_answers.certifications: only DB-CONFIRMED
// ids are ever written.
//
// Extracted from the former private `resolveCertificationClaims` when the
// apply path stopped taking claims (sprint 23): `mergeCertificationClaims`
// (application-requirements.ts) is now the only caller, and it re-runs the
// pure proof-gap check itself against the filtered result.
export async function resolveCertificationDocIds(
  client: PoolClient,
  workerId: string,
  docIds: readonly string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(docIds));
  if (unique.length === 0) return new Set<string>();

  const docsRes = await client.query<{ id: string }>(
    `SELECT id FROM worker_documents
      WHERE worker_id = $1
        AND doc_type = 'certification_doc'
        AND id = ANY($2::uuid[])`,
    [workerId, unique],
  );
  return new Set(docsRes.rows.map((row) => row.id));
}

/**
 * STAGE 1: create the application row, and nothing else.
 *
 * Sprint 23 reduced this to the minimum an apply can be. What it no longer
 * does, and where each of those went:
 *   - the required-documents bounce: gone. Every apply is
 *     document-incomplete by design now, and 091 DROPS the 022 BEFORE-INSERT
 *     `job_applications_required_docs_guard` that enforced it at the DB
 *     level -- which is also why the `app.allow_incomplete_docs` GUC the
 *     WhatsApp surface used to set is dead and no longer set for any
 *     surface. Docs are collected in stage 2.
 *   - the answers gate (`validateApplicationAnswers`) and the certification
 *     -claims gate: gone, along with the long "(a)-(f) recipe to close this
 *     gap" comment that described building them for WhatsApp. That flow
 *     SHIPPED (migration 080, whatsapp/lib/application-fill.ts) and its
 *     surface-agnostic core now lives in lib/application-requirements.ts,
 *     serving both doors.
 *   - the `worker_application_defaults` write-back: moved into
 *     `mergeFieldAnswers`, so it happens for BOTH surfaces (B4.0 §9) rather
 *     than web-only.
 *
 * What it gained: the employer's `pre_application_prompts`. On web these
 * must all be answered in the request (the apply screen asks them), so a
 * short or malformed set bounces before the INSERT. On WhatsApp they cannot
 * possibly precede the row -- "accept" is a one-tap reply -- so the column
 * starts `{}` and the bot collects them conversationally right afterwards,
 * through `mergePromptAnswers`.
 */
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
  //
  // The requirement columns stage 2 owns (required_fields, optional_fields,
  // certification_requirements) are deliberately NOT selected: nothing in
  // stage 1 reads them, and re-deriving them here is how a second,
  // divergent "what's missing" computation gets started.
  // application-requirements.ts is the single source of truth for that.
  const jobRes = await client.query<{
    id: string;
    required_docs: string[] | null;
    optional_docs: string[] | null;
    pre_application_prompts: unknown;
  }>(
    `SELECT id, required_docs, optional_docs, pre_application_prompts FROM jobs WHERE id = $1 AND status = 'active'`,
    [jobId],
  );
  if (jobRes.rows.length === 0) {
    return { status: 'job_closed' };
  }

  const job = jobRes.rows[0];
  const requiredDocs = job.required_docs ?? [];
  const optionalDocs = job.optional_docs ?? [];

  // Prompt answers are stored in their OWN column, not under a reserved key
  // inside application_answers (B4.0 §1): that keeps the 16 KB answers cap
  // and every Object.keys(application_answers) reader untouched, and makes
  // the write-once top-up a single SQL expression (mergePromptAnswers).
  let promptAnswersToStore: Record<string, string> = {};
  if (surface === 'web') {
    // parsePreApplicationPromptList fails OPEN on a corrupt column value
    // (non-array -> no prompts), so a hand-edited row degrades to "this job
    // asks nothing" instead of 500-ing every apply.
    const prompts = parsePreApplicationPromptList(job.pre_application_prompts);
    const validated = validatePromptAnswers(prompts, input.promptAnswers);
    if (!validated.ok) {
      if (validated.error === 'missing_prompt_answers') {
        return { status: 'missing_prompt_answers', missing: validated.missing };
      }
      return { status: 'invalid_prompt_answers' };
    }
    promptAnswersToStore = validated.value;
  }
  // WhatsApp: the accept is a one-tap button reply that cannot carry
  // answers, so the row starts with an empty object and the prompt lane
  // collects them on the following turns via mergePromptAnswers (write-once
  // per id at the SQL level). Any promptAnswers a caller passes on this
  // surface is ignored rather than trusted -- it has been through no
  // validator here.

  const docTypesToSnapshot = Array.from(new Set([...requiredDocs, ...optionalDocs]));

  try {
    const insertRes = await client.query(
      `INSERT INTO job_applications (job_id, worker_id, status, application_answers, prompt_answers)
       VALUES ($1, $2, 'pending', '{}'::jsonb, $3::jsonb)
       ON CONFLICT (job_id, worker_id) DO NOTHING
       RETURNING id, job_id, status, applied_at`,
      [jobId, workerId, JSON.stringify(promptAnswersToStore)],
    );

    if (insertRes.rows.length === 0) {
      // already_applied: NEVER patch the row here, even though
      // `promptAnswersToStore` may hold freshly-validated data -- this
      // idempotent re-apply path intentionally discards it. Stage-2 top-ups
      // (and prompt answers, which are write-once PER ID via
      // `mergePromptAnswers` in application-requirements.ts) go through that
      // module's own UPDATE paths, never through this one. So no UPDATE of
      // any kind runs here.
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
    // Both copyRequiredDocumentSnapshots call sites above (fresh apply and
    // already_applied repair) are inside this same try block, so one catch
    // covers both. See CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS above for
    // why both 078 constraint names collapse to the same graceful result
    // instead of an unhandled 500.
    if (err?.code === '23514' && CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS.has(err?.constraint)) {
      return { status: 'certification_document_limit' };
    }
    throw err;
  }
}
