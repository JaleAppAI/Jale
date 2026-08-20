import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { resolveEntitlements } from '../lib/entitlements';
import { corsHeaders, errorMessage } from '../lib/http';
import { formatPayRange, JOB_TYPES, parseJobFields, parseOptionalCoordinates, parseRequiredDocs, parseRequiredFields } from '../lib/job-fields';
import { resolveJobLocationFields } from '../lib/job-location-parse';
import { setJobCoordinates } from '../lib/location';
import { parseCityFields, parseCityFromLocation } from '../lib/city-fields';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;

    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: {
      title?: string;
      location?: string;
      job_type?: string;
      description?: string;
      required_docs?: string[];
      optional_docs?: string[];
      required_fields?: string[];
      optional_fields?: string[];
      latitude?: number;
      longitude?: number;
      pay_min?: number | null;
      pay_max?: number | null;
      pay_interval?: string | null;
      start_date?: string | null;
      expected_duration?: string | null;
      shift_schedule?: string | null;
      transportation_required?: boolean;
      work_authorization_required?: boolean;
      language_preference?: string[];
      number_of_workers_needed?: number;
      trade_category?: string;
      required_experience_years?: number | null;
      required_experience_months?: number | null;
      certifications?: string[];
      trade_category_other?: string | null;
      expected_duration_bucket?: string | null;
      work_days?: string[] | null;
      shift_start?: string | null;
      shift_end?: string | null;
      certification_requirements?: { name: string; tier: 'required' | 'optional'; proof_required: boolean }[] | null;
      city_key?: string;
      city?: string | null;
      state?: string;
      state_region?: string | null;
    };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { title, location, job_type, description } = body;
    if (!title?.trim() || !location?.trim() || !job_type) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_fields', required: ['title', 'location', 'job_type'] }) };
    }

    // parseJobFields (below) caps the TRIMMED length at 4000 chars, but this
    // insert previously stored the RAW value -- a whitespace-padded string
    // that trims to exactly 4000 chars could carry an unbounded amount of
    // padding into the DB (e.g. ' '.repeat(1_000_000) + 'A'.repeat(4000)
    // passes validation and previously persisted ~1MB). Normalize the same
    // way employer-jobs-update.ts and employer-templates-save.ts already do:
    // trimmed-or-null, computed once here so every use below agrees.
    const normalizedDescription = typeof description === 'string' ? (description.trim() || null) : null;

    if (!JOB_TYPES.includes(job_type as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_type', valid: JOB_TYPES }) };
    }

    const requiredDocsResult = parseRequiredDocs(body.required_docs);
    if (!requiredDocsResult.ok) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: requiredDocsResult.error, valid: requiredDocsResult.valid }),
      };
    }
    const required_docs = requiredDocsResult.value;

    // optional_docs/required_fields/optional_fields reuse the same shared
    // parsers as required_docs (parseRequiredDocs enforces the DOC_TYPES
    // vocabulary regardless of which tier it's parsing; parseRequiredFields
    // is REQUIRED_FIELD_TYPES-scoped for both tiers too), wrapped here so
    // each tier gets its own distinct error code instead of colliding on
    // parseRequiredFields' baked-in 'invalid_required_fields'.
    const optionalDocsResult = parseRequiredDocs(body.optional_docs);
    if (!optionalDocsResult.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_optional_docs', valid: optionalDocsResult.valid }) };
    }
    const optional_docs = optionalDocsResult.value;

    const requiredFieldsResult = parseRequiredFields(body.required_fields);
    if (!requiredFieldsResult.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_required_fields', valid: requiredFieldsResult.valid }) };
    }
    const required_fields = requiredFieldsResult.value;

    const optionalFieldsResult = parseRequiredFields(body.optional_fields);
    if (!optionalFieldsResult.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_optional_fields', valid: optionalFieldsResult.valid }) };
    }
    const optional_fields = optionalFieldsResult.value;

    // Tier-overlap rejection BEFORE hitting the DB CHECK (jobs_fields_tiers_disjoint /
    // jobs_docs_tiers_disjoint in 074_job_optional_requirements.sql enforce
    // NOT (required && optional) at the DB layer) -- catching it here gives a
    // single combined, named error instead of a raw constraint-violation 500.
    const requirementsOverlapKeys = [
      ...required_fields.filter((key) => optional_fields.includes(key)),
      ...required_docs.filter((key) => optional_docs.includes(key)),
    ];
    if (requirementsOverlapKeys.length > 0) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'requirements_tier_overlap', keys: requirementsOverlapKeys }) };
    }

    // Explicit city/state_region body fields win over the parse -- an employer
    // must always be able to correct a location the parser can't handle.
    const locationFields = resolveJobLocationFields(location.trim(), body.city, body.state_region);
    if (!locationFields.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: locationFields.error }) };
    }

    const jobFields = parseJobFields(body as Record<string, unknown>);
    if (!jobFields.ok) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: jobFields.error, ...(jobFields.valid ? { valid: jobFields.valid } : {}) }),
      };
    }

    // Work-auth ownership: once the employer's picker sends required_fields
    // AT ALL (hasOwnProperty, not just a non-empty array), it owns
    // work_authorization_required going forward -- the legacy standalone
    // body.work_authorization_required flag is overridden so the two
    // controls can never silently disagree. Absent required_fields keeps the
    // legacy parseJobFields behavior exactly as-is.
    const hasRequiredFieldsKey = Object.prototype.hasOwnProperty.call(body, 'required_fields');
    const workAuthorizationRequired = hasRequiredFieldsKey
      ? required_fields.includes('work_authorization')
      : jobFields.value.work_authorization_required;

    const coordinates = parseOptionalCoordinates(body as Record<string, unknown>);
    if (!coordinates.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: coordinates.error }) };
    }

    const cityFields = parseCityFields(body as Record<string, unknown>);
    if (!cityFields.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: cityFields.error }) };
    }

    // Location precision (create only): every job must land in some
    // city-filtered feed. If neither the validated picker triple
    // (parseCityFields) nor the SEO parse of `location`
    // (resolveJobLocationFields) yields a city, reject rather than silently
    // persist an unfindable job. The update path deliberately keeps its
    // existing laxity here -- see employer-jobs-update.ts.
    if (cityFields.value === null && locationFields.value.city === null) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'city_required' }) };
    }

    // Degraded-picker fallback: no triple sent -> best-effort parse of the
    // free-text location, so the job still enters city-filtered feeds.
    // An explicit `city: null` (the SEO fields' deliberate-clear semantics)
    // suppresses the derive too -- a cleared city must not resurrect as a
    // city_key and keep the job matching the old city's feed.
    const cityTriple = locationFields.cityCleared
      ? null
      : (cityFields.value ?? parseCityFromLocation(location));

    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('ROLLBACK');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    // A7: Lock the employer's users row to serialize concurrent slot consumers.
    // SELECT … FOR UPDATE on users ensures two simultaneous creates for the same
    // employer cannot both read "0 active jobs" and both insert.
    const lockResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1 FOR UPDATE`,
      [cognitoSub],
    );
    const userId = lockResult.rows[0]?.id;

    // Resolve entitlements AFTER acquiring the lock so the limit is authoritative.
    const entitlements = await resolveEntitlements(client, userId);

    // Count the employer's current active jobs while holding the lock.
    const countResult = await client.query<{ active_jobs: number }>(
      `SELECT COUNT(*)::int AS active_jobs FROM jobs WHERE employer_id = $1 AND status = 'active'`,
      [userId],
    );
    const activeJobs = countResult.rows[0].active_jobs;

    if (activeJobs >= entitlements.activeJobLimit) {
      await client.query('ROLLBACK');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'job_limit_reached',
          plan_code: entitlements.planCode,
          active_job_limit: entitlements.activeJobLimit,
          active_jobs: activeJobs,
        }),
      };
    }

    // BE-T2 (077): the six new structured columns are appended at the END of
    // the column/VALUES/RETURNING lists (and of the params array below) so
    // every pre-existing positional index elsewhere in this codebase/tests
    // (description at params[5], work_authorization_required at params[17],
    // the city triple at params[24..27]) is undisturbed.
    const certificationRequirementsParam = jobFields.value.certification_requirements === null
      ? null
      : JSON.stringify(jobFields.value.certification_requirements);

    const result = await client.query(
      `INSERT INTO jobs (
         employer_id,
         title,
         location,
         pay,
         job_type,
         description,
         required_docs,
         optional_docs,
         required_fields,
         optional_fields,
         pay_min,
         pay_max,
         pay_interval,
         start_date,
         expected_duration,
         shift_schedule,
         transportation_required,
         work_authorization_required,
         language_preference,
         number_of_workers_needed,
         trade_category,
         required_experience_years,
         required_experience_months,
         certifications,
         city_key,
         city,
         state,
         state_region,
         trade_category_other,
         expected_duration_bucket,
         work_days,
         shift_start,
         shift_end,
         certification_requirements
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
         $29, $30, $31, $32::time, $33::time, $34::jsonb
       )
       RETURNING id, title, location, pay, job_type, status, required_docs, optional_docs, required_fields, optional_fields, created_at,
         pay_min, pay_max, pay_interval, start_date, expected_duration, shift_schedule,
         transportation_required, work_authorization_required, language_preference, number_of_workers_needed,
         workers_hired AS hired_count,
         GREATEST(number_of_workers_needed - workers_hired, 0) AS open_count,
         trade_category, required_experience_years, required_experience_months, certifications,
         city_key, city, state, state_region,
         trade_category_other, expected_duration_bucket, work_days, shift_start, shift_end, certification_requirements`,
      [
        userId,
        title.trim(),
        location.trim(),
        formatPayRange(jobFields.value.pay_min, jobFields.value.pay_max),
        job_type,
        normalizedDescription,
        required_docs,
        optional_docs,
        required_fields,
        optional_fields,
        jobFields.value.pay_min,
        jobFields.value.pay_max,
        jobFields.value.pay_interval,
        jobFields.value.start_date,
        jobFields.value.expected_duration,
        jobFields.value.shift_schedule,
        jobFields.value.transportation_required,
        workAuthorizationRequired,
        jobFields.value.language_preference,
        jobFields.value.number_of_workers_needed,
        jobFields.value.trade_category,
        jobFields.value.required_experience_years,
        jobFields.value.required_experience_months,
        jobFields.value.certifications,
        // The two location systems share the `city` column: the validated
        // picker triple wins, then the SEO resolver's (explicit-or-parsed)
        // city -- identical strings whenever both are present.
        cityTriple?.city_key ?? null,
        cityTriple?.city ?? locationFields.value.city,
        cityTriple?.state ?? null,
        locationFields.value.state_region,
        jobFields.value.trade_category_other,
        jobFields.value.expected_duration_bucket,
        jobFields.value.work_days,
        jobFields.value.shift_start,
        jobFields.value.shift_end,
        certificationRequirementsParam,
      ],
    );
    const job = result.rows[0];

    if (coordinates.value) {
      await setJobCoordinates(client, job.id, coordinates.value.latitude, coordinates.value.longitude, 'manual');
    }

    await client.query('COMMIT');

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...job, applicant_count: 0 }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-jobs-create error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
