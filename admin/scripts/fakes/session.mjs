// Fake for src/lib/server/session.ts in the admin check scripts: the session
// comes from globalThis.__adminCheck.session (undefined means signed out).
export async function getCurrentAdminSession() {
  return globalThis.__adminCheck?.session ?? undefined;
}

export async function requireAdminSession() {
  const session = await getCurrentAdminSession();
  if (!session) {
    throw new Error('fake session: no admin session (the real helper redirects to /login)');
  }
  return session;
}

// The K1.3 helpers the API routes use: the state names whether the request
// carried a session cookie (globalThis.__adminCheck.hadCookie).
export async function getAdminSessionState() {
  const session = await getCurrentAdminSession();
  return { session, hadCookie: Boolean(globalThis.__adminCheck?.hadCookie) };
}

export function adminApiUnauthorized(state) {
  return Response.json({ error: state.hadCookie ? 'session_expired' : 'unauthorized' }, { status: 401 });
}
