import type { PreferredLanguage } from './onboarding-types';

// ── Why this exists ──────────────────────────────────────────────────
//
// Voice-note handling (transcription, extraction) runs as an async pipeline
// (Transcribe + AI-role lambdas) that is disjoint from the synchronous
// webhook -> SQS FIFO -> processor path. Those AI-role lambdas do zero
// workflow-DB work — no claim rows, no per-phone serialization, no RLS
// session — on purpose, so a bug in an extraction prompt can never touch
// whatsapp_processed_messages or worker state directly.
//
// When the pipeline finishes, its result has to become a workflow event
// again, and the only way to get the processor's guarantees (claim-row
// idempotency, per-phone FIFO ordering via message group ID, RLS grants
// scoped to the authenticated role) is to re-enter through the same door
// every other inbound message uses: a synthetic record on the v2 inbound
// FIFO queue, shaped so `parseFormBody` decodes it exactly like a real
// Twilio webhook POST.
//
// The synthetic MessageSid is `${origMessageSid}#<suffix>` — mirrors the
// `<sid>#err` convention in processor.ts's sendErrorFallback. Real Twilio
// sids are exactly 34 chars and, per Twilio's SID alphabet, can never
// contain `#`, so this can't collide with a genuine inbound message and
// is a spoof-proof discriminator: nothing reaches this queue without
// first passing the webhook's Twilio signature validation, so anything
// bearing a `#`-suffixed sid is guaranteed to have originated from our
// own pipeline, not from attacker-controlled webhook input.
//
// If parsing fails for any reason (unknown suffix, malformed JSON, version
// skew, kind/suffix mismatch), `parseVoiceTranscriptEvent` returns null and
// the record falls through to ordinary empty-body text handling — a
// harmless reprompt — rather than throwing.

interface VoiceEventCommon {
  version: 'v2';
  status: 'COMPLETED' | 'FAILED';
  phone: string; // normalized, no 'whatsapp:' prefix
  runId: string;
  stepKey: string; // step the voice note was recorded AT (staleness anchor)
  language: PreferredLanguage;
  origMessageSid: string; // inbound voice-note's Twilio sid
  startedAt: string; // ISO
}

export interface TrustVoiceEventV2 extends VoiceEventCommon {
  kind: 'trust_answer';
  questionIndex: number; // 0|1|2
  transcript?: string; // present iff COMPLETED
  transcriptOutputKey?: string;
  /**
   * Deterministic Step Functions execution ARN (Task 5/B3), mirroring
   * `ProfileIntakeVoiceEventV2.executionArn` — the staleness anchor
   * `applyTrustVoiceTranscript` compares against
   * `state_context.v2TrustVoiceExecutionArn` so a late transcript from a
   * PRIOR visit to the same run/step (BACK, then RESTART, then back again)
   * can never silently overwrite a corrected answer.
   */
  executionArn: string;
}

export interface VoiceExtractionFields {
  full_name?: string | null;
  city?: string | null;
  main_trade?: string | null;
  main_trade_other?: string | null;
  years_experience?: string | null;
  has_transportation?: boolean | null;
  availability?: string | null;
}

export interface ProfileIntakeVoiceEventV2 extends VoiceEventCommon {
  kind: 'profile_intake';
  fields: VoiceExtractionFields | null; // null on failure
  confidences: Record<string, number> | null;
  summaryEn: string | null;
  summaryEs: string | null;
  executionArn: string;
  extractionId: string | null; // worker_profile_ai_extractions.id
}

export type VoiceEventV2 = TrustVoiceEventV2 | ProfileIntakeVoiceEventV2;

/**
 * SFN execution input: pipeline-required top-level fields + v2 envelope
 * (receiver/writer adds status + result fields at completion time).
 */
export interface VoicePipelineExecutionInputV2 {
  transcriptionJobName: string;
  mediaS3Uri: string;
  mediaBucketName: string;
  transcriptOutputKey: string;
  v2: Omit<VoiceEventCommon, 'status'> & {
    kind: VoiceEventV2['kind'];
    questionIndex?: number;
  };
}

export const VOICE_EVENT_FIELD = 'XJaleVoiceEvent';

export const SYNTHETIC_SID_SUFFIX = { trust_answer: '#vt', profile_intake: '#vp' } as const;

/**
 * `${origSid}${suffix}` — real Twilio sids are 34 chars, so with a 3-char
 * suffix this always fits VARCHAR(50). Not asserted at runtime: an
 * oversized sid would mean Twilio changed its sid format, which would
 * break far more than this queue.
 */
export function syntheticVoiceSid(origSid: string, kind: VoiceEventV2['kind']): string {
  return `${origSid}${SYNTHETIC_SID_SUFFIX[kind]}`;
}

/**
 * URLSearchParams-encoded body shaped like a Twilio inbound webhook POST,
 * so it round-trips through `parseFormBody` unchanged. Body is empty —
 * the payload lives entirely in the VOICE_EVENT_FIELD JSON blob.
 */
export function buildSyntheticVoiceInboundBody(evt: VoiceEventV2): string {
  const params = new URLSearchParams({
    From: `whatsapp:${evt.phone}`,
    MessageSid: syntheticVoiceSid(evt.origMessageSid, evt.kind),
    Body: '',
    [VOICE_EVENT_FIELD]: JSON.stringify(evt),
  });
  return params.toString();
}

const SUFFIX_TO_KIND: Record<string, VoiceEventV2['kind']> = {
  '#vt': 'trust_answer',
  '#vp': 'profile_intake',
};

/**
 * Strict by design: this is the only thing standing between "trusted
 * pipeline completion" and "attacker-controlled webhook text that happens
 * to look like JSON". MessageSid must end with a known suffix AND the
 * field must parse as JSON AND version === 'v2' AND the parsed kind must
 * match the sid suffix — any mismatch returns null rather than guessing,
 * so the message falls through to ordinary (harmless) text handling.
 */
export function parseVoiceTranscriptEvent(
  params: Record<string, string | undefined>,
): VoiceEventV2 | null {
  const sid = params.MessageSid;
  const raw = params[VOICE_EVENT_FIELD];
  if (!sid || !raw) return null;

  const suffix = Object.keys(SUFFIX_TO_KIND).find((s) => sid.endsWith(s));
  if (!suffix) return null;
  const expectedKind = SUFFIX_TO_KIND[suffix];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const evt = parsed as Partial<VoiceEventV2>;
  if (evt.version !== 'v2') return null;
  if (evt.kind !== expectedKind) return null;

  return evt as VoiceEventV2;
}
