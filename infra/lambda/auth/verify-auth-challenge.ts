import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';
import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { timingSafeEqual } from 'node:crypto';
import { getDbPool } from '../lib/db';

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
 * The same first-correct-OTP moment also promotes any name staged at
 * signup (migration 052's promote_worker_pending_name) into
 * users.full_name, so a worker who closes the tab before the authenticated
 * post-OTP profile PATCH still ends up with a name. Guarded by the same
 * phone_number_verified check as the flip above, so it only ever runs once
 * per worker, not on every login. Best-effort like the flip: a database
 * stall or error here must never fail a correct login.
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

    await promoteWorkerPendingName(event.request.userAttributes?.sub);
  }

  return event;
};

// Promotes a name staged at signup (stage_worker_pending_name) into
// users.full_name, but only on the first correct OTP (callers gate this on
// phone_number_verified !== 'true') and only while full_name is still NULL
// (enforced inside promote_worker_pending_name itself). `sub` is read from
// event.request.userAttributes.sub, the same Cognito-issued identifier
// PostConfirmation writes to users.cognito_sub. Best-effort: a database
// stall or error must never fail a correct login, so this is caught and
// logged, never rethrown. A short statement timeout on this session (not
// the shared pool default) bounds how long a database stall can add to a
// login.
async function promoteWorkerPendingName(cognitoSub: string | undefined): Promise<void> {
  if (!cognitoSub) return;

  let client;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query("SET statement_timeout = '2000ms'");
    await client.query('SELECT promote_worker_pending_name($1)', [cognitoSub]);
  } catch (err) {
    console.warn('[verify-auth-challenge] pending name promotion failed (login unaffected)', {
      err: (err as Error)?.message,
    });
  } finally {
    if (client) client.release();
  }
}
