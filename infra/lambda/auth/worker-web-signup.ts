import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomInt } from 'node:crypto';
import { recordSignupSource } from '../lib/analytics-capture';
import { auditCaller, type AuditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { parseSignupSource, type SignupSource } from '../lib/signup-source';
import { reconcileWorkerCognitoAccount } from './lib/worker-cognito-reconciliation';

const cognito = new CognitoIdentityProviderClient({});
const CORS_HEADERS = corsHeaders();

interface SignupBody {
  phone?: string;
  /**
   * R2 web signup is PHONE ONLY — the worker's name is collected inside the
   * onboarding flow itself (`profile.name`), not on the signup form. The
   * field is kept on the type, accepted and IGNORED, so a stale client that
   * still posts it gets a 200 instead of a 400 during the rollout window.
   * Nothing is staged: `stage_worker_pending_name` /
   * `promote_worker_pending_name` (migration 052) have no caller left.
   */
  fullName?: string;
  /**
   * Where the signup started (contract K3.6): `{ src, entry }`, stashed by
   * the frontend on the first auth-page load. Validated against the
   * first-party allow-list; an invalid one is dropped (or stored with no
   * code) and never fails the signup.
   */
  signup_source?: unknown;
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
  const signupSource = parseSignupSource(body.signup_source);

  if (!/^\+\d{8,15}$/.test(phone)) {
    return json(400, { error: 'invalid_phone', message: 'Phone must be in E.164 format.' });
  }

  // Observability only, never a rejection: tells us when the last stale
  // client stops sending a name so the field can be dropped from the type.
  // The value itself is never logged.
  if (body.fullName !== undefined) {
    console.warn('worker-web-signup: ignoring deprecated fullName field (phone-only signup)');
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
    // verify-auth-challenge.ts on the first correct OTP) — pre-marking a
    // stranger's number "verified" was a pre-registration poisoning vector.
    // R2 removed the name from this endpoint entirely: the worker types it
    // at `profile.name`, inside the authenticated onboarding flow.
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
      // name NULL for `profile.name` to fill.
      await seedWorkerUser(repaired.cognitoSub, phone, '', auditCaller(event, { kind: 'anonymous' }, 'web'), signupSource);
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

    // Same rationale as the reconcile branch: the users row is seeded with
    // `cognito_sub` + `phone` and no name. `resolve_worker_internal_id`
    // (086) resolves that row for the onboarding engine on the very next
    // request.
    await seedWorkerUser(cognitoSub, phone, '', auditCaller(event, { kind: 'anonymous' }, 'web'), signupSource);
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

/**
 * Seeds the worker's users row. The person signing up is not verified yet,
 * so the change records name an anonymous actor, never the phone.
 *
 * The signup source, when there is one, is recorded in the same transaction
 * once the row exists, best-effort: jale_cap.record_signup_source keeps the
 * first write and only for an account created in the last 24 hours, and a
 * failure there rolls back to its own savepoint without touching the row.
 */
async function seedWorkerUser(
  cognitoSub: string,
  phone: string,
  fullName: string,
  caller: AuditCaller,
  signupSource: SignupSource | null,
): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await setAuditContext(client, caller, 'auth.worker_web_signup');
    const seeded = await client.query<{ reconcile_worker_signup: string | null }>(
      'SELECT reconcile_worker_signup($1, $2, $3)',
      [cognitoSub, phone, fullName],
    );
    const userId = seeded?.rows?.[0]?.reconcile_worker_signup;
    if (signupSource && typeof userId === 'string') {
      await recordSignupSource(client, userId, signupSource);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
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
