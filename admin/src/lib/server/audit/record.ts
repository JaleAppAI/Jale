// Admin dashboard access records.
//
//   withAdminReadTransaction(session, async (client) => ...)
//       BEGIN -> reads -> recordAdminAccess(...) -> COMMIT, then render.
//   recordAdminAccess(session, e, client)   a read, in the read's transaction
//   recordAdminAction(session, e, client)   an action, in the action's transaction
//   recordAdminAttempt(session | null, e)   a refusal or failure, after the
//                                           request's transaction has ended
//   recordAdminSession(outcome, actor)      sign-in, sign-out, expiry, rejection
//
// Access and action events throw when they cannot be written, so the request
// fails and returns nothing. Attempt and session events run in their own
// transaction on their own connection and never throw: when the database
// write fails they go to the fallback log. Call recordAdminAttempt only
// after the request's own client has been released; the pool is small.
//
// Events hold identifiers, codes, field names, counts and times. The one free
// text is an admin's reason for a contact reveal (purpose 'reveal'), at most
// 500 characters. Never pass a message body, a search input or a contact
// value into an event.
import type { PoolClient } from 'pg';
import type { AdminRole } from '../../types';
import { getAdminDbPool } from '../db';
import { isAdminRole, type AdminSession } from '../session-claims';
import {
  ANONYMOUS_ACTOR,
  adminActorFor,
  requestIdFor,
  type AdminAuditActor,
  type AnonymousAuditActor,
} from './actor';
import {
  ADMIN_SURFACES,
  AUDIT_CATEGORIES,
  AUDIT_CHANNEL,
  AUDIT_PURPOSE_KINDS,
  AUDIT_RECORD_TYPES,
  FIELD_NAME_PATTERN,
  MAX_CATEGORIES,
  MAX_FIELD_NAMES,
  MAX_IDS_PER_EVENT,
  MAX_REASON_LENGTH,
  SURFACE_PATTERN,
  isUuid,
  type AdminSurface,
  type AttemptOutcome,
  type AuditCategory,
  type AuditEventPayload,
  type AuditKind,
  type AuditRecordType,
  type SessionOutcome,
} from './codes';
import {
  emitAuditFallbackFailed,
  emitAuditWriteFailed,
  writeAuditFallback,
} from './fallback';

export { withAdminReadTransaction } from './with-read-transaction';
export type { AdminSurface, AttemptOutcome, AuditCategory, AuditRecordType, SessionOutcome } from './codes';

export const RECORD_EVENT_SQL = 'SELECT jale_audit.record_event($1::jsonb) AS seq';

/** Why the data was read. A reveal carries the admin's reason. */
export type AdminAuditPurpose =
  | { kind: 'reveal'; reason: string }
  | { kind: 'case' | 'job'; id: string }
  | { kind: 'verification' | 'self' | 'audit_review' };

/** The shape of an admin access or action event. */
export type AdminAuditEvent = {
  surface: AdminSurface;
  categories: readonly AuditCategory[];
  /** users.id of the people whose data was read or acted on. */
  subjectUserIds?: readonly string[];
  /** Required when recordIds is not empty. */
  recordType?: AuditRecordType;
  recordIds?: readonly string[];
  /** Column names only, never values. */
  fieldNames?: readonly string[];
  purpose?: AdminAuditPurpose;
  /** When a signed link granted by this read expires. */
  linkExpiresAt?: Date;
  /** Rows shown or affected. Defaults to the number of record ids. */
  resultCount?: number;
};

export type AdminAttemptEvent = AdminAuditEvent & { outcome: AttemptOutcome };

/** The actor of a session event: the admin, or null for an unknown caller. */
export type AdminSessionActor = {
  adminUserId: string;
  role: AdminRole;
  sessionId?: string;
  requestId?: string;
};

/** Any client with pg's query shape: a PoolClient, or a test double. */
export type AuditQueryClient = {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ['denied', 'not_found', 'failed'];
const SESSION_OUTCOMES: readonly SessionOutcome[] = ['signed_in', 'sign_in_rejected', 'signed_out', 'expired', 'revoked'];
const MAX_RESULT_COUNT = 2_147_483_647;
const MAX_PARTS = 32_767;

function invalid(key: string): Error {
  // Names the key, never the value.
  return new Error(`audit: invalid ${key}`);
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function uniqueIds(values: readonly string[] | undefined, key: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (!isUuid(value)) throw invalid(key);
    const id = value.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function uniqueCodes<T extends string>(values: readonly T[] | undefined): T[] {
  return [...new Set(values ?? [])];
}

type BuildInput = {
  kind: AuditKind;
  outcome: string;
  actor: AdminAuditActor | AnonymousAuditActor;
  event: AdminAuditEvent;
  requestId: string;
};

/**
 * Validates an event and turns it into record_event payloads. An event that
 * names more than 500 subjects or records is split into parts that share the
 * request id; part 1 carries the result count and later parts carry 0, so a
 * sum over parts stays right.
 */
export function buildAuditEventPayloads({ kind, outcome, actor, event, requestId }: BuildInput): AuditEventPayload[] {
  if (!event || typeof event !== 'object') throw invalid('event');

  const { surface } = event;
  if (!includes(ADMIN_SURFACES, surface) || surface.length > 100 || !SURFACE_PATTERN.test(surface)) {
    throw invalid('surface');
  }

  const categories = uniqueCodes(event.categories);
  if (
    categories.length < 1
    || categories.length > MAX_CATEGORIES
    || !categories.every((category) => includes(AUDIT_CATEGORIES, category))
  ) {
    throw invalid('categories');
  }

  const subjectUserIds = uniqueIds(event.subjectUserIds, 'subject_user_ids');
  const recordIds = uniqueIds(event.recordIds, 'record_ids');
  const { recordType } = event;
  if (recordType !== undefined && !includes(AUDIT_RECORD_TYPES, recordType)) throw invalid('record_type');
  if (recordIds.length > 0 && recordType === undefined) throw invalid('record_type');

  const fieldNames = uniqueCodes(event.fieldNames);
  if (fieldNames.length > MAX_FIELD_NAMES || !fieldNames.every((name) => FIELD_NAME_PATTERN.test(name))) {
    throw invalid('field_names');
  }

  const resultCount = event.resultCount ?? recordIds.length;
  if (!Number.isSafeInteger(resultCount) || resultCount < 0 || resultCount > MAX_RESULT_COUNT) {
    throw invalid('result_count');
  }

  let purposeKind: AuditEventPayload['purpose_kind'];
  let purposeId: string | undefined;
  let reason: string | undefined;
  const { purpose } = event;
  if (purpose !== undefined) {
    if (!purpose || !includes(AUDIT_PURPOSE_KINDS, purpose.kind)) throw invalid('purpose_kind');
    purposeKind = purpose.kind;
    if (purpose.kind === 'case' || purpose.kind === 'job') {
      if (!isUuid(purpose.id)) throw invalid('purpose_id');
      purposeId = purpose.id.toLowerCase();
    } else if (purpose.kind === 'reveal') {
      reason = typeof purpose.reason === 'string' ? purpose.reason.trim() : '';
      // The reason is the one free text, and only an admin may give one.
      if (!reason || reason.length > MAX_REASON_LENGTH || actor.actor_kind !== 'admin') {
        throw invalid('reason');
      }
    }
  }

  let linkExpiresAt: string | undefined;
  if (event.linkExpiresAt !== undefined) {
    if (!(event.linkExpiresAt instanceof Date) || Number.isNaN(event.linkExpiresAt.getTime())) {
      throw invalid('link_expires_at');
    }
    linkExpiresAt = event.linkExpiresAt.toISOString();
  }

  const parts = Math.max(
    1,
    Math.ceil(subjectUserIds.length / MAX_IDS_PER_EVENT),
    Math.ceil(recordIds.length / MAX_IDS_PER_EVENT),
  );
  if (parts > MAX_PARTS) throw invalid('parts');

  return Array.from({ length: parts }, (_, index): AuditEventPayload => {
    const from = index * MAX_IDS_PER_EVENT;
    const to = from + MAX_IDS_PER_EVENT;
    return {
      kind,
      outcome,
      actor_kind: actor.actor_kind,
      ...(actor.actor_kind === 'admin'
        ? {
            actor_id: actor.actor_id,
            actor_role: actor.actor_role,
            ...(actor.actor_session ? { actor_session: actor.actor_session } : {}),
          }
        : {}),
      channel: AUDIT_CHANNEL,
      surface,
      categories,
      subject_user_ids: subjectUserIds.slice(from, to),
      ...(recordType ? { record_type: recordType } : {}),
      record_ids: recordIds.slice(from, to),
      result_count: index === 0 ? resultCount : 0,
      field_names: fieldNames,
      ...(purposeKind ? { purpose_kind: purposeKind } : {}),
      ...(purposeId ? { purpose_id: purposeId } : {}),
      ...(reason ? { reason } : {}),
      ...(linkExpiresAt ? { link_expires_at: linkExpiresAt } : {}),
      ...(parts > 1 ? { part: index + 1, parts } : {}),
      request_id: requestId,
    };
  });
}

async function writeEvents(client: AuditQueryClient, payloads: AuditEventPayload[]): Promise<void> {
  for (const payload of payloads) {
    await client.query(RECORD_EVENT_SQL, [JSON.stringify(payload)]);
  }
}

async function recordInTransaction(
  kind: 'read' | 'action',
  outcome: 'allowed' | 'done',
  session: AdminSession,
  e: AdminAuditEvent,
  client: AuditQueryClient,
): Promise<void> {
  if (session?.preview === true) {
    return;
  }
  try {
    const payloads = buildAuditEventPayloads({
      kind,
      outcome,
      actor: adminActorFor(session),
      event: e,
      requestId: requestIdFor(session?.requestId),
    });
    await writeEvents(client, payloads);
  } catch (error) {
    emitAuditWriteFailed(e?.surface);
    throw error;
  }
}

/**
 * Records a read in the read's own transaction, before COMMIT. Throws when the
 * event cannot be written: the caller's transaction then rolls back and the
 * data is never returned.
 */
export function recordAdminAccess(session: AdminSession, e: AdminAuditEvent, client: AuditQueryClient): Promise<void> {
  return recordInTransaction('read', 'allowed', session, e, client);
}

/** Records an action (no free text) in the action's transaction, before COMMIT. Throws on failure. */
export function recordAdminAction(session: AdminSession, e: AdminAuditEvent, client: AuditQueryClient): Promise<void> {
  return recordInTransaction('action', 'done', session, e, client);
}

/**
 * The attempt channel: BEGIN -> record_event -> COMMIT on a connection of its
 * own. On any failure the transaction rolls back and every part goes to the
 * fallback log. Never throws.
 */
async function writeOutsideRequest(payloads: AuditEventPayload[]): Promise<void> {
  const occurredAt = new Date();
  let client: PoolClient;
  try {
    const pool = await getAdminDbPool();
    client = await pool.connect();
  } catch {
    for (const payload of payloads) await writeAuditFallback(payload, occurredAt);
    return;
  }

  try {
    await client.query('BEGIN');
    await writeEvents(client, payloads);
    await client.query('COMMIT');
    client.release();
  } catch {
    let broken: Error | undefined;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    }
    client.release(broken);
    for (const payload of payloads) await writeAuditFallback(payload, occurredAt);
  }
}

function lostEventCodes(kind: AuditKind, outcome: unknown, surface: unknown): Record<string, unknown> {
  return {
    kind,
    outcome: typeof outcome === 'string' && /^[a-z_]{1,32}$/.test(outcome) ? outcome : 'invalid',
    surface: typeof surface === 'string' && surface.length <= 100 && SURFACE_PATTERN.test(surface) ? surface : 'invalid',
  };
}

/**
 * Records a refusal or a failure (outcome denied, not_found or failed) after
 * the request's transaction has ended and its client has been released.
 * `session` is null when there is no signed-in admin. Never throws.
 */
export async function recordAdminAttempt(session: AdminSession | null, e: AdminAttemptEvent): Promise<void> {
  if (session?.preview === true) {
    return;
  }
  let payloads: AuditEventPayload[];
  try {
    if (!includes(ATTEMPT_OUTCOMES, e?.outcome)) throw invalid('outcome');
    payloads = buildAuditEventPayloads({
      kind: 'attempt',
      outcome: e.outcome,
      actor: session ? adminActorFor(session) : ANONYMOUS_ACTOR,
      event: e,
      requestId: requestIdFor(session?.requestId),
    });
  } catch {
    emitAuditFallbackFailed(lostEventCodes('attempt', e?.outcome, e?.surface));
    return;
  }
  await writeOutsideRequest(payloads);
}

/**
 * Records a session event through the attempt channel: signed_in,
 * sign_in_rejected (actor null: the caller is not a known admin), signed_out,
 * expired or revoked. Never throws.
 */
export async function recordAdminSession(outcome: SessionOutcome, actor: AdminSessionActor | null): Promise<void> {
  let payloads: AuditEventPayload[];
  try {
    if (!includes(SESSION_OUTCOMES, outcome)) throw invalid('outcome');
    let auditActor: AdminAuditActor | AnonymousAuditActor = ANONYMOUS_ACTOR;
    if (actor) {
      if (!isUuid(actor.adminUserId) || !isAdminRole(actor.role)) throw invalid('actor');
      if (actor.sessionId !== undefined && !isUuid(actor.sessionId)) throw invalid('actor_session');
      auditActor = {
        actor_kind: 'admin',
        actor_id: actor.adminUserId.toLowerCase(),
        actor_role: actor.role,
        ...(actor.sessionId ? { actor_session: actor.sessionId.toLowerCase() } : {}),
      };
    }
    payloads = buildAuditEventPayloads({
      kind: 'session',
      outcome,
      actor: auditActor,
      event: { surface: 'admin.session', categories: ['admin_access'], resultCount: 0 },
      requestId: requestIdFor(actor?.requestId),
    });
  } catch {
    emitAuditFallbackFailed(lostEventCodes('session', outcome, 'admin.session'));
    return;
  }
  await writeOutsideRequest(payloads);
}
