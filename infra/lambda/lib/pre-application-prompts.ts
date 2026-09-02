// pre-application-prompts.ts
//
// The employer's free-text "pre-application prompts" -- the short questions
// a worker answers at APPLY time (stage 1), before the employer has asked
// for anything else. Stored as `jobs.pre_application_prompts` (JSONB array
// of `{id, text}`, 091_application_stages.sql) and answered into
// `job_applications.prompt_answers` (JSONB object keyed on prompt id).
//
// Surface-agnostic and DB-free by construction: no `PoolClient`, no
// `APIGatewayProxyEvent`. Both doors call the same functions -- the web
// apply handler (`api/worker-jobs-apply.ts` via `lib/applications.ts`) and
// the WhatsApp prompt lane -- so a prompt answer that is legal on one
// surface is legal on the other. Same house rule as
// certification-claims.ts.
//
// ── WHY A SEPARATE COLUMN, NOT A RESERVED ANSWERS KEY ────────────
// `prompt_answers` is deliberately NOT a key inside
// `job_applications.application_answers`: that keeps the 16 KB answers cap
// and every `Object.keys(application_answers)` reader untouched, and it
// makes write-once a single SQL expression (`$1::jsonb || prompt_answers`,
// see `mergePromptAnswers` in application-requirements.ts -- the EXISTING
// key wins). Prompt ids, unlike answer keys, are employer-minted and
// unbounded in vocabulary, so they could never live behind the closed
// allowlists that guard `required_fields` (073) / `optional_fields` (074).
//
// ── THE ONE BOUND SET ────────────────────────────────────────────
// These four constants are the single source of truth for the app layer and
// must be kept in sync BY HAND with the CHECK constraints 091 installs --
// `pre_application_prompts_valid(p)` on `jobs` and the `octet_length` cap on
// `job_applications.prompt_answers`. Nothing enforces that automatically
// (same caveat 073/074/077/078 all carry for their own mirrored lists), so a
// change to either side is a two-file change.
//
//   MAX_PRE_APPLICATION_PROMPTS  10     prompts per job
//   MAX_PROMPT_TEXT_LENGTH       500    chars per prompt, trimmed
//   MAX_PROMPT_ANSWER_LENGTH     1000   chars per answer, trimmed
//   MAX_PROMPT_ANSWERS_BYTES     12288  UTF-8 bytes for the whole object
//
// The byte cap matters on its own: ten 1000-character answers pass every
// per-answer rule, but ten 1000-character answers of accented or emoji text
// are 2-4 bytes per character and would breach the column CHECK, raising a
// raw 23514 that no handler maps -- an unhandled 500 on entirely ordinary
// Spanish input. `validatePromptAnswers`/`normalizePromptAnswers` therefore
// measure `Buffer.byteLength` of the serialized object, not just its length.
import { randomUUID } from 'crypto';

export const MAX_PRE_APPLICATION_PROMPTS = 10;
export const MAX_PROMPT_TEXT_LENGTH = 500;
export const MAX_PROMPT_ANSWER_LENGTH = 1000;
export const MAX_PROMPT_ANSWERS_BYTES = 12288;

// Mirrors 091's `id ~ '^[A-Za-z0-9_-]{1,40}$'`. A minted `randomUUID()` (36
// chars of hex and dashes) satisfies it by construction.
const PROMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export interface PreApplicationPrompt {
  id: string;
  text: string;
}

export type PromptAnswers = Record<string, string>;

export type ParsePreApplicationPromptsResult =
  | { ok: true; value: PreApplicationPrompt[] }
  | { ok: false; error: 'invalid_pre_application_prompts' };

export type ValidatePromptAnswersResult =
  | { ok: true; value: PromptAnswers }
  | { ok: false; error: 'invalid_prompt_answers' }
  | { ok: false; error: 'missing_prompt_answers'; missing: string[] };

export type NormalizePromptAnswersResult =
  | { ok: true; value: PromptAnswers }
  | { ok: false; error: 'invalid_prompt_answers' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INVALID_PROMPTS = { ok: false, error: 'invalid_pre_application_prompts' } as const;
const INVALID_ANSWERS = { ok: false, error: 'invalid_prompt_answers' } as const;

/**
 * Parses an employer-supplied `pre_application_prompts` request value (job
 * create/update) into the canonical stored shape.
 *
 * Rules, all of them fail-CLOSED with a single error code (unlike
 * `promptsNormalized`/`parsePreApplicationPromptList` below, which read
 * already-stored data and must degrade gracefully):
 *   - absent / null -> `[]` (the column default; omitting the field is never
 *     itself an error).
 *   - must be an array of at most MAX_PRE_APPLICATION_PROMPTS plain objects
 *     with EXACTLY the keys `id` (optional on input) and `text` -- an extra
 *     key is rejected rather than dropped, because 091's CHECK also insists
 *     on exactly two keys and silently discarding one here would let a
 *     future field disappear without anyone noticing.
 *   - `text` is trimmed and must then be 1..MAX_PROMPT_TEXT_LENGTH chars.
 *   - `id`, when supplied, must match PROMPT_ID_PATTERN and be distinct
 *     within the list. A malformed id is REJECTED, never re-minted:
 *     `prompt_answers` is keyed on these ids, so quietly replacing one
 *     would orphan every answer already stored under it.
 *   - `id`, when absent (or an empty string), is minted with
 *     `randomUUID()`. This is the only non-pure part of this module.
 */
export function parsePreApplicationPrompts(raw: unknown): ParsePreApplicationPromptsResult {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return INVALID_PROMPTS;
  if (raw.length > MAX_PRE_APPLICATION_PROMPTS) return INVALID_PROMPTS;

  const value: PreApplicationPrompt[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!isPlainObject(entry)) return INVALID_PROMPTS;
    for (const key of Object.keys(entry)) {
      if (key !== 'id' && key !== 'text') return INVALID_PROMPTS;
    }

    if (typeof entry.text !== 'string') return INVALID_PROMPTS;
    const text = entry.text.trim();
    if (text.length === 0 || text.length > MAX_PROMPT_TEXT_LENGTH) return INVALID_PROMPTS;

    let id: string;
    if (entry.id === undefined || entry.id === null) {
      id = randomUUID();
    } else {
      if (typeof entry.id !== 'string' || !PROMPT_ID_PATTERN.test(entry.id)) return INVALID_PROMPTS;
      id = entry.id;
    }

    if (seen.has(id)) return INVALID_PROMPTS;
    seen.add(id);
    value.push({ id, text });
  }

  return { ok: true, value };
}

/**
 * Reads an ALREADY-STORED `jobs.pre_application_prompts` column value
 * defensively. FAILS OPEN, exactly like `parseCertificationRequirements`
 * (certification-claims.ts): a non-array becomes `[]` and a malformed entry
 * is dropped rather than thrown, so a corrupt or hand-edited row degrades to
 * "this job asks no prompts" instead of 500-ing the apply path. Every reader
 * of the column (apply, the stage-2 door, the employer reads) goes through
 * this; only the employer WRITE path uses the strict
 * `parsePreApplicationPrompts` above.
 */
export function parsePreApplicationPromptList(raw: unknown): PreApplicationPrompt[] {
  if (!Array.isArray(raw)) return [];
  const value: PreApplicationPrompt[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_PRE_APPLICATION_PROMPTS)) {
    if (!isPlainObject(entry)) continue;
    const { id, text } = entry;
    if (typeof id !== 'string' || !PROMPT_ID_PATTERN.test(id)) continue;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_TEXT_LENGTH) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    value.push({ id, text: trimmed });
  }
  return value;
}

/**
 * The post-applicants edit lock's comparison key, same shape as
 * `certReqsNormalized` in employer-jobs-update.ts: compare normalized
 * CONTENT, not `JSON.stringify` of the raw column, because jsonb sorts
 * object keys on storage and a byte comparison would read an unchanged
 * round-trip as an edit. Entry ORDER is significant on purpose -- the UI
 * never reorders, so a reorder implies a real edit.
 *
 * Accepts a raw column value as well as a parsed list (a non-array yields
 * '[]'), so the "current" and "incoming" sides can be compared without
 * pre-parsing either.
 */
export function promptsNormalized(value: unknown): string {
  return JSON.stringify(
    (Array.isArray(value) ? value : []).map((entry: any) => [entry?.id, entry?.text]),
  );
}

function collectAnswers(
  prompts: unknown,
  raw: unknown,
): { ok: true; value: PromptAnswers; known: PreApplicationPrompt[] } | { ok: false } {
  const known = Array.isArray(prompts) ? parsePreApplicationPromptList(prompts) : [];
  const knownIds = new Set(known.map((prompt) => prompt.id));

  if (raw === undefined || raw === null) return { ok: true, value: {}, known };
  if (!isPlainObject(raw)) return { ok: false };

  // Built fresh from validated keys only -- never spread the input, so
  // __proto__/constructor-style keys cannot ride along (they are also never
  // a known prompt id, which is what actually rejects them).
  const value: PromptAnswers = {};
  for (const key of Object.keys(raw)) {
    if (!knownIds.has(key)) return { ok: false };
    const answer = raw[key];
    if (typeof answer !== 'string') return { ok: false };
    const trimmed = answer.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_ANSWER_LENGTH) return { ok: false };
    value[key] = trimmed;
  }

  // The column CHECK is on UTF-8 BYTES, not characters -- see this file's
  // header for why the per-answer char bounds above are not enough.
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PROMPT_ANSWERS_BYTES) {
    return { ok: false };
  }

  return { ok: true, value, known };
}

/**
 * The APPLY-time gate: shape + known ids + per-answer bounds + byte cap,
 * AND completeness -- every prompt the job asks must be answered, since
 * stage 1 is the one moment the worker is being asked them all at once.
 * Returns the trimmed values on success.
 *
 * `prompts` may be either a parsed `PreApplicationPrompt[]` or the raw
 * jsonb column value.
 */
export function validatePromptAnswers(prompts: unknown, raw: unknown): ValidatePromptAnswersResult {
  const collected = collectAnswers(prompts, raw);
  if (!collected.ok) return INVALID_ANSWERS;

  const missing = collected.known
    .filter((prompt) => !Object.prototype.hasOwnProperty.call(collected.value, prompt.id))
    .map((prompt) => prompt.id);
  if (missing.length > 0) return { ok: false, error: 'missing_prompt_answers', missing };

  return { ok: true, value: collected.value };
}

/**
 * The TOP-UP path: everything `validatePromptAnswers` checks EXCEPT
 * completeness. A WhatsApp worker who answered prompt 1 of 2 and then said
 * `cancelar` keeps the application with a partial `prompt_answers`, and
 * finishes the rest later (on WhatsApp, or on the web stage-2 door) one id
 * at a time. `mergePromptAnswers` (application-requirements.ts) uses this;
 * outstanding prompts are tracked by `computeRemaining`, not by an error
 * here.
 */
export function normalizePromptAnswers(prompts: unknown, raw: unknown): NormalizePromptAnswersResult {
  const collected = collectAnswers(prompts, raw);
  if (!collected.ok) return INVALID_ANSWERS;
  return { ok: true, value: collected.value };
}
