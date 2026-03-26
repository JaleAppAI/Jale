import { getDbPool } from '../lib/db';
import { corsHeaders } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: any): Promise<any> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer.claims.sub;

    const pool = await getDbPool();
    client = await pool.connect();

    // RLS requires an explicit transaction so SET LOCAL survives until the SELECT
    await client.query('BEGIN');
    await client.query('SET LOCAL app.current_user_id = $1', [cognitoSub]);

    // Legal wall: block access if ToS not accepted
    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'legal_required',
          requiredVersion: process.env.REQUIRED_TOS_VERSION,
          currentVersion: compliance.currentVersion,
        }),
      };
    }

    const result = await client.query(
      'SELECT id, user_type, email, phone, full_name, tenant_id, created_at FROM users WHERE cognito_sub = $1',
      [cognitoSub],
    );
    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'profile_not_found',
          message: 'Please complete profile setup',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.rows[0]),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Worker profile handler error:', err);
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
