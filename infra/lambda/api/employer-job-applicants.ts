import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { isPlainObject } from '../lib/application-answers';
import { promptAnswersView, stageView } from '../lib/application-stage-view';
import { parsePreApplicationPromptList } from '../lib/pre-application-prompts';
import { APPLICATION_STATUSES } from '../lib/job-fields';
import { checkCompliance } from '../legal/check-compliance';
import { buildHireDetails, hireDetailsNeeded } from '../lib/application-hire-view';
import { auditCaller, type AuditCaller } from '../lib/audit/caller';
import { recordAccess, recordAttempt, responseFieldNames, type AttemptEvent } from '../lib/audit/record';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE = 'employer.job_applicants';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  let caller: AuditCaller | undefined;
  let attempt: Omit<AttemptEvent, 'outcome'> | undefined;

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
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    const resolved = await resolveEmployerActor(client, cognitoSub);
    if (!resolved.ok) {
      await client.query('COMMIT');
      return employerActorFailureResponse(resolved, CORS_HEADERS);
    }
    const { actor } = resolved;
    caller = auditCaller(event, { kind: 'employer', id: actor.userId }, 'web');
    const purpose = { kind: 'job', id: jobId } as const;
    attempt = { surface: SURFACE, purpose };

    // Verify this job is in the caller's scope (the employer_id predicate
    // returns no row if not).
    // Also carries optional_fields/optional_docs so the applicant query
    // below can compute each applicant's not_provided list without a
    // second round trip -- and, since 091, the rest of the job's
    // requirement columns too. Those are job-level, identical for every
    // applicant, so they are fetched ONCE here and folded into each row's
    // snapshot below rather than re-joined per applicant.
    const jobCheck = await client.query(
      `SELECT id, optional_fields, optional_docs,
              required_fields, required_docs,
              certification_requirements, pre_application_prompts
         FROM jobs WHERE id = $1 AND employer_id = ANY($2::uuid[])`,
      [jobId, actor.scopeUserIds],
    );
    if (jobCheck.rowCount === 0) {
      await client.query('COMMIT');
      await recordAttempt(client, caller, { ...attempt, outcome: 'denied' });
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }
    const jobRow = (jobCheck.rows ?? [])[0] ?? {};
    const optionalFields: string[] = Array.isArray(jobRow.optional_fields) ? jobRow.optional_fields : [];
    const optionalDocs: string[] = Array.isArray(jobRow.optional_docs) ? jobRow.optional_docs : [];
    const preApplicationPrompts = parsePreApplicationPromptList(jobRow.pre_application_prompts);

    // Build applicant query with optional filters
    const qs = event.queryStringParameters ?? {};
    const conditions: string[] = ['ja.job_id = $1', 'j.employer_id = ANY($2::uuid[])'];
    const params: (string | number | string[])[] = [jobId, actor.scopeUserIds, optionalDocs];
    let idx = 4;

    if (qs.status) {
      if (!APPLICATION_STATUSES.includes(qs.status as any)) {
        await client.query('COMMIT');
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_status', valid: APPLICATION_STATUSES }) };
      }
      if (qs.status === 'contacted') {
        conditions.push(`ja.status = ANY($${idx++}::text[])`);
        params.push(['contacted', 'reviewed']);
      } else if (qs.status === 'not_interested') {
        conditions.push(`ja.status = ANY($${idx++}::text[])`);
        params.push(['not_interested', 'rejected']);
      } else {
        conditions.push(`ja.status = $${idx++}`);
        params.push(qs.status);
      }
    }
    if (qs.availability) {
      conditions.push(`wp.availability = $${idx++}`);
      params.push(qs.availability);
    }
    if (qs.min_experience) {
      conditions.push(`wp.years_experience >= $${idx++}`);
      params.push(parseInt(qs.min_experience, 10));
    }
    if (qs.skills) {
      // skills is a comma-separated list — match any skill using the && (overlap) operator
      const skillList = qs.skills
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (skillList.length > 0) {
        conditions.push(`EXISTS (
          SELECT 1
          FROM worker_skills ws
          WHERE ws.worker_id = ja.worker_id
            AND ws.skill = ANY($${idx++}::text[])
        )`);
        params.push(skillList);
      }
    }

    const result = await client.query(
      `SELECT
         ja.id            AS application_id,
         ja.worker_id,
         COALESCE(wp.full_name, u.full_name) AS full_name,
         COALESCE(wp.phone, u.phone)         AS phone,
         CASE ja.status
           WHEN 'reviewed' THEN 'contacted'
           WHEN 'rejected' THEN 'not_interested'
           ELSE ja.status
         END AS status,
         ja.applied_at,
         ja.application_answers,
         -- 091 stage columns. stage/details_status are derived from these
         -- TIMESTAMPS, never from the literal status, so moving a
         -- details_requested applicant on to contacted/talking does not
         -- silently reset the stage.
         ja.prompt_answers,
         ja.details_requested_at,
         ja.details_completed_at,
         -- F19 (125): the start details the employer saved for a hire.
         -- Published only as hire_details (stripped below); to_char keeps
         -- the DATE the calendar day the employer picked.
         to_char(ja.hire_start_date, 'YYYY-MM-DD') AS hire_start_date,
         ja.hire_report_location,
         ja.hire_contact_name,
         ja.hire_contact_phone,
         ja.hire_notes,
         ja.hire_details_updated_at,
         ARRAY(
           SELECT ws.skill
           FROM worker_skills ws
           WHERE ws.worker_id = ja.worker_id
           ORDER BY ws.skill
         ) AS skills,
         wp.availability,
         wp.years_experience,
         wp.location,
         -- Optional docs (job's optional_docs, param $3) this applicant has
         -- NOT attached to THIS job -- folded into not_provided below
         -- alongside skipped optional_fields answers. A document counts as
         -- provided only when it is attached to this application's job: a
         -- vault-only copy (job_id NULL), or one attached to another job,
         -- does not, so the employer is never told a document was provided
         -- that this job cannot show.
         ARRAY(
           SELECT dt FROM unnest($3::text[]) AS dt
           WHERE NOT EXISTS (
             SELECT 1 FROM worker_documents wd
              WHERE wd.worker_id = ja.worker_id
                AND wd.doc_type = dt
                AND wd.job_id = ja.job_id
           )
         ) AS missing_optional_docs,
         -- JOB-SCOPED doc types, the input computeRemaining expects and
         -- exactly what 091's hire gate measures. Same scope as
         -- missing_optional_docs above (attached to this job only): that one
         -- answers "did the worker skip an optional item", this one answers
         -- "can this application be hired".
         --
         -- No syncDocumentSnapshots here: this is an employer session, and
         -- the sync sets a WORKER caller context and writes worker_documents
         -- (FORCE RLS). Only worker sessions may do that.
         ARRAY(
           SELECT DISTINCT wd.doc_type
             FROM worker_documents wd
            WHERE wd.worker_id = ja.worker_id
              AND wd.job_id = ja.job_id
         ) AS have_docs
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
       JOIN users u ON u.id = ja.worker_id
       LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ja.applied_at DESC`,
      params,
    );

    // The employer must see exactly which optional items were skipped:
    // not_provided = optional_fields absent from this applicant's answers,
    // plus the optional_docs not attached to this job (missing_optional_docs,
    // computed in SQL above).
    // missing_optional_docs is an internal helper column, dropped from the
    // response -- only its contribution to not_provided is exposed.
    const applicants = result.rows.map((row: any) => {
      const {
        missing_optional_docs, have_docs,
        hire_start_date: _hireStartDate, hire_report_location: _hireReportLocation, hire_contact_name: _hireContactName,
        hire_contact_phone: _hireContactPhone, hire_notes: _hireNotes, hire_details_updated_at: _hireDetailsUpdatedAt,
        ...applicant
      } = row;
      const hireDetails = row.status === 'hired' ? buildHireDetails(row) : null;
      // Guard + normalize, not just guard: application_answers is JSONB NOT
      // NULL DEFAULT '{}' and node-pg returns it pre-parsed in production,
      // but if it ever arrived as something else, ship the normalized {}
      // rather than passing a non-object value through to the employer.
      const answers = isPlainObject(applicant.application_answers) ? applicant.application_answers : {};
      const notProvided = [
        ...optionalFields.filter((field) => !Object.prototype.hasOwnProperty.call(answers, field)),
        ...(Array.isArray(missing_optional_docs) ? missing_optional_docs : []),
      ];
      // The shared stage vocabulary, computed by the SAME pure functions the
      // worker's own door runs -- fed a snapshot assembled from the columns
      // already selected, so no per-row engine round trip.
      const stage = stageView({
        ...row,
        // The selected `status` is the CASE-remapped one; the snapshot wants
        // the application status only for exits it never evaluates here, so
        // either is safe -- passed explicitly for clarity.
        application_status: row.status,
        required_fields: jobRow.required_fields,
        optional_fields: jobRow.optional_fields,
        required_docs: jobRow.required_docs,
        optional_docs: jobRow.optional_docs,
        certification_requirements: jobRow.certification_requirements,
        pre_application_prompts: jobRow.pre_application_prompts,
        have_docs,
      });
      return {
        ...applicant,
        application_answers: answers,
        not_provided: notProvided,
        ...stage,
        // Overwrites the RAW jsonb column with the joined view: the employer
        // must never have to correlate answer ids against the job's prompts
        // themselves, and an answer to a since-deleted prompt still shows.
        prompt_answers: promptAnswersView(jobRow.pre_application_prompts, row.prompt_answers),
        // F19 (K4.2): the saved start details, and whether a hire still needs them.
        hire_details: hireDetails,
        hire_details_needed: hireDetailsNeeded(row.status, hireDetails),
      };
    });

    // Every listed applicant is recorded before COMMIT; the helper splits a
    // list longer than 500 into parts that share the request id.
    await recordAccess(client, caller, {
      surface: SURFACE,
      subjectUserIds: result.rows.map((row: { worker_id: string }) => row.worker_id),
      recordIds: result.rows.map((row: { application_id: string }) => row.application_id),
      resultCount: result.rows.length,
      fieldNames: responseFieldNames(applicants),
      purpose,
    });
    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        applicants,
        total: result.rowCount,
        pre_application_prompts: preApplicationPrompts,
      }),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (caller && attempt) await recordAttempt(client, caller, { ...attempt, outcome: 'failed' });
    }
    console.error('employer-job-applicants error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
