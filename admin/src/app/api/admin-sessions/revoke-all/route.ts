import { NextResponse } from 'next/server';
import { AdminSessionStore } from '@/lib/server/admin-session-store';
import { isUuid } from '@/lib/server/audit/codes';
import { setAdminAuditContext } from '@/lib/server/audit/context';
import { recordAdminAction, recordAdminAttempt, type AdminAuditEvent } from '@/lib/server/audit/record';
import { getAdminDirectory } from '@/lib/server/cognito-admin';
import { getAdminDbPool } from '@/lib/server/db';
import { endAdminTrust, forgetAllDevices } from '@/lib/server/device-trust';
import { adminApiUnauthorized, getAdminSessionState } from '@/lib/server/session';

// Revoking an admin's sessions is recorded against that admin (admin_users.id).
function revokeEvent(targetAdminUserId?: string): AdminAuditEvent {
  return {
    surface: 'admin.sessions_revoke',
    categories: ['admin_access'],
    ...(targetAdminUserId ? { recordType: 'admin_user' as const, recordIds: [targetAdminUserId] } : {}),
  };
}

export async function POST(request: Request) {
  // K1.3: unauthorized without a cookie, session_expired when it has ended.
  const state = await getAdminSessionState();
  if (!state.session) {
    return adminApiUnauthorized(state);
  }
  const { session } = state;
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

  // Signing out everywhere also ends every trusted browser (contract K1.2).
  // The sessions are revoked first, so this step never blocks that. The rows
  // end in the database before the pool forgets the devices: the sign-in
  // check reads the rows, so a Cognito failure never leaves a browser
  // trusted, and a retry finishes the pool's side.
  try {
    await endAdminTrust(pool, adminUserId, 'signed_out_everywhere');
  } catch (error) {
    await recordAdminAttempt(session, { ...revokeEvent(adminUserId), resultCount: 0, outcome: 'failed' });
    throw error;
  }
  try {
    // The pool user is named by its sign-in id, never by the stored email
    // (the pool's usernames are case-sensitive). A row with no sign-in id has
    // no pool user to reach.
    const { rows } = await pool.query<{ cognito_sub: string | null }>(
      'SELECT cognito_sub FROM admin_users WHERE id = $1',
      [adminUserId],
    );
    const username = rows[0]?.cognito_sub?.trim();
    if (username) {
      await forgetAllDevices(getAdminDirectory(), username);
    }
  } catch {
    await recordAdminAttempt(session, { ...revokeEvent(adminUserId), resultCount: 0, outcome: 'failed' });
    return NextResponse.json(
      { ok: false, error: 'directory_sync_failed', saved: true, revokedCount },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, revokedCount });
}
