// Test-only stand-in for src/lib/server/admin-inbox.ts (K2.1, K2.2) in the
// FE-1 checks. State comes from globalThis.__adminCheck; every call is
// tracked so a check can assert the page's query waves.
async function tracked(name, read) {
  const check = (globalThis.__adminCheck ??= {});
  check.calls ??= [];
  check.inflight = (check.inflight ?? 0) + 1;
  check.maxInflight = Math.max(check.maxInflight ?? 0, check.inflight);
  check.calls.push(name);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return read(check);
  } finally {
    check.inflight -= 1;
  }
}

export function getInboxCounts(session) {
  return tracked('getInboxCounts', (check) => {
    check.countsSession = session;
    if (check.countsError) throw check.countsError;
    return check.counts ?? null;
  });
}

export function loadRecentActivity(session, limit) {
  return tracked('loadRecentActivity', (check) => {
    check.activityArgs = [session, limit];
    if (check.activityError) throw check.activityError;
    return check.activity ?? [];
  });
}
