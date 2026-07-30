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

// Real (unmocked) — pure functions, no AWS/DB dependency.
import { hashNormalizedPhone } from '../../../../lambda/whatsapp/lib/runtime-controls';

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

// ── Task 5: v2 branch — zero DB work, re-enter via the v2 FIFO queue ──────
describe('handleVoiceTrustCompletion — v2 branch', () => {
  const { handleVoiceTrustCompletion } = require('../../../../lambda/ai/voice-trust-receiver');

  const v2Context = {
    v2: {
      version: 'v2' as const,
      kind: 'trust_answer' as const,
      phone: '+15551234567',
      runId: 'run-1',
      stepKey: 'trust.question.1',
      language: 'en' as const,
      origMessageSid: 'SM00000000000000000000000000000v',
      startedAt: '2026-07-27T00:00:00.000Z',
      questionIndex: 0,
    },
    mediaBucketName: 'jale-bucket',
    transcriptOutputKey: 'transcripts/v2.json',
  };

  const V2_EXECUTION_ARN = 'arn:aws:states:us-east-1:123456789012:execution:trust-voice-pipeline:vt-test';

  function parseSentEvent(): any {
    const sentInput = mockSqsSend.mock.calls[0][0];
    const params = new URLSearchParams(sentInput.MessageBody);
    return { sentInput, evt: JSON.parse(params.get('XJaleVoiceEvent')!) };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WHATSAPP_INBOUND_V2_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/v2-queue.fifo';
    mockSqsSend.mockResolvedValue({});
  });

  it('does ZERO DB work and sends exactly one FIFO message with correct group/dedup ids', async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve('{"results":{"transcripts":[{"transcript":"five years experience"}]}}') },
    });

    await handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: v2Context, executionArn: V2_EXECUTION_ARN });

    expect(mockDbConnect).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockSqsSend).toHaveBeenCalledTimes(1);

    const { sentInput, evt } = parseSentEvent();
    expect(sentInput.QueueUrl).toBe(process.env.WHATSAPP_INBOUND_V2_QUEUE_URL);
    expect(sentInput.MessageDeduplicationId).toBe('SM00000000000000000000000000000v#vt');
    expect(sentInput.MessageGroupId).toBe(hashNormalizedPhone(v2Context.v2.phone));
    expect(evt.kind).toBe('trust_answer');
    expect(evt.status).toBe('COMPLETED');
    expect(evt.transcript).toBe('five years experience');
    expect(evt.stepKey).toBe('trust.question.1');
    expect(evt.questionIndex).toBe(0);
    // Task 5/B3: the outbound event carries the execution ARN threaded in
    // as a top-level sibling of executionContext by the state machine
    // ($$.Execution.Id) — the router's staleness anchor.
    expect(evt.executionArn).toBe(V2_EXECUTION_ARN);
  });

  it('throws when executionArn is missing on a v2 completion (never silently omits the staleness anchor)', async () => {
    await expect(
      handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: v2Context }),
    ).rejects.toThrow(/executionArn missing/);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  // Task 7/B5: an S3 hiccup reading the transcript must never throw bare —
  // this lambda has no worker-visible retry story, so an uncaught throw
  // means no #vt event is EVER sent and the worker waits forever. It must
  // degrade to the same graceful FAILED path an empty transcript already
  // takes.
  it('an S3 read failure is caught and forwarded as a graceful FAILED event, never thrown', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('S3 unavailable'));

    await expect(
      handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: v2Context, executionArn: V2_EXECUTION_ARN }),
    ).resolves.toBeUndefined();

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const { evt } = parseSentEvent();
    expect(evt.status).toBe('FAILED');
    expect(evt.transcript).toBeUndefined();
  });

  it('an empty (whitespace-only) transcript is escalated to FAILED before the event is built', async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve('{"results":{"transcripts":[{"transcript":"   "}]}}') },
    });

    await handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: v2Context, executionArn: V2_EXECUTION_ARN });

    expect(mockDbQuery).not.toHaveBeenCalled();
    const { evt } = parseSentEvent();
    expect(evt.status).toBe('FAILED');
    expect(evt.transcript).toBeUndefined();
  });

  it('a FAILED completion never reads S3 and forwards FAILED status', async () => {
    await handleVoiceTrustCompletion({ status: 'FAILED', executionContext: v2Context, executionArn: V2_EXECUTION_ARN });

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
    const { evt } = parseSentEvent();
    expect(evt.status).toBe('FAILED');
    expect(evt.transcript).toBeUndefined();
  });

  it('never logs the transcript text or the phone number', async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve('{"results":{"transcripts":[{"transcript":"a secret transcript"}]}}') },
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: v2Context, executionArn: V2_EXECUTION_ARN });

    const loggedText = logSpy.mock.calls.map(([msg]) => String(msg)).join('\n');
    expect(loggedText).not.toContain('a secret transcript');
    expect(loggedText).not.toContain(v2Context.v2.phone);
    logSpy.mockRestore();
  });
});

export {};
