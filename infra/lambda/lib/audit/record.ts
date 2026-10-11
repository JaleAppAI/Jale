import type { AuditCaller } from './caller';
import { auditOrigin, writeAuditFallback } from './fallback';
import { emitAuditFallbackFailed, emitAuditWriteFailed, surfaceDimension } from './metrics';
import {
  ACCESS_SURFACES,
  FIELD_NAME_PATTERN,
  MAX_FIELD_NAMES,
  MAX_IDS_PER_PART,
  isAccessSurface,
  isUuid,
  type AccessSurface,
  type AuditPurpose,
  type AuditRecordType,
} from './registry';

/**
 * Access and attempt records for request handlers.
 *
 * recordAccess runs inside the request's transaction, after the data is
 * fetched and shaped and before COMMIT, so the record commits with the read
 * or not at all. It throws when the record cannot be written; the handler's
 * error path then answers 500 and returns none of the data.
 *
 * recordAttempt runs after the request's transaction has ended, on the same
 * client, in a transaction of its own. It never throws: when the database
 * refuses the record, it goes to the fallback log group.
 *
 * A record holds identifiers, codes, field names, counts and times. Never a
 * value: no answer, contact detail, message, document content or link.
 */

export const RECORD_EVENT_SQL = 'SELECT jale_audit.record_event($1::jsonb) AS seq';

/** One `jale_audit.record_event` payload, in the function's snake_case keys. */
export interface AuditEventPayload {
  kind: 'read' | 'attempt';
  outcome: 'allowed' | 'denied' | 'not_found' | 'failed';
  actor_kind: AuditCaller['actorKind'];
  actor_id?: string;
  channel: AuditCaller['channel'];
  surface: AccessSurface;
  categories: string[];
  subject_user_ids: string[];
  record_type?: AuditRecordType;
  record_ids: string[];
  result_count: number;
  field_names: string[];
  purpose_kind?: AuditPurpose['kind'];
  purpose_id?: string;
  link_expires_at?: string;
  part: number;
  parts: number;
  request_id: string;
}

/** What a handler states about a read it is about to return. */
export interface AccessEvent {
  surface: AccessSurface;
  /** The people whose data is returned. */
  subjectUserIds: readonly string[];
  /** The records returned, of the surface's record type. */
  recordIds?: readonly string[];
  /** How many results the response carries. A split record repeats it on every part. */
  resultCount: number;
  /** The response's field names (see responseFieldNames), never its values. */
  fieldNames?: readonly string[];
  purpose?: AuditPurpose | null;
  /** When a signed link granted by this read expires. */
  linkExpiresAt?: Date | null;
}

/** A refused, not-found or failed request on a covered surface. */
export interface AttemptEvent {
  surface: AccessSurface;
  outcome: 'denied' | 'not_found' | 'failed';
  /** The person asked for. Anything that is not a UUID is dropped: it names no one. */
  subjectUserIds?: readonly unknown[];
  /** The records asked for, of the surface's record type. Non-UUIDs are dropped. */
  recordIds?: readonly unknown[];
  /** A job or case purpose whose id is not a UUID is dropped. */
  purpose?: { kind: AuditPurpose['kind']; id?: unknown } | null;
}

/** The client surface these helpers use: a pg PoolClient, or a test double. */
export interface AuditClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  getTransactionStatus?: () => string | null;
}

/** Thrown when an access record cannot be written. Its message carries no value. */
export class AuditRecordError extends Error {
  constructor(surface: unknown, options?: { cause?: unknown }) {
    super(`audit: the access record for ${surfaceDimension(surface)} could not be written`, options);
    this.name = 'AuditRecordError';
  }
}

function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Field names as the records hold them: snake_case, sorted, de-duplicated, at most 100. */
export function normalizeFieldNames(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const snake = camelToSnake(String(name));
    if (FIELD_NAME_PATTERN.test(snake)) out.add(snake);
  }
  return [...out].sort().slice(0, MAX_FIELD_NAMES);
}

/**
 * The field names of a response: the keys of each object given (the items, for
 * a list). Keys that cannot be field names are left out. Only names are read,
 * never values.
 */
export function responseFieldNames(...shapes: unknown[]): string[] {
  const keys: string[] = [];
  const add = (shape: unknown): void => {
    if (Array.isArray(shape)) {
      for (const item of shape) add(item);
      return;
    }
    if (shape && typeof shape === 'object') keys.push(...Object.keys(shape));
  };
  for (const shape of shapes) add(shape);
  return normalizeFieldNames(keys);
}

function uniqueIds(ids: readonly unknown[] | undefined, what: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    if (!isUuid(id)) throw new Error(`audit: ${what} must be UUIDs`);
    const canonical = id.toLowerCase();
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

function validIds(ids: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    if (!isUuid(id)) continue;
    const canonical = id.toLowerCase();
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

function chunk(ids: string[], index: number): string[] {
  return ids.slice(index * MAX_IDS_PER_PART, (index + 1) * MAX_IDS_PER_PART);
}

function actorFields(caller: AuditCaller): Pick<AuditEventPayload, 'actor_kind' | 'actor_id' | 'channel'> {
  const needsId = caller.actorKind === 'worker' || caller.actorKind === 'employer';
  if (needsId ? !isUuid(caller.actorId) : caller.actorId !== null) {
    throw new Error('audit: the actor id does not fit the actor kind');
  }
  return {
    actor_kind: caller.actorKind,
    ...(caller.actorId ? { actor_id: caller.actorId } : {}),
    channel: caller.channel,
  };
}

function purposeFields(purpose: AuditPurpose | null | undefined): Pick<AuditEventPayload, 'purpose_kind' | 'purpose_id'> {
  if (!purpose) return {};
  if (purpose.kind === 'job' || purpose.kind === 'case') {
    if (!isUuid(purpose.id)) throw new Error('audit: a job or case purpose needs its id');
    return { purpose_kind: purpose.kind, purpose_id: purpose.id.toLowerCase() };
  }
  return { purpose_kind: purpose.kind };
}

/**
 * The payloads for one read: one, or one per part when the subjects or the
 * records number more than 500. Parts share the request id and repeat every
 * field except the two lists.
 */
export function buildAccessPayloads(caller: AuditCaller, event: AccessEvent): AuditEventPayload[] {
  if (!isAccessSurface(event.surface)) throw new Error('audit: unknown access surface');
  const entry = ACCESS_SURFACES[event.surface];
  const subjects = uniqueIds(event.subjectUserIds, 'subject ids');
  const records = uniqueIds(event.recordIds, 'record ids');
  if (records.length > 0 && entry.recordType === null) {
    throw new Error('audit: this surface records no record ids');
  }
  if (!Number.isInteger(event.resultCount) || event.resultCount < 0) {
    throw new Error('audit: the result count must be a whole number');
  }
  const parts = Math.max(
    1,
    Math.ceil(subjects.length / MAX_IDS_PER_PART),
    Math.ceil(records.length / MAX_IDS_PER_PART),
  );
  const common = {
    kind: 'read' as const,
    outcome: 'allowed' as const,
    ...actorFields(caller),
    surface: event.surface,
    categories: [...entry.categories],
    ...(entry.recordType ? { record_type: entry.recordType } : {}),
    result_count: event.resultCount,
    field_names: normalizeFieldNames(event.fieldNames ?? []),
    ...purposeFields(event.purpose),
    ...(event.linkExpiresAt ? { link_expires_at: event.linkExpiresAt.toISOString() } : {}),
    request_id: caller.requestId,
  };
  return Array.from({ length: parts }, (_, index) => ({
    ...common,
    subject_user_ids: chunk(subjects, index),
    record_ids: chunk(records, index),
    part: index + 1,
    parts,
  }));
}

/** The payload for one attempt. Ids that are not UUIDs are dropped, never sent. */
export function buildAttemptPayload(caller: AuditCaller, event: AttemptEvent): AuditEventPayload {
  if (!isAccessSurface(event.surface)) throw new Error('audit: unknown access surface');
  if (!['denied', 'not_found', 'failed'].includes(event.outcome)) throw new Error('audit: unknown attempt outcome');
  const entry = ACCESS_SURFACES[event.surface];
  const records = entry.recordType ? validIds(event.recordIds).slice(0, MAX_IDS_PER_PART) : [];
  let purpose: AuditPurpose | null = null;
  if (event.purpose) {
    const { kind, id } = event.purpose;
    if (kind === 'job' || kind === 'case') {
      if (isUuid(id)) purpose = { kind, id };
    } else {
      purpose = { kind };
    }
  }
  return {
    kind: 'attempt',
    outcome: event.outcome,
    ...actorFields(caller),
    surface: event.surface,
    categories: [...entry.categories],
    subject_user_ids: validIds(event.subjectUserIds).slice(0, MAX_IDS_PER_PART),
    ...(entry.recordType ? { record_type: entry.recordType } : {}),
    record_ids: records,
    result_count: 0,
    field_names: [],
    ...purposeFields(purpose),
    part: 1,
    parts: 1,
    request_id: caller.requestId,
  };
}

/**
 * Writes the access record for a read, in the caller's open transaction and
 * before COMMIT. Throws AuditRecordError, after emitting AuditWriteFailed,
 * when any part cannot be written.
 */
export async function recordAccess(client: AuditClient, caller: AuditCaller, event: AccessEvent): Promise<void> {
  try {
    for (const payload of buildAccessPayloads(caller, event)) {
      await client.query(RECORD_EVENT_SQL, [JSON.stringify(payload)]);
    }
  } catch (err) {
    emitAuditWriteFailed(event?.surface, auditOrigin());
    throw new AuditRecordError(event?.surface, { cause: err });
  }
}

function transactionStatus(client: AuditClient): string | null {
  try {
    return typeof client.getTransactionStatus === 'function' ? client.getTransactionStatus() : 'I';
  } catch {
    return null;
  }
}

/**
 * Writes an attempt record after the request's transaction has ended: BEGIN,
 * record_event, COMMIT, on the same client. On any failure it rolls back and
 * sends the record to the fallback log group. It never throws, and it never
 * runs inside a transaction it did not open: a client still in one sends the
 * record straight to the fallback.
 */
export async function recordAttempt(client: AuditClient, caller: AuditCaller, event: AttemptEvent): Promise<void> {
  let payload: AuditEventPayload;
  try {
    payload = buildAttemptPayload(caller, event);
  } catch {
    emitAuditFallbackFailed(auditOrigin(), { kind: 'attempt', surface: surfaceDimension(event?.surface) });
    return;
  }
  const status = transactionStatus(client);
  if (status !== 'I') {
    await writeAuditFallback(payload);
    return;
  }
  try {
    await client.query('BEGIN');
    await client.query(RECORD_EVENT_SQL, [JSON.stringify(payload)]);
    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may be gone; the pool discards it on release.
    }
    await writeAuditFallback(payload);
  }
}
