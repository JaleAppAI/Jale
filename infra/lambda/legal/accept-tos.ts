import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    // Extract user sub from Cognito authorizer claims (set by API Gateway)
    const cognitoSub: string = event.requestContext?.authorizer?.claims?.sub;

    if (!cognitoSub) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'unauthorized', message: 'Missing user identity' }),
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

    // Server-side validation: reject requests with non-matching version
    if (tosVersion.trim() !== process.env.REQUIRED_TOS_VERSION!.trim()) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'invalid_tos_version',
          message: `Expected version ${process.env.REQUIRED_TOS_VERSION}`,
        }),
      };
    }

    // Extract request metadata for consent log
    // Pass null for missing IPs — column is INET, no need for ::inet cast
    const ipAddress: string | null =
      event.requestContext?.identity?.sourceIp || null;
    const userAgent: string =
      event.headers?.['User-Agent'] ?? event.headers?.['user-agent'] ?? 'unknown';

    // Connect to DB via shared pool
    const pool = await getDbPool();
    client = await pool.connect();

    // Transaction: update user + insert consent log entries (RLS-aware)
    // Idempotent: if the user already accepted this exact version, skip writes.
    try {
      await client.query('BEGIN');
      await setRlsContext(client, cognitoSub);

      // Conditional UPDATE — only writes when the version actually changes.
      // Uses IS DISTINCT FROM to handle NULL → value transitions correctly.
      const updateResult = await client.query(
        `UPDATE users
            SET tos_version = $1,
                tos_accepted_at = NOW(),
                privacy_version = $1,
                privacy_accepted_at = NOW()
          WHERE cognito_sub = $2
            AND tos_version IS DISTINCT FROM $1`,
        [tosVersion, cognitoSub],
      );

      // Only insert consent log rows if the UPDATE actually changed something
      if (updateResult.rowCount && updateResult.rowCount > 0) {
        await client.query(
          `INSERT INTO legal_consent_log
              (user_id, document_type, document_version, ip_address, user_agent)
           SELECT id, 'tos', $1, $2, $3
             FROM users
            WHERE cognito_sub = $4`,
          [tosVersion, ipAddress, userAgent, cognitoSub],
        );

        await client.query(
          `INSERT INTO legal_consent_log
              (user_id, document_type, document_version, ip_address, user_agent)
           SELECT id, 'privacy', $1, $2, $3
             FROM users
            WHERE cognito_sub = $4`,
          [tosVersion, ipAddress, userAgent, cognitoSub],
        );
      } else {
        // rowCount === 0: either user already accepted (idempotent) or user row
        // doesn't exist at all (post-confirmation DB sync failed).
        const existsResult = await client.query(
          'SELECT 1 FROM users WHERE cognito_sub = $1',
          [cognitoSub],
        );
        if (existsResult.rows.length === 0) {
          await client.query('COMMIT');
          return {
            statusCode: 409,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: 'user_not_provisioned',
              message: 'Account setup incomplete. Please try signing out and back in.',
            }),
          };
        }
        // else: idempotent accept — user already has this version, fall through to 200
      }

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
    console.error('accept-tos handler error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error', message: 'Internal server error' }),
    };
  } finally {
    if (client) {
      client.release();
    }
  }
};
