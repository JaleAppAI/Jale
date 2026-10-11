import type { AdminRole } from '../types';

/** Who a verified admin id token says the caller is. Not yet a session. */
export type AdminIdentity = {
  sub: string;
  email?: string;
  role: AdminRole;
  groups: string[];
};

/**
 * The signed-in admin for one request.
 *
 * A real session carries the server-side ids every access record names:
 * `sessionId` (admin_sessions.id), `adminUserId` (admin_users.id) and a fresh
 * `requestId` per request. The local-preview stand-in (development only) has
 * none of them and is marked `preview: true`; the audit helpers never write
 * an event for it, and refuse any other session that lacks the ids.
 */
export type AdminSession = AdminIdentity & (
  | {
      preview?: undefined;
      sessionId: string;
      adminUserId: string;
      requestId: string;
    }
  | {
      preview: true;
      sessionId?: undefined;
      adminUserId?: undefined;
      requestId?: undefined;
    }
);

export type AdminTokenClaims = {
  sub?: unknown;
  email?: unknown;
  'cognito:groups'?: unknown;
};

const ADMIN_ROLE_PRIORITY: AdminRole[] = ['admin_superadmin', 'admin_ops', 'admin_readonly'];
const ADMIN_ROLE_SET = new Set<AdminRole>(ADMIN_ROLE_PRIORITY);

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && ADMIN_ROLE_SET.has(value as AdminRole);
}

export function selectHighestAdminRole(groups: unknown): AdminRole | undefined {
  if (!Array.isArray(groups)) {
    return undefined;
  }

  return ADMIN_ROLE_PRIORITY.find((role) => groups.includes(role));
}

export function buildAdminSessionFromClaims(claims: AdminTokenClaims): AdminIdentity {
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!sub) {
    throw new Error('Admin token is missing subject');
  }

  const groups = Array.isArray(claims['cognito:groups'])
    ? claims['cognito:groups'].filter((group): group is string => typeof group === 'string')
    : [];
  const role = selectHighestAdminRole(groups);

  if (!role) {
    throw new Error('Admin token does not include an admin group');
  }

  const email = typeof claims.email === 'string' && claims.email.trim()
    ? claims.email.trim()
    : undefined;

  return {
    sub,
    email,
    role,
    groups,
  };
}

export function isLocalPreviewAllowed(
  nodeEnv: string | undefined,
  role: string | undefined,
  allowFlag: string | undefined,
): boolean {
  return nodeEnv === 'development' && allowFlag === 'true' && isAdminRole(role);
}
