/**
 * Where a signup came from, first-party only (analytics item #16, contract
 * K3.6, privacy check D-A1/D-A8).
 *
 * A Jale-issued code (`?src=flyer`) on Jale's own links -- `/app`, the public
 * job page `/j/<code>`, the employer sign-up page -- plus which of those doors
 * the visitor came through. Never `utm_*`, `document.referrer` or cookies.
 *
 * Stashed in `sessionStorage` on the first load of one of those pages and
 * sent once, with the worker signup or the employer's first profile save.
 * The FIRST touch of the visit wins and is never overwritten. Best-effort
 * throughout: storage that refuses simply records nothing, and nothing here
 * can throw into a page or a signup.
 */

export const SIGNUP_SOURCE_STORAGE_KEY = 'jale.signup-source';

/**
 * Mirror of `SIGNUP_SOURCE_CODES` in `infra/lambda/lib/signup-source.ts` (the
 * server owns the list and re-validates). `signup-source-mirror.test.ts`
 * fails when the two differ.
 */
export const SIGNUP_SOURCE_CODES = [
  'flyer',
  'qr',
  'sms',
  'facebook-page',
  'instagram',
  'partner',
  'event',
  'other',
] as const;

export type SignupSourceCode = (typeof SIGNUP_SOURCE_CODES)[number];
export type SignupEntry = 'app' | 'job_link' | 'signup_page';
export type SignupSourceStash = { src: SignupSourceCode | null; entry: SignupEntry; capturedAt: string };
/** The K3.6 wire shape: `signup_source` on the worker signup body and the employer profile PATCH. */
export type SignupSourceBody = { src: string | null; entry: string };

const SRC_PATTERN = /^[a-z0-9-]{2,32}$/;
const ENTRIES: readonly SignupEntry[] = ['app', 'job_link', 'signup_page'];

/** The code, when it is one of Jale's own; null otherwise. Exact: no case folding, no trimming. */
export function normalizeSignupSourceCode(raw: string | null | undefined): SignupSourceCode | null {
  if (typeof raw !== 'string' || !SRC_PATTERN.test(raw)) return null;
  return (SIGNUP_SOURCE_CODES as readonly string[]).includes(raw) ? (raw as SignupSourceCode) : null;
}

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The stash, or null when there is none or it cannot be trusted. */
export function readSignupSource(): SignupSourceStash | null {
  let raw: string | null;
  try {
    raw = store()?.getItem(SIGNUP_SOURCE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const entry = ENTRIES.find((candidate) => candidate === record.entry);
    if (!entry) return null;
    let src: SignupSourceCode | null = null;
    if (record.src !== null) {
      src = normalizeSignupSourceCode(typeof record.src === 'string' ? record.src : null);
      if (src === null) return null;
    }
    return { src, entry, capturedAt: typeof record.capturedAt === 'string' ? record.capturedAt : '' };
  } catch {
    return null;
  }
}

/** Records this touch unless the visit already has one. Never throws. */
export function captureSignupSource(input: { src: string | null; entry: SignupEntry }, now: Date = new Date()): void {
  if (readSignupSource() !== null) return;
  const stash: SignupSourceStash = {
    src: normalizeSignupSourceCode(input.src),
    entry: input.entry,
    capturedAt: now.toISOString(),
  };
  try {
    store()?.setItem(SIGNUP_SOURCE_STORAGE_KEY, JSON.stringify(stash));
  } catch {
    // Best effort: a refused write records nothing.
  }
}

/** What to send with a signup, or null when nothing was captured. */
export function signupSourceBody(): SignupSourceBody | null {
  const stash = readSignupSource();
  return stash ? { src: stash.src, entry: stash.entry } : null;
}

/** Called once the source has gone out with a signup: it is sent once per visit. */
export function clearSignupSource(): void {
  try {
    store()?.removeItem(SIGNUP_SOURCE_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
