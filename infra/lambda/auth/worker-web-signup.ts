import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomInt } from 'node:crypto';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

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
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: phone,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: randomPassword(),
        UserAttributes: [
          { Name: 'phone_number', Value: phone },
          { Name: 'phone_number_verified', Value: 'true' },
          { Name: 'name', Value: fullName },
          { Name: 'custom:user_type', Value: 'worker' },
        ],
      }));
    } catch (err: any) {
      if (err?.name !== 'UsernameExistsException') throw err;
      // This endpoint is unauthenticated. Never change Cognito or profile data
      // for an existing phone number until the caller proves ownership by OTP.
      return json(200, { ok: true });
    }

    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: phone,
      Password: randomPassword(),
      Permanent: true,
    }));

    const confirmed = await cognito.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: phone,
    }));
    const cognitoSub = confirmed.UserAttributes?.find((attr) => attr.Name === 'sub')?.Value;

    if (!cognitoSub) {
      throw new Error('Unable to resolve Cognito sub for worker signup.');
    }

    await ensureWorkerGroup(userPoolId, phone);
    await seedWorkerUser(cognitoSub, phone, fullName);

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
    await setRlsContext(client, cognitoSub);
    await client.query(
      `INSERT INTO users (cognito_sub, user_type, phone, full_name)
       VALUES ($1, 'worker', $2, $3)
       ON CONFLICT (cognito_sub) DO UPDATE
       SET phone = EXCLUDED.phone,
           full_name = EXCLUDED.full_name`,
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
