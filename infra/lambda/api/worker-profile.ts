import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'unauthorized' }),
      };
    }

    const pool = await getDbPool();
    client = await pool.connect();

    // RLS requires an explicit transaction so SET LOCAL survives until the SELECT
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    // Legal wall: block access if user missing or ToS not accepted
    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
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
      `SELECT u.id, u.user_type, u.email, u.phone, u.full_name, u.tenant_id, u.created_at,
          u.main_trade, u.main_trade_other,
          ARRAY(
            SELECT ws.skill
            FROM worker_skills ws
            WHERE ws.worker_id = wp.user_id
            ORDER BY ws.skill
          ) AS skills,
          wp.availability, wp.years_experience, wp.experience_months, wp.location, wp.bio,
          COALESCE(wp.certifications, '{}'::text[]) AS certifications,
          COALESCE((
            SELECT json_agg(json_build_object('city_key', wpc.city_key, 'city', wpc.city, 'state', wpc.state,
                   'latitude', wpc.latitude, 'longitude', wpc.longitude) ORDER BY wpc.created_at, wpc.city_key)
            FROM worker_preferred_cities wpc
            WHERE wpc.user_id = u.id
          ), '[]'::json) AS preferred_cities
   FROM users u
   LEFT JOIN worker_profiles wp ON wp.user_id = u.id
   WHERE u.cognito_sub = $1`,
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
    console.error('Worker profile handler error:', errorMessage(err));
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
