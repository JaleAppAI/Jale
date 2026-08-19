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

const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((args) => ({ input: args, __type: 'Invoke' })),
}));

const mockSqsSend = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn((args) => ({ input: args, __type: 'SendMessage' })),
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

const mockSendPendingOutbox = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  sendPendingOutbox: mockSendPendingOutbox,
}));

process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/db';
process.env.MEDIA_BUCKET_NAME = 'jale-worker-media-test';
process.env.BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0';
process.env.AI_EXTRACTION_CONFIDENCE_THRESHOLD = '0.75';
process.env.AI_INDUSTRY_KEYWORDS = '["electrician","plumber","carpenter"]';
process.env.QUESTION_GENERATOR_ARN = 'arn:aws:lambda:us-east-2:123:function:question-generator';
process.env.WHATSAPP_INBOUND_V2_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789012/whatsapp-inbound-v2.fifo';

import { handler } from '../../../../lambda/whatsapp/ai-profile-writer';
import { parseVoiceTranscriptEvent } from '../../../../lambda/whatsapp/lib/voice-events';

function makeTranscriptS3Response(text: string) {
  const json = JSON.stringify({ results: { transcripts: [{ transcript: text }] } });
  return {
    Body: {
      transformToString: jest.fn().mockResolvedValue(json),
    },
  };
}

/**
 * Regression fixture (T-transcription-language-id): Transcribe's output JSON
 * shape when a job runs with `IdentifyMultipleLanguages` — `results` carries
 * an additional `language_codes` array (per-segment identified languages)
 * alongside the SAME `transcripts[0].transcript` field the old hardcoded-
 * LanguageCode jobs always produced. `readTranscript` only ever reads
 * `results.transcripts[0].transcript`, so this extra field must be inert.
 */
function makeMultiLanguageTranscriptS3Response(text: string) {
  const json = JSON.stringify({
    results: {
      transcripts: [{ transcript: text }],
      language_codes: [
        { language_code: 'es-US', duration_in_seconds: 3.2 },
        { language_code: 'en-US', duration_in_seconds: 1.1 },
      ],
    },
  });
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

test('handler accepts VoiceTranscriptionPipeline completion envelope', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('I am a plumber in Denver'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { city: 'Denver', main_trade: 'plumber' },
    { city: 0.9, main_trade: 0.95 },
    'Plumber in Denver.',
    'Plomero en Denver.',
  ));

  await handler({
    status: 'COMPLETED',
    executionContext: {
      userId: 'user-1',
      conversationId: 'conv-1',
      inboundMessageSid: 'MMvoice-envelope',
      whatsappNumber: '+15125551234',
      language: 'en',
      mediaBucketName: 'jale-worker-media-test',
      transcriptOutputKey: 'user-1/transcripts/job-envelope.json',
    },
  }, {} as any, () => {});

  expect(mockS3Send).toHaveBeenCalledTimes(1);
  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  expect(outboxInserts()[0][1][0]).toBe('MMvoice-envelope');
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
  const mediaPhotoUpdate = mockQuery.mock.calls.find(([sql, params]: [string, unknown[]]) =>
    /UPDATE whatsapp_conversations/.test(sql)
    && Array.isArray(params)
    && params.includes('MMvoice-complete')
    && /conversation_state = 'awaiting_media_photo'/.test(sql)
  );
  expect(mediaPhotoUpdate).toBeDefined();
  const outboxCalls = outboxInserts();
  expect(outboxCalls).toHaveLength(3);
  expect(outboxCalls[0][1][3]).toContain('Profile created');
  expect(outboxCalls[1][1][3]).toContain('Your profile is ready');
  expect(outboxCalls[2][1][3]).toContain('Profile photo');
});

test('spanish voice profile with custom trade generates questions and asks first custom question', async () => {
  const customQuestions = [
    { q_en: 'What welding work do you do?', q_es: 'Que tipo de soldadura haces?' },
    { q_en: 'What is your welding level?', q_es: 'Cual es tu nivel en soldadura?' },
    { q_en: 'What welding tasks do you do most?', q_es: 'Que tareas de soldadura haces mas?' },
  ];
  mockS3Send.mockResolvedValue(makeTranscriptS3Response(
    'Me llamo Luis, vivo en Denver, soy soldador, tengo diez anos de experiencia, tengo transporte y busco tiempo completo.',
  ));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    {
      full_name: 'Luis Worker',
      city: 'Denver',
      main_trade: 'other',
      main_trade_other: 'Soldador',
      years_experience: '10+',
      has_transportation: true,
      availability: 'full_time',
    },
    {
      full_name: 0.95,
      city: 0.95,
      main_trade: 0.95,
      main_trade_other: 0.95,
      years_experience: 0.95,
      has_transportation: 0.95,
      availability: 0.95,
    },
    'Custom welding profile complete.',
    'Perfil de soldador completo.',
  ));
  mockLambdaSend.mockResolvedValue({
    Payload: Buffer.from(JSON.stringify(customQuestions)),
  });

  mockQuery.mockImplementation((sql: string) => {
    if (/SELECT cognito_sub FROM users/.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ cognito_sub: 'worker-sub' }] });
    }
    if (/SELECT full_name, city, main_trade/.test(sql)) {
      return Promise.resolve({
        rowCount: 1,
        rows: [{
          full_name: 'Luis Worker',
          city: 'Denver',
          main_trade: 'other',
          main_trade_other: 'Soldador',
          years_experience: '10+',
          has_transportation: true,
          availability: 'full_time',
        }],
      });
    }
    if (/SELECT id FROM worker_trust_assessments/.test(sql)) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    if (/SELECT questions FROM trade_questions/.test(sql)) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    if (/SELECT COALESCE\(MAX\(sequence\)/.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ next_seq: 1 }] });
    }
    return Promise.resolve({ rowCount: 1, rows: [] });
  });

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-custom-es',
    whatsappNumber: '+15125551234',
    language: 'es',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/custom-es.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  const invokeInput = mockLambdaSend.mock.calls[0][0].input;
  const payload = JSON.parse(Buffer.from(invokeInput.Payload).toString());
  expect(payload).toEqual({ professionKey: 'soldador', professionRaw: 'Soldador' });

  const customStateUpdate = mockQuery.mock.calls.find(([sql, params]: [string, unknown[]]) =>
    /UPDATE whatsapp_conversations/.test(sql)
    && (
      String(sql).includes("conversation_state = 'building_custom_trust'")
      || (Array.isArray(params) && params.includes('building_custom_trust'))
    )
  );
  expect(customStateUpdate).toBeDefined();
  const stateJson = (customStateUpdate![1] as unknown[]).find((value) =>
    typeof value === 'string' && value.includes('custom_trust_questions')
  );
  expect(JSON.parse(String(stateJson))).toMatchObject({
    custom_trust_step: 0,
    custom_trust_profession: 'Soldador',
    custom_trust_questions: customQuestions,
  });

  const outboxBodiesForCustomTrust = outboxInserts().map((call) => call[1][3]);
  expect(outboxBodiesForCustomTrust).toContain('Que tipo de soldadura haces?');
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

// ── Stream B (Task 8d): v2 profile-intake completion branch ─────────────
//
// A `v2` marker on the executionContext selects this branch: the SQL up
// through the worker_profile_ai_extractions INSERT is IDENTICAL to the v1
// path above (same queries, same params) — what changes is everything
// AFTER it: no `UPDATE users`, no `whatsapp_outbox` INSERT, no
// autoAdvanceProfileAfterAi call. Instead exactly one SQS SendMessage goes
// out, carrying a `#vp`-suffixed synthetic event the v2 router re-enters
// through.

function v2ExecutionContext(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    conversationId: 'run-abc',
    inboundMessageSid: 'MMvoice-v2-1',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-v2.json',
    voiceMessageMediaId: 'media-1',
    v2: {
      workflowRunId: 'run-abc',
      expectedStepKey: 'profile.voice_processing',
      startedAt: '2026-07-27T00:00:00.000Z',
    },
    ...overrides,
  };
}

test('v2 COMPLETED: writes the extraction row, enqueues exactly one #vp event, and touches NEITHER users NOR the outbox', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-v2-1' }] });
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('My name is Jose, I am a plumber'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { full_name: 'Jose', main_trade: 'plumber' },
    { full_name: 0.9, main_trade: 0.9 },
    'Jose, a plumber.',
    'Jose, un plomero.',
  ));

  await handler({
    status: 'COMPLETED',
    executionArn: 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-v2-1',
    executionContext: v2ExecutionContext(),
  } as any, {} as any, () => {});

  expect(mockS3Send).toHaveBeenCalledTimes(1);
  expect(mockBedrockSend).toHaveBeenCalledTimes(1);

  const extractionInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(extractionInsert).toBeDefined();
  expect(extractionInsert![0]).toMatch(/RETURNING id/);

  // NEVER touches users or the outbox on the v2 branch.
  expect(mockQuery.mock.calls.some(([sql]: [string]) => /UPDATE users/.test(sql))).toBe(false);
  expect(outboxInserts()).toHaveLength(0);
  expect(mockSendPendingOutbox).not.toHaveBeenCalled();

  expect(mockSqsSend).toHaveBeenCalledTimes(1);
  const sent = mockSqsSend.mock.calls[0][0].input;
  expect(sent.QueueUrl).toBe(process.env.WHATSAPP_INBOUND_V2_QUEUE_URL);
  expect(sent.MessageGroupId).toBeTruthy();
  expect(sent.MessageDeduplicationId).toBe('MMvoice-v2-1#vp');

  const params = Object.fromEntries(new URLSearchParams(sent.MessageBody));
  const evt = parseVoiceTranscriptEvent(params);
  expect(evt).not.toBeNull();
  expect(evt).toMatchObject({
    kind: 'profile_intake',
    status: 'COMPLETED',
    runId: 'run-abc',
    stepKey: 'profile.voice_processing',
    executionArn: 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-v2-1',
    extractionId: 'extraction-v2-1',
    fields: { full_name: 'Jose', main_trade: 'plumber' },
    summaryEn: 'Jose, a plumber.',
    summaryEs: 'Jose, un plomero.',
  });
});

// Task 8: the transaction is held open across S3/Bedrock calls, so
// publishing the #vp event BEFORE the COMMIT means a COMMIT failure leaves
// an event already delivered that references a rolled-back extractionId —
// FIFO dedup then blocks any correction from ever landing. The fix commits
// first, then publishes.
test('v2 COMPLETED: publishes the #vp event strictly AFTER COMMIT, never before', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-v2-order' }] });
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('My name is Jose, I am a plumber'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { full_name: 'Jose', main_trade: 'plumber' },
    { full_name: 0.9, main_trade: 0.9 },
    'Jose, a plumber.',
    'Jose, un plomero.',
  ));

  await handler({
    status: 'COMPLETED',
    executionArn: 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-v2-order',
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-v2-order' }),
  } as any, {} as any, () => {});

  const commitCallIndex = mockQuery.mock.calls.findIndex(([sql]: [string]) => sql === 'COMMIT');
  expect(commitCallIndex).toBeGreaterThanOrEqual(0);
  const commitOrder = mockQuery.mock.invocationCallOrder[commitCallIndex];
  expect(mockSqsSend).toHaveBeenCalledTimes(1);
  const sqsOrder = mockSqsSend.mock.invocationCallOrder[0];
  expect(sqsOrder).toBeGreaterThan(commitOrder);
});

test('v2 COMPLETED: a COMMIT failure publishes no event and never rolls back (the row already exists)', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-v2-commitfail' }] });
    }
    if (sql === 'COMMIT') {
      return Promise.reject(new Error('commit failed'));
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('My name is Jose, I am a plumber'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { full_name: 'Jose', main_trade: 'plumber' },
    { full_name: 0.9, main_trade: 0.9 },
    'Jose, a plumber.',
    'Jose, un plomero.',
  ));

  await expect(handler({
    status: 'COMPLETED',
    executionArn: 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-v2-commitfail',
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-v2-commitfail' }),
  } as any, {} as any, () => {})).rejects.toThrow('commit failed');

  // The publish call sits strictly AFTER `await client.query('COMMIT')` —
  // when that await itself rejects, execution never reaches the publish
  // line (nor the `committed = true` marker), so no event is ever sent for
  // a transaction that never actually committed.
  expect(mockSqsSend).not.toHaveBeenCalled();
});

// Pins the rollback/release path through the pre-transaction restructure
// (Task A): the extraction row is written and executionArn is checked
// AFTER `BEGIN`/`setWorkerRlsContextByUserId`, so a missing executionArn on
// COMPLETED still throws from inside the open transaction — `committed`
// never flips to true, so the outer catch issues ROLLBACK (never COMMIT),
// no #vp event is ever published, and the client is released in `finally`
// regardless. Mirrors voice-trust-receiver.test.ts's "throws when
// executionArn is missing" case for the same contract.
test('v2 COMPLETED: missing executionArn throws, rolls back (never commits), publishes no event, and releases the client', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-v2-noarn' }] });
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('My name is Jose, I am a plumber'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { full_name: 'Jose', main_trade: 'plumber' },
    { full_name: 0.9, main_trade: 0.9 },
    'Jose, a plumber.',
    'Jose, un plomero.',
  ));

  await expect(handler({
    status: 'COMPLETED',
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-v2-noarn' }),
  } as any, {} as any, () => {})).rejects.toThrow(/executionArn missing/);

  expect(mockQuery.mock.calls.some(([sql]: [string]) => sql === 'COMMIT')).toBe(false);
  expect(mockQuery.mock.calls.some(([sql]: [string]) => sql === 'ROLLBACK')).toBe(true);
  expect(mockSqsSend).not.toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalled();
});

test('v2 FAILED: writes a failed extraction row and enqueues a FAILED #vp event, still no users/outbox writes', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-v2-2' }] });
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });

  await handler({
    status: 'FAILED',
    executionArn: 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-v2-2',
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-v2-2' }),
  } as any, {} as any, () => {});

  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockBedrockSend).not.toHaveBeenCalled();
  expect(mockQuery.mock.calls.some(([sql]: [string]) => /UPDATE users/.test(sql))).toBe(false);
  expect(outboxInserts()).toHaveLength(0);
  expect(mockSendPendingOutbox).not.toHaveBeenCalled();

  expect(mockSqsSend).toHaveBeenCalledTimes(1);
  const sent = mockSqsSend.mock.calls[0][0].input;
  expect(sent.MessageDeduplicationId).toBe('MMvoice-v2-2#vp');
  const params = Object.fromEntries(new URLSearchParams(sent.MessageBody));
  const evt = parseVoiceTranscriptEvent(params);
  expect(evt).toMatchObject({ kind: 'profile_intake', status: 'FAILED', fields: null, extractionId: 'extraction-v2-2' });
});

// Same rollback/release contract as the COMPLETED case above, for the
// FAILED branch's own executionArn check (ai-profile-writer.ts:505-507).
test('v2 FAILED: missing executionArn throws, rolls back (never commits), publishes no event, and releases the client', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-v2-failnoarn' }] });
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });

  await expect(handler({
    status: 'FAILED',
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-v2-failnoarn' }),
  } as any, {} as any, () => {})).rejects.toThrow(/executionArn missing/);

  expect(mockS3Send).not.toHaveBeenCalled();
  expect(mockBedrockSend).not.toHaveBeenCalled();
  expect(mockQuery.mock.calls.some(([sql]: [string]) => sql === 'COMMIT')).toBe(false);
  expect(mockQuery.mock.calls.some(([sql]: [string]) => sql === 'ROLLBACK')).toBe(true);
  expect(mockSqsSend).not.toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalled();
});

test('v1 legacy path is byte-identical (no v2 marker => no SQS send, users/outbox writes unchanged)', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('I am an electrician in Austin'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { city: 'Austin', main_trade: 'electrician' },
    { city: 0.9, main_trade: 0.95 },
    'Electrician in Austin.',
    'Electricista en Austin.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-v1-parity',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-v1-parity.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  expect(mockSqsSend).not.toHaveBeenCalled();
  expect(mockQuery.mock.calls.some(([sql]: [string]) => /UPDATE users/.test(sql))).toBe(true);
  expect(outboxInserts().length).toBeGreaterThan(0);
});

test('a transcript with results.language_codes (multi-language job output) parses identically to a single-language one, with a detected-language ASR metadata line added', async () => {
  mockS3Send.mockResolvedValue(makeMultiLanguageTranscriptS3Response('I am an electrician in Austin with 5 years experience'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { city: 'Austin', main_trade: 'electrician', years_experience: '5-9' },
    { city: 0.9, main_trade: 0.95, years_experience: 0.85 },
    'Electrician in Austin with 5+ years experience.',
    'Electricista en Austin con más de 5 años de experiencia.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-lang-codes',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-lang-codes.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  expect(mockS3Send).toHaveBeenCalledTimes(1);
  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  // Task A (new contract): the raw language_codes JSON shape must never
  // reach Bedrock verbatim — only the shared transcript.ts parser's
  // derived `languages` array, rendered as a plain calibration line.
  const converseInput = (mockBedrockSend.mock.calls[0][0] as any).input;
  const promptText = JSON.stringify(converseInput);
  expect(promptText).toContain('I am an electrician in Austin with 5 years experience');
  expect(promptText).not.toContain('language_codes');
  expect(promptText).toContain('Detected language(s): es-US, en-US');

  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(insertCall).toBeDefined();
});

// ── Task A: empty-transcript guard + ASR-metadata prompt block + quality logs ──

function makeTranscribeItemsS3Response(text: string, items: Array<{ w: string; conf: string | undefined; type?: string }>) {
  const json = JSON.stringify({
    results: {
      transcripts: [{ transcript: text }],
      items: items.map((item) => ({
        type: item.type ?? 'pronunciation',
        alternatives: [{ content: item.w, ...(item.conf === undefined ? {} : { confidence: item.conf }) }],
      })),
    },
  });
  return {
    Body: {
      transformToString: jest.fn().mockResolvedValue(json),
    },
  };
}

function makeEmptyTranscriptS3Response() {
  const json = JSON.stringify({ results: { transcripts: [{ transcript: '   ' }] } });
  return {
    Body: {
      transformToString: jest.fn().mockResolvedValue(json),
    },
  };
}

test('empty transcript on the v2 lane degrades to FAILED: writes a failed extraction row and a FAILED #vp event', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-empty-v2' }] });
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });
  mockS3Send.mockResolvedValue(makeEmptyTranscriptS3Response());

  await handler({
    status: 'COMPLETED',
    executionArn: 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-empty',
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-empty' }),
  } as any, {} as any, () => {});

  expect(mockBedrockSend).not.toHaveBeenCalled();
  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(insertCall).toBeDefined();
  expect(insertCall![0]).toContain("'failed'");

  expect(mockSqsSend).toHaveBeenCalledTimes(1);
  const sent = mockSqsSend.mock.calls[0][0].input;
  expect(sent.MessageDeduplicationId).toBe('MMvoice-empty#vp');
  const params = Object.fromEntries(new URLSearchParams(sent.MessageBody));
  const evt = parseVoiceTranscriptEvent(params);
  expect(evt).toMatchObject({ kind: 'profile_intake', status: 'FAILED', fields: null, extractionId: 'extraction-empty-v2' });
});

test('an S3 GetObject rejection on the v2 lane degrades to FAILED: writes a failed extraction row and a FAILED #vp event', async () => {
  mockQuery.mockImplementation((sql: string) => {
    if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'extraction-s3err-v2' }] });
    }
    return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
  });
  mockS3Send.mockRejectedValue(new Error('S3 unavailable'));

  await handler({
    status: 'COMPLETED',
    executionArn: 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-s3err',
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-s3err' }),
  } as any, {} as any, () => {});

  expect(mockBedrockSend).not.toHaveBeenCalled();
  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(insertCall).toBeDefined();
  expect(insertCall![0]).toContain("'failed'");

  expect(mockSqsSend).toHaveBeenCalledTimes(1);
  const sent = mockSqsSend.mock.calls[0][0].input;
  expect(sent.MessageDeduplicationId).toBe('MMvoice-s3err#vp');
  const params = Object.fromEntries(new URLSearchParams(sent.MessageBody));
  const evt = parseVoiceTranscriptEvent(params);
  expect(evt).toMatchObject({ kind: 'profile_intake', status: 'FAILED', fields: null, extractionId: 'extraction-s3err-v2' });
});

test('empty transcript on the v1 legacy lane degrades to FAILED: queues the ai_extraction_failed outbox message', async () => {
  mockS3Send.mockResolvedValue(makeEmptyTranscriptS3Response());

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-empty-v1',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-empty.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  expect(mockBedrockSend).not.toHaveBeenCalled();
  const outboxCalls = outboxInserts();
  expect(outboxCalls.length).toBeGreaterThan(0);
  expect(outboxCalls[0][1][3]).toContain("We could not process your voice message");
  expect(mockSendPendingOutbox).toHaveBeenCalled();
});

test('never logs the transcript text on an empty-transcript or S3-error degrade', async () => {
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockS3Send.mockResolvedValue(makeEmptyTranscriptS3Response());

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-empty-log',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-empty-log.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  const logged = logSpy.mock.calls.map(([msg]) => String(msg)).join('\n');
  expect(logged).toContain('AiProfileWriterTranscriptReadFailed');
  expect(logged).toContain('empty_transcript');
  logSpy.mockRestore();
});

test('low-confidence words (conf < 0.5) appear in the ASR metadata prompt block, in transcript order, 2-decimal formatted', async () => {
  mockS3Send.mockResolvedValue(makeTranscribeItemsS3Response('troca rufero good electrician', [
    { w: 'troca', conf: '0.41' },
    { w: 'rufero', conf: '0.38' },
    { w: 'good', conf: '0.9' },
    { w: 'electrician', conf: '0.95' },
  ]));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { main_trade: 'electrician' },
    { main_trade: 0.9 },
    'Summary.',
    'Resumen.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-lowconf',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-lowconf.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  const converseInput = (mockBedrockSend.mock.calls[0][0] as any).input;
  const promptText = JSON.stringify(converseInput);
  expect(promptText).toContain('Possibly mistranscribed words');
  expect(promptText).toContain('\\"troca\\" (0.41)');
  expect(promptText).toContain('\\"rufero\\" (0.38)');
  // High-confidence words must never appear in the mistranscribed list.
  expect(promptText).not.toMatch(/"good" \(0\.9/);
  expect(promptText).not.toMatch(/"electrician" \(0\.9/);
});

test('no ASR metadata block is added to the prompt when the transcript has no items', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('I am an electrician'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { main_trade: 'electrician' },
    { main_trade: 0.9 },
    'Summary.',
    'Resumen.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-nometa',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-nometa.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  const converseInput = (mockBedrockSend.mock.calls[0][0] as any).input;
  const promptText = JSON.stringify(converseInput);
  // The system prompt always carries the one-sentence calibration
  // instruction (spec 3c); only the USER prompt's metadata block itself is
  // conditional on data existing. Assert the header/lines that only ever
  // appear in that block are absent, not the word "ASR metadata" generally.
  expect(promptText).not.toContain('ASR metadata (calibration only, do not extract from it)');
  expect(promptText).not.toContain('Possibly mistranscribed words');
  expect(promptText).not.toContain('Detected language');
  expect(promptText).not.toContain('Overall transcription confidence');
});

test('caps the mistranscribed-words list at 10, in transcript order', async () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ w: `word${i}`, conf: '0.10' }));
  mockS3Send.mockResolvedValue(makeTranscribeItemsS3Response('fifteen low confidence words', items));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { main_trade: 'electrician' },
    { main_trade: 0.9 },
    'Summary.',
    'Resumen.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-cap10',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-cap10.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  const converseInput = (mockBedrockSend.mock.calls[0][0] as any).input;
  const promptText = JSON.stringify(converseInput);
  for (let i = 0; i < 10; i++) {
    expect(promptText).toContain(`word${i}`);
  }
  for (let i = 10; i < 15; i++) {
    expect(promptText).not.toContain(`word${i}`);
  }
});

test('asr_metadata is present in the completed extraction INSERT params', async () => {
  mockS3Send.mockResolvedValue(makeTranscribeItemsS3Response('troca is a truck', [
    { w: 'troca', conf: '0.41' },
    { w: 'is', conf: '0.95' },
    { w: 'a', conf: '0.9' },
    { w: 'truck', conf: '0.92' },
  ]));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { main_trade: 'electrician' },
    { main_trade: 0.9 },
    'Summary.',
    'Resumen.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-asrmeta',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-asrmeta.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql) && /'completed'/.test(sql)
  );
  expect(insertCall).toBeDefined();
  expect(insertCall![0]).toContain('asr_metadata');
  const params = insertCall![1] as unknown[];
  const asrMetadataParam = params[params.length - 1] as string;
  expect(asrMetadataParam).not.toBeNull();
  const parsed = JSON.parse(asrMetadataParam);
  expect(parsed).toMatchObject({
    provider: 'transcribe',
    word_count: 4,
    low_confidence_word_count: 1,
  });
});

test('asr_metadata is NULL in the failed extraction INSERT params when the transcript was never read', async () => {
  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-nulasr',
    whatsappNumber: '+15125551234',
    language: 'es',
    status: 'failed',
    errorMessage: 'TranscribeJobFailed',
  }, {} as any, () => {});

  const insertCall = mockQuery.mock.calls.find(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql)
  );
  expect(insertCall).toBeDefined();
  expect(insertCall![0]).toContain('asr_metadata');
  const params = insertCall![1] as unknown[];
  expect(params[params.length - 1]).toBeNull();
});
