import { NextResponse } from 'next/server';
import { AdminSessionStore } from '@/lib/server/admin-session-store';
import { isUuid } from '@/lib/server/audit/codes';
import { setAdminAuditContext } from '@/lib/server/audit/context';
import { recordAdminAction, recordAdminAttempt, type AdminAuditEvent } from '@/lib/server/audit/record';
import { getAdminDbPool } from '@/lib/server/db';
import { getCurrentAdminSession } from '@/lib/server/session';

// Revoking an admin's sessions is recorded against that admin (admin_users.id).
function revokeEvent(targetAdminUserId?: string): AdminAuditEvent {
  return {
    surface: 'admin.sessions_revoke',
    categories: ['admin_access'],
    ...(targetAdminUserId ? { recordType: 'admin_user' as const, recordIds: [targetAdminUserId] } : {}),
  };
}

export async function POST(request: Request) {
  const session = await getCurrentAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin_superadmin') {
    await recordAdminAttempt(session, { ...revokeEvent(), outcome: 'denied' });
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => undefined);
  const adminUserId = typeof body?.adminUserId === 'string' ? body.adminUserId.trim() : '';
  if (!isUuid(adminUserId)) {
    return NextResponse.json({ error: 'invalid_admin_user_id' }, { status: 400 });
  }

  const pool = await getAdminDbPool();
  const client = await pool.connect();
  let revokedCount = 0;
  let failed = false;
  let failure: unknown;
  try {
    await client.query('BEGIN');
    await setAdminAuditContext(client, session, 'admin.sessions_revoke');
    revokedCount = await new AdminSessionStore(client).revokeAllForAdmin(
      adminUserId,
      'superadmin_revocation',
    );
    await recordAdminAction(session, { ...revokeEvent(adminUserId), resultCount: revokedCount }, client);
    await client.query('COMMIT');
  } catch (error) {
    failed = true;
    failure = error;
    await client.query('ROLLBACK').catch(() => undefined);
  } finally {
    client.release();
  }

  if (failed) {
    await recordAdminAttempt(session, { ...revokeEvent(adminUserId), resultCount: 0, outcome: 'failed' });
    throw failure;
  }
  return NextResponse.json({ ok: true, revokedCount });
}
