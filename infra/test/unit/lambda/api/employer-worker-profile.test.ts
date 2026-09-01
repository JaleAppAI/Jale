import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-worker-profile';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

// Query-text-dispatching mock: matches each client.query() call by a
// distinctive substring of its SQL so adding new queries (e.g. the
// trust_assessment lookup) never shifts positional call order.
type QueryStubs = {
  employer?: unknown;
  jobOwnership?: unknown;
  profile?: unknown;
  assessment?: unknown;
  extraction?: unknown;
};

function setupMockQuery(overrides: QueryStubs = {}) {
  const {
    employer = { rows: [{ id: 'employer-id' }] },
    jobOwnership = { rows: [{ id: 'job-uuid' }] },
    profile = { rows: [] },
    assessment = { rows: [] },
    extraction = { rows: [] },
  } = overrides;

  mockQuery.mockImplementation((text: string) => {
    const t = String(text);
    if (t.includes('FROM users WHERE cognito_sub')) return Promise.resolve(employer);
    if (t.includes('FROM jobs WHERE id')) return Promise.resolve(jobOwnership);
    if (t.includes('FROM job_applications ja')) return Promise.resolve(profile);
    if (t.includes('FROM worker_trust_extractions')) return Promise.resolve(extraction);
    if (t.includes('FROM worker_trust_assessments')) return Promise.resolve(assessment);
    // BEGIN / COMMIT / ROLLBACK and anything else
    return Promise.resolve({});
  });
}

describe('employer-worker-profile Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockSetInternalUserRlsContext.mockResolvedValue(undefined);
  });

  const makeEvent = (sub: string | null, workerId = 'worker-uuid', jobId = 'job-uuid') =>
    ({
      requestContext: { authorizer: { claims: sub ? { sub } : {} } },
      pathParameters: { worker_id: workerId },
      queryStringParameters: { job_id: jobId },
    }) as unknown as APIGatewayProxyEvent;

  const mockProfile = {
    worker_id: 'worker-uuid',
    full_name: 'Maria G',
    phone: '555-1234',
    skills: ['Forklift'],
    availability: 'immediate',
    years_experience: 3,
    experience_months: 36,
    location: 'LA',
    certifications: ['OSHA 10'],
    main_trade: 'electrician',
    main_trade_other: null,
    has_transportation: true,
    city: 'Los Angeles',
    application_status: 'pending',
    applied_at: new Date().toISOString(),
  };

  it('returns 401 if cognitoSub is missing', async () => {
    const res = await handler(makeEvent(null));
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 if legal compliance not met', async () => {
    mockCheckCompliance.mockResolvedValue({
      compliant: false,
      userExists: true,
      currentVersion: 'v0.9',
    });
    mockQuery.mockResolvedValue({});
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 if employer does not own the job', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({ jobOwnership: { rows: [] } });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
  });

  it('returns 200 with worker profile including safe onboarding facts', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [] },
    });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ...mockProfile,
      trust_assessment: null,
      trust_extraction: null,
    });
    const profileQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM job_applications ja'))?.[0];
    expect(profileQuery).toContain('FROM worker_skills ws');
    expect(profileQuery).toContain('WHERE ws.worker_id = ja.worker_id');
    expect(profileQuery).toContain('j.employer_id = $3');
    expect(profileQuery).not.toContain('wp.skills');
    expect(profileQuery).toContain('wp.experience_months');
    expect(profileQuery).toContain('wp.certifications');
    // Safe onboarding facts must be in the query
    expect(profileQuery).toContain('u.main_trade');
    expect(profileQuery).toContain('u.main_trade_other');
    expect(profileQuery).toContain('u.has_transportation');
    expect(profileQuery).toContain('u.city');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 404 without ever running the trust-assessment query', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({ profile: { rows: [] } });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
    const assessmentCalled = mockQuery.mock.calls.some(([queryText]) =>
      String(queryText).includes('FROM worker_trust_assessments'),
    );
    expect(assessmentCalled).toBe(false);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns trust_assessment with score and components but never rationales', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const scoredAssessment = {
      id: 'assessment-uuid',
      profession_key: 'electrician',
      status: 'scored',
      competency_score: 72,
      score_components: {
        specific_knowledge: 24,
        practical_experience: 22,
        safety_awareness: 14,
        communication_clarity: 12,
      },
      // Realistic values for the sensitive fields that the handler's SELECT
      // must not request and must not serialize. Their presence here (as if
      // a broader SELECT/spread regression returned them) is what gives the
      // not-contains assertions below actual teeth.
      score_rationale: {
        specific_knowledge: 'Mentions taping and leveling.',
        practical_experience: 'Describes ten years on residential rewires.',
        safety_awareness: 'References lockout/tagout procedure.',
        communication_clarity: 'Answers are concise and on-topic.',
      },
      rubric_version: 7,
      scoring_model_id: 'us.amazon.nova-lite-v1:0',
      answers: [
        {
          question_index: 0,
          q_en: 'How many years have you worked as an electrician?',
          q_es: '¿Cuántos años ha trabajado como electricista?',
          answer_text: 'Ten years',
          answer_source: 'voice',
          answered_at: '2026-08-19T00:00:00.000Z',
        },
        {
          question_index: 1,
          q_en: 'Reply with the number of your answer.\n1. Yes\n2. No',
          q_es: null,
          answer_text: '1',
          answer_source: 'text',
          answered_at: '2026-08-19T00:05:00.000Z',
        },
      ],
      scored_at: '2026-08-20T00:00:00.000Z',
    };
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [scoredAssessment] },
    });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trust_assessment.competency_score).toBe(72);
    expect(body.trust_assessment.score_components).toEqual({
      specific_knowledge: 24,
      practical_experience: 22,
      safety_awareness: 14,
      communication_clarity: 12,
    });
    expect(body.trust_assessment.answers).toHaveLength(2);
    // rubric_version is now deliberately included -- it's what lets the
    // frontend detect a rebalanced (SSM-hot-edited) rubric and degrade its
    // hardcoded 30/30/20/20 bars to plain numbers instead of mislabeling them.
    expect(body.trust_assessment.rubric_version).toBe(7);
    // score_rationale and scoring_model_id remain excluded -- the privacy
    // contract for this endpoint.
    expect(JSON.stringify(body)).not.toContain('score_rationale');
    expect(JSON.stringify(body)).not.toContain('scoring_model_id');

    const assessmentQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM worker_trust_assessments'))?.[0];
    expect(assessmentQuery).toContain('rubric_version');
    expect(assessmentQuery).not.toContain('score_rationale');
    expect(assessmentQuery).not.toContain('scoring_model_id');

    // R2-D: the extraction lookup joins this endpoint's privacy contract.
    // `error` is a raw model/runtime failure string and `model_id` is an
    // internal implementation detail -- 086 leaves BOTH out of the column
    // grant, so naming either is a 42501, not just a leak.
    const everyQuery = mockQuery.mock.calls.map(([queryText]) => String(queryText)).join('\n');
    for (const forbidden of ['score_rationale', 'scoring_model_id', 'error', 'model_id']) {
      expect(everyQuery).not.toContain(forbidden);
      expect(JSON.stringify(body)).not.toContain(forbidden);
    }
  });

  it('coerces a non-numeric stored rubric_version to the -1 sentinel instead of NaN', async () => {
    // rubric_version is TEXT in the DB. A non-numeric stored value (e.g. the
    // v2 onboarding flow's string sentinel) must not become NaN --
    // JSON.stringify(NaN) serializes as `null`, which the frontend drift
    // gate reads as "no rubric_version reported" (known scale) and renders
    // bars anyway. -1 can never equal the frontend's KNOWN_RUBRIC_VERSION,
    // so it still correctly degrades to plain numbers.
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const scoredAssessment = {
      id: 'assessment-uuid',
      profession_key: 'electrician',
      status: 'scored',
      competency_score: 72,
      score_components: {
        specific_knowledge: 24,
        practical_experience: 22,
        safety_awareness: 14,
        communication_clarity: 12,
      },
      rubric_version: 'v2-trust-rubric-1',
      answers: [],
      scored_at: '2026-08-20T00:00:00.000Z',
    };
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [scoredAssessment] },
    });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trust_assessment.rubric_version).toBe(-1);
  });

  it('returns trust_assessment: null when the worker has no assessment', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [] },
    });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).trust_assessment).toBeNull();
  });

  it('nulls score fields for a non-scored assessment but still returns answers', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const pendingAssessment = {
      id: 'assessment-uuid',
      profession_key: 'electrician',
      status: 'pending',
      competency_score: null,
      score_components: null,
      // Not-yet-scored realistically has no rationale/rubric/model yet, but a
      // regression could still return leftover values from a prior scoring
      // attempt (e.g. re-queued row) — assert they never leak either way.
      score_rationale: null,
      rubric_version: null,
      scoring_model_id: null,
      answers: [
        {
          question_index: 0,
          q_en: 'How many years have you worked as an electrician?',
          q_es: '¿Cuántos años ha trabajado como electricista?',
          answer_text: 'Ten years',
          answer_source: 'voice',
          answered_at: '2026-08-19T00:00:00.000Z',
        },
      ],
      scored_at: null,
    };
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [pendingAssessment] },
    });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    const ta = JSON.parse(res.body).trust_assessment;
    expect(ta.status).toBe('pending');
    expect(ta.competency_score).toBeNull();
    expect(ta.score_components).toBeNull();
    expect(ta.rubric_version).toBeNull();
    expect(ta.answers.length).toBeGreaterThan(0);
  });
  /* ===== R2-D: trust_extraction ========================================== */

  const completedExtraction = {
    status: 'completed',
    extracted: {
      skills: [{ label_en: 'Conduit bending', label_es: 'Doblado de tuberia', source: [0] }],
      tools: [{ label_en: 'Hydraulic bender', label_es: 'Dobladora hidraulica', source: [0] }],
      experience_signals: [],
      safety: [{ label_en: 'Lockout/tagout', label_es: 'Bloqueo y etiquetado', source: [2] }],
      notable: [],
    },
    summary_en: 'Ten years of residential rewires, comfortable bending conduit.',
    summary_es: 'Diez anos de recableado residencial, comodo doblando tuberia.',
    extractor_version: 'trust-extractor-1',
    created_at: '2026-08-27T00:00:00.000Z',
  };

  it('returns the latest completed extraction for the assessment it returned', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [{ id: 'assessment-uuid', status: 'scored', answers: [], rubric_version: 7 }] },
      extraction: { rows: [completedExtraction] },
    });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trust_extraction).toEqual({
      status: 'completed',
      extracted: completedExtraction.extracted,
      summary_en: completedExtraction.summary_en,
      summary_es: completedExtraction.summary_es,
      extractor_version: 'trust-extractor-1',
    });
    // `created_at` is selected (it is what the ORDER BY ranks on) but is not
    // part of the wire contract -- the panel has no place to show it.
    expect(body.trust_extraction).not.toHaveProperty('created_at');
  });

  it('selects six of the ten granted extraction columns, scoped to that assessment', async () => {
    // 086:200-205 grants SELECT on a named ten-column list. The four this
    // response skips (id, assessment_id, user_id, updated_at) are simply
    // unneeded; the two OUTSIDE that grant -- `error` and `model_id` -- are a
    // hard 42501 for a non-owner reader, not a soft leak. Asserting the
    // select list POSITIVELY is what pins both facts at once.
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [{ id: 'assessment-uuid', status: 'scored', answers: [] }] },
      extraction: { rows: [completedExtraction] },
    });
    await handler(makeEvent('employer-sub'));

    const call = mockQuery.mock.calls.find(([queryText]) =>
      String(queryText).includes('FROM worker_trust_extractions'),
    );
    expect(call).toBeDefined();
    const sql = String(call![0]);
    const selectList = sql
      .slice(sql.indexOf('SELECT') + 'SELECT'.length, sql.indexOf('FROM'))
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    expect(selectList).toEqual([
      'status',
      'extracted',
      'summary_en',
      'summary_es',
      'extractor_version',
      'created_at',
    ]);
    // Latest completed, else latest of any status -- one round trip.
    expect(sql).toContain("ORDER BY (status = 'completed') DESC, created_at DESC");
    expect(sql).toContain('LIMIT 1');
    // Scoped to the assessment actually returned: `extracted[].source` indexes
    // back into THAT assessment's `answers` (086 Part 1), so an extraction of
    // a different assessment would point its chips at the wrong questions.
    expect(sql).toContain('assessment_id = $1');
    expect(call![1]).toEqual(['assessment-uuid', 'worker-uuid']);
  });

  it('reports a non-completed extraction as a status only, with no partial content', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [{ id: 'assessment-uuid', status: 'scored', answers: [] }] },
      extraction: {
        rows: [
          {
            status: 'extracting',
            // A re-queued row can still carry the previous attempt's output.
            // Until it is `completed` none of it is shown, so none of it ships.
            extracted: { skills: [{ label_en: 'Stale', label_es: 'Viejo', source: [0] }] },
            summary_en: 'Stale summary',
            summary_es: 'Resumen viejo',
            extractor_version: 'trust-extractor-1',
            created_at: '2026-08-27T00:00:00.000Z',
          },
        ],
      },
    });
    const res = await handler(makeEvent('employer-sub'));
    const body = JSON.parse(res.body);
    expect(body.trust_extraction.status).toBe('extracting');
    expect(body.trust_extraction.extracted).toEqual({});
    expect(body.trust_extraction.summary_en).toBeNull();
    expect(body.trust_extraction.summary_es).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Stale');
  });

  it('returns trust_extraction: null when the assessment has no extraction row', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [{ id: 'assessment-uuid', status: 'scored', answers: [] }] },
      extraction: { rows: [] },
    });
    const res = await handler(makeEvent('employer-sub'));
    expect(JSON.parse(res.body).trust_extraction).toBeNull();
  });

  it('never runs the extraction query when there is no assessment to attach it to', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({ profile: { rows: [mockProfile] }, assessment: { rows: [] } });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trust_assessment).toBeNull();
    expect(body.trust_extraction).toBeNull();
    expect(
      mockQuery.mock.calls.some(([queryText]) =>
        String(queryText).includes('FROM worker_trust_extractions'),
      ),
    ).toBe(false);
  });

  it('returns 404 without ever running the extraction query', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({ profile: { rows: [] } });
    const res = await handler(makeEvent('employer-sub'));
    expect(res.statusCode).toBe(404);
    expect(
      mockQuery.mock.calls.some(([queryText]) =>
        String(queryText).includes('FROM worker_trust_extractions'),
      ),
    ).toBe(false);
  });

  it('reads the extraction in the internal-user RLS lane the 086 employer policy keys on', async () => {
    // wte_employer_applicant_read gates on
    // employer_has_applicant_relationship(app.current_internal_user_id, ...),
    // and that GUC must hold the EMPLOYER's id, never the worker's.
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    setupMockQuery({
      profile: { rows: [mockProfile] },
      assessment: { rows: [{ id: 'assessment-uuid', status: 'scored', answers: [] }] },
      extraction: { rows: [completedExtraction] },
    });
    await handler(makeEvent('employer-sub'));
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'employer-id');
  });
});
