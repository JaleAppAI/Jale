import { getEmployerProfile, updateEmployerProfile, type EmployerProfileData } from './api/employer';
import { clearSignupSource, signupSourceBody } from './signup-source';

/** The sign-up form's answers, saved on the first visit after sign-in (`EmployerAuthForm.savePendingSignupProfile`). */
export const PENDING_EMPLOYER_PROFILE_KEY = 'pendingEmployerProfile';

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

  const source = signupSourceBody();
  const promise = updateEmployerProfile(token, {
    ...answers,
    ...(source ? { signup_source: source } : {}),
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
