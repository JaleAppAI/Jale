const mockBedrockSend = jest.fn();
const mockSsmSend = jest.fn();
const mockSqsSend = jest.fn();
const mockDbQuery = jest.fn();
const mockDbRelease = jest.fn();
const mockDbConnect = jest.fn().mockResolvedValue({
  query: mockDbQuery,
  release: mockDbRelease,
});

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn().mockResolvedValue({ connect: mockDbConnect }),
}));

const VALID_SCORE = {
  competency_score: 72,
  score_components: {
    specific_knowledge: 22,
    practical_experience: 25,
    safety_awareness: 15,
    communication_clarity: 10,
  },
  score_rationale: {
    specific_knowledge: 'Good',
    practical_experience: 'Solid',
    safety_awareness: 'OK',
    communication_clarity: 'Clear',
  },
};

describe('scoreAssessment', () => {
  const { scoreAssessment } = require('../../../../lambda/ai/trust-scorer');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SSM_RUBRIC_PARAM = '/jale/ai/scoring-rubric';
    process.env.TRUST_ASSESSMENT_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/trust-assessment-queue';
    mockSsmSend.mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({
          version: '1.0',
          dimensions: [],
          system_instruction: 'test',
          output_format: {},
        }),
        Version: 5,
      },
    });
  });

  it('exits early if claim UPDATE returns 0 rows', async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0 });

    await scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'electrician' });

    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDbRelease).toHaveBeenCalledTimes(1);
  });

  it('calls Bedrock and writes score atomically on successful claim', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ answers: [{ q_en: 'Q1', answer_text: 'Residential', answer_source: 'text' }] }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: JSON.stringify(VALID_SCORE) }] } },
    });

    await scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'electrician' });

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  });

  it('accepts score JSON with unquoted known keys from Bedrock', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ answers: [{ q_en: 'Q1', answer_text: 'Residential', answer_source: 'text' }] }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{
            text: `{
              competency_score: 72,
              score_components: {
                specific_knowledge: 22,
                practical_experience: 25,
                safety_awareness: 15,
                communication_clarity: 10
              },
              score_rationale: {
                specific_knowledge: "Good",
                practical_experience: "Solid",
                safety_awareness: "OK",
                communication_clarity: "Clear"
              }
            }`,
          }],
        },
      },
    });

    await scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'electrician' });

    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  });

  it('rolls back if user score update affects no rows', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ answers: [] }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] });
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: JSON.stringify(VALID_SCORE) }] } },
    });

    await expect(
      scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'electrician' }),
    ).rejects.toThrow(/user score update matched no rows/i);

    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });

  it('rolls back without updating user score if assessment update matches no rows (lost race with recovery)', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ answers: [] }] }) // select answers
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 }) // assessment UPDATE guarded by status='scoring' -- no longer scoring
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: JSON.stringify(VALID_SCORE) }] } },
    });

    await scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'electrician' });

    expect(mockDbQuery.mock.calls.some(([sql]) => sql.includes('UPDATE users'))).toBe(false);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });

  it('validates score sum matches competency_score', async () => {
    const badScore = { ...VALID_SCORE, competency_score: 99 };
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ answers: [] }] });
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: JSON.stringify(badScore) }] } },
    });

    await expect(
      scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'x' }),
    ).rejects.toThrow(/sum mismatch/i);
  });
});

describe('handleRecoveryCron', () => {
  const { handleRecoveryCron } = require('../../../../lambda/ai/trust-scorer');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRUST_ASSESSMENT_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/queue';
  });

  it('resets stale scoring rows and re-queues', async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', user_id: 'u1', profession_key: 'electrician' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockSqsSend.mockResolvedValue({});

    await handleRecoveryCron();

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
  });
});

export {};
