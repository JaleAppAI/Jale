import { resolveCompanyEntitlements } from '../../../lambda/lib/entitlements';

function mockClient(rows: any[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as any;
}

describe('resolveCompanyEntitlements', () => {
  const ORG = 'org-uuid';
  const PRO = { active_job_limit: 10, template_limit: 20, foreman_seat_limit: 3 };

  test('resolves by organization_id, eligibility before recency', async () => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: PRO }]);
    const ent = await resolveCompanyEntitlements(client, ORG);
    expect(ent).toEqual({ planCode: 'employer_pro', activeJobLimit: 10, templateLimit: 20, foremanSeatLimit: 3 });
    const [sql, params] = client.query.mock.calls[0];
    expect(params).toEqual([ORG]);
    expect(sql).not.toMatch(/s\.user_id/);
    expect(sql).toMatch(/status IN \('active',\s*'trialing'\)/);
    expect(sql).toMatch(/status = 'past_due'\s+AND\s+s\.grace_ends_at > now\(\)/);
    const whereIdx = sql.search(/WHERE\s+s\.organization_id = \$1/);
    expect(whereIdx).toBeGreaterThan(-1);
    expect(sql.search(/ORDER BY s\.updated_at DESC/)).toBeGreaterThan(whereIdx);
    expect(sql).toMatch(/code = 'employer_free' AND active = true/);
  });

  test('falls back to the employer_free catalog row with no seats', async () => {
    const client = mockClient([{ plan_code: 'employer_free', entitlements: { active_job_limit: 1, template_limit: 2, foreman_seat_limit: 0 } }]);
    expect(await resolveCompanyEntitlements(client, ORG))
      .toEqual({ planCode: 'employer_free', activeJobLimit: 1, templateLimit: 2, foremanSeatLimit: 0 });
  });

  test.each([
    ['missing', { active_job_limit: 10, template_limit: 20 }],
    ['negative', { ...PRO, foreman_seat_limit: -1 }],
    ['fractional', { ...PRO, foreman_seat_limit: 1.5 }],
    ['null', { ...PRO, foreman_seat_limit: null }],
    ['an empty string', { ...PRO, foreman_seat_limit: '' }],
    ['a decimal string', { ...PRO, foreman_seat_limit: '3.0' }],
    ['a boolean', { ...PRO, foreman_seat_limit: true }],
  ])('throws billing_plan_catalog_invalid when foreman_seat_limit is %s', async (_name, entitlements) => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements }]);
    await expect(resolveCompanyEntitlements(client, ORG)).rejects.toThrow('billing_plan_catalog_invalid');
  });

  test.each([
    ['active_job_limit', 'missing', undefined],
    ['active_job_limit', 'negative', -1],
    ['active_job_limit', 'null', null],
    ['template_limit', 'missing', undefined],
    ['template_limit', 'negative', -1],
    ['template_limit', 'null', null],
  ])('throws billing_plan_catalog_invalid when %s is %s', async (key, _name, bad) => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { ...PRO, [key]: bad } }]);
    await expect(resolveCompanyEntitlements(client, ORG)).rejects.toThrow('billing_plan_catalog_invalid');
  });

  test('accepts a limit of 2147483647 (the PostgreSQL integer maximum)', async () => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { ...PRO, foreman_seat_limit: 2147483647 } }]);
    expect((await resolveCompanyEntitlements(client, ORG)).foremanSeatLimit).toBe(2147483647);
  });

  test.each([
    ['foreman_seat_limit', 2147483648],
    ['foreman_seat_limit', '2147483648'],
    ['active_job_limit', 2147483648],
    ['active_job_limit', '2147483648'],
    ['template_limit', 2147483648],
  ])('throws billing_plan_catalog_invalid when %s is above the integer maximum (%p)', async (key, big) => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { ...PRO, [key]: big } }]);
    await expect(resolveCompanyEntitlements(client, ORG)).rejects.toThrow('billing_plan_catalog_invalid');
  });

  test('accepts digit-string limits', async () => {
    const client = mockClient([{ plan_code: 'employer_pro', entitlements: { ...PRO, foreman_seat_limit: '3' } }]);
    expect((await resolveCompanyEntitlements(client, ORG)).foremanSeatLimit).toBe(3);
  });

  test('throws billing_plan_catalog_invalid when neither a subscription nor the free row resolves', async () => {
    await expect(resolveCompanyEntitlements(mockClient([]), ORG)).rejects.toThrow('billing_plan_catalog_invalid');
  });
});
