import { readCompanyUsage } from '../../../../lambda/lib/company-usage';

const ORG = '33333333-3333-4333-8333-333333333333';

function clientWith(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as import('pg').PoolClient & { query: jest.Mock };
}

const ROW = { organization_id: ORG, active_jobs: 3, templates: 2, active_foremen: 1, suspended_foremen: 1 };

describe('readCompanyUsage', () => {
  it('reads the caller\'s company usage through the definer, without the lock by default', async () => {
    const client = clientWith([ROW]);
    expect(await readCompanyUsage(client)).toEqual({
      organizationId: ORG, activeJobs: 3, templates: 2, activeForemen: 1, suspendedForemen: 1,
    });
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toContain('FROM jale_cap.employer_org_usage($1)');
    expect(params).toEqual([false]);
  });

  it('accepts digit-string counts (pg bigint)', async () => {
    const usage = await readCompanyUsage(clientWith([{ ...ROW, active_jobs: '3' }]));
    expect(usage.activeJobs).toBe(3);
  });

  it('asks for the company lock with { lock: true }', async () => {
    const client = clientWith([ROW]);
    await readCompanyUsage(client, { lock: true });
    expect(client.query.mock.calls[0][1]).toEqual([true]);
  });

  it.each([
    ['no row', []],
    ['a negative count', [{ ...ROW, active_jobs: -1 }]],
    ['a non-integer count', [{ ...ROW, templates: 'x' }]],
    ['a null count', [{ ...ROW, active_foremen: null }]],
    ['an empty-string count', [{ ...ROW, suspended_foremen: '' }]],
    ['a boolean count', [{ ...ROW, templates: true }]],
    ['a null organization_id', [{ ...ROW, organization_id: null }]],
  ])('throws company_usage_unavailable on %s', async (_name, rows) => {
    await expect(readCompanyUsage(clientWith(rows))).rejects.toThrow('company_usage_unavailable');
  });

  it('lets the database refusal through (an inactive or unset caller)', async () => {
    const client = { query: jest.fn().mockRejectedValue(Object.assign(new Error('not an active member'), { code: '42501' })) } as never;
    await expect(readCompanyUsage(client)).rejects.toMatchObject({ code: '42501' });
  });
});
