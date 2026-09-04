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
import { REQUIRED_FIELD_TYPES, DOC_TYPES, type PayInterval } from '../../lib/job-fields';
import { EDUCATION_LEVELS } from '../../lib/application-answers';
import {
  copyRequiredDocumentSnapshots,
  CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS,
} from '../../lib/applications';
// Sprint 23: this lane no longer owns a "what's missing" engine of its own.
// Everything below derives from lib/application-requirements.ts -- the ONE
// shared engine both the web stage-2 door and this flow run on.
import {
  loadRequirementSnapshot,
  computeRemaining,
  mergeFieldAnswers,
  markDetailsCompleteIfDone,
  seedAnswersFromDefaults,
  clearFieldAnswer,
  type RequirementSnapshot,
  type MergeFailureReason,
} from '../../lib/application-requirements';
import {
  fieldQuestion,
  fieldRetryHint,
  fieldLabel,
  docPrompt,
  fillMessage,
  type FillFieldKey,
  type CollectableDocType,
  type FillMessageKey,
} from './application-fill-prompts';
import { extractFieldAnswer, type ExtractionClient } from './application-fill-extraction';
import { isChatsKeyword, isCloseKeyword, type IncomingMessage } from './conversation-router';
import { t, type Lang } from './templates';
import { REPROMPT_COOLDOWN_MS } from './onboarding-language';
import {
  sniffDocumentType,
  uploadDocumentToS3,
  MediaTooLargeError,
  ALLOWED_DOCUMENT_TYPES,
  detectMediaCategory,
} from './media';
import {
  isHelpCommand,
  isSupportCommand,
  isProfileCommand,
  isApplicationsCommand,
  parseTypedJobAction,
  normalizeCommandText,
  type ProfileStateContext,
} from './flows';

/** The four step kinds the WhatsApp fill lane can act on, plus the sprint-23
 * `details_not_requested` exit. Deliberately NARROWER than the shared
 * engine's `nextStep`: this lane has no certification-claim collector (that
 * step is web-only), so a job whose only gap is a certification reads as
 * `complete` here and the worker finishes it through the `web_handoff` link.
 * `markDetailsCompleteIfDone` still refuses to stamp `details_completed_at`
 * in that case -- the engine, not this lane, owns that verdict. */
export type FillExitReason =
  | 'job_inactive'
  | 'application_gone'
  | 'application_closed'
  | 'details_not_requested';

export type NextStep =
  | { kind: 'field'; key: FillFieldKey; uncollectable: string[] }
  | { kind: 'doc'; docType: CollectableDocType; uncollectable: string[] }
  | { kind: 'exit'; reason: FillExitReason; uncollectable: string[] }
  | { kind: 'complete'; uncollectable: string[] };

export interface FillStepResult {
  step: NextStep;
  /** The snapshot the step was derived from -- null for a vanished row.
   * Threaded on so completion can call `markDetailsCompleteIfDone` without a
   * second synced load, and so callers can read jobId/requiredFields. */
  snapshot: RequirementSnapshot | null;
}

/**
 * THE STAGE GATE (B4.0 section 7). The shared engine's compat
 * `computeNextStep` deliberately does NOT gate on stage -- it preserves the
 * pre-sprint-23 shape for callers that armed the fill at accept time. This
 * lane arms only after the employer requested details, so it applies the
 * gate itself, on EVERY turn (not just at arm time): an employer who moves a
 * `details_requested` applicant on to contacted/talking keeps the fill alive
 * because the gate reads the TIMESTAMPS, never the literal status.
 *
 * Order mirrors the compat wrapper's, with two insertions:
 *   1. lifecycle exits (job filled/closed, application hired/not_interested)
 *   2. stage === 'apply'          -> exit `details_not_requested`   (NEW)
 *   3. details_completed_at set   -> complete                        (NEW)
 *   4. fields, then docs, then complete.
 */
export function fillStepFor(snapshot: RequirementSnapshot | null): NextStep {
  if (!snapshot) return { kind: 'exit', reason: 'application_gone', uncollectable: [] };

  const remaining = computeRemaining(snapshot);
  const uncollectable = remaining.uncollectableDocs;

  if (snapshot.jobStatus === 'filled' || snapshot.jobStatus === 'closed') {
    return { kind: 'exit', reason: 'job_inactive', uncollectable };
  }
  if (snapshot.applicationStatus === 'hired' || snapshot.applicationStatus === 'not_interested') {
    return { kind: 'exit', reason: 'application_closed', uncollectable };
  }
  if (snapshot.stage === 'apply') {
    return { kind: 'exit', reason: 'details_not_requested', uncollectable };
  }
  if (snapshot.detailsCompletedAt) return { kind: 'complete', uncollectable };

  const fieldKey = remaining.fields[0];
  if (fieldKey !== undefined) {
    return { kind: 'field', key: fieldKey as FillFieldKey, uncollectable };
  }
  const docType = remaining.docs[0];
  if (docType !== undefined) {
    return { kind: 'doc', docType: docType as CollectableDocType, uncollectable };
  }
  return { kind: 'complete', uncollectable };
}

/**
 * One synced snapshot load (`syncDocumentSnapshots: true` copies the
 * worker's vault docs onto the job first, so a vault-only resume is never
 * re-asked -- see the engine header) plus the gate above. Replaces this
 * module's former two/three-query `computeNextStep`/`countRemainingRequirements`
 * pair: the shared engine answers both from the SAME select.
 */
export async function computeFillStep(
  client: PoolClient,
  applicationId: string,
): Promise<FillStepResult> {
  const snapshot = await loadRequirementSnapshot(client, applicationId, {
    syncDocumentSnapshots: true,
  });
  return { step: fillStepFor(snapshot), snapshot };
}

export interface FillCounts {
  nFields: number;
  nDocs: number;
  uncollectable: string[];
}

/** The intro's "N questions and M documents" counts, now derived PURELY from
 * a snapshot the caller already loaded -- no extra round trip. */
export function fillCountsFor(snapshot: RequirementSnapshot | null): FillCounts {
  if (!snapshot) return { nFields: 0, nDocs: 0, uncollectable: [] };
  const remaining = computeRemaining(snapshot);
  return {
    nFields: remaining.counts.fields,
    nDocs: remaining.counts.docs,
    uncollectable: remaining.uncollectableDocs,
  };
}

/**
 * The `{{url}}` the `web_handoff` note points at: the worker's own stage-2
 * page for THIS application. `PUBLIC_SITE_BASE_URL` is wired onto the
 * processor Lambda by whatsapp-stack.ts; the literal fallback keeps unit
 * tests and any un-migrated environment producing a real link rather than
 * "undefined/es/worker/...".
 */
export function workerApplicationUrl(lang: Lang, applicationId: string): string {
  const base = (process.env.PUBLIC_SITE_BASE_URL ?? 'https://jaleapp.ai').replace(/\/+$/, '');
  return `${base}/${lang}/worker/applications/${applicationId}`;
}

/**
 * Localizes a list of uncollectable doc-type codes into a comma-joined,
 * human-readable string for the `web_handoff` note's `{{doc}}` var. Task 11
 * moves this here (from processor.ts, where Task 9's intro-arm append
 * originated it) so the completion arm's OWN `web_handoff` append
 * (`sendCompletionPrompt`) can reuse the exact same labels/fallback
 * (`labels[docType]?.[lang] ?? docType`) instead of hand-rolling a second
 * copy -- processor.ts now imports this instead of defining its own.
 */
export function localizeDocList(docTypes: string[], lang: Lang): string {
  const labels: Record<string, Record<Lang, string>> = {
    resume: { en: 'Resume', es: 'Resume' },
    driver_license: { en: "Driver's license", es: 'Licencia de conducir' },
    // SSN is no longer offered for new jobs, but legacy jobs may still require it -- keep the label.
    ssn: { en: 'SSN card / ITIN', es: 'Tarjeta SSN / ITIN' },
    // Added by migration 074 to DOC_TYPES; both were reaching workers as the
    // raw enum string inside the job_documents_required reply (and now the
    // fill flow's web_handoff note).
    work_auth_doc: { en: 'Work authorization document', es: 'Documento de autorización de trabajo' },
    certification_doc: { en: 'Certification', es: 'Certificación' },
  };
  return docTypes.map((docType) => labels[docType]?.[lang] ?? docType).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────
// Task 7: `handleFillMessage` -- field-step collection (parse, extract,
// confirm). Task 8 adds document collection (media turns, doc-step free
// text). Escapes/dispatch-order (Task 10) are still NOT implemented here --
// structured as an early `{handled: false}` return so the processor falls
// back to normal routing until that task lands. Task 11 expands
// `sendNextStepPrompt`'s complete/exit arms (see that function and its
// `sendCompletionPrompt`/`sendExitPrompt` helpers) into real terminal
// copy/scrub/offer behavior.
//
// INVARIANT (binding, from Task 6 review): `handleFillMessage` and
// `promptNextStep` always run INSIDE the processor's per-turn transaction
// -- this module never issues BEGIN/COMMIT/ROLLBACK itself. That is also
// why `computeNextStep`'s `setInternalUserRlsContext` call (for the
// worker_documents check) sticks for the rest of the turn, and why every
// DB WRITE below runs after its own `deps.setRls(client, ctx.workerId)`
// call (see `mergeAnswer`) -- job_applications reads (this file's own
// `fetchApplicationJobContext`, and `computeNextStep`'s SELECT) do not require
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
 * resolved fresh every turn (see `fetchApplicationJobContext`) from
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
  // Task 11: the CURRENT job's required_fields, surfaced (like `jobId`)
  // during a text turn's step-5 refresh (`fetchApplicationJobContext`) --
  // `undefined` whenever that refresh hasn't run (e.g. a promptNextStep call
  // reached directly from processor.ts, or any test that doesn't populate
  // it), in which case `finalizeAnswer`'s de-required guard is a no-op
  // (fails open: merge proceeds exactly as before this field existed).
  // Never read anywhere except that one guard.
  requiredFields?: string[];
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

// ── L3 reuse sub-states (sprint 24) ─────────────────────────────────────
//
// Three separate keys, deliberately NOT folded into `fill_pending`: that
// type is field-key-shaped and its resolver assumes a confirm/entry loop
// throughout (same reasoning as `fill_cert_more_pending`, see
// `handleFillMediaTurn`).
//
// STATE_CONTEXT IDENTITY (binding, `FillDeps.updateStateContext`): every
// write below goes through `deps.updateStateContext`, which BOTH persists
// the spread-merged patch AND mutates the same `ctx.stateContext` object in
// place. Nothing here mutates `ctx.stateContext` directly, and nothing reads
// a value it wrote without going through that call first -- so a second read
// in the same turn sees the patch with no extra round trip, and the DB and
// the in-memory object can never disagree.

/** One correctable item in the numbered CAMBIAR menu. */
export type FillChangeItem =
  | { kind: 'field'; key: FillFieldKey }
  | { kind: 'doc'; docType: CollectableDocType };

/** What `armFill` reused, remembered so a LATER turn's CAMBIAR can list it.
 * Only what THIS arm actually reused: a re-arm seeds nothing and copies
 * nothing, sends no reuse summary, and correspondingly offers nothing to
 * correct -- the menu and the message the worker saw always agree. */
export interface FillReusedState {
  fields: string[];
  docs: string[];
}

/** The all-pre-filled gate. `repeated` records that the prompt has already
 * been re-sent once; the state is then KEPT but silent, so a LISTO arriving
 * several turns later still sends the application. */
export interface FillConfirmState {
  at: number;
  repeated?: boolean;
}

/** The armed numbered menu. One-shot: any reply that is not a bare digit
 * clears it (see `resolveChangeMenu`), so a stale menu can never hijack a
 * digit the worker meant as an answer. */
export interface FillChangeMenuState {
  items: FillChangeItem[];
  at: number;
  repeated?: boolean;
}

/**
 * Task 10 requirement 5: the ONE canonical home for the fill lane's
 * `state_context` keys, layered onto `ProfileStateContext` (flows.ts) via
 * intersection rather than widening that shared type directly -- flows.ts
 * has no knowledge of (and must not depend on) this module. Both
 * conversation-router.ts (`setFocusedConversation`'s `fill_relay_override`
 * arm-site) and processor.ts (the Task 10 seam/dispatch-tail) import this
 * type via `import type` instead of maintaining their own local duplicate.
 * `import type` keeps this a compile-time-only edge: conversation-router.ts
 * gains no runtime dependency on this module, so there is no import cycle
 * even though this module imports real functions (`isChatsKeyword`,
 * `isCloseKeyword`) from conversation-router.ts below.
 */
export type FillStateContext = ProfileStateContext & {
  fill_application_id?: string | null;
  fill_relay_override?: boolean | null;
  fill_pending?: FillPendingState | null;
  fill_cert_more_pending?: boolean | null;
  fill_last_prompt_at?: number;
  // Task 11: set by the completion arm alongside the scrub write when
  // another of the worker's applications still has a real gap -- see
  // `findContinueOtherOffer`/`sendCompletionPrompt`. The Task 10 fill-lane
  // seam gate (processor.ts) fires on this key OR `fill_application_id`;
  // `handleFillMessage` resolves it as a one-shot yes/no (see
  // `resolveOfferOnlyTurn`) whenever `fill_application_id` itself is unset.
  fill_offer_application_id?: string | null;
  // Sprint 24 L3 -- see the three shapes above. All four are cleared by
  // `FILL_SCRUB`, so they never outlive the fill that armed them.
  fill_reused?: FillReusedState | null;
  fill_confirm?: FillConfirmState | null;
  fill_change_menu?: FillChangeMenuState | null;
  /** A doc slot the worker asked to replace: the next media turn stores
   * against THIS doc type instead of whatever the step walk says is next.
   * Needed because the job-scoped row was deleted but the VAULT row is
   * untouched (decision D3), so the very next synced load copies it back
   * and the requirement reads satisfied again. */
  fill_doc_replace?: string | null;
  // Sprint 23 prompt lane (application-prompts.ts). Declared here, not in a
  // second loose type, so the mutual-exclusion scrub (`FILL_SCRUB`) and the
  // processor's two lane gates read one shape.
  prompt_application_id?: string | null;
  prompt_last_prompt_at?: number | null;
  /** One-shot numbered `aplicaciones` menu (applications-command.ts). */
  applications_menu?: { ids: string[]; at: number } | null;
};

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

/** Accent/case/whitespace-insensitive normalization for the fill lane's
 * reserved words -- the same NFD strip `parseFillConfirmation` uses, since
 * the WhatsApp keyboards this audience uses often drop or mangle accents. */
function normalizeKeyword(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * CAMBIAR / CHANGE (sprint 24 L3) -- "let me fix one of the things you
 * reused". Both languages are accepted in either locale, like every other
 * reserved word in this lane, because a bilingual worker's keyboard is not
 * the same thing as their conversation language.
 *
 * EXACT match only, deliberately not fuzzy: it must never eat a legitimate
 * free-text answer (a work_history entry mentioning a change of employer).
 * Neither word is within 1 Damerau-Levenshtein edit of any COMMAND_KEYWORDS
 * entry sharing its first letter (`commands`/`comandos`/`chats`/`cerrar`/
 * `close`), so `matchCommandFuzzy` cannot swallow it either -- the same
 * property `isFillCancel` relies on and a unit test locks.
 */
export function isFillChange(body: string): boolean {
  const t = normalizeKeyword(body);
  return t === 'cambiar' || t === 'change';
}

/** LISTO / DONE -- the explicit "send it" for the all-pre-filled gate. Same
 * exact-match rules as `isFillChange`; no COMMAND_KEYWORDS entry starts with
 * l or d, so there is nothing for the fuzzy matcher to collide with. */
export function isFillDone(body: string): boolean {
  const t = normalizeKeyword(body);
  return t === 'listo' || t === 'done';
}

const FILL_FIELD_KEYS: ReadonlySet<string> = new Set(REQUIRED_FIELD_TYPES);
const COLLECTABLE_DOC_TYPES: ReadonlySet<string> = new Set(DOC_TYPES);

/** Narrows a key read off `state_context` (or off the engine's `string[]`
 * seed report) to this lane's key union, dropping anything the catalog does
 * not list -- a legacy state_context value, or a key a later migration
 * retired. */
function asFillFieldKey(value: unknown): FillFieldKey | null {
  return typeof value === 'string' && FILL_FIELD_KEYS.has(value) ? (value as FillFieldKey) : null;
}

/** Same, for doc types. `ssn` is not in DOC_TYPES, so a legacy required
 * `ssn` can never become a collectable menu item or a replacement slot. */
function asCollectableDocType(value: unknown): CollectableDocType | null {
  return typeof value === 'string' && COLLECTABLE_DOC_TYPES.has(value)
    ? (value as CollectableDocType)
    : null;
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

// ── Escape detection (Task 10, spec §6) ─────────────────────────────────
//
// A worker mid-fill can always step OUT to a handful of reserved commands;
// `handleFillMessage` checks these (in the order spec §6 specifies) before
// ever treating the body as a field/doc answer. Every one of these matchers
// is reused verbatim from flows.ts/conversation-router.ts -- never
// reimplemented -- so a single grammar change there (e.g. widening
// COMMAND_KEYWORDS) automatically applies here too.

// Exact-match jobs keyword (spec §6.3): the WHOLE normalized body must BE
// one of these words. Deliberately NOT `isJobsKeyword` (flows.ts), whose
// prefix+fuzzy grammar (`/^(trabajos?|jobs?|empleos?)\b/`) would eat a
// legitimate field answer like "trabajo de pintor 5 anos" as an escape.
const EXACT_JOBS_WORDS = new Set(['jobs', 'trabajos', 'empleos', 'job', 'trabajo', 'empleo']);

function isExactJobsKeyword(body: string): boolean {
  return EXACT_JOBS_WORDS.has(normalizeCommandText(body));
}

/** CHATS/CERRAR/help/support/profile: these always win over an in-flight
 * fill -- including a pending yes/no confirmation -- so a worker can always
 * reach them mid-fill. (The one exception, spec §6.3, is a body that
 * itself PARSES as the pending confirmation -- '1'/'1 si'/'2 no'/bare
 * si/no/yes -- which `handleFillMessage` intercepts before this check ever
 * runs; see its own comment.) */
function matchesCommandEscape(body: string): boolean {
  return (
    isChatsKeyword(body)
    || isCloseKeyword(body)
    || isHelpCommand(body)
    || isSupportCommand(body)
    || isProfileCommand(body)
    || isApplicationsCommand(body)
  );
}

/**
 * The full "this body is a command, not an answer" predicate: the reserved
 * commands above, the EXACT jobs keyword, and a typed job action. Exported
 * so the sprint-23 prompt lane (application-prompts.ts) applies byte-identical
 * escape rules -- a worker must be able to reach `ayuda`/`chats`/`trabajos`
 * mid-prompts exactly as they can mid-fill, and a single grammar change in
 * flows.ts must move both lanes at once.
 */
export function matchesFillEscape(body: string): boolean {
  return matchesCommandEscape(body) || isExactJobsKeyword(body) || parseTypedJobAction(body) !== null;
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

/**
 * FINAL-REVIEW Finding 2: `education`/`military_service`/`worked_here_before`
 * are extraction-bucket keys (not in `DETERMINISTIC_KEYS`), but their own
 * `FIELD_QUESTIONS` copy (application-fill-prompts.ts) IS a numbered menu --
 * "Responde con 1, 2, 3, 4, 5, 6 o 7." for education, "1. Si / 2. No" for the
 * other two. Bedrock extraction never sees that menu text, so a fully
 * compliant bare-digit/si/no reply was previously sent straight to
 * extraction anyway, where it likely fails the 0.75 confidence gate --
 * whose retry hint then tells the worker to repeat the exact input that just
 * failed, a hard loop for the MOST compliant workers.
 *
 * This is a pre-parse, checked BEFORE the extraction call but AFTER
 * `DETERMINISTIC_KEYS` (those four keys never reach this function). Matches
 * are merged DIRECTLY through the same no-confirm path `work_authorization`
 * uses (spec §7: booleans/menus need no echo-confirm) -- never through
 * `fill_pending`. Anything that doesn't match one of these exact forms
 * (including a compliant-but-elaborated reply like "si, en 2022" for
 * worked_here_before) returns null and falls through to extraction
 * UNCHANGED, so `{answer: true, when: '2022'}`-shaped extraction still
 * works exactly as before.
 *
 * `education`'s menu order is 1:1 with `EDUCATION_LEVELS` (application-
 * answers.ts) -- verified against the actual FIELD_QUESTIONS copy: 1=None,
 * 2=Primary school, 3=High school, 4=GED, 5=Some college, 6=College degree,
 * 7=Trade school, matching EDUCATION_LEVELS' ['none', 'primary',
 * 'high_school', 'ged', 'some_college', 'college', 'trade_school'] index for
 * index.
 */
function parseMenuAnswer(key: FillFieldKey, body: string): { value: unknown } | null {
  const t = body.trim().toLowerCase();
  switch (key) {
    case 'education': {
      const m = t.match(/^([1-7])$/);
      if (!m) return null;
      const level = EDUCATION_LEVELS[Number(m[1]) - 1];
      return { value: { level } };
    }
    case 'military_service': {
      if (t === '1' || t === 'si' || t === 'yes') return { value: { served: true } };
      if (t === '2' || t === 'no') return { value: { served: false } };
      return null;
    }
    case 'worked_here_before': {
      if (t === '1' || t === 'si' || t === 'yes') return { value: { answer: true } };
      if (t === '2' || t === 'no') return { value: { answer: false } };
      return null;
    }
    default:
      return null;
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

// ── Merge choke point (spec section 4.3, now the shared engine) ─────────

type MergeResult = { ok: true } | { ok: false; reason: MergeFailureReason | 'invalid' };

/**
 * The ONLY path from an extracted/parsed value to the DB, and now a thin
 * adapter over the shared engine's `mergeFieldAnswers` -- ONE key per turn,
 * exactly the batch shape the web door posts with many.
 *
 * What the engine adds over this module's former private `mergeAnswer`:
 *   - the same per-key `validateApplicationAnswers([key], [], {...})` gate
 *     (unchanged), plus a check that the key is actually one THIS job asks
 *     for, which subsumes the de-required guard `finalizeAnswer` used to do
 *     on its own (an employer who dropped the key mid-confirm now gets
 *     `unknown_answer_key` -> 'invalid');
 *   - the post-merge column-size SAVEPOINT (this lane previously bounded
 *     only the per-merge JSON);
 *   - the `worker_application_defaults` WRITE-BACK, which WhatsApp never had
 *     (B4.0 section 9 -- 091 grants jale_whatsapp the INSERT/UPDATE). This is
 *     why the swap is not cosmetic: answering on WhatsApp now pre-fills the
 *     worker's NEXT application, same as the web door.
 *   - `markDetailsCompleteIfDone` on success.
 *
 * `deps.setRls` still runs FIRST (call-order test): the defaults write-back
 * lands on FORCE-RLS `worker_application_defaults`, and the engine only sets
 * the GUC itself on the document-sync path (skipped entirely for a job that
 * asks for no documents).
 *
 * A defaults-write failure propagates out of the engine BY DESIGN rather
 * than being swallowed, so a turn cannot commit an answer whose default
 * silently vanished. That aborts the whole turn transaction -- louder than
 * the pre-swap behavior, and deliberate.
 */
async function mergeAnswer(
  client: PoolClient,
  ctx: FillContext,
  key: FillFieldKey,
  value: unknown,
  deps: FillDeps,
): Promise<MergeResult> {
  await deps.setRls(client, ctx.workerId);
  const result = await mergeFieldAnswers(client, {
    applicationId: ctx.stateContext.fill_application_id as string,
    workerId: ctx.workerId,
    answers: { [key]: value },
  });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason };
}

/** Maps every `mergeFieldAnswers` failure reason to caller-facing copy. The
 * lifecycle reasons reuse the SAME exit copy `sendExitPrompt` sends, so a
 * job that closed between the question and the answer reads identically
 * whichever code path notices first. */
function mergeFailureMessage(
  reason: MergeFailureReason | 'invalid',
  key: FillFieldKey,
  lang: Lang,
): string {
  switch (reason) {
    case 'too_large':
      return fillMessage('answer_too_long', lang);
    case 'not_found':
      return fillMessage('exit_application_gone', lang);
    case 'closed':
      return fillMessage('exit_application_closed', lang);
    case 'stage_locked':
      return fillMessage('exit_details_not_requested', lang);
    case 'certification_document_limit':
      return fillMessage('cert_cap', lang);
    case 'invalid':
    default:
      return fieldRetryHint(key, lang);
  }
}

// ── job_id surfacing (see FillContext's jsdoc) ──────────────────────────

/**
 * Tiny dedicated job_id lookup. `computeNextStep`'s own SELECT already
 * joins in `job_id` internally, but its signature and return shape are
 * frozen (Task 6, reviewed/approved -- not to be disturbed) and it does not
 * expose that column. This duplicate, single-column SELECT is the
 * sanctioned way (per the Task 7 brief) to surface `job_id` onto
 * `FillContext` every turn without touching that function. Used ONLY by the
 * media branch (step 2) -- media turns never resolve a field's
 * `fill_pending`, so they have no use for `required_fields`
 * (`fetchApplicationJobContext`, below, is the text-path equivalent). Like
 * `computeNextStep`'s own initial SELECT, this does not require
 * `setInternalUserRlsContext` -- only the worker_documents check does.
 * Deliberately NOT a job_applications-JOIN-jobs query (unlike
 * `fetchApplicationJobContext`) so its SQL text stays outside the
 * `/FROM job_applications ja/` pattern some cert-loop tests use to assert
 * `computeNextStep` itself never ran.
 */
async function fetchApplicationJobId(client: PoolClient, applicationId: string): Promise<string | null> {
  const res = await client.query<{ job_id: string }>(
    'SELECT job_id FROM job_applications WHERE id = $1',
    [applicationId],
  );
  return res.rows[0]?.job_id ?? null;
}

/**
 * Task 11: like `fetchApplicationJobId`, but also surfaces `required_fields`
 * (a JOIN, not a second query) -- read once per TEXT turn (step 5) and
 * stashed on `ctx.requiredFields` for the sole purpose of `finalizeAnswer`'s
 * de-required guard (see that function's jsdoc). `computeNextStep`'s own
 * SELECT already joins in both columns internally, but its signature and
 * return shape are frozen (Task 6, reviewed/approved) and it does not
 * expose either. Deliberately spells out `job_applications`/`jobs` instead
 * of `computeNextStep`'s own `ja`/`j` aliases -- several existing tests
 * (application-fill.test.ts's cert-loop cases, processor.test.ts's dispatch-
 * tail cases) grep call history for the literal `FROM job_applications ja`
 * shape specifically to assert "no `computeNextStep`-like re-derive ran
 * this turn"; reusing that alias here would make this UNRELATED lookup a
 * false positive under that pattern.
 */
async function fetchApplicationJobContext(
  client: PoolClient,
  applicationId: string,
): Promise<{ jobId: string | null; requiredFields: string[] | undefined }> {
  const res = await client.query<{ job_id: string; required_fields?: string[] }>(
    `SELECT job_applications.job_id, jobs.required_fields
       FROM job_applications
       JOIN jobs ON jobs.id = job_applications.job_id
      WHERE job_applications.id = $1`,
    [applicationId],
  );
  const row = res.rows[0];
  return { jobId: row?.job_id ?? null, requiredFields: row?.required_fields };
}

// ── Prompting the next step (fields/docs/complete/exit) ────────────────

interface ContinueOtherOffer {
  applicationId: string;
  jobTitle: string;
}

/**
 * The employer's display name for a job, for the `intro`/`completion` copy.
 * `employer_display_name` (031) is a SECURITY DEFINER lookup: it flips a
 * transaction-local `app.employer_name_lookup` GUC that widens
 * `employer_profiles` reads until COMMIT. That widening is INERT for this
 * lane -- jale_whatsapp holds no table grant on `employer_profiles` at all
 * (031's header) -- which is why the WhatsApp lane may call it mid-turn
 * where an API handler (worker-jobs-detail.ts:44-46) must keep it last
 * before COMMIT. Same precedent as conversation-router.ts:566.
 */
async function loadJobCompanyName(client: PoolClient, jobId: string): Promise<string> {
  const res = await client.query<{ company: string }>(
    `SELECT employer_display_name(j.employer_id) AS company FROM jobs j WHERE j.id = $1`,
    [jobId],
  );
  return res.rows[0]?.company ?? 'Jale';
}

/**
 * Scans the worker's OTHER applications for one that is genuinely awaiting
 * stage-2 answers, to offer right after the just-completed one.
 *
 * Sprint 23 narrows the SQL with the stage predicate itself -- an
 * application nobody has asked details for is NOT something to offer to
 * continue, and re-deriving that per candidate would burn a synced snapshot
 * load each time. `details_requested_at IS NOT NULL AND details_completed_at
 * IS NULL` mirrors the gate in `fillStepFor`; the per-candidate
 * `computeFillStep` below is still what decides there is a REAL gap.
 */
export async function findContinueOtherOffer(
  client: PoolClient,
  workerId: string,
  excludeApplicationId: string,
): Promise<ContinueOtherOffer | null> {
  const res = await client.query<{ id: string; title: string }>(
    `SELECT ja.id, j.title
       FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
      WHERE ja.worker_id = $1 AND ja.id <> $2
        AND j.status IN ('active','paused')
        AND ja.status IN ('pending','contacted','talking')
        AND ja.details_requested_at IS NOT NULL
        AND ja.details_completed_at IS NULL
      ORDER BY ja.updated_at DESC`,
    [workerId, excludeApplicationId],
  );
  for (const row of res.rows.slice(0, 5)) {
    const { step } = await computeFillStep(client, row.id);
    if (step.kind === 'field' || step.kind === 'doc') {
      return { applicationId: row.id, jobTitle: row.title };
    }
  }
  return null;
}

/**
 * Completion arm (`kind: 'complete'`). Order is BINDING:
 *   1. `markDetailsCompleteIfDone` -- the employer's applicant list and 091's
 *      hire gate both read `details_completed_at`, so it must be stamped
 *      BEFORE the worker is told their details went out. The already-loaded
 *      snapshot is passed in so this costs one UPDATE, not a second synced
 *      load. The engine refuses to stamp when anything is still outstanding
 *      (e.g. a certification this lane cannot collect) -- that is its call,
 *      not this lane's.
 *   2. the `completion` copy (naming the employer), plus the `web_handoff`
 *      note with the worker's own stage-2 URL when anything this lane cannot
 *      collect remains: an uncollectable doc (legacy `ssn`) OR -- the case
 *      the engine swap introduced -- an outstanding CERTIFICATION. The
 *      module header promises the worker finishes a cert through that link,
 *      and `markDetailsCompleteIfDone` returning false is the authoritative
 *      "not actually done" signal, so the two are wired together here:
 *      without this a cert-only gap said "we sent your details" and gave the
 *      worker no way to finish, while the employer's list still read
 *      incomplete.
 *   3. the offer/scrub write, then the `continue_other` message.
 *
 * Scrub set: every fill key, the prompt lane's keys, and the one-shot
 * applications menu -- see `FILL_SCRUB` for why each one is in there.
 */
/**
 * What the `web_handoff` line names. Uncollectable docs first (the legacy
 * `ssn` bucket, which is why this lane always had the line at all). If there
 * are none and the engine still REFUSED to stamp `details_completed_at`, the
 * gap is something the walk in `fillStepFor` skips -- today only a
 * certification -- so name the certifications themselves: they are the
 * employer's own free-text requirement names, which read correctly in both
 * languages. Returns '' when there is genuinely nothing left, which is the
 * ordinary completion and gets no link.
 */
function webHandoffItems(
  uncollectable: string[],
  stamped: boolean,
  snapshot: RequirementSnapshot | null,
  lang: Lang,
): string {
  if (uncollectable.length > 0) return localizeDocList(uncollectable, lang);
  if (stamped || !snapshot) return '';
  const remaining = computeRemaining(snapshot);
  // Already-stamped rows also return false from markDetailsCompleteIfDone
  // (the UPDATE matches zero rows), so gate on the real outstanding set
  // rather than on `stamped` alone.
  const certs = [...remaining.certifications.unclaimed, ...remaining.certifications.unproven];
  return certs.join(', ');
}

async function sendCompletionPrompt(
  client: PoolClient,
  ctx: FillContext,
  applicationId: string,
  inboundSid: string,
  from: string,
  deps: FillDeps,
  uncollectable: string[],
  snapshot: RequirementSnapshot | null,
  leadIn?: string,
): Promise<void> {
  const stamped = await markDetailsCompleteIfDone(client, applicationId, snapshot);

  const company = await loadJobCompanyName(client, snapshot?.jobId ?? ctx.jobId);
  let body = fillMessage('completion', ctx.lang, { company });
  const handoff = webHandoffItems(uncollectable, stamped, snapshot, ctx.lang);
  if (handoff) {
    body += `\n\n${fillMessage('web_handoff', ctx.lang, {
      doc: handoff,
      url: workerApplicationUrl(ctx.lang, applicationId),
    })}`;
  }
  if (leadIn) body = `${leadIn}\n\n${body}`;

  const offer = await findContinueOtherOffer(client, ctx.workerId, applicationId);

  const patch: Record<string, unknown> = {
    ...FILL_SCRUB,
    fill_offer_application_id: offer ? offer.applicationId : null,
    fill_last_prompt_at: deps.nowMs(),
  };

  await deps.updateStateContext(client, ctx.conversationId, patch);
  await deps.queueReplyText(client, inboundSid, from, body);
  logStep('complete', 'prompted');

  if (offer) {
    await deps.queueReplyText(
      client,
      inboundSid,
      from,
      fillMessage('continue_other', ctx.lang, { job_title: offer.jobTitle }),
    );
    logStep('complete', 'offered_other');
  }
}

// Lifecycle exit reason -> the mapped prompts key. `details_not_requested`
// (sprint 23) is the one exit that is not terminal: the employer simply has
// not asked yet, so its copy points the worker at "aplicaciones" instead of
// telling them the application is over.
const EXIT_MESSAGE_KEYS: Record<FillExitReason, FillMessageKey> = {
  job_inactive: 'exit_job_inactive',
  application_gone: 'exit_application_gone',
  application_closed: 'exit_application_closed',
  details_not_requested: 'exit_details_not_requested',
};

/**
 * Every state_context key a fill ENTRY or EXIT must clear, in one place.
 * The prompt-lane keys (`prompt_application_id`, `prompt_last_prompt_at`)
 * and the one-shot `applications_menu` are in here because the two lanes are
 * mutually exclusive: arming or leaving the fill must never leave a prompt
 * turn or a stale numbered menu addressable.
 */
const FILL_SCRUB = {
  fill_application_id: null,
  fill_pending: null,
  fill_cert_more_pending: null,
  fill_relay_override: null,
  fill_offer_application_id: null,
  prompt_application_id: null,
  prompt_last_prompt_at: null,
  applications_menu: null,
  // Sprint 24 L3. Each is scoped to ONE armed application: a stale
  // fill_confirm would let a later LISTO send an application the worker has
  // moved on from, a stale fill_change_menu would let a bare digit clear an
  // answer on it, a stale fill_reused would name the wrong job's data, and a
  // stale fill_doc_replace would file the next photo under the wrong slot.
  fill_reused: null,
  fill_confirm: null,
  fill_change_menu: null,
  fill_doc_replace: null,
} as const;

/**
 * Lifecycle-exit arm (`kind: 'exit'`). Sends the reason-mapped copy, then a
 * full scrub + disarm -- the SAME key set the completion arm clears, but
 * NEVER an offer (the worker didn't finish anything here).
 */
async function sendExitPrompt(
  client: PoolClient,
  ctx: FillContext,
  inboundSid: string,
  from: string,
  deps: FillDeps,
  reason: FillExitReason,
  leadIn?: string,
): Promise<void> {
  let body = fillMessage(EXIT_MESSAGE_KEYS[reason], ctx.lang);
  if (leadIn) body = `${leadIn}\n\n${body}`;

  await deps.updateStateContext(client, ctx.conversationId, {
    ...FILL_SCRUB,
    fill_last_prompt_at: deps.nowMs(),
  });
  await deps.queueReplyText(client, inboundSid, from, body);
  logStep(reason, 'prompted');
}

async function sendNextStepPrompt(
  client: PoolClient,
  ctx: FillContext,
  inboundSid: string,
  from: string,
  deps: FillDeps,
  leadIn?: string,
): Promise<void> {
  const applicationId = ctx.stateContext.fill_application_id as string;
  const { step, snapshot } = await computeFillStep(client, applicationId);

  if (step.kind === 'complete') {
    return sendCompletionPrompt(
      client, ctx, applicationId, inboundSid, from, deps, step.uncollectable, snapshot, leadIn,
    );
  }
  if (step.kind === 'exit') {
    return sendExitPrompt(client, ctx, inboundSid, from, deps, step.reason, leadIn);
  }

  const patch: Record<string, unknown> = { fill_last_prompt_at: deps.nowMs() };
  let body: string;
  let logKey: string;
  if (step.kind === 'field') {
    body = fieldQuestion(step.key, ctx.lang);
    logKey = step.key;
  } else {
    body = docPrompt(step.docType, ctx.lang);
    logKey = step.docType;
  }

  if (leadIn) body = `${leadIn}\n\n${body}`;

  await deps.updateStateContext(client, ctx.conversationId, patch);
  await deps.queueReplyText(client, inboundSid, from, body);
  logStep(logKey, 'prompted');
}

/**
 * Queues the current step's prompt and stamps `fill_last_prompt_at`. Exposed
 * separately from `handleFillMessage` so `armFill` and the processor's
 * dispatch tail can invoke it directly without synthesizing an inbound
 * message.
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

export type ArmFillOutcome =
  | { armed: true }
  | { armed: false; reason: FillExitReason };

/**
 * THE one place stage 2 is armed (sprint 23). Three entry points share it --
 * the `application:start:app-<uuid>` button on the details-requested
 * template, a pick from the `aplicaciones` list, and the idle fallback --
 * and nothing else may arm the lane. In particular the job-accept path no
 * longer does: at accept time the employer has not asked for anything.
 *
 * Order (each step depends on the previous):
 *   1. gate on the CALLER's already-loaded snapshot. An apply-stage or
 *      closed application never arms, and the caller sends the matching
 *      copy from the returned reason.
 *   2. capture the previously-armed application id (for `switched_job`)
 *      BEFORE the arm write mutates state_context in place.
 *   3. `seedAnswersFromDefaults` -- pre-fill from the worker's saved
 *      answers. B4.0 section 9 moves this from accept time to HERE: there is
 *      nothing worth pre-filling until the employer asks. Runs BEFORE the
 *      counts so the intro never advertises a question the seed just
 *      answered.
 *   4. the arm write (full scrub + `fill_application_id`).
 *   5. `switched_job`, then the intro (counts re-derived from a FRESH
 *      snapshot, post-seed), then the first prompt.
 *
 * ── SPRINT 24 L3: WHAT THE WORKER SEES ───────────────────────────────────
 * The 2026-09-04T04:41:58Z incident happened entirely inside this function.
 * A worker tapped Start and received three messages at once -- "you switched
 * to a different job application", "Faltan 0 preguntas y 0 documentos.
 * Empezamos:", and the completion -- because the seed had answered every
 * question from the single per-worker defaults blob and the synced load had
 * attached a work-authorization document from the vault. Their details went
 * to the employer without them answering anything, and included answers
 * given to a DIFFERENT company.
 *
 * So the message order is now BINDING:
 *   a. `switched_job` (unchanged, and correct: it explains the rest).
 *   b. `intro_profile_check` -- sent BEFORE the defaults row is even read,
 *      so the reuse is announced rather than discovered.
 *   c. seed, arm write, then ONE synced load. That load is this turn's
 *      first, so it is the one that copies vault documents and the only one
 *      whose `copiedDocuments` is non-empty (see the field's jsdoc).
 *   d. `reuse_summary` -- ONLY if something was actually seeded or copied,
 *      naming both and offering CAMBIAR. What it names is remembered in
 *      `fill_reused` so a later CAMBIAR lists exactly this.
 *   e. remaining > 0: the counted intro and the first prompt, as before.
 *   f. remaining == 0: NO completion. `confirm_all_prefilled` plus a
 *      `fill_confirm` arm, so nothing reaches the employer until the worker
 *      says LISTO.
 */
export async function armFill(
  client: PoolClient,
  ctx: FillContext,
  snapshot: RequirementSnapshot,
  inboundSid: string,
  from: string,
  deps: FillDeps,
): Promise<ArmFillOutcome> {
  const gate = fillStepFor(snapshot);
  if (gate.kind === 'exit') return { armed: false, reason: gate.reason };

  const applicationId = snapshot.applicationId;
  const previousApplicationId = ctx.stateContext.fill_application_id as string | undefined;

  // (a) Unchanged, and moved ahead of the seed only so it stays FIRST now
  // that two more messages precede the intro. Read off `ctx.stateContext`
  // before the arm write mutates it in place.
  if (previousApplicationId !== undefined && previousApplicationId !== applicationId) {
    await deps.queueReplyText(client, inboundSid, from, fillMessage('switched_job', ctx.lang));
  }

  // (b) Transparency: announced BEFORE the defaults row is read, so the
  // worker is told the profile is about to be used, not shown the result.
  await deps.queueReplyText(client, inboundSid, from, fillMessage('intro_profile_check', ctx.lang));

  // (c) The seed now returns only 'stable' keys (decision D2 --
  // FIELD_REUSE_POLICY, job-fields.ts); the four per-application keys are
  // refused inside the engine with a `seed_skipped/per_application` line.
  const seededKeys = await seedAnswersFromDefaults(
    client,
    { applicationId, workerId: ctx.workerId },
    snapshot.requiredFields,
    snapshot.optionalFields,
  );

  await deps.updateStateContext(client, ctx.conversationId, {
    ...FILL_SCRUB,
    pending_picker: null,
    fill_application_id: applicationId,
  });
  ctx.jobId = snapshot.jobId;

  // THIS is the turn's first synced load (the caller's own snapshot is
  // loaded unsynced -- processor.ts's ownership check must run before any
  // write), so it is the load that copies vault documents and the only one
  // that can report them. Read `copiedDocuments` here or never.
  const { snapshot: seeded } = await computeFillStep(client, applicationId);
  const reusedFields = seededKeys
    .map(asFillFieldKey)
    .filter((key): key is FillFieldKey => key !== null);
  const copiedDocs = (seeded?.copiedDocuments ?? [])
    .map(asCollectableDocType)
    .filter((docType): docType is CollectableDocType => docType !== null);

  // (d) The reuse summary, and ONLY when there is something to summarize:
  // a worker on their first application must not be told about a profile
  // check that found nothing.
  if (reusedFields.length > 0 || copiedDocs.length > 0) {
    const lines: string[] = [];
    if (reusedFields.length > 0) {
      lines.push(fillMessage('reuse_fields_line', ctx.lang, {
        labels: reusedFields.map((key) => fieldLabel(key, ctx.lang)).join(', '),
      }));
    }
    if (copiedDocs.length > 0) {
      lines.push(fillMessage('reuse_docs_line', ctx.lang, {
        docLabels: localizeDocList(copiedDocs, ctx.lang),
      }));
    }
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_reused: { fields: reusedFields, docs: copiedDocs } satisfies FillReusedState,
    });
    await deps.queueReplyText(
      client,
      inboundSid,
      from,
      `${lines.join('\n')}\n\n${fillMessage('reuse_change_footer', ctx.lang)}`,
    );
    logStep('reuse', 'summarized');
  }

  const counts = fillCountsFor(seeded);
  const webHandoffNote = counts.uncollectable.length > 0
    ? `\n\n${fillMessage('web_handoff', ctx.lang, {
      doc: localizeDocList(counts.uncollectable, ctx.lang),
      url: workerApplicationUrl(ctx.lang, applicationId),
    })}`
    : '';

  if (counts.nFields + counts.nDocs === 0) {
    // (f) THE FIX. `promptNextStep` here would reach `sendCompletionPrompt`
    // and send the whole application in this same turn -- the incident. The
    // worker gets the gate instead, and `fill_confirm` keeps it addressable
    // across turns (see `resolveFillConfirm`).
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_confirm: { at: deps.nowMs() } satisfies FillConfirmState,
      fill_last_prompt_at: deps.nowMs(),
    });
    await deps.queueReplyText(
      client,
      inboundSid,
      from,
      `${fillMessage('confirm_all_prefilled', ctx.lang)}${webHandoffNote}`,
    );
    logStep('confirm', 'prompted');
    return { armed: true };
  }

  // (e) Unchanged: the counted intro, then the first real question.
  const company = await loadJobCompanyName(client, snapshot.jobId);
  const introBody = fillMessage('intro', ctx.lang, {
    company,
    n_fields: String(counts.nFields),
    n_docs: String(counts.nDocs),
  }) + webHandoffNote;
  await deps.queueReplyText(client, inboundSid, from, introBody);

  await promptNextStep(client, ctx, inboundSid, from, deps);
  return { armed: true };
}

// ── L3: the all-pre-filled gate and the CAMBIAR menu ────────────────────

/**
 * Resolves a turn while `fill_confirm` is armed -- i.e. the application has
 * nothing outstanding and is waiting on the worker's explicit go-ahead.
 *
 * LISTO/DONE goes through `promptNextStep`, NOT a direct completion call, so
 * the verdict is re-derived: if the employer widened the requirements
 * between the arm and this reply, the worker is asked the new question
 * instead of sending an application that no longer qualifies.
 *
 * Anything else re-sends the prompt ONCE and then goes quiet, keeping the
 * state armed: a worker who wandered off mid-conversation must still be able
 * to type LISTO three turns later, and clearing the gate would leave a
 * silent completion as the only remaining way out. CAMBIAR never reaches
 * here -- `handleFillMessage` consumes it earlier, before the escapes.
 */
async function resolveFillConfirm(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  confirm: FillConfirmState,
  body: string,
): Promise<FillResult> {
  if (isFillDone(body)) {
    await deps.updateStateContext(client, ctx.conversationId, { fill_confirm: null });
    logStep('confirm', 'confirmed');
    await promptNextStep(client, ctx, msg.messageSid, msg.from, deps);
    return { handled: true };
  }

  if (!confirm.repeated) {
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_confirm: { ...confirm, repeated: true } satisfies FillConfirmState,
      fill_last_prompt_at: deps.nowMs(),
    });
    await deps.queueReplyText(
      client, msg.messageSid, msg.from, fillMessage('confirm_all_prefilled', ctx.lang),
    );
    logStep('confirm', 'reprompt');
    return { handled: true };
  }

  logStep('confirm', 'unhandled');
  return { handled: false };
}

/** The menu body: header, then one numbered line per item. Fields carry
 * their short label, documents the same localized label the `web_handoff`
 * note and the reuse summary use -- one vocabulary for one document. */
function buildChangeMenuBody(items: FillChangeItem[], lang: Lang): string {
  const lines = items.map((item, index) => {
    const label = item.kind === 'field'
      ? fieldLabel(item.key, lang)
      : localizeDocList([item.docType], lang);
    return `${index + 1}. ${label}`;
  });
  return `${fillMessage('change_menu_header', lang)}\n\n${lines.join('\n')}`;
}

/** Reads `fill_reused` defensively: the value comes back off a JSONB column
 * and may predate this feature entirely (a fill armed by the previous
 * release), so every member is re-narrowed rather than trusted. */
function reusedItems(stateContext: Record<string, unknown>): FillChangeItem[] {
  const reused = stateContext.fill_reused as Partial<FillReusedState> | null | undefined;
  const fields = Array.isArray(reused?.fields) ? reused!.fields : [];
  const docs = Array.isArray(reused?.docs) ? reused!.docs : [];
  return [
    ...fields
      .map(asFillFieldKey)
      .filter((key): key is FillFieldKey => key !== null)
      .map((key): FillChangeItem => ({ kind: 'field', key })),
    ...docs
      .map(asCollectableDocType)
      .filter((docType): docType is CollectableDocType => docType !== null)
      .map((docType): FillChangeItem => ({ kind: 'doc', docType })),
  ];
}

/**
 * CAMBIAR/CHANGE, from ANY sub-state of an armed fill (decision D3's "let
 * them replace one"). Lists what this arm reused and nothing else, so the
 * menu and the `reuse_summary` the worker is answering always agree.
 *
 * `fill_pending` is deliberately KEPT here: opening a menu is not one of the
 * six scrub events (spec §4.2), and a worker who glances at the list and
 * then answers the pending question should not have lost it. It IS cleared
 * once a menu item is actually chosen -- see `resolveChangeMenu`.
 */
async function openChangeMenu(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
): Promise<FillResult> {
  const items = reusedItems(ctx.stateContext);
  if (items.length === 0) {
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('change_nothing', ctx.lang));
    logStep('change', 'nothing_reused');
    return { handled: true };
  }

  await deps.updateStateContext(client, ctx.conversationId, {
    fill_change_menu: { items, at: deps.nowMs() } satisfies FillChangeMenuState,
    fill_last_prompt_at: deps.nowMs(),
  });
  await deps.queueReplyText(client, msg.messageSid, msg.from, buildChangeMenuBody(items, ctx.lang));
  logStep('change', 'menu_sent');
  return { handled: true };
}

/**
 * Resolves a turn while the numbered menu is armed.
 *
 * ONE-SHOT, on purpose. Only a bare 1-2 digit body is treated as a pick;
 * anything else clears the menu and falls through to ordinary handling, so
 * the worker's real answer is never eaten AND no stale menu survives to
 * hijack a later digit (several fields -- work_authorization, education,
 * the entry loops -- legitimately answer with a digit). An out-of-range
 * digit re-sends the list once, then gives up the same way.
 *
 * On a real pick both `fill_change_menu` and `fill_confirm` are cleared:
 * the worker is leaving the gate to fix something, and whatever they answer
 * next completes the application through the ordinary path (they answered
 * it themselves -- that is the explicit act decision D asks for).
 * `fill_pending` is cleared too, as a 'discard': the candidate that was
 * awaiting a yes/no belongs to a question the worker has just walked away
 * from, and leaving it armed would resolve it against the wrong step.
 */
async function resolveChangeMenu(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  menu: FillChangeMenuState,
  body: string,
): Promise<FillResult | null> {
  const digits = body.trim().match(/^(\d{1,2})$/);
  if (!digits) {
    await deps.updateStateContext(client, ctx.conversationId, { fill_change_menu: null });
    logStep('change', 'menu_dropped');
    return null;
  }

  const items = Array.isArray(menu.items) ? menu.items : [];
  const item = items[Number(digits[1]) - 1];
  if (!item) {
    if (menu.repeated) {
      await deps.updateStateContext(client, ctx.conversationId, { fill_change_menu: null });
      logStep('change', 'menu_abandoned');
      return null;
    }
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_change_menu: { ...menu, repeated: true } satisfies FillChangeMenuState,
    });
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('change_menu_invalid', ctx.lang));
    await deps.queueReplyText(client, msg.messageSid, msg.from, buildChangeMenuBody(items, ctx.lang));
    logStep('change', 'menu_invalid');
    return { handled: true };
  }

  const applicationId = ctx.stateContext.fill_application_id as string;
  const remaining = items.filter((entry) => entry !== item);
  const patch: Record<string, unknown> = {
    fill_change_menu: null,
    fill_confirm: null,
    fill_pending: null,
    fill_reused: {
      fields: remaining.filter((e): e is { kind: 'field'; key: FillFieldKey } => e.kind === 'field').map((e) => e.key),
      docs: remaining.filter((e): e is { kind: 'doc'; docType: CollectableDocType } => e.kind === 'doc').map((e) => e.docType),
    } satisfies FillReusedState,
  };

  // Both branches WRITE under FORCE RLS (`job_applications` /
  // `worker_documents`), and both policies key on
  // app.current_internal_user_id -- so the GUC goes first or the statement
  // is a silent zero-row no-op. Same contract `mergeAnswer` and
  // `handleDocUpload` follow.
  await deps.setRls(client, ctx.workerId);

  if (item.kind === 'field') {
    await deps.updateStateContext(client, ctx.conversationId, patch);
    const cleared = await clearFieldAnswer(client, { applicationId, key: item.key });
    logStep(item.key, cleared ? 'change_cleared' : 'change_clear_noop');
    if (!cleared) {
      // F7: the ONLY way the engine refuses is its `details_completed_at IS
      // NULL` guard -- the same application was completed elsewhere (the web
      // stage-2 door) while this menu was armed. Falling through to
      // `promptNextStep` here answered a worker who had just asked to FIX
      // something with the completion copy ("we sent your details"), i.e.
      // reported a raced no-op as a success and sent that copy a second time
      // for the same application. Say what actually happened instead, and
      // point at the one place a sent application can still be read.
      //
      // The lane is deliberately NOT scrubbed: `patch` above already took
      // away everything that could act on this application again (the menu,
      // the LISTO gate, a pending candidate), and the next turn re-derives
      // `complete` so the ordinary completion arm disarms the lane with its
      // own scrub. Doing it here would fork that one exit.
      await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('change_locked', ctx.lang, {
        url: workerApplicationUrl(ctx.lang, applicationId),
      }));
      logStep(item.key, 'change_locked');
      return { handled: true };
    }
    // Re-derived, not asked directly: with the key gone the engine's own
    // walk names it as the next step (or names an earlier gap first, which
    // is the right order anyway).
    await promptNextStep(client, ctx, msg.messageSid, msg.from, deps);
    return { handled: true };
  }

  // A doc: drop THIS JOB's copy only. The vault row (job_id IS NULL) is the
  // worker's own file and is never touched -- decision D3 is "let them
  // replace one", not "delete their document". Bound job_id is what
  // guarantees that.
  await client.query(
    `DELETE FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = $3`,
    [ctx.workerId, ctx.jobId, item.docType],
  );
  // ...which means the very next synced load copies the vault row back and
  // the requirement reads satisfied again. `fill_doc_replace` is what keeps
  // the slot addressable anyway, so the replacement file lands here instead
  // of on whatever the step walk says is next. `fill_cert_more_pending` is
  // cleared with it: a cert loop from before this correction would otherwise
  // out-rank the slot the worker just asked to replace.
  await deps.updateStateContext(client, ctx.conversationId, {
    ...patch,
    fill_cert_more_pending: null,
    fill_doc_replace: item.docType,
    fill_last_prompt_at: deps.nowMs(),
  });
  await deps.queueReplyText(client, msg.messageSid, msg.from, docPrompt(item.docType, ctx.lang));
  logStep(item.docType, 'change_doc_reprompt');
  return { handled: true };
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
  // Sprint 24 L3: a slot the worker asked to replace out-ranks the step
  // walk, for the same reason the cert loop does -- the walk cannot express
  // it. The job-scoped row was deleted but the VAULT row was not (decision
  // D3), so the synced load inside `computeFillStep` has already copied it
  // back and would route this file to whatever is next instead. The cert
  // loop still comes first: it is cleared when a replacement is armed, so
  // the two can never both be set.
  const replaceDoc = asCollectableDocType(ctx.stateContext.fill_doc_replace);
  if (ctx.stateContext.fill_cert_more_pending) {
    docType = 'certification_doc';
  } else if (replaceDoc) {
    docType = replaceDoc;
  } else {
    const { step: nextStep } = await computeFillStep(client, applicationId);
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

  // The replacement landed (or the slot is satisfied anyway) -- disarm.
  // 'stay_pending' deliberately keeps it armed: the error reply told the
  // worker to resend, and clearing here would file their next attempt under
  // whatever the step walk says instead (the same reasoning as the cert
  // loop's own flag, below).
  if (replaceDoc && (outcome === 'stored' || outcome === 'satisfied')) {
    await deps.updateStateContext(client, ctx.conversationId, { fill_doc_replace: null });
    logStep(docType, 'doc_replaced');
  }

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

/**
 * Finalizes ONE answer (a plain value for a scalar key, or the FULL
 * accumulated array for an array key) through the merge choke point, then
 * either re-prompts on failure or clears `fill_pending` and advances.
 *
 * Task 11 de-required guard: `ctx.requiredFields` (surfaced fresh this turn
 * by `fetchApplicationJobContext`, see `FillContext`'s jsdoc) is checked
 * FIRST, before ever calling `mergeAnswer`. If the employer removed `key`
 * from the job's `required_fields` while this exact answer sat in
 * `fill_pending` awaiting confirmation, merging it now would let it silently
 * satisfy the SAME key if it is ever re-added later -- `computeNextStep`'s
 * `hasOwnProperty` walk has no notion of *when* an answer was written, only
 * whether the key is present. So the stale candidate is discarded SILENTLY
 * (no error copy -- this was never the worker's mistake) and the actual
 * current step is re-derived via `promptNextStep` instead of being merged.
 * `ctx.requiredFields` is `undefined` for any caller that never ran that
 * refresh (this function's own unit tests that construct `ctx` directly,
 * or a future call site) -- the guard fails OPEN in that case (proceeds to
 * merge exactly as before this guard existed) rather than risk a false
 * discard from absent data.
 */
async function finalizeAnswer(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
  key: FillFieldKey,
  value: unknown,
): Promise<FillResult> {
  if (Array.isArray(ctx.requiredFields) && !ctx.requiredFields.includes(key)) {
    await deps.updateStateContext(client, ctx.conversationId, { fill_pending: null });
    logStep(key, 'discarded_derequired');
    await promptNextStep(client, ctx, msg.messageSid, msg.from, deps);
    return { handled: true };
  }

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

  // FINAL-REVIEW Finding 2: education/military_service/worked_here_before
  // get ONE more deterministic chance -- their own FIELD_QUESTIONS copy is a
  // numbered menu that Bedrock extraction never sees, so an exact menu reply
  // must never be sent there (see parseMenuAnswer's jsdoc). Merges DIRECTLY,
  // exactly like the `det` branch above (no fill_pending confirm loop) --
  // anything that doesn't match falls through to extraction, unchanged.
  const menuParsed = parseMenuAnswer(key, body);
  if (menuParsed) {
    const result = await mergeAnswer(client, ctx, key, menuParsed.value, deps);
    if (!result.ok) {
      await deps.queueReplyText(client, msg.messageSid, msg.from, mergeFailureMessage(result.reason, key, ctx.lang));
      logStep(key, 'merge_failed', result.reason);
      return { handled: true };
    }
    logStep(key, 'merged');
    await sendNextStepPrompt(client, ctx, msg.messageSid, msg.from, deps);
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
 * Task 11: resolves a turn where `fill_application_id` is UNSET but
 * `fill_offer_application_id` is armed (the continue-other offer,
 * `sendCompletionPrompt`) -- the processor's seam gate now fires on either
 * key being set (spec amendment), and this is what handles the "only the
 * offer key is set" half of that gate. Exactly two outcomes, per the brief:
 *   - '1' / '1 si' / bare 'si' / 'yes' (i.e. `parseFillConfirmation` ===
 *     'yes') arms `fill_application_id` with the offered id, clears the
 *     offer key in the SAME write, and prompts that application's first gap
 *     -- via `promptNextStep`, which re-derives through `computeNextStep`
 *     rather than trusting the offer's snapshot, since the offered
 *     application may have gone stale (lifecycle-exited, or completed via
 *     another channel) between the offer and this reply.
 *   - ANY other input (decline, stray text, a button/list payload, or a
 *     media turn -- `msg.body` is `undefined`/empty for all of the latter,
 *     which `parseFillConfirmation` already treats as non-'yes') clears the
 *     offer key and returns `{handled:false}` -- one-shot, no nagging: the
 *     turn falls through to whatever routing would have applied had no
 *     offer ever been made (including a media turn's own normal handling
 *     downstream).
 */
async function resolveOfferOnlyTurn(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
): Promise<FillResult> {
  const offerId = ctx.stateContext.fill_offer_application_id as string | undefined;
  if (typeof offerId !== 'string') return { handled: false };

  if (parseFillConfirmation(msg.body ?? '') === 'yes') {
    await deps.updateStateContext(client, ctx.conversationId, {
      fill_offer_application_id: null,
      fill_application_id: offerId,
    });
    logStep('offer', 'accepted');
    await promptNextStep(client, ctx, msg.messageSid, msg.from, deps);
    return { handled: true };
  }

  await deps.updateStateContext(client, ctx.conversationId, { fill_offer_application_id: null });
  logStep('offer', 'declined');
  return { handled: false };
}

/**
 * Fill-lane dispatcher for one inbound WhatsApp turn. Only called once the
 * caller has established `fill_application_id` OR `fill_offer_application_id`
 * is set on `stateContext` (spec §6's dispatch section applies "when
 * fill_application_id is set"; Task 11 widens the seam to the offer key too
 * -- see `resolveOfferOnlyTurn`). When `fill_application_id` itself is unset,
 * this delegates the WHOLE turn to `resolveOfferOnlyTurn` and returns
 * immediately -- none of the numbered steps below ever run without a real
 * armed application. Returns `{handled:false}` immediately when NEITHER key
 * is set, so the processor's normal routing takes over.
 *
 * Full order implemented here (spec §6, encoded once):
 *   1. Button/interactive-payload escape (Task 10) -- UNCONDITIONAL, even
 *      before the media check: button/list payloads keep top priority over
 *      everything this module does. Fill state is KEPT (scrub rule) --
 *      the processor's normal routing (job button, legal reply, whatever
 *      else consumes the payload) runs untouched, and the fill resumes on
 *      the worker's next plain-text turn.
 *   2. Media turn (`handleFillMediaTurn`) -- BEFORE the CANCELAR guard and
 *      before any text parsing (a captioned photo's caption never leaks to
 *      the text parser). jobId is surfaced here too, independently of the
 *      text path's own refresh in step 5.
 *   3. CANCELAR guard (also scrubs the cert-loop flag, `fill_cert_more_pending`).
 *   4. Picker-digit escape (Task 10, spec §6.4): a bare 1-2 digit body while
 *      `state_context.pending_picker` is set always belongs to the picker
 *      -- checked before jobId refresh/cert-loop/fill_pending so it wins
 *      even in the (structurally unreachable per Task 8's re-review, but
 *      guarded conservatively anyway) case both a picker AND a
 *      confirmation are in flight at once.
 *   5. jobId surfaced onto `ctx` (see `FillContext`'s jsdoc).
 *   6. Confirmation-in-flight exception (Task 10, spec §6.3): while the
 *      cert loop or `fill_pending` is genuinely awaiting a yes/no answer, a
 *      body that PARSES as that confirmation ('1'/'1 si'/'2 no'/bare
 *      si/no/yes) is consumed as the confirmation FIRST -- even though the
 *      identical string can also parse as a typed job action ("1 si" =
 *      accept recent_jobs[0]) or, in principle, a picker digit (already
 *      excluded by step 4). Anything that does NOT parse as a confirmation
 *      falls through to the escape checks below, so e.g. "CHATS" while a
 *      confirmation is pending still escapes instead of getting a generic
 *      reconfirm re-echo from `resolveFillPending`/`resolveCertLoopPending`.
 *   7. Command escapes (Task 10, spec §6 items 5/9): CHATS/CERRAR/help/
 *      support/profile always win over an in-flight fill (`matchesCommandEscape`).
 *   8. Exact-match jobs keyword (Task 10, spec §6.3) -- NOT `isJobsKeyword`'s
 *      prefix+fuzzy grammar, which would eat a legitimate field answer like
 *      "trabajo de pintor 5 anos" as an escape.
 *   9. Typed job actions (Task 10) -- the ambiguous overlap with a
 *      confirmation-in-flight was already resolved at step 6; any typed job
 *      action reaching this point is a genuine escape.
 *  10. Relay-override consume+clear (Task 10, spec §4.2): a CHATS pick (or
 *      a conversation:focus tap) mid-fill arms this ONE-TURN flag
 *      (`setFocusedConversation`, conversation-router.ts) so the worker's
 *      very next free-text message relays to the newly-focused employer
 *      instead of feeding the fill. Cleared here, in the SAME turn it is
 *      consumed (`deps.updateStateContext`'s spread-merge + in-place
 *      mutation contract), so a SECOND free-text message goes back to
 *      feeding the fill -- without this clear every later message would
 *      relay forever and the fill would deadlock.
 *  11. `fill_pending`/cert-loop resolution (confirm/discard/entry-loop) for
 *      any body that reached this point WITHOUT parsing as a confirmation
 *      at step 6 (e.g. unrecognized text) -- re-echoes the confirmation,
 *      per spec §6 item 6, exactly as before Task 10.
 *  12. Current-step handling: doc-step free text re-sends the doc prompt
 *      (cooldown-guarded); field-step text goes through deterministic parse
 *      or extraction.
 */
export async function handleFillMessage(
  client: PoolClient,
  ctx: FillContext,
  msg: IncomingMessage,
  deps: FillDeps,
): Promise<FillResult> {
  const applicationId = ctx.stateContext.fill_application_id as string | undefined;
  if (!applicationId) return resolveOfferOnlyTurn(client, ctx, msg, deps);

  // (1) Button/interactive-payload escape -- see this function's jsdoc.
  if (msg.buttonPayload || msg.interactivePayload) {
    return { handled: false };
  }

  // (2) Media-first (spec §6 item 1) -- BEFORE the CANCELAR guard and before
  // any text parsing: a captioned photo's caption must never leak to the
  // text parser, so a media turn never even reads `msg.body`. jobId is
  // refreshed here too (see FillContext's jsdoc) since Task 8's doc writes
  // below consume ctx.jobId, and this branch never reaches the text path's
  // own refresh further down.
  if (msg.numMedia > 0) {
    ctx.jobId = (await fetchApplicationJobId(client, applicationId)) ?? ctx.jobId;
    return handleFillMediaTurn(client, ctx, msg, deps, applicationId);
  }

  const body = msg.body ?? '';

  // (3) CANCELAR guard (spec §6 item 2) -- before any parsing/extraction.
  if (isFillCancel(body)) {
    // FINAL-REVIEW Finding 1a/3: fill_relay_override and
    // fill_offer_application_id are ALSO scrubbed here (not just
    // fill_application_id/fill_pending) -- neither has any other exit-time
    // scrub site, so leaving either standing after a cancel would let it
    // poison the worker's NEXT fill arm (a stale override swallows their
    // first free-text answer and relays it into an old focused thread; a
    // stale offer id lets a later stray "1"/"si" re-arm a long-finished
    // application).
    await deps.updateStateContext(client, ctx.conversationId, { ...FILL_SCRUB });
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('canceled', ctx.lang));
    logStep('cancel', 'canceled');
    return { handled: true };
  }

  // (3b) CAMBIAR/CHANGE guard (sprint 24 L3) -- a reserved word of the same
  // class as CANCELAR, and checked in the same place: it must work from ANY
  // sub-state (mid-question, mid-confirmation, or at the all-pre-filled
  // gate), and it must win before a pending yes/no or a field parser can
  // look at the body.
  if (isFillChange(body)) {
    return openChangeMenu(client, ctx, msg, deps);
  }

  // (4) Picker-digit escape -- see this function's jsdoc.
  if (ctx.stateContext.pending_picker && /^\d{1,2}$/.test(body.trim())) {
    return { handled: false };
  }

  // (5) jobId (+ Task 11: requiredFields, for finalizeAnswer's de-required
  // guard) resolved fresh every turn (see FillContext's jsdoc) before any
  // step handling -- Task 8's doc writes consume ctx.jobId.
  const jobContext = await fetchApplicationJobContext(client, applicationId);
  ctx.jobId = jobContext.jobId ?? ctx.jobId;
  ctx.requiredFields = jobContext.requiredFields;

  // (5b) Change-menu resolution (sprint 24 L3). BEFORE step 6 on purpose:
  // the menu was the last thing this lane sent, so a bare '1' answers IT,
  // not a yes/no confirmation that happens to accept the same digit. A
  // non-digit body clears the menu and returns null, so the turn continues
  // down the ordinary path below.
  const changeMenu = ctx.stateContext.fill_change_menu as FillChangeMenuState | undefined;
  if (changeMenu) {
    const resolved = await resolveChangeMenu(client, ctx, msg, deps, changeMenu, body);
    if (resolved) return resolved;
  }

  const certLoopPending = Boolean(ctx.stateContext.fill_cert_more_pending);
  const pending = ctx.stateContext.fill_pending as FillPendingState | undefined;

  // (6) Confirmation-in-flight exception -- see this function's jsdoc.
  if ((certLoopPending || pending) && parseFillConfirmation(body) !== null) {
    if (certLoopPending) return resolveCertLoopPending(client, ctx, msg, deps, body);
    return resolveFillPending(client, ctx, msg, deps, pending!, applicationId, body);
  }

  // (7) Command escapes -- CHATS/CERRAR/help/support/profile.
  if (matchesCommandEscape(body)) {
    return { handled: false };
  }

  // (8) Exact-match jobs keyword.
  if (isExactJobsKeyword(body)) {
    return { handled: false };
  }

  // (9) Typed job actions.
  if (parseTypedJobAction(body)) {
    return { handled: false };
  }

  // (10) Relay-override consume+clear -- see this function's jsdoc.
  if (ctx.stateContext.fill_relay_override) {
    await deps.updateStateContext(client, ctx.conversationId, { fill_relay_override: null });
    logStep('relay_override', 'consumed');
    return { handled: false };
  }

  // (10b) The all-pre-filled gate (sprint 24 L3). AFTER the escapes, so
  // CHATS/CERRAR/help still work from it, and after CANCELAR/CAMBIAR, which
  // are its two other legitimate answers. LISTO/DONE completes; anything
  // else re-prompts once and then goes quiet without dropping the gate.
  const confirm = ctx.stateContext.fill_confirm as FillConfirmState | undefined;
  if (confirm) {
    return resolveFillConfirm(client, ctx, msg, deps, confirm, body);
  }

  // (11) Task 8's cert loop / fill_pending resolution (see
  // handleFillMediaTurn's jsdoc; review fix, bug A) -- reached only when the
  // body did NOT parse as a confirmation at step 6, so this is exactly the
  // "unrecognized text" re-echo path (reconfirm / cert-loop reconfirm).
  if (certLoopPending) {
    return resolveCertLoopPending(client, ctx, msg, deps, body);
  }
  if (pending) {
    return resolveFillPending(client, ctx, msg, deps, pending, applicationId, body);
  }

  // (11b) A replacement slot is armed (sprint 24 L3): the worker asked to
  // change a document and has sent text instead of a file. The engine's own
  // walk cannot name that slot -- the vault copy makes it read as satisfied
  // -- so re-send ITS prompt, cooldown-guarded like any other doc-step text.
  const replacePending = asCollectableDocType(ctx.stateContext.fill_doc_replace);
  if (replacePending) {
    return handleDocStepText(client, ctx, msg, deps, replacePending);
  }

  const { step: nextStep } = await computeFillStep(client, applicationId);
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
