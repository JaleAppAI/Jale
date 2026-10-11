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
