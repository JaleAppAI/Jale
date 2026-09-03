// ---------------------------------------------------------------------------
// Pre-application prompts -- the employer's apply-time questions
// (`jobs.pre_application_prompts`, migration 091).
//
// Pure list algebra for `PreApplicationPromptsEditor` and `lib/job-form.ts`.
// No React, no next-intl: the editor owns the copy, this owns the rules.
//
// THE ONE RULE THAT MATTERS: an id is minted EXACTLY ONCE, by `mintPromptId`,
// from the editor's "Add a question" handler. Nothing else here mints. Once a
// job has applicants the backend LOCKS this list and compares it by content
// (`promptsNormalized`, mirroring `certification_requirements`), so a prompt
// that comes back with a fresh id reads as a CHANGE and 409s `field_locked` --
// which would make every later save of that job fail, even a title fix. It is
// also the key each stored answer is filed under, so a re-mint orphans answers
// that already exist. Read the id, keep the id, send the id back.
// ---------------------------------------------------------------------------

/**
 * Hard bound, byte-identical to the backend's: migration 091's
 * `pre_application_prompts_valid` CHECK and `parsePreApplicationPrompts`
 * both accept 1..500 characters of trimmed text. Past it the write is a 400
 * `invalid_pre_application_prompts`, so the form refuses first
 * (`prompt_too_long`).
 */
export const MAX_PROMPT_CHARS = 500;

/**
 * The number the editor's counter shows (`0/300`). Deliberately BELOW the hard
 * bound: 300 characters is already a long question to answer from a phone, and
 * the counter is guidance, not a gate. Nothing blocks on this -- see the
 * ratified single bound set in the sprint-23 design's cross-lane
 * reconciliations.
 */
export const SOFT_PROMPT_CHARS = 300;

/** Hard cap on how many questions one job may ask (migration 091's CHECK). */
export const MAX_PROMPTS = 10;

/** Past this, the editor's tip turns from advice into a warning. */
export const RECOMMENDED_MAX_PROMPTS = 2;

/** One row of the editor: a stable id plus whatever the employer has typed. */
export type PromptDraft = { id: string; text: string };

/** The wire shape -- `normalizePrompts`'s output, ready for the job payload. */
export type PreApplicationPromptPayload = { id: string; text: string };

/**
 * Migration 091's per-id CHECK. Applied on the way IN (`sanitizePrompts`) so a
 * stored value the database could not have produced -- a hand-rolled payload, a
 * replayed fixture -- never rides back out on the next save and turns a title
 * edit into a 400.
 */
const PROMPT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * A v4 UUID: 36 characters of hex and hyphens, which is inside the CHECK's
 * `^[A-Za-z0-9_-]{1,40}$`. `crypto.randomUUID` is available in every browser
 * this app supports and in Node 19+ (the test runner); it is deliberately NOT
 * feature-detected, because a silently weaker fallback id is worse than a loud
 * failure on a surface only employers reach.
 */
export function mintPromptId(): string {
    return crypto.randomUUID();
}

/** Whether the editor should still offer "Add a question". */
export function canAddPrompt(prompts: readonly PromptDraft[]): boolean {
    return prompts.length < MAX_PROMPTS;
}

/**
 * Appends one blank row with a fresh id. THE ONLY MINT SITE -- see this
 * module's header. Returns the same array at the cap so a caller's `onChange`
 * is a no-op rather than a re-render with identical content.
 */
export function addPrompt(prompts: readonly PromptDraft[]): PromptDraft[] {
    if (!canAddPrompt(prompts)) return prompts as PromptDraft[];
    return [...prompts, { id: mintPromptId(), text: '' }];
}

export function removePromptAt(prompts: readonly PromptDraft[], index: number): PromptDraft[] {
    if (index < 0 || index >= prompts.length) return prompts as PromptDraft[];
    return prompts.filter((_, i) => i !== index);
}

/** Swaps a row with its neighbour. `direction` is -1 (up) or 1 (down). */
export function movePrompt(
    prompts: readonly PromptDraft[],
    index: number,
    direction: -1 | 1,
): PromptDraft[] {
    const target = index + direction;
    if (index < 0 || index >= prompts.length) return prompts as PromptDraft[];
    if (target < 0 || target >= prompts.length) return prompts as PromptDraft[];
    const next = [...prompts];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

/** Replaces one row's text. The id is untouched -- see the header. */
export function updatePromptText(
    prompts: readonly PromptDraft[],
    index: number,
    text: string,
): PromptDraft[] {
    if (index < 0 || index >= prompts.length) return prompts as PromptDraft[];
    return prompts.map((prompt, i) => (i === index ? { ...prompt, text } : prompt));
}

export type PromptValidationCode = 'prompt_blank' | 'prompt_too_long';

/**
 * Form-level validation, in the same shape as `lib/job-form.ts`'s step
 * validators: the FIRST failing code, or `null`.
 *
 * Blank is reported before too-long across the whole list (not row by row):
 * an empty row is almost always an "Add a question" the employer never filled
 * in, and naming that is more useful than naming a long one further down.
 */
export function validatePrompts(prompts: readonly PromptDraft[]): PromptValidationCode | null {
    if (prompts.some((prompt) => prompt.text.trim().length === 0)) return 'prompt_blank';
    if (prompts.some((prompt) => prompt.text.trim().length > MAX_PROMPT_CHARS)) return 'prompt_too_long';
    return null;
}

/**
 * Editor state -> wire payload: trim, drop blanks, cap the length, KEEP every
 * id. Blanks are dropped rather than rejected because this also runs on the
 * always-send path (`jobFormToBasePayload`), where an untouched trailing "Add
 * a question" row must not become a 400.
 */
export function normalizePrompts(prompts: readonly PromptDraft[]): PreApplicationPromptPayload[] {
    return prompts
        .map((prompt) => ({ id: prompt.id, text: prompt.text.trim() }))
        .filter((prompt) => prompt.text.length > 0)
        .slice(0, MAX_PROMPTS);
}

/**
 * Wire value -> editor state. Total on `unknown`: a job read from before
 * migration 091 carries no key at all, and a replayed/hand-rolled payload may
 * carry anything. Malformed entries are DROPPED rather than repaired -- there
 * is no id we could invent for one that would not orphan its answers.
 */
export function sanitizePrompts(value: unknown): PromptDraft[] {
    if (!Array.isArray(value)) return [];
    const out: PromptDraft[] = [];
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object') continue;
        const { id, text } = entry as { id?: unknown; text?: unknown };
        if (typeof id !== 'string' || typeof text !== 'string') continue;
        if (!PROMPT_ID_RE.test(id)) continue;
        out.push({ id, text });
        if (out.length === MAX_PROMPTS) break;
    }
    return out;
}

/**
 * Which voice the editor's always-visible tip speaks in. Above the
 * recommendation the same advice becomes a warning, because by then the
 * employer has already done the thing it warns about.
 */
export function promptTipLevel(count: number): 'info' | 'warning' {
    return count > RECOMMENDED_MAX_PROMPTS ? 'warning' : 'info';
}
