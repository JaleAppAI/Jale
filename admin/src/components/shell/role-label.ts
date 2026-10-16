import type { AdminRole } from '@/lib/types';

// K1.4 fixed copy.
const ROLE_LABELS = {
  admin_readonly: 'Read-only',
  admin_ops: 'Ops',
  admin_superadmin: 'Superadmin',
} as const satisfies Record<AdminRole, string>;

export function roleLabel(role: AdminRole): 'Read-only' | 'Ops' | 'Superadmin' {
  return ROLE_LABELS[role];
}
