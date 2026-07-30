import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomInt } from 'node:crypto';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { reconcileWorkerCognitoAccount } from './lib/worker-cognito-reconciliation';

const cognito = new CognitoIdentityProviderClient({});
const CORS_HEADERS = corsHeaders();

interface SignupBody {
  phone?: string;
  fullName?: string;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let body: SignupBody;
  try {
    body = JSON.parse(event.body ?? '{}') as SignupBody;
  } catch {
    return json(400, { error: 'invalid_json', message: 'Request body must be valid JSON.' });
  }

  const phone = body.phone?.trim() ?? '';
  const fullName = body.fullName?.trim() ?? '';

  if (!/^\+\d{8,15}$/.test(phone)) {
    return json(400, { error: 'invalid_phone', message: 'Phone must be in E.164 format.' });
  }

  if (!fullName) {
    return json(400, { error: 'missing_full_name', message: 'fullName is required.' });
  }

  const userPoolId = process.env.WORKER_POOL_ID;
  if (!userPoolId) {
    console.error('worker-web-signup missing WORKER_POOL_ID');
    return json(500, { error: 'server_config', message: 'Worker signup is not configured.' });
  }

  try {
    // Hardening (2026-07-26 security review): this endpoint is
    // unauthenticated, so NOTHING the caller supplies is identity proof.
    // The account is created with phone_number_verified='false' (flipped by
    // verify-auth-challenge.ts on the first correct OTP) and WITHOUT the
    // caller's fullName — pre-marking a stranger's number "verified" with an
    // attacker-chosen name was a pre-registration poisoning vector. The name
    // reaches the DB moments later through the authenticated post-OTP
    // profile update the frontend already performs on every signup
    // (WorkerAuthForm's pendingWorkerProfile → PATCH /worker/profile).
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: phone,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: randomPassword(),
        UserAttributes: [
          { Name: 'phone_number', Value: phone },
          { Name: 'phone_number_verified', Value: 'false' },
          { Name: 'custom:user_type', Value: 'worker' },
        ],
      }));
    } catch (err: any) {
      if (err?.name !== 'UsernameExistsException') throw err;
      const repaired = await reconcileWorkerCognitoAccount({
        client: cognito,
        userPoolId,
        phone,
      });
      // '' is a safe no-op through reconcile_worker_signup's NULLIF/COALESCE:
      // it never clobbers an existing users.full_name and leaves a new row's
      // name NULL for the authenticated post-OTP update to fill.
      await seedWorkerUser(repaired.cognitoSub, phone, '');
      // Stage the caller-supplied name for promotion on the first correct
      // OTP (see stageWorkerPendingName below) so a worker who closes the
      // tab before the authenticated post-OTP PATCH still gets a name.
      await stageWorkerPendingName(repaired.cognitoSub, fullName);
      return json(200, { ok: true });
    }

    const confirmed = await cognito.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: phone,
    }));
    const cognitoSub = confirmed.UserAttributes?.find((attr) => attr.Name === 'sub')?.Value;

    if (!cognitoSub) {
      throw new Error('Unable to resolve Cognito sub for worker signup.');
    }

    // Same rationale as the reconcile branch: the users row is seeded
    // WITHOUT the caller-supplied name; the authenticated post-OTP profile
    // update owns it. `fullName` is still validated above purely as an API
    // contract check (the frontend always sends it).
    await seedWorkerUser(cognitoSub, phone, '');
    // Stage the caller-supplied name for promotion on the first correct OTP
    // (see stageWorkerPendingName below) so a worker who closes the tab
    // before the authenticated post-OTP PATCH still gets a name.
    await stageWorkerPendingName(cognitoSub, fullName);
    await ensureWorkerGroup(userPoolId, phone);

    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: phone,
      Password: randomPassword(),
      Permanent: true,
    }));

    return json(200, { ok: true });
  } catch (err: any) {
    console.error('worker-web-signup error:', errorMessage(err));

    if (err?.name === 'InvalidPasswordException') {
      return json(400, { error: 'password_requirements', message: 'Generated password did not meet policy.' });
    }

    if (err?.name === 'InvalidParameterException') {
      return json(400, { error: 'invalid_phone', message: 'Phone number is not valid for signup.' });
    }

    if (err?.name === 'LimitExceededException' || err?.name === 'TooManyRequestsException') {
      return json(429, { error: 'too_many_attempts', message: 'Too many attempts. Try again later.' });
    }

    return json(500, { error: 'signup_failed', message: 'Worker signup failed.' });
  }
};

async function ensureWorkerGroup(userPoolId: string, username: string): Promise<void> {
  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: userPoolId,
    Username: username,
    GroupName: 'Workers',
  }));
}

async function seedWorkerUser(cognitoSub: string, phone: string, fullName: string): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT reconcile_worker_signup($1, $2, $3)',
      [cognitoSub, phone, fullName],
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// Stages the caller-supplied name for promote_worker_pending_name to adopt
// on the first correct OTP (verify-auth-challenge.ts) -- never displayed and
// never trusted as identity until that promotion happens. A later signup
// submission for the same worker intentionally overwrites an earlier
// pending value (stage_worker_pending_name's UPDATE, migration 052), so a
// squatter who pre-creates an account cannot hold a name against the real
// owner by staging first. Nothing is promoted without a correct OTP, and
// staging is best-effort: it must never fail the signup response.
async function stageWorkerPendingName(cognitoSub: string, fullName: string): Promise<void> {
  try {
    const pool = await getDbPool();
    const client = await pool.connect();
    try {
      await client.query('SELECT stage_worker_pending_name($1, $2)', [cognitoSub, fullName]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('worker-web-signup: failed to stage pending name (signup unaffected)', {
      err: errorMessage(err),
    });
  }
}

function randomPassword(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 24; i += 1) {
    token += alphabet[randomInt(0, alphabet.length)];
  }
  return `Jale!${token}9aA`;
}

function json(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
