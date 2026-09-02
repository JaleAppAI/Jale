/**
 * `/worker/applications/{applicationId}*` — the WEB "stage 2" door
 * (Sprint 23 L2.4).
 *
 *   GET  /worker/applications/{applicationId}                   -> state doc
 *   POST /worker/applications/{applicationId}/answers           -> field answers
 *   POST /worker/applications/{applicationId}/certifications    -> cert claims
 *   POST /worker/applications/{applicationId}/prompt-answers    -> prompt answers
 *
 * ONE Lambda, four routes, the `whatsapp/web/worker-onboarding.ts` shape:
 * they share a connection, a transaction, an entry sequence and an error
 * vocabulary, and four functions would have been four copies of the same
 * forty lines.
 *
 * ── WHY IT RUNS AS jale_whatsapp (binding) ────────────────────────────
 * `job_applications` is FORCE RLS and the only worker-scoped UPDATE policy
 * is `jobapp_whatsapp_update` (migration 028), for role `jale_whatsapp`,
 * keyed on the GUC `app.current_internal_user_id` (= `users.id`). There is
 * no worker UPDATE policy for `jale_admin`, so this door cannot be an
 * ApiStack Lambda; it is declared in `whatsapp-stack.ts` next to the web
 * onboarding door with `DB_SECRET_ARN = jale/whatsapp/db`, and it resolves
 * the caller through 086's `resolve_worker_internal_id` SECURITY DEFINER
 * exactly as that door does.
 *
 * `jobapp_whatsapp_select` is `USING (true)` (028), so RLS proves NOTHING
 * about ownership on a read: every application query here carries an
 * explicit `AND worker_id = $2`. The shared engine's own snapshot SELECT is
 * keyed on the application id alone by design — this handler is the caller
 * that must have proven ownership first, and the `worker_id = $2` SELECT in
 * the entry sequence below is that proof.
 *
 * ── ALL LOGIC LIVES IN THE ENGINE ─────────────────────────────────────
 * Every requirement decision — what is still missing, what to ask next,
 * whether the details stage is complete, and every write — comes from
 * `lib/application-requirements.ts`. This file is transport: auth, the
 * transaction, the HTTP status mapping and the JSON shape. Do not grow a
 * second what's-missing engine here (the module header names two that
 * already had to be collapsed into one).
 *
 * ── THE 031 TRANSACTION TRAP ──────────────────────────────────────────
 * `employer_display_name()` flips a transaction-local GUC that widens
 * `employer_profiles` reads until COMMIT (migration 031, and the same
 * comment in `worker-jobs-detail.ts:44-46`). It is therefore the LAST query
 * of every request, issued from `buildState` — which is why `buildState` is
 * called exactly ONCE per request, immediately before the COMMIT or
 * ROLLBACK, on all three paths that need a state document (the GET, a
 * successful POST, and the two 409 bodies that carry `state`).
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';

import { getDbPool, setInternalUserRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { normalizeApplicationStatus } from '../lib/job-fields';
import { CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS } from '../lib/applications';
import {
  computeRemaining,
  detailsStatusFor,
  loadRequirementSnapshot,
  markDetailsCompleteIfDone,
  mergeCertificationClaims,
  mergeFieldAnswers,
  mergePromptAnswers,
  nextStep,
  type MergeCertificationClaimsResult,
  type MergeFieldAnswersResult,
  type MergePromptAnswersResult,
  type RequirementSnapshot,
} from '../lib/application-requirements';

const CORS_HEADERS = corsHeaders();

/**
 * 16 KB, taken as a BYTE length on the raw body BEFORE `JSON.parse` and
 * before `getDbPool()` — same reasoning as the web onboarding door: parsing
 * a multi-megabyte body is pure attacker-controlled CPU and heap on a VPC
 * Lambda, and such a request must never reach the connection pool at all.
 * The largest legitimate batch is 20 short field answers; nothing a worker
 * can type comes close. API Gateway's own 10 MB cap is three orders of
 * magnitude too high to serve as this guard.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * The batch cap for `POST answers`. The ENGINE does not count keys —
 * `mergeFieldAnswers` validates each one and bounds the serialized batch in
 * bytes — so the door enforces the count, and REJECTS rather than truncates:
 * silently dropping the 21st answer would lose a worker's typing with a 200.
 */
const MAX_ANSWER_KEYS = 20;

/** The three `{action}` write doors. Anything else is a 404. */
const WRITE_ACTIONS = new Set(['answers', 'certifications', 'prompt-answers']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function fail(statusCode: number, error: string, extra: Record<string, unknown> = {}): APIGatewayProxyResult {
  return json(statusCode, { error, ...extra });
}

function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `event.pathParameters.action` ONLY — no `event.path` regex fallback.
 * `{applicationId}` is a UUID segment, so a path regex would have to
 * distinguish an action from an id by shape, which is a bug waiting to be
 * written. An absent/empty action is the bare `GET {applicationId}`.
 */
function routeAction(event: APIGatewayProxyEvent): string {
  const raw = event.pathParameters?.action;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** 078's two trigger caps, raised through a doc-snapshot copy. */
function isCertificationDocumentLimit(err: unknown): boolean {
  const candidate = err as { code?: unknown; constraint?: unknown } | undefined;
  return candidate?.code === '23514'
    && typeof candidate.constraint === 'string'
    && CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS.has(candidate.constraint);
}

// ── The state document ────────────────────────────────────────────────

interface StateDoc {
  application: Record<string, unknown>;
  job: Record<string, unknown>;
  answers: Record<string, unknown>;
  certifications: unknown[];
  prompt_answers: Record<string, string>;
  documents: { doc_type: string; present: boolean }[];
  remaining: ReturnType<typeof computeRemaining>;
  next_step: ReturnType<typeof nextStep>;
}

/**
 * The one and only place a state document is built, and the LAST thing any
 * request does before it commits or rolls back. Its final two queries are
 * the job's `employer_id` (the snapshot deliberately does not carry it, and
 * the engine is not this lane's to extend) and `employer_display_name` — see
 * the 031 note in the file header for why nothing may follow them.
 */
async function buildState(client: PoolClient, snapshot: RequirementSnapshot): Promise<StateDoc> {
  const remaining = computeRemaining(snapshot);

  // `answers` is the worker's field answers ONLY. 'certifications' is a
  // RESERVED key inside the same column (the job CHECKs never list it) and
  // is surfaced as its own top-level array instead. Read with the same
  // fail-open `Array.isArray` guard the engine's private `storedClaims`
  // uses: a corrupt value reads as "nothing claimed" rather than throwing.
  const { certifications: rawClaims, ...fieldAnswers } = snapshot.answers;
  const certifications = Array.isArray(rawClaims) ? rawClaims : [];

  // Presence over required ∪ optional docs, from the JOB-SCOPED `haveDocs`
  // the snapshot already synced — NOT from `remaining.docs`, which is
  // required-and-collectable only and would drop every optional doc.
  const docTypes = Array.from(new Set([...snapshot.requiredDocs, ...snapshot.optionalDocs]));
  const haveDocs = new Set(snapshot.haveDocs);

  const employerRes = await client.query<{ employer_id: string | null }>(
    `SELECT employer_id FROM jobs WHERE id = $1`,
    [snapshot.jobId],
  );
  const employerId = employerRes.rows[0]?.employer_id ?? null;

  // LAST QUERY OF THE TRANSACTION. See the file header.
  let companyName: string | null = null;
  if (employerId) {
    const nameRes = await client.query<{ company_name: string | null }>(
      `SELECT employer_display_name($1) AS company_name`,
      [employerId],
    );
    companyName = nameRes.rows[0]?.company_name ?? null;
  }

  return {
    application: {
      id: snapshot.applicationId,
      job_id: snapshot.jobId,
      // Same legacy remap as `worker-applications-list.ts`
      // (reviewed -> contacted, rejected -> not_interested). An unknown
      // status falls back to the raw value: `normalizeApplicationStatus`
      // returns null for one, and a null status in the doc is worse than an
      // unrecognized string.
      status: normalizeApplicationStatus(snapshot.applicationStatus) ?? snapshot.applicationStatus,
      details_status: detailsStatusFor(
        {
          details_requested_at: snapshot.detailsRequestedAt,
          details_completed_at: snapshot.detailsCompletedAt,
        },
        remaining,
      ),
      stage: snapshot.stage,
      details_requested_at: snapshot.detailsRequestedAt,
      details_completed_at: snapshot.detailsCompletedAt,
      applied_at: snapshot.appliedAt,
      updated_at: snapshot.updatedAt,
    },
    job: {
      id: snapshot.jobId,
      title: snapshot.jobTitle,
      company_name: companyName,
      status: snapshot.jobStatus,
      required_fields: snapshot.requiredFields,
      optional_fields: snapshot.optionalFields,
      required_docs: snapshot.requiredDocs,
      optional_docs: snapshot.optionalDocs,
      certification_requirements: snapshot.certificationRequirements,
      pre_application_prompts: snapshot.prompts,
    },
    answers: fieldAnswers,
    certifications,
    prompt_answers: snapshot.promptAnswers,
    documents: docTypes.map((docType) => ({ doc_type: docType, present: haveDocs.has(docType) })),
    remaining,
    next_step: nextStep(snapshot),
  };
}

// ── Entry sequence ────────────────────────────────────────────────────

async function resolveWorker(client: PoolClient, cognitoSub: string): Promise<string | null> {
  const res = await client.query<{ id: string | null }>(
    `SELECT public.resolve_worker_internal_id($1) AS id`,
    [cognitoSub],
  );
  return res.rows[0]?.id ?? null;
}

// ── The merge result mapper ───────────────────────────────────────────

type MergeResult = MergeFieldAnswersResult | MergeCertificationClaimsResult | MergePromptAnswersResult;
type MergeFailure = Extract<MergeResult, { ok: false }>;

/**
 * ONE mapper for all three doors. It covers the union of every failure
 * reason even though no single door can produce all of them:
 * `mergePromptAnswers` can never return `stage_locked` or
 * `certification_document_limit` (prompts belong to the apply stage and are
 * deliberately not stage-gated), and only `mergeFieldAnswers`' invalid
 * variant carries a per-key `errors` map — hence the `'errors' in` probe
 * rather than three near-identical mappers.
 *
 * `too_large` is 400, NOT the 413 the pre-DB body cap returns: the same word
 * describes two different things here — a request that was too big to read,
 * and an accumulated column that would overflow after a merge that was
 * itself perfectly reasonable. Deliberately not harmonized.
 */
function mapFailure(result: MergeFailure): { status: number; error: string; withState: boolean; extra?: Record<string, unknown> } {
  switch (result.reason) {
    case 'invalid':
      return {
        status: 400,
        error: 'invalid_answers',
        withState: false,
        extra: { errors: 'errors' in result ? result.errors : {} },
      };
    case 'too_large':
      return { status: 400, error: 'payload_too_large', withState: false };
    case 'stage_locked':
      return { status: 409, error: 'stage_locked', withState: true };
    case 'closed':
      return { status: 409, error: 'application_closed', withState: true };
    case 'certification_document_limit':
      return { status: 409, error: 'certification_document_limit', withState: false };
    case 'not_found':
    default:
      return { status: 404, error: 'not_found', withState: false };
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (typeof cognitoSub !== 'string' || cognitoSub.trim() === '') return fail(401, 'unauthorized');

  if (event.body && Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) {
    return fail(413, 'payload_too_large');
  }
  const body = parseBody(event);
  if (body === null) return fail(400, 'invalid_request');

  // A non-UUID id is answered 404 with no DB round trip at all. Handing it
  // to Postgres would raise 22P02 and leak out as a 500, and "no such
  // application" is the honest answer either way — an id that cannot exist
  // is indistinguishable, to this caller, from one that does not.
  const applicationId = event.pathParameters?.applicationId;
  if (typeof applicationId !== 'string' || !UUID_REGEX.test(applicationId)) {
    return fail(404, 'not_found');
  }

  const method = (event.httpMethod || 'GET').toUpperCase();
  const action = routeAction(event);
  const requiredTosVersion = process.env.REQUIRED_TOS_VERSION ?? '1.0';

  let client: PoolClient | undefined;
  let settled = false;
  const commit = async (): Promise<void> => { await client!.query('COMMIT'); settled = true; };
  const rollback = async (): Promise<void> => { await client!.query('ROLLBACK'); settled = true; };

  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');

    const workerId = await resolveWorker(client, cognitoSub);
    if (!workerId) {
      await rollback();
      return fail(404, 'worker_not_found');
    }
    await setInternalUserRlsContext(client, workerId);

    // The legal wall. Unlike the onboarding door (where accepting the terms
    // IS step one) this is an ordinary `/worker/*` route and must be gated.
    // Read directly rather than through `checkCompliance`, which keys on
    // cognito_sub: we already hold the internal id, and 004 grants
    // jale_whatsapp SELECT on exactly this column.
    const tosRes = await client.query<{ tos_version: string | null }>(
      `SELECT tos_version FROM users WHERE id = $1`,
      [workerId],
    );
    const currentVersion = tosRes.rows[0]?.tos_version ?? null;
    if (currentVersion?.trim() !== requiredTosVersion.trim()) {
      await rollback();
      return fail(403, 'legal_required', { requiredVersion: requiredTosVersion, currentVersion });
    }

    // OWNERSHIP. `jobapp_whatsapp_select` is USING (true), so this explicit
    // `worker_id = $2` is the only thing standing between a worker and
    // somebody else's application.
    const ownedRes = await client.query<{ id: string }>(
      `SELECT id FROM job_applications WHERE id = $1 AND worker_id = $2`,
      [applicationId, workerId],
    );
    if (ownedRes.rows.length === 0) {
      await rollback();
      return fail(404, 'not_found');
    }

    // ROUTE VALIDATION BEFORE THE SNAPSHOT LOAD. The load is not a pure
    // read -- it copies the worker's vault documents onto the job -- so a
    // request that can only ever be refused must not reach it. Still inside
    // the transaction (and still rolled back) because ownership is what
    // decides whether this caller is allowed to learn anything at all,
    // including which actions exist.
    if (action === '') {
      if (method !== 'GET') {
        await rollback();
        return fail(405, 'method_not_allowed');
      }
    } else if (!WRITE_ACTIONS.has(action)) {
      await rollback();
      return fail(404, 'not_found');
    } else if (method !== 'POST') {
      await rollback();
      return fail(405, 'method_not_allowed');
    }

    let snapshot: RequirementSnapshot | null;
    try {
      snapshot = await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true });
    } catch (err) {
      // The snapshot load COPIES vault docs onto the job, so it can trip
      // either 078 cap before a single answer has been read. A 409 the
      // browser can explain beats a 500 it cannot.
      if (!isCertificationDocumentLimit(err)) throw err;
      await rollback();
      return fail(409, 'certification_document_limit');
    }
    if (!snapshot) {
      await rollback();
      return fail(404, 'not_found');
    }

    // ── GET: the state document ────────────────────────────────────
    if (action === '') {
      // A doc uploaded through `/worker/vault/*` never touches this engine,
      // so the read is what completes the application. Re-load when it
      // flipped: `details_completed_at` is part of the response.
      const flipped = await markDetailsCompleteIfDone(client, applicationId, snapshot);
      if (flipped) {
        snapshot = await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true });
        if (!snapshot) {
          await rollback();
          return fail(404, 'not_found');
        }
      }
      const state = await buildState(client, snapshot);
      await commit();
      return json(200, state);
    }

    // ── POST {action}: the three write doors ───────────────────────
    let result: MergeResult;
    if (action === 'answers') {
      const answers = body.answers;
      if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
        await rollback();
        return fail(400, 'invalid_answers', { errors: {} });
      }
      const keyCount = Object.keys(answers).length;
      if (keyCount === 0 || keyCount > MAX_ANSWER_KEYS) {
        await rollback();
        return fail(400, 'invalid_answers', { errors: {} });
      }
      result = await mergeFieldAnswers(client, {
        applicationId,
        workerId,
        answers: answers as Record<string, unknown>,
      });
    } else if (action === 'certifications') {
      result = await mergeCertificationClaims(client, { applicationId, workerId, claims: body.claims });
    } else {
      // `prompt-answers` -- WRITE_ACTIONS above has already refused every
      // other action, so this branch cannot be reached by an unknown one.
      result = await mergePromptAnswers(client, { applicationId, workerId, answers: body.answers });
    }

    if (result.ok) {
      // The FRESH state: the merge may have filled the last gap and flipped
      // `details_completed_at`, and the browser renders straight from this.
      const fresh = await loadRequirementSnapshot(client, applicationId, { syncDocumentSnapshots: true });
      if (!fresh) {
        await rollback();
        return fail(404, 'not_found');
      }
      const state = await buildState(client, fresh);
      await commit();
      return json(200, state);
    }

    const mapped = mapFailure(result);
    // The 409 bodies carry the state so the browser can re-render without a
    // second round trip — built BEFORE the rollback, since building it is
    // itself two queries.
    const extra = mapped.withState
      ? { ...(mapped.extra ?? {}), state: await buildState(client, snapshot) }
      : (mapped.extra ?? {});
    await rollback();
    return fail(mapped.status, mapped.error, extra);
  } catch (err) {
    if (client && !settled) await client.query('ROLLBACK').catch(() => undefined);
    console.error(JSON.stringify({
      metric: 'WorkerApplicationDetailsRequestFailed',
      method,
      action,
      error: errorMessage(err),
    }));
    return fail(500, 'internal_error');
  } finally {
    client?.release();
  }
};
