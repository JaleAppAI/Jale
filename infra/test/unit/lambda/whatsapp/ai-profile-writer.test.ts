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
process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
process.env.AI_EXTRACTION_CONFIDENCE_THRESHOLD = '0.75';
process.env.AI_INDUSTRY_KEYWORDS = '["electrician","plumber","carpenter"]';
process.env.QUESTION_GENERATOR_ARN = 'arn:aws:lambda:us-east-2:123:function:question-generator';
process.env.WHATSAPP_INBOUND_V2_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789012/whatsapp-inbound-v2.fifo';

import { handler } from '../../../../lambda/whatsapp/ai-profile-writer';
import { parseVoiceTranscriptEvent } from '../../../../lambda/whatsapp/lib/voice-events';
import { TRADE_KEYS, EXPERIENCE_KEYS, AVAILABILITY_KEYS } from '../../../../lambda/lib/worker-vocab';

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
  // Should have inserted whatsapp_outbox row. Sprint 22 R1-A: the SECOND row
  // (and the `building_profile` conversation-state advance that produced it)
  // came from `autoAdvanceProfileAfterAi`, which is deleted along with the v1
  // trust lane it fed. The extraction summary is all this branch queues now.
  const outboxCalls = outboxInserts();
  expect(outboxCalls).toHaveLength(1);
  expect(outboxCalls[0][1][0]).toBe('MMvoice-1');
  expect(outboxCalls[0][1][3]).toContain('Profile created');
  expect(mockQuery.mock.calls.find(([sql]: [string]) =>
    /UPDATE whatsapp_conversations/.test(sql) && /building_profile/.test(sql)
  )).toBeUndefined();
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
  // Sprint 22 R1-A: no `building_profile` advance any more — see the success
  // test above. The failure notice is the only outbox row.
  expect(mockQuery.mock.calls.find(([sql]: [string]) =>
    /UPDATE whatsapp_conversations/.test(sql) && /building_profile/.test(sql)
  )).toBeUndefined();
  const outboxCalls = outboxInserts();
  expect(outboxCalls).toHaveLength(1);
  expect(outboxCalls[0][1][0]).toBe('MMvoice-failed');
  expect(outboxCalls[0][1][3]).toContain('No pudimos procesar');
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

// Sprint 22 R1-A: two tests lived here — "when AI fills all profile fields,
// handler upserts worker profile and completes if trust columns are missing"
// and "spanish voice profile with custom trade generates questions and asks
// first custom question". Both exercised `autoAdvanceProfileAfterAi`, the v1
// `building_profile` -> `building_trust_signal` / `building_custom_trust`
// hand-off, which is deleted along with the numbered trust menu it fed.

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

// ── Vocabulary <-> extraction-prompt coupling ──────────────────────
//
// The user prompt tells the model which values it may return for main_trade,
// years_experience and availability. Those three arrays are rendered from
// `lib/worker-vocab` (the same tuples `buildUserUpdateSql` validates against),
// so they cannot drift apart -- but they CAN both change silently, and a
// reordered or renamed key reaching Bedrock is invisible until the model
// starts returning values the DB CHECK constraint rejects. This pins the
// rendered fragments, in order.
test('the extraction prompt lists the worker-vocab options, in vocabulary order', async () => {
  mockS3Send.mockResolvedValue(makeTranscriptS3Response('I am an electrician in Austin with 5 years experience'));
  mockBedrockSend.mockResolvedValue(makeBedrockResponse(
    { city: 'Austin', main_trade: 'electrician' },
    { city: 0.9, main_trade: 0.95 },
    'Electrician in Austin.',
    'Electricista en Austin.',
  ));

  await handler({
    userId: 'user-1',
    conversationId: 'conv-1',
    inboundMessageSid: 'MMvoice-vocab',
    whatsappNumber: '+15125551234',
    language: 'en',
    mediaBucketName: 'jale-worker-media-test',
    transcriptOutputKey: 'user-1/transcripts/job-vocab.json',
    status: 'transcription_complete',
  }, {} as any, () => {});

  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  const converseInput = (mockBedrockSend.mock.calls[0][0] as any).input;
  const userPrompt = converseInput.messages[0].content[0].text as string;

  expect(userPrompt).toContain(`"main_trade": one of ${JSON.stringify(TRADE_KEYS)} or null`);
  expect(userPrompt).toContain(`"years_experience": one of ${JSON.stringify(EXPERIENCE_KEYS)} or null`);
  expect(userPrompt).toContain(`"availability": one of ${JSON.stringify(AVAILABILITY_KEYS)} or null`);

  // Belt and braces: the literal text as it shipped before the vocabularies
  // were centralised, so this fails if worker-vocab itself is reordered.
  expect(userPrompt).toContain('"main_trade": one of ["electrician","plumber","carpenter","concrete","painting","other"] or null');
  expect(userPrompt).toContain('"years_experience": one of ["0-1","2-4","5-9","10+"] or null');
  expect(userPrompt).toContain('"availability": one of ["full_time","part_time","weekends","flexible"] or null');
});

// ── L6: a voice-extracted custom trade is canonicalised ─────────────
describe('custom trade canonicalisation (v1 voice path)', () => {
  const WELDER = { trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null };
  const ELECTRICIAN = { trade_key: 'electrician', canonical_en: 'Electrician', canonical_es: 'Electricista', trade_category: 'electrician' };

  /** Answers the one `trade_aliases` SELECT and records query order so the
   * pre-BEGIN placement of that lookup is observable. */
  function seedQueries(aliasRow?: Record<string, unknown>) {
    const order: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM trade_aliases/.test(sql)) {
        order.push('alias');
        return Promise.resolve({ rows: aliasRow ? [aliasRow] : [], rowCount: aliasRow ? 1 : 0 });
      }
      if (sql === 'BEGIN') order.push('BEGIN');
      if (/UPDATE users/.test(sql)) order.push('users');
      return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
    });
    return order;
  }

  function run(lang: 'en' | 'es') {
    return handler({
      userId: 'user-1',
      conversationId: 'conv-1',
      inboundMessageSid: 'MMvoice-trade',
      whatsappNumber: '+15125551234',
      language: lang,
      mediaBucketName: 'jale-worker-media-test',
      transcriptOutputKey: 'user-1/transcripts/job-trade.json',
      status: 'transcription_complete',
    } as any, {} as any, () => {});
  }

  function seedExtraction(fields: object, scores: object) {
    mockS3Send.mockResolvedValue(makeTranscriptS3Response('soy soldador'));
    mockBedrockSend.mockResolvedValue(makeBedrockResponse(fields, scores, 'Summary.', 'Resumen.'));
  }

  const usersUpdate = () =>
    mockQuery.mock.calls.find(([sql]: [string]) => /UPDATE users/.test(sql));

  beforeEach(() => {
    process.env.ALIAS_GENERATOR_ARN = 'arn:aws:lambda:us-east-2:123:function:alias-generator';
    mockLambdaSend.mockResolvedValue({});
  });
  afterAll(() => { delete process.env.ALIAS_GENERATOR_ARN; });

  it('writes the canonical Spanish name for a resolved custom trade', async () => {
    seedQueries(WELDER);
    seedExtraction({ main_trade_other: 'soldador' }, { main_trade_other: 0.9 });

    await run('es');

    const [sql, params] = usersUpdate()!;
    expect(sql).toContain('main_trade');
    expect(sql).toContain('main_trade_other');
    expect(params).toContain('other');
    expect(params).toContain('Soldador');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('writes the canonical English name when the worker speaks English', async () => {
    seedQueries(WELDER);
    seedExtraction({ main_trade_other: 'soldador' }, { main_trade_other: 0.9 });

    await run('en');

    expect(usersUpdate()![1]).toContain('Welder');
  });

  it('promotes a standard trade and CLEARS the stale free text', async () => {
    seedQueries(ELECTRICIAN);
    seedExtraction({ main_trade_other: 'electricista' }, { main_trade_other: 0.9 });

    await run('es');

    const [sql, params] = usersUpdate()!;
    // Both columns are forced, so main_trade_other cannot keep a stale
    // spelling next to the promoted enum key (maybeAdd would skip a null).
    expect(sql).toMatch(/main_trade = \$\d+/);
    expect(sql).toMatch(/main_trade_other = \$\d+/);
    expect(params).toContain('electrician');
    expect(params).toContain(null);
    expect(params).not.toContain('electricista');
  });

  it('tidies an unresolved trade and asks the generator to learn it', async () => {
    seedQueries();
    seedExtraction({ main_trade_other: '  soldador   de arco ' }, { main_trade_other: 0.9 });

    await run('es');

    expect(usersUpdate()![1]).toContain('Soldador de arco');
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString());
    expect(payload).toEqual({ tradeKey: 'soldador de arco', tradeRaw: 'Soldador de arco' });
  });

  it('a high-confidence STANDARD main_trade wins over free text — never discarded', async () => {
    // The extractor answers `main_trade` with an enum key OR falls back to
    // free text. When it gave a confident enum answer, canonicalising the
    // free text over it would throw a valid standard trade away.
    const order = seedQueries(WELDER);
    seedExtraction(
      { main_trade: 'plumber', main_trade_other: 'soldador' },
      { main_trade: 0.95, main_trade_other: 0.9 },
    );

    await run('es');

    expect(order).not.toContain('alias');
    const params = usersUpdate()![1];
    expect(params).toContain('plumber');
    expect(params).not.toContain('Soldador');
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('canonicalises the free text when main_trade is itself "other"', async () => {
    seedQueries(WELDER);
    seedExtraction(
      { main_trade: 'other', main_trade_other: 'soldador' },
      { main_trade: 0.95, main_trade_other: 0.9 },
    );

    await run('es');

    expect(usersUpdate()![1]).toContain('Soldador');
  });

  it('canonicalises the free text when a standard main_trade is low-confidence', async () => {
    seedQueries(WELDER);
    seedExtraction(
      { main_trade: 'plumber', main_trade_other: 'soldador' },
      { main_trade: 0.4, main_trade_other: 0.9 },
    );

    await run('es');

    const params = usersUpdate()![1];
    expect(params).toContain('Soldador');
    expect(params).not.toContain('plumber');
  });

  it('ignores a low-confidence trade: no lookup, no trade write', async () => {
    const order = seedQueries(WELDER);
    seedExtraction({ main_trade_other: 'soldador' }, { main_trade_other: 0.3 });

    await run('es');

    expect(order).not.toContain('alias');
    expect(usersUpdate()).toBeUndefined();
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('resolves the alias BEFORE opening the transaction', async () => {
    const order = seedQueries(WELDER);
    seedExtraction({ main_trade_other: 'soldador' }, { main_trade_other: 0.9 });

    await run('es');

    expect(order.indexOf('alias')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('alias')).toBeLessThan(order.indexOf('BEGIN'));
  });

  it('still writes the raw text when the alias lookup fails', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM trade_aliases/.test(sql)) return Promise.reject(new Error('relation missing'));
      return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
    });
    seedExtraction({ main_trade_other: 'soldador' }, { main_trade_other: 0.9 });

    await run('es');

    expect(usersUpdate()![1]).toContain('Soldador');
  });
});

// ── 2c (Ops health): every failed row records why it failed ─────────────
//
// `worker_profile_ai_extractions.failure_kind` (migration 115) is what the
// admin Ops page groups failures by. Model / JSON / shape failures are caught
// in-Lambda (no throw, so the state machine no longer re-invokes this lambda
// for them). A FAILED invocation from the pipeline is `transcribe` unless the
// Transcribe job had already COMPLETED: the only state that runs after a
// COMPLETED job is InvokeOnCompleted, so its catch means this lambda failed.

const VP_EXECUTION_ARN = 'arn:aws:states:us-east-2:123456789012:execution:profile-voice-pipeline:vp-MMvoice-2c';
const VP_TRANSCRIPT = 'My name is Jose, I am a plumber in Denver';

/** An extraction INSERT as a column -> value map, so assertions never depend
 * on parameter order: `$n` is bound, quoted literals are unquoted, and the
 * failed row's media guard `(SELECT m.id FROM worker_profile_media m WHERE
 * m.id = $n)` resolves as Postgres would — the id when it is one of
 * `existingMediaIds`, otherwise NULL. */
function insertedRow(sql: string, params: unknown[], existingMediaIds: string[]): Record<string, unknown> {
  const [, columnList, valueList] = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*RETURNING/)!;
  const columns = columnList.split(',').map((column) => column.trim());
  const values = valueList.split(',').map((value) => value.trim());
  expect(values).toHaveLength(columns.length);
  return Object.fromEntries(columns.map((column, i) => {
    const placeholder = values[i].match(/^\$(\d+)$/);
    if (placeholder) return [column, params[Number(placeholder[1]) - 1]];
    const mediaGuard = values[i].match(/^\(SELECT m\.id FROM worker_profile_media m WHERE m\.id = \$(\d+)\)$/);
    if (mediaGuard) {
      const mediaId = params[Number(mediaGuard[1]) - 1];
      return [column, existingMediaIds.includes(mediaId as string) ? mediaId : null];
    }
    return [column, values[i].replace(/^'(.*)'$/, '$1')];
  }));
}

/** The one extraction INSERT this invocation made, as a column -> value map
 * (`media-1`, the fixture's voice note, exists unless told otherwise). */
function extractionInsertRow(existingMediaIds: string[] = ['media-1']): Record<string, unknown> {
  const inserts = mockQuery.mock.calls.filter(([sql]: [string]) =>
    /INSERT INTO worker_profile_ai_extractions/.test(sql),
  );
  expect(inserts).toHaveLength(1);
  const [sql, params] = inserts[0] as [string, unknown[]];
  return insertedRow(sql, params, existingMediaIds);
}

/** The FAILED #vp event: unchanged contract, whatever the cause. */
function expectFailedVpEvent(extractionId: string) {
  expect(mockSqsSend).toHaveBeenCalledTimes(1);
  const params = Object.fromEntries(new URLSearchParams(mockSqsSend.mock.calls[0][0].input.MessageBody));
  expect(parseVoiceTranscriptEvent(params)).toEqual({
    version: 'v2',
    kind: 'profile_intake',
    status: 'FAILED',
    phone: '+15125551234',
    runId: 'run-abc',
    stepKey: 'profile.voice_processing',
    language: 'en',
    origMessageSid: 'MMvoice-2c',
    startedAt: '2026-07-27T00:00:00.000Z',
    executionArn: VP_EXECUTION_ARN,
    extractionId,
    fields: null,
    confidences: null,
    summaryEn: null,
    summaryEs: null,
  });
}

function makeBedrockTextResponse(text: string) {
  return { output: { message: { content: [{ text }] } } };
}

function runVoicePipeline(status: 'COMPLETED' | 'FAILED', contextOverrides: Record<string, unknown> = {}) {
  return handler({
    status,
    executionArn: VP_EXECUTION_ARN,
    executionContext: v2ExecutionContext({ inboundMessageSid: 'MMvoice-2c', ...contextOverrides }),
  } as any, {} as any, () => {});
}

describe('failure_kind on every failed extraction row (2c)', () => {
  beforeEach(() => {
    mockQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'extraction-2c' }] });
      }
      return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
    });
  });

  describe('FAILED invocations from the voice pipeline', () => {
    it('records transcribe when the Transcribe job reported FAILED (no caught error)', async () => {
      await runVoicePipeline('FAILED', {
        transcribeStatus: { TranscriptionJob: { TranscriptionJobStatus: 'FAILED' } },
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(extractionInsertRow()).toEqual({
        user_id: 'user-1',
        voice_message_media_id: 'media-1',
        bedrock_model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        status: 'failed',
        failure_kind: 'transcribe',
        asr_metadata: null,
      });
      expectFailedVpEvent('extraction-2c');
    });

    it.each([
      ['the StartTranscribeJob catch (no poll yet)', {
        error: { Error: 'Transcribe.BadRequestException', Cause: 'The requested job name already exists.' },
      }],
      ['the GetTranscribeJob catch (job still IN_PROGRESS)', {
        transcribeStatus: { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } },
        error: { Error: 'Transcribe.LimitExceededException', Cause: 'Rate exceeded' },
      }],
      ['the GetTranscribeJob catch with a States.* error (job still QUEUED)', {
        transcribeStatus: { TranscriptionJob: { TranscriptionJobStatus: 'QUEUED' } },
        error: { Error: 'States.TaskFailed', Cause: 'Service call failed' },
      }],
    ])('records transcribe for an error caught at %s', async (_label, context) => {
      await runVoicePipeline('FAILED', context);

      expect(extractionInsertRow()).toMatchObject({
        status: 'failed',
        failure_kind: 'transcribe',
        voice_message_media_id: 'media-1',
        asr_metadata: null,
      });
      expectFailedVpEvent('extraction-2c');
    });

    it.each([
      ['threw', { Error: 'Error', Cause: '{"errorType":"Error","errorMessage":"commit failed"}' }],
      ['timed out', { Error: 'Sandbox.Timedout', Cause: 'Task timed out after 60.00 seconds' }],
    ])('records pipeline_error when this lambda %s after Transcribe COMPLETED (the InvokeOnCompleted catch)', async (_label, error) => {
      await runVoicePipeline('FAILED', {
        transcribeStatus: { TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED' } },
        error,
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(extractionInsertRow()).toEqual({
        user_id: 'user-1',
        voice_message_media_id: 'media-1',
        bedrock_model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        status: 'failed',
        failure_kind: 'pipeline_error',
        asr_metadata: null,
      });
      expectFailedVpEvent('extraction-2c');
    });

    it('still writes the failed row (media id NULL) and sends the FAILED event when the media row was never committed', async () => {
      // A processor turn that rolled back after StartExecution leaves the
      // running execution holding a media id with no committed row; the
      // completed INSERT then fails the foreign key and the InvokeOnCompleted
      // catch lands here. The mock enforces the same foreign key.
      mockQuery.mockImplementation((sql: string, params: unknown[]) => {
        if (/INSERT INTO worker_profile_ai_extractions/.test(sql)) {
          if (insertedRow(sql, params, []).voice_message_media_id != null) {
            return Promise.reject(Object.assign(
              new Error('insert or update on table "worker_profile_ai_extractions" violates foreign key constraint'),
              { code: '23503' },
            ));
          }
          return Promise.resolve({ rows: [{ id: 'extraction-2c' }] });
        }
        return Promise.resolve({ rows: [{ next_seq: 1, cognito_sub: 'worker-sub' }], rowCount: 1 });
      });

      await expect(runVoicePipeline('FAILED', {
        voiceMessageMediaId: 'media-rolled-back',
        transcribeStatus: { TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED' } },
        error: { Error: 'error', Cause: '{"errorType":"error","errorMessage":"violates foreign key constraint"}' },
      })).resolves.toBeUndefined();

      expect(extractionInsertRow([])).toMatchObject({
        status: 'failed',
        failure_kind: 'pipeline_error',
        voice_message_media_id: null,
      });
      expectFailedVpEvent('extraction-2c');
    });

    it('never logs or stores the caught error name or cause', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await runVoicePipeline('FAILED', {
        transcribeStatus: { TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED' } },
        error: { Error: 'Sandbox.Timedout', Cause: '{"errorType":"Error","errorMessage":"commit failed"}' },
      });

      const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.map(String).join(' '))
        .join('\n');
      expect(logged).toContain('"metric":"AiProfileWriterExtractionFailed","failureKind":"pipeline_error"');
      const written = JSON.stringify([mockQuery.mock.calls, mockSqsSend.mock.calls]);
      for (const text of ['commit failed', 'Sandbox.Timedout']) {
        expect(logged).not.toContain(text);
        expect(written).not.toContain(text);
      }
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('records transcribe for a legacy-shaped failed event', async () => {
      await handler({
        userId: 'user-1',
        conversationId: 'conv-1',
        inboundMessageSid: 'MMvoice-legacy-2c',
        whatsappNumber: '+15125551234',
        language: 'es',
        status: 'failed',
        errorMessage: 'TranscribeJobFailed',
      }, {} as any, () => {});

      expect(extractionInsertRow()).toMatchObject({ status: 'failed', failure_kind: 'transcribe' });
    });
  });

  describe('failures caught inside the lambda', () => {
    it('records empty_transcript, keeping asr_metadata', async () => {
      mockS3Send.mockResolvedValue(makeEmptyTranscriptS3Response());

      await expect(runVoicePipeline('COMPLETED')).resolves.toBeUndefined();

      expect(mockBedrockSend).not.toHaveBeenCalled();
      const row = extractionInsertRow();
      expect(row).toMatchObject({
        status: 'failed',
        failure_kind: 'empty_transcript',
        voice_message_media_id: 'media-1',
      });
      expect(row).not.toHaveProperty('transcript_text');
      expect(JSON.parse(row.asr_metadata as string)).toMatchObject({ provider: 'transcribe' });
      expectFailedVpEvent('extraction-2c');
    });

    it('records audio_read when the transcript cannot be read (asr_metadata NULL)', async () => {
      mockS3Send.mockRejectedValue(new Error('S3 unavailable'));

      await expect(runVoicePipeline('COMPLETED')).resolves.toBeUndefined();

      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(extractionInsertRow()).toEqual({
        user_id: 'user-1',
        voice_message_media_id: 'media-1',
        bedrock_model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        status: 'failed',
        failure_kind: 'audio_read',
        asr_metadata: null,
      });
      expectFailedVpEvent('extraction-2c');
    });

    it('records model_call when the Bedrock call rejects — caught, no throw', async () => {
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockRejectedValue(
        Object.assign(new Error('Too many requests, please wait'), { name: 'ThrottlingException' }),
      );

      await expect(runVoicePipeline('COMPLETED')).resolves.toBeUndefined();

      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      const row = extractionInsertRow();
      expect(row).toMatchObject({
        status: 'failed',
        failure_kind: 'model_call',
        voice_message_media_id: 'media-1',
      });
      expect(row).not.toHaveProperty('transcript_text');
      expect(JSON.parse(row.asr_metadata as string)).toMatchObject({ provider: 'transcribe' });
      expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(VP_TRANSCRIPT);
      expect(mockQuery.mock.calls.some(([sql]: [string]) => sql === 'COMMIT')).toBe(true);
      expect(mockQuery.mock.calls.some(([sql]: [string]) => sql === 'ROLLBACK')).toBe(false);
      expectFailedVpEvent('extraction-2c');
    });

    it('records bad_json when the model reply does not parse — caught, no throw', async () => {
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockResolvedValue(makeBedrockTextResponse('Sorry, I can only describe this worker in prose.'));

      await expect(runVoicePipeline('COMPLETED')).resolves.toBeUndefined();

      const row = extractionInsertRow();
      expect(row).toMatchObject({
        status: 'failed',
        failure_kind: 'bad_json',
        voice_message_media_id: 'media-1',
      });
      expect(row).not.toHaveProperty('transcript_text');
      expect(JSON.parse(row.asr_metadata as string)).toMatchObject({ provider: 'transcribe' });
      expectFailedVpEvent('extraction-2c');
    });

    it.each([
      ['extracted_fields is null', '{"extracted_fields":null,"confidence_scores":{"full_name":0.9},"summary_en":"s","summary_es":"s"}'],
      ['extracted_fields is a string', '{"extracted_fields":"Jose, plumber","confidence_scores":{"full_name":0.9},"summary_en":"s","summary_es":"s"}'],
      ['confidence_scores is an array', '{"extracted_fields":{"full_name":"Jose"},"confidence_scores":[0.9],"summary_en":"s","summary_es":"s"}'],
      ['both keys are missing', '{"summary_en":"Jose, a plumber.","summary_es":"Jose, un plomero."}'],
      ['the reply is JSON null', 'null'],
      ['the reply is a JSON array', '[]'],
    ])('records bad_shape when %s — caught, no throw', async (_label, reply) => {
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockResolvedValue(makeBedrockTextResponse(reply));

      await expect(runVoicePipeline('COMPLETED')).resolves.toBeUndefined();

      const row = extractionInsertRow();
      expect(row).toMatchObject({
        status: 'failed',
        failure_kind: 'bad_shape',
        voice_message_media_id: 'media-1',
      });
      expect(row).not.toHaveProperty('transcript_text');
      expect(row).not.toHaveProperty('extracted_fields');
      expectFailedVpEvent('extraction-2c');
    });

    it('logs the cause only — never the transcript or the error text', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockRejectedValue(new Error('upstream said: Jose is a plumber'));

      await runVoicePipeline('COMPLETED');

      const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.map(String).join(' '))
        .join('\n');
      expect(logged).toContain('"metric":"AiProfileWriterExtractionFailed","failureKind":"model_call"');
      expect(logged).not.toContain('Jose');
      expect(logged).not.toContain('upstream said');
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('keeps the SDK error class name on the model_call log line only — never its message, the transcript or a row', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockRejectedValue(
        Object.assign(new Error('Too many requests, please wait; prompt began Jose'), { name: 'ThrottlingException' }),
      );

      await expect(runVoicePipeline('COMPLETED')).resolves.toBeUndefined();

      const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.map(String).join(' '))
        .join('\n');
      const failedLine = logSpy.mock.calls
        .map(([msg]) => String(msg))
        .filter((msg) => msg.includes('AiProfileWriterExtractionFailed'));
      expect(failedLine).toEqual([
        '{"metric":"AiProfileWriterExtractionFailed","failureKind":"model_call","errorName":"ThrottlingException","v2":true}',
      ]);
      // Only the class name leaves the lambda, and only in the log: the
      // message, the transcript and the name are in no row and no event.
      const written = JSON.stringify([mockQuery.mock.calls, mockSqsSend.mock.calls]);
      for (const text of ['Too many requests', 'please wait', 'prompt began', 'Jose']) {
        expect(logged).not.toContain(text);
        expect(written).not.toContain(text);
      }
      expect(written).not.toContain('ThrottlingException');
      expect(extractionInsertRow()).toMatchObject({ status: 'failed', failure_kind: 'model_call' });
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it.each([
      ['a string rejection', 'upstream said: Jose is a plumber'],
      ['an object whose name is not a string', { name: 42, message: 'upstream said: Jose is a plumber' }],
      ['a null rejection', null],
      ['an undefined rejection', undefined],
    ])('logs errorName "unknown" when the Bedrock rejection is %s', async (_label, rejection) => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockRejectedValue(rejection);

      await expect(runVoicePipeline('COMPLETED')).resolves.toBeUndefined();

      const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.map(String).join(' '))
        .join('\n');
      expect(logged).toContain(
        '"metric":"AiProfileWriterExtractionFailed","failureKind":"model_call","errorName":"unknown","v2":true',
      );
      expect(logged).not.toContain('upstream said');
      expect(extractionInsertRow()).toMatchObject({ status: 'failed', failure_kind: 'model_call' });
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('bounds a very long error name to 100 characters', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockRejectedValue(Object.assign(new Error('x'), { name: 'E'.repeat(150) }));

      await runVoicePipeline('COMPLETED');

      const logged = logSpy.mock.calls.map(([msg]) => String(msg)).join('\n');
      expect(logged).toContain(`"errorName":"${'E'.repeat(100)}","v2":true`);
      expect(logged).not.toContain('E'.repeat(101));
      logSpy.mockRestore();
    });

    it.each([
      ['bad_json', 'Sorry, I can only describe this worker in prose.'],
      ['bad_shape', '{"summary_en":"Jose, a plumber.","summary_es":"Jose, un plomero."}'],
    ])('leaves the %s log line without an errorName', async (kind, reply) => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
      mockBedrockSend.mockResolvedValue(makeBedrockTextResponse(reply));

      await runVoicePipeline('COMPLETED');

      const failedLines = logSpy.mock.calls
        .map(([msg]) => String(msg))
        .filter((msg) => msg.includes('AiProfileWriterExtractionFailed'));
      expect(failedLines).toEqual([`{"metric":"AiProfileWriterExtractionFailed","failureKind":"${kind}","v2":true}`]);
      logSpy.mockRestore();
    });
  });

  it('success path unchanged: completed row has no failure_kind, #vp event carries the extraction', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockS3Send.mockResolvedValue(makeTranscriptS3Response(VP_TRANSCRIPT));
    mockBedrockSend.mockResolvedValue(makeBedrockResponse(
      { full_name: 'Jose', city: 'Denver, CO', main_trade: 'plumber' },
      { full_name: 0.9, city: 0.8, main_trade: 0.95 },
      'Jose, a plumber in Denver.',
      'Jose, un plomero en Denver.',
    ));

    await runVoicePipeline('COMPLETED');

    const row = extractionInsertRow();
    expect(row).toEqual({
      user_id: 'user-1',
      voice_message_media_id: 'media-1',
      bedrock_model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      transcript_text: VP_TRANSCRIPT,
      extracted_fields: JSON.stringify({ full_name: 'Jose', city: 'Denver, CO', main_trade: 'plumber' }),
      confidence_scores: JSON.stringify({ full_name: 0.9, city: 0.8, main_trade: 0.95 }),
      status: 'completed',
      asr_metadata: expect.any(String),
    });
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const params = Object.fromEntries(new URLSearchParams(mockSqsSend.mock.calls[0][0].input.MessageBody));
    expect(parseVoiceTranscriptEvent(params)).toEqual({
      version: 'v2',
      kind: 'profile_intake',
      status: 'COMPLETED',
      phone: '+15125551234',
      runId: 'run-abc',
      stepKey: 'profile.voice_processing',
      language: 'en',
      origMessageSid: 'MMvoice-2c',
      startedAt: '2026-07-27T00:00:00.000Z',
      executionArn: VP_EXECUTION_ARN,
      extractionId: 'extraction-2c',
      fields: { full_name: 'Jose', city: 'Denver, CO', main_trade: 'plumber' },
      confidences: { full_name: 0.9, city: 0.8, main_trade: 0.95 },
      summaryEn: 'Jose, a plumber in Denver.',
      summaryEs: 'Jose, un plomero en Denver.',
    });
    expect(logSpy.mock.calls.map(([msg]) => String(msg)).join('\n')).not.toContain('AiProfileWriterExtractionFailed');
    logSpy.mockRestore();
  });
});
