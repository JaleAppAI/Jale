import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { getDbPool } from '../../lib/db';
import { corsHeaders } from '../../lib/http';
import {
  emitEmailSkipped,
  emitIntakeError,
  emitRateLimited,
  emitReportCapture,
  emitReportCreated,
  emitRoleUnknown,
  emitUploadRejected,
  type CaptureOutcome,
} from './metrics';
import { hashAttachToken, newAttachToken } from './tokens';
import { deleteObjectQuietly, pinUpload, presignUpload, type UploadGrant } from './upload';
import {
  readJsonBody,
  validateAttach,
  validateUpload,
  type CreateInput,
  type ImageType,
  type ReportRole,
} from './validate';

/**
 * What both report intakes share: the request wrapper (routing, the one log
 * line, the 500), the transaction rule, the create tail, and the upload and
 * attach actions, which authenticate by the attach token alone.
 *
 * The transaction rule: every intake call commits whatever
 * its outcome, refusals included, because a refused attempt still counts
 * toward the rate limits; only an exception rolls back. No network call runs
 * between BEGIN and COMMIT: the logins end a transaction left idle for 60 s.
 * So storage calls (signing, checking, copying, deleting) always run between
 * transactions.
 *
 * Nothing here answers with a sign-in or terms refusal: a report is accepted
 * from anyone the route admits, with or without an account.
 */

const s3 = new S3Client({});

export interface ActionResult {
  response: APIGatewayProxyResult;
  /** A fixed outcome code for the log line. */
  outcome: string;
  /** A fixed code that refines the outcome, when one helps. */
  reason?: string;
}

export type Action = (event: APIGatewayProxyEvent) => Promise<ActionResult>;

export function respond(status: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResult {
  return { statusCode: status, headers: { ...corsHeaders(), ...headers }, body: JSON.stringify(body) };
}

function result(status: number, body: Record<string, unknown>, outcome: string, reason?: string): ActionResult {
  return { response: respond(status, body), outcome, ...(reason ? { reason } : {}) };
}

/** 400 naming the fields that failed; never their values. */
export function invalid(fields?: string[], reason?: string): ActionResult {
  return result(400, fields ? { error: 'invalid_request', fields } : { error: 'invalid_request' }, 'invalid_request', reason);
}

/** The body of a POST, or the 413/400 to answer instead. */
export function parseBody(event: APIGatewayProxyEvent): { ok: true; value: unknown } | { ok: false; result: ActionResult } {
  const parsed = readJsonBody(event);
  if (parsed.ok) return parsed;
  if (parsed.status === 413) {
    return { ok: false, result: result(413, { error: 'payload_too_large' }, 'payload_too_large') };
  }
  return { ok: false, result: invalid(parsed.fields) };
}

/** A code safe to log for an error: a SQLSTATE or the error's class name, never its message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(name) ? name : 'Error';
}

/**
 * The Lambda handler for one intake: routes `<METHOD> <action>` to an
 * action, answers 404 for anything else, turns an exception into 500
 * `internal` (and ReportIntakeErrors), and writes exactly one log line per
 * request: tag, action, outcome and the API request id. Never the body, the
 * context, the contact, keys, tokens, addresses or hashes.
 */
export function intakeHandler(
  tag: string,
  routes: ReadonlyMap<string, Action>,
): (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult> {
  return async (event) => {
    const action = event.pathParameters?.action;
    // A Map, so a caller-chosen action such as `__proto__` finds nothing.
    const route = typeof action === 'string' ? routes.get(`${event.httpMethod} ${action}`) : undefined;
    let outcome: ActionResult;
    if (!route) {
      outcome = result(404, { error: 'not_found' }, 'not_found');
    } else {
      try {
        outcome = await route(event);
      } catch (err) {
        emitIntakeError();
        outcome = {
          response: respond(500, { error: 'internal' }, { 'Cache-Control': 'no-store' }),
          outcome: 'internal',
          reason: errorCode(err),
        };
      }
    }
    console.log(JSON.stringify({
      tag,
      action: route ? action : 'unknown',
      outcome: outcome.outcome,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      requestId: event.requestContext?.requestId,
    }));
    return outcome.response;
  };
}

/**
 * Runs `fn` between BEGIN and COMMIT on `client`. Any exception rolls back
 * and propagates. `beforeCommit` runs just before COMMIT is sent, so a caller
 * can tell "failed before the commit" (nothing was recorded) from "failed at
 * the commit" (it may have been).
 */
export async function inTransaction<T>(
  client: PoolClient,
  fn: () => Promise<T>,
  beforeCommit?: () => void,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const value = await fn();
    beforeCommit?.();
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function imagesConfig(): { bucket: string; kmsKeyId: string } {
  const bucket = process.env.REPORT_IMAGES_BUCKET;
  const kmsKeyId = process.env.REPORT_IMAGES_KEY_ID;
  if (!bucket || !kmsKeyId) throw new Error('report_images_not_configured');
  return { bucket, kmsKeyId };
}

async function presign(key: string, contentType: ImageType): Promise<UploadGrant> {
  const { bucket, kmsKeyId } = imagesConfig();
  return presignUpload(s3, { bucket, key, contentType, kmsKeyId });
}

/** The single row a jale_cap function returns, with its outcome checked against `allowed`. */
function outcomeRow<T extends { outcome: unknown }>(rows: T[], allowed: readonly string[], fn: string): T {
  const row = rows[0];
  if (!row || typeof row.outcome !== 'string' || !allowed.includes(row.outcome)) {
    throw new Error(`${fn}: unexpected outcome`);
  }
  return row;
}

// ── Create ──

export interface CreateRow {
  outcome: string;
  report_id: string | null;
  report_number: string | number | null;
  replayed: boolean | null;
  email_queued: boolean | null;
}

const CREATE_OUTCOMES = [
  'ok', 'reporting_paused', 'signed_out_paused', 'rate_limited', 'rate_limited_global',
  'invalid_category', 'invalid_request', 'role_unknown',
] as const;

export const CREATE_COLUMNS = 'outcome, report_id, report_number, replayed, email_queued';

export function createRow(rows: CreateRow[], fn: string): CreateRow {
  const row = outcomeRow(rows, CREATE_OUTCOMES, fn);
  if (row.outcome === 'ok' && (typeof row.report_id !== 'string' || row.report_number === null)) {
    throw new Error(`${fn}: ok without a report`);
  }
  return row;
}

interface GrantRow {
  outcome: string;
  upload_key: string | null;
}

const GRANT_OUTCOMES = ['ok', 'not_found', 'already_attached', 'upload_expired', 'screenshots_paused', 'invalid_type'] as const;

async function uploadGrant(client: PoolClient, reportId: string, tokenHash: string, contentType: ImageType): Promise<GrantRow> {
  const { rows } = await client.query<GrantRow>(
    'SELECT outcome, upload_key FROM jale_cap.problem_report_upload_grant($1::uuid, $2::text, $3::text)',
    [reportId, tokenHash, contentType],
  );
  const row = outcomeRow(rows, GRANT_OUTCOMES, 'problem_report_upload_grant');
  if (row.outcome === 'ok' && typeof row.upload_key !== 'string') {
    throw new Error('problem_report_upload_grant: ok without a key');
  }
  return row;
}

export interface CreateDoor {
  /** The role for the ReportsCreated dimension: the sign-in's, or the one claimed. */
  role: ReportRole;
  verified: boolean;
  /** What an over-limit `rate_limited` counts against. */
  rateLimitScope: 'account' | 'address';
  /** Runs the door's create function inside the open transaction. */
  create: (client: PoolClient, tokenHash: string) => Promise<CreateRow>;
}

/**
 * One transaction: the door's create, then, for a saved report that declares
 * an image, the upload grant. After the commit: metrics, and the signature
 * for the upload. A failed signature does not fail the saved report: it
 * answers with no upload, and the person can ask for one through `upload`.
 */
export async function createReport(input: CreateInput, door: CreateDoor): Promise<ActionResult> {
  const { token, hash } = newAttachToken();
  const { row, grant } = await withClient((client) => inTransaction(client, async () => {
    const created = await door.create(client, hash);
    const granted = created.outcome === 'ok' && input.image
      ? await uploadGrant(client, created.report_id as string, hash, input.image.contentType)
      : undefined;
    return { row: created, grant: granted };
  }));

  switch (row.outcome) {
    case 'ok':
      break;
    case 'reporting_paused':
    case 'signed_out_paused':
      return result(503, { error: row.outcome }, row.outcome);
    case 'rate_limited':
      emitRateLimited(door.rateLimitScope);
      return result(429, { error: 'rate_limited' }, row.outcome);
    case 'rate_limited_global':
      emitRateLimited('global');
      return result(429, { error: 'rate_limited' }, row.outcome);
    case 'invalid_category':
      return invalid(['category'], row.outcome);
    case 'role_unknown':
      emitRoleUnknown();
      return invalid(undefined, row.outcome);
    default:
      // invalid_request: the key belongs to another reporter's report.
      return invalid(['client_key'], row.outcome);
  }

  const replayed = row.replayed === true;
  if (!replayed) {
    emitReportCreated(door.role, door.verified);
    const capture = (input.context.capture as { outcome?: CaptureOutcome } | undefined)?.outcome;
    if (capture) emitReportCapture(capture);
  }
  // false means the team-email switch is on but nothing was queued; NULL
  // (switched off, or a replay) is not a skip.
  if (row.email_queued === false) emitEmailSkipped();

  let upload: UploadGrant | null = null;
  let reason: string | undefined;
  if (grant?.outcome === 'ok' && input.image) {
    try {
      upload = await presign(grant.upload_key as string, input.image.contentType);
    } catch (err) {
      emitIntakeError();
      reason = `upload_unsigned:${errorCode(err)}`;
    }
  }

  return {
    response: respond(201, {
      number: `JR-${row.report_number}`,
      report_id: row.report_id,
      attach_token: token,
      upload,
      replayed,
    }),
    outcome: replayed ? 'replayed' : 'ok',
    ...(reason ? { reason } : {}),
  };
}

// ── Upload and attach ──

/** The answers to an upload or attach refusal. */
const IMAGE_REFUSALS = new Map<string, number>([
  ['not_found', 404],
  ['already_attached', 409],
  ['upload_expired', 410],
  ['invalid_image', 422],
  ['screenshots_paused', 503],
]);

function imageRefusal(outcome: string, reason?: string): ActionResult {
  const status = IMAGE_REFUSALS.get(outcome);
  if (status === undefined) throw new Error('report image: unmapped outcome');
  return result(status, { error: outcome }, outcome, reason);
}

/** POST upload: a new upload for a saved report, by its token. */
export async function uploadAction(event: APIGatewayProxyEvent): Promise<ActionResult> {
  const body = parseBody(event);
  if (!body.ok) return body.result;
  const checked = validateUpload(body.value);
  if (!checked.ok) return invalid(checked.fields);
  const { reportId, attachToken, image } = checked.value;
  const tokenHash = hashAttachToken(attachToken);

  const grant = await withClient((client) => inTransaction(client, () => uploadGrant(client, reportId, tokenHash, image.contentType)));
  if (grant.outcome === 'invalid_type') return invalid(['image'], grant.outcome);
  if (grant.outcome !== 'ok') return imageRefusal(grant.outcome);

  const upload = await presign(grant.upload_key as string, image.contentType);
  return result(200, { upload }, 'ok');
}

interface PendingRow {
  outcome: string;
  pending_key: string | null;
  content_type: string | null;
}

const PENDING_OUTCOMES = ['ok', 'not_found', 'already_attached', 'upload_expired', 'screenshots_paused'] as const;
const ATTACH_OUTCOMES = ['ok', 'not_found', 'already_attached', 'upload_expired', 'invalid_image', 'screenshots_paused'] as const;
const IMAGE_TYPE_SET: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * POST attach: the pre-check in its own transaction, then the storage checks
 * and the copy with no transaction open, then the attach in a second one.
 * A copy whose attach is refused for this attempt's own token is deleted.
 * `already_attached` deletes nothing: it names the image an earlier attempt
 * of this same upload attached. Nor does `not_found`: the token is checked
 * first, so another attempt on the same upload, holding a newer token, may
 * have attached this very key. A copy left that way goes with the lifecycle
 * rule.
 */
export async function attachAction(event: APIGatewayProxyEvent): Promise<ActionResult> {
  const body = parseBody(event);
  if (!body.ok) return body.result;
  const checked = validateAttach(body.value);
  if (!checked.ok) return invalid(checked.fields);
  const { reportId, attachToken } = checked.value;
  const tokenHash = hashAttachToken(attachToken);

  return withClient(async (client) => {
    const pending = await inTransaction(client, async () => {
      const { rows } = await client.query<PendingRow>(
        'SELECT outcome, pending_key, content_type FROM jale_cap.problem_report_pending_upload($1::uuid, $2::text)',
        [reportId, tokenHash],
      );
      const row = outcomeRow(rows, PENDING_OUTCOMES, 'problem_report_pending_upload');
      if (row.outcome === 'ok' && (typeof row.pending_key !== 'string' || !IMAGE_TYPE_SET.has(row.content_type ?? ''))) {
        throw new Error('problem_report_pending_upload: ok without an upload');
      }
      return row;
    });
    if (pending.outcome !== 'ok') return imageRefusal(pending.outcome);

    const { bucket, kmsKeyId } = imagesConfig();
    const pendingKey = pending.pending_key as string;
    const contentType = pending.content_type as ImageType;
    const pinned = await pinUpload(s3, { bucket, reportId, pendingKey, contentType, kmsKeyId });
    if (!pinned.ok) {
      emitUploadRejected(pinned.reason);
      // Nothing arrived, or it is gone: a new upload can still work.
      if (pinned.reason === 'missing') return imageRefusal('upload_expired', pinned.reason);
      return imageRefusal('invalid_image', pinned.reason);
    }

    let commitSent = false;
    let attached: { outcome: string };
    try {
      attached = await inTransaction(client, async () => {
        const { rows } = await client.query<{ outcome: string }>(
          'SELECT outcome FROM jale_cap.problem_report_attach($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::integer)',
          [reportId, tokenHash, pendingKey, pinned.finalKey, contentType, pinned.byteSize],
        );
        return outcomeRow(rows, ATTACH_OUTCOMES, 'problem_report_attach');
      }, () => {
        commitSent = true;
      });
    } catch (err) {
      // Rolled back before the commit: nothing names the copy, so it goes.
      // A failure at the commit may still have recorded it, so it stays.
      if (!commitSent) await deleteObjectQuietly(s3, bucket, pinned.finalKey);
      throw err;
    }

    if (attached.outcome === 'ok') return result(200, { attached: true }, 'ok');
    if (attached.outcome !== 'already_attached' && attached.outcome !== 'not_found') {
      await deleteObjectQuietly(s3, bucket, pinned.finalKey);
      if (attached.outcome === 'invalid_image') emitUploadRejected('refused');
    }
    return imageRefusal(attached.outcome);
  });
}
