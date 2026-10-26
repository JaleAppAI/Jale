import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

/**
 * GET/POST/PATCH /employer/tutorials and /worker/tutorials -- tutorial
 * progress and guide settings (contracts K1.2, K1.3 and K1-v2).
 *
 *   - Progress: which first-time tutorials, and which app tour, this account
 *     has finished or skipped, kept in public.user_tutorial_progress
 *     (migration 130), one row per account and id.
 *   - Settings: the account's guide settings, kept in
 *     public.user_tutorial_settings (migration 137), one row per account.
 *     `always_show` opens guides every time their task starts; `muted` lists
 *     the tutorials turned off with "Don't show this again".
 *
 * The role comes from the path. Each path has the authorizer of one user
 * pool, so the employer ids are read and written only on /employer/tutorials
 * and the worker ids only on /worker/tutorials.
 *
 *   GET    { tutorials, settings }: the records this account has for the
 *          role's tutorial ids and its tour id ([] when none), and its
 *          settings, read in one transaction. With no stored settings row
 *          the answer is { always_show: false, muted: [] }. `muted` is
 *          answered filtered to the role's tutorial ids, in their list order.
 *          A failed settings read answers those defaults with the progress
 *          (outcome code read_without_settings); a failed progress read is a
 *          500.
 *   POST   { tutorial_id, outcome } records how an auto-opened tutorial or
 *          the role's app tour was dismissed. The first outcome recorded for
 *          an id is kept: the row is inserted with ON CONFLICT DO NOTHING and
 *          then read back, so the answer is always the stored record.
 *   PATCH  { always_show?, muted? }, at least one of the two, saves the
 *          settings with one upsert and answers { settings }, the stored row
 *          read like GET. `muted` holds only the role's tutorial ids (never a
 *          tour id), is de-duplicated, stored in the role's list order and
 *          replaces the stored list; a field left out keeps its stored value.
 *          Anything else answers 400 invalid_settings.
 *   404    no users row for the caller (post-confirmation never ran).
 *
 * No terms-of-service check: this is UI state, and the worker onboarding
 * tutorial shows before onboarding finishes. No access record: the handler
 * reads and writes no personal data, only the caller's own progress flags
 * and settings.
 *
 * One structured log line per request: role, method and an outcome code.
 * The caller's sub and the settings themselves are never logged.
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

/**
 * K1-v2: one app tour per role. Its outcome is recorded like a tutorial's
 * (POST, first outcome wins), but it is never a muted id. Never rename an id
 * once released.
 */
export const EMPLOYER_TOUR_IDS = ['employer_app_tour'] as const;

export const WORKER_TOUR_IDS = ['worker_app_tour'] as const;

const OUTCOMES: readonly string[] = ['completed', 'skipped'];

/** K1.3 and K1-v2: a request body is capped at 1 KiB, counted in bytes. */
const MAX_BODY_BYTES = 1024;

type Role = 'employer' | 'worker';

const ROLE_BY_RESOURCE: Readonly<Record<string, Role>> = {
  '/employer/tutorials': 'employer',
  '/worker/tutorials': 'worker',
};

/** The tutorial ids of each role: the only ids `muted` may hold. */
const TUTORIAL_IDS_BY_ROLE: Readonly<Record<Role, readonly string[]>> = {
  employer: EMPLOYER_TUTORIAL_IDS,
  worker: WORKER_TUTORIAL_IDS,
};

/** Every id a role records an outcome for: its tutorials, then its tour. */
const RECORD_IDS_BY_ROLE: Readonly<Record<Role, readonly string[]>> = {
  employer: [...EMPLOYER_TUTORIAL_IDS, ...EMPLOYER_TOUR_IDS],
  worker: [...WORKER_TUTORIAL_IDS, ...WORKER_TOUR_IDS],
};

interface StoredRow {
  tutorial_id: string;
  outcome: string;
  recorded_at: Date | string;
}

type RecordRequest =
  | { ok: true; tutorialId: string; outcome: string }
  | { ok: false; error: 'invalid_tutorial' | 'invalid_outcome' };

/** A user_tutorial_settings row, and the settings as answered. */
interface Settings {
  always_show: boolean;
  muted: string[];
}

/** A settings patch: null leaves the stored value as it is. */
interface SettingsPatch {
  alwaysShow: boolean | null;
  muted: string[] | null;
}

function toRecord(row: StoredRow): { tutorial_id: string; outcome: string; recorded_at: string } {
  return {
    tutorial_id: row.tutorial_id,
    outcome: row.outcome,
    recorded_at: new Date(row.recorded_at).toISOString(),
  };
}

/**
 * `muted` as answered: only `role`'s tutorial ids, each once, in the role's
 * list order. A stored list may hold an id the role no longer lists.
 */
function inRoleOrder(ids: readonly string[], role: Role): string[] {
  return TUTORIAL_IDS_BY_ROLE[role].filter((id) => ids.includes(id));
}

function toSettings(row: Settings | undefined, role: Role): Settings {
  if (!row) return { always_show: false, muted: [] };
  return { always_show: row.always_show === true, muted: inRoleOrder(row.muted, role) };
}

/** A JSON object body within the size cap, or null. */
function parseObjectBody(body: string | null): Record<string, unknown> | null {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Reads `{ always_show?, muted? }` for `role`; at least one must be present.
 * Unknown fields are ignored. Null when anything is out of contract.
 */
function parseSettingsPatch(body: string | null, role: Role): SettingsPatch | null {
  const value = parseObjectBody(body);
  if (!value) return null;
  const hasAlwaysShow = Object.prototype.hasOwnProperty.call(value, 'always_show');
  const hasMuted = Object.prototype.hasOwnProperty.call(value, 'muted');
  if (!hasAlwaysShow && !hasMuted) return null;

  let alwaysShow: boolean | null = null;
  if (hasAlwaysShow) {
    if (typeof value.always_show !== 'boolean') return null;
    alwaysShow = value.always_show;
  }

  let muted: string[] | null = null;
  if (hasMuted) {
    const list = value.muted;
    if (!Array.isArray(list)) return null;
    const allowed = TUTORIAL_IDS_BY_ROLE[role];
    if (!list.every((id): id is string => typeof id === 'string' && allowed.includes(id))) return null;
    muted = inRoleOrder(list, role);
  }
  return { alwaysShow, muted };
}

/** Reads `{ tutorial_id, outcome }` for `role`. Unknown fields are ignored. */
function parseRecordRequest(body: string | null, role: Role): RecordRequest {
  const value = parseObjectBody(body);
  if (!value) return { ok: false, error: 'invalid_tutorial' };
  const { tutorial_id: tutorialId, outcome } = value;
  if (typeof tutorialId !== 'string' || !RECORD_IDS_BY_ROLE[role].includes(tutorialId)) {
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

const SETTINGS_SQL = `SELECT always_show, muted
                        FROM user_tutorial_settings
                       WHERE user_id = $1`;

// One upsert: a parameter sent as NULL keeps the stored value, or takes the
// column default on the first write. updated_at is set here; no trigger.
const SAVE_SETTINGS_SQL = `INSERT INTO user_tutorial_settings (user_id, always_show, muted, updated_at)
                           VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::text[], '{}'), now())
                           ON CONFLICT (user_id) DO UPDATE
                              SET always_show = COALESCE($2::boolean, user_tutorial_settings.always_show),
                                  muted = COALESCE($3::text[], user_tutorial_settings.muted),
                                  updated_at = now()
                           RETURNING always_show, muted`;

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
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH') {
    return respond(405, { error: 'method_not_allowed' }, 'method_not_allowed');
  }

  let record: { tutorialId: string; outcome: string } | null = null;
  if (method === 'POST') {
    const request = parseRecordRequest(event.body, role);
    if (!request.ok) return respond(400, { error: request.error }, request.error);
    record = request;
  }
  let patch: SettingsPatch | null = null;
  if (method === 'PATCH') {
    patch = parseSettingsPatch(event.body, role);
    if (!patch) return respond(400, { error: 'invalid_settings' }, 'invalid_settings');
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

    if (patch) {
      const { rows } = await client.query<Settings>(SAVE_SETTINGS_SQL, [userId, patch.alwaysShow, patch.muted]);
      if (!rows[0]) throw new Error('tutorial settings: the upsert returned no row');
      await client.query('COMMIT');
      return respond(200, { settings: toSettings(rows[0], role) }, 'settings_saved');
    }

    if (!record) {
      const { rows } = await client.query<StoredRow>(READ_SQL, [userId, RECORD_IDS_BY_ROLE[role]]);
      // Settings are read under a savepoint: when that read fails (the
      // settings table not there yet, a missing grant), progress still
      // answers, with the default settings, so first-time tutorials keep
      // working; the failure is logged under its own outcome code.
      await client.query('SAVEPOINT settings_read');
      let stored: Settings | undefined;
      let settingsError: string | null = null;
      try {
        stored = (await client.query<Settings>(SETTINGS_SQL, [userId])).rows[0];
        await client.query('RELEASE SAVEPOINT settings_read');
      } catch (err) {
        settingsError = errorMessage(err);
        await client.query('ROLLBACK TO SAVEPOINT settings_read');
      }
      await client.query('COMMIT');
      const body = { tutorials: rows.map(toRecord), settings: toSettings(stored, role) };
      if (settingsError !== null) return respond(200, body, 'read_without_settings', { error: settingsError });
      return respond(200, body, 'read');
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
