import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const VALID_TRADES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'] as const;
const VALID_JOB_TYPES = ['full-time', 'part-time', 'contract'] as const;
const VALID_COMPANY_SIZES = ['1-10', '11-50', '51-200', '200+'] as const;

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function validateStringArray(value: unknown, valid: readonly string[], error: string): string[] | APIGatewayProxyResult {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !valid.includes(item))) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error, valid }) };
  }
  return Array.from(new Set(value));
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;

    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
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

    let result;
    if (event.httpMethod === 'PATCH') {
      let body: any;
      try { body = JSON.parse(event.body ?? '{}'); }
      catch {
        await client.query('COMMIT');
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
      }

      const hiringTrades = validateStringArray(body.hiring_trades, VALID_TRADES, 'invalid_hiring_trades');
      if (!Array.isArray(hiringTrades)) {
        await client.query('COMMIT');
        return hiringTrades;
      }
      const typicalJobTypes = validateStringArray(body.typical_job_types, VALID_JOB_TYPES, 'invalid_typical_job_types');
      if (!Array.isArray(typicalJobTypes)) {
        await client.query('COMMIT');
        return typicalJobTypes;
      }
      if (body.company_size !== undefined && body.company_size !== null && !VALID_COMPANY_SIZES.includes(body.company_size)) {
        await client.query('COMMIT');
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_company_size', valid: VALID_COMPANY_SIZES }) };
      }

      const companyName = cleanText(body.company_name);
      const contactName = cleanText(body.contact_name);
      const phone = cleanText(body.phone);
      const city = cleanText(body.city);
      const serviceArea = cleanText(body.service_area);
      const companySize = cleanText(body.company_size);
      const companyDescription = cleanText(body.company_description);
      const hiringTradesProvided = Object.prototype.hasOwnProperty.call(body, 'hiring_trades');
      const jobTypesProvided = Object.prototype.hasOwnProperty.call(body, 'typical_job_types');

      if (companyName) {
        await client.query('UPDATE users SET full_name = $1, phone = COALESCE($2, phone) WHERE cognito_sub = $3', [companyName, phone, cognitoSub]);
      } else if (phone) {
        await client.query('UPDATE users SET phone = $1 WHERE cognito_sub = $2', [phone, cognitoSub]);
      }

      await client.query(
        `INSERT INTO employer_profiles (
           user_id, company_name, contact_name, phone, city, service_area,
           hiring_trades, typical_job_types, company_size, company_description
         )
         VALUES (
           (SELECT id FROM users WHERE cognito_sub = $1),
           $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10
         )
         ON CONFLICT (user_id) DO UPDATE SET
           company_name = COALESCE(EXCLUDED.company_name, employer_profiles.company_name),
           contact_name = COALESCE(EXCLUDED.contact_name, employer_profiles.contact_name),
           phone = COALESCE(EXCLUDED.phone, employer_profiles.phone),
           city = COALESCE(EXCLUDED.city, employer_profiles.city),
           service_area = COALESCE(EXCLUDED.service_area, employer_profiles.service_area),
           hiring_trades = CASE WHEN $11 THEN EXCLUDED.hiring_trades ELSE employer_profiles.hiring_trades END,
           typical_job_types = CASE WHEN $12 THEN EXCLUDED.typical_job_types ELSE employer_profiles.typical_job_types END,
           company_size = COALESCE(EXCLUDED.company_size, employer_profiles.company_size),
           company_description = COALESCE(EXCLUDED.company_description, employer_profiles.company_description),
           updated_at = NOW()
         RETURNING
           user_id,
           company_name,
           contact_name,
           phone,
           city,
           service_area,
           hiring_trades,
           typical_job_types,
           company_size,
           company_description`,
        [
          cognitoSub,
          companyName,
          contactName,
          phone,
          city,
          serviceArea,
          hiringTrades,
          typicalJobTypes,
          companySize,
          companyDescription,
          hiringTradesProvided,
          jobTypesProvided,
        ],
      );

      result = await client.query(
        `SELECT
           u.id,
           u.user_type,
           u.email,
           COALESCE(ep.phone, u.phone) AS phone,
           u.full_name,
           u.tenant_id,
           u.created_at,
           ep.company_name,
           ep.contact_name,
           ep.city,
           ep.service_area,
           COALESCE(ep.hiring_trades, '{}'::text[]) AS hiring_trades,
           COALESCE(ep.typical_job_types, '{}'::text[]) AS typical_job_types,
           ep.company_size,
           ep.company_description
         FROM users u
         LEFT JOIN employer_profiles ep ON ep.user_id = u.id
         WHERE u.cognito_sub = $1`,
        [cognitoSub],
      );
    } else {
      result = await client.query(
        `SELECT
           u.id,
           u.user_type,
           u.email,
           COALESCE(ep.phone, u.phone) AS phone,
           u.full_name,
           u.tenant_id,
           u.created_at,
           ep.company_name,
           ep.contact_name,
           ep.city,
           ep.service_area,
           COALESCE(ep.hiring_trades, '{}'::text[]) AS hiring_trades,
           COALESCE(ep.typical_job_types, '{}'::text[]) AS typical_job_types,
           ep.company_size,
           ep.company_description
         FROM users u
         LEFT JOIN employer_profiles ep ON ep.user_id = u.id
         WHERE u.cognito_sub = $1`,
        [cognitoSub],
      );
    }
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
      try { await client.query('ROLLBACK'); } catch (_) { }
    }
    console.error('Employer profile handler error:', errorMessage(err));
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
