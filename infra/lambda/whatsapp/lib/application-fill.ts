/**
 * DB-derived progress engine for the WhatsApp application-fill flow (spec:
 * docs/superpowers/specs/2026-08-19-whatsapp-application-fill-design.md
 * §5/§9).
 *
 * `computeNextStep` is the ONLY source of truth for "what does this worker
 * need to answer/upload next" -- it re-derives the answer from the DB on
 * every call rather than trusting any cached fill-flow state, so a job's
 * `required_fields`/`required_docs` can widen or narrow mid-fill (an
 * employer editing requirements) and the very next turn reflects it. This
 * file intentionally exports ONLY `computeNextStep` and `NextStep` for now
 * -- later tasks add the fill-flow dispatcher here.
 *
 * Lifecycle exits (§9): the DB enums are the source of truth, not a
 * hand-maintained mirror --
 *   - jobs.status: 'active' | 'paused' | 'filled' | 'closed'
 *     (JOB_STATUSES, job-fields.ts) -- 'active'/'paused' continue the fill,
 *     'filled'/'closed' exit as `job_inactive`.
 *   - job_applications.status: 'pending' | 'contacted' | 'talking' |
 *     'hired' | 'not_interested' (APPLICATION_STATUSES, job-fields.ts) --
 *     'hired'/'not_interested' exit as `application_closed`, the other
 *     three continue.
 *   - A vanished application row (deleted, or its job CASCADE-deleted)
 *     exits as `application_gone`.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { setInternalUserRlsContext } from '../../lib/db';
import { DOC_TYPES, type PayInterval } from '../../lib/job-fields';
import { validateApplicationAnswers } from '../../lib/application-answers';
import {
  copyRequiredDocumentSnapshots,
  CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS,
} from '../../lib/applications';
import {
  fieldQuestion,
  fieldRetryHint,
  docPrompt,
  fillMessage,
  type FillFieldKey,
  type CollectableDocType,
  type FillMessageKey,
} from './application-fill-prompts';
import { extractFieldAnswer, type ExtractionClient } from './application-fill-extraction';
import type { IncomingMessage } from './conversation-router';
import { t, type Lang } from './templates';
import { REPROMPT_COOLDOWN_MS } from './onboarding-language';
import {
  sniffDocumentType,
  uploadDocumentToS3,
  MediaTooLargeError,
  ALLOWED_DOCUMENT_TYPES,
  detectMediaCategory,
} from './media';

export type NextStep =
  | { kind: 'field'; key: FillFieldKey; uncollectable: string[] }
  | { kind: 'doc'; docType: CollectableDocType; uncollectable: string[] }
  | { kind: 'exit'; reason: 'job_inactive' | 'application_gone' | 'application_closed'; uncollectable: string[] }
  | { kind: 'complete'; uncollectable: string[] };

// DOC_TYPES (job-fields.ts) already excludes 'ssn' -- legacy rows may still
// carry it (kept in DB CHECK constraints for that reason), but it can never
// be collected through this flow. See job-fields.ts's DOC_TYPES comment.
const COLLECTABLE = new Set<string>(DOC_TYPES);

/**
 * Computes the next unanswered required field, then the next missing
 * required doc, for a worker's job application -- or an exit/complete
 * verdict. Field keys are walked in `required_fields` array order using
 * `hasOwnProperty` presence (a stored `false`/`null` answer counts as
 * answered -- only an ABSENT key is unanswered), so re-ordering or widening
 * `required_fields` on the job takes effect on the very next call. Docs are
 * only checked once every field is answered, matching the design's
 * fields-before-docs ordering.
 */
export async function computeNextStep(client: PoolClient, applicationId: string): Promise<NextStep> {
  const appRes = await client.query(
    `SELECT ja.worker_id, ja.job_id, ja.status AS application_status,
            ja.application_answers, j.status AS job_status,
            j.required_fields, j.required_docs
       FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
      WHERE ja.id = $1`,
    [applicationId],
  );
  if (appRes.rows.length === 0) {
    return { kind: 'exit', reason: 'application_gone', uncollectable: [] };
  }
  const row = appRes.rows[0];
  const uncollectable: string[] = (row.required_docs ?? []).filter(
    (d: string) => !COLLECTABLE.has(d),
  );

  if (row.job_status === 'filled' || row.job_status === 'closed') {
    return { kind: 'exit', reason: 'job_inactive', uncollectable };
  }
  if (row.application_status === 'hired' || row.application_status === 'not_interested') {
    return { kind: 'exit', reason: 'application_closed', uncollectable };
  }

  const answers = row.application_answers ?? {};
  for (const key of row.required_fields ?? []) {
    if (!Object.prototype.hasOwnProperty.call(answers, key)) {
      return { kind: 'field', key, uncollectable };
    }
  }

  // worker_documents is FORCE ROW LEVEL SECURITY (005_document_vault.sql):
  // its SELECT policy requires app.current_internal_user_id = worker_id.
  // Without this, the query below silently returns zero rows and every
  // required doc reads as missing forever. Same house pattern as
  // applyWorkerToJob (../../lib/applications.ts).
  await setInternalUserRlsContext(client, row.worker_id);
  const docRes = await client.query(
    `SELECT DISTINCT doc_type FROM worker_documents
      WHERE worker_id = $1 AND (job_id IS NULL OR job_id = $2)`,
    [row.worker_id, row.job_id],
  );
  const have = new Set(docRes.rows.map((r: { doc_type: string }) => r.doc_type));
  for (const docType of row.required_docs ?? []) {
    if (!COLLECTABLE.has(docType)) continue;
    if (!have.has(docType)) return { kind: 'doc', docType, uncollectable };
  }

  return { kind: 'complete', uncollectable };
}

export interface FillCounts {
  nFields: number;
  nDocs: number;
  uncollectable: string[];
}

/**
 * Task 9: the intro's "N preguntas y M documentos" counts. A deliberately
 * SEPARATE query from `computeNextStep` (which only ever answers "what's
 * the very next gap", not "how many remain") -- one targeted SELECT that
 * mirrors computeNextStep's own two-query shape (job_applications JOIN jobs,
 * plus the worker_documents presence check) but folded into a single round
 * trip via a correlated subquery, since counting (unlike computeNextStep's
 * early-return walk) always needs both halves. Simplest-correct choice
 * (task brief): one extra SELECT, not N calls to computeNextStep in a loop.
 *
 * Callers MUST have already set the `app.current_internal_user_id` RLS GUC
 * this turn (worker_documents is FORCE RLS, 005_document_vault.sql, exactly
 * as in computeNextStep) -- this function does not set it itself, since by
 * the time the fill-arm intro is being built the caller
 * (`handleJobAction`/`seedAnswersFromDefaults` in processor.ts) always
 * already has.
 */
export async function countRemainingRequirements(
  client: PoolClient,
  applicationId: string,
): Promise<FillCounts> {
  const res = await client.query<{
    application_answers: Record<string, unknown> | null;
    required_fields: string[] | null;
    required_docs: string[] | null;
    have_docs: string[] | null;
  }>(
    `SELECT ja.application_answers, j.required_fields, j.required_docs,
            COALESCE((
              SELECT array_agg(DISTINCT wd.doc_type)
                FROM worker_documents wd
               WHERE wd.worker_id = ja.worker_id
                 AND (wd.job_id IS NULL OR wd.job_id = ja.job_id)
            ), '{}') AS have_docs
       FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
      WHERE ja.id = $1`,
    [applicationId],
  );
  const row = res.rows[0];
  if (!row) return { nFields: 0, nDocs: 0, uncollectable: [] };

  const answers = row.application_answers ?? {};
  const requiredFields = row.required_fields ?? [];
  const requiredDocs = row.required_docs ?? [];
  const have = new Set(row.have_docs ?? []);

  const nFields = requiredFields.filter(
    (key) => !Object.prototype.hasOwnProperty.call(answers, key),
  ).length;
  const uncollectable = requiredDocs.filter((d) => !COLLECTABLE.has(d));
  const nDocs = requiredDocs.filter((d) => COLLECTABLE.has(d) && !have.has(d)).length;

  return { nFields, nDocs, uncollectable };
}

// ─────────────────────────────────────────────────────────────────────────
// Task 7: `handleFillMessage` -- field-step collection (parse, extract,
// confirm). Task 8 adds document collection (media turns, doc-step free
// text). Escapes/dispatch-order (Task 10) are still NOT implemented here --
// structured as an early `{handled: false}` return so the processor falls
// back to normal routing until that task lands. Complete/exit prompting
// (Task 11) is a minimal placeholder (see `sendNextStepPrompt`).
//
// INVARIANT (binding, from Task 6 review): `handleFillMessage` and
// `promptNextStep` always run INSIDE the processor's per-turn transaction
// -- this module never issues BEGIN/COMMIT/ROLLBACK itself. That is also
// why `computeNextStep`'s `setInternalUserRlsContext` call (for the
// worker_documents check) sticks for the rest of the turn, and why every
// DB WRITE below runs after its own `deps.setRls(client, ctx.workerId)`
// call (see `mergeAnswer`) -- job_applications reads (this file's own
// `fetchApplicationJobId`, and `computeNextStep`'s SELECT) do not require
// the GUC, matching `computeNextStep`'s own precedent; only the
// worker_documents check and answer WRITES do.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fill-lane dependencies, injected the same way `RouterDeps` is injected
 * into `conversation-router.ts` so this module stays unit-testable without
 * processor mocks.
 *
 * `updateStateContext`'s contract is BINDING -- every handler below (and
 * the processor task that wires the real implementation) relies on it
 * doing BOTH of:
 *   1. Persisting the spread-merged `patch` into the conversation row's
 *      `state_context` column (a JSONB replace of the merged object, not a
 *      partial JSONB update).
 *   2. Mutating the SAME `ctx.stateContext` object in place, so a second
 *      read of `ctx.stateContext` later in the same turn (this module reads
 *      it repeatedly -- e.g. `fill_pending` right after clearing it) sees
 *      the patched value without a second DB round trip.
 */
export interface FillDeps {
  extraction: ExtractionClient;
  queueReplyText(client: PoolClient, inboundSid: string, to: string, body: string): Promise<void>;
  setRls(client: PoolClient, workerId: string): Promise<void>; // setInternalUserRlsContext
  updateStateContext(client: PoolClient, conversationId: string, patch: Record<string, unknown>): Promise<void>;
  nowMs(): number;
  // Task 8: downloads one Twilio media attachment, already bounded to the
  // document size cap. The real wiring (processor.ts) passes
  // `downloadTwilioMediaBounded(mediaUrl, accountSid, authToken,
  // MAX_DOCUMENT_BYTES)` (media.ts) -- this module never talks to Twilio
  // directly, only through this injected function, so it stays unit-
  // testable without a live Twilio credential. Throws MediaTooLargeError on
  // overage, or a plain Error on any other download failure -- both are
  // caught by `handleDocUpload` and turned into a reply, never rethrown.
  downloadMedia(mediaUrl: string): Promise<Buffer>;
  // Task 8: the S3 bucket documents are uploaded to (real wiring:
  // `process.env.DOCUMENTS_BUCKET`, the bucket `uploadDocumentToS3`
  // (media.ts) targets -- see documents-stack.ts).
  documentsBucket: string;
}

/**
 * Per-turn fill context. `jobId` is NOT read from `stateContext` -- it is
 * resolved fresh every turn (see `fetchApplicationJobId`) from
 * `fill_application_id` and surfaced onto this object before any step
 * handling runs, so Task 8's doc writes (scoped by `job_id`) always see the
 * current value even if the worker switched applications mid-turn.
 */
export interface FillContext {
  conversationId: string;
  workerId: string;
  jobId: string;
  lang: Lang;
  // Includes (not exhaustive -- other keys belong to other lanes):
  // fill_application_id, fill_pending?, fill_last_prompt_at?,
  // fill_relay_override?, fill_offer_application_id?, fill_cert_more_pending?
  // (Task 8 -- see handleFillMediaTurn's jsdoc for why certification_doc
  // needs its OWN loop flag distinct from fill_pending)
  stateContext: Record<string, unknown>;
}

/** `false` => the processor continues its normal (non-fill) routing. */
export type FillResult = { handled: true } | { handled: false };

// ── fill_pending shapes ─────────────────────────────────────────────────
//
// Scrub rule (spec §4.2, verbatim): fill_pending is KEPT across sanctioned
// interruptions (escapes, picker resolutions, the relay override -- none of
// which this task implements, so none of the code below touches it for
// those cases) and SCRUBBED on exactly: confirm, discard, anchor switch,
// CANCELAR, completion, lifecycle exit. §6's list matches; the two must
// stay identical. Task 7 implements confirm/discard/CANCELAR/completion+exit
// (the last two only as the Task 11 placeholder in `sendNextStepPrompt`);
// anchor switch is Task 8/10's `handleJobAction` new-accept path.
//
// Three stages cover both the single-value confirm loop and the per-entry
// array loop (`references`/`work_history`):
//   - 'confirm': awaiting yes/no on ONE candidate value (`extracted`). For
//     an array key, `entries` holds the entries already confirmed so far
//     (possibly empty) -- its mere presence (vs `undefined`) is what marks
//     this key as an array key throughout this module.
//   - 'entry_another': one entry just got confirmed into `entries`;
//     awaiting yes/no on "add another?".
//   - 'collecting': back to awaiting FREE TEXT for the next entry (no
//     confirm in flight) -- `entries` holds what's confirmed so far.
export interface FillPendingConfirm {
  key: FillFieldKey;
  stage: 'confirm';
  extracted: unknown;
  summaryVars?: Record<string, string>;
  entries?: unknown[];
}
export interface FillPendingEntryAnother {
  key: FillFieldKey;
  stage: 'entry_another';
  entries: unknown[];
}
export interface FillPendingCollecting {
  key: FillFieldKey;
  stage: 'collecting';
  entries: unknown[];
}
export type FillPendingState = FillPendingConfirm | FillPendingEntryAnother | FillPendingCollecting;

// references/work_history are the only two array-shaped answer keys
// (validator caps both at 3 entries) -- collected one entry per turn, per
// spec §7.
const ARRAY_FIELD_KEYS: ReadonlySet<FillFieldKey> = new Set(['references', 'work_history']);

// MUST mirror validateReferences/validateWorkHistory's `value.length > 3`
// cap (application-answers.ts) -- review finding: without this, a 4th
// CONFIRMED entry would sit in fill_pending.entries only to have the
// whole-array validation fail at finalize time, silently discarding every
// already-confirmed entry behind a generic single-entry retry hint. Once
// the cap is hit, the entry loop auto-finalizes instead of offering
// 'entry_another'.
const MAX_ARRAY_ENTRIES = 3;

// The 4 keys parseDeterministic understands; every other FillFieldKey goes
// through Bedrock extraction (application-fill-extraction.ts's own
// ExtractionKey union is exactly the complement of this set).
const DETERMINISTIC_KEYS: ReadonlySet<FillFieldKey> = new Set([
  'work_authorization',
  'date_of_birth',
  'date_available',
  'desired_pay',
]);

/** Structured, metadata-only log line (spec §11 / task brief): key names
 * and reason codes ONLY -- never message text, prompts, or extracted
 * values. */
function logStep(key: string, outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: 'ApplicationFillStep', key, outcome, reason }));
}

/** Exact 'cancelar' (case/trim-insensitive) -- deliberately NOT fuzzy.
 * Spec §6.2 requires (and a unit test locks) that this exact string sit
 * >1 Damerau-Levenshtein edit from every `COMMAND_KEYWORDS` entry in
 * flows.ts, so it can never collide with `matchCommandFuzzy`'s typo
 * tolerance for an unrelated command. */
export function isFillCancel(body: string): boolean {
  return body.trim().toLowerCase() === 'cancelar';
}

/** Confirmation reply for the `fill_pending` yes/no gates: '1'/'1 si'/bare
 * 'si'/'yes' -> 'yes'; '2'/'2 no'/bare 'no' -> 'no'; anything else -> null
 * (the caller re-echoes the confirmation, per spec §6 item 6 -- it never
 * silently re-extracts). Accent-insensitive ('sí' normalizes to 'si') since
 * WhatsApp keyboards for this audience often drop/mangle accents (same
 * house rationale as application-fill-prompts.ts's copy style). */
export function parseFillConfirmation(body: string): 'yes' | 'no' | null {
  const t = body
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
  if (t === '1' || t === '1 si' || t === '1 yes' || t === 'si' || t === 'yes') return 'yes';
  if (t === '2' || t === '2 no' || t === 'no') return 'no';
  return null;
}

// ── Deterministic per-key parsers (spec §7) ─────────────────────────────

const PAY_INTERVAL_WORDS: Record<string, PayInterval> = {
  hora: 'hourly',
  hour: 'hourly',
  dia: 'daily',
  day: 'daily',
  semana: 'weekly',
  week: 'weekly',
  mes: 'monthly',
  month: 'monthly',
  proyecto: 'fixed',
  project: 'fixed',
  // 'ano'/'year' deliberately absent: PAY_INTERVALS (job-fields.ts) has no
  // yearly value -- the parser returns null (re-prompt) rather than
  // guessing a nearest interval.
};

function normalizePayInterval(word: string | undefined): PayInterval | null {
  if (word === undefined) return null;
  return PAY_INTERVAL_WORDS[word] ?? null;
}

/** Never throws on garbage input -- every branch is a plain string
 * compare/regex match over an already-trimmed/lowercased string. */
function parseDeterministic(
  key: FillFieldKey,
  body: string,
): { value: unknown } | { pendingDate: string } | null {
  const t = body.trim().toLowerCase();
  switch (key) {
    case 'work_authorization': {
      if (t === '1' || t === 'si' || t === 'yes') return { value: true };
      if (t === '2' || t === 'no') return { value: false };
      return null;
    }
    case 'date_of_birth':
    case 'date_available': {
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? { pendingDate: t } : null; // real-date/age-bound checks happen at merge time
    }
    case 'desired_pay': {
      // Separator alternation MUST list the longer words ('an', 'al')
      // before the bare 'a' -- regex alternation commits to the FIRST
      // alternative that lets the (fully optional) rest of the pattern
      // proceed, and since everything after this group is optional, a
      // bare 'a' tried first would "succeed" by eating just the 'a' of
      // 'an'/'al', stranding the remaining letter and losing the interval
      // word entirely (review finding: the brief's original `al?` did
      // exactly this to "an hour", which application-fill-prompts.ts's own
      // desired_pay question/hint use as their worked example).
      const m = t
        .replace(',', '.')
        .match(
          /(\d{1,4})(?:\.\d+)?\s*(?:\$|dolares|dollars)?\s*(?:por|per|\/|an|al|a)?\s*(hora|hour|dia|day|semana|week|mes|month|ano|year|proyecto|project)?/,
        );
      if (!m || !m[1]) return null;
      const interval = normalizePayInterval(m[2]);
      return interval ? { value: { amount: Number(m[1]), interval } } : null;
    }
    default:
      return null; // the extraction bucket
  }
}

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** Unambiguous long-form echo for a date pending confirmation (spec §7:
 * MM/DD vs DD/MM ambiguity is real for this audience even though the
 * validator requires ISO input), e.g. "3 de abril de 1990". */
function formatLongDate(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split('-').map(Number);
  return lang === 'es' ? `${d} de ${MONTHS_ES[m - 1]} de ${y}` : `${MONTHS_EN[m - 1]} ${d}, ${y}`;
}

const PAY_INTERVAL_LABELS: Record<Lang, Record<PayInterval, string>> = {
  en: { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month', fixed: 'fixed price' },
  es: { hourly: 'hora', daily: 'dia', weekly: 'semana', monthly: 'mes', fixed: 'precio fijo' },
};

/** desired_pay has no confirmation step (spec §7) -- this is the "echoed
 * normalized in the next prompt" text folded into the following question. */
function buildPayEcho(lang: Lang, amount: number, interval: PayInterval): string {
  const label = PAY_INTERVAL_LABELS[lang][interval];
  return lang === 'es' ? `Listo: $${amount} por ${label}.` : `Got it: $${amount} per ${label}.`;
}

/** Generic extraction-summary echo, built from `ExtractionOutcome`'s
 * `summaryVars` (application-fill-extraction.ts's `buildSummaryVars` --
 * exactly one value per key). Language-neutral lead-in only; the display
 * string itself already carries whatever the worker said. */
function buildSummaryLine(lang: Lang, vars: Record<string, string>): string {
  const value = Object.values(vars)[0] ?? '';
  return lang === 'es' ? `Dijiste: ${value}` : `You said: ${value}`;
}

function mapExtractionFailure(
  reason: 'low_confidence' | 'invalid' | 'too_long' | 'bedrock_error',
  key: FillFieldKey,
  lang: Lang,
): string {
  switch (reason) {
    case 'too_long':
      return fillMessage('answer_too_long', lang);
    case 'bedrock_error':
      return fillMessage('guard_error', lang);
    case 'low_confidence':
    case 'invalid':
      return fieldRetryHint(key, lang);
  }
}

// ── Merge choke point (spec §4.3) ───────────────────────────────────────

type MergeResult = { ok: true } | { ok: false; reason: 'invalid' | 'too_large' };

/**
 * THE single UPDATE statement that ever writes `job_applications
 * .application_answers` from this module -- both `mergeAnswer` (one
 * worker-confirmed key per call) and `seedAnswersFromDefaults` (Task 9, a
 * batch of pre-seeded keys in one call) go through this, so the `||`-merge
 * SQL text exists in exactly one place. Caller is responsible for having
 * already called `deps.setRls` in this turn (job_applications UPDATEs are
 * not RLS-gated the way worker_documents is, but every write in this module
 * runs after the RLS GUC is set anyway, by convention -- see mergeAnswer's
 * own call order test).
 */
async function persistMergedAnswers(
  client: PoolClient,
  applicationId: string,
  mergedJson: string,
): Promise<void> {
  await client.query(
    `UPDATE job_applications
        SET application_answers = application_answers || $1::jsonb, updated_at = now()
      WHERE id = $2`,
    [mergedJson, applicationId],
  );
}

/**
 * The ONLY path from an extracted/parsed value to the DB. Re-validates
 * (defense in depth -- extraction/deterministic parsing already produced a
 * plausible value, but this is the last gate before a write) via
 * `validateApplicationAnswers`, which rebuilds a fresh object from
 * validated fields only -- `merged` is never built from the raw input.
 * The 8192-byte check is a backstop (spec §12): per-key validator bounds
 * already keep every real shape far under this, but a future validator
 * change should fail loud here rather than silently growing the column.
 */
async function mergeAnswer(
  client: PoolClient,
  ctx: FillContext,
  key: FillFieldKey,
  value: unknown,
  deps: FillDeps,
): Promise<MergeResult> {
  const validated = validateApplicationAnswers([key], [], { [key]: value });
  if (!validated.ok) return { ok: false, reason: 'invalid' };
  const merged = JSON.stringify({ [key]: (validated.value as Record<string, unknown>)[key] });
  if (merged.length > 8192) return { ok: false, reason: 'too_large' };
  await deps.setRls(client, ctx.workerId);
  await persistMergedAnswers(client, ctx.stateContext.fill_application_id as string, merged);
  return { ok: true };
}

/**
 * Task 9: pre-fills an application's answers from the worker's saved
 * `worker_application_defaults` row (079_worker_application_defaults.sql;
 * read access for jale_whatsapp added by 081, keyed on
 * `app.current_internal_user_id` -- see task-9a-report.md's RLS analysis),
 * so a worker who already answered these questions on a past application is
 * not re-asked. Called once at fill-arm time (`handleJobAction`'s accept
 * path in processor.ts), BEFORE `computeNextStep`/the intro counts, for both
 * fresh accepts and re-arms.
 *
 * Contract (binding, from the task brief):
 *   - `deps.setRls` runs FIRST, before any SELECT (worker_application_defaults
 *     is FORCE RLS -- see 079/081).
 *   - Only a key that is (a) present in `requiredFields`/`optionalFields` --
 *     i.e. actually relevant to THIS job, (b) present in the defaults row,
 *     and (c) ABSENT (via `hasOwnProperty`, matching `computeNextStep`'s own
 *     presence convention -- a stored `false`/`null` answer already counts
 *     as answered) from the application's CURRENT `application_answers` is a
 *     seed candidate.
 *   - Each candidate is re-validated via the same single-key
 *     `validateApplicationAnswers([key], [], {[key]: value})` shape
 *     `mergeAnswer` uses -- a defaults row is worker-supplied history, not a
 *     trusted-by-construction value (a validator can also legitimately
 *     tighten between when the default was saved and now). A key that fails
 *     validation is skipped SILENTLY (never an error to the worker -- the
 *     bot simply asks the question, exactly as if no default existed).
 *   - All keys that DO validate are merged in exactly ONE UPDATE (via
 *     `persistMergedAnswers`, the same choke point `mergeAnswer` uses) --
 *     batching one call is straightforward here since every seeded key is
 *     already known before any write happens (unlike the confirm-per-turn
 *     flow `mergeAnswer` serves), so there is no reason to prefer N
 *     round-trips over one.
 *
 * Returns the seeded key NAMES ONLY (spec §11: metadata-only logging) --
 * never the values. Short-circuits (no `job_applications` SELECT, no
 * UPDATE) when the worker has no defaults row, or the row's `answers` is
 * empty -- the common case for a worker's very first application.
 */
export async function seedAnswersFromDefaults(
  client: PoolClient,
  ctx: FillContext,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  deps: FillDeps,
): Promise<string[]> {
  await deps.setRls(client, ctx.workerId);

  const defaultsRes = await client.query<{ answers: Record<string, unknown> }>(
    `SELECT answers FROM worker_application_defaults WHERE worker_id = $1`,
    [ctx.workerId],
  );
  const defaults = defaultsRes.rows[0]?.answers ?? {};
  if (Object.keys(defaults).length === 0) return [];

  const applicationId = ctx.stateContext.fill_application_id as string;
  const appRes = await client.query<{ application_answers: Record<string, unknown> }>(
    `SELECT application_answers FROM job_applications WHERE id = $1`,
    [applicationId],
  );
  const currentAnswers = appRes.rows[0]?.application_answers ?? {};

  const seeded: string[] = [];
  const toMerge: Record<string, unknown> = {};
  for (const key of [...requiredFields, ...optionalFields]) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
    if (Object.prototype.hasOwnProperty.call(currentAnswers, key)) continue;
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

/** Maps a merge failure to the caller-facing message (brief's caller
 * contract): 'too_large' -> answer_too_long; 'invalid' -> the per-key retry
 * hint. */
function mergeFailureMessage(reason: 'invalid' | 'too_large', key: FillFieldKey, lang: Lang): string {
  return reason === 'too_large' ? fillMessage('answer_too_long', lang) : fieldRetryHint(key, lang);
}

// ── job_id surfacing (see FillContext's jsdoc) ──────────────────────────

/**
 * Tiny dedicated job_id lookup. `computeNextStep`'s own SELECT already
 * joins in `job_id` internally, but its signature and return shape are
 * frozen (Task 6, reviewed/approved -- not to be disturbed) and it does not
 * expose that column. This duplicate, single-column SELECT is the
 * sanctioned way (per the Task 7 brief) to surface `job_id` onto
 * `FillContext` every turn without touching that function. Like
 * `computeNextStep`'s own initial SELECT, this does not require
 * `setInternalUserRlsContext` -- only the worker_documents check does.
 */
async function fetchApplicationJobId(client: PoolClient, applicationId: string): Promise<string | null> {
  const res = await client.query<{ job_id: string }>(
    'SELECT job_id FROM job_applications WHERE id = $1',
    [applicationId],
  );
  return res.rows[0]?.job_id ?? null;
}

// ── Prompting the next step (fields/docs only here; see jsdoc) ─────────

async function sendNextStepPrompt(
  client: PoolClient,
  ctx: FillContext,
  inboundSid: string,
  from: string,
  deps: FillDeps,
  leadIn?: string,
): Promise<void> {
  const applicationId = ctx.stateContext.fill_application_id as string;
  const nextStep = await computeNextStep(client, applicationId);
  const patch: Record<string, unknown> = { fill_last_prompt_at: deps.nowMs() };
  let body: string;
  let logKey: string;

  if (nextStep.kind === 'field') {
    body = fieldQuestion(nextStep.key, ctx.lang);
    logKey = nextStep.key;
  } else if (nextStep.kind === 'doc') {
    body = docPrompt(nextStep.docType, ctx.lang);
    logKey = nextStep.docType;
  } else {
    // 'complete' | 'exit' -- Task 11 expands both arms (completion copy
    // including the web-handoff note when uncollectable is non-empty,
    // exit-reason-specific copy, the next-application offer). Minimal
    // Task 7 placeholder per the brief: clear fill state and send the
    // generic completion message so the lane always terminates cleanly
    // rather than looping forever on a stale fill_application_id.
    body = fillMessage('completion', ctx.lang);
    patch.fill_application_id = null;
    patch.fill_pending = null;
    logKey = nextStep.kind;
  }

  if (leadIn) body = `${leadIn}\n\n${body}`;

  await deps.updateStateContext(client, ctx.conversationId, patch);
  await deps.queueReplyText(client, inboundSid, from, body);
  logStep(logKey, 'prompted');
}

/**
 * Queues the current `computeNextStep` prompt (field question / doc prompt
 * / the Task 11 completion-or-exit placeholder) and stamps
 * `fill_last_prompt_at`. Exposed separately from `handleFillMessage` so
 * `handleJobAction`'s new-accept / already-applied paths (outside this
 * module) and the Task 10 dispatch tail can invoke it directly without
 * synthesizing an inbound message.
 */
export async function promptNextStep(
  client: PoolClient,
  ctx: FillContext,
  inboundSid: string,
  from: string,
  deps: FillDeps,
): Promise<void> {
  await sendNextStepPrompt(client, ctx, inboundSid, from, deps);
}

// ─────────────────────────────────────────────────────────────────────────
// Task 8: document collection (spec §8). `handleDocUpload` does the actual
// download/sniff/S3-put/DB-write for ONE attachment; `handleFillMediaTurn`
// is the media-branch dispatcher `handleFillMessage` delegates to, and
// `handleDocStepText` covers the free-text-at-a-doc-step case (spec §6
// item 7's doc-step carve-out, §6 item 1 covers the media branch itself).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Wraps `deps.queueReplyText` so every reply queued THROUGH the returned
 * copy gets `leadIn` prepended -- used for the NumMedia>1 "we only used the
 * first file" note (spec §6 item 1), which must land ahead of whatever
 * reply the doc-upload path (success prompt or an error reply) ends up
 * sending, without threading a leadIn parameter through every call site.
 */
function withLeadIn(deps: FillDeps, leadIn: string): FillDeps {
  return {
    ...deps,
    queueReplyText: (client, inboundSid, to, body) =>
      deps.queueReplyText(client, inboundSid, to, `${leadIn}\n\n${body}`),
  };
}

// Outcome contract: 'stored' (row written) | 'satisfied' (requirement
// already met: cert cap, non-cert 23505 first-write-wins) | 'stay_pending'
// (an error reply was already sent, step unchanged -- recovery is the
// worker resending, a new message SID, per spec §8/§12). The CALLER
// (`handleFillMediaTurn`) runs `promptNextStep` only for stored/satisfied --
// NEVER for stay_pending, since the error reply already told the worker
// what to do next. `handleFillMessage` (and therefore this function) always
// runs INSIDE the processor's per-turn transaction -- the SAVEPOINT below
// depends on that; never call this standalone/autocommit.
async function handleDocUpload(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  docType: CollectableDocType,
  deps: FillDeps,
): Promise<'stored' | 'satisfied' | 'stay_pending'> {
  const reply = (key: FillMessageKey) =>
    deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage(key, ctx.lang));

  let buf: Buffer;
  try {
    buf = await deps.downloadMedia(msg.mediaUrl!);
  } catch (err) {
    // Spec §12: caught -> the turn still commits + an error reply;
    // recovery is the worker resending (never rethrown -- a download
    // hiccup must not abort the whole turn transaction).
    if (err instanceof MediaTooLargeError) {
      await reply('doc_too_large');
      logStep(docType, 'doc_too_large');
      return 'stay_pending';
    }
    await reply('doc_download_failed');
    logStep(docType, 'doc_download_failed');
    return 'stay_pending';
  }

  const sniffed = sniffDocumentType(buf);
  const claimed = msg.mediaContentType;
  // Trust the SNIFF as authoritative. Only reject when Twilio's claimed
  // content type is itself one of our allowed types but disagrees with the
  // real magic bytes (a mismatch/spoof) -- a claimed type outside our
  // allowlist (e.g. Twilio reports something we don't recognize) never
  // blocks an otherwise-valid sniff result.
  if (
    !sniffed ||
    (claimed !== undefined && (ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(claimed) && sniffed !== claimed)
  ) {
    await reply('doc_invalid_type');
    logStep(docType, 'doc_invalid_type');
    return 'stay_pending';
  }

  const ext = sniffed === 'application/pdf' ? 'pdf' : sniffed === 'image/png' ? 'png' : 'jpg';
  // S3 key scheme matches worker-doc-upload-url.ts's tokenized-upload path
  // (documents/${jobId}/${workerId}/${docType}/${uuid}.${ext}) -- S3 PUT
  // happens BEFORE any DB write (spec §4.3's orphan-tolerated invariant: an
  // S3 object with no DB row is harmless and unreachable; a DB row pointing
  // at a missing S3 object would not be).
  const key = `documents/${ctx.jobId}/${ctx.workerId}/${docType}/${randomUUID()}.${ext}`;
  const { versionId } = await uploadDocumentToS3(deps.documentsBucket, key, buf, sniffed);

  await deps.setRls(client, ctx.workerId);
  await client.query('SAVEPOINT fill_doc');
  try {
    if (docType !== 'certification_doc') {
      // Non-cert doc types are one-row-per-slot (007/075's partial unique
      // indexes exclude certification_doc) -- DELETE-then-INSERT is the
      // "replace", mirroring worker-doc-confirm.ts (080's header: no
      // ON CONFLICT arbiter is used here or there, since 075 narrowed the
      // per-job/vault unique indexes' predicates and an arbiter's WHERE
      // clause must match an index predicate exactly).
      await client.query(
        `DELETE FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = $3`,
        [ctx.workerId, ctx.jobId, docType],
      );
    }
    // Column list + cert_name=NULL decision: see this file's header comment
    // above handleFillMediaTurn and the task report for the full rationale
    // (078_worker_documents_cert_name.sql: cert_name is nullable, no
    // default, and NULL is a first-class "no label supplied" value, not an
    // error -- worker-doc-confirm.ts's tokenized upload path already treats
    // an omitted cert_name the same way).
    await client.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ctx.workerId, ctx.jobId, docType, key, `${docType}.${ext}`, buf.length, sniffed, versionId, null],
    );
    await copyRequiredDocumentSnapshots(client, ctx.workerId, ctx.jobId, [docType]);
    await client.query('RELEASE SAVEPOINT fill_doc');
    logStep(docType, 'stored');
    return 'stored';
  } catch (err: any) {
    await client.query('ROLLBACK TO SAVEPOINT fill_doc');
    // Both 078 cert-cap constraint names (total-per-slot and per-cert-name)
    // collapse to the same graceful result -- see
    // CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS's own comment
    // (applications.ts) for why neither is actionable from this chat flow.
    if (err?.code === '23514' && CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS.has(err?.constraint)) {
      await reply('cert_cap');
      logStep(docType, 'cert_cap');
      return 'satisfied';
    }
    // Non-cert unique-violation race (two turns for the same slot landing
    // concurrently, e.g. a retried/duplicated inbound) -- first write wins,
    // silently: the requirement is satisfied either way, and surfacing an
    // error here would be confusing (nothing is actually wrong from the
    // worker's point of view).
    if (err?.code === '23505' && docType !== 'certification_doc') {
      logStep(docType, 'first_write_wins');
      return 'satisfied';
    }
    throw err;
  }
}

/**
 * Free text at a doc step (spec §6 item 7's doc-step carve-out): text is
 * NEVER interpreted as a document -- it just re-sends the current doc
 * prompt, cooldown-guarded by the SAME `fill_last_prompt_at` timestamp
 * `sendNextStepPrompt` stamps (`REPROMPT_COOLDOWN_MS`, lifted from
 * onboarding-language.ts per spec §6 item 9) so a chatty worker sending
 * several stray texts in a row doesn't get the prompt spammed back at them.
 */
async function handleDocStepText(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  docType: CollectableDocType,
): Promise<FillResult> {
  const last = ctx.stateContext.fill_last_prompt_at as number | undefined;
  if (last !== undefined && deps.nowMs() - last < REPROMPT_COOLDOWN_MS) {
    logStep(docType, 'doc_text_cooldown');
    return { handled: true };
  }
  await deps.updateStateContext(client, ctx.conversationId, { fill_last_prompt_at: deps.nowMs() });
  await deps.queueReplyText(client, msg.messageSid, msg.from, docPrompt(docType, ctx.lang));
  logStep(docType, 'doc_text_reprompt');
  return { handled: true };
}

/**
 * Media-branch dispatcher (spec §6 item 1) -- `handleFillMessage` delegates
 * here whenever `msg.numMedia > 0`, BEFORE the CANCELAR guard and before any
 * text parsing (a captioned photo's caption must never leak to the text
 * parser).
 *
 * `fill_cert_more_pending` (stateContext): certification_doc is the ONE doc
 * type that does not simply advance on a successful upload (spec §8) -- it
 * loops "Tienes otro certificado?" and only moves on once the worker sends
 * something that is NOT another file. But `computeNextStep` cannot express
 * "still open to more certs": its presence check (`have.has(docType)`)
 * already reads certification_doc as satisfied the instant ONE row exists,
 * so a second cert upload would otherwise get mis-routed to whatever
 * `computeNextStep` says is ACTUALLY next (a different doc, a field, or
 * complete). This flag is how the loop stays addressable across turns: set
 * the instant a cert is stored, it makes the very next MEDIA turn skip
 * `computeNextStep` entirely and go straight back to the cert slot. A TEXT
 * reply while it's armed is gated through `parseFillConfirmation` by
 * `resolveCertLoopPending` (`handleFillMessage` delegates there) -- 'yes'
 * keeps it armed, 'no' clears it, unclear text re-echoes and keeps it
 * armed; only a genuine cap hit ('satisfied', below) clears it from THIS
 * function's side, never a retryable 'stay_pending'. This is why the flag
 * lives SEPARATELY from `fill_pending`: that type is field-key-shaped only
 * (`FillPendingState.key: FillFieldKey`), and its resolver
 * (`resolveFillPending`) assumes a field's confirm/entry_another/collecting
 * shape throughout -- reusing it for a doc type would require it to also
 * understand DB document writes, which is out of scope here.
 */
async function handleFillMediaTurn(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  applicationId: string,
): Promise<FillResult> {
  let docType: CollectableDocType;
  if (ctx.stateContext.fill_cert_more_pending) {
    docType = 'certification_doc';
  } else {
    const nextStep = await computeNextStep(client, applicationId);
    if (nextStep.kind === 'field') {
      await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('field_step_media', ctx.lang));
      logStep(nextStep.key, 'field_step_media');
      return { handled: true };
    }
    if (nextStep.kind !== 'doc') {
      // complete/exit: Task 11 territory, not dispatched from here.
      return { handled: false };
    }
    docType = nextStep.docType;
  }

  // Audio at a doc step: never a valid document, so never even attempt a
  // download. Deliberately the READY-WORKER templates.ts key
  // ('voice_note_not_supported'), NOT the v2 onboarding-voice key
  // ('v2_voice_not_supported') -- this flow is unrelated to onboarding-v2's
  // voice lane.
  if (msg.mediaContentType && detectMediaCategory(msg.mediaContentType) === 'voice') {
    await deps.queueReplyText(client, msg.messageSid, msg.from, t('voice_note_not_supported', ctx.lang));
    logStep(docType, 'voice_note_not_supported');
    return { handled: true };
  }

  const takeFirstNote = msg.numMedia > 1 ? fillMessage('doc_take_first', ctx.lang) : undefined;
  const effectiveDeps = takeFirstNote ? withLeadIn(deps, takeFirstNote) : deps;

  const outcome = await handleDocUpload(client, ctx, msg, docType, effectiveDeps);

  if (docType === 'certification_doc' && outcome === 'stored') {
    // Arm the loop and ask "tienes otro?" INSTEAD of promptNextStep -- see
    // this function's jsdoc for why certification_doc does not simply
    // advance like every other doc type. Reuses 'entry_another'
    // (application-fill-prompts.ts) rather than minting a dedicated key:
    // its Si/No copy is already exactly this question's shape, and the
    // prompts module documents it as the shared "add another?" gate.
    await deps.updateStateContext(client, ctx.conversationId, { fill_cert_more_pending: true });
    await effectiveDeps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('entry_another', ctx.lang));
    logStep(docType, 'cert_stored_loop');
    return { handled: true };
  }

  // Review fix (Critical, bug B): only a GENUINE loop exit clears the flag
  // -- the cap being hit ('satisfied'). 'stay_pending' (invalid type,
  // oversize, download failure) on a retry WHILE the loop is armed must
  // leave it armed: the error reply already tells the worker to resend,
  // and clearing here would silently re-route their next attempt through
  // computeNextStep to whatever's ACTUALLY next, storing their retried
  // cert file under the WRONG doc_type. 'stored' is handled entirely by
  // the branch above (returns before reaching here) and always keeps the
  // flag armed, never clears it.
  if (outcome === 'satisfied' && ctx.stateContext.fill_cert_more_pending) {
    await deps.updateStateContext(client, ctx.conversationId, { fill_cert_more_pending: null });
  }

  if (outcome === 'stored' || outcome === 'satisfied') {
    await promptNextStep(client, ctx, msg.messageSid, msg.from, effectiveDeps);
  }
  return { handled: true };
}

/**
 * Review fix (Critical, bug A): a TEXT reply while `fill_cert_more_pending`
 * is armed is an ANSWER to "tienes otro certificado?", not a free pass to
 * advance regardless of content -- the previous version cleared the flag
 * and fell through unconditionally, so "1"/"si" (the exact affirmative
 * `entry_another`'s own copy invites) was silently treated the same as
 * "no". Gated through `parseFillConfirmation` exactly like the array-entry
 * loop's `entry_another` stage (`resolveFillPending`):
 *   - 'yes' -> keep the flag armed, re-send `docPrompt('certification_doc')`
 *     (tell them to send it) -- no fill_pending-style state update needed,
 *     the flag itself already carries "still in the loop".
 *   - 'no' -> clear the flag (genuine exit) and fall through to
 *     `promptNextStep`, exactly like the media-path's 'satisfied' exit.
 *   - null (unclear) -> re-echo via the same generic `fillMessage(
 *     'reconfirm', ...)` `resolveFillPending` uses for its own unclear-text
 *     case, per that same precedent; the flag is untouched (kept).
 * CANCELAR (and, once Task 10 lands, other escapes) run BEFORE this point
 * in `handleFillMessage` and already scrub `fill_cert_more_pending`
 * themselves -- this function only ever runs for a plain, unescaped text
 * reply.
 */
async function resolveCertLoopPending(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  body: string,
): Promise<FillResult> {
  const answer = parseFillConfirmation(body);
  if (answer === null) {
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('reconfirm', ctx.lang));
    logStep('certification_doc', 'cert_loop_reconfirm');
    return { handled: true };
  }
  if (answer === 'yes') {
    await deps.queueReplyText(client, msg.messageSid, msg.from, docPrompt('certification_doc', ctx.lang));
    logStep('certification_doc', 'cert_loop_send_more');
    return { handled: true };
  }
  // answer === 'no' -- genuine exit.
  await deps.updateStateContext(client, ctx.conversationId, { fill_cert_more_pending: null });
  logStep('certification_doc', 'cert_loop_advance');
  await promptNextStep(client, ctx, msg.messageSid, msg.from, deps);
  return { handled: true };
}

// ── fill_pending resolution (spec §6 item 6) ────────────────────────────

/** Finalizes ONE answer (a plain value for a scalar key, or the FULL
 * accumulated array for an array key) through the merge choke point, then
 * either re-prompts on failure or clears `fill_pending` and advances. */
async function finalizeAnswer(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  key: FillFieldKey,
  value: unknown,
): Promise<FillResult> {
  const result = await mergeAnswer(client, ctx, key, value, deps);
  if (!result.ok) {
    // The confirmed/finalized candidate is provably bad (fails the real
    // validator, or the backstop) -- retrying the SAME value would just
    // fail again, so it is discarded (scrub rule: this counts as
    // 'discard') and the worker is asked to answer fresh.
    await deps.updateStateContext(client, ctx.conversationId, { fill_pending: null });
    await deps.queueReplyText(client, msg.messageSid, msg.from, mergeFailureMessage(result.reason, key, ctx.lang));
    logStep(key, 'merge_failed', result.reason);
    return { handled: true };
  }
  await deps.updateStateContext(client, ctx.conversationId, { fill_pending: null });
  logStep(key, 'merged');
  await promptNextStep(client, ctx, msg.messageSid, msg.from, deps);
  return { handled: true };
}

async function resolveFillPending(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  pending: FillPendingState,
  applicationId: string,
  body: string,
): Promise<FillResult> {
  if (pending.stage === 'collecting') {
    // Back to awaiting free text for the next array entry -- this is NOT a
    // yes/no gate, so it never touches parseFillConfirmation; it re-enters
    // ordinary field handling with the already-confirmed entries carried
    // along.
    return handleFieldStep(client, ctx, msg, deps, pending.key, applicationId, body, pending.entries);
  }

  const answer = parseFillConfirmation(body);
  if (answer === null) {
    // Unrecognized text while a yes/no answer is pending: defined behavior
    // is to re-echo the confirmation, never to silently re-extract (spec
    // §6 item 6). fill_pending is KEPT.
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('reconfirm', ctx.lang));
    logStep(pending.key, 'reconfirm');
    return { handled: true };
  }

  if (pending.stage === 'entry_another') {
    if (answer === 'yes') {
      await deps.updateStateContext(client, ctx.conversationId, {
        fill_pending: { key: pending.key, stage: 'collecting', entries: pending.entries } satisfies FillPendingCollecting,
      });
      await deps.queueReplyText(client, msg.messageSid, msg.from, fieldQuestion(pending.key, ctx.lang));
      logStep(pending.key, 'entry_collect_more');
      return { handled: true };
    }
    // 'no' -- validate + merge the WHOLE accumulated array exactly once.
    return finalizeAnswer(client, ctx, msg, deps, pending.key, pending.entries);
  }

  // stage === 'confirm'
  if (answer === 'no') {
    // Discard this ONE candidate. Array keys (entries !== undefined) keep
    // whatever was already confirmed and fall back to 'collecting'; scalar
    // keys clear fully and re-ask with the format hint.
    const nextPending: FillPendingState | null =
      pending.entries !== undefined
        ? { key: pending.key, stage: 'collecting', entries: pending.entries }
        : null;
    await deps.updateStateContext(client, ctx.conversationId, { fill_pending: nextPending });
    await deps.queueReplyText(client, msg.messageSid, msg.from, fieldRetryHint(pending.key, ctx.lang));
    logStep(pending.key, 'discarded');
    return { handled: true };
  }

  // answer === 'yes'
  if (pending.entries !== undefined) {
    // One array entry confirmed -- accumulate.
    const entries = [...pending.entries, pending.extracted];
    if (entries.length >= MAX_ARRAY_ENTRIES) {
      // At the validator's cap: do NOT offer "add another?" (there's no
      // room for a 4th) -- finalize immediately with the full, capped
      // array so it can never end up parked in fill_pending only to fail
      // whole-array validation later.
      logStep(pending.key, 'entry_cap_reached');
      return finalizeAnswer(client, ctx, msg, deps, pending.key, entries);
    }
    // Below the cap -- ask "add another?" (the array itself is only
    // validated/merged once the worker says no more, or the cap above
    // triggers).
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_pending: { key: pending.key, stage: 'entry_another', entries } satisfies FillPendingEntryAnother,
    });
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('entry_another', ctx.lang));
    logStep(pending.key, 'entry_confirmed');
    return { handled: true };
  }

  // Scalar key: merge directly.
  return finalizeAnswer(client, ctx, msg, deps, pending.key, pending.extracted);
}

// ── Current-step (no pending) field handling (spec §7) ──────────────────

async function handleFieldStep(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  key: FillFieldKey,
  applicationId: string,
  body: string,
  existingEntries?: unknown[],
): Promise<FillResult> {
  void applicationId; // mergeAnswer reads ctx.stateContext.fill_application_id directly

  const det = parseDeterministic(key, body);
  if (det) {
    if ('pendingDate' in det) {
      // Dates get the cheap long-form confirm via fill_pending (spec §7) --
      // no merge yet.
      const longForm = formatLongDate(det.pendingDate, ctx.lang);
      await deps.updateStateContext(client, ctx.conversationId, {
        fill_pending: { key, stage: 'confirm', extracted: det.pendingDate } satisfies FillPendingConfirm,
      });
      await deps.queueReplyText(
        client,
        msg.messageSid,
        msg.from,
        `${longForm}\n\n${fillMessage('confirm_footer', ctx.lang)}`,
      );
      logStep(key, 'confirm_pending');
      return { handled: true };
    }

    // work_authorization (boolean) / desired_pay ({amount, interval}) --
    // neither gets a confirmation step (spec §7); merge straight away.
    const leadIn =
      key === 'desired_pay'
        ? buildPayEcho(
            ctx.lang,
            (det.value as { amount: number; interval: PayInterval }).amount,
            (det.value as { amount: number; interval: PayInterval }).interval,
          )
        : undefined;
    const result = await mergeAnswer(client, ctx, key, det.value, deps);
    if (!result.ok) {
      await deps.queueReplyText(client, msg.messageSid, msg.from, mergeFailureMessage(result.reason, key, ctx.lang));
      logStep(key, 'merge_failed', result.reason);
      return { handled: true };
    }
    logStep(key, 'merged');
    await sendNextStepPrompt(client, ctx, msg.messageSid, msg.from, deps, leadIn);
    return { handled: true };
  }

  if (DETERMINISTIC_KEYS.has(key)) {
    // Recognized deterministic key, but the text didn't parse -- re-prompt
    // with the per-key hint; nothing written (spec §12).
    await deps.queueReplyText(client, msg.messageSid, msg.from, fieldRetryHint(key, ctx.lang));
    logStep(key, 'parse_failed');
    return { handled: true };
  }

  // Extraction bucket (spec §7): one Bedrock call, confidence/validator
  // gated by extractFieldAnswer itself.
  const outcome = await extractFieldAnswer(deps.extraction, key, body, ctx.lang);
  if (!outcome.ok) {
    await deps.queueReplyText(client, msg.messageSid, msg.from, mapExtractionFailure(outcome.reason, key, ctx.lang));
    logStep(key, 'extraction_failed', outcome.reason);
    return { handled: true };
  }

  const isArrayKey = ARRAY_FIELD_KEYS.has(key);
  const pendingPatch: FillPendingConfirm = {
    key,
    stage: 'confirm',
    extracted: outcome.value,
    summaryVars: outcome.summaryVars,
    ...(isArrayKey ? { entries: existingEntries ?? [] } : {}),
  };
  await deps.updateStateContext(client, ctx.conversationId, { fill_pending: pendingPatch });
  await deps.queueReplyText(
    client,
    msg.messageSid,
    msg.from,
    `${buildSummaryLine(ctx.lang, outcome.summaryVars)}\n\n${fillMessage('confirm_footer', ctx.lang)}`,
  );
  logStep(key, 'confirm_pending');
  return { handled: true };
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Fill-lane dispatcher for one inbound WhatsApp turn. Only called once the
 * caller has established `fill_application_id` is set on `stateContext`
 * (spec §6's dispatch section applies "when fill_application_id is set");
 * returns `{handled:false}` immediately otherwise so the processor's normal
 * routing takes over.
 *
 * Order implemented here (spec §6, Tasks 7+8's slice of it):
 *   1. Media turn (`handleFillMediaTurn`) -- BEFORE the CANCELAR guard and
 *      before any text parsing (a captioned photo's caption never leaks to
 *      the text parser). jobId is surfaced here too, independently of the
 *      text path's own refresh in step 3.
 *   2. CANCELAR guard (also scrubs the cert-loop flag, `fill_cert_more_pending`).
 *   3. jobId surfaced onto `ctx` (see `FillContext`'s jsdoc); if the
 *      cert-loop flag is armed, the text is a yes/no answer to it
 *      (`resolveCertLoopPending`), not a general-purpose advance.
 *   4. `fill_pending` resolution (confirm/discard/entry-loop).
 *   5. Current-step handling: doc-step free text re-sends the doc prompt
 *      (cooldown-guarded); field-step text goes through deterministic parse
 *      or extraction.
 * Escapes and the picker/relay interruption precedence are Task 10's
 * dispatch-order work -- not implemented here.
 */
export async function handleFillMessage(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
): Promise<FillResult> {
  const applicationId = ctx.stateContext.fill_application_id as string | undefined;
  if (!applicationId) return { handled: false };

  // Media-first (spec §6 item 1) -- BEFORE the CANCELAR guard and before any
  // text parsing: a captioned photo's caption must never leak to the text
  // parser, so a media turn never even reads `msg.body`. jobId is refreshed
  // here too (see FillContext's jsdoc) since Task 8's doc writes below
  // consume ctx.jobId, and this branch never reaches the text path's own
  // refresh further down.
  if (msg.numMedia > 0) {
    ctx.jobId = (await fetchApplicationJobId(client, applicationId)) ?? ctx.jobId;
    return handleFillMediaTurn(client, ctx, msg, deps, applicationId);
  }

  const body = msg.body ?? '';

  // CANCELAR guard (spec §6 item 2) -- before any parsing/extraction.
  if (isFillCancel(body)) {
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_application_id: null,
      fill_pending: null,
      fill_cert_more_pending: null,
    });
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('canceled', ctx.lang));
    logStep('cancel', 'canceled');
    return { handled: true };
  }

  // jobId resolved fresh every turn (see FillContext's jsdoc) before any
  // step handling -- Task 8's doc writes consume ctx.jobId.
  ctx.jobId = (await fetchApplicationJobId(client, applicationId)) ?? ctx.jobId;

  // Task 8's cert loop (see handleFillMediaTurn's jsdoc; review fix, bug A):
  // a TEXT reply while the loop is armed is the worker's yes/no answer to
  // "tienes otro certificado?", NOT an unconditional advance -- gate it
  // through the same confirm semantics the array-entry loop uses.
  if (ctx.stateContext.fill_cert_more_pending) {
    return resolveCertLoopPending(client, ctx, msg, deps, body);
  }

  const pending = ctx.stateContext.fill_pending as FillPendingState | undefined;
  if (pending) {
    return resolveFillPending(client, ctx, msg, deps, pending, applicationId, body);
  }

  const nextStep = await computeNextStep(client, applicationId);
  if (nextStep.kind === 'doc') {
    // Free text at a doc step (spec §6 item 7): never interpreted as a
    // document -- re-send the doc prompt, cooldown-guarded.
    return handleDocStepText(client, ctx, msg, deps, nextStep.docType);
  }
  if (nextStep.kind !== 'field') {
    // complete/exit prompting outside a direct response is not dispatched
    // from here (Task 11).
    return { handled: false };
  }

  return handleFieldStep(client, ctx, msg, deps, nextStep.key, applicationId, body);
}
