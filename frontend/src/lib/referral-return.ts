// Validates and carries the referral context through the worker
// signup/OTP flow. Kept deliberately narrow: the redirect target is built
// from a bare job UUID, never a caller-supplied path -- an attacker-supplied
// query param that cannot express a path cannot express an open redirect.
//
// The stash is a BACKUP now, not the record. Sign-in tells the server which
// job the worker came for, and every onboarding screen reads it
// back from there, so it survives a new tab, another device and a login
// bounce. The stash only covers the one case the server cannot: a claim that
// never landed. That is also why nothing clears it on a visit that simply
// lacks `job`/`share` -- such visits are exactly the bounces it exists for.

import { locales } from '@/i18n/locales';
import { sanitizeReturnPath } from './login-url';

const STORAGE_KEY = 'pendingReferral';
const COMPLETING_KEY = 'authFlowCompleting';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/{locale}/worker/jobs/{id}`, optionally followed by a query or fragment. */
const JOB_RETURN_PATH_RE = /^\/([a-z]{2})\/worker\/jobs\/([^/?#]+)(?:[?#].*)?$/;

/**
 * How long sign-in waits for the claim before it starts the session anyway.
 * About four seconds: long enough for a slow phone connection to land the
 * request, short enough that a worker who has just typed the right code is
 * not left wondering whether it worked.
 */
export const CLAIM_WAIT_MS = 4_000;

export interface PendingReferral {
  jobId: string | null;
  shareCode: string | null;
}

/** Accepts ONLY a bare job UUID -- never a path, and never anything that
 * could be interpreted as one. */
export function validateJobId(value: string | null | undefined): string | null {
  if (!value) return null;
  return UUID_RE.test(value) ? value : null;
}

/**
 * The job a `returnUrl` is about, when it is a worker job page.
 *
 * `useRequireAuth` bounces a signed-out visitor to
 * `/{locale}/auth/worker?returnUrl=/{locale}/worker/jobs/<uuid>`, and that
 * sign-in is about that job exactly as a `?job=` link would be. Only a
 * same-origin path survives (`sanitizeReturnPath` runs first), only the job
 * DETAIL page counts, and the only thing that can come out is a bare UUID.
 */
export function jobIdFromReturnPath(path: string | null | undefined): string | null {
  const safe = sanitizeReturnPath(path ?? null);
  if (!safe) return null;
  const match = JOB_RETURN_PATH_RE.exec(safe);
  if (!match || !(locales as readonly string[]).includes(match[1])) return null;
  return validateJobId(match[2]);
}

/**
 * Runs `work` and waits for it to settle -- or for `ms` to pass, whichever
 * comes first. Never rejects: a failed or hung claim is simply over.
 *
 * It deliberately does NOT cancel `work`, and hands it nothing it could be
 * cancelled through. A claim still in flight when the wait ends keeps going
 * after the sign-in form unmounts (under `apiFetch`'s own per-attempt timeout)
 * and still lands; the onboarding read then picks the job up on a later
 * response. `work` is a function rather than a promise so a synchronous throw
 * is caught here too.
 */
export async function settleWithin(work: () => unknown, ms: number): Promise<'settled' | 'timed_out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), ms);
  });
  const settled = new Promise<unknown>((resolve) => resolve(work()))
    .then(() => 'settled' as const, () => 'settled' as const);
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The tab's session storage, or null where it cannot be used: outside the
 * browser; where the browser blocks this site's data, when the property access
 * itself throws; and where storage is switched off, when the property is null
 * (some in-app web views). Every helper below reaches storage through this and
 * inside its own `try`, so a refusal reads as "nothing stashed" or "not
 * completing" and can never interrupt a sign-in.
 */
function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : (sessionStorage ?? null);
  } catch {
    return null;
  }
}

/**
 * Stashes the referral context for the duration of the signup/OTP flow.
 * Best-effort carry-through, not core auth: storage that is blocked, switched
 * off or full simply keeps nothing.
 */
export function stashPendingReferral(referral: PendingReferral): void {
  try {
    sessionStore()?.setItem(STORAGE_KEY, JSON.stringify(referral));
  } catch {
    // best-effort only
  }
}

/** Reads the stashed referral context, tolerating garbage/missing JSON. */
export function readPendingReferral(): PendingReferral | null {
  let raw: string | null;
  try {
    raw = sessionStore()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const jobId = typeof parsed.jobId === 'string' ? parsed.jobId : null;
    const shareCode = typeof parsed.shareCode === 'string' ? parsed.shareCode : null;
    return { jobId, shareCode };
  } catch {
    return null;
  }
}

export function clearPendingReferral(): void {
  try {
    sessionStore()?.removeItem(STORAGE_KEY);
  } catch {
    // best-effort only
  }
}

// Single-ownership hand-off between WorkerAuthForm and the auth/worker page:
// while the form is mid-flow (between OTP success and its own router.push),
// this flag tells the page's already-authenticated-effect to stand down so
// the two don't both claim the referral and race on the redirect.

export function markAuthFlowCompleting(): void {
  try {
    sessionStore()?.setItem(COMPLETING_KEY, '1');
  } catch {
    // best-effort only
  }
}

export function isAuthFlowCompleting(): boolean {
  try {
    return sessionStore()?.getItem(COMPLETING_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearAuthFlowCompleting(): void {
  try {
    sessionStore()?.removeItem(COMPLETING_KEY);
  } catch {
    // best-effort only
  }
}
