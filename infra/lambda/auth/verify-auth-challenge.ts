import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { timingSafeEqual } from 'node:crypto';

const cognito = new CognitoIdentityProviderClient({});

/**
 * VerifyAuthChallenge: Compares the user's submitted answer against the
 * OTP stored in privateChallengeParameters by CreateAuthChallenge.
 *
 * The comparison itself is stateless — all context flows through Cognito's
 * session. The one side effect: a CORRECT answer is the first (and only)
 * real proof of phone possession, so it flips `phone_number_verified` to
 * 'true'. Signup paths (worker-web-signup.ts, worker-cognito-reconciliation
 * .ts) deliberately create accounts with 'false' — an unauthenticated POST
 * proves nothing, and pre-marking it verified let anyone pre-register
 * someone else's number as "verified". Best-effort: a Cognito hiccup here
 * must never fail a correct login, so the flip is caught-and-logged, never
 * rethrown.
 *
 * This trigger touches NO database: R2 made web signup phone-only, so there
 * is no staged name to promote here any more (migration 052's
 * stage_worker_pending_name / promote_worker_pending_name have no caller
 * left). The cleanup migration that drops them is 092 -- 091 is now the
 * application-stages migration, and 090's header still says 091 only
 * because it predates that renumbering and applied migrations are never
 * edited. The worker types their name at `profile.name` inside the
 * onboarding flow.
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

  if (event.response.answerCorrect && event.request.userAttributes?.phone_number_verified !== 'true') {
    try {
      await cognito.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        UserAttributes: [{ Name: 'phone_number_verified', Value: 'true' }],
      }));
    } catch (err) {
      console.warn('[verify-auth-challenge] phone_number_verified flip failed (login unaffected)', {
        err: (err as Error)?.message,
      });
    }
  }

  return event;
};
