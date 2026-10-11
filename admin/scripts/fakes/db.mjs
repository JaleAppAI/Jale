// Fake for src/lib/server/db.ts in the admin check scripts: the pool comes
// from globalThis.__adminCheck.pool (see scripts/lib/check-harness.mjs).
export function getAdminDbPool() {
  const pool = globalThis.__adminCheck?.pool;
  if (!pool) {
    return Promise.reject(new Error('fake db: no pool configured for this check'));
  }
  if (pool instanceof Error) {
    return Promise.reject(pool);
  }
  return Promise.resolve(pool);
}
