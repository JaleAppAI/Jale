import { randomUUID } from 'node:crypto';
import type { AdminRole } from '../../types';
import { isAdminRole, type AdminSession } from '../session-claims';
import { REQUEST_ID_PATTERN, isUuid } from './codes';

export type AdminAuditActor = {
  actor_kind: 'admin';
  actor_id: string;
  actor_role: AdminRole;
  actor_session?: string;
};

export type AnonymousAuditActor = { actor_kind: 'anonymous' };

export const ANONYMOUS_ACTOR: AnonymousAuditActor = { actor_kind: 'anonymous' };

/**
 * The actor every admin event names: admin_users.id, the role, and the
 * admin_sessions.id, all from the server-side session. A session
 * without them is refused, so a missing id can never become an unattributed
 * record. Callers handle the preview session before calling this.
 */
export function adminActorFor(session: AdminSession | null | undefined): AdminAuditActor {
  if (
    !session
    || session.preview
    || !isUuid(session.adminUserId)
    || !isUuid(session.sessionId)
    || !isAdminRole(session.role)
  ) {
    throw new Error('audit: the admin session has no server-side ids');
  }
  return {
    actor_kind: 'admin',
    actor_id: session.adminUserId.toLowerCase(),
    actor_role: session.role,
    actor_session: session.sessionId.toLowerCase(),
  };
}

/** The request's id when it is well formed, otherwise a fresh one. */
export function requestIdFor(candidate: string | undefined): string {
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}
