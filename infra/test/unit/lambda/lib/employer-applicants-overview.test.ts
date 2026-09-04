const mockQuery = jest.fn();
const client: any = { query: mockQuery };

import { listEmployerApplicantsOverview } from '../../../../lambda/lib/employer-applicants-overview';

const EMPLOYER = 'eeeeeeee-0000-0000-0000-000000000001';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    application_id: 'app-1',
    worker_id: 'w-1',
    worker_name: 'Maria Garcia',
    job_id: 'job-1',
    job_title: 'Line Cook',
    job_city: 'Austin',
    job_status: 'active',
    application_status: 'pending',
    applied_at: '2026-08-30T00:00:00Z',
    skills: ['grill', 'prep'],
    availability: 'weekdays',
    years_experience: 4,
    match_score: 72,
    score_band: 'strong',
    trust_score: 78,
    ...overrides,
  };
}

function rowsResult(rows: any[]) {
  return { rows, rowCount: rows.length };
}

describe('listEmployerApplicantsOverview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns applicants with a total and a deduped jobs facet', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([
      baseRow(),
      baseRow({ application_id: 'app-2', worker_id: 'w-2', job_id: 'job-2', job_title: 'Dishwasher', job_city: 'Dallas', match_score: null, score_band: null }),
      baseRow({ application_id: 'app-3', worker_id: 'w-3' }),
    ]));
    const overview = await listEmployerApplicantsOverview(client, EMPLOYER);
    expect(overview.total).toBe(3);
    expect(overview.applicants).toHaveLength(3);
    expect(overview.jobs).toEqual([
      { job_id: 'job-1', title: 'Line Cook', city: 'Austin', status: 'active' },
      { job_id: 'job-2', title: 'Dishwasher', city: 'Dallas', status: 'active' },
    ]);
  });

  it('scopes to the employer, excludes dismissed applicants, and joins the ranking cache in SQL', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerApplicantsOverview(client, EMPLOYER);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([EMPLOYER]);
    expect(sql).toMatch(/j\.employer_id = \$1/);
    expect(sql).toMatch(/ja\.status NOT IN \('not_interested', 'rejected'\)/);
    expect(sql).toMatch(/LEFT JOIN employer_candidate_rankings ecr/);
    expect(sql).toMatch(/j\.city AS job_city/);
    expect(sql).toMatch(/ORDER BY ja\.applied_at DESC/);
  });
  // ---------------------------------------------------------------------------
  // B8 (sprint 24) -- the qualifications the row needs to show. availability /
  // years_experience / match_score were already selected; trust_score was the
  // one field the per-job surface had and this one did not.
  // ---------------------------------------------------------------------------

  it("selects the worker's trust score the same way the per-job ranking query does", async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerApplicantsOverview(client, EMPLOYER);
    const [sql] = mockQuery.mock.calls[0];
    // users.trade_competency_score (012:122, INTEGER 0..100) aliased to
    // trust_score -- the same expression employer-candidate-ranking.ts:338
    // uses, so the two surfaces can never show different numbers.
    expect(sql).toMatch(/u\.trade_competency_score AS trust_score/);
  });

  it('passes availability, years_experience and trust_score straight through to the row', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([
      baseRow({ availability: 'weekends', years_experience: 9, trust_score: 64 }),
    ]));
    const overview = await listEmployerApplicantsOverview(client, EMPLOYER);
    expect(overview.applicants[0]).toMatchObject({
      availability: 'weekends',
      years_experience: 9,
      trust_score: 64,
    });
  });

  it('keeps a never-assessed worker\'s trust_score null rather than zero', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([baseRow({ trust_score: null })]));
    const overview = await listEmployerApplicantsOverview(client, EMPLOYER);
    expect(overview.applicants[0].trust_score).toBeNull();
  });
});
