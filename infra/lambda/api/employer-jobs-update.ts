import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { resolveEntitlements } from '../lib/entitlements';
import { corsHeaders, errorMessage } from '../lib/http';
import { formatPayRange, JOB_TYPES, parseJobFields, parseOptionalCoordinates, parseRequiredDocs, WRITABLE_JOB_STATUSES } from '../lib/job-fields';
import { setJobCoordinates } from '../lib/location';
import { parseCityFields, parseCityFromLocation } from '../lib/city-fields';
import { resolveJobLocationFields } from '../lib/job-location-parse';
import { enqueueVisibilityTransition, isEffectivelyVisible } from '../lib/job-visibility';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;

    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_job_id' }) };
    }
    if (!UUID_REGEX.test(jobId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_id' }) };
    }

    let body: Record<string, any>;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    // Two operations share this endpoint: a status change ({ status }) and a
    // descriptive-field edit (no status). Route to the field-edit path when the
    // body carries no status.
    if (body.status === undefined) {
      return await handleFieldEdit(event, jobId, cognitoSub, body);
    }

    const { status } = body as { status?: string };
    if (!status || !WRITABLE_JOB_STATUSES.includes(status as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_status', valid: WRITABLE_JOB_STATUSES }) };
    }

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

    // Fetch the current status + public listing state once, up front. This backs
    // two independent things: the A7 entitlement gate below (which only needs
    // currentStatus) and the visibility-event decision after the UPDATE (which
    // needs public_listing_enabled + public_code too, regardless of which way the
    // status is transitioning). FOR UPDATE OF jobs locks the row for the rest of
    // this transaction -- matching the field-edit path's idiom below -- so a
    // concurrent status change on the same job cannot read this same row between
    // this SELECT and the UPDATE, which would otherwise let two concurrent
    // requests both decide the visibility-event transition from the same
    // stale currentStatus/public_listing_enabled snapshot (TOCTOU).
    const currentResult = await client.query<{ status: string; public_listing_enabled: boolean; public_code: string }>(
      `SELECT jobs.status, jobs.public_listing_enabled, jobs.public_code
         FROM jobs JOIN users u ON u.id = jobs.employer_id WHERE jobs.id = $1 AND u.cognito_sub = $2
         FOR UPDATE OF jobs`,
      [jobId, cognitoSub],
    );
    const currentRow = currentResult.rows?.[0];
    const currentStatus = currentRow?.status;

    // A7: Gate non-active→active transitions against the plan's active job limit.
    // Transitions that do not activate a job (active→paused, active→closed, active→active,
    // paused→paused, paused→closed) consume no slot and bypass the gate entirely.
    if (status === 'active') {
      if (currentStatus !== 'active') {
        // Non-active→active: this consumes a slot. Enforce the entitlement gate.
        // Lock the employer's users row to serialize all concurrent slot consumers.
        const lockResult = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE cognito_sub = $1 FOR UPDATE`,
          [cognitoSub],
        );
        const userId = lockResult.rows[0]?.id;

        const entitlements = await resolveEntitlements(client, userId);

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
      }
    }

    const result = await client.query(
      `WITH employer_job AS (
         SELECT jobs.id
         FROM jobs
         JOIN users u ON u.id = jobs.employer_id
         WHERE jobs.id = $2 AND u.cognito_sub = $3
       )
       UPDATE jobs SET status = $1
       FROM employer_job
       WHERE jobs.id = employer_job.id
       RETURNING jobs.id, jobs.title, jobs.location, jobs.pay, jobs.job_type, jobs.status, jobs.created_at,
         jobs.pay_min, jobs.pay_max, jobs.pay_interval, jobs.start_date, jobs.expected_duration, jobs.shift_schedule,
         jobs.transportation_required, jobs.work_authorization_required, jobs.language_preference, jobs.number_of_workers_needed,
         jobs.workers_hired AS hired_count,
         GREATEST(jobs.number_of_workers_needed - jobs.workers_hired, 0) AS open_count,
         jobs.trade_category, jobs.required_experience_years, jobs.required_experience_months, jobs.certifications,
         jobs.public_code, jobs.public_listing_enabled,
         (SELECT COUNT(*)::int FROM job_applications WHERE job_id = $2) AS applicant_count`,
      [status, jobId, cognitoSub],
    );

    // Ownership is enforced by the users join above; rowCount === 0 means forbidden.
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    // Effective public visibility is status='active' AND public_listing_enabled.
    // public_listing_enabled is untouched by this status-only update, so
    // currentRow's value holds for both sides of the comparison.
    if (currentRow?.public_listing_enabled === true && currentRow.public_code) {
      const wasVisible = isEffectivelyVisible(currentStatus ?? '', currentRow.public_listing_enabled);
      const isVisible = isEffectivelyVisible(status, currentRow.public_listing_enabled);
      await enqueueVisibilityTransition(client, jobId, currentRow.public_code, wasVisible, isVisible);
    }

    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.rows[0]),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-jobs-update error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};

const EDITABLE_COLUMNS = [
  'title', 'location', 'pay', 'job_type', 'description', 'required_docs',
  'pay_min', 'pay_max', 'pay_interval', 'start_date', 'expected_duration',
  'shift_schedule', 'transportation_required', 'work_authorization_required',
  'language_preference', 'number_of_workers_needed', 'trade_category',
  'required_experience_years', 'required_experience_months', 'certifications',
  'city_key', 'city', 'state', 'state_region',
] as const;

async function handleFieldEdit(
  event: APIGatewayProxyEvent,
  jobId: string,
  cognitoSub: string,
  body: Record<string, any>,
): Promise<APIGatewayProxyResult> {
  const { title, location, job_type } = body;
  if (!title?.trim() || !location?.trim() || !job_type) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_fields', required: ['title', 'location', 'job_type'] }) };
  }
  if (!JOB_TYPES.includes(job_type as any)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_type', valid: JOB_TYPES }) };
  }

  const requiredDocsResult = parseRequiredDocs(body.required_docs);
  if (!requiredDocsResult.ok) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: requiredDocsResult.error, valid: requiredDocsResult.valid }) };
  }
  const required_docs = requiredDocsResult.value;

  // Recomputed on every edit (location is always present in this full-replacement
  // payload); explicit city/state_region body fields win over the parse -- an
  // employer must always be able to correct a location the parser can't handle.
  const locationFields = resolveJobLocationFields(location.trim(), body.city, body.state_region);
  if (!locationFields.ok) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: locationFields.error }) };
  }

  const jobFields = parseJobFields(body);
  if (!jobFields.ok) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: jobFields.error, ...(jobFields.valid ? { valid: jobFields.valid } : {}) }) };
  }
  const f = jobFields.value;

  const cityFields = parseCityFields(body);
  if (!cityFields.ok) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: cityFields.error }) };
  }

  // Runs conceptually AFTER the clear-on-omit below: when no triple is sent
  // the stored key is being replaced anyway, so a parseable location text
  // must re-key the job rather than leave it invisible to city filters.
  // An explicit `city: null` (SEO clear semantics) suppresses the derive too:
  // a deliberately cleared city must not resurrect as a matching city_key.
  const cityTriple = locationFields.cityCleared
    ? null
    : (cityFields.value ?? parseCityFromLocation(location));

  const coordinates = parseOptionalCoordinates(body);
  if (!coordinates.ok) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: coordinates.error }) };
  }

  let client;
  try {
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
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }) };
    }

    const current = await client.query<{
      job_type: string; required_docs: string[] | null; applicant_count: number; hired_count: number;
      city: string | null; state_region: string | null;
    }>(
      `SELECT jobs.job_type,
              jobs.required_docs,
              jobs.workers_hired AS hired_count,
              jobs.city,
              jobs.state_region,
              (SELECT COUNT(*)::int FROM job_applications WHERE job_id = jobs.id) AS applicant_count
         FROM jobs JOIN users u ON u.id = jobs.employer_id
        WHERE jobs.id = $1 AND u.cognito_sub = $2
        FOR UPDATE OF jobs`,
      [jobId, cognitoSub],
    );
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }
    const cur = current.rows[0];

    // Lock rules: required_docs and job_type freeze once the job has applicants.
    if (cur.applicant_count > 0) {
      const docsChanged = JSON.stringify([...required_docs].sort()) !== JSON.stringify([...(cur.required_docs ?? [])].sort());
      if (docsChanged || job_type !== cur.job_type) {
        await client.query('ROLLBACK');
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'field_locked', fields: ['required_docs', 'job_type'] }) };
      }
    }
    if (f.number_of_workers_needed < cur.hired_count) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'openings_below_hired', hired_count: cur.hired_count }) };
    }

    const values: Record<string, unknown> = {
      title: title.trim(),
      location: location.trim(),
      pay: formatPayRange(f.pay_min, f.pay_max),
      job_type,
      description: typeof body.description === 'string' ? (body.description.trim() || null) : null,
      required_docs,
      pay_min: f.pay_min,
      pay_max: f.pay_max,
      pay_interval: f.pay_interval,
      start_date: f.start_date,
      expected_duration: f.expected_duration,
      shift_schedule: f.shift_schedule,
      transportation_required: f.transportation_required,
      work_authorization_required: f.work_authorization_required,
      language_preference: f.language_preference,
      number_of_workers_needed: f.number_of_workers_needed,
      trade_category: f.trade_category,
      required_experience_years: f.required_experience_years,
      required_experience_months: f.required_experience_months,
      certifications: f.certifications,
      // Matching identity (city_key/state): an omitted triple replaces the
      // stored keys on purpose -- a fresh parse of the new location text, or
      // NULL when unparseable. A stale key must never keep matching the old
      // city's feed.
      city_key: cityTriple?.city_key ?? null,
      state: cityTriple?.state ?? null,
      // Shared display column: a validated triple wins; otherwise the SEO
      // resolver's rules apply -- explicit null clears, and an unparseable
      // location with NO explicit override preserves the stored value (a
      // text-only edit must not null a good SEO city; matching correctness
      // lives in city_key above, which DOES reset).
      city: cityTriple?.city ?? (locationFields.cityCleared ? null : (locationFields.value.city ?? cur.city)),
      state_region: locationFields.stateRegionCleared ? null : (locationFields.value.state_region ?? cur.state_region),
    };
    const setClauses = EDITABLE_COLUMNS.map((col, i) => `${col} = $${i + 1}`).join(', ');
    const params = EDITABLE_COLUMNS.map((col) => values[col]);
    const startDateIdx = EDITABLE_COLUMNS.indexOf('start_date') + 1;

    const result = await client.query(
      `UPDATE jobs SET ${setClauses.replace(`start_date = $${startDateIdx}`, `start_date = $${startDateIdx}::date`)}
         WHERE id = $${EDITABLE_COLUMNS.length + 1}
       RETURNING id, title, location, pay, job_type, status, required_docs, created_at,
         pay_min, pay_max, pay_interval, start_date, expected_duration, shift_schedule,
         transportation_required, work_authorization_required, language_preference, number_of_workers_needed,
         workers_hired AS hired_count,
         GREATEST(number_of_workers_needed - workers_hired, 0) AS open_count,
         trade_category, required_experience_years, required_experience_months, certifications,
         city_key, city, state, state_region,
         public_code, public_listing_enabled,
         (SELECT COUNT(*)::int FROM job_applications WHERE job_id = jobs.id) AS applicant_count`,
      [...params, jobId],
    );

    // Deliberate asymmetry with the city triple above: an omitted triple CLEARS the
    // stored city keys, but omitted coordinates PRESERVE the existing pin.
    if (coordinates.value) {
      await setJobCoordinates(client, jobId, coordinates.value.latitude, coordinates.value.longitude, 'manual');
    }

    await client.query('COMMIT');
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(result.rows[0]) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-jobs-update (edit) error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
}
