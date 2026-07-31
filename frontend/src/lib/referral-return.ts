// Validates and carries the referral context through the worker
// signup/OTP flow. Kept deliberately narrow: the redirect target is built
// from a bare job UUID, never a caller-supplied path -- an attacker-supplied
// query param that cannot express a path cannot express an open redirect.

const STORAGE_KEY = 'pendingReferral';
const COMPLETING_KEY = 'authFlowCompleting';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Stashes the referral context for the duration of the signup/OTP flow.
 * No-ops outside the browser and swallows storage errors (private
 * browsing / quota) since this is best-effort carry-through, not core auth.
 */
export function stashPendingReferral(referral: PendingReferral): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(referral));
  } catch {
    // best-effort only
  }
}

/** Reads the stashed referral context, tolerating garbage/missing JSON. */
export function readPendingReferral(): PendingReferral | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(STORAGE_KEY);
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
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort only
  }
}

// Single-ownership hand-off between WorkerAuthForm and the auth/worker page:
// while the form is mid-flow (between OTP success and its own router.push),
// this flag tells the page's already-authenticated-effect to stand down so
// the two don't both claim the referral and race on the redirect.

export function markAuthFlowCompleting(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(COMPLETING_KEY, '1');
  } catch {
    // best-effort only
  }
}

export function isAuthFlowCompleting(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return sessionStorage.getItem(COMPLETING_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearAuthFlowCompleting(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(COMPLETING_KEY);
  } catch {
    // best-effort only
  }
}
