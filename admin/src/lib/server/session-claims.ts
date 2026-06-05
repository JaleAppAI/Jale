import type { AdminRole } from '../types';

export type AdminSession = {
  sub: string;
  email?: string;
  role: AdminRole;
  groups: string[];
};

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

export function buildAdminSessionFromClaims(claims: AdminTokenClaims): AdminSession {
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

export function isLocalPreviewAllowed(nodeEnv: string | undefined, role: string | undefined): boolean {
  return nodeEnv !== 'production' && isAdminRole(role);
}
