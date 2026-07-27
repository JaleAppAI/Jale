// infra/test/unit/lambda/whatsapp/lib/voice-events.test.ts
//
// Pure module: nothing is mocked, no clock is faked.

import {
  buildSyntheticVoiceInboundBody,
  parseVoiceTranscriptEvent,
  syntheticVoiceSid,
  VOICE_EVENT_FIELD,
  type TrustVoiceEventV2,
  type ProfileIntakeVoiceEventV2,
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
    expect(parsed).toEqual(trustEvent);
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
