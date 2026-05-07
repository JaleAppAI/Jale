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
}), { virtual: true });

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

const mockSendPendingOutbox = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  sendPendingOutbox: mockSendPendingOutbox,
}));

process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/db';
process.env.MEDIA_BUCKET_NAME = 'jale-worker-media-test';
process.env.BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0';
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

function makeFencedBedrockResponse(fields: object, scores: object, summaryEn: string, summaryEs: string) {
  const json = JSON.stringify({
    extracted_fields: fields,
    confidence_scores: scores,
    summary_en: summaryEn,
    summary_es: summaryEs,
  });
  return {
    output: {
      message: {
        content: [{ text: `\`\`\`json\n${json}\n\`\`\`` }],
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockReturnValue({ query: mockQuery, release: mockRelease });
  mockQuery.mockResolvedValue({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  mockSendPendingOutbox.mockResolvedValue(undefined);
});

function outboxInserts() {
  return mockQuery.mock.calls.filter(([sql]: [string]) =>
    /INSERT INTO whatsapp_outbox/.test(sql)
  );
}

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
    inboundMessageSid: 'MMvoice-1',
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
  const outboxCalls = outboxInserts();
  expect(outboxCalls).toHaveLength(2);
  expect(outboxCalls[0][1][0]).toBe('MMvoice-1');
  expect(outboxCalls[0][1][3]).toContain('Profile created');
  expect(outboxCalls[1][1][3]).toContain('what is your full name');
  // Should have updated conversation state to building_profile with a pending field
  const convUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
    /UPDATE whatsapp_conversations/.test(sql) && /building_profile/.test(sql)
  );
  expect(convUpdate).toBeDefined();
  expect(convUpdate![1][1]).toContain('"pending_field":"full_name"');
  expect(mockSendPendingOutbox).toHaveBeenCalledWith(
    expect.objectContaining({ query: mockQuery }),
    'MMvoice-1',
  );
  const commitOrder = mockQuery.mock.invocationCallOrder[
    mockQuery.mock.calls.findIndex(([sql]) => sql === 'COMMIT')
  ];
  expect(commitOrder).toBeLessThan(mockSendPendingOutbox.mock.invocationCallOrder[0]);
});

test('handler writes failed extraction and falls back on failed status', async () => {
  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-failed',
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
  const outboxCalls = outboxInserts();
  expect(outboxCalls).toHaveLength(2);
  expect(outboxCalls[0][1][0]).toBe('MMvoice-failed');
  expect(outboxCalls[0][1][3]).toContain('No pudimos procesar');
  expect(outboxCalls[1][1][3]).toContain('nombre completo');
  expect(convUpdate![1][1]).toContain('"pending_field":"full_name"');
  expect(mockSendPendingOutbox).toHaveBeenCalledWith(
    expect.objectContaining({ query: mockQuery }),
    'MMvoice-failed',
  );
  const commitOrder = mockQuery.mock.invocationCallOrder[
    mockQuery.mock.calls.findIndex(([sql]) => sql === 'COMMIT')
  ];
  expect(commitOrder).toBeLessThan(mockSendPendingOutbox.mock.invocationCallOrder[0]);
});

test('does not flush outbox when the DB transaction fails', async () => {
  mockQuery
    .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
    .mockRejectedValueOnce(new Error('insert failed')); // failed extraction insert

  await expect(handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-db-fail',
    whatsappNumber: '+15125551234',
    language: 'es',
    status: 'failed',
  }, {} as any, () => {})).rejects.toThrow('insert failed');

  expect(mockSendPendingOutbox).not.toHaveBeenCalled();
  expect(mockQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
});

test('throws when outbox flush fails after commit without rolling back committed DB work', async () => {
  mockSendPendingOutbox.mockRejectedValueOnce(new Error('Twilio send failed 500'));

  await expect(handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-flush-fail',
    whatsappNumber: '+15125551234',
    language: 'es',
    status: 'failed',
  }, {} as any, () => {})).rejects.toThrow('Twilio send failed 500');

  expect(mockQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  expect(mockQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
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
    inboundMessageSid: 'MMvoice-2',
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

test('when AI fills all profile fields, handler upserts worker profile and completes if trust columns are missing', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('Complete worker profile'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    {
      full_name: 'Alex Worker',
      city: 'El Paso',
      main_trade: 'electrician',
      years_experience: '10+',
      has_transportation: true,
      availability: 'full_time',
    },
    {
      full_name: 0.95,
      city: 0.95,
      main_trade: 0.95,
      years_experience: 0.95,
      has_transportation: 0.95,
      availability: 0.95,
    },
    'Complete electrician profile.',
    'Perfil completo de electricista.',
  ));

  mockQuery.mockImplementation((sql: string) => {
    if (/SELECT cognito_sub FROM users/.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ cognito_sub: 'worker-sub' }] });
    }
    if (/SELECT full_name, city, main_trade/.test(sql)) {
      return Promise.resolve({
        rowCount: 1,
        rows: [{
          full_name: 'Alex Worker',
          city: 'El Paso',
          main_trade: 'electrician',
          main_trade_other: null,
          years_experience: '10+',
          has_transportation: true,
          availability: 'full_time',
        }],
      });
    }
    if (/information_schema\.columns/.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ exists: false }] });
    }
    if (/SELECT COALESCE\(MAX\(sequence\)/.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ next_seq: 1 }] });
    }
    return Promise.resolve({ rowCount: 1, rows: [] });
  });

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-complete',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-complete.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  const workerProfileUpsert = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profiles/.test(sql)
  );
  expect(workerProfileUpsert).toBeDefined();
  const idleUpdate = mockQuery.mock.calls.find(([sql, params]: [string, unknown[]]) =>
    /UPDATE whatsapp_conversations/.test(sql)
    && Array.isArray(params)
    && params.includes('MMvoice-complete')
    && /conversation_state = 'idle'/.test(sql)
  );
  expect(idleUpdate).toBeDefined();
  const outboxCalls = outboxInserts();
  expect(outboxCalls).toHaveLength(2);
  expect(outboxCalls[0][1][3]).toContain('Profile created');
  expect(outboxCalls[1][1][3]).toContain('Your profile is ready');
});

test('handler accepts Bedrock JSON wrapped in a markdown fence', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('Soy electricista en Austin'));
  mockBedrockSend.mockResolvedValue(makeFencedBedrockResponse(
    { city: 'Austin', main_trade: 'electrician' },
    { city: 0.9, main_trade: 0.95 },
    'Electrician in Austin.',
    'Electricista en Austin.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-3',
    whatsappNumber: '+15125551234',
    language: 'es',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-3.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(insertCall).toBeDefined();
});
