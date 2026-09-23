import type { DefineAuthChallengeTriggerEvent } from 'aws-lambda';

/**
 * DefineAuthChallenge: Routes the custom auth challenge flow.
 *
 * Session routing:
 * - User does not exist        → fail authentication (no challenge)
 * - No prior challenges        → issue CUSTOM_CHALLENGE (first attempt)
 * - Last challenge succeeded   → issue tokens (OTP correct)
 * - 3+ failed attempts         → fail authentication
 * - Otherwise (retry allowed)  → issue another CUSTOM_CHALLENGE
 *
 * Used by the worker pool for passwordless OTP sign-in.
 *
 * `userNotFound`: the worker pool client sets `preventUserExistenceErrors:
 * true` (lib/constructs/cognito-pool.ts). Under that setting Cognito does NOT
 * return UserNotFoundException for an unknown phone -- it runs the custom-auth
 * triggers anyway with `request.userNotFound = true` and EMPTY userAttributes,
 * so the caller cannot tell a real account from a missing one. Without this
 * branch the flow fell through to CreateAuthChallenge, which threw on the
 * missing `phone_number` attribute: a Lambda error (WorkerOtpSendErrors) for
 * every "Send code" tap on an unregistered phone, and a
 * UserLambdaValidationException in the browser instead of the masked
 * NotAuthorizedException the setting is meant to produce. Failing
 * authentication here keeps the masking AND never invokes the sender.
 */
export const handler = async (
  event: DefineAuthChallengeTriggerEvent,
): Promise<DefineAuthChallengeTriggerEvent> => {
  const session = event.request.session;

  if (event.request.userNotFound === true) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

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
