import type { PoolClient } from 'pg';
import { setInternalUserRlsContext } from './db';
import { isPlainObject, validateApplicationAnswers } from './application-answers';
import {
  findCertificationProofGaps,
  parseCertificationRequirements,
  validateCertificationClaims,
  type CertificationClaim,
} from './certification-claims';
import { upsertWorkerApplicationDefaults } from './worker-application-defaults';

export type ApplySurface = 'web' | 'whatsapp';

export type ApplyWorkerResult =
  | { status: 'applied'; application: Record<string, unknown> }
  | { status: 'already_applied'; application?: Record<string, unknown> }
  | { status: 'missing_documents'; missing_docs: string[] }
  | { status: 'missing_answers'; missing_fields: string[] }
  | { status: 'invalid_answers'; error: string }
  | { status: 'invalid_certification_claims' }
  | { status: 'missing_certification_claims' }
  | { status: 'missing_certification_proof'; certs: string[] }
  | { status: 'certification_document_limit' }
  | { status: 'job_closed' }
  | { status: 'forbidden' };

interface ApplyWorkerToJobInput {
  workerId: string;
  jobId: string;
  surface: ApplySurface;
  answers?: Record<string, unknown>;
  // WEB SURFACE ONLY -- see the certification-requirements block below.
  // Raw, unvalidated request value; shape is checked by
  // validateCertificationClaims (certification-claims.ts), never here.
  certificationClaims?: unknown;
}

// Must match MAX_ANSWERS_JSON_LENGTH in application-answers.ts, which is
// module-private there. Hand-synced, same caveat 078_worker_documents_cert_name.sql
// documents for its own MAX_CERTIFICATION_LENGTH duplication -- nothing
// enforces the two constants stay equal. This is the RECHECK of that same
// cap on the answers object AFTER certification_claims are merged in under
// the 'certifications' key (validateApplicationAnswers's own check ran
// before that merge and only ever saw the pre-merge object).
const MAX_MERGED_ANSWERS_JSON_LENGTH = 16384;

// Both 078_worker_documents_cert_name.sql trigger caps raise ERRCODE 23514
// with these exact CONSTRAINT names -- see that migration's header for why
// they're two distinct names (a per-slot total cap and an independently-
// reachable per-cert-name cap) rather than one. Both map to the same
// graceful apply-level result here: from this flow's perspective (a
// snapshot COPY, not a fresh worker upload) neither is something the
// worker can act on from the apply screen, so there is no value in
// surfacing them as two different codes.
const CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS = new Set([
  'certification_document_limit',
  'certification_document_name_limit',
]);

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
//   re-apply, and it must never insert duplicate rows for docs already
//   copied.
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

// WEB SURFACE ONLY. Runs validateCertificationClaims (the pure,
// surface-agnostic validator) and then does the ONE thing that validator
// cannot do without a DB connection: confirms every claimed doc id is a
// worker_documents row OWNED BY THIS WORKER with doc_type =
// 'certification_doc' (a legacy unlabeled cert file -- cert_name IS NULL --
// is still a VALID proof attachment; cert_name equality is never required).
// An id that fails that check is dropped from its claim's doc_ids -- not
// rejected as a hard error on its own -- so a claim with at least one other
// valid id still stands; findCertificationProofGaps (certification-claims.ts)
// is re-run against the DB-filtered claims afterward to catch the case
// where filtering left a required+proof_required claim with zero ids left.
// This also means only DB-CONFIRMED doc ids are ever written to
// application_answers.certifications -- never a stray/hostile id a worker
// referenced but does not actually own.
async function resolveCertificationClaims(
  client: PoolClient,
  workerId: string,
  rawClaims: unknown,
  certificationRequirements: ReturnType<typeof parseCertificationRequirements>,
): Promise<
  | { ok: true; certifications: CertificationClaim[] }
  | { ok: false; result: ApplyWorkerResult }
> {
  const validated = validateCertificationClaims(rawClaims, certificationRequirements);
  if (!validated.ok) {
    if (validated.error === 'missing_certification_proof') {
      return { ok: false, result: { status: 'missing_certification_proof', certs: validated.certs } };
    }
    return { ok: false, result: { status: validated.error } };
  }

  const allDocIds = Array.from(new Set(validated.certifications.flatMap((claim) => claim.doc_ids ?? [])));
  let validDocIds = new Set<string>();
  if (allDocIds.length > 0) {
    const docsRes = await client.query<{ id: string }>(
      `SELECT id FROM worker_documents
        WHERE worker_id = $1
          AND doc_type = 'certification_doc'
          AND id = ANY($2::uuid[])`,
      [workerId, allDocIds],
    );
    validDocIds = new Set(docsRes.rows.map((row) => row.id));
  }

  const certifications = validated.certifications.map((claim) =>
    claim.doc_ids ? { ...claim, doc_ids: claim.doc_ids.filter((id) => validDocIds.has(id)) } : claim,
  );

  const certs = findCertificationProofGaps(certifications, certificationRequirements);
  if (certs.length > 0) {
    return { ok: false, result: { status: 'missing_certification_proof', certs } };
  }

  return { ok: true, certifications };
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
    certification_requirements: unknown;
  }>(
    `SELECT id, required_docs, optional_docs, required_fields, optional_fields, certification_requirements FROM jobs WHERE id = $1 AND status = 'active'`,
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
  // INVARIANT enforced elsewhere, not here: a job with a non-empty
  // certification_requirements can never also list certification_doc in
  // required_docs/optional_docs -- the employer job-CREATE path rejects
  // that combination outright (a separate task owns that validation). So
  // missingRequiredDocuments below never needs to special-case
  // certification_doc: per-certification proof presence is entirely
  // gated by validateCertificationClaims/resolveCertificationClaims further
  // down, never by this required-docs check.
  const certificationRequirements = parseCertificationRequirements(job.certification_requirements);

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
  //
  // THE COMPLETE RECIPE TO CLOSE THIS GAP (for the WhatsApp fill-flow, once
  // it exists) -- everything a caller needs, in one place, in order:
  //   (a) Run validateApplicationAnswers(requiredFields, optionalFields, answers)
  //       exactly like the web branch below -- same function, same rules,
  //       no WhatsApp-specific relaxation.
  //   (b) If the job's certification_requirements is non-empty (parsed via
  //       parseCertificationRequirements, certification-claims.ts), run
  //       validateCertificationClaims(claims, certificationRequirements)
  //       against whatever claims the bot has collected, and ALSO do the
  //       DB ownership/type check resolveCertificationClaims does above
  //       (worker_documents, doc_type = 'certification_doc', owned by this
  //       worker -- a legacy unlabeled cert file is still valid proof) --
  //       (a) and (b) never route through each other; certification_claims
  //       is a top-level sibling of answers, not a field inside it.
  //   (c) Merge the DB-validated certifications array from (b) into the
  //       validated answers object from (a) under the RESERVED key
  //       'certifications' -- see certification-claims.ts's header for why
  //       that key can never collide with a real answer key.
  //   (d) Re-check the merged object against MAX_MERGED_ANSWERS_JSON_LENGTH
  //       (16KB, this file) -- the (a)-stage check only ever saw the
  //       pre-merge object.
  //   (e) Call upsertWorkerApplicationDefaults (worker-application-defaults.ts)
  //       with the merged object minus its 'certifications' key, exactly as
  //       the web branch does below -- same function, no reimplementation.
  //   (f) Add the grant migration 079_worker_application_defaults.sql's
  //       header already describes:
  //         GRANT SELECT, INSERT, UPDATE ON worker_application_defaults TO jale_whatsapp;
  //       Without it, step (e) fails with 42501 the first time this runs
  //       over the jale_whatsapp role.
  // Until all of (a)-(f) ship together, WhatsApp keeps bypassing every one
  // of these gates below, as it already does today.
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

    // WEB SURFACE ONLY, and only when the job actually asks for certs --
    // most jobs' certification_requirements is empty, and this whole block
    // must be a no-op for them (byte-for-byte the pre-existing behavior).
    if (certificationRequirements.length > 0) {
      const claimsResult = await resolveCertificationClaims(
        client,
        workerId,
        input.certificationClaims,
        certificationRequirements,
      );
      if (!claimsResult.ok) {
        return claimsResult.result;
      }
      // Reserved key -- see certification-claims.ts. answersToStore can
      // never already carry this key: validateApplicationAnswers rejects a
      // client-supplied 'certifications' answers key with
      // 'unknown_answer_key', since it is never a member of
      // REQUIRED_FIELD_TYPES / jobs_required_fields_valid (073) or
      // jobs_optional_fields_valid (074).
      answersToStore = { ...answersToStore, certifications: claimsResult.certifications };

      // RECHECK, not the original check: validateApplicationAnswers only
      // ever measured the pre-merge object above. The merge just added an
      // arbitrary-length certifications array (bounded in practice by
      // MAX_CERTIFICATION_FILES-scale doc_ids arrays, but not by anything
      // this function enforces) that could push the combined object over
      // the same cap. Same error code as the original oversize case
      // (application-answers.ts) -- to a caller this is observationally
      // identical to "answers were too large", just discovered one merge
      // later.
      if (JSON.stringify(answersToStore).length > MAX_MERGED_ANSWERS_JSON_LENGTH) {
        return { status: 'invalid_answers', error: 'invalid_answers' };
      }
    }

    // WEB SURFACE ONLY, AFTER validation (and after any certification-claims
    // merge above) succeeds: save these answers as the worker's prefill
    // defaults for future applications. 'certifications' is stripped first
    // -- worker_application_defaults.answers holds only the free-form
    // questionnaire keys (REQUIRED_FIELD_TYPES), never certification claims,
    // which are per-job by nature and meaningless as a cross-job default.
    // A failure here is NEVER swallowed: it propagates out of this
    // try-less block and up through the caller (worker-jobs-apply.ts),
    // which rolls back the whole apply transaction. Saving a worker's
    // defaults is not allowed to silently fail while the application itself
    // still commits.
    const { certifications: _certifications, ...defaultsAnswers } = answersToStore;
    await upsertWorkerApplicationDefaults(client, workerId, defaultsAnswers);
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
