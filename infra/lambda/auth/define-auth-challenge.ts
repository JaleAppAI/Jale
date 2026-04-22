import type { DefineAuthChallengeTriggerEvent } from 'aws-lambda';

/**
 * DefineAuthChallenge: Routes the custom auth challenge flow.
 *
 * Session routing:
 * - No prior challenges        → issue CUSTOM_CHALLENGE (first attempt)
 * - Last challenge succeeded   → issue tokens (OTP correct)
 * - 3+ failed attempts         → fail authentication
 * - Otherwise (retry allowed)  → issue another CUSTOM_CHALLENGE
 *
 * Used by the worker pool for passwordless OTP sign-in.
 */
export const handler = async (
  event: DefineAuthChallengeTriggerEvent,
): Promise<DefineAuthChallengeTriggerEvent> => {
  const session = event.request.session;

  if (session.length === 0) {
    // First call: issue a custom challenge (OTP will be generated in CreateAuthChallenge)
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = 'CUSTOM_CHALLENGE';
  } else if (
    session[session.length - 1].challengeResult === true
  ) {
    // Last challenge succeeded: issue tokens
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (session.length >= 3) {
    // 3+ failed attempts: fail authentication
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    // Failed but under the retry limit: issue another challenge
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = 'CUSTOM_CHALLENGE';
  }

  return event;
};
