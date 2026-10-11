import type { AuditCaller } from './caller';
import {
  ACCESS_SURFACES,
  CHANGE_SURFACES,
  REQUEST_CHANNELS,
  REQUEST_ID_PATTERN,
  SURFACE_PATTERN,
  isUuid,
  type AuditSurface,
} from './registry';
import type { AuditClient } from './record';

/**
 * The change-record context: who is writing, through which
 * channel and surface, for which request. The change-log triggers read these
 * five settings for every covered write in the same transaction, so a unit
 * of work that writes a covered table states its actor first.
 *
 * All five are set in one statement, transaction-locally
 * (set_config(..., true)), so the context ends with the transaction and never
 * reaches the next request on a pooled connection.
 */
export const SET_AUDIT_CONTEXT_SQL = `SELECT set_config('app.audit_actor_kind', $1, true),
       set_config('app.audit_actor_id', $2, true),
       set_config('app.audit_channel', $3, true),
       set_config('app.audit_surface', $4, true),
       set_config('app.audit_request_id', $5, true)`;

const ID_ACTORS = new Set<string>(['worker', 'employer']);
const NO_ID_ACTORS = new Set<string>(['token_holder', 'anonymous', 'platform']);
const SURFACES = new Set<string>([...Object.keys(ACCESS_SURFACES), ...CHANGE_SURFACES]);

/**
 * The five setting values, in SET_AUDIT_CONTEXT_SQL's order. Throws on a
 * context the triggers would store as invalid; in particular an anonymous,
 * platform or token-holder actor never carries an id.
 */
export function auditContextValues(caller: AuditCaller, surface: AuditSurface): [string, string, string, string, string] {
  const kind = caller?.actorKind as string | undefined;
  const id = caller?.actorId as unknown;
  if (typeof kind !== 'string' || (!ID_ACTORS.has(kind) && !NO_ID_ACTORS.has(kind))) {
    throw new Error('audit context: unknown actor kind');
  }
  if (ID_ACTORS.has(kind) && !isUuid(id)) throw new Error(`audit context: the ${kind} actor needs its users.id`);
  if (NO_ID_ACTORS.has(kind) && id !== null && id !== undefined) throw new Error(`audit context: the ${kind} actor carries no id`);
  if (!(REQUEST_CHANNELS as readonly string[]).includes(caller.channel)) throw new Error('audit context: unknown channel');
  if (!SURFACES.has(surface) || !SURFACE_PATTERN.test(surface)) throw new Error('audit context: unknown surface');
  const requestId = typeof caller.requestId === 'string' && REQUEST_ID_PATTERN.test(caller.requestId)
    ? caller.requestId
    : '';
  return [kind, ID_ACTORS.has(kind) ? (id as string).toLowerCase() : '', caller.channel, surface, requestId];
}

/** States the actor for every covered write in the client's open transaction. */
export async function setAuditContext(client: AuditClient, caller: AuditCaller, surface: AuditSurface): Promise<void> {
  await client.query(SET_AUDIT_CONTEXT_SQL, auditContextValues(caller, surface));
}
