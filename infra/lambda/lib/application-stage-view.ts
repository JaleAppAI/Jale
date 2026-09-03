// application-stage-view.ts
//
// The READ-side adapter for the sprint-23 application-stage engine.
//
// `lib/application-requirements.ts` owns the truth: `computeRemaining` and
// `detailsStatusFor` are pure, and `loadRequirementSnapshot` is the one
// loader. But `loadRequirementSnapshot` is a per-application round trip, and
// employer/worker LIST endpoints already select the same columns in one
// joined query -- calling the loader per row would turn a single SELECT into
// N+1. This module closes that gap WITHOUT duplicating any derivation logic:
// it only re-shapes a row that already carries the snapshot's columns into a
// `RequirementSnapshot`, then defers to the pure functions.
//
// It is deliberately a separate file from application-requirements.ts (which
// is owned by the WhatsApp/apply lane and must not be edited here) and is
// pure by construction -- no `PoolClient`, no GUC, no clock.
//
// ── THE `have_docs` CONTRACT (read this before wiring a new caller) ──
// `RequirementSnapshot.haveDocs` is JOB-SCOPED: the doc types present on
// `worker_documents` rows whose `job_id` IS this job. That is what 091's
// hire gate measures and what `syncDocumentSnapshots` (worker sessions only)
// materializes. A worker's VAULT rows (`job_id IS NULL`) do NOT count until
// something copies them onto the job.
//
// Employer sessions may never run that copy (it writes to a FORCE-RLS table
// under a worker GUC), so every caller here passes the job-scoped set and
// accepts that `remaining.docs` can name a doc the worker already holds in
// their vault but has not yet attached to this job. That is the SAME answer
// the employer's hire gate will give, which is the point.
//
// Surfaces that answer the WORKER's question ("do I still need to upload
// this?") must keep using the vault-or-job predicate for their own
// user-facing key -- see `api/worker-jobs-detail.ts`, which feeds this module
// a job-scoped set for `remaining` while keeping its legacy vault-or-job
// `missing_docs`. The two can legitimately disagree on the same row.
import {
  computeRemaining,
  detailsStatusFor,
  type DetailsStatus,
  type Remaining,
  type RequirementSnapshot,
  type RequirementStage,
} from './application-requirements';
import { parseCertificationRequirements } from './certification-claims';
import {
  parsePreApplicationPromptList,
  type PreApplicationPrompt,
  type PromptAnswers,
} from './pre-application-prompts';

/**
 * The columns a caller must have selected. Every one is optional and every
 * one is `unknown`-tolerant on purpose: this is fed straight from `pg` rows
 * that differ per endpoint (`ja.id` vs `ja.id AS application_id`,
 * `ja.status` vs a CASE-remapped `status`), and a missing/NULL column must
 * degrade to the column default rather than throw.
 */
export interface StageRow {
  id?: unknown;
  application_id?: unknown;
  worker_id?: unknown;
  job_id?: unknown;
  /** Prefer the raw `ja.status`; `status` is accepted as a fallback. */
  application_status?: unknown;
  status?: unknown;
  job_status?: unknown;
  job_title?: unknown;
  application_answers?: unknown;
  prompt_answers?: unknown;
  details_requested_at?: unknown;
  details_completed_at?: unknown;
  applied_at?: unknown;
  updated_at?: unknown;
  required_fields?: unknown;
  optional_fields?: unknown;
  required_docs?: unknown;
  optional_docs?: unknown;
  certification_requirements?: unknown;
  pre_application_prompts?: unknown;
  have_docs?: unknown;
}

/** `Remaining` minus the three buckets no read endpoint publishes. */
export interface RemainingView {
  prompts: string[];
  fields: string[];
  certifications: { unclaimed: string[]; unproven: string[] };
  docs: string[];
  counts: { prompts: number; fields: number; certifications: number; docs: number };
  complete: boolean;
}

export interface StageView {
  details_status: DetailsStatus;
  stage: RequirementStage;
  remaining: RemainingView;
}

export interface PromptAnswerView {
  prompt_id: string;
  /** The prompt's text, or null when the job no longer asks this prompt. */
  question: string | null;
  text: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Stored `prompt_answers`, defensively. Fails OPEN like every other reader of
 * an already-stored jsonb column in this codebase: a non-object reads as "no
 * answers" and a non-string value is dropped, so a hand-edited row degrades
 * to "nothing answered" instead of 500-ing a read endpoint.
 */
function promptAnswersOf(value: unknown): PromptAnswers {
  if (!isPlainObject(value)) return {};
  const out: PromptAnswers = {};
  for (const key of Object.keys(value)) {
    const answer = value[key];
    if (typeof answer === 'string') out[key] = answer;
  }
  return out;
}

/**
 * Re-shapes an already-selected row into the exact object
 * `computeRemaining`/`nextStep` consume. NOT a substitute for
 * `loadRequirementSnapshot` -- it runs no query and performs no document
 * sync, so the caller owns having selected `have_docs` with the semantics
 * documented at the top of this file.
 *
 * Absent columns collapse to their DB defaults (`[]` / `{}` / NULL), which
 * is what lets a NOT-YET-APPLIED worker be described by the same code path:
 * pass the job's columns with no application columns and every requirement
 * comes back outstanding.
 */
export function snapshotFromRow(row: StageRow): RequirementSnapshot {
  return {
    applicationId: typeof row.id === 'string' ? row.id
      : typeof row.application_id === 'string' ? row.application_id : '',
    workerId: typeof row.worker_id === 'string' ? row.worker_id : '',
    jobId: typeof row.job_id === 'string' ? row.job_id : '',
    applicationStatus: typeof row.application_status === 'string' ? row.application_status : text(row.status),
    jobStatus: text(row.job_status),
    jobTitle: typeof row.job_title === 'string' ? row.job_title : null,
    answers: isPlainObject(row.application_answers) ? row.application_answers : {},
    promptAnswers: promptAnswersOf(row.prompt_answers),
    prompts: parsePreApplicationPromptList(row.pre_application_prompts),
    requiredFields: stringArray(row.required_fields),
    optionalFields: stringArray(row.optional_fields),
    requiredDocs: stringArray(row.required_docs),
    optionalDocs: stringArray(row.optional_docs),
    certificationRequirements: parseCertificationRequirements(row.certification_requirements),
    haveDocs: stringArray(row.have_docs),
    detailsRequestedAt: row.details_requested_at ?? null,
    detailsCompletedAt: row.details_completed_at ?? null,
    appliedAt: row.applied_at ?? null,
    updatedAt: row.updated_at ?? null,
    // Same rule as `toSnapshot` (application-requirements.ts): the stage is
    // derived from the TIMESTAMP, never from the literal status, so an
    // employer moving a `details_requested` applicant on to `contacted`
    // does not silently reset the stage.
    stage: row.details_requested_at ? 'details' : 'apply',
  };
}

/** Drops the three buckets read endpoints do not publish. */
export function remainingView(remaining: Remaining): RemainingView {
  return {
    prompts: remaining.prompts,
    fields: remaining.fields,
    certifications: remaining.certifications,
    docs: remaining.docs,
    counts: remaining.counts,
    complete: remaining.complete,
  };
}

/** Total outstanding items -- the single number a list row can badge on. */
export function remainingCount(remaining: Remaining | RemainingView): number {
  const { prompts, fields, certifications, docs } = remaining.counts;
  return prompts + fields + certifications + docs;
}

/**
 * The three shared response keys, in one call. `detailsStatusFor` is handed
 * the FULL `Remaining` (it reads `.complete`), and the trimmed view is what
 * ships.
 */
export function stageView(row: StageRow): StageView {
  const remaining = computeRemaining(snapshotFromRow(row));
  return {
    details_status: detailsStatusFor(
      { details_requested_at: row.details_requested_at, details_completed_at: row.details_completed_at },
      remaining,
    ),
    stage: row.details_requested_at ? 'details' : 'apply',
    remaining: remainingView(remaining),
  };
}

/**
 * Joins stored `prompt_answers` to the job's `pre_application_prompts` so a
 * reader never has to correlate two columns itself.
 *
 * Order is the job's prompt order (the order the worker was asked), and only
 * ANSWERED prompts appear -- an unanswered one is already reported by
 * `remaining.prompts`.
 *
 * An answer whose prompt id is no longer in the job's list is APPENDED with
 * `question: null` rather than dropped: an employer who deleted a prompt
 * after someone answered it must still see what was said, and the frontend
 * needs a way to render it as orphaned rather than mislabel it under a
 * neighbouring question.
 */
export function promptAnswersView(prompts: unknown, answers: unknown): PromptAnswerView[] {
  const known: PreApplicationPrompt[] = parsePreApplicationPromptList(prompts);
  const stored = promptAnswersOf(answers);
  const out: PromptAnswerView[] = [];
  const used = new Set<string>();

  for (const prompt of known) {
    if (!Object.prototype.hasOwnProperty.call(stored, prompt.id)) continue;
    used.add(prompt.id);
    out.push({ prompt_id: prompt.id, question: prompt.text, text: stored[prompt.id] });
  }
  for (const id of Object.keys(stored)) {
    if (used.has(id)) continue;
    out.push({ prompt_id: id, question: null, text: stored[id] });
  }
  return out;
}
