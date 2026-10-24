import { readCompanyUsage, CompanyUsageRefusedError } from '../../../../lambda/lib/company-usage';

const ORG = '33333333-3333-4333-8333-333333333333';

function clientWith(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as import('pg').PoolClient & { query: jest.Mock };
}

const ROW = { organization_id: ORG, active_jobs: 3, templates: 2, active_foremen: 1, suspended_foremen: 1, pending_invites: 0 };

describe('readCompanyUsage', () => {
  it('reads the caller\'s company usage through the definer, without the lock by default', async () => {
    const client = clientWith([ROW]);
    expect(await readCompanyUsage(client)).toEqual({
      organizationId: ORG, activeJobs: 3, templates: 2, activeForemen: 1, suspendedForemen: 1, pendingInvites: 0,
    });
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toContain('FROM jale_cap.employer_org_usage($1)');
    expect(params).toEqual([false]);
  });

  it('reads pending_invites strictly', async () => {
    const client = clientWith([{ ...ROW, pending_invites: '2' }]);
    expect((await readCompanyUsage(client)).pendingInvites).toBe(2);
    expect(String(client.query.mock.calls[0][0])).toMatch(/\bpending_invites\b/);
    await expect(readCompanyUsage(clientWith([{ ...ROW, pending_invites: null }]))).rejects.toThrow('company_usage_unavailable');
    const { pending_invites: _omitted, ...withoutPending } = ROW;
    await expect(readCompanyUsage(clientWith([withoutPending]))).rejects.toThrow('company_usage_unavailable');
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

  const dbError = (message: string, code: string) => Object.assign(new Error(message), { code });
  const failingClient = (err: unknown) => ({ query: jest.fn().mockRejectedValue(err) }) as never;

  it('maps the definer\'s not-an-active-member refusal (42501) to CompanyUsageRefusedError', async () => {
    const err = dbError('employer_org_usage: the caller is not an active member of a company', '42501');
    const thrown = await readCompanyUsage(failingClient(err), { lock: true }).catch((e) => e);
    expect(thrown).toBeInstanceOf(CompanyUsageRefusedError);
  });

  it.each([
    ['the caller context is not set', dbError('employer_org_usage: the caller context is not set', '42501')],
    ['the company row is missing', dbError('employer_org_usage: the company row is missing', '42501')],
    ['an RLS violation', dbError('new row violates row-level security policy', '42501')],
    ['the not-a-member text under another code', dbError('the caller is not an active member of a company', 'P0001')],
    ['a lock timeout', dbError('canceling statement due to lock timeout', '55P03')],
  ])('rethrows %s unchanged', async (_name, err) => {
    const thrown = await readCompanyUsage(failingClient(err)).catch((e) => e);
    expect(thrown).toBe(err);
    expect(thrown).not.toBeInstanceOf(CompanyUsageRefusedError);
  });
});
