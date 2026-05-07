import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { setWorkerCoordinates } from '../lib/location';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const VALID_AVAIL = ['full_time', 'part_time', 'weekends', 'flexible'] as const;

function normalizeSkills(skills: string[]): string[] | null {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawSkill of skills) {
    const skill = rawSkill.trim().toLowerCase();
    if (skill.length < 1 || skill.length > 100) {
      return null;
    }
    if (!seen.has(skill)) {
      seen.add(skill);
      normalized.push(skill);
    }
  }

  return normalized;
}

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
    const skillsProvided = Object.prototype.hasOwnProperty.call(body, 'skills');
    if (availability !== undefined && availability !== null && !VALID_AVAIL.includes(availability)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_availability', valid: VALID_AVAIL }) };
    }
    if (skillsProvided && (!Array.isArray(skills) || skills.some((s: any) => typeof s !== 'string'))) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_skills' }) };
    }
    const normalizedSkills = skillsProvided ? normalizeSkills(skills) : undefined;
    if (normalizedSkills === null) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_skills' }) };
    }
    if (years_experience !== undefined && years_experience !== null && (typeof years_experience !== 'number' || years_experience < 0)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_years_experience' }) };
    }
    const hasLatitude = Object.prototype.hasOwnProperty.call(body, 'latitude');
    const hasLongitude = Object.prototype.hasOwnProperty.call(body, 'longitude');
    if (hasLatitude !== hasLongitude) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_coordinates' }) };
    }
    if (hasLatitude) {
      if (typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_latitude' }) };
      }
      if (typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_longitude' }) };
      }
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
      `INSERT INTO worker_profiles (user_id, availability, years_experience, location, bio)
       VALUES (
         (SELECT id FROM users WHERE cognito_sub = $1),
         $2, $3, $4, $5
       )
       ON CONFLICT (user_id) DO UPDATE SET
         availability     = COALESCE(EXCLUDED.availability, worker_profiles.availability),
         years_experience = COALESCE(EXCLUDED.years_experience, worker_profiles.years_experience),
         location         = COALESCE(EXCLUDED.location, worker_profiles.location),
         bio              = COALESCE(EXCLUDED.bio, worker_profiles.bio),
         updated_at       = NOW()
       RETURNING
         user_id,
         ARRAY(
           SELECT ws.skill
           FROM worker_skills ws
           WHERE ws.worker_id = worker_profiles.user_id
           ORDER BY ws.skill
         ) AS skills,
         availability,
         years_experience,
         location,
         bio`,
      [cognitoSub, availability ?? null, years_experience ?? null, location ?? null, bio ?? null],
    );
    const profile = upsertRes.rows[0];

    if (skillsProvided) {
      const skillsToWrite = normalizedSkills ?? [];
      await client.query('DELETE FROM worker_skills WHERE worker_id = $1', [profile.user_id]);
      if (skillsToWrite.length > 0) {
        await client.query(
          `INSERT INTO worker_skills (worker_id, skill)
           SELECT $1, normalized.skill
           FROM unnest($2::text[]) AS normalized(skill)
           ON CONFLICT DO NOTHING`,
          [profile.user_id, skillsToWrite],
        );
      }
      profile.skills = skillsToWrite;
    }
    if (hasLatitude) {
      await setWorkerCoordinates(client, profile.user_id, body.latitude, body.longitude, 'map_pin');
    }

    await client.query('COMMIT');

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(profile) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-profile-update error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
