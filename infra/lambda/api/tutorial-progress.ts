import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

/**
 * GET/POST /employer/tutorials and /worker/tutorials -- tutorial progress
 * (contract K1.2 and K1.3): which first-time tutorials this account has
 * finished or skipped, kept in public.user_tutorial_progress (migration 130),
 * one row per account and tutorial.
 *
 * The role comes from the path. Each path has the authorizer of one user
 * pool, so the employer ids are read and written only on /employer/tutorials
 * and the worker ids only on /worker/tutorials.
 *
 *   GET   the records this account has for the path's role; [] when none.
 *   POST  { tutorial_id, outcome } records how an auto-opened tutorial was
 *         dismissed. The first outcome recorded for an id is kept: the row is
 *         inserted with ON CONFLICT DO NOTHING and then read back, so the
 *         answer is always the stored record.
 *   404   no users row for the caller (post-confirmation never ran).
 *
 * No terms-of-service check: this is UI state, and the worker onboarding
 * tutorial shows before onboarding finishes. No access record: the handler
 * reads and writes no personal data, only the caller's own progress flags.
 *
 * One structured log line per request: role, method and an outcome code.
 * The caller's sub is never logged.
 */

/** K1.1. Never rename an id once released: the database stores them. */
export const EMPLOYER_TUTORIAL_IDS = [
  'employer_welcome',
  'employer_post_job',
  'employer_applicants',
  'employer_messages',
] as const;

export const WORKER_TUTORIAL_IDS = [
  'worker_onboarding',
  'worker_apply',
  'worker_details',
  'worker_profile',
] as const;

const OUTCOMES: readonly string[] = ['completed', 'skipped'];

/** K1.3: the record body is capped at 1 KiB, counted in bytes. */
const MAX_BODY_BYTES = 1024;

type Role = 'employer' | 'worker';

const ROLE_BY_RESOURCE: Readonly<Record<string, Role>> = {
  '/employer/tutorials': 'employer',
  '/worker/tutorials': 'worker',
};

const IDS_BY_ROLE: Readonly<Record<Role, readonly string[]>> = {
  employer: EMPLOYER_TUTORIAL_IDS,
  worker: WORKER_TUTORIAL_IDS,
};

interface StoredRow {
  tutorial_id: string;
  outcome: string;
  recorded_at: Date | string;
}

type RecordRequest =
  | { ok: true; tutorialId: string; outcome: string }
  | { ok: false; error: 'invalid_tutorial' | 'invalid_outcome' };

function toRecord(row: StoredRow): { tutorial_id: string; outcome: string; recorded_at: string } {
  return {
    tutorial_id: row.tutorial_id,
    outcome: row.outcome,
    recorded_at: new Date(row.recorded_at).toISOString(),
  };
}

/** Reads `{ tutorial_id, outcome }` for `role`. Unknown fields are ignored. */
function parseRecordRequest(body: string | null, role: Role): RecordRequest {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, error: 'invalid_tutorial' };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, error: 'invalid_tutorial' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'invalid_tutorial' };
  }
  const { tutorial_id: tutorialId, outcome } = value as Record<string, unknown>;
  if (typeof tutorialId !== 'string' || !IDS_BY_ROLE[role].includes(tutorialId)) {
    return { ok: false, error: 'invalid_tutorial' };
  }
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) {
    return { ok: false, error: 'invalid_outcome' };
  }
  return { ok: true, tutorialId, outcome };
}

const READ_SQL = `SELECT tutorial_id, outcome, recorded_at
                    FROM user_tutorial_progress
                   WHERE user_id = $1 AND tutorial_id = ANY($2::text[])
                   ORDER BY tutorial_id`;

const INSERT_SQL = `INSERT INTO user_tutorial_progress (user_id, tutorial_id, outcome)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (user_id, tutorial_id) DO NOTHING`;

const STORED_SQL = `SELECT tutorial_id, outcome, recorded_at
                      FROM user_tutorial_progress
                     WHERE user_id = $1 AND tutorial_id = $2`;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = (event.httpMethod ?? '').toUpperCase();
  const role: Role | null = ROLE_BY_RESOURCE[event.resource ?? ''] ?? null;

  const respond = (
    statusCode: number,
    body: unknown,
    outcome: string,
    extra: Record<string, unknown> = {},
  ): APIGatewayProxyResult => {
    console.log(JSON.stringify({ event: 'TutorialProgress', role, method, outcome, ...extra }));
    return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
  };

  const cognitoSub: unknown = event.requestContext?.authorizer?.claims?.sub;
  if (typeof cognitoSub !== 'string' || cognitoSub === '') {
    return respond(401, { error: 'unauthorized' }, 'unauthorized');
  }
  if (!role) return respond(404, { error: 'not_found' }, 'unknown_path');
  if (method !== 'GET' && method !== 'POST') {
    return respond(405, { error: 'method_not_allowed' }, 'method_not_allowed');
  }

  let record: { tutorialId: string; outcome: string } | null = null;
  if (method === 'POST') {
    const request = parseRecordRequest(event.body, role);
    if (!request.ok) return respond(400, { error: request.error }, request.error);
    record = request;
  }

  let client: PoolClient | undefined;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE cognito_sub = $1', [cognitoSub]);
    const userId = user.rows[0]?.id;
    if (!userId) {
      await client.query('ROLLBACK');
      return respond(404, { error: 'not_found' }, 'not_found');
    }

    if (!record) {
      const { rows } = await client.query<StoredRow>(READ_SQL, [userId, IDS_BY_ROLE[role]]);
      await client.query('COMMIT');
      return respond(200, { tutorials: rows.map(toRecord) }, 'read');
    }

    const { tutorialId, outcome } = record;
    const inserted = await client.query(INSERT_SQL, [userId, tutorialId, outcome]);
    const { rows } = await client.query<StoredRow>(STORED_SQL, [userId, tutorialId]);
    if (!rows[0]) throw new Error('tutorial progress: the stored record was not found after the insert');
    await client.query('COMMIT');
    return respond(
      200,
      { tutorial: toRecord(rows[0]) },
      (inserted.rowCount ?? 0) > 0 ? 'recorded' : 'already_recorded',
    );
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* the release below discards a client left in a transaction */ }
    }
    return respond(500, { error: 'internal_error' }, 'internal_error', { error: errorMessage(err) });
  } finally {
    client?.release();
  }
};
