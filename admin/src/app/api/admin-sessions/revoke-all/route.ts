import { NextResponse } from 'next/server';
import { AdminSessionStore } from '@/lib/server/admin-session-store';
import { getAdminDbPool } from '@/lib/server/db';
import { getCurrentAdminSession } from '@/lib/server/session';

export async function POST(request: Request) {
  const session = await getCurrentAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin_superadmin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => undefined);
  const adminUserId = typeof body?.adminUserId === 'string' ? body.adminUserId.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(adminUserId)) {
    return NextResponse.json({ error: 'invalid_admin_user_id' }, { status: 400 });
  }

  const pool = await getAdminDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revokedCount = await new AdminSessionStore(client).revokeAllForAdmin(
      adminUserId,
      'superadmin_revocation',
    );
    await client.query(
      `INSERT INTO admin_audit_log
        (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
       VALUES ($1, $2, 'revoke_admin_sessions', 'admin_user', $3, false, $4::jsonb)`,
      [
        session.email,
        session.role,
        adminUserId,
        JSON.stringify({ revokedCount }),
      ],
    );
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, revokedCount });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
