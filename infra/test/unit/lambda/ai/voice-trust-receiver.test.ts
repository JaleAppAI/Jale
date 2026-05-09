const mockDbQuery = jest.fn();
const mockDbRelease = jest.fn();
const mockDbConnect = jest.fn().mockResolvedValue({
  query: mockDbQuery,
  release: mockDbRelease,
});
const mockS3Send = jest.fn();
const mockSqsSend = jest.fn();
const mockSendPendingOutbox = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn().mockResolvedValue({ connect: mockDbConnect }),
  setRlsContext: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  sendPendingOutbox: mockSendPendingOutbox,
}));

const baseContext = {
  userId: 'user-123',
  conversationId: 'conv-456',
  inboundMessageSid: 'SM123',
  whatsappNumber: 'whatsapp:+15551234567',
  language: 'en',
  trustStep: 0,
  assessmentId: 'assessment-789',
  mediaBucketName: 'jale-bucket',
  transcriptOutputKey: 'transcripts/abc.json',
  trustQuestions: [
    { q_en: 'Q1 en', q_es: 'Q1 es' },
    { q_en: 'Q2 en', q_es: 'Q2 es' },
    { q_en: 'Q3 en', q_es: 'Q3 es' },
  ],
} as const;

describe('handleVoiceTrustCompletion', () => {
  const { handleVoiceTrustCompletion } = require('../../../../lambda/ai/voice-trust-receiver');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRUST_ASSESSMENT_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/queue';
    mockSendPendingOutbox.mockResolvedValue(undefined);
  });

  it('on FAILED sends retry prompt without advancing step', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{
        state_context: {
          custom_trust_step: 0,
          custom_trust_answers: [],
          custom_trust_questions: baseContext.trustQuestions,
        },
      }],
    });

    await handleVoiceTrustCompletion({ status: 'FAILED', executionContext: baseContext });

    const updateCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("conversation_state = 'building_custom_trust'"));
    expect(updateCall).toBeDefined();
    const stepAdvanceCall = mockDbQuery.mock.calls.find(([, params]) =>
      String(params?.[0]).includes('custom_trust_step'));
    expect(stepAdvanceCall).toBeUndefined();
  });

  it('on COMPLETED mid-flow reads transcript, appends answer, and advances step', async () => {
    const transcript = '{"results":{"transcripts":[{"transcript":"I do residential wiring"}]}}';
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(transcript) },
    });
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          state_context: {
            custom_trust_step: 0,
            custom_trust_answers: [],
            custom_trust_questions: baseContext.trustQuestions,
          },
        }],
      })
      .mockResolvedValue({ rows: [] });

    await handleVoiceTrustCompletion({
      status: 'COMPLETED',
      executionContext: { ...baseContext, trustStep: 0 },
    });

    const updateCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE whatsapp_conversations'));
    expect(updateCall).toBeDefined();
    expect(String(updateCall?.[1]?.[0])).toContain('"custom_trust_step":1');
  });

  it('on COMPLETED final step inserts WTA row and pushes to queue', async () => {
    const transcript = '{"results":{"transcripts":[{"transcript":"I handle crews"}]}}';
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(transcript) },
    });
    const existingAnswers = [
      { q_en: 'Q1 en', answer_text: 'Residential', answer_source: 'text', answered_at: '2026-01-01T00:00:00Z' },
      { q_en: 'Q2 en', answer_text: 'Lead', answer_source: 'voice', answered_at: '2026-01-01T00:00:00Z' },
    ];
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          state_context: {
            custom_trust_step: 2,
            custom_trust_answers: existingAnswers,
            custom_trust_questions: baseContext.trustQuestions,
            custom_trust_profession: 'soldador de arco',
          },
        }],
      })
      .mockResolvedValue({ rows: [] });
    mockSqsSend.mockResolvedValue({});

    await handleVoiceTrustCompletion({
      status: 'COMPLETED',
      executionContext: { ...baseContext, trustStep: 2 },
    });

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const insertCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO worker_trust_assessments'));
    expect(insertCall).toBeDefined();
  });
});

export {};
