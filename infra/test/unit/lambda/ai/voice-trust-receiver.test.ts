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

// Sprint 22 R1-A: the legacy (non-v2) `VoiceTrustContext` lane — the one that
// wrote `custom_trust_*` state and parked the conversation in
// `building_custom_trust` — is deleted. Its tests went with it; what remains
// is the assertion that a non-v2 event now fails loudly instead of silently
// dropping a worker's transcribed answer.
describe('handleVoiceTrustCompletion — legacy (non-v2) execution context', () => {
  const { handleVoiceTrustCompletion } = require('../../../../lambda/ai/voice-trust-receiver');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws and does ZERO DB work — no producer of this shape exists any more', async () => {
    await expect(
      handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: baseContext }),
    ).rejects.toThrow(/non-v2 execution context is no longer supported/);

    expect(mockDbConnect).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
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

  // Regression (T-transcription-language-id): jobs run with
  // IdentifyMultipleLanguages add a `results.language_codes` array to the
  // Transcribe output JSON alongside the same `transcripts[0].transcript`
  // shape. readTranscript only ever reads the latter, so this extra field
  // must be inert — the parsed transcript text is unaffected.
  it('a transcript with results.language_codes (multi-language job output) parses the transcript unchanged', async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: () => Promise.resolve(JSON.stringify({
          results: {
            transcripts: [{ transcript: 'five years experience' }],
            language_codes: [
              { language_code: 'es-US', duration_in_seconds: 3.2 },
              { language_code: 'en-US', duration_in_seconds: 1.1 },
            ],
          },
        })),
      },
    });

    await handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: v2Context, executionArn: V2_EXECUTION_ARN });

    const { evt } = parseSentEvent();
    expect(evt.status).toBe('COMPLETED');
    expect(evt.transcript).toBe('five years experience');
  });

  // Task A: transcript reading is now delegated to the shared
  // infra/lambda/lib/transcript.ts parser, which recognizes a
  // `jaleTranscriptVersion: 1` passthrough payload (future provider
  // adapters) as well as raw Transcribe batch output. This proves that
  // hook is wired through end-to-end here, not just unit-tested in
  // isolation on the parser itself.
  it('parses a jaleTranscriptVersion:1 fixture (future-provider passthrough) via the shared transcript helper', async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: () => Promise.resolve(JSON.stringify({
          jaleTranscriptVersion: 1,
          text: 'five years experience',
          provider: 'deepgram',
        })),
      },
    });

    await handleVoiceTrustCompletion({ status: 'COMPLETED', executionContext: v2Context, executionArn: V2_EXECUTION_ARN });

    const { evt } = parseSentEvent();
    expect(evt.status).toBe('COMPLETED');
    expect(evt.transcript).toBe('five years experience');
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
