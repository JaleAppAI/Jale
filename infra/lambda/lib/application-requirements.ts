/**
 * application-requirements.ts -- THE shared "what does this application
 * still need" engine, for every surface.
 *
 * Sprint 23 splits a job application into two stages:
 *   - stage 1 "apply": a minimal step. The worker answers the employer's
 *     free-text `pre_application_prompts` and nothing else.
 *   - stage 2 "details": only after the employer asks
 *     (`details_requested_at`), the worker fills the job's
 *     `required_fields` / `certification_requirements` / `required_docs`.
 *
 * The stage-2 collector already existed, on WhatsApp only
 * (`whatsapp/lib/application-fill.ts`, migration 080). This module is that
 * engine's surface-agnostic core lifted into `lib/` so the web door
 * (`api/worker-application-details.ts`) and the WhatsApp fill flow run on
 * ONE system, plus the prompt/certification steps WhatsApp never had.
 * `computeNextStep` and `countRemainingRequirements` at the bottom keep
 * their pre-existing return shapes so the WhatsApp lane swaps only an
 * import path.
 *
 * ── RLS CONTRACT (binding) ───────────────────────────────────────
 * `job_applications` is FORCE RLS and the only worker-side UPDATE policy is
 * `jobapp_whatsapp_update` (028:30-33) -- jale_whatsapp, keyed on
 * `worker_id = app.current_internal_user_id`. There is NO worker UPDATE
 * policy for jale_admin. So the stage-2 worker API runs as jale_whatsapp
 * (the `whatsapp/web/worker-onboarding.ts:13-23` shape), while employer
 * reads run as jale_admin. This module must be identical under both roles:
 *
 *   1. It takes an EXPLICIT `workerId` and never derives identity from a
 *      GUC or a session.
 *   2. The CALLER sets `app.current_internal_user_id`
 *      (`setInternalUserRlsContext`, lib/db.ts:72) for the request/turn.
 *      The ONE exception is the `syncDocumentSnapshots` path below, which
 *      must set it itself because it WRITES to worker_documents (FORCE RLS)
 *      -- exactly as the pre-existing `computeNextStep` did
 *      (application-fill.ts:121) before this lift. Every pure function here
 *      sets nothing.
 *   3. It never issues BEGIN / COMMIT / ROLLBACK. Callers own the
 *      transaction. The only exception is the internal SAVEPOINT used to
 *      bound the post-merge answers size (see `withSizeGuard`), which is
 *      transaction-local and always released or rolled back.
 *   4. `jobapp_whatsapp_select` is `USING (true)` (028:26-27), so anything
 *      that must be worker-scoped filters `WHERE id = $1 AND worker_id = $2`
 *      in SQL. The engine's own snapshot SELECT is keyed on the application
 *      id alone (matching the pre-existing `computeNextStep`); the CALLING
 *      door is responsible for having already proven ownership. Every WRITE
 *      here is additionally protected by the policy predicate itself.
 *
 * ── DOCUMENT SNAPSHOTS ───────────────────────────────────────────
 * Employer sessions can only read job-scoped `worker_documents` rows (018),
 * and 091's hire gate counts `wd.job_id = NEW.job_id` rows only. So
 * `have_docs` here is JOB-SCOPED, unlike the vault-inclusive
 * `(job_id IS NULL OR job_id = ...)` probe the WhatsApp flow used before the
 * lift. To keep the two equivalent, every WORKER-side read/write passes
 * `syncDocumentSnapshots: true`, which runs `copyRequiredDocumentSnapshots`
 * (applications.ts) first: a doc sitting in the vault is copied onto the job
 * and then counts. Without that sync a vault-only resume would read as
 * missing forever and the bot would re-ask for it every turn. Employer reads
 * pass `computeRemaining` a row they already have and never sync.
 *
 * ── DUPLICATE ENGINE WARNING ─────────────────────────────────────
 * `worker-jobs-detail.ts` used to compute its own missing_docs/missing_fields
 * independently (the second of the "two what's-missing engines" flagged in
 * the sprint plan). Point every new reader at `computeRemaining` here. Do
 * not add a third.
 */
import type { PoolClient } from 'pg';
import { setInternalUserRlsContext } from './db';
import { DOC_TYPES, isReusableField } from './job-fields';
import { MAX_ANSWERS_JSON_LENGTH, validateApplicationAnswers } from './application-answers';
import {
  copyRequiredDocumentSnapshots,
  resolveCertificationDocIds,
  CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS,
  type CopiedDocument,
} from './applications';
import {
  findMissingCertifications,
  normalizeCertificationClaims,
  parseCertificationRequirements,
  type CertificationClaim,
  type CertificationRequirement,
} from './certification-claims';
import {
  filterReusableDefaults,
  loadWorkerApplicationDefaults,
  upsertWorkerApplicationDefaults,
} from './worker-application-defaults';
import {
  MAX_PROMPT_ANSWERS_BYTES,
  PROMPT_ANSWERS_CONSTRAINT,
  normalizePromptAnswers,
  parsePreApplicationPromptList,
  type PreApplicationPrompt,
  type PromptAnswers,
} from './pre-application-prompts';

export { PROMPT_ANSWERS_CONSTRAINT } from './pre-application-prompts';

// DOC_TYPES (job-fields.ts) already excludes 'ssn' -- legacy jobs may still
// require it (it is kept in the DB CHECK constraints for that reason), but
// it can never be collected through any flow. Such a doc is reported in
// `uncollectableDocs` and NEVER blocks completion; the surfaces send the
// worker elsewhere for it (WhatsApp's `web_handoff` note).
const COLLECTABLE = new Set<string>(DOC_TYPES);

// Per-merge backstop, lifted verbatim from the WhatsApp `mergeAnswer`
// (spec §12): per-key validator bounds already keep every real shape far
// under this, but a future validator change should fail loud here rather
// than silently growing the column. Applies to the serialized batch handed
// to ONE merge call; MAX_ANSWERS_JSON_LENGTH (16384) bounds the accumulated
// column afterwards.
const MAX_PER_MERGE_JSON_LENGTH = 8192;

// The CONSTRAINT name 091's BEFORE-UPDATE hire gate
// (`enforce_job_application_hire_requirements`) raises its 23514 with. The
// employer status handler catches it and answers 409 `details_incomplete`
// instead of leaking a 500.
export const HIRE_REQUIREMENTS_CONSTRAINT = 'job_applications_hire_requirements_check';

// Metadata-ONLY step telemetry (spec §11: never the answer values). The
// event name is carried over verbatim from the WhatsApp flow's private
// `logStep` (application-fill.ts:406) so existing log queries keep
// matching after the lift -- the stream is the same stream, it just now
// also covers the web door.
function logStep(key: string, outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: 'ApplicationFillStep', key, outcome, reason }));
}

export type RequirementStage = 'apply' | 'details';

export type DetailsStatus = 'not_requested' | 'requested' | 'complete';

export type RequirementStep =
  | { kind: 'prompt'; promptId: string; text: string }
  | { kind: 'field'; key: string }
  | { kind: 'certification'; name: string; proofRequired: boolean }
  | { kind: 'doc'; docType: string }
  | { kind: 'complete'; stage: RequirementStage }
  | { kind: 'exit'; reason: 'job_inactive' | 'application_gone' | 'application_closed' };

export interface RequirementSnapshot {
  applicationId: string;
  workerId: string;
  jobId: string;
  applicationStatus: string;
  jobStatus: string;
  jobTitle: string | null;
  /** job_applications.application_answers, including the reserved 'certifications' key. */
  answers: Record<string, unknown>;
  /** job_applications.prompt_answers, keyed on prompt id. */
  promptAnswers: PromptAnswers;
  prompts: PreApplicationPrompt[];
  requiredFields: string[];
  optionalFields: string[];
  requiredDocs: string[];
  optionalDocs: string[];
  certificationRequirements: CertificationRequirement[];
  /** JOB-SCOPED doc types present for this worker. See the header. */
  haveDocs: string[];
  detailsRequestedAt: unknown;
  detailsCompletedAt: unknown;
  appliedAt: unknown;
  updatedAt: unknown;
  /** Derived from `details_requested_at`, NEVER from the literal status. */
  stage: RequirementStage;
  /**
   * ADDITIVE (sprint 24 L3, decision D3): the documents THIS load's
   * `syncDocumentSnapshots` copied onto the job -- always `[]` on an
   * unsynced load and on the (normal) synced load that copied nothing.
   *
   * It exists so a surface can TELL the worker which documents were attached
   * from their vault, instead of a required document silently vanishing off
   * the ask list (incident mechanism 3). Read it in the SAME turn as the
   * load: it reports what this call did, not what the job holds -- the
   * second synced load of a turn legitimately reports nothing, because the
   * first one already copied everything.
   *
   * OPTIONAL, so the OTHER snapshot builder -- `snapshotFromRow`
   * (application-stage-view.ts), which re-shapes an already-selected
   * employer-side row and performs no sync at all -- keeps compiling
   * untouched. `toSnapshot` below always sets `[]`, so every snapshot that
   * came through THIS module's loader has a real array; read it as
   * `?? []` when the value may have come from either builder.
   */
  copiedDocuments?: CopiedDocument[];
}

export interface Remaining {
  /** Unanswered prompt ids, in `pre_application_prompts` order. */
  prompts: string[];
  /** Unanswered required field keys, in `required_fields` order. */
  fields: string[];
  certifications: { unclaimed: string[]; unproven: string[] };
  /** Missing COLLECTABLE required doc types, in `required_docs` order. */
  docs: string[];
  /** Required docs that no flow can collect (legacy `ssn`). Never blocking. */
  uncollectableDocs: string[];
  optionalFields: string[];
  optionalDocs: string[];
  counts: { prompts: number; fields: number; certifications: number; docs: number };
  complete: boolean;
}

// ── Snapshot load ────────────────────────────────────────────────────────

interface RequirementRow {
  id: string;
  worker_id: string;
  job_id: string;
  application_status: string;
  application_answers: Record<string, unknown> | null;
  prompt_answers: Record<string, string> | null;
  details_requested_at: unknown;
  details_completed_at: unknown;
  applied_at: unknown;
  updated_at: unknown;
  job_status: string;
  job_title: string | null;
  required_fields: string[] | null;
  optional_fields: string[] | null;
  required_docs: string[] | null;
  optional_docs: string[] | null;
  certification_requirements: unknown;
  pre_application_prompts: unknown;
  have_docs: string[] | null;
}

// ONE SELECT for the whole picture. `have_docs` is folded in as an
// ARRAY(...) subquery rather than a second round trip -- the pre-existing
// `computeNextStep` needed two queries (job context, then the doc probe)
// and `countRemainingRequirements` needed a third for the counts; there is
// now one statement behind all of it.
//
// No FOR UPDATE and no lock of any kind: a row lock on `jobs` needs the
// UPDATE privilege that jale_whatsapp deliberately lacks (ADR-W05), and
// nothing here needs one -- merges commute (jsonb `||`), prompt answers are
// write-once at SQL level, and `details_completed_at` is guarded by
// `IS NULL`. That is why the stage-2 door carries no lockVersion.
const SNAPSHOT_SQL = `SELECT ja.id, ja.worker_id, ja.job_id,
            ja.status AS application_status,
            ja.application_answers, ja.prompt_answers,
            ja.details_requested_at, ja.details_completed_at,
            ja.applied_at, ja.updated_at,
            j.status AS job_status, j.title AS job_title,
            j.required_fields, j.optional_fields,
            j.required_docs, j.optional_docs,
            j.certification_requirements, j.pre_application_prompts,
            ARRAY(SELECT DISTINCT wd.doc_type
                    FROM worker_documents wd
                   WHERE wd.worker_id = ja.worker_id
                     AND wd.job_id = ja.job_id) AS have_docs
       FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
      WHERE ja.id = $1`;

function toSnapshot(row: RequirementRow): RequirementSnapshot {
  return {
    applicationId: row.id,
    workerId: row.worker_id,
    jobId: row.job_id,
    applicationStatus: row.application_status,
    jobStatus: row.job_status,
    jobTitle: row.job_title ?? null,
    answers: row.application_answers ?? {},
    promptAnswers: row.prompt_answers ?? {},
    prompts: parsePreApplicationPromptList(row.pre_application_prompts),
    requiredFields: row.required_fields ?? [],
    optionalFields: row.optional_fields ?? [],
    requiredDocs: row.required_docs ?? [],
    optionalDocs: row.optional_docs ?? [],
    certificationRequirements: parseCertificationRequirements(row.certification_requirements),
    haveDocs: row.have_docs ?? [],
    detailsRequestedAt: row.details_requested_at ?? null,
    detailsCompletedAt: row.details_completed_at ?? null,
    appliedAt: row.applied_at ?? null,
    updatedAt: row.updated_at ?? null,
    // B4.0 §7: the fill gates on TIMESTAMPS, not on the literal status, so
    // moving a `details_requested` applicant on to `contacted`/`talking`
    // keeps stage 2 alive.
    stage: row.details_requested_at ? 'details' : 'apply',
    // Filled in by the sync path only (see the field's own jsdoc).
    copiedDocuments: [],
  };
}

/**
 * Loads everything the pure functions below need, in one SELECT.
 *
 * `syncDocumentSnapshots` (worker sessions only) copies the worker's vault
 * docs onto this job first, then RE-READS `have_docs`, so the job-scoped
 * count this engine and 091's hire gate both use agrees with what the
 * worker actually holds. It sets `app.current_internal_user_id` itself --
 * the only place in this module that touches a GUC -- because
 * `copyRequiredDocumentSnapshots` WRITES to worker_documents, which is
 * FORCE RLS (005). A job that asks for no documents at all skips the whole
 * sync (no GUC, no copy, no re-read).
 *
 * Returns null for a vanished application (deleted, or its job
 * CASCADE-deleted); `nextStep(null)` turns that into `exit/application_gone`.
 */
export async function loadRequirementSnapshot(
  client: PoolClient,
  applicationId: string,
  options: { syncDocumentSnapshots?: boolean } = {},
): Promise<RequirementSnapshot | null> {
  const res = await client.query<RequirementRow>(SNAPSHOT_SQL, [applicationId]);
  const row = res.rows[0];
  if (!row) return null;

  const snapshot = toSnapshot(row);
  if (!options.syncDocumentSnapshots) return snapshot;

  const docTypes = Array.from(new Set([...snapshot.requiredDocs, ...snapshot.optionalDocs]));
  if (docTypes.length === 0) return snapshot;

  await setInternalUserRlsContext(client, snapshot.workerId);
  const copiedDocuments = await copyRequiredDocumentSnapshots(
    client, snapshot.workerId, snapshot.jobId, docTypes,
  );

  const docsRes = await client.query<{ doc_type: string }>(
    `SELECT DISTINCT doc_type FROM worker_documents WHERE worker_id = $1 AND job_id = $2`,
    [snapshot.workerId, snapshot.jobId],
  );
  return { ...snapshot, haveDocs: docsRes.rows.map((r) => r.doc_type), copiedDocuments };
}

// ── Pure derivation ──────────────────────────────────────────────────────

/** The claims stored under the reserved 'certifications' answers key. */
function storedClaims(snapshot: RequirementSnapshot): CertificationClaim[] {
  const raw = snapshot.answers.certifications;
  // Fails open on a corrupt value: a non-array reads as "nothing claimed",
  // so every required cert shows up as a gap instead of throwing. Same
  // house rule as parseCertificationRequirements.
  return Array.isArray(raw) ? (raw as CertificationClaim[]) : [];
}

/**
 * Everything still outstanding. PURE -- no DB, no GUC, no clock -- so
 * employer read endpoints can call it on a row they already selected and
 * get exactly the answer the worker's own door would give.
 *
 * Presence is `hasOwnProperty`, not truthiness: a stored `false` or `null`
 * counts as ANSWERED (matching the pre-existing `computeNextStep`
 * convention -- "no, I have not worked here before" is an answer). Array
 * order is the job's column order in every bucket, so widening or
 * re-ordering `required_fields` takes effect on the very next call.
 *
 * `complete` deliberately ignores optional fields/docs and uncollectable
 * docs: those can never be finished by the worker through any flow, so
 * blocking on them would strand the application forever.
 */
export function computeRemaining(snapshot: RequirementSnapshot): Remaining {
  const { answers } = snapshot;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(answers, key);

  const prompts = snapshot.prompts
    .filter((prompt) => !Object.prototype.hasOwnProperty.call(snapshot.promptAnswers, prompt.id))
    .map((prompt) => prompt.id);

  const fields = snapshot.requiredFields.filter((key) => !has(key));
  const optionalFields = snapshot.optionalFields.filter((key) => !has(key));

  const haveDocs = new Set(snapshot.haveDocs);
  const uncollectableDocs = snapshot.requiredDocs.filter((docType) => !COLLECTABLE.has(docType));
  const docs = snapshot.requiredDocs.filter(
    (docType) => COLLECTABLE.has(docType) && !haveDocs.has(docType),
  );
  const optionalDocs = snapshot.optionalDocs.filter(
    (docType) => COLLECTABLE.has(docType) && !haveDocs.has(docType),
  );

  const certifications = findMissingCertifications(
    storedClaims(snapshot),
    snapshot.certificationRequirements,
  );
  const nCerts = certifications.unclaimed.length + certifications.unproven.length;

  return {
    prompts,
    fields,
    certifications,
    docs,
    uncollectableDocs,
    optionalFields,
    optionalDocs,
    counts: {
      prompts: prompts.length,
      fields: fields.length,
      certifications: nCerts,
      docs: docs.length,
    },
    complete: prompts.length === 0 && fields.length === 0 && nCerts === 0 && docs.length === 0,
  };
}

/**
 * The single "what do I ask for next" verdict, re-derived from the snapshot
 * every call -- never from cached flow state -- so an employer editing the
 * job's requirements mid-fill is reflected on the very next turn.
 *
 * ORDER (binding):
 *   1. exits   -- a gone application, a filled/closed job, or a
 *                 hired/not_interested application ends the flow before any
 *                 question is asked. 'paused' jobs and the new
 *                 'details_requested' status are NOT exits.
 *   2. prompts -- stage 1's only question, and the first thing asked in
 *                 stage 2 as well (a WhatsApp worker who said `cancelar`
 *                 mid-prompt keeps a partial set and finishes it here).
 *   3. complete/apply -- THE STAGE GATE. Until the employer requests
 *                 details, fields, certifications and docs are never asked.
 *   4. fields  -- `required_fields` column order.
 *   5. certifications -- unclaimed first, then unproven: you cannot
 *                 meaningfully ask "where is the proof" for a cert the
 *                 worker has not claimed yet.
 *   6. docs    -- collectable required docs only.
 *   7. complete/details.
 */
export function nextStep(snapshot: RequirementSnapshot | null): RequirementStep {
  if (!snapshot) return { kind: 'exit', reason: 'application_gone' };

  if (snapshot.jobStatus === 'filled' || snapshot.jobStatus === 'closed') {
    return { kind: 'exit', reason: 'job_inactive' };
  }
  if (snapshot.applicationStatus === 'hired' || snapshot.applicationStatus === 'not_interested') {
    return { kind: 'exit', reason: 'application_closed' };
  }

  const remaining = computeRemaining(snapshot);

  const promptId = remaining.prompts[0];
  if (promptId !== undefined) {
    const prompt = snapshot.prompts.find((entry) => entry.id === promptId)!;
    return { kind: 'prompt', promptId: prompt.id, text: prompt.text };
  }

  if (snapshot.stage === 'apply') return { kind: 'complete', stage: 'apply' };

  const fieldKey = remaining.fields[0];
  if (fieldKey !== undefined) return { kind: 'field', key: fieldKey };

  const certName = remaining.certifications.unclaimed[0] ?? remaining.certifications.unproven[0];
  if (certName !== undefined) {
    const req = snapshot.certificationRequirements.find((entry) => entry.name === certName)!;
    return { kind: 'certification', name: req.name, proofRequired: req.proof_required };
  }

  const docType = remaining.docs[0];
  if (docType !== undefined) return { kind: 'doc', docType };

  return { kind: 'complete', stage: 'details' };
}

/**
 * The employer-facing / API-facing stage label, derived from the two
 * TIMESTAMPTZ columns (B4.0 §7) rather than the literal status, so
 * `details_requested -> contacted` does not silently reset it.
 *
 *   not_requested  the employer has not asked yet (details_requested_at NULL)
 *   requested      asked, still outstanding
 *   complete       details_completed_at is set, OR `remaining` says nothing
 *                  is left -- the second case covers the window between a
 *                  worker uploading the last doc through /worker/vault/* and
 *                  `markDetailsCompleteIfDone` flipping the timestamp on the
 *                  next read.
 *
 * `remaining` never PROMOTES a not-yet-requested application: an applicant
 * whose vault happens to satisfy a job must not read as "details complete"
 * before anyone asked.
 */
export function detailsStatusFor(
  row: { details_requested_at?: unknown; details_completed_at?: unknown },
  remaining?: Remaining,
): DetailsStatus {
  if (row.details_completed_at) return 'complete';
  if (!row.details_requested_at) return 'not_requested';
  return remaining?.complete ? 'complete' : 'requested';
}

// ── Compat wrappers (the WhatsApp lane swaps only the import path) ───────

export type NextStep =
  | { kind: 'field'; key: string; uncollectable: string[] }
  | { kind: 'doc'; docType: string; uncollectable: string[] }
  | { kind: 'exit'; reason: 'job_inactive' | 'application_gone' | 'application_closed'; uncollectable: string[] }
  | { kind: 'complete'; uncollectable: string[] };

export interface FillCounts {
  nFields: number;
  nDocs: number;
  nCerts: number;
  nPrompts: number;
  uncollectable: string[];
}

/**
 * The pre-existing `application-fill.ts:85` contract, preserved byte-for-
 * byte in shape: the SAME FOUR kinds (`field | doc | exit | complete`), each
 * carrying `uncollectable`, and the same fields-then-docs walk.
 *
 * DELIBERATELY NARROWER THAN `nextStep`: the new `prompt` and
 * `certification` kinds are NEVER returned here, so the existing exhaustive
 * `switch (step.kind)` in the WhatsApp flow keeps compiling and keeps
 * behaving identically after the import swap. Those two steps have their own
 * lanes; reach them through `nextStep` when wiring them up.
 *
 * Also unlike `nextStep`, this does not apply the stage gate: a
 * pre-sprint-23 caller that armed the fill flow at accept time still gets
 * `field`/`doc` steps. Sequence the stage gate in when the fill flow is
 * re-armed from the details-requested notification.
 *
 * Syncs vault docs onto the job (see the header) -- the pre-existing version
 * probed vault-inclusively and set the RLS GUC itself, and this preserves
 * both behaviors.
 */
export async function computeNextStep(client: PoolClient, applicationId: string): Promise<NextStep> {
  const snapshot = await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true });
  if (!snapshot) return { kind: 'exit', reason: 'application_gone', uncollectable: [] };

  const remaining = computeRemaining(snapshot);
  const uncollectable = remaining.uncollectableDocs;

  if (snapshot.jobStatus === 'filled' || snapshot.jobStatus === 'closed') {
    return { kind: 'exit', reason: 'job_inactive', uncollectable };
  }
  if (snapshot.applicationStatus === 'hired' || snapshot.applicationStatus === 'not_interested') {
    return { kind: 'exit', reason: 'application_closed', uncollectable };
  }

  const fieldKey = remaining.fields[0];
  if (fieldKey !== undefined) return { kind: 'field', key: fieldKey, uncollectable };

  const docType = remaining.docs[0];
  if (docType !== undefined) return { kind: 'doc', docType, uncollectable };

  return { kind: 'complete', uncollectable };
}

/**
 * The intro's "N questions and M documents" counts
 * (`application-fill.ts:159`). `nFields`, `nDocs` and `uncollectable` keep
 * their exact former meanings; `nCerts` and `nPrompts` are ADDITIVE, so an
 * existing destructuring caller is unaffected.
 *
 * Unlike the pre-existing version this no longer requires the caller to have
 * already set the RLS GUC -- the shared load path sets it as part of the doc
 * sync when the job asks for any documents.
 */
export async function countRemainingRequirements(
  client: PoolClient,
  applicationId: string,
): Promise<FillCounts> {
  const snapshot = await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true });
  if (!snapshot) return { nFields: 0, nDocs: 0, nCerts: 0, nPrompts: 0, uncollectable: [] };

  const remaining = computeRemaining(snapshot);
  return {
    nFields: remaining.counts.fields,
    nDocs: remaining.counts.docs,
    nCerts: remaining.counts.certifications,
    nPrompts: remaining.counts.prompts,
    uncollectable: remaining.uncollectableDocs,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────

export type MergeFailureReason =
  | 'not_found'
  | 'closed'
  | 'stage_locked'
  | 'too_large'
  | 'certification_document_limit';

export type MergeFieldAnswersResult =
  | { ok: true; keys: string[]; detailsCompleted: boolean }
  | { ok: false; reason: 'invalid'; errors: Record<string, string> }
  | { ok: false; reason: MergeFailureReason };

export type MergeCertificationClaimsResult =
  | { ok: true; certifications: CertificationClaim[]; detailsCompleted: boolean }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: MergeFailureReason };

export type MergePromptAnswersResult =
  | { ok: true; keys: string[] }
  | { ok: false; reason: 'invalid' | 'not_found' | 'closed' | 'too_large' };

/**
 * THE single UPDATE statement that ever writes
 * `job_applications.application_answers` from the shared engine -- every
 * merge path (`mergeFieldAnswers`, `mergeCertificationClaims`,
 * `seedAnswersFromDefaults`, and the WhatsApp per-turn `mergeAnswer` once it
 * imports from here) goes through it, so the `||`-merge SQL text exists in
 * exactly one place.
 *
 * BINDING -- DO NOT ADD A QUERY HERE. The statement text and the
 * `[mergedJson, applicationId]` parameter pair are regex-pinned by
 * `infra/test/unit/lambda/whatsapp/lib/application-fill.test.ts` (~:496) as
 * `mockQuery.mock.calls[1]`. Taking a SAVEPOINT inside this function (as an
 * earlier draft of the design had it) would shift the UPDATE to `calls[2]`
 * and break that pin the moment the WhatsApp lane swaps its import. The
 * size guard therefore lives in the CALLER (`withSizeGuard`), and this
 * function issues exactly ONE query. The appended RETURNING is safe: the
 * pin's regex is unanchored and adds no parameter.
 *
 * The returned `total` is the post-merge column size in CHARACTERS
 * (`length`, not `octet_length`) so it is directly comparable with
 * `MAX_ANSWERS_JSON_LENGTH`, which application-answers.ts measures as
 * `JSON.stringify(...).length`. `total` is null when the driver returned no
 * row (a caller/test double), in which case the caller must not treat the
 * size as breached.
 */
export async function persistMergedAnswers(
  client: PoolClient,
  applicationId: string,
  mergedJson: string,
): Promise<{ total: number | null }> {
  const res = await client.query<{ total: number }>(
    `UPDATE job_applications
        SET application_answers = application_answers || $1::jsonb, updated_at = now()
      WHERE id = $2
      RETURNING length(application_answers::text) AS total`,
    [mergedJson, applicationId],
  );
  const total = res.rows[0]?.total;
  return { total: total === undefined || total === null ? null : Number(total) };
}

/**
 * Runs one merge inside a SAVEPOINT and rolls it back if the POST-MERGE
 * column size breaches `cap`. A savepoint, not an app-side pre-check,
 * because the accumulated size is only knowable after the jsonb `||` has
 * actually been applied -- and rolling back to the savepoint leaves the
 * caller's own transaction (and every earlier statement in it) intact,
 * which a plain ROLLBACK would not. Transaction-local and always released
 * or rolled back, so the "engine never BEGIN/COMMITs" contract holds.
 */
async function withSizeGuard(
  client: PoolClient,
  cap: number,
  write: () => Promise<{ total: number | null }>,
): Promise<{ ok: true } | { ok: false; reason: 'too_large' }> {
  await client.query('SAVEPOINT application_requirements_merge');
  let total: number | null;
  try {
    ({ total } = await write());
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT application_requirements_merge');
    throw err;
  }
  if (total !== null && total > cap) {
    await client.query('ROLLBACK TO SAVEPOINT application_requirements_merge');
    return { ok: false, reason: 'too_large' };
  }
  await client.query('RELEASE SAVEPOINT application_requirements_merge');
  return { ok: true };
}

/**
 * The lifecycle gate every stage-2 write shares. `closed` outranks
 * `stage_locked`: a hired or rejected application is finished, not "come
 * back when the employer asks".
 */
function writeGate(
  snapshot: RequirementSnapshot,
  { requireDetailsStage }: { requireDetailsStage: boolean },
): { ok: false; reason: 'closed' | 'stage_locked' } | null {
  if (snapshot.applicationStatus === 'hired' || snapshot.applicationStatus === 'not_interested') {
    return { ok: false, reason: 'closed' };
  }
  if (snapshot.jobStatus === 'filled' || snapshot.jobStatus === 'closed') {
    return { ok: false, reason: 'closed' };
  }
  if (requireDetailsStage && snapshot.stage === 'apply') {
    return { ok: false, reason: 'stage_locked' };
  }
  return null;
}

/**
 * The stage-2 questionnaire door, for BOTH surfaces: web posts a batch of
 * 1..20 keys, the WhatsApp flow posts one confirmed key per turn.
 *
 * ALL-OR-NOTHING (B4.0 §5): each key is re-validated on its own via the
 * single-key `validateApplicationAnswers([key], [], {[key]: value})` shape
 * -- the same call the WhatsApp `mergeAnswer` used -- and ANY failure
 * rejects the whole batch with a `{key: reason}` map the frontend marks
 * fields from. Keys are re-derived from THIS job's
 * `required_fields`/`optional_fields`, so a key the job does not ask for is
 * `unknown_answer_key` (which is also what keeps the reserved
 * 'certifications' key out of this door -- 073/074's CHECKs never list it).
 * Validated values are rebuilt from the validator's output, never spread
 * from the input.
 *
 * Then, in order: ONE merge UPDATE for the whole batch (bounded per-merge
 * and post-merge), the defaults write-back for BOTH doors (B4.0 §9 -- 091
 * grants jale_whatsapp the INSERT/UPDATE 081 deferred), and
 * `markDetailsCompleteIfDone`. A defaults failure is never swallowed: it
 * propagates so the caller rolls the whole merge back rather than committing
 * an answer whose default silently vanished.
 *
 * Doc snapshot copies can trip either 078 trigger cap; both collapse to
 * `certification_document_limit`, same as the apply path.
 *
 * `errors` and `toMerge` are built as null-prototype objects so a key like
 * `__proto__` lands as a real own property instead of silently hitting
 * `Object.prototype`'s accessor and vanishing from the error map.
 */
export async function mergeFieldAnswers(
  client: PoolClient,
  { applicationId, workerId, answers }: {
    applicationId: string;
    workerId: string;
    answers: Record<string, unknown>;
  },
): Promise<MergeFieldAnswersResult> {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    return { ok: false, reason: 'invalid', errors: {} };
  }
  const keys = Object.keys(answers);
  if (keys.length === 0) return { ok: false, reason: 'invalid', errors: {} };

  let snapshot: RequirementSnapshot | null;
  try {
    snapshot = await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true });
  } catch (err: any) {
    if (err?.code === '23514' && CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS.has(err?.constraint)) {
      return { ok: false, reason: 'certification_document_limit' };
    }
    throw err;
  }
  if (!snapshot) return { ok: false, reason: 'not_found' };
  const gated = writeGate(snapshot, { requireDetailsStage: true });
  if (gated) return gated;

  const allowed = new Set([...snapshot.requiredFields, ...snapshot.optionalFields]);
  const errors: Record<string, string> = Object.create(null) as Record<string, string>;
  const toMerge: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const key of keys) {
    if (!allowed.has(key)) {
      errors[key] = 'unknown_answer_key';
      continue;
    }
    const validated = validateApplicationAnswers([key], [], { [key]: answers[key] });
    if (!validated.ok) {
      errors[key] = validated.error;
      continue;
    }
    toMerge[key] = (validated.value as Record<string, unknown>)[key];
  }

  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };
  if (Object.keys(toMerge).length === 0) return { ok: false, reason: 'invalid', errors };

  const mergedJson = JSON.stringify(toMerge);
  if (mergedJson.length > MAX_PER_MERGE_JSON_LENGTH) return { ok: false, reason: 'too_large' };

  const guarded = await withSizeGuard(client, MAX_ANSWERS_JSON_LENGTH, () =>
    persistMergedAnswers(client, applicationId, mergedJson),
  );
  if (!guarded.ok) return guarded;

  // THE REUSE FILTER (sprint 24 L3, decision D2). Every answered key lands on
  // the APPLICATION above -- the employer asked for them -- but only the
  // 'stable' ones may be remembered as a cross-application default. Filtered
  // HERE as well as inside `upsertWorkerApplicationDefaults` on purpose: this
  // is the call site the incident went through, and an all-per_application
  // batch must issue no defaults statement at all.
  const reusable = filterReusableDefaults(toMerge);
  if (Object.keys(reusable).length > 0) {
    await upsertWorkerApplicationDefaults(client, workerId, reusable);
  }

  const detailsCompleted = await markDetailsCompleteIfDone(client, applicationId, {
    ...snapshot,
    answers: { ...snapshot.answers, ...toMerge },
  });

  return { ok: true, keys: Object.keys(toMerge), detailsCompleted };
}

/**
 * The stage-2 certification door. Three steps, in order:
 *   1. `normalizeCertificationClaims` -- shape only, dropping names the job
 *      no longer asks for (tier drift). NOT `validateCertificationClaims`:
 *      stage 2 accepts partial progress, and what is still missing is
 *      reported by `computeRemaining`, not rejected here.
 *   2. `resolveCertificationDocIds` -- the DB half. Every claimed doc id
 *      must be a `worker_documents` row OWNED BY THIS WORKER with
 *      doc_type = 'certification_doc' (a legacy unlabeled cert file --
 *      cert_name NULL -- is still valid proof; cert_name is never
 *      compared). An id that fails is DROPPED from its claim rather than
 *      failing the claim, so a claim with one other valid id still stands.
 *      This is what keeps a stray or hostile id another worker's document
 *      out of the column.
 *   3. Union BY NAME with what is already stored, new claim wins for a
 *      given name (latest answer wins), so answering one certification
 *      never erases another.
 *
 * Doc snapshot copies can trip either 078 trigger cap; both collapse to
 * `certification_document_limit`, same as the apply path.
 */
export async function mergeCertificationClaims(
  client: PoolClient,
  { applicationId, workerId, claims }: {
    applicationId: string;
    workerId: string;
    claims: unknown;
  },
): Promise<MergeCertificationClaimsResult> {
  let snapshot: RequirementSnapshot | null;
  try {
    snapshot = await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true });
  } catch (err: any) {
    if (err?.code === '23514' && CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS.has(err?.constraint)) {
      return { ok: false, reason: 'certification_document_limit' };
    }
    throw err;
  }
  if (!snapshot) return { ok: false, reason: 'not_found' };
  const gated = writeGate(snapshot, { requireDetailsStage: true });
  if (gated) return gated;

  const normalized = normalizeCertificationClaims(claims, snapshot.certificationRequirements);
  if (normalized === null) return { ok: false, reason: 'invalid' };

  const allDocIds = Array.from(new Set(normalized.flatMap((claim) => claim.doc_ids ?? [])));
  const validDocIds = await resolveCertificationDocIds(client, workerId, allDocIds);
  const confirmed = normalized.map((claim) =>
    claim.doc_ids ? { ...claim, doc_ids: claim.doc_ids.filter((id) => validDocIds.has(id)) } : claim,
  );

  const byName = new Map<string, CertificationClaim>(
    storedClaims(snapshot).map((claim) => [claim.name, claim] as const),
  );
  for (const claim of confirmed) byName.set(claim.name, claim);
  const certifications = Array.from(byName.values());

  const guarded = await withSizeGuard(client, MAX_ANSWERS_JSON_LENGTH, () =>
    persistMergedAnswers(client, applicationId, JSON.stringify({ certifications })),
  );
  if (!guarded.ok) return guarded;

  const detailsCompleted = await markDetailsCompleteIfDone(client, applicationId, {
    ...snapshot,
    answers: { ...snapshot.answers, certifications },
  });

  return { ok: true, certifications, detailsCompleted };
}

/**
 * The prompt-answers door (stage 1's questions, answerable from either
 * surface). WRITE-ONCE PER ID, enforced by SQL rather than by a read-then-
 * write race: the NEW object is on the LEFT of `||`, so for a key present
 * in both, the EXISTING (right-hand) value wins.
 *
 *   prompt_answers = $1::jsonb || prompt_answers
 *
 * Accepts a PARTIAL set (`normalizePromptAnswers`, not
 * `validatePromptAnswers`): a WhatsApp worker who said `cancelar` mid-prompt
 * keeps the application with what they had, and tops the rest up later here.
 * Not stage-gated -- prompts belong to the apply stage, and this is the only
 * write door that works there.
 *
 * The post-merge total is bounded in OCTETS, matching 091's
 * `job_applications_prompt_answers_valid` CHECK
 * (`octet_length(prompt_answers::text) <= 16384`): the per-answer byte
 * guard in `normalizePromptAnswers` only ever sees THIS call's object,
 * never the accumulated column.
 *
 * TWO layers guard that, both needed. The `withSizeGuard` savepoint
 * measures the post-merge size and rolls back cleanly -- but it can only
 * fire if the CHECK let the row through first. When the app-side constant
 * and the DB CHECK disagree (they are hand-synced across two lanes), or the
 * CHECK measures a slightly different expression, Postgres raises the
 * 23514 instead. Mapping that constraint to the SAME `too_large` reason
 * means a byte overflow from emoji or CJK answers is a clean 400 at the
 * door either way, never a 500. The savepoint is what makes the caller's
 * transaction survivable after that raise.
 */
export async function mergePromptAnswers(
  client: PoolClient,
  { applicationId, answers }: {
    applicationId: string;
    workerId?: string;
    answers: unknown;
  },
): Promise<MergePromptAnswersResult> {
  const snapshot = await loadRequirementSnapshot(client, applicationId);
  if (!snapshot) return { ok: false, reason: 'not_found' };
  const gated = writeGate(snapshot, { requireDetailsStage: false });
  if (gated) return { ok: false, reason: 'closed' };

  const normalized = normalizePromptAnswers(snapshot.prompts, answers);
  if (!normalized.ok) return { ok: false, reason: 'invalid' };

  const keys = Object.keys(normalized.value);
  if (keys.length === 0) return { ok: true, keys: [] };

  let guarded: { ok: true } | { ok: false; reason: 'too_large' };
  try {
    guarded = await withSizeGuard(client, MAX_PROMPT_ANSWERS_BYTES, async () => {
      const res = await client.query<{ total: number }>(
        `UPDATE job_applications
            SET prompt_answers = $1::jsonb || prompt_answers, updated_at = now()
          WHERE id = $2
          RETURNING octet_length(prompt_answers::text) AS total`,
        [JSON.stringify(normalized.value), applicationId],
      );
      const total = res.rows[0]?.total;
      return { total: total === undefined || total === null ? null : Number(total) };
    });
  } catch (err: any) {
    // withSizeGuard has already rolled back to its savepoint, so the
    // caller's transaction is intact and can still answer the request.
    if (err?.code === '23514' && err?.constraint === PROMPT_ANSWERS_CONSTRAINT) {
      return { ok: false, reason: 'too_large' };
    }
    throw err;
  }
  if (!guarded.ok) return guarded;

  return { ok: true, keys };
}

/**
 * Flips `details_completed_at` when, and only when, the details stage has
 * nothing outstanding. Called after every merge and on every stage-2 GET --
 * that GET call is what makes a doc uploaded through `/worker/vault/*`
 * (which never touches this module) complete the application on the next
 * read, so no explicit "POST complete" endpoint is needed.
 *
 * Three guards, all necessary:
 *   - stage must be 'details'. An apply-stage application whose worker
 *     happens to satisfy every requirement is NOT complete -- nobody asked
 *     yet, and `details_requested_at` is the employer handler's to write.
 *   - `computeRemaining().complete`.
 *   - `details_completed_at IS NULL` in the UPDATE itself, so a concurrent
 *     second call cannot move an already-recorded completion timestamp.
 *
 * Returns whether THIS call was the one that flipped it.
 */
export async function markDetailsCompleteIfDone(
  client: PoolClient,
  applicationId: string,
  snapshot?: RequirementSnapshot | null,
): Promise<boolean> {
  const snap = snapshot === undefined
    ? await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true })
    : snapshot;
  if (!snap) return false;
  if (snap.stage !== 'details') return false;
  if (!computeRemaining(snap).complete) return false;

  const res = await client.query(
    `UPDATE job_applications
        SET details_completed_at = now(), updated_at = now()
      WHERE id = $1
        AND details_completed_at IS NULL`,
    [applicationId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Pre-fills an application's answers from the worker's saved
 * `worker_application_defaults` row, so a worker who already answered these
 * questions on a past application is not re-asked. Lifted verbatim from
 * `application-fill.ts:735` (which armed it at accept time); per B4.0 §9 it
 * now runs at the STAGE-2 ARM instead -- there is nothing to pre-fill until
 * the employer has asked for details.
 *
 * Contract (unchanged by the lift):
 *   - The GUC is set FIRST, before any SELECT: worker_application_defaults
 *     is FORCE RLS (079/081).
 *   - A key is a seed candidate only if it is (a) relevant to THIS job
 *     (present in requiredFields/optionalFields), (b) present in the
 *     defaults row, and (c) ABSENT from the application's current
 *     `application_answers` by `hasOwnProperty` -- a stored `false`/`null`
 *     already counts as answered.
 *   - Every candidate is re-validated with the same single-key
 *     `validateApplicationAnswers` shape a live answer gets: a defaults row
 *     is worker-supplied history, not trusted-by-construction, and a
 *     validator can legitimately tighten between when it was saved and now.
 *     A key that fails is skipped SILENTLY -- the bot simply asks the
 *     question, exactly as if no default existed.
 *   - Everything that validates is merged in exactly ONE UPDATE, through
 *     `persistMergedAnswers`.
 *   - Returns the seeded key NAMES ONLY (metadata-only logging), never the
 *     values. Short-circuits with no `job_applications` SELECT and no
 *     UPDATE when the worker has no defaults row or its `answers` is empty
 *     -- the common case for a first application.
 */
export async function seedAnswersFromDefaults(
  client: PoolClient,
  { applicationId, workerId }: { applicationId: string; workerId: string },
  requiredFields: readonly string[],
  optionalFields: readonly string[],
): Promise<string[]> {
  await setInternalUserRlsContext(client, workerId);

  const defaults = await loadWorkerApplicationDefaults(client, workerId);
  if (Object.keys(defaults).length === 0) return [];

  const appRes = await client.query<{ application_answers: Record<string, unknown> | null }>(
    `SELECT application_answers FROM job_applications WHERE id = $1`,
    [applicationId],
  );
  const currentAnswers = appRes.rows[0]?.application_answers ?? {};

  const seeded: string[] = [];
  const toMerge: Record<string, unknown> = {};
  for (const key of [...requiredFields, ...optionalFields]) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
    if (Object.prototype.hasOwnProperty.call(currentAnswers, key)) continue;
    // THE REUSE GATE (sprint 24 L3, decision D2). Checked AFTER the
    // already-answered check so the log line means what it says -- "a
    // default for this key existed and we would have used it, but this key
    // is not reusable" -- and never fires for a key that was going to be
    // skipped anyway. A legacy defaults row written before the policy
    // existed still holds these keys, which is why the refusal is logged
    // rather than silent: it is the signal that such a row is being read.
    if (!isReusableField(key)) {
      logStep(key, 'seed_skipped', 'per_application');
      continue;
    }
    const validated = validateApplicationAnswers([key], [], { [key]: defaults[key] });
    if (!validated.ok) {
      logStep(key, 'seed_skipped', 'invalid_default');
      continue;
    }
    toMerge[key] = (validated.value as Record<string, unknown>)[key];
    seeded.push(key);
  }

  if (seeded.length === 0) return [];

  await persistMergedAnswers(client, applicationId, JSON.stringify(toMerge));
  for (const key of seeded) logStep(key, 'seeded');
  return seeded;
}

/**
 * Removes ONE answer key from ONE application (sprint 24 L3, decision D3's
 * correction path -- the WhatsApp CAMBIAR / web "fix this" flow).
 *
 * The inverse of a single-key merge, and deliberately NOT a merge of `null`:
 * `computeRemaining` treats presence by `hasOwnProperty`, so a stored `null`
 * still reads as ANSWERED and the question would never be re-asked. The
 * jsonb `-` operator actually deletes the key, which puts the field back in
 * `remaining.fields` and therefore back in the next step.
 *
 * NEVER touches `worker_application_defaults`: correcting what one employer
 * sees is not an edit to the worker's saved profile answers. (Re-answering
 * the question writes the new value back through `mergeFieldAnswers`, which
 * is where a stable key legitimately updates the default.)
 *
 * `details_completed_at IS NULL` is a fail-safe, not a nicety: punching a
 * hole in an application the employer already sees as complete would leave a
 * row that 091's BEFORE-UPDATE hire gate rejects at hire time. Returns
 * whether a row was actually changed, so a caller that raced a completion
 * can re-derive instead of claiming a correction that did not happen.
 *
 * RLS: `job_applications` is FORCE RLS and the only worker-side UPDATE
 * policy is `jobapp_whatsapp_update`, keyed on
 * `worker_id = app.current_internal_user_id` -- so the CALLER must have set
 * that GUC (module header, contract 2). Without it this is a silent
 * zero-row UPDATE, which is exactly what the returned boolean surfaces.
 */
export async function clearFieldAnswer(
  client: PoolClient,
  { applicationId, key }: { applicationId: string; key: string },
): Promise<boolean> {
  const res = await client.query(
    `UPDATE job_applications
        SET application_answers = application_answers - $1::text, updated_at = now()
      WHERE id = $2
        AND details_completed_at IS NULL`,
    [key, applicationId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Reads 091's hire-gate rejection. The trigger raises 23514 with CONSTRAINT
 * `HIRE_REQUIREMENTS_CONSTRAINT` and a DETAIL payload of
 * `{fields, docs, certifications}` -- the employer status handler turns that
 * into 409 `details_incomplete {missing}` instead of a 500.
 *
 * Returns null for anything that is not that specific rejection, so an
 * unrelated CHECK violation keeps propagating. Degrades to all-empty
 * buckets (never throws, never forwards a non-string) when DETAIL is absent
 * or unparseable: the 409 is still the right answer even if we cannot say
 * exactly what is missing, and the buckets go straight into a JSON response
 * body.
 */
export function parseHireGateError(
  err: unknown,
): { fields: string[]; docs: string[]; certifications: string[] } | null {
  const candidate = err as { code?: unknown; constraint?: unknown; detail?: unknown } | undefined;
  if (!candidate || candidate.code !== '23514') return null;
  if (candidate.constraint !== HIRE_REQUIREMENTS_CONSTRAINT) return null;

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

  let parsed: unknown;
  try {
    parsed = typeof candidate.detail === 'string' ? JSON.parse(candidate.detail) : undefined;
  } catch {
    parsed = undefined;
  }
  const detail = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;

  return {
    fields: strings(detail.fields),
    docs: strings(detail.docs),
    certifications: strings(detail.certifications),
  };
}
