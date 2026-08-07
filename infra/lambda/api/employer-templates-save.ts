import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { resolveEntitlements } from '../lib/entitlements';
import { corsHeaders, errorMessage } from '../lib/http';
import { JOB_TYPES, parseJobFields, parseOptionalCoordinates, parseRequiredDocs } from '../lib/job-fields';
import { parseCityFields } from '../lib/city-fields';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const MAX_NAME_LENGTH = 80;

/** Validates a template payload with the SAME helpers employer-jobs-create
 * uses, so a template is always a storable create request. Returns the
 * normalized payload to persist (start_date stripped -- never templated). */
function validateTemplatePayload(raw: Record<string, unknown>):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> } {
  const { title, location, job_type } = raw as { title?: string; location?: string; job_type?: string };
  if (!title?.trim() || !location?.trim() || !job_type) {
    return { ok: false, status: 400, error: 'missing_fields', extra: { required: ['title', 'location', 'job_type'] } };
  }
  if (!JOB_TYPES.includes(job_type as never)) {
    return { ok: false, status: 400, error: 'invalid_job_type', extra: { valid: JOB_TYPES } };
  }
  const requiredDocs = parseRequiredDocs(raw.required_docs as string[] | undefined);
  if (!requiredDocs.ok) return { ok: false, status: 400, error: requiredDocs.error, extra: { valid: requiredDocs.valid } };
  const jobFields = parseJobFields(raw);
  if (!jobFields.ok) return { ok: false, status: 400, error: jobFields.error, extra: jobFields.valid ? { valid: jobFields.valid } : undefined };
  const coordinates = parseOptionalCoordinates(raw);
  if (!coordinates.ok) return { ok: false, status: 400, error: coordinates.error };
  const cityFields = parseCityFields(raw);
  if (!cityFields.ok) return { ok: false, status: 400, error: cityFields.error };

  const value: Record<string, unknown> = {
    title: title.trim(),
    location: location.trim(),
    job_type,
    description: typeof raw.description === 'string' ? raw.description.trim() || undefined : undefined,
    required_docs: requiredDocs.value,
    ...jobFields.value,
    ...(coordinates.value ?? {}),
    ...(cityFields.value ?? {}),
  };
  delete value.start_date; // templates never carry a date
  return { ok: true, value };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: { id?: string; name?: string; payload?: Record<string, unknown> };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_template_name' }) };
    }
    if (typeof body.payload !== 'object' || body.payload === null) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_template_payload' }) };
    }
    const payload = validateTemplatePayload(body.payload);
    if (!payload.ok) {
      return { statusCode: payload.status, headers: CORS_HEADERS, body: JSON.stringify({ error: payload.error, ...(payload.extra ?? {}) }) };
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
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }) };
    }

    // Same serialization pattern as the active-job limit: lock the employer
    // row so two concurrent saves cannot both pass the cap check.
    const lockResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1 FOR UPDATE`,
      [cognitoSub],
    );
    const employerId = lockResult.rows[0]?.id;
    if (!employerId) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }

    if (body.id) {
      // Update path: rename and/or overwrite an owned template. RLS scopes
      // the UPDATE; rowCount 0 means unknown or unowned -- indistinguishable
      // on purpose.
      const nameConflict = await client.query(
        `SELECT id FROM employer_job_templates WHERE employer_id = $1 AND name = $2 AND id <> $3`,
        [employerId, name, body.id],
      );
      if ((nameConflict.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'template_name_taken' }) };
      }
      const updated = await client.query(
        `UPDATE employer_job_templates
            SET name = $1, payload = $2::jsonb, updated_at = NOW()
          WHERE id = $3 AND employer_id = $4
        RETURNING id, name, payload, updated_at`,
        [name, JSON.stringify(payload.value), body.id, employerId],
      );
      if (updated.rowCount === 0) {
        await client.query('ROLLBACK');
        return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
      }
      await client.query('COMMIT');
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(updated.rows[0]) };
    }

    const entitlements = await resolveEntitlements(client, employerId);
    const countResult = await client.query<{ template_count: number }>(
      `SELECT COUNT(*)::int AS template_count FROM employer_job_templates WHERE employer_id = $1`,
      [employerId],
    );
    if (countResult.rows[0].template_count >= entitlements.templateLimit) {
      await client.query('ROLLBACK');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'template_limit_reached',
          plan_code: entitlements.planCode,
          template_limit: entitlements.templateLimit,
        }),
      };
    }

    const nameConflict = await client.query(
      `SELECT id FROM employer_job_templates WHERE employer_id = $1 AND name = $2`,
      [employerId, name],
    );
    if ((nameConflict.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'template_name_taken' }) };
    }

    const inserted = await client.query(
      `INSERT INTO employer_job_templates (employer_id, name, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, name, payload, updated_at`,
      [employerId, name, JSON.stringify(payload.value)],
    );
    await client.query('COMMIT');
    return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify(inserted.rows[0]) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('employer-templates-save error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
