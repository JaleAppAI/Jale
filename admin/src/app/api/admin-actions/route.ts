import { NextResponse } from 'next/server';
import { parseAdminActionRequest } from '@/lib/action-requests';
import { dispatchAdminAction } from '@/lib/server/admin-action-dispatch';
import { getCurrentAdminSession } from '@/lib/server/session';

export async function POST(request: Request) {
  const session = await getCurrentAdminSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized', message: 'Admin session expired.' }, { status: 401 });
  }

  const parsed = parseAdminActionRequest(await request.json().catch(() => undefined));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, message: 'Invalid admin action request.' }, { status: 400 });
  }

  const result = await dispatchAdminAction(session, parsed.value);
  return NextResponse.json(result, { status: result.ok ? 200 : result.status });
}
