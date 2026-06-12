import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';
import { timingSafeEqual } from 'node:crypto';

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

  const expected = Buffer.from(expectedOtp);
  const actual = Buffer.from(userAnswer ?? '');
  event.response.answerCorrect =
    expected.length === actual.length && timingSafeEqual(expected, actual);
  return event;
};
