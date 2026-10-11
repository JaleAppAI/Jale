import {
  parseAccessHistoryQuery,
  type AccessHistoryFilter,
  type AccessHistoryResult,
  type AccessHistorySearchParams,
} from '../access-history';
import type { AccessHistoryEntry, AccessHistorySource } from '../types';
import { adminActorFor, requestIdFor } from './audit/actor';
import { recordAdminAttempt, withAdminReadTransaction, type AuditQueryClient } from './audit/record';
import type { AdminSession } from './session-claims';

// The dashboard's reveal tile counts this many days back.
export const REVEAL_TILE_DAYS = 7;

/**
 * Contact reveals in the last `days` days, from the access records (and the
 * frozen legacy action log): jale_audit.reveal_count returns a count only.
 */
export async function countRecentReveals(
  client: AuditQueryClient,
  days: number = REVEAL_TILE_DAYS,
): Promise<number> {
  const result = await client.query<{ count: string | number }>(
    'SELECT jale_audit.reveal_count($1) AS count',
    [days],
  );
  return Number(result.rows[0]?.count ?? 0);
}

// --- The access history --------------------------------------------------------

/**
 * Rows asked of history_search per page; ties can make a page longer. Short
 * enough to render the whole page without virtualizing it (or printing it
 * half blank).
 */
export const ACCESS_HISTORY_PAGE_SIZE = 50;

/**
 * One page of the access history. history_search records the search itself,
 * in the caller's transaction. `cursor` is each row's time with microseconds
 * (a JavaScript Date keeps milliseconds only), for the next page's p_before.
 * The ORDER BY repeats the function's own order: newest first.
 */
export const HISTORY_SEARCH_SQL = `
  SELECT h.source, h.seq, h.entry_id, h.occurred_at,
         to_char(h.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor,
         h.kind, h.outcome, h.actor_kind, h.actor_id, h.actor_role, h.actor_session, h.actor_email,
         h.channel, h.surface, h.categories, h.subject_user_ids, h.record_type, h.record_ids,
         h.result_count, h.field_names, h.purpose_kind, h.purpose_id, h.reason, h.link_expires_at,
         h.part, h.parts, h.table_name, h.operation, h.row_count, h.changed_fields, h.context_status,
         h.action, h.target_type, h.target_id, h.summary, h.pii_reveal, h.request_id
    FROM jale_audit.history_search($1::jsonb, $2::jsonb, $3, $4::timestamptz) AS h
   ORDER BY h.occurred_at DESC, h.source, h.seq DESC, h.entry_id`;

export type HistorySearchRow = {
  source: string;
  seq: string | number | null;
  entry_id: string;
  occurred_at: Date | string;
  cursor: string;
  kind: string | null;
  outcome: string | null;
  actor_kind: string | null;
  actor_id: string | null;
  actor_role: string | null;
  actor_session: string | null;
  actor_email: string | null;
  channel: string | null;
  surface: string | null;
  categories: string[] | null;
  subject_user_ids: string[] | null;
  record_type: string | null;
  record_ids: string[] | null;
  result_count: number | null;
  field_names: string[] | null;
  purpose_kind: string | null;
  purpose_id: string | null;
  reason: string | null;
  link_expires_at: Date | string | null;
  part: number | null;
  parts: number | null;
  table_name: string | null;
  operation: string | null;
  row_count: number | null;
  changed_fields: string[] | null;
  context_status: string | null;
  action: string | null;
  target_type: string | null;
  target_id: string | null;
  summary: string | null;
  pii_reveal: boolean | null;
  request_id: string | null;
};

const SOURCES: readonly AccessHistorySource[] = ['event', 'change', 'legacy'];

function asIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// node-postgres returns text[] and uuid[] columns as arrays. Anything else
// fails loudly rather than render wrong ids.
function asList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('access history: unexpected list value');
  return value.map(String);
}

function optional<K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** A history_search row as the page shows it. NULL columns are left out. */
export function mapHistoryRow(row: HistorySearchRow): AccessHistoryEntry {
  if (!(SOURCES as readonly string[]).includes(row.source)) {
    throw new Error('access history: unexpected source');
  }
  return {
    key: `${row.source}:${row.entry_id}`,
    source: row.source as AccessHistorySource,
    occurredAt: asIso(row.occurred_at),
    ...optional('kind', row.kind),
    ...optional('outcome', row.outcome),
    ...optional('actorKind', row.actor_kind),
    ...optional('actorId', row.actor_id),
    ...optional('actorRole', row.actor_role),
    ...optional('actorSession', row.actor_session),
    ...optional('actorEmail', row.actor_email),
    ...optional('channel', row.channel),
    ...optional('surface', row.surface),
    categories: asList(row.categories),
    subjectUserIds: asList(row.subject_user_ids),
    ...optional('recordType', row.record_type),
    recordIds: asList(row.record_ids),
    ...optional('resultCount', row.result_count),
    fieldNames: asList(row.field_names),
    ...optional('purposeKind', row.purpose_kind),
    ...optional('purposeId', row.purpose_id),
    ...optional('reason', row.reason),
    ...optional('linkExpiresAt', row.link_expires_at == null ? null : asIso(row.link_expires_at)),
    ...optional('part', row.part),
    ...optional('parts', row.parts),
    ...optional('tableName', row.table_name),
    ...optional('operation', row.operation),
    ...optional('rowCount', row.row_count),
    changedFields: asList(row.changed_fields),
    ...optional('contextStatus', row.context_status),
    ...optional('action', row.action),
    ...optional('targetType', row.target_type),
    ...optional('targetId', row.target_id),
    ...optional('summary', row.summary),
    piiReveal: row.pii_reveal === true,
    ...optional('requestId', row.request_id),
  };
}

/** history_search's p_filter: only the filters that are set. */
function historyFilterPayload(filter: AccessHistoryFilter): Record<string, string> {
  const payload: Record<string, string> = {};
  if (filter.subjectUserId) payload.subject_user_id = filter.subjectUserId;
  if (filter.actorId) payload.actor_id = filter.actorId;
  if (filter.recordId) payload.record_id = filter.recordId;
  if (filter.from) payload.from = filter.from;
  if (filter.to) payload.to = filter.to;
  if (filter.category) payload.category = filter.category;
  if (filter.outcome) payload.outcome = filter.outcome;
  return payload;
}

/**
 * One page of the access history, in the caller's read transaction. The
 * function records the search (its own read event, with this request id)
 * before it returns. Every returned row is kept: a page holds more than
 * `limit` rows only when rows tie on its last time, and dropping one would
 * skip it for good. A full page offers the next one from its last row.
 */
export async function searchAccessHistory(
  client: AuditQueryClient,
  session: AdminSession,
  filter: AccessHistoryFilter,
  before?: string,
  limit: number = ACCESS_HISTORY_PAGE_SIZE,
): Promise<{ entries: AccessHistoryEntry[]; nextBefore?: string }> {
  const actor = adminActorFor(session);
  const pActor = {
    actor_id: actor.actor_id,
    actor_role: actor.actor_role,
    ...(actor.actor_session ? { actor_session: actor.actor_session } : {}),
    request_id: requestIdFor(session.requestId),
  };
  const result = await client.query<HistorySearchRow>(HISTORY_SEARCH_SQL, [
    JSON.stringify(pActor),
    JSON.stringify(historyFilterPayload(filter)),
    limit,
    before ?? null,
  ]);
  const { rows } = result;
  const entries = rows.map(mapHistoryRow);
  const last = rows.at(-1);
  return rows.length >= limit && last ? { entries, nextBefore: last.cursor } : { entries };
}

/**
 * The access history page (/access-history), superadmins only.
 *   - Another role is refused, and the refusal is recorded as a denied
 *     attempt that names no search input.
 *   - The local preview has no admin id to search as.
 *   - An invalid search is shown back without searching.
 *   - Otherwise one read transaction around history_search, which records
 *     the search; the entries are returned after COMMIT.
 *   - A search that fails records a failed attempt once its client is
 *     released. Like the refusal, it names no search input.
 */
export async function loadAccessHistory(
  session: AdminSession,
  params: AccessHistorySearchParams,
): Promise<AccessHistoryResult> {
  if (session.role !== 'admin_superadmin') {
    await recordAdminAttempt(session, {
      surface: 'admin.access_history',
      categories: ['audit_history'],
      purpose: { kind: 'audit_review' },
      outcome: 'denied',
    });
    return { status: 'forbidden' };
  }
  if (session.preview) {
    return { status: 'preview' };
  }

  const query = parseAccessHistoryQuery(params);
  if (query.problems.length > 0) {
    return { status: 'invalid', query };
  }

  let page: Awaited<ReturnType<typeof searchAccessHistory>>;
  try {
    page = await withAdminReadTransaction(
      session,
      (client) => searchAccessHistory(client, session, query.filter, query.before),
    );
  } catch (error) {
    await recordAdminAttempt(session, {
      surface: 'admin.access_history',
      categories: ['audit_history'],
      purpose: { kind: 'audit_review' },
      outcome: 'failed',
    });
    throw error;
  }
  return { status: 'ok', query, ...page };
}
