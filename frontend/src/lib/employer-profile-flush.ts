import { getEmployerProfile, updateEmployerProfile, type EmployerProfileData } from './api/employer';
import { clearSignupSource, signupSourceBody } from './signup-source';

/** The sign-up form's answers, saved on the first visit after sign-in (`EmployerAuthForm.savePendingSignupProfile`). */
export const PENDING_EMPLOYER_PROFILE_KEY = 'pendingEmployerProfile';

/** The one PATCH in flight, keyed by the stored answers it is sending. */
let inFlight: { payload: string; promise: Promise<EmployerProfileData> } | null = null;

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
 */
export function flushPendingEmployerProfile(token: string): Promise<EmployerProfileData | null> {
  const pending = sessionStorage.getItem(PENDING_EMPLOYER_PROFILE_KEY);
  if (!pending) return Promise.resolve(null);
  if (inFlight && inFlight.payload === pending) return inFlight.promise;

  const source = signupSourceBody();
  const promise = updateEmployerProfile(token, {
    ...JSON.parse(pending),
    ...(source ? { signup_source: source } : {}),
  }).then(
    (saved) => {
      // Only the answers this request sent: a newer stash is left for its own save.
      if (sessionStorage.getItem(PENDING_EMPLOYER_PROFILE_KEY) === pending) {
        sessionStorage.removeItem(PENDING_EMPLOYER_PROFILE_KEY);
        clearSignupSource();
      }
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
 * The profile page's load: the profile, then -- on the first visit after a
 * sign-up, if the dashboard has not already sent them -- the pending sign-up
 * answers (see `flushPendingEmployerProfile`). A failed save rejects the load,
 * as before, and leaves the answers for the next one.
 */
export async function loadEmployerProfileWithPendingFlush(
  token: string,
  signal?: AbortSignal,
): Promise<EmployerProfileData> {
  const loaded = await getEmployerProfile(token, signal);
  const saved = await flushPendingEmployerProfile(token);
  return saved ?? loaded;
}
