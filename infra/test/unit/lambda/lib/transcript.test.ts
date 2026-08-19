import {
  parseTranscriptJson,
  readTranscriptResult,
  type TranscriptResult,
} from '../../../../lambda/lib/transcript';

// ── parseTranscriptJson ──────────────────────────────────────────────────

describe('parseTranscriptJson', () => {
  it('parses a single-language Amazon Transcribe batch output', () => {
    const raw = JSON.stringify({
      jobName: 'job-1',
      results: {
        transcripts: [{ transcript: 'I am a plumber in Denver' }],
        items: [
          {
            start_time: '0.0',
            end_time: '0.2',
            alternatives: [{ confidence: '0.9987', content: 'I' }],
            type: 'pronunciation',
          },
          {
            start_time: '0.2',
            end_time: '0.4',
            alternatives: [{ confidence: '0.85', content: 'am' }],
            type: 'pronunciation',
          },
        ],
        language_code: 'en-US',
      },
      status: 'COMPLETED',
    });

    const result = parseTranscriptJson(raw);

    expect(result.text).toBe('I am a plumber in Denver');
    expect(result.provider).toBe('transcribe');
    expect(result.words).toEqual([
      { w: 'I', conf: 0.9987 },
      { w: 'am', conf: 0.85 },
    ]);
    expect(result.languages).toEqual(['en-US']);
    expect(result.avgConfidence).toBeCloseTo((0.9987 + 0.85) / 2);
    expect(result.jaleTranscriptVersion).toBeUndefined();
  });

  it('reads languages from results.language_codes for a multi-language job', () => {
    const raw = JSON.stringify({
      results: {
        transcripts: [{ transcript: 'Hola, I am a plumber' }],
        items: [
          { alternatives: [{ confidence: '0.9', content: 'Hola' }], type: 'pronunciation' },
        ],
        language_codes: [
          { language_code: 'es-US', duration_in_seconds: 3.2 },
          { language_code: 'en-US', duration_in_seconds: 1.1 },
        ],
        // language_codes must win over a singular language_code when both present.
        language_code: 'en-US',
      },
    });

    const result = parseTranscriptJson(raw);

    expect(result.languages).toEqual(['es-US', 'en-US']);
  });

  it('falls back to the singular results.language_code when language_codes is absent', () => {
    const raw = JSON.stringify({
      results: {
        transcripts: [{ transcript: 'I am a plumber' }],
        items: [],
        language_code: 'en-US',
      },
    });

    const result = parseTranscriptJson(raw);

    expect(result.languages).toEqual(['en-US']);
  });

  it('excludes punctuation items from words and from avgConfidence', () => {
    const raw = JSON.stringify({
      results: {
        transcripts: [{ transcript: 'I am a plumber.' }],
        items: [
          { alternatives: [{ confidence: '0.9', content: 'I' }], type: 'pronunciation' },
          { alternatives: [{ confidence: '0.4', content: 'am' }], type: 'pronunciation' },
          { alternatives: [{ confidence: '0.0', content: '.' }], type: 'punctuation' },
        ],
      },
    });

    const result = parseTranscriptJson(raw);

    expect(result.words).toEqual([
      { w: 'I', conf: 0.9 },
      { w: 'am', conf: 0.4 },
    ]);
    // avg must be over the two pronunciation confs only, never the
    // punctuation item's 0.0 confidence.
    expect(result.avgConfidence).toBeCloseTo((0.9 + 0.4) / 2);
  });

  it('parses Transcribe string confidences and maps NaN/missing to null', () => {
    const raw = JSON.stringify({
      results: {
        transcripts: [{ transcript: 'troca rufero' }],
        items: [
          { alternatives: [{ confidence: '0.4123', content: 'troca' }], type: 'pronunciation' },
          { alternatives: [{ confidence: 'N/A', content: 'rufero' }], type: 'pronunciation' },
          { alternatives: [{ content: 'no-confidence-field' }], type: 'pronunciation' },
        ],
      },
    });

    const result = parseTranscriptJson(raw);

    expect(result.words).toEqual([
      { w: 'troca', conf: 0.4123 },
      { w: 'rufero', conf: null },
      { w: 'no-confidence-field', conf: null },
    ]);
    // avgConfidence only averages the single numeric conf present.
    expect(result.avgConfidence).toBeCloseTo(0.4123);
  });

  it('degrades gracefully for an empty transcript with no items', () => {
    const raw = JSON.stringify({
      results: {
        transcripts: [{ transcript: '' }],
      },
    });

    const result = parseTranscriptJson(raw);

    expect(result.text).toBe('');
    expect(result.provider).toBe('transcribe');
    expect(result.words).toBeUndefined();
    expect(result.languages).toBeUndefined();
    expect(result.avgConfidence).toBeUndefined();
  });

  it('degrades gracefully when results is missing entirely', () => {
    const result = parseTranscriptJson(JSON.stringify({}));

    expect(result.text).toBe('');
    expect(result.provider).toBe('transcribe');
    expect(result.words).toBeUndefined();
    expect(result.languages).toBeUndefined();
    expect(result.avgConfidence).toBeUndefined();
  });

  it('passes jaleTranscriptVersion:1 payloads through as-is (future-provider hook)', () => {
    const future: TranscriptResult = {
      jaleTranscriptVersion: 1,
      text: 'hello from deepgram',
      words: [{ w: 'hello', conf: 0.99 }],
      languages: ['en-US'],
      avgConfidence: 0.99,
      provider: 'deepgram',
    };

    const result = parseTranscriptJson(JSON.stringify(future));

    expect(result).toEqual(future);
  });

  it('minimally validates a jaleTranscriptVersion:1 payload, coercing missing optional fields', () => {
    const raw = JSON.stringify({ jaleTranscriptVersion: 1, text: 'hi there' });

    const result = parseTranscriptJson(raw);

    expect(result.jaleTranscriptVersion).toBe(1);
    expect(result.text).toBe('hi there');
    expect(result.words).toBeUndefined();
    expect(result.languages).toBeUndefined();
    expect(result.avgConfidence).toBeUndefined();
    expect(result.provider).toBeUndefined();
  });

  it('throws on garbage (unparseable) JSON, propagating to the caller', () => {
    expect(() => parseTranscriptJson('{not valid json')).toThrow();
  });
});

// ── readTranscriptResult ─────────────────────────────────────────────────

describe('readTranscriptResult', () => {
  it('fetches the S3 object, reads the body as a string, and parses it', async () => {
    const json = JSON.stringify({
      results: { transcripts: [{ transcript: 'I am an electrician' }] },
    });
    const send = jest.fn().mockResolvedValue({
      Body: { transformToString: jest.fn().mockResolvedValue(json) },
    });
    const fakeS3 = { send } as unknown as import('@aws-sdk/client-s3').S3Client;

    const result = await readTranscriptResult(fakeS3, 'my-bucket', 'user-1/transcripts/job.json');

    expect(result.text).toBe('I am an electrician');
    expect(result.provider).toBe('transcribe');
    expect(send).toHaveBeenCalledTimes(1);
    const sentCommand = send.mock.calls[0][0] as { input: { Bucket: string; Key: string } };
    expect(sentCommand.input).toEqual({ Bucket: 'my-bucket', Key: 'user-1/transcripts/job.json' });
  });

  it('propagates an S3 GetObject rejection to the caller', async () => {
    const send = jest.fn().mockRejectedValue(new Error('S3 unavailable'));
    const fakeS3 = { send } as unknown as import('@aws-sdk/client-s3').S3Client;

    await expect(readTranscriptResult(fakeS3, 'my-bucket', 'key.json')).rejects.toThrow('S3 unavailable');
  });
});
