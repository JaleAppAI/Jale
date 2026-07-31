// Validates and carries the referral "return" destination through the worker
// signup/OTP flow. Kept deliberately narrow: the only thing we ever redirect
// to after auth is an internal /worker/jobs/{uuid} path, never an arbitrary
// URL supplied by a query string.

const STORAGE_KEY = 'pendingReferral';

export interface PendingReferral {
  returnTo: string | null;
  shareCode: string | null;
}

/** Accepts ONLY an internal worker-job path -- never an open redirect. */
export function validateReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\/worker\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
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
    const returnTo = typeof parsed.returnTo === 'string' ? parsed.returnTo : null;
    const shareCode = typeof parsed.shareCode === 'string' ? parsed.shareCode : null;
    return { returnTo, shareCode };
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
