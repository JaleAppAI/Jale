// ── Mocks (must come before handler import) ────────────────────────

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn((args) => ({ input: args, __type: 'GetObject' })),
}));

const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn((args) => ({ input: args, __type: 'Converse' })),
}));

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(() => ({
  query: mockQuery,
  release: mockRelease,
}));
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
  setRlsContext: jest.fn(),
}));

process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/db';
process.env.MEDIA_BUCKET_NAME = 'jale-worker-media-test';
process.env.BEDROCK_MODEL_ID = 'amazon.nova-lite-v1:0';
process.env.AI_EXTRACTION_CONFIDENCE_THRESHOLD = '0.75';
process.env.AI_INDUSTRY_KEYWORDS = '["electrician","plumber","carpenter"]';

import { handler } from '../../../../lambda/whatsapp/ai-profile-writer';

function makeTranscriptS3Response(text: string) {
  const json = JSON.stringify({ results: { transcripts: [{ transcript: text }] } });
  return {
    Body: {
      transformToString: jest.fn().mockResolvedValue(json),
    },
  };
}

function makeBedrockResponse(fields: object, scores: object, summaryEn: string, summaryEs: string) {
  return {
    output: {
      message: {
        content: [{
          text: JSON.stringify({
            extracted_fields: fields,
            confidence_scores: scores,
            summary_en: summaryEn,
            summary_es: summaryEs,
          }),
        }],
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockReturnValue({ query: mockQuery, release: mockRelease });
  mockQuery.mockResolvedValue({ rows: [{ next_seq: 1 }], rowCount: 0 });
});

test('handler writes completed extraction and updates user on success', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('I am an electrician in Austin with 5 years experience'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { city: 'Austin', main_trade: 'electrician', years_experience: '5-9' },
    { city: 0.9, main_trade: 0.95, years_experience: 0.85 },
    'Electrician in Austin with 5+ years experience.',
    'Electricista en Austin con más de 5 años de experiencia.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-1.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  // Should have read transcript from S3
  expect(mockS3Send).toHaveBeenCalledTimes(1);
  // Should have called Bedrock
  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  // Should have written ai_extraction row with status=completed
  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(insertCall).toBeDefined();
  // Should have updated users table
  const updateCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /UPDATE users/.test(sql)
  );
  expect(updateCall).toBeDefined();
  // Should have inserted whatsapp_outbox row
  const outboxCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO whatsapp_outbox/.test(sql)
  );
  expect(outboxCall).toBeDefined();
  // Should have updated conversation state to building_profile
  const convUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
    /UPDATE whatsapp_conversations/.test(sql) && /building_profile/.test(sql)
  );
  expect(convUpdate).toBeDefined();
});

test('handler writes failed extraction and falls back on failed status', async () => {
  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    whatsappNumber: '+15125551234',
    language: 'es',
    status: 'failed',
    errorMessage: 'TranscribeJobFailed',
  }, {} as any, () => {});

  // Should NOT call S3 or Bedrock
  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockBedrockSend).not.toHaveBeenCalled();
  // Should write failed extraction row
  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(insertCall).toBeDefined();
  // Should update conversation to building_profile
  const convUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
    /UPDATE whatsapp_conversations/.test(sql) && /building_profile/.test(sql)
  );
  expect(convUpdate).toBeDefined();
  // Should queue fallback reply (ai_extraction_failed message)
  const outboxCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO whatsapp_outbox/.test(sql)
  );
  expect(outboxCall).toBeDefined();
});

test('fields with confidence below threshold are not written to users', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('maybe electrician somewhere'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { city: 'Unknown', main_trade: 'electrician', years_experience: '0-1' },
    { city: 0.3, main_trade: 0.9, years_experience: 0.4 },
    'Summary.',
    'Resumen.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-2.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  // UPDATE users SQL should only contain main_trade (confidence 0.9), not city (0.3) or years_experience (0.4)
  const updateCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /UPDATE users/.test(sql)
  );
  expect(updateCall).toBeDefined();
  expect(updateCall![0]).toContain('main_trade');
  expect(updateCall![0]).not.toContain('city');
  expect(updateCall![0]).not.toContain('years_experience');
});
