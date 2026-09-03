/**
 * The three voice actions on the web onboarding door (Sprint 23 L6).
 *
 * S3, the presigner and Step Functions are mocked; everything else — the
 * validation, the key shapes, the ownership rule, the status vocabulary — is
 * the real module. The `worker_profile_media` insert and the RLS policy behind
 * it are covered against real PostgreSQL in
 * `test/unit/db/web-onboarding-door.integration.test.ts`.
 */

const mockS3Send = jest.fn();
const mockGetSignedUrl = jest.fn();
const mockSfnSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Put', ...input })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Head', ...input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Get', ...input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({ send: mockSfnSend })),
  StartExecutionCommand: jest.fn().mockImplementation((input) => input),
}));

import {
  MAX_WEB_VOICE_BYTES,
  VOICE_UPLOAD_URL_TTL_SECONDS,
  createVoiceUploadUrl,
  normalizeContentType,
  questionIndexForStep,
  readVoiceResult,
  startVoiceTranscription,
  voicePrefix,
} from '../../../../../lambda/whatsapp/web/onboarding-voice';

const WORKER = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKER = '22222222-2222-4222-8222-222222222222';
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-02T12:00:00.000Z');

function fakeClient(): any {
  return { query: jest.fn().mockResolvedValue({ rows: [{ cognito_sub: 'sub-1' }], rowCount: 1 }) };
}

function s3Body(json: unknown) {
  return { Body: { transformToString: () => Promise.resolve(JSON.stringify(json)) } };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MEDIA_BUCKET_NAME = 'jale-worker-media';
  process.env.TRUST_PIPELINE_STATE_MACHINE_ARN =
    'arn:aws:states:us-east-2:123456789012:stateMachine:TrustVoicePipeline';
  mockGetSignedUrl.mockResolvedValue('https://s3.example/presigned');
  mockSfnSend.mockResolvedValue({});
});

describe('normalizeContentType', () => {
  // MediaRecorder reports its mimeType WITH codec parameters; the allowlist is
  // exact-match on the base type, so the parameters have to come off first.
  it('strips codec parameters and lowercases', () => {
    expect(normalizeContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeContentType('AUDIO/WEBM; codecs=opus')).toBe('audio/webm');
  });

  it('rejects non-strings and empties', () => {
    expect(normalizeContentType(undefined)).toBeNull();
    expect(normalizeContentType(7)).toBeNull();
    expect(normalizeContentType(';codecs=opus')).toBeNull();
  });
});

describe('questionIndexForStep', () => {
  it('is 0-based', () => {
    expect(questionIndexForStep('trust.question.1')).toBe(0);
    expect(questionIndexForStep('trust.question.3')).toBe(2);
  });
});

describe('voice-upload-url', () => {
  const base = {
    workerId: WORKER,
    stepKey: 'trust.question.2',
    questionIndex: 1,
    contentType: 'audio/webm;codecs=opus',
    sizeBytes: 120_000,
    now: NOW,
  };

  it('mints a key under the worker prefix and returns url + expiry', async () => {
    const res = await createVoiceUploadUrl(base);

    expect(res.statusCode).toBe(200);
    expect(String(res.body.key)).toMatch(
      new RegExp(`^voice/${WORKER}/[0-9a-f-]{36}\\.webm$`),
    );
    expect(res.body.url).toBe('https://s3.example/presigned');
    expect(res.body.expiresAt).toBe(
      new Date(NOW.getTime() + VOICE_UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    );

    const [, command, options] = mockGetSignedUrl.mock.calls[0] as any[];
    expect(command.Bucket).toBe('jale-worker-media');
    // The content type is SIGNED: the browser cannot presign audio and PUT
    // something else.
    expect(command.ContentType).toBe('audio/webm');
    expect(options.expiresIn).toBe(VOICE_UPLOAD_URL_TTL_SECONDS);
  });

  it('accepts every allowed MIME type and maps each to its own extension', async () => {
    const cases: [string, string][] = [
      ['audio/webm', 'webm'],
      ['audio/ogg', 'ogg'],
      ['audio/mp4', 'm4a'],
      ['audio/mpeg', 'mp3'],
      ['audio/wav', 'wav'],
    ];
    for (const [mime, ext] of cases) {
      const res = await createVoiceUploadUrl({ ...base, contentType: mime });
      expect(res.statusCode).toBe(200);
      expect(String(res.body.key).endsWith(`.${ext}`)).toBe(true);
    }
  });

  it('rejects a MIME type outside the allowlist and never presigns', async () => {
    const res = await createVoiceUploadUrl({ ...base, contentType: 'application/zip' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_content_type');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  // The WhatsApp lane allows 16 MB (Twilio's cap). The web lane must NOT
  // inherit that number.
  it('rejects a declared size over 5 MB', async () => {
    const res = await createVoiceUploadUrl({ ...base, sizeBytes: MAX_WEB_VOICE_BYTES + 1 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('file_too_large');
    expect(res.body.maxBytes).toBe(5 * 1024 * 1024);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-integer size', { sizeBytes: 1.5 }],
    ['a zero size', { sizeBytes: 0 }],
    ['a missing size', { sizeBytes: undefined }],
    ['a non-trust step', { stepKey: 'profile.name' }],
    ['a questionIndex that disagrees with the step', { questionIndex: 0 }],
  ])('rejects %s', async (_label, patch) => {
    const res = await createVoiceUploadUrl({ ...base, ...patch } as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});

describe('voice-transcribe', () => {
  const key = `${voicePrefix(WORKER)}${MEDIA_ID}.webm`;
  const base = {
    workerId: WORKER,
    phone: '+15125550000',
    runId: 'run-1',
    language: 'es' as const,
    currentStepKey: 'trust.question.1',
    key,
    stepKey: 'trust.question.1',
    questionIndex: 0,
  };

  function headOk(bytes = 100_000, type = 'audio/webm') {
    mockS3Send.mockResolvedValueOnce({ ContentLength: bytes, ContentType: type });
  }

  it('starts the pipeline and answers 202 with the key to poll', async () => {
    headOk();
    const client = fakeClient();

    const res = await startVoiceTranscription(client, base);

    expect(res.statusCode).toBe(202);
    // Deterministic in the media id, which the audio key carries: a retried
    // transcribe hands back the SAME key the browser is already polling.
    const flat = MEDIA_ID.replace(/-/g, '');
    expect(res.body.transcriptOutputKey).toBe(
      `voice/${WORKER}/transcripts/jale-vtw-${flat}.json`,
    );

    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const sent = mockSfnSend.mock.calls[0][0] as any;
    expect(sent.name).toBe(`vtw-${flat}`);
    const sfnInput = JSON.parse(sent.input);
    expect(sfnInput.v2.origin).toBe('web');
    expect(sfnInput.v2.kind).toBe('trust_answer');
    expect(sfnInput.v2.questionIndex).toBe(0);
    expect(sfnInput.v2.language).toBe('es');
    expect(sfnInput.mediaS3Uri).toBe(`s3://jale-worker-media/${key}`);

    // The media row is written on the caller's transaction, exactly as the
    // WhatsApp lane does it.
    const insert = client.query.mock.calls.find(([sql]: [string]) =>
      String(sql).includes('INSERT INTO worker_profile_media'));
    expect(insert).toBeDefined();
    expect(insert[1]).toEqual([MEDIA_ID, WORKER, key, 'audio/webm']);
    // ON CONFLICT, because this door's media id is DETERMINISTIC (it is the
    // uuid in the key). A retried transcribe — an apiFetch 401 replay, a lost
    // response, a double-tap — must be the no-op the deterministic execution
    // name already makes it, not a 23505 the handler turns into a 500.
    expect(String(insert[0])).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('is idempotent on ExecutionAlreadyExists — a browser retry resolves to the same execution', async () => {
    headOk();
    const err: any = new Error('already');
    err.name = 'ExecutionAlreadyExists';
    mockSfnSend.mockRejectedValueOnce(err);

    const res = await startVoiceTranscription(fakeClient(), base);
    expect(res.statusCode).toBe(202);
  });

  // The tenant boundary. 404, never 403: a 403 would confirm the object is
  // there, which is the only thing a prefix guess is trying to learn.
  it('404s a key under ANOTHER worker prefix, and never touches S3 or SFN', async () => {
    const res = await startVoiceTranscription(fakeClient(), {
      ...base,
      key: `${voicePrefix(OTHER_WORKER)}${MEDIA_ID}.webm`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a traversal attempt', `voice/${WORKER}/../${OTHER_WORKER}/x.webm`],
    ['a nested subtree', `${voicePrefix(WORKER)}sub/x.webm`],
    ['a bare prefix', voicePrefix(WORKER)],
    ['a non-uuid basename', `${voicePrefix(WORKER)}notauuid.webm`],
    ['a prefix that merely starts the same', `voice/${WORKER}extra/${MEDIA_ID}.webm`],
    ['a non-string key', 42 as unknown as string],
  ])('404s %s', async (_label, badKey) => {
    const res = await startVoiceTranscription(fakeClient(), { ...base, key: badKey });
    expect(res.statusCode).toBe(404);
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it('404s when the object does not exist', async () => {
    const err: any = new Error('missing');
    err.name = 'NotFound';
    mockS3Send.mockRejectedValueOnce(err);

    const res = await startVoiceTranscription(fakeClient(), base);
    expect(res.statusCode).toBe(404);
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  // This Lambda has `s3:GetObject` on `voice/*` and NO `s3:ListBucket`, so S3
  // answers AccessDenied — not NoSuchKey — for a key that is simply not there.
  // Matching on the name alone would 500 on the commonest failure of all.
  it('404s when S3 answers 403 for an absent key', async () => {
    const err: any = new Error('Access Denied');
    err.name = 'AccessDenied';
    err.$metadata = { httpStatusCode: 403 };
    mockS3Send.mockRejectedValueOnce(err);

    const res = await startVoiceTranscription(fakeClient(), base);
    expect(res.statusCode).toBe(404);
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  // The declared size at presign time is advisory. This is where the cap is
  // real: HeadObject reports what was actually PUT.
  it('rejects an object that is actually over the cap, whatever was declared', async () => {
    mockS3Send.mockResolvedValueOnce({ ContentLength: MAX_WEB_VOICE_BYTES + 1, ContentType: 'audio/webm' });

    const res = await startVoiceTranscription(fakeClient(), base);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('file_too_large');
    expect(mockSfnSend).not.toHaveBeenCalled();
  });

  it('rejects a zero-byte upload rather than paying for a transcription of silence', async () => {
    mockS3Send.mockResolvedValueOnce({ ContentLength: 0, ContentType: 'audio/webm' });
    const res = await startVoiceTranscription(fakeClient(), base);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('empty_upload');
  });

  it('422s when the run has moved on from the step being answered', async () => {
    const res = await startVoiceTranscription(fakeClient(), {
      ...base,
      currentStepKey: 'trust.question.2',
    });
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe('step_mismatch');
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('400s a non-trust step or a mismatched questionIndex', async () => {
    expect((await startVoiceTranscription(fakeClient(), {
      ...base, stepKey: 'profile.name', currentStepKey: 'profile.name',
    })).statusCode).toBe(400);
    expect((await startVoiceTranscription(fakeClient(), {
      ...base, questionIndex: 2,
    })).statusCode).toBe(400);
  });
});

describe('voice-result', () => {
  const transcriptKey = `voice/${WORKER}/transcripts/jale-vtw-abc.json`;

  it('200s with the transcript and the mean confidence when one is reported', async () => {
    mockS3Send.mockResolvedValueOnce(s3Body({
      results: {
        transcripts: [{ transcript: 'I have five years framing houses' }],
        items: [
          { type: 'pronunciation', alternatives: [{ content: 'I', confidence: '0.9' }] },
          { type: 'pronunciation', alternatives: [{ content: 'have', confidence: '0.7' }] },
        ],
      },
    }));

    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: transcriptKey });
    expect(res.statusCode).toBe(200);
    expect(res.body.transcript).toBe('I have five years framing houses');
    expect(res.body.confidence).toBeCloseTo(0.8, 5);
  });

  it('omits confidence rather than inventing one', async () => {
    mockS3Send.mockResolvedValueOnce(s3Body({ jaleTranscriptVersion: 1, text: 'hola que tal' }));
    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: transcriptKey });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('confidence');
  });

  // Transcribe writes the object ONCE, at the end, so "absent" is exactly
  // "still working".
  it('202s while the object does not exist yet', async () => {
    const err: any = new Error('missing');
    err.name = 'NoSuchKey';
    mockS3Send.mockRejectedValueOnce(err);

    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: transcriptKey });
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('pending');
  });

  // And the same thing said the other way. With no `s3:ListBucket` on this
  // Lambda, a not-yet-written transcript comes back as 403, on EVERY poll
  // before the job finishes. Reading that as an error would 500 several times
  // per voice answer — and `WebOnboardingRequestFailed` is alarmed.
  it('202s when S3 answers 403 rather than 404 for the not-yet-written object', async () => {
    const err: any = new Error('Access Denied');
    err.name = 'AccessDenied';
    err.$metadata = { httpStatusCode: 403 };
    mockS3Send.mockRejectedValueOnce(err);

    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: transcriptKey });
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('pending');
  });

  // This is the marker `voice-trust-receiver` writes for a web-origin failure.
  // Without it this branch would be unreachable and the browser would poll to
  // its own cap.
  it('410s on the empty-text failure marker', async () => {
    mockS3Send.mockResolvedValueOnce(s3Body({ jaleTranscriptVersion: 1, text: '', provider: 'failed' }));
    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: transcriptKey });
    expect(res.statusCode).toBe(410);
    expect(res.body.error).toBe('transcription_failed');
  });

  it('410s on a transcript that came back as silence', async () => {
    mockS3Send.mockResolvedValueOnce(s3Body({ results: { transcripts: [{ transcript: '   ' }] } }));
    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: transcriptKey });
    expect(res.statusCode).toBe(410);
  });

  it('410s rather than 500s on an unparseable object', async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve('<html>nope</html>') },
    });
    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: transcriptKey });
    expect(res.statusCode).toBe(410);
  });

  it.each([
    ["another worker's transcript", `voice/${OTHER_WORKER}/transcripts/x.json`],
    ['an audio key rather than a transcript', `voice/${WORKER}/${MEDIA_ID}.webm`],
    ['a nested key', `voice/${WORKER}/transcripts/sub/x.json`],
    ['a WhatsApp-shaped transcript key', `${WORKER}/transcripts/jale-vt-x.json`],
    ['a non-string key', null as unknown as string],
  ])('404s %s without reading S3', async (_label, badKey) => {
    const res = await readVoiceResult({ workerId: WORKER, transcriptOutputKey: badKey });
    expect(res.statusCode).toBe(404);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

export {};
