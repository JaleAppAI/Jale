import { getEmployerProfile, updateEmployerProfile, type EmployerProfileData } from './api/employer';
import { ApiError } from './api/errors';
import { clearSignupSource, signupSourceBody } from './signup-source';

/** The sign-up form's answers, saved on the first visit after sign-in (`EmployerAuthForm.savePendingSignupProfile`). */
export const PENDING_EMPLOYER_PROFILE_KEY = 'pendingEmployerProfile';

// ---------------------------------------------------------------------------
// The stored invite (Phase 3)
//
// The invite page stores `{ token, email }` once its lookup succeeds, so the
// token survives a reload after it has left the address bar. A sign-up's
// confirm forwards the token to Cognito only for that same email (I4): a
// stale token from another invite or another address is never sent. It is
// cleared once accepted, or once a sign-up's confirm has carried it.
// ---------------------------------------------------------------------------

export const PENDING_INVITE_KEY = 'pendingInvite';

export type PendingInvite = { token: string; email: string };

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Stores the invite with its email normalised. Storage out of reach: nothing is stored. */
export function storePendingInvite(invite: PendingInvite): void {
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ token: invite.token, email: normaliseEmail(invite.email) }));
  } catch {
    // The page still holds the token for this visit.
  }
}

/** The stored invite, or null when there is none, it is malformed, or storage is out of reach. */
export function readPendingInvite(): PendingInvite | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { token, email } = parsed as { token?: unknown; email?: unknown };
    if (typeof token !== 'string' || !token || typeof email !== 'string' || !email) return null;
    return { token, email: normaliseEmail(email) };
  } catch {
    return null;
  }
}

export function clearPendingInvite(): void {
  try {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Nothing to clear when storage is out of reach.
  }
}

/** The stored token when its invite was sent to `email` (trimmed, case-insensitive); otherwise null. */
export function storedInviteTokenFor(email: string): string | null {
  const wanted = normaliseEmail(email);
  if (!wanted) return null;
  const stored = readPendingInvite();
  return stored && stored.email === wanted ? stored.token : null;
}

/** The one PATCH in flight, keyed by the stored answers it is sending. */
let inFlight: { payload: string; promise: Promise<EmployerProfileData> } | null = null;

/** The stored answers as text, or null when there are none or storage is out of reach. */
function readPending(): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(PENDING_EMPLOYER_PROFILE_KEY);
  } catch {
    return null;
  }
}

/** The stored answers as an object, or null when the text cannot be read as one. */
function parsePending(pending: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(pending);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The stash's fields a foreman may write about themselves: `contact_name` and `phone`, when present. */
function foremanAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  if ('contact_name' in answers) own.contact_name = answers.contact_name;
  if ('phone' in answers) own.phone = answers.phone;
  return own;
}

/** Drops the answers this request sent, leaving a newer stash for its own save. */
function forgetPending(pending: string): void {
  try {
    if (sessionStorage.getItem(PENDING_EMPLOYER_PROFILE_KEY) !== pending) return;
    sessionStorage.removeItem(PENDING_EMPLOYER_PROFILE_KEY);
  } catch {
    return;
  }
  clearSignupSource();
}

/**
 * PATCHes the answers the sign-up form collected, carrying the first-party
 * signup source (contract K3.6), and resolves to the saved profile -- or to
 * `null` when nothing is pending.
 *
 * Both the dashboard (where a new employer lands) and the profile page call
 * this, and React may run an effect twice, so asks for the same stored answers
 * share ONE request. Both stashes are dropped only after the PATCH resolves; a
 * failed one leaves them for the next ask.
 *
 * The PATCH takes no signal: it is a write, and a half-applied profile the app
 * then forgets about is worse than a request that outlives the page.
 *
 * Never throws synchronously (the dashboard calls it from an effect): storage
 * that is out of reach reads as nothing pending, and a stash that is not a
 * JSON object is kept as it is and not sent.
 */
export function flushPendingEmployerProfile(token: string): Promise<EmployerProfileData | null> {
  const pending = readPending();
  if (!pending) return Promise.resolve(null);
  if (inFlight && inFlight.payload === pending) return inFlight.promise;
  const answers = parsePending(pending);
  if (!answers) return Promise.resolve(null);

  // A company sign-up's source only. An invited foreman's stash is
  // `{ contact_name, phone }` (no `company_name`): they did not sign a
  // company up, and a foreman's write carries no company fields.
  const source = 'company_name' in answers ? signupSourceBody() : null;
  const promise = updateEmployerProfile(token, {
    ...answers,
    ...(source ? { signup_source: source } : {}),
  }).catch((err: unknown) => {
    // A company sign-up's stash on a login the backend made a foreman (its
    // post-confirmation accepted a live invite for the confirmed email):
    // company fields are the owner's, so the PATCH is refused with 403
    // `owner_required`, and would be on every load. Save what is the
    // foreman's own -- name and phone -- and let the rest go.
    if (!(err instanceof ApiError && err.status === 403 && err.code === 'owner_required')) throw err;
    const own = foremanAnswers(answers);
    return Object.keys(own).length > 0 ? updateEmployerProfile(token, own) : getEmployerProfile(token);
  }).then(
    (saved) => {
      forgetPending(pending);
      if (inFlight?.promise === promise) inFlight = null;
      return saved;
    },
    (err: unknown) => {
      if (inFlight?.promise === promise) inFlight = null;
      throw err;
    },
  );
  inFlight = { payload: pending, promise };
  return promise;
}

/**
 * The profile page's load. The pending sign-up answers go first (or the load
 * joins the dashboard's save of them already in flight), and the saved profile
 * that comes back is the answer; the profile is read only when nothing was
 * pending. Reading first could answer with data served before the save landed,
 * and a later save from that form would write blanks over it. A failed save
 * rejects the load, as before, and leaves the answers for the next one.
 */
export async function loadEmployerProfileWithPendingFlush(
  token: string,
  signal?: AbortSignal,
): Promise<EmployerProfileData> {
  const saved = await flushPendingEmployerProfile(token);
  return saved ?? getEmployerProfile(token, signal);
}
