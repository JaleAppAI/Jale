import { getEmployerProfile, updateEmployerProfile, type EmployerProfileData } from './api/employer';
import { clearSignupSource, signupSourceBody } from './signup-source';

/** The sign-up form's answers, saved on the first visit after sign-in (`EmployerAuthForm.savePendingSignupProfile`). */
export const PENDING_EMPLOYER_PROFILE_KEY = 'pendingEmployerProfile';

/**
 * The profile page's load: the profile, then -- on the first visit after a
 * sign-up -- the PATCH of the answers the sign-up form collected, carrying the
 * first-party signup source (contract K3.6). Both stashes are dropped only
 * after the PATCH resolves; a failed one leaves them for the next load.
 *
 * The PATCH takes no signal: it is a write, and a half-applied profile the app
 * then forgets about is worse than a request that outlives the page.
 */
export async function loadEmployerProfileWithPendingFlush(
  token: string,
  signal?: AbortSignal,
): Promise<EmployerProfileData> {
  let loaded = await getEmployerProfile(token, signal);
  const pending = sessionStorage.getItem(PENDING_EMPLOYER_PROFILE_KEY);
  if (pending) {
    const source = signupSourceBody();
    loaded = await updateEmployerProfile(token, {
      ...JSON.parse(pending),
      ...(source ? { signup_source: source } : {}),
    });
    sessionStorage.removeItem(PENDING_EMPLOYER_PROFILE_KEY);
    clearSignupSource();
  }
  return loaded;
}
