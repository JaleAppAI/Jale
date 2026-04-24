import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';

/**
 * VerifyAuthChallenge: Compares the user's submitted answer against the
 * OTP stored in privateChallengeParameters by CreateAuthChallenge.
 *
 * Stateless — all context flows through Cognito's session. No DB, no external calls.
 */
export const handler = async (
  event: VerifyAuthChallengeResponseTriggerEvent,
): Promise<VerifyAuthChallengeResponseTriggerEvent> => {
  const expectedOtp = event.request.privateChallengeParameters?.otp;
  const userAnswer = event.request.challengeAnswer;

  // Guard against missing expected OTP (shouldn't happen if CreateAuthChallenge ran correctly)
  if (!expectedOtp) {
    event.response.answerCorrect = false;
    return event;
  }

  // Constant-time comparison not strictly necessary here since the OTP is
  // 6 digits and the attacker would gain nothing from timing analysis (the
  // DefineAuthChallenge 3-attempt limit is the real rate control). But use
  // a simple equality check — matches the security posture of similar AWS
  // custom-auth examples.
  event.response.answerCorrect = userAnswer === expectedOtp;
  return event;
};
