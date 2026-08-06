import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { setWorkerCoordinates, type WorkerLocationSource } from '../lib/location';
import { parsePreferredCities, type CityFields } from '../lib/city-fields';
import { checkCompliance } from '../legal/check-compliance';
import { requestTradeAliasGeneration } from '../lib/trade-alias-request';

const CORS_HEADERS = corsHeaders();
const VALID_TRADES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'] as const;
const VALID_EXPERIENCE = ['0-1', '2-4', '5-9', '10+'] as const;
const VALID_AVAIL = ['full_time', 'part_time', 'weekends', 'flexible'] as const;
// 'map_pin' is deliberately absent: no client can drop a pin yet, and its
// confidence (100) would outrank every later correction. See migration 061 §4.
const VALID_LOCATION_SOURCES = ['geocoded_zip', 'geocoded_address'] as const satisfies readonly WorkerLocationSource[];
const MAX_CERTIFICATIONS = 20;
const MAX_CERTIFICATION_LENGTH = 200;
const MAX_EXPERIENCE_YEARS = 80;
const MAX_EXPERIENCE_MONTHS = MAX_EXPERIENCE_YEARS * 12; // 960; mirrors the worker_profiles CHECK

function normalizeStringList(values: string[], maxItems: number, maxLength: number, transform: (value: string) => string): string[] | null {
  const normalized: string[] = [];
  const seen = new Set<string>();

  if (values.length > maxItems) return null;

  for (const raw of values) {
    const value = transform(raw.trim());
    if (value.length < 1 || value.length > maxLength) {
      return null;
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }

  return normalized;
}

function normalizeSkills(skills: string[]): string[] | null {
  return normalizeStringList(skills, 100, 100, (value) => value.toLowerCase());
}

function normalizeCertifications(certifications: string[]): string[] | null {
  return normalizeStringList(certifications, MAX_CERTIFICATIONS, MAX_CERTIFICATION_LENGTH, (value) => value);
}

function experienceSlugToYears(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return value;
  if (value === '0-1') return 1;
  if (value === '2-4') return 3;
  if (value === '5-9') return 7;
  if (value === '10+') return 10;
  return null;
}

function experienceToMonths(value: string | number | null | undefined): number | null {
  const years = experienceSlugToYears(value);
  return years === null ? null : years * 12;
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
      experience_months,
      location,
      bio,
      city,
      main_trade,
      main_trade_other,
      has_transportation,
      certifications,
    } = body;
    const skillsProvided = Object.prototype.hasOwnProperty.call(body, 'skills');
    const certificationsProvided = Object.prototype.hasOwnProperty.call(body, 'certifications');
    if (availability !== undefined && availability !== null && !VALID_AVAIL.includes(availability)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_availability', valid: VALID_AVAIL }) };
    }
    if (main_trade !== undefined && main_trade !== null && !VALID_TRADES.includes(main_trade)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_main_trade', valid: VALID_TRADES }) };
    }
    if (main_trade === 'other' && (typeof main_trade_other !== 'string' || main_trade_other.trim().length === 0)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'main_trade_other_required' }) };
    }
    if (experience_months !== undefined && experience_months !== null) {
      if (typeof experience_months !== 'number' || !Number.isInteger(experience_months) || experience_months < 0 || experience_months > MAX_EXPERIENCE_MONTHS) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_experience_months' }) };
      }
    }
    if (years_experience !== undefined && years_experience !== null) {
      const validNumericExperience = typeof years_experience === 'number' && years_experience >= 0 && years_experience <= MAX_EXPERIENCE_YEARS && Number.isInteger(years_experience);
      const validSlugExperience = typeof years_experience === 'string' && VALID_EXPERIENCE.includes(years_experience as any);
      if (!validNumericExperience && !validSlugExperience) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_years_experience', valid: VALID_EXPERIENCE, max: MAX_EXPERIENCE_YEARS }) };
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
    if (certificationsProvided && (!Array.isArray(certifications) || certifications.some((s: any) => typeof s !== 'string'))) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_certifications' }) };
    }
    const normalizedCertifications = certificationsProvided ? normalizeCertifications(certifications) : undefined;
    if (normalizedCertifications === null) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_certifications' }) };
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

    const hasLocationSource = Object.prototype.hasOwnProperty.call(body, 'location_source');
    if (hasLocationSource && !VALID_LOCATION_SOURCES.includes(body.location_source)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_location_source', valid: VALID_LOCATION_SOURCES }) };
    }

    const preferredProvided = Object.prototype.hasOwnProperty.call(body, 'preferred_cities');
    let preferredCities: CityFields[] = [];
    if (preferredProvided) {
      const parsed = parsePreferredCities(body.preferred_cities);
      if (!parsed.ok) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: parsed.error }) };
      }
      preferredCities = parsed.value;
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
    const profileExperienceMonths = typeof experience_months === 'number' ? experience_months : experienceToMonths(years_experience);
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
      `INSERT INTO worker_profiles (user_id, full_name, phone, availability, years_experience, experience_months, location, bio, certifications)
       SELECT id, full_name, COALESCE(phone, whatsapp_number), $2, $3, $4, $5, $6, COALESCE($7::text[], '{}'::text[])
       FROM users
       WHERE cognito_sub = $1
       ON CONFLICT (user_id) DO UPDATE SET
         full_name        = COALESCE(EXCLUDED.full_name, worker_profiles.full_name),
         phone            = COALESCE(EXCLUDED.phone, worker_profiles.phone),
         availability     = COALESCE(EXCLUDED.availability, worker_profiles.availability),
         years_experience = COALESCE(EXCLUDED.years_experience, worker_profiles.years_experience),
         experience_months = COALESCE(EXCLUDED.experience_months, worker_profiles.experience_months),
         location         = COALESCE(EXCLUDED.location, worker_profiles.location),
         bio              = COALESCE(EXCLUDED.bio, worker_profiles.bio),
         certifications   = CASE WHEN $8::boolean THEN EXCLUDED.certifications ELSE worker_profiles.certifications END,
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
         experience_months,
         location,
         bio,
         certifications,
         COALESCE((
           SELECT json_agg(json_build_object('city_key', wpc.city_key, 'city', wpc.city, 'state', wpc.state,
                  'latitude', wpc.latitude, 'longitude', wpc.longitude) ORDER BY wpc.created_at, wpc.city_key)
           FROM worker_preferred_cities wpc
           WHERE wpc.user_id = worker_profiles.user_id
         ), '[]'::json) AS preferred_cities`,
      [
        cognitoSub,
        availability ?? null,
        profileExperience,
        profileExperienceMonths,
        normalizedLocation,
        normalizedBio,
        normalizedCertifications ?? null,
        certificationsProvided,
      ],
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
    // Full replacement, so it only runs when the client actually sent the field
    // -- an ordinary profile save that omits it must not wipe the worker's
    // cities. The RETURNING above already carried the stored list; this
    // overwrites it with the new one because those rows post-date that read.
    //
    // The 061 RLS policy resolves the row owner through user_type = 'worker',
    // so a non-worker account reaching this endpoint with preferred_cities
    // writes zero rows and trips the transaction, surfacing as a 500 rather
    // than a 403. Known and accepted: the security outcome is correct and no
    // client can legitimately produce that call.
    if (preferredProvided) {
      await client.query('DELETE FROM worker_preferred_cities WHERE user_id = $1', [profile.user_id]);
      if (preferredCities.length > 0) {
        await client.query(
          `INSERT INTO worker_preferred_cities (user_id, city_key, city, state, latitude, longitude)
           SELECT $1, x.city_key, x.city, x.state, x.latitude, x.longitude
           FROM jsonb_to_recordset($2::jsonb) AS x(city_key text, city text, state text, latitude numeric, longitude numeric)`,
          [profile.user_id, JSON.stringify(preferredCities)],
        );
      }
      profile.preferred_cities = preferredCities;
    }
    if (hasLatitude) {
      // Precedence is by confidence: geocoded_zip (30) < geocoded_address (70),
      // and within 7 days a stored higher-confidence fix wins by design -- a ZIP
      // centroid must not overwrite a full-address geocode.
      const source = hasLocationSource ? body.location_source : 'geocoded_address';
      await setWorkerCoordinates(client, profile.user_id, body.latitude, body.longitude, source);
    }

    await client.query('COMMIT');

    // Fire-and-forget: grows the bilingual trade-alias cache for the matcher.
    // requestTradeAliasGeneration never throws by contract; the try/catch here
    // is defense in depth so this can never affect the response either way.
    if (main_trade === 'other' && normalizedTradeOther) {
      try {
        await requestTradeAliasGeneration(normalizedTradeOther);
      } catch {
        // Swallowed intentionally -- see comment above.
      }
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(profile) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-profile-update error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
