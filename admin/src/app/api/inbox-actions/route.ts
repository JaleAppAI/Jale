import { handleInboxActionRequest } from '@/lib/server/inbox-actions';
import { adminApiUnauthorized, getAdminSessionState } from '@/lib/server/session';

// Contract K2.7 (sprint 28): the Inbox actions. BE-2b owns this route.
// The K1.3 session check first (401 `unauthorized`, or `session_expired`
// when the cookie's session has ended); the actions, their role checks and
// their records are in lib/server/inbox-actions.ts.
export async function POST(request: Request): Promise<Response> {
  const state = await getAdminSessionState();
  if (!state.session) {
    return adminApiUnauthorized(state);
  }

  return handleInboxActionRequest(request, state.session);
}
