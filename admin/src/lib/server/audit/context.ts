// The change-log audit context. Five settings that
// jale_audit.capture_change copies into each change record a write leaves:
// who wrote, from which channel and surface, in which request. They are set
// transaction-locally (set_config's third argument, true), in one statement,
// right after BEGIN in each admin transaction that writes a table the change
// log covers (the case actions today), so they end with it and never carry
// over to another use of the pooled connection. The report actions write no
// covered table and set none; a report table that becomes covered needs the
// call right after BEGIN in those actions too.
//
// The local preview has no admin id, so it sets none, and its writes are
// recorded under the database login alone.
import type { AdminSession } from '../session-claims';
import { adminActorFor, requestIdFor } from './actor';
import { ADMIN_SURFACES, AUDIT_CHANNEL, type AdminSurface } from './codes';
import type { AuditQueryClient } from './record';

export const SET_AUDIT_CONTEXT_SQL = `SELECT set_config('app.audit_actor_kind', $1, true),
       set_config('app.audit_actor_id', $2, true),
       set_config('app.audit_channel', $3, true),
       set_config('app.audit_surface', $4, true),
       set_config('app.audit_request_id', $5, true)`;

/** Sets the audit context for the rest of the client's open transaction. */
export async function setAdminAuditContext(
  client: AuditQueryClient,
  session: AdminSession,
  surface: AdminSurface,
): Promise<void> {
  if (session?.preview === true) {
    return;
  }
  if (!(ADMIN_SURFACES as readonly string[]).includes(surface)) {
    throw new Error('audit: invalid surface');
  }
  const actor = adminActorFor(session);
  await client.query(SET_AUDIT_CONTEXT_SQL, [
    actor.actor_kind,
    actor.actor_id,
    AUDIT_CHANNEL,
    surface,
    requestIdFor(session.requestId),
  ]);
}
