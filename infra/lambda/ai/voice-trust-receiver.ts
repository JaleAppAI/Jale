import type { Handler } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { readTranscriptResult } from '../lib/transcript';
import type { Lang } from '../whatsapp/lib/templates';
import {
  buildSyntheticVoiceInboundBody,
  resolveVoiceOrigin,
  syntheticVoiceSid,
  type VoiceEventV2,
  type VoiceOrigin,
} from '../whatsapp/lib/voice-events';
import { hashNormalizedPhone } from '../whatsapp/lib/runtime-controls';

const s3 = new S3Client({});
const sqsClient = new SQSClient({});

interface TrustQuestion {
  q_en: string;
  q_es: string;
}

export interface VoiceTrustContext {
  userId: string;
  conversationId: string;
  inboundMessageSid: string;
  whatsappNumber: string;
  language: Lang;
  trustStep: 0 | 1 | 2;
  assessmentId: string;
  mediaBucketName: string;
  transcriptOutputKey: string;
  trustQuestions: TrustQuestion[];
}

/**
 * The v2 lane's slice of the Step Functions execution input (see
 * lib/voice-events.ts's `VoicePipelineExecutionInputV2['v2']`). Present iff
 * the trust voice note was started from the v2 onboarding lane
 * (processor.ts's `startTrustTranscription`); the legacy `VoiceTrustContext`
 * above has no `v2` field at all, so the two shapes never overlap.
 */
export interface V2TrustExecutionContext {
  v2: {
    version: 'v2';
    kind: 'trust_answer';
    phone: string;
    runId: string;
    stepKey: string;
    language: Lang;
    origMessageSid: string;
    startedAt: string;
    questionIndex: number;
    /**
     * Sprint 23 L6. ABSENT on every execution started before it shipped, and
     * on every WhatsApp execution that omits it — read through
     * `resolveVoiceOrigin`, never directly.
     */
    origin?: VoiceOrigin;
  };
  mediaBucketName: string;
  transcriptOutputKey: string;
}

export interface VoiceTrustReceiverEvent {
  status: 'COMPLETED' | 'FAILED';
  executionContext: VoiceTrustContext | V2TrustExecutionContext;
  /**
   * `$$.Execution.Id`, threaded in by the VoiceTranscriptionPipeline
   * construct's `invokeOnCompleted`/`invokeOnFailed` payloads as a top-level
   * sibling of `executionContext` (same mechanism `ai-profile-writer.ts`'s
   * `VoicePipelineAiProfileWriterEvent.executionArn` already uses) — the
   * deterministic execution ARN this lambda embeds in the outbound
   * `TrustVoiceEventV2` so the router's staleness check
   * (`applyTrustVoiceTranscript`) can compare it against
   * `state_context.v2TrustVoiceExecutionArn`. Always present in practice for
   * a REAL Step Functions invocation on the v2 branch; the legacy branch
   * never reads it.
   */
  executionArn?: string;
}

function isV2TrustExecutionContext(
  ctx: VoiceTrustContext | V2TrustExecutionContext,
): ctx is V2TrustExecutionContext {
  return (ctx as V2TrustExecutionContext).v2?.version === 'v2';
}

function inboundV2QueueUrl(): string {
  const url = process.env.WHATSAPP_INBOUND_V2_QUEUE_URL;
  if (!url) throw new Error('WHATSAPP_INBOUND_V2_QUEUE_URL not set');
  return url;
}

/**
 * The object `voice-result` polls when Transcribe produced nothing usable.
 *
 * Transcribe writes `transcriptOutputKey` ITSELF on success, so the happy web
 * path needs no write here at all. But a FAILED job writes NOTHING, and the
 * browser is polling that exact key — without a marker it would poll until its
 * own 60s cap with no way to tell "still working" from "never coming". The
 * marker is a `jaleTranscriptVersion: 1` payload with empty text, so
 * `readTranscriptResult` parses it unchanged and the empty-text branch on the
 * door turns it into a 410.
 *
 * Best effort: a write failure here must not throw, or Step Functions retries
 * a completion task whose transcription job is already over.
 */
async function persistWebFailureMarker(
  bucket: string,
  key: string,
): Promise<void> {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'application/json',
      Body: JSON.stringify({ jaleTranscriptVersion: 1, text: '', provider: 'failed' }),
    }));
  } catch (err) {
    console.error(JSON.stringify({
      metric: 'VoiceTrustReceiverWebMarkerWriteFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
  }
}

/**
 * v2 branch: the SAME Step Functions pipeline (Twilio media -> S3 ->
 * Transcribe) that fed the retired `building_custom_trust` flow now serves
 * only v2's `trust.question.*` steps, and v2 re-entry does ZERO DB work
 * here — see lib/voice-events.ts's module doc for why. It re-enters the
 * onboarding lane as a synthetic inbound event on the same FIFO queue every
 * other v2 message travels through, so the processor's claim idempotency,
 * per-phone ordering, and staleness check (onboarding/steps/trust.ts) apply
 * exactly as they would to a real message. Logs safe scalars only — never
 * the transcript text or the phone number.
 */
async function handleV2VoiceTrustCompletion(
  status: 'COMPLETED' | 'FAILED',
  ctx: V2TrustExecutionContext,
  executionArn: string,
): Promise<void> {
  const { v2 } = ctx;
  console.log(JSON.stringify({
    metric: 'VoiceTrustReceiverStarted',
    status,
    kind: v2.kind,
    stepKey: v2.stepKey,
  }));

  let transcript: string | undefined;
  let finalStatus: 'COMPLETED' | 'FAILED' = status;
  if (status === 'COMPLETED') {
    // Task 7/B5 fix: an S3 hiccup reading the transcript must never throw
    // bare here — this lambda has no DLQ/retry story a worker would ever
    // see resolved, so an uncaught throw means the worker waits forever
    // with no #vt event ever sent. Degrade to FAILED and let the router's
    // existing graceful `v2_voice_failed` reprompt (applyTrustVoiceTranscript,
    // onboarding/steps/trust.ts) handle it exactly like a genuinely empty
    // transcript already does below.
    try {
      const result = await readTranscriptResult(s3, ctx.mediaBucketName, ctx.transcriptOutputKey);
      transcript = result.text;
      if (transcript.trim().length === 0) {
        finalStatus = 'FAILED';
      }
    } catch (err) {
      console.error(JSON.stringify({
        metric: 'VoiceTrustReceiverTranscriptReadFailed',
        stepKey: v2.stepKey,
        reason: (err as { name?: string })?.name ?? 'unknown_error',
      }));
      finalStatus = 'FAILED';
    }
  }

  // ── THE WEB-ORIGIN TRAP ───────────────────────────────────────────
  //
  // A web worker may have no WhatsApp conversation at all. The synthetic
  // inbound event below re-enters the processor, which calls
  // `getOrCreateConversationForUpdate` — minting a WhatsApp conversation for
  // someone who has never messaged us, and then prompting them there. So a
  // web-origin completion STOPS HERE. The browser is polling the transcript
  // object directly (`POST /worker/onboarding/voice-result`), and the answer
  // is recorded when the worker submits it through the ordinary `answers`
  // action — the same one a typed answer uses.
  if (resolveVoiceOrigin(v2.origin) === 'web') {
    if (finalStatus !== 'COMPLETED') {
      await persistWebFailureMarker(ctx.mediaBucketName, ctx.transcriptOutputKey);
    }
    console.log(JSON.stringify({
      metric: 'VoiceTrustReceiverWebCompleted',
      kind: v2.kind,
      stepKey: v2.stepKey,
      status: finalStatus,
    }));
    return;
  }

  const evt: VoiceEventV2 = {
    version: 'v2',
    kind: 'trust_answer',
    status: finalStatus,
    phone: v2.phone,
    runId: v2.runId,
    stepKey: v2.stepKey,
    language: v2.language,
    origMessageSid: v2.origMessageSid,
    startedAt: v2.startedAt,
    questionIndex: v2.questionIndex,
    executionArn,
    origin: 'whatsapp',
    ...(finalStatus === 'COMPLETED'
      ? { transcript, transcriptOutputKey: ctx.transcriptOutputKey }
      : {}),
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: inboundV2QueueUrl(),
      MessageBody: buildSyntheticVoiceInboundBody(evt),
      MessageGroupId: hashNormalizedPhone(evt.phone),
      MessageDeduplicationId: syntheticVoiceSid(evt.origMessageSid, evt.kind),
    }),
  );

  console.log(JSON.stringify({
    metric: 'VoiceTrustReceiverV2Requeued',
    kind: evt.kind,
    stepKey: evt.stepKey,
    status: finalStatus,
  }));
}

export async function handleVoiceTrustCompletion(
  event: VoiceTrustReceiverEvent,
): Promise<void> {
  if (isV2TrustExecutionContext(event.executionContext)) {
    if (!event.executionArn) {
      throw new Error('executionArn missing on v2 trust-voice completion');
    }
    await handleV2VoiceTrustCompletion(event.status, event.executionContext, event.executionArn);
    return;
  }

  // Sprint 22 R1-A: the legacy `VoiceTrustContext` branch lived here. It read
  // and wrote `custom_trust_*` state on `whatsapp_conversations`, parked the
  // conversation in `building_custom_trust`, and inserted the assessment row
  // itself. That lane is gone: v2's `trust.question.*` steps own trust answers
  // end to end, and no producer of a non-v2 execution context has existed
  // since processor.ts's `startTrustTranscription` became the only site that
  // starts this pipeline (it always tags the payload with `v2`). Fail loudly
  // rather than silently dropping a worker's transcribed answer.
  throw new Error('voice-trust-receiver: non-v2 execution context is no longer supported');
}

export const handler: Handler<VoiceTrustReceiverEvent> = async (event) => {
  await handleVoiceTrustCompletion(event);
};
