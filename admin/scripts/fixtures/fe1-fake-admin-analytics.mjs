// Test-only stand-in for the K3.4 loaders of src/lib/server/admin-analytics.ts
// in the FE-1 checks. Tracked like the admin-inbox fake, so a check can
// assert Home's query waves.
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

export function getHomeMetrics() {
  return tracked('getHomeMetrics', (check) => {
    if (check.metricsError) throw check.metricsError;
    return check.metrics;
  });
}

export function getSystemHealth() {
  return tracked('getSystemHealth', (check) => {
    if (check.healthError) throw check.healthError;
    return check.health;
  });
}

// Phase 5: the company loaders. A check sets globalThis.__adminCheck.companies
// (rows) and .company ({ company, members }); every load is recorded.
export function loadCompanies() {
  return tracked('loadCompanies', (check) => check.companies ?? []);
}

export function loadCompany(_session, organizationId) {
  return tracked('loadCompany', (check) => {
    (check.companyLoads ??= []).push(organizationId);
    return check.company ?? { company: null, members: [] };
  });
}
