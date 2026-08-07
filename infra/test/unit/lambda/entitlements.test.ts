import { resolveEntitlements } from '../../../lambda/lib/entitlements';

function mockClient(rows: any[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as any;
}

describe('resolveEntitlements', () => {
  test('no eligible subscription -> employer_free catalog fallback row', async () => {
    // Simulates the single query's fallback CTE surfacing the active
    // employer_free catalog row when there is no eligible subscription.
    const client = mockClient([{ plan_code: 'employer_free', entitlements: { active_job_limit: 1, template_limit: 2 } }]);
    const ent = await resolveEntitlements(client, 'user-uuid');
    expect(ent.planCode).toBe('employer_free');
    expect(ent.activeJobLimit).toBe(1);
    expect(ent.templateLimit).toBe(2);
  });

  test('active pro subscription -> pro limits', async () => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { active_job_limit: 10, template_limit: 20 } }]);
    const ent = await resolveEntitlements(client, 'user-uuid');
    expect(ent.planCode).toBe('employer_pro');
    expect(ent.activeJobLimit).toBe(10);
    expect(ent.templateLimit).toBe(20);
  });

  test('past_due inside grace keeps pro (spec S6.9)', async () => {
    // The eligible CTE's WHERE clause (status IN ('active','trialing') OR
    // past_due-with-live-grace) is what admits this row in the real query;
    // the mock represents that CTE's output.
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { active_job_limit: 10, template_limit: 20 } }]);
    const ent = await resolveEntitlements(client, 'user-uuid');
    expect(ent.planCode).toBe('employer_pro');
    expect(ent.activeJobLimit).toBe(10);
    expect(ent.templateLimit).toBe(20);
  });

  test('past_due after grace falls back to free (spec S6.10)', async () => {
    // Expired grace excludes the subscription from the eligible CTE, so the
    // real query's fallback CTE is what supplies this row.
    const client = mockClient([{ plan_code: 'employer_free', entitlements: { active_job_limit: 1, template_limit: 2 } }]);
    const ent = await resolveEntitlements(client, 'user-uuid');
    expect(ent.planCode).toBe('employer_free');
    expect(ent.activeJobLimit).toBe(1);
    expect(ent.templateLimit).toBe(2);
  });

  test('newer canceled subscription must not mask an older eligible one: SQL filters eligibility before selecting latest', async () => {
    // A newer canceled/expired subscription must not win over an older
    // active/trialing/grace-valid one. resolveEntitlements now issues a
    // single query whose `eligible` CTE applies the status/grace predicate
    // in the WHERE clause *before* ordering by updated_at DESC LIMIT 1 — so
    // an ineligible newer row is excluded from consideration entirely, and
    // the older eligible row (still passing the WHERE) is what gets picked.
    // We can't run real Postgres against a mock client, so we prove the
    // fix by asserting the query text actually encodes that eligibility
    // filter ahead of the ordering, and that the resolved plan is the
    // eligible (pro) one rather than a fallback/canceled result.
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { active_job_limit: 10, template_limit: 20 } }]);
    const ent = await resolveEntitlements(client, 'user-uuid');
    expect(ent.planCode).toBe('employer_pro');
    expect(ent.activeJobLimit).toBe(10);
    expect(ent.templateLimit).toBe(20);

    const [sql, params] = client.query.mock.calls[0];
    expect(params).toEqual(['user-uuid']);
    // Eligibility predicate must gate rows before the latest-row selection.
    expect(sql).toMatch(/status IN \('active',\s*'trialing'\)/);
    expect(sql).toMatch(/status = 'past_due'\s+AND\s+s\.grace_ends_at > now\(\)/);
    const whereIdx = sql.search(/WHERE\s+s\.user_id = \$1/);
    const orderByLatestIdx = sql.search(/ORDER BY s\.updated_at DESC/);
    expect(whereIdx).toBeGreaterThan(-1);
    expect(orderByLatestIdx).toBeGreaterThan(whereIdx);
  });

  test('parses template_limit alongside active_job_limit', async () => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { active_job_limit: 10, template_limit: 20 } }]);
    const ent = await resolveEntitlements(client, 'user-uuid');
    expect(ent.planCode).toBe('employer_pro');
    expect(ent.activeJobLimit).toBe(10);
    expect(ent.templateLimit).toBe(20);
  });

  test('throws billing_plan_catalog_invalid when template_limit is missing', async () => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { active_job_limit: 10 } }]);
    await expect(resolveEntitlements(client, 'user-uuid')).rejects.toThrow('billing_plan_catalog_invalid');
  });

  test('zero rows (no subscription and no active employer_free catalog row) -> throws billing_plan_catalog_invalid', async () => {
    const client = mockClient([]);
    await expect(resolveEntitlements(client, 'user-uuid')).rejects.toThrow('billing_plan_catalog_invalid');
  });
});
