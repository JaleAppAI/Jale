const mockQuery = jest.fn();
const client: any = { query: mockQuery };

import { listEmployerApplicantsOverview } from '../../../../lambda/lib/employer-applicants-overview';
import { stageView } from '../../../../lambda/lib/application-stage-view';

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
    const overview = await listEmployerApplicantsOverview(client, [EMPLOYER]);
    expect(overview.total).toBe(3);
    expect(overview.applicants).toHaveLength(3);
    expect(overview.jobs).toEqual([
      { job_id: 'job-1', title: 'Line Cook', city: 'Austin', status: 'active' },
      { job_id: 'job-2', title: 'Dishwasher', city: 'Dallas', status: 'active' },
    ]);
  });

  it('scopes to the employer, excludes dismissed applicants, and joins the ranking cache in SQL', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerApplicantsOverview(client, [EMPLOYER]);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([[EMPLOYER]]);
    expect(sql).toMatch(/j\.employer_id = ANY\(\$1::uuid\[\]\)/);
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
    await listEmployerApplicantsOverview(client, [EMPLOYER]);
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
    const overview = await listEmployerApplicantsOverview(client, [EMPLOYER]);
    expect(overview.applicants[0]).toMatchObject({
      availability: 'weekends',
      years_experience: 9,
      trust_score: 64,
    });
  });

  it('keeps a never-assessed worker\'s trust_score null rather than zero', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([baseRow({ trust_score: null })]));
    const overview = await listEmployerApplicantsOverview(client, [EMPLOYER]);
    expect(overview.applicants[0].trust_score).toBeNull();
  });

  it("reads every job in the caller's scope through one uuid[] parameter", async () => {
    const FOREMAN = 'eeeeeeee-0000-0000-0000-000000000002';
    mockQuery.mockResolvedValueOnce(rowsResult([]));
    await listEmployerApplicantsOverview(client, [EMPLOYER, FOREMAN]);
    expect(mockQuery.mock.calls[0][1]).toEqual([[EMPLOYER, FOREMAN]]);
  });

  // F19 (K4.2): the overview row carries the same hire details and prompt
  // flag as the per-job list, from the same builder.
  it('publishes hire_details and hire_details_needed, and strips the raw hire columns', async () => {
    mockQuery.mockResolvedValueOnce(rowsResult([
      baseRow({ application_id: 'hired-with', application_status: 'hired', hire_start_date: null, hire_report_location: null,
        hire_contact_name: 'Site lead', hire_contact_phone: '+1 555 0100', hire_notes: null,
        hire_details_updated_at: new Date('2026-10-14T12:00:00.000Z') }),
      baseRow({ application_id: 'hired-without', application_status: 'hired' }),
      baseRow({ application_id: 'pending', application_status: 'pending' }),
    ]));
    const { applicants } = await listEmployerApplicantsOverview(client, [EMPLOYER]);
    expect(applicants.map((a: any) => [a.application_id, a.hire_details, a.hire_details_needed])).toEqual([
      ['hired-with', { start_date: null, report_location: null, contact_name: 'Site lead', contact_phone: '+1 555 0100',
        notes: null, updated_at: '2026-10-14T12:00:00.000Z' }, false],
      ['hired-without', null, true],
      ['pending', null, false],
    ]);
    expect(Object.prototype.hasOwnProperty.call(applicants[0], 'hire_contact_name')).toBe(false);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("to_char(ja.hire_start_date, 'YYYY-MM-DD') AS hire_start_date");
  });

  // ---------------------------------------------------------------------------
  // details_status: the same value the per-job applicants list publishes, so
  // the board's hire gate reads the same answer as the applicant page.
  // ---------------------------------------------------------------------------
  describe('details_status', () => {
    const REQUESTED_AT = new Date('2026-10-01T12:00:00.000Z');
    const COMPLETED_AT = new Date('2026-10-02T12:00:00.000Z');

    // The job's requirement columns and the application's stage inputs, as
    // the overview query selects them. One required field and one required
    // document, both outstanding unless an override supplies them.
    function stageRow(overrides: Record<string, unknown> = {}) {
      return baseRow({
        application_answers: {},
        prompt_answers: {},
        details_requested_at: null,
        details_completed_at: null,
        required_fields: ['years_experience'],
        optional_fields: [],
        required_docs: ['resume'],
        optional_docs: [],
        certification_requirements: [],
        pre_application_prompts: [],
        have_docs: [],
        ...overrides,
      });
    }

    const ROWS = {
      notRequested: stageRow({ application_id: 'not-requested' }),
      requested: stageRow({ application_id: 'requested', application_status: 'details_requested', details_requested_at: REQUESTED_AT }),
      // Requested, and the worker has supplied everything: the per-job list
      // reads this as complete before details_completed_at is stamped.
      requestedNothingLeft: stageRow({
        application_id: 'requested-nothing-left', application_status: 'details_requested',
        details_requested_at: REQUESTED_AT, application_answers: { years_experience: 4 }, have_docs: ['resume'],
      }),
      // Requested, the field is answered but the document is attached only in
      // the vault (not to this job), so it is still outstanding.
      requestedDocOutstanding: stageRow({
        application_id: 'requested-doc-outstanding', application_status: 'details_requested',
        details_requested_at: REQUESTED_AT, application_answers: { years_experience: 4 }, have_docs: [],
      }),
      completed: stageRow({
        application_id: 'completed', details_requested_at: REQUESTED_AT, details_completed_at: COMPLETED_AT,
      }),
      // Every requirement met but never requested: still not_requested.
      notRequestedNothingLeft: stageRow({
        application_id: 'not-requested-nothing-left', application_answers: { years_experience: 4 }, have_docs: ['resume'],
      }),
    };

    async function statusById(rows: Record<string, unknown>[]) {
      mockQuery.mockResolvedValueOnce(rowsResult(rows));
      const { applicants } = await listEmployerApplicantsOverview(client, [EMPLOYER]);
      return new Map(applicants.map((a: any) => [a.application_id, a.details_status]));
    }

    it('is not_requested when neither timestamp is set', async () => {
      const statuses = await statusById([ROWS.notRequested]);
      expect(statuses.get('not-requested')).toBe('not_requested');
    });

    it('is requested when details were requested and something is outstanding', async () => {
      const statuses = await statusById([ROWS.requested, ROWS.requestedDocOutstanding]);
      expect(statuses.get('requested')).toBe('requested');
      expect(statuses.get('requested-doc-outstanding')).toBe('requested');
    });

    it('is complete once details_completed_at is set', async () => {
      const statuses = await statusById([ROWS.completed]);
      expect(statuses.get('completed')).toBe('complete');
    });

    it('equals what the per-job applicants list derives for the same application', async () => {
      const rows = Object.values(ROWS);
      const statuses = await statusById(rows);
      expect(statuses.size).toBe(rows.length);
      for (const row of rows) {
        // The per-job list publishes stageView(row).details_status.
        expect([row.application_id, statuses.get(row.application_id as string)])
          .toEqual([row.application_id, stageView(row).details_status]);
      }
      // The case that needs the outstanding-items check, not only the
      // timestamps, to agree with the per-job list.
      expect(statuses.get('requested-nothing-left')).toBe(stageView(ROWS.requestedNothingLeft).details_status);
      expect(stageView(ROWS.requestedNothingLeft).details_status).toBe('complete');
    });

    it('selects the stage timestamps and the job-scoped document types in SQL', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([]));
      await listEmployerApplicantsOverview(client, [EMPLOYER]);
      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('ja.details_requested_at');
      expect(sql).toContain('ja.details_completed_at');
      expect(sql).toContain('ja.application_answers');
      expect(sql).toContain('ja.prompt_answers');
      expect(sql).toMatch(/j\.required_fields/);
      expect(sql).toMatch(/j\.pre_application_prompts/);
      expect(sql).toMatch(/j\.certification_requirements/);
      // Job-scoped, the same set the per-job list and the hire gate measure:
      // a vault-only document does not count.
      expect(sql).toContain('WHERE wd.worker_id = ja.worker_id');
      expect(sql).toContain('AND wd.job_id = ja.job_id');
      expect(sql).toContain('AS have_docs');
    });

    it('publishes details_status and none of the columns it is derived from', async () => {
      mockQuery.mockResolvedValueOnce(rowsResult([ROWS.requested]));
      const { applicants } = await listEmployerApplicantsOverview(client, [EMPLOYER]);
      const item = applicants[0] as Record<string, unknown>;
      expect(item.details_status).toBe('requested');
      for (const key of [
        'details_requested_at', 'details_completed_at', 'application_answers', 'prompt_answers', 'have_docs',
        'required_fields', 'optional_fields', 'required_docs', 'optional_docs', 'certification_requirements',
        'pre_application_prompts', 'stage', 'remaining',
      ]) {
        expect([key, Object.prototype.hasOwnProperty.call(item, key)]).toEqual([key, false]);
      }
    });
  });
});
