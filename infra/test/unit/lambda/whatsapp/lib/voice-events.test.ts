// infra/test/unit/lambda/whatsapp/lib/voice-events.test.ts
//
// Pure module: nothing is mocked, no clock is faked.

import {
  buildSyntheticVoiceInboundBody,
  parseVoiceTranscriptEvent,
  resolveVoiceOrigin,
  syntheticVoiceSid,
  VOICE_EVENT_FIELD,
  type TrustVoiceEventV2,
  type ProfileIntakeVoiceEventV2,
  type VoicePipelineExecutionInputV2,
} from '../../../../../lambda/whatsapp/lib/voice-events';

// Mirrors processor.ts's parseFormBody (URLSearchParams entries -> object).
function decodeFormBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

const REAL_SID = '1'.repeat(34); // Twilio sids are exactly 34 chars

const trustEvent: TrustVoiceEventV2 = {
  version: 'v2',
  kind: 'trust_answer',
  status: 'COMPLETED',
  phone: '+15125551234',
  runId: 'run-abc-123',
  stepKey: 'trust.question.2',
  language: 'en',
  origMessageSid: REAL_SID,
  startedAt: '2026-07-26T12:00:00.000Z',
  questionIndex: 1,
  transcript: 'I fix leaky pipes and install water heaters.',
  transcriptOutputKey: 'transcripts/run-abc-123/q2.json',
  executionArn: 'arn:aws:states:us-east-2:000000000000:execution:fake-trust-voice-pipeline:vt-1',
};

const profileEvent: ProfileIntakeVoiceEventV2 = {
  version: 'v2',
  kind: 'profile_intake',
  status: 'COMPLETED',
  phone: '+15125551234',
  runId: 'run-def-456',
  stepKey: 'profile.voice_processing',
  language: 'es',
  origMessageSid: REAL_SID,
  startedAt: '2026-07-26T12:05:00.000Z',
  fields: {
    full_name: 'Juan Perez',
    city: 'Austin',
    main_trade: 'plumbing',
    main_trade_other: null,
    years_experience: '5',
    has_transportation: true,
    availability: 'weekdays',
  },
  confidences: { full_name: 0.95, city: 0.9 },
  summaryEn: 'Plumber with 5 years experience in Austin.',
  summaryEs: 'Plomero con 5 años de experiencia en Austin.',
  executionArn: 'arn:aws:states:us-east-1:123456789012:execution:voice-pipeline:run-def-456',
  extractionId: 'extraction-uuid-1',
};

describe('syntheticVoiceSid', () => {
  it('appends the trust_answer suffix and stays within VARCHAR(50)', () => {
    const sid = syntheticVoiceSid(REAL_SID, 'trust_answer');
    expect(sid).toBe(`${REAL_SID}#vt`);
    expect(sid.length).toBeLessThanOrEqual(50);
  });

  it('appends the profile_intake suffix and stays within VARCHAR(50)', () => {
    const sid = syntheticVoiceSid(REAL_SID, 'profile_intake');
    expect(sid).toBe(`${REAL_SID}#vp`);
    expect(sid.length).toBeLessThanOrEqual(50);
  });
});

describe('buildSyntheticVoiceInboundBody / parseVoiceTranscriptEvent round-trip', () => {
  it('round-trips a trust_answer event with all fields preserved', () => {
    const body = buildSyntheticVoiceInboundBody(trustEvent);
    const params = decodeFormBody(body);
    expect(params.From).toBe(`whatsapp:${trustEvent.phone}`);
    expect(params.MessageSid).toBe(`${REAL_SID}#vt`);
    expect(params.Body).toBe('');

    const parsed = parseVoiceTranscriptEvent(params);
    // Sprint 23 L6: `origin` is normalized ON PARSE, so a trust event built
    // without one comes back marked `whatsapp` rather than round-tripping to
    // `undefined`. That is the point of the default — no consumer downstream
    // has to remember which absence means which door.
    expect(parsed).toEqual({ ...trustEvent, origin: 'whatsapp' });
  });

  it('round-trips a profile_intake event with all fields preserved', () => {
    const body = buildSyntheticVoiceInboundBody(profileEvent);
    const params = decodeFormBody(body);
    expect(params.From).toBe(`whatsapp:${profileEvent.phone}`);
    expect(params.MessageSid).toBe(`${REAL_SID}#vp`);
    expect(params.Body).toBe('');

    const parsed = parseVoiceTranscriptEvent(params);
    expect(parsed).toEqual(profileEvent);
  });

  it('encodes Body as an empty string in the form body', () => {
    const body = buildSyntheticVoiceInboundBody(trustEvent);
    expect(body).toContain('Body=');
    const params = decodeFormBody(body);
    expect(params.Body).toBe('');
  });

  it('round-trips a FAILED profile_intake event with null result fields', () => {
    const failed: ProfileIntakeVoiceEventV2 = {
      ...profileEvent,
      status: 'FAILED',
      fields: null,
      confidences: null,
      summaryEn: null,
      summaryEs: null,
      extractionId: null,
    };
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(failed));
    expect(parseVoiceTranscriptEvent(params)).toEqual(failed);
  });
});

describe('parseVoiceTranscriptEvent — strict rejection', () => {
  it('returns null when the sid has no known suffix', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(trustEvent));
    params.MessageSid = REAL_SID; // no suffix at all
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });

  it('returns null when the sid has an unrecognized suffix', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(trustEvent));
    params.MessageSid = `${REAL_SID}#err`;
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });

  it('returns null when the event field is not valid JSON', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(trustEvent));
    params[VOICE_EVENT_FIELD] = '{not json';
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });

  it('returns null when version is not v2', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(trustEvent));
    params[VOICE_EVENT_FIELD] = JSON.stringify({ ...trustEvent, version: 'v1' });
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });

  it('returns null when kind does not match the sid suffix (#vt sid, profile_intake kind)', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(trustEvent));
    params[VOICE_EVENT_FIELD] = JSON.stringify({ ...profileEvent, kind: 'profile_intake' });
    // sid still ends in #vt (from trustEvent's encoding) but kind claims profile_intake
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });

  it('returns null when kind does not match the sid suffix (#vp sid, trust_answer kind)', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(profileEvent));
    params[VOICE_EVENT_FIELD] = JSON.stringify({ ...trustEvent, kind: 'trust_answer' });
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });

  it('returns null when the event field is absent', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(trustEvent));
    delete params[VOICE_EVENT_FIELD];
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });

  it('returns null when MessageSid is absent', () => {
    const params = decodeFormBody(buildSyntheticVoiceInboundBody(trustEvent));
    delete params.MessageSid;
    expect(parseVoiceTranscriptEvent(params)).toBeNull();
  });
});

describe('VoicePipelineExecutionInputV2 shape', () => {
  // languageCode was dropped (T-transcription-language-id): the Step
  // Functions construct now identifies language itself
  // (IdentifyMultipleLanguages) instead of reading it from the execution
  // input, so the field must no longer be required — or even present — on
  // this type. This is a compile-time assertion: the object literal below
  // fails to typecheck if `languageCode` is still a required/known field.
  it('constructs without a languageCode field', () => {
    const input: VoicePipelineExecutionInputV2 = {
      transcriptionJobName: 'jale-vt-worker1-123',
      mediaS3Uri: 's3://bucket/worker1/voice/media-id',
      mediaBucketName: 'bucket',
      transcriptOutputKey: 'worker1/transcripts/jale-vt-worker1-123.json',
      v2: {
        version: 'v2',
        kind: 'trust_answer',
        phone: '+15125551234',
        runId: 'run-1',
        stepKey: 'trust.question.1',
        language: 'es',
        origMessageSid: '1'.repeat(34),
        startedAt: '2026-08-14T00:00:00.000Z',
        questionIndex: 0,
      },
    };
    expect(input).not.toHaveProperty('languageCode');
    expect(input.transcriptionJobName).toBe('jale-vt-worker1-123');
  });

  // The test above only proves languageCode isn't REQUIRED — it would still
  // pass if the field came back as optional (a partial regression: no
  // longer mandatory, but still a recognized property some caller could
  // resurrect). Assigning it into an object literal is an excess-property
  // check: TS only flags an unknown key on a literal assigned directly to
  // the typed variable, so this fails to compile today (languageCode isn't
  // a property of VoicePipelineExecutionInputV2 at all) and would silently
  // stop failing — making @ts-expect-error itself an unused-directive error
  // — the moment languageCode is reintroduced in ANY form, required or not.
  it('rejects a languageCode field even if reintroduced as optional (compile-time)', () => {
    const input: VoicePipelineExecutionInputV2 = {
      transcriptionJobName: 'jale-vt-worker1-123',
      mediaS3Uri: 's3://bucket/worker1/voice/media-id',
      mediaBucketName: 'bucket',
      transcriptOutputKey: 'worker1/transcripts/jale-vt-worker1-123.json',
      // @ts-expect-error languageCode was removed from VoicePipelineExecutionInputV2
      languageCode: 'es-US',
      v2: {
        version: 'v2',
        kind: 'trust_answer',
        phone: '+15125551234',
        runId: 'run-1',
        stepKey: 'trust.question.1',
        language: 'es',
        origMessageSid: '1'.repeat(34),
        startedAt: '2026-08-14T00:00:00.000Z',
        questionIndex: 0,
      },
    };
    expect(input.transcriptionJobName).toBe('jale-vt-worker1-123');
  });
});

// ── Sprint 23 L6: `origin` ───────────────────────────────────────────────
describe('voice origin', () => {
  it('resolves an absent, undefined or unrecognized origin to whatsapp', () => {
    expect(resolveVoiceOrigin(undefined)).toBe('whatsapp');
    expect(resolveVoiceOrigin(null)).toBe('whatsapp');
    expect(resolveVoiceOrigin('whatsapp')).toBe('whatsapp');
    expect(resolveVoiceOrigin('WEB')).toBe('whatsapp');
    expect(resolveVoiceOrigin(1)).toBe('whatsapp');
  });

  it('resolves the exact string web to web', () => {
    expect(resolveVoiceOrigin('web')).toBe('web');
  });

  // The wire compatibility guarantee: a trust event that predates `origin`
  // must still parse, and must come back marked whatsapp rather than
  // undefined so no consumer has to remember the default.
  it('parses a pre-Sprint-23 trust event (no origin) and normalizes it to whatsapp', () => {
    const sid = '2'.repeat(34);
    const legacy = {
      version: 'v2',
      kind: 'trust_answer',
      status: 'COMPLETED',
      phone: '+15125551234',
      runId: 'run-1',
      stepKey: 'trust.question.2',
      language: 'en',
      origMessageSid: sid,
      startedAt: '2026-08-14T00:00:00.000Z',
      questionIndex: 1,
      executionArn: 'arn:aws:states:us-east-2:1:execution:sm:vt-x',
      transcript: 'five years',
    };
    const parsed = parseVoiceTranscriptEvent({
      MessageSid: `${sid}#vt`,
      [VOICE_EVENT_FIELD]: JSON.stringify(legacy),
    }) as TrustVoiceEventV2 | null;

    expect(parsed).not.toBeNull();
    expect(parsed!.origin).toBe('whatsapp');
    expect(parsed!.transcript).toBe('five years');
  });

  it('preserves a web origin through a round trip', () => {
    const sid = 'web:abc';
    const evt: TrustVoiceEventV2 = {
      version: 'v2',
      kind: 'trust_answer',
      status: 'COMPLETED',
      phone: '+15125551234',
      runId: 'run-1',
      stepKey: 'trust.question.1',
      language: 'en',
      origMessageSid: sid,
      startedAt: '2026-09-02T00:00:00.000Z',
      questionIndex: 0,
      executionArn: 'arn:aws:states:us-east-2:1:execution:sm:vtw-x',
      origin: 'web',
    };
    const decoded = decodeFormBody(buildSyntheticVoiceInboundBody(evt));
    const parsed = parseVoiceTranscriptEvent(decoded) as TrustVoiceEventV2 | null;
    expect(parsed!.origin).toBe('web');
  });

  it('accepts origin on the execution input envelope (compile-time)', () => {
    const input: VoicePipelineExecutionInputV2 = {
      transcriptionJobName: 'jale-vtw-abc',
      mediaS3Uri: 's3://bucket/voice/worker1/abc.webm',
      mediaBucketName: 'bucket',
      transcriptOutputKey: 'voice/worker1/transcripts/jale-vtw-abc.json',
      v2: {
        version: 'v2',
        kind: 'trust_answer',
        phone: '+15125551234',
        runId: 'run-1',
        stepKey: 'trust.question.1',
        language: 'en',
        origMessageSid: 'web:abc',
        startedAt: '2026-09-02T00:00:00.000Z',
        questionIndex: 0,
        origin: 'web',
      },
    };
    expect(input.v2.origin).toBe('web');
  });
});
