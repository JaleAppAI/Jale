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
import { setInternalUserRlsContext } from '../../lib/db';
import { DOC_TYPES, type PayInterval } from '../../lib/job-fields';
import { validateApplicationAnswers } from '../../lib/application-answers';
import {
  fieldQuestion,
  fieldRetryHint,
  docPrompt,
  fillMessage,
  type FillFieldKey,
  type CollectableDocType,
} from './application-fill-prompts';
import { extractFieldAnswer, type ExtractionClient } from './application-fill-extraction';
import type { IncomingMessage } from './conversation-router';
import type { Lang } from './templates';

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

// ─────────────────────────────────────────────────────────────────────────
// Task 7: `handleFillMessage` -- field-step collection (parse, extract,
// confirm). Media handling (Task 8) and escapes/dispatch-order (Task 10)
// are NOT implemented here -- both are structured as early `{handled:
// false}` returns so the processor falls back to normal routing until
// those tasks land. Complete/exit prompting (Task 11) is a minimal
// placeholder (see `sendNextStepPrompt`).
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
  // fill_relay_override?, fill_offer_application_id?
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
  await client.query(
    `UPDATE job_applications
        SET application_answers = application_answers || $1::jsonb, updated_at = now()
      WHERE id = $2`,
    [merged, ctx.stateContext.fill_application_id],
  );
  return { ok: true };
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
 * Order implemented here (spec §6, Task 7's slice of it):
 *   1. Media stub (Task 8 owns real handling) -> `{handled:false}`.
 *   2. CANCELAR guard.
 *   3. jobId surfaced onto `ctx` (see `FillContext`'s jsdoc).
 *   4. `fill_pending` resolution (confirm/discard/entry-loop).
 *   5. Current-step field handling (deterministic parse or extraction).
 * Escapes, the picker/relay interruption precedence, and doc-step text are
 * Task 10's dispatch-order work -- not implemented here.
 */
export async function handleFillMessage(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
): Promise<FillResult> {
  const applicationId = ctx.stateContext.fill_application_id as string | undefined;
  if (!applicationId) return { handled: false };

  // Media-first (spec §6 item 1) is Task 8's -- this dispatcher only
  // understands text turns today.
  if (msg.numMedia > 0) return { handled: false };

  const body = msg.body ?? '';

  // CANCELAR guard (spec §6 item 2) -- before any parsing/extraction.
  if (isFillCancel(body)) {
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_application_id: null,
      fill_pending: null,
    });
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('canceled', ctx.lang));
    logStep('cancel', 'canceled');
    return { handled: true };
  }

  // jobId resolved fresh every turn (see FillContext's jsdoc) before any
  // step handling -- Task 8's doc writes consume ctx.jobId.
  ctx.jobId = (await fetchApplicationJobId(client, applicationId)) ?? ctx.jobId;

  const pending = ctx.stateContext.fill_pending as FillPendingState | undefined;
  if (pending) {
    return resolveFillPending(client, ctx, msg, deps, pending, applicationId, body);
  }

  const nextStep = await computeNextStep(client, applicationId);
  if (nextStep.kind !== 'field') {
    // Doc-step text, and complete/exit prompting outside a direct
    // response, are not dispatched from here (Task 8/Task 10/Task 11).
    return { handled: false };
  }

  return handleFieldStep(client, ctx, msg, deps, nextStep.key, applicationId, body);
}
