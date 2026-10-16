import { NextResponse } from 'next/server';
import { runAdminUserAction } from '@/lib/server/admin-users';
import { payloadHashMatches, readActionBody } from '@/lib/server/payload-hash';
import { adminApiUnauthorized, getAdminSessionState } from '@/lib/server/session';

// Contract K1.5 (sprint 28): the Admins page's actions (invite, resend the
// invitation, change role, deactivate, reactivate). Superadmins only; the
// session is checked first (K1.3: 401 `unauthorized`, or `session_expired`
// when the cookie's session has ended); then the body must carry its own
// SHA-256 in x-amz-content-sha256, checked as the Inbox actions check it
// (400 `invalid_input` otherwise); then the action answers with K1.5's
// status and body.
export async function POST(request: Request) {
  const state = await getAdminSessionState();
  if (!state.session) {
    return adminApiUnauthorized(state);
  }

  const text = await readActionBody(request);
  if (text === null || !payloadHashMatches(request, text)) {
    return NextResponse.json({ ok: false, error: 'invalid_input' }, { status: 400 });
  }

  const { status, body: result } = await runAdminUserAction(state.session, parseJson(text));
  return NextResponse.json(result, { status });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
