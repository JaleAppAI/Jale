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

  it('ranks applied workers by trust score, relevant skills, and profile keywords', async () => {
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
});
