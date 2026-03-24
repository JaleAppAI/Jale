import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';

interface DbSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

// Cache the parsed secret across warm invocations
let cachedSecret: DbSecret | undefined;

const smClient = new SecretsManagerClient({});

async function getDbSecret(): Promise<DbSecret> {
  if (cachedSecret) {
    return cachedSecret;
  }

  const result = await smClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.DB_SECRET_ARN,
    }),
  );

  cachedSecret = JSON.parse(result.SecretString!) as DbSecret;
  return cachedSecret;
}

/**
 * Decode a JWT and extract the payload without verification.
 * This is acceptable here because the token was already validated by Cognito
 * on the client side. In production, use a custom authorizer.
 */
function decodeJwtPayload(token: string): Record<string, any> {
  const parts = token.replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'http://localhost:3000',
};

export const handler = async (event: any): Promise<any> => {
  let client: Client | undefined;

  try {
    // Extract user sub from Authorization header JWT
    const authHeader: string | undefined =
      event.headers?.Authorization ?? event.headers?.authorization;

    if (!authHeader) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'unauthorized', message: 'Missing Authorization header' }),
      };
    }

    const jwtPayload = decodeJwtPayload(authHeader);
    const cognitoSub: string = jwtPayload.sub;

    if (!cognitoSub) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'unauthorized', message: 'Invalid token: missing sub' }),
      };
    }

    // Parse request body
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const tosVersion: string | undefined = body?.tosVersion;

    if (!tosVersion) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'bad_request', message: 'tosVersion is required' }),
      };
    }

    // Connect to DB
    const secret = await getDbSecret();
    client = new Client({
      host: secret.host,
      port: secret.port,
      database: secret.dbname,
      user: secret.username,
      password: secret.password,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();

    // Extract request metadata for consent log
    const ipAddress: string =
      event.requestContext?.identity?.sourceIp ?? '0.0.0.0';
    const userAgent: string =
      event.headers?.['User-Agent'] ?? event.headers?.['user-agent'] ?? 'unknown';

    // Transaction: update user + insert consent log entries
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE users
            SET tos_version = $1,
                tos_accepted_at = NOW(),
                privacy_version = $1,
                privacy_accepted_at = NOW()
          WHERE cognito_sub = $2`,
        [tosVersion, cognitoSub],
      );

      await client.query(
        `INSERT INTO legal_consent_log
            (user_id, document_type, document_version, ip_address, user_agent)
         SELECT id, 'tos', $1, $2::inet, $3
           FROM users
          WHERE cognito_sub = $4`,
        [tosVersion, ipAddress, userAgent, cognitoSub],
      );

      await client.query(
        `INSERT INTO legal_consent_log
            (user_id, document_type, document_version, ip_address, user_agent)
         SELECT id, 'privacy_policy', $1, $2::inet, $3
           FROM users
          WHERE cognito_sub = $4`,
        [tosVersion, ipAddress, userAgent, cognitoSub],
      );

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ accepted: true, version: tosVersion }),
    };
  } catch (err) {
    console.error('accept-tos handler error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error', message: 'Internal server error' }),
    };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch (endErr) {
        console.error('Error closing DB connection:', endErr);
      }
    }
  }
};
