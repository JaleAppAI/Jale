/**
 * `PUT /employer/jobs/{jobId}/applicants/{workerId}/hire-details` -- F19
 * (sprint 28, contract K4.2): the employer records where and when a hired
 * worker starts.
 *
 * Reached through `employer-applicant-dispatch.ts`, on the Lambda that
 * already serves the applicant's status change (same login, same env).
 *
 * ── THE WRITE IS A DEFINER ─────────────────────────────────────────
 * The request login holds no column rights on the 125 hire columns.
 * `jale_cap.employer_save_hire_details` writes them as its own owner and
 * checks in SQL that the application is on one of the caller's jobs
 * (`app.current_internal_user_id`) and is hired. It reports `changed`, so a
 * save that changes nothing is not news to the worker.
 *
 * ── THE DETAILS-ADDED LINE ─────────────────────────────────────────
 * A changed, non-empty save sends the worker one free-text WhatsApp line,
 * through `jale_cap.employer_hire_details_notice`, which writes nothing
 * unless the worker is ready, delivery is on and their own last message
 * keeps the 24-hour window open (the web hire card shows the details either
 * way). It runs in its own savepoint: a refusal or an error there is logged
 * and rolled back to the savepoint, and the save still commits. It never
 * re-sends the hire celebration, which stays keyed on the status change.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { loadStageRecipient } from '../lib/employer-worker-lane';
import { buildApplicationStageUrl } from '../lib/application-stage-notify';
import { buildHireDetails } from '../lib/application-hire-view';

const CORS_HEADERS = corsHeaders();
const DEFAULT_FRONTEND_BASE_URL = 'https://jaleapp.ai';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTICE_SAVEPOINT = 'hire_details_notice';

/** The body is five short fields; anything larger is not a hire-details save. */
const MAX_BODY_BYTES = 8 * 1024;

export type HireDetailsLanguage = 'en' | 'es';

/** The five fields, in contract order. Also the order `fields` lists errors in. */
const FIELDS = ['start_date', 'report_location', 'contact_name', 'contact_phone', 'notes'] as const;
type HireField = typeof FIELDS[number];
export type HireDetailsValue = Record<HireField, string | null>;

/** Character limits, matching 125's CHECKs (which count characters, not UTF-16 units). */
const MAX_CHARS: Readonly<Record<Exclude<HireField, 'start_date'>, number>> = {
  report_location: 200,
  contact_name: 80,
  contact_phone: 32,
  notes: 1000,
};
const PHONE_REGEX = /^[0-9 +()-]+$/;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

/** A real calendar day in YYYY-MM-DD; 2026-02-30 is not one. */
function isCalendarDay(value: string): boolean {
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Validates the body. Every field is optional and nullable: a missing key, a
 * null and a blank string all mean "not given". Strings are trimmed. Every
 * invalid field is named, in contract order, so the form can mark them all
 * at once. Unknown keys are ignored.
 */
export function parseHireDetailsInput(body: unknown):
  | { ok: true; value: HireDetailsValue }
  | { ok: false; fields: string[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: [] };
  const input = body as Record<string, unknown>;
  const value = {} as HireDetailsValue;
  const invalid: string[] = [];

  for (const field of FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      value[field] = null;
      continue;
    }
    if (typeof raw !== 'string' || raw.includes('\u0000')) {
      invalid.push(field);
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      value[field] = null;
      continue;
    }
    const ok = field === 'start_date'
      ? isCalendarDay(trimmed)
      : Array.from(trimmed).length <= MAX_CHARS[field] && (field !== 'contact_phone' || PHONE_REGEX.test(trimmed));
    if (ok) value[field] = trimmed;
    else invalid.push(field);
  }

  return invalid.length > 0 ? { ok: false, fields: invalid } : { ok: true, value };
}

/**
 * The worker's details-added line. ASCII-only, unaccented, informal "tu"
 * Spanish, like every worker-facing WhatsApp line. Free text, sent only
 * inside the worker's own 24-hour window, so it has no template twin.
 */
export function buildHireDetailsNotice(lang: HireDetailsLanguage, input: { jobTitle: string; url: string }): string {
  return lang === 'es'
    ? `Tu empleador agrego los detalles de inicio para ${input.jobTitle}. Velos aqui: ${input.url}`
    : `Your employer added your start details for ${input.jobTitle}. See them here: ${input.url}`;
}

/**
 * The details-added line, inside its own savepoint. Returns the outcome for
 * the log; never throws.
 */
async function sendDetailsNotice(client: PoolClient, applicationId: string, jobId: string): Promise<string> {
  await client.query(`SAVEPOINT ${NOTICE_SAVEPOINT}`);
  try {
    const recipient = await loadStageRecipient(client, applicationId);
    let outcome = 'no_number';
    if (recipient.hasWhatsappNumber) {
      const titleRes = await client.query<{ title: string }>(`SELECT title FROM jobs WHERE id = $1`, [jobId]);
      const jobTitle = titleRes.rows[0]?.title;
      if (!jobTitle) {
        outcome = 'no_job';
      } else {
        const lang: HireDetailsLanguage = recipient.language === 'en' ? 'en' : 'es';
        const url = buildApplicationStageUrl(
          process.env.FRONTEND_BASE_URL ?? DEFAULT_FRONTEND_BASE_URL, lang, applicationId,
        );
        const res = await client.query<{ outcome: string }>(
          `SELECT outcome FROM jale_cap.employer_hire_details_notice($1, $2)`,
          [applicationId, buildHireDetailsNotice(lang, { jobTitle, url })],
        );
        outcome = res.rows[0]?.outcome ?? 'no_outcome';
      }
    }
    await client.query(`RELEASE SAVEPOINT ${NOTICE_SAVEPOINT}`);
    return outcome;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${NOTICE_SAVEPOINT}`);
    console.error(JSON.stringify({ metric: 'HireDetailsNoticeFailed', applicationId, error: errorMessage(err) }));
    return 'failed';
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (typeof cognitoSub !== 'string' || cognitoSub.trim() === '') return json(401, { error: 'unauthorized' });

  // A malformed id cannot name an application the caller owns.
  const jobId = event.pathParameters?.jobId;
  const workerId = event.pathParameters?.workerId;
  if (typeof jobId !== 'string' || !UUID_REGEX.test(jobId) || typeof workerId !== 'string' || !UUID_REGEX.test(workerId)) {
    return json(404, { error: 'not_found' });
  }
  if ((event.httpMethod ?? '').toUpperCase() !== 'PUT') return json(405, { error: 'method_not_allowed' });

  if (event.body && Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) {
    return json(400, { error: 'invalid_hire_details', fields: [] });
  }
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_hire_details', fields: [] });
  }
  const parsed = parseHireDetailsInput(body);
  if (!parsed.ok) return json(400, { error: 'invalid_hire_details', fields: parsed.fields });
  const details = parsed.value;

  let client: PoolClient | undefined;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('ROLLBACK');
      return json(409, { error: 'user_not_provisioned' });
    }
    if (!compliance.compliant) {
      await client.query('ROLLBACK');
      return json(403, { error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION });
    }

    const employerRes = await client.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    const employerId = employerRes.rows[0]?.id;
    if (!employerId) {
      await client.query('ROLLBACK');
      return json(409, { error: 'user_not_provisioned' });
    }
    // The definers read the caller from this setting.
    await setInternalUserRlsContext(client, employerId);

    const saveRes = await client.query(
      `SELECT outcome, application_id, changed, start_date, report_location, contact_name, contact_phone, notes, updated_at
         FROM jale_cap.employer_save_hire_details($1, $2, $3::date, $4, $5, $6, $7)`,
      [jobId, workerId, details.start_date, details.report_location, details.contact_name, details.contact_phone,
        details.notes],
    );
    const saved = saveRes.rows[0];
    if (!saved || saved.outcome === 'not_found') {
      await client.query('ROLLBACK');
      return json(404, { error: 'not_found' });
    }
    if (saved.outcome === 'not_hired') {
      await client.query('ROLLBACK');
      return json(409, { error: 'not_hired' });
    }

    // The same builder every read uses, so the PUT answer is the same
    // function of the row: null when the save left all five fields empty.
    const hireDetails = buildHireDetails({
      hire_start_date: saved.start_date,
      hire_report_location: saved.report_location,
      hire_contact_name: saved.contact_name,
      hire_contact_phone: saved.contact_phone,
      hire_notes: saved.notes,
      hire_details_updated_at: saved.updated_at,
    });

    if (saved.changed === true && hireDetails !== null) {
      const outcome = await sendDetailsNotice(client, saved.application_id, jobId);
      console.log(JSON.stringify({ metric: 'HireDetailsNotice', outcome, applicationId: saved.application_id }));
    }

    await client.query('COMMIT');
    return json(200, { hire_details: hireDetails });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ } }
    // A CHECK the validation above should have caught first.
    if ((err as { code?: unknown })?.code === '23514') return json(400, { error: 'invalid_hire_details', fields: [] });
    console.error('employer-application-hire-details error:', errorMessage(err));
    return json(500, { error: 'internal_error' });
  } finally {
    client?.release();
  }
};
