import {
  buildEmployerCandidateSourceHash,
  listEmployerCandidates,
  sanitizeCandidateForLlm,
  scoreBandForMatch,
} from '../../../../lambda/lib/employer-candidate-ranking';

const makeClient = (query: jest.Mock) => ({ query }) as any;

describe('employer candidate ranking', () => {
  it('maps scores to score bands', () => {
    expect(scoreBandForMatch(70)).toBe('strong');
    expect(scoreBandForMatch(45)).toBe('good');
    expect(scoreBandForMatch(44)).toBe('fair');
  });

  it('ranks applied workers by trust score and relevant skills', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          title: 'Electrician for panel wiring',
          location: 'Houston',
          job_type: 'full-time',
          description: 'Need panels, conduit, wiring, and safety experience.',
          required_docs: ['resume'],
          created_at: '2026-05-10T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            application_id: 'app-low',
            worker_id: 'worker-low',
            full_name: 'Painter',
            phone: '+15550000002',
            status: 'submitted',
            applied_at: '2026-05-11T00:00:00.000Z',
            skills: ['paint'],
            profile_skills: [],
            bio: 'Interior repainting and prep.',
            location: 'Houston',
            availability: 'part_time',
            profile_years_experience: 3,
            main_trade: 'painting',
            main_trade_other: null,
            user_years_experience: '2-4',
            user_availability: 'part_time',
            city: 'Houston',
            trust_score: 30,
          },
          {
            application_id: 'app-high',
            worker_id: 'worker-high',
            full_name: 'Electrician',
            phone: '+15550000001',
            status: 'submitted',
            applied_at: '2026-05-12T00:00:00.000Z',
            skills: ['conduit', 'panels', 'wiring'],
            profile_skills: [],
            bio: 'Commercial panel wiring and conduit installs.',
            location: 'Houston',
            availability: 'full_time',
            profile_years_experience: 10,
            main_trade: 'electrician',
            main_trade_other: null,
            user_years_experience: '10+',
            user_availability: 'full_time',
            city: 'Houston',
            trust_score: 94,
          },
        ],
      })
      // Dedicated COUNT query for the true applicant total.
      .mockResolvedValueOnce({ rows: [{ total: '2' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await listEmployerCandidates(makeClient(query), 'job-1', { limit: 10 });

    expect(result.response.ranking_status).toBe('deterministic');
    expect(result.response.ranking_version).toBe('sql-v1');
    expect(result.response.total).toBe(2);
    expect(result.shouldEnqueueRerank).toBe(true);
    expect(result.response.candidates[0]).toMatchObject({
      application_id: 'app-high',
      worker_id: 'worker-high',
      trust_score: 94,
      score_band: 'strong',
    });
    expect(result.response.candidates[0].match_score).toBeGreaterThan(result.response.candidates[1].match_score);
    expect(result.response.candidates[0].match_reasons).toEqual(expect.arrayContaining([
      'High trust score',
      'Trade match',
      'Relevant skills: conduit, panels, wiring',
    ]));
  });

  it('reports the true applicant total even when applicants exceed the shortlist cap', async () => {
    const makeRow = (i: number) => ({
      application_id: `app-${i}`,
      worker_id: `worker-${i}`,
      full_name: `Worker ${i}`,
      phone: null,
      status: 'submitted',
      applied_at: '2026-05-11T00:00:00.000Z',
      skills: ['paint'],
      profile_skills: [],
      bio: '',
      location: 'Houston',
      availability: 'part_time',
      profile_years_experience: 3,
      main_trade: 'painting',
      main_trade_other: null,
      user_years_experience: '2-4',
      user_availability: 'part_time',
      city: 'Houston',
      trust_score: 30,
    });

    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          title: 'Painter',
          location: 'Houston',
          job_type: 'full-time',
          description: 'Need painting help.',
          required_docs: [],
          created_at: '2026-05-10T00:00:00.000Z',
        }],
      })
      // Shortlist query is capped (LIMIT shortlistLimit), so it only returns
      // a subset of the true applicant pool.
      .mockResolvedValueOnce({
        rows: Array.from({ length: 5 }, (_, i) => makeRow(i)),
      })
      // Dedicated COUNT query reports the true, uncapped applicant total.
      .mockResolvedValueOnce({ rows: [{ total: '400' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await listEmployerCandidates(makeClient(query), 'job-1', { limit: 10 });

    expect(result.response.total).toBe(400);
    expect(result.response.candidates.length).toBeLessThanOrEqual(10);
  });

  it('does not query raw trust answers or trust rationale', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          title: 'Electrician',
          location: 'Houston',
          job_type: 'full-time',
          description: 'panels',
          required_docs: [],
          created_at: '2026-05-10T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await listEmployerCandidates(makeClient(query), 'job-1', { limit: 10 });

    const sql = query.mock.calls.map(([text]) => String(text)).join('\n');
    expect(sql).toContain('trade_competency_score');
    expect(sql).not.toContain('worker_trust_assessments');
    expect(sql).not.toContain('trust_signals');
    expect(sql).not.toContain('score_rationale');
    expect(sql).not.toContain('answers');
  });

  it('does not select applicant contact fields or raw bio unless explicitly requested', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          title: 'Electrician',
          location: 'Houston',
          job_type: 'full-time',
          description: 'panels',
          required_docs: [],
          created_at: '2026-05-10T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await listEmployerCandidates(makeClient(query), 'job-1', { limit: 10 });

    const candidateSql = String(query.mock.calls[1][0]);
    expect(candidateSql).toContain('NULL::text AS full_name');
    expect(candidateSql).toContain('NULL::text AS phone');
    expect(candidateSql).not.toContain('COALESCE(wp.full_name');
    expect(candidateSql).not.toContain('COALESCE(wp.phone');
    expect(candidateSql).not.toMatch(/\bwp\.bio\b/);
    expect(candidateSql).not.toContain('worker_documents');
  });

  it('changes source hash when candidate skills change', () => {
    const base = {
      job: { id: 'job-1', title: 'Electrician', description: 'panels' },
      candidates: [{ worker_id: 'w1', score: 80, skills: ['panels'] }],
    };

    expect(buildEmployerCandidateSourceHash(base)).not.toBe(
      buildEmployerCandidateSourceHash({
        ...base,
        candidates: [{ worker_id: 'w1', score: 80, skills: ['drywall'] }],
      }),
    );
  });

  it('uses fresh matching cache when source hash matches', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          title: 'Electrician',
          location: 'Houston',
          job_type: 'full-time',
          description: 'panels',
          required_docs: [],
          created_at: '2026-05-10T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            application_id: 'app-1',
            worker_id: 'worker-1',
            full_name: 'First',
            phone: null,
            status: 'submitted',
            applied_at: '2026-05-11T00:00:00.000Z',
            skills: ['panels'],
            profile_skills: [],
            bio: '',
            location: 'Houston',
            availability: 'full_time',
            profile_years_experience: 5,
            main_trade: 'electrician',
            main_trade_other: null,
            user_years_experience: '5-9',
            user_availability: 'full_time',
            city: 'Houston',
            trust_score: 80,
          },
        ],
      })
      // Dedicated COUNT query for the true applicant total.
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({
        rows: [{
          worker_id: 'worker-1',
          score: 96,
          score_band: 'strong',
          reasons: ['LLM reason'],
          computed_at: '2026-05-15T00:00:00.000Z',
        }],
      });

    const result = await listEmployerCandidates(makeClient(query), 'job-1', { limit: 10 });

    expect(result.response.ranking_status).toBe('llm_cached');
    expect(result.response.ranking_version).toBe('llm-v1');
    expect(result.response.candidates[0].match_score).toBe(96);
    expect(result.response.candidates[0].match_reasons).toEqual(['LLM reason']);
    expect(result.shouldEnqueueRerank).toBe(false);
  });

  it('redacts contact and raw profile fields from LLM payloads', () => {
    const sanitized = sanitizeCandidateForLlm({
      application_id: 'app-1',
      worker_id: 'worker-1',
      display_name: 'Worker',
      phone: '+15550000001',
      status: 'submitted',
      applied_at: '2026-05-14T00:00:00.000Z',
      skills: ['wiring'],
      availability: 'full_time',
      years_experience: 5,
      location: 'Houston',
      trust_score: 91,
      match_score: 88,
      score_band: 'strong',
      match_reasons: ['High trust score'],
    });

    expect(sanitized).not.toHaveProperty('phone');
    expect(sanitized).not.toHaveProperty('worker_id');
    expect(sanitized).toMatchObject({
      skills: ['wiring'],
      trust_score: 91,
      match_score: 88,
    });
  });

  describe('cached ranking provenance', () => {
    // The rerank worker's fallback path writes the DETERMINISTIC ranking into
    // this same cache (tagged sql-v1, model_id NULL) so the SQS queue stops
    // retrying. Serving that cached order is correct; reporting it to the
    // employer as an LLM ranking is not.
    const JOB_ROW = {
      id: 'job-1',
      title: 'Electrician for panel wiring',
      location: 'Houston',
      job_type: 'full-time',
      description: 'panels',
      required_docs: [],
      created_at: '2026-05-10T00:00:00.000Z',
    };

    const CANDIDATE_ROWS = [
      {
        application_id: 'app-1',
        worker_id: 'worker-1',
        full_name: 'Electrician',
        phone: null,
        status: 'submitted',
        applied_at: '2026-05-11T00:00:00.000Z',
        skills: ['panels'],
        profile_skills: [],
        location: 'Houston',
        availability: 'full_time',
        profile_years_experience: 5,
        main_trade: 'electrician',
        main_trade_other: null,
        user_years_experience: '5-9',
        user_availability: 'full_time',
        city: 'Houston',
        trust_score: 80,
      },
      {
        application_id: 'app-2',
        worker_id: 'worker-2',
        full_name: 'Painter',
        phone: null,
        status: 'submitted',
        applied_at: '2026-05-12T00:00:00.000Z',
        skills: ['paint'],
        profile_skills: [],
        location: 'Houston',
        availability: 'part_time',
        profile_years_experience: 3,
        main_trade: 'painting',
        main_trade_other: null,
        user_years_experience: '2-4',
        user_availability: 'part_time',
        city: 'Houston',
        trust_score: 30,
      },
    ];

    /** job -> candidates -> count -> fresh cache rows. */
    function clientFor(cacheRows: Array<Record<string, unknown>>) {
      const query = jest.fn()
        .mockResolvedValueOnce({ rows: [JOB_ROW] })
        .mockResolvedValueOnce({ rows: CANDIDATE_ROWS })
        .mockResolvedValueOnce({ rows: [{ total: '2' }] })
        .mockResolvedValueOnce({ rows: cacheRows });
      return { client: makeClient(query), query };
    }

    it('reports a deterministic fallback cache as deterministic/sql-v1 while still serving the cached order', async () => {
      // Cache order is deliberately the reverse of the deterministic sort, so
      // this fails if the fix serves `deterministic` instead of the cache.
      const { client, query } = clientFor([
        {
          worker_id: 'worker-2',
          score: 30,
          score_band: 'fair',
          reasons: ['Applied to this job'],
          ranking_version: 'sql-v1',
          model_id: null,
          computed_at: '2026-05-15T00:00:00.000Z',
        },
        {
          worker_id: 'worker-1',
          score: 88,
          score_band: 'strong',
          reasons: ['High trust score'],
          ranking_version: 'sql-v1',
          model_id: null,
          computed_at: '2026-05-15T00:00:00.000Z',
        },
      ]);

      const result = await listEmployerCandidates(client, 'job-1', { limit: 10 });

      expect(result.response.ranking_status).toBe('deterministic');
      expect(result.response.ranking_version).toBe('sql-v1');
      expect(result.response.candidates.map((candidate) => candidate.worker_id))
        .toEqual(['worker-2', 'worker-1']);
      expect(result.response.candidates[0].match_score).toBe(30);
      // Still a cache hit: re-enqueueing is what caused the retry storm.
      expect(result.shouldEnqueueRerank).toBe(false);
      expect(result.response.computed_at).toBe('2026-05-15T00:00:00.000Z');
      // The cache read must ask for the provenance columns.
      expect(String(query.mock.calls[3][0])).toContain('ranking_version');
    });

    it('reports an llm-v1 cache as llm_cached/llm-v1', async () => {
      const { client } = clientFor([
        {
          worker_id: 'worker-1',
          score: 96,
          score_band: 'strong',
          reasons: ['LLM reason'],
          ranking_version: 'llm-v1',
          model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          computed_at: '2026-05-15T00:00:00.000Z',
        },
      ]);

      const result = await listEmployerCandidates(client, 'job-1', { limit: 10 });

      expect(result.response.ranking_status).toBe('llm_cached');
      expect(result.response.ranking_version).toBe('llm-v1');
      expect(result.response.candidates[0].match_reasons).toEqual(['LLM reason']);
      expect(result.shouldEnqueueRerank).toBe(false);
    });

    it('treats a mixed cache as deterministic — a partly deterministic ranking is not an LLM ranking', async () => {
      const { client } = clientFor([
        {
          worker_id: 'worker-1',
          score: 96,
          score_band: 'strong',
          reasons: ['LLM reason'],
          ranking_version: 'llm-v1',
          model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          computed_at: '2026-05-15T00:00:00.000Z',
        },
        {
          worker_id: 'worker-2',
          score: 30,
          score_band: 'fair',
          reasons: ['Applied to this job'],
          ranking_version: 'sql-v1',
          model_id: null,
          computed_at: '2026-05-15T00:00:00.000Z',
        },
      ]);

      const result = await listEmployerCandidates(client, 'job-1', { limit: 10 });

      expect(result.response.ranking_status).toBe('deterministic');
      expect(result.response.ranking_version).toBe('sql-v1');
      expect(result.response.candidates).toHaveLength(2);
    });
  });
});
