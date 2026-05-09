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
    process.env.WORKER_RERANK_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/worker-rerank-queue';
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

  it('writes score with profession key and inserts rerank outbox before sending SQS after commit', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ answers: [{ q_en: 'Q1', answer_text: 'Residential', answer_source: 'text' }] }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1',
          worker_id: 'u1',
          payload: {
            workerId: 'u1',
            professionKey: 'electrician',
            reason: 'trust_score_updated',
          },
          attempts: 0,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: JSON.stringify(VALID_SCORE) }] } },
    });

    await scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'electrician' });

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);

    const userUpdate = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('SET trade_competency_score = $1')
      && String(sql).includes('trade_competency_profession_key = $2'));
    expect(userUpdate?.[1]).toEqual([72, 'electrician', 'u1']);

    const outboxInsertIndex = mockDbQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes('INSERT INTO trust_score_rerank_outbox'));
    const commitIndex = mockDbQuery.mock.calls.findIndex(([sql]) => sql === 'COMMIT');
    expect(outboxInsertIndex).toBeGreaterThan(-1);
    expect(outboxInsertIndex).toBeLessThan(commitIndex);

    const commitOrder = mockDbQuery.mock.invocationCallOrder[commitIndex];
    expect(mockSqsSend.mock.invocationCallOrder[0]).toBeGreaterThan(commitOrder);
    expect(mockSqsSend).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/worker-rerank-queue',
      MessageBody: JSON.stringify({
        workerId: 'u1',
        professionKey: 'electrician',
        reason: 'trust_score_updated',
      }),
    }));
  });

  it('accepts score JSON with unquoted known keys from Bedrock', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ answers: [{ q_en: 'Q1', answer_text: 'Residential', answer_source: 'text' }] }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
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
      .mockResolvedValueOnce({ rowCount: 1 })
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

  it('marks rerank outbox row failed when worker rerank SQS send fails', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ answers: [] }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1',
          worker_id: 'u1',
          payload: {
            workerId: 'u1',
            professionKey: 'electrician',
            reason: 'trust_score_updated',
          },
          attempts: 0,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: JSON.stringify(VALID_SCORE) }] } },
    });
    mockSqsSend.mockRejectedValueOnce(new Error('sqs outage'));

    await scoreAssessment({ assessmentId: 'abc', userId: 'u1', professionKey: 'electrician' });

    const failedUpdate = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'failed'")
      && String(sql).includes('attempts = attempts + 1'));
    expect(failedUpdate?.[1]).toEqual(['outbox-1', 'sqs outage']);
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
    process.env.WORKER_RERANK_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/worker-rerank-queue';
  });

  it('resets stale scoring rows and re-queues', async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'a1', user_id: 'u1', profession_key: 'electrician' }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    mockSqsSend.mockResolvedValue({});

    await handleRecoveryCron();

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
  });

  it('drains pending rerank outbox rows during recovery cron', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1',
          worker_id: 'u1',
          payload: {
            workerId: 'u1',
            professionKey: 'electrician',
            reason: 'trust_score_updated',
          },
          attempts: 1,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockSqsSend.mockResolvedValue({});

    await handleRecoveryCron();

    expect(mockSqsSend).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/worker-rerank-queue',
    }));
    const sentUpdate = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'sent'"));
    expect(sentUpdate?.[1]).toEqual(['outbox-1']);
  });
});

export {};
