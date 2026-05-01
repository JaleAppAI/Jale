import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const VALID_AVAIL = ['immediate', '2-weeks', '1-month'] as const;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: any;
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) }; }

    const { full_name, skills, availability, years_experience, location, bio } = body;
    if (availability !== undefined && availability !== null && !VALID_AVAIL.includes(availability)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_availability', valid: VALID_AVAIL }) };
    }
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s: any) => typeof s !== 'string'))) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_skills' }) };
    }
    if (years_experience !== undefined && years_experience !== null && (typeof years_experience !== 'number' || years_experience < 0)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_years_experience' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

    if (typeof full_name === 'string' && full_name.trim().length > 0) {
      await client.query(`UPDATE users SET full_name = $1 WHERE cognito_sub = $2`, [full_name.trim(), cognitoSub]);
    }

    const upsertRes = await client.query(
      `INSERT INTO worker_profiles (user_id, skills, availability, years_experience, location, bio)
       VALUES (
         (SELECT id FROM users WHERE cognito_sub = $1),
         COALESCE($2::text[], '{}'), $3, $4, $5, $6
       )
       ON CONFLICT (user_id) DO UPDATE SET
         skills           = COALESCE(EXCLUDED.skills, worker_profiles.skills),
         availability     = COALESCE(EXCLUDED.availability, worker_profiles.availability),
         years_experience = COALESCE(EXCLUDED.years_experience, worker_profiles.years_experience),
         location         = COALESCE(EXCLUDED.location, worker_profiles.location),
         bio              = COALESCE(EXCLUDED.bio, worker_profiles.bio),
         updated_at       = NOW()
       RETURNING user_id, skills, availability, years_experience, location, bio`,
      [cognitoSub, skills ?? null, availability ?? null, years_experience ?? null, location ?? null, bio ?? null],
    );
    await client.query('COMMIT');

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(upsertRes.rows[0]) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-profile-update error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
