import { getAdminDbPool } from './db';
import type { AuditEvent } from '../types';

export type AuditEventRow = {
  id: string;
  created_at: Date | string;
  actor_email: string | null;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  pii_reveal: boolean;
  metadata: Record<string, unknown> | null;
};

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    at: asIso(row.created_at),
    actor: row.actor_email ?? row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    piiReveal: row.pii_reveal,
    summary: metadataString(row.metadata, 'summary')
      ?? `${row.actor_email ?? row.actor_role} performed ${row.action} on ${row.target_type} ${row.target_id}.`,
  };
}

export async function listAuditEvents(): Promise<AuditEvent[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<AuditEventRow>(
    `SELECT id, created_at, actor_email, actor_role, action, target_type,
            target_id, pii_reveal, metadata
       FROM admin_audit_log
      ORDER BY created_at DESC
      LIMIT 200`,
  );

  return result.rows.map(mapAuditEventRow);
}
