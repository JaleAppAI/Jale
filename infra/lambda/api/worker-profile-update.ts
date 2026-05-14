import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { setWorkerCoordinates } from '../lib/location';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const VALID_TRADES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'] as const;
const VALID_EXPERIENCE = ['0-1', '2-4', '5-9', '10+'] as const;
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

function experienceSlugToYears(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return value;
  if (value === '0-1') return 1;
  if (value === '2-4') return 3;
  if (value === '5-9') return 7;
  if (value === '10+') return 10;
  return null;
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

    const {
      full_name,
      skills,
      availability,
      years_experience,
      location,
      bio,
      city,
      main_trade,
      main_trade_other,
      has_transportation,
    } = body;
    const skillsProvided = Object.prototype.hasOwnProperty.call(body, 'skills');
    if (availability !== undefined && availability !== null && !VALID_AVAIL.includes(availability)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_availability', valid: VALID_AVAIL }) };
    }
    if (main_trade !== undefined && main_trade !== null && !VALID_TRADES.includes(main_trade)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_main_trade', valid: VALID_TRADES }) };
    }
    if (main_trade === 'other' && (typeof main_trade_other !== 'string' || main_trade_other.trim().length === 0)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'main_trade_other_required' }) };
    }
    if (years_experience !== undefined && years_experience !== null) {
      const validNumericExperience = typeof years_experience === 'number' && years_experience >= 0;
      const validSlugExperience = typeof years_experience === 'string' && VALID_EXPERIENCE.includes(years_experience as any);
      if (!validNumericExperience && !validSlugExperience) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_years_experience', valid: VALID_EXPERIENCE }) };
      }
    }
    if (has_transportation !== undefined && has_transportation !== null && typeof has_transportation !== 'boolean') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_has_transportation' }) };
    }
    if (skillsProvided && (!Array.isArray(skills) || skills.some((s: any) => typeof s !== 'string'))) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_skills' }) };
    }
    const normalizedSkills = skillsProvided ? normalizeSkills(skills) : undefined;
    if (normalizedSkills === null) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_skills' }) };
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

    const normalizedFullName = typeof full_name === 'string' && full_name.trim().length > 0 ? full_name.trim() : null;
    const normalizedCity = typeof city === 'string' && city.trim().length > 0 ? city.trim() : null;
    const normalizedLocation = typeof location === 'string' && location.trim().length > 0 ? location.trim() : normalizedCity;
    const normalizedTradeOther = typeof main_trade_other === 'string' && main_trade_other.trim().length > 0
      ? main_trade_other.trim()
      : null;
    const userExperience = typeof years_experience === 'string' ? years_experience : null;
    const profileExperience = experienceSlugToYears(years_experience);
    const normalizedBio = typeof bio === 'string' && bio.trim().length > 0 ? bio.trim() : null;

    await client.query(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         city = COALESCE($2, city),
         main_trade = COALESCE($3, main_trade),
         main_trade_other = CASE
           WHEN $3 = 'other' THEN COALESCE($4, main_trade_other)
           WHEN $3 IS NOT NULL THEN NULL
           ELSE COALESCE($4, main_trade_other)
         END,
         years_experience = COALESCE($5, years_experience),
         has_transportation = COALESCE($6, has_transportation),
         availability = COALESCE($7, availability)
       WHERE cognito_sub = $8`,
      [
        normalizedFullName,
        normalizedCity,
        main_trade ?? null,
        normalizedTradeOther,
        userExperience,
        has_transportation ?? null,
        availability ?? null,
        cognitoSub,
      ],
    );

    const upsertRes = await client.query(
      `INSERT INTO worker_profiles (user_id, full_name, phone, availability, years_experience, location, bio)
       SELECT id, full_name, COALESCE(phone, whatsapp_number), $2, $3, $4, $5
       FROM users
       WHERE cognito_sub = $1
       ON CONFLICT (user_id) DO UPDATE SET
         full_name        = COALESCE(EXCLUDED.full_name, worker_profiles.full_name),
         phone            = COALESCE(EXCLUDED.phone, worker_profiles.phone),
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
      [cognitoSub, availability ?? null, profileExperience, normalizedLocation, normalizedBio],
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
