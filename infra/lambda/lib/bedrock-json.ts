/**
 * Lenient JSON extraction for Bedrock Converse responses.
 *
 * Every "return only JSON" prompt eventually meets a model that wraps the
 * payload in a markdown fence or introduces it with a sentence. Stripping
 * fences alone (the old idiom in every caller) turned that into a hard parse
 * failure -- which is exactly how the employer candidate reranker filled its
 * DLQ after the Haiku 4.5 cutover. This module centralises the tolerant
 * parse so every Bedrock caller deviates the same way.
 *
 * The scan is ported from `ai/trust-extractor.ts`'s `firstJsonValue` (a
 * string-aware balanced-brace walk) and extended to top-level arrays. That
 * copy is deliberate: trust-extractor.ts is out of scope for this change, so
 * the idiom is duplicated rather than lifted out from under a working
 * extractor.
 */

/** Thrown when a response holds no parseable JSON value at all. */
export class BedrockJsonParseError extends Error {
  readonly kind = 'parse' as const;

  constructor(message = 'bedrock response is not JSON') {
    super(message);
    this.name = 'BedrockJsonParseError';
  }
}

/**
 * How many candidate start positions the scan will try before giving up.
 * Prose can contain a stray bracket ("the JSON [as requested]:"), so the scan
 * advances past unparseable runs; the cap keeps a pathological response from
 * turning into a quadratic walk.
 */
const MAX_SCAN_STARTS = 20;

/** Removes a surrounding ```json / ``` fence and trims the result. */
export function stripCodeFences(raw: string): string {
  return raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * Returns the first balanced, parseable JSON object or array substring in
 * `raw`, or null when there is none. Tolerates prose before and after the
 * value; string-aware, so a brace or bracket inside a quoted string (a
 * worker's own words, a label) cannot end the value early.
 */
export function extractFirstJsonValue(raw: string): string | null {
  let searchFrom = 0;
  for (let attempt = 0; attempt < MAX_SCAN_STARTS; attempt += 1) {
    const start = nextValueStart(raw, searchFrom);
    if (start === -1) return null;
    const candidate = balancedValueAt(raw, start);
    if (candidate !== null && isParseable(candidate)) return candidate;
    searchFrom = start + 1;
  }
  return null;
}

/**
 * Parses a Bedrock text response as JSON: the fence-stripped text first, then
 * the first JSON value embedded in surrounding prose.
 *
 * @throws BedrockJsonParseError when neither yields JSON. The message carries
 * no model output -- callers log metrics, not content.
 */
export function parseBedrockJson<T>(raw: string): T {
  const cleaned = stripCodeFences(raw ?? '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall through to the prose-tolerant scan.
  }

  const candidate = extractFirstJsonValue(cleaned);
  if (candidate === null) throw new BedrockJsonParseError();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new BedrockJsonParseError();
  }
}

/** Index of the next `{` or `[` at or after `from`, or -1. */
function nextValueStart(text: string, from: number): number {
  const brace = text.indexOf('{', from);
  const bracket = text.indexOf('[', from);
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/**
 * Returns the balanced run that starts at `start`, or null when it never
 * closes. Tracks the expected closers on a stack so `{"a":[1,2]}` closes in
 * the right order, and skips everything inside a JSON string.
 */
function balancedValueAt(text: string, start: number): string | null {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      closers.push('}');
    } else if (char === '[') {
      closers.push(']');
    } else if (char === '}' || char === ']') {
      if (closers.pop() !== char) return null;
      if (closers.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function isParseable(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}
