import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-worker-profile';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
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
};

function setupMockQuery(overrides: QueryStubs = {}) {
  const {
    employer = { rows: [{ id: 'employer-id' }] },
    jobOwnership = { rows: [{ id: 'job-uuid' }] },
    profile = { rows: [] },
    assessment = { rows: [] },
  } = overrides;

  mockQuery.mockImplementation((text: string) => {
    const t = String(text);
    if (t.includes('FROM users WHERE cognito_sub')) return Promise.resolve(employer);
    if (t.includes('FROM jobs WHERE id')) return Promise.resolve(jobOwnership);
    if (t.includes('FROM job_applications ja')) return Promise.resolve(profile);
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
    expect(JSON.parse(res.body)).toEqual({ ...mockProfile, trust_assessment: null });
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

  it('returns trust_assessment with score and components but never rationales', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const scoredAssessment = {
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
    expect(JSON.stringify(body)).not.toContain('score_rationale');
    expect(JSON.stringify(body)).not.toContain('rubric_version');
    expect(JSON.stringify(body)).not.toContain('scoring_model_id');

    const assessmentQuery = mockQuery.mock.calls.find(([queryText]) => String(queryText).includes('FROM worker_trust_assessments'))?.[0];
    expect(assessmentQuery).not.toContain('score_rationale');
    expect(assessmentQuery).not.toContain('rubric_version');
    expect(assessmentQuery).not.toContain('scoring_model_id');
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
    expect(ta.answers.length).toBeGreaterThan(0);
  });
});
