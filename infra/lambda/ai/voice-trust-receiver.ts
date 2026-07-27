import type { Handler } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getDbPool } from '../lib/db';
import type { Lang } from '../whatsapp/lib/templates';
import { sendPendingOutbox } from '../whatsapp/lib/outbox';
import { normalizeProfession } from '../whatsapp/handlers/custom-trust';
import {
  buildSyntheticVoiceInboundBody,
  syntheticVoiceSid,
  type VoiceEventV2,
} from '../whatsapp/lib/voice-events';
import { hashNormalizedPhone } from '../whatsapp/lib/runtime-controls';

const s3 = new S3Client({});
const sqsClient = new SQSClient({});

interface TrustQuestion {
  q_en: string;
  q_es: string;
}

interface TrustAnswer {
  q_en: string;
  answer_text: string;
  answer_source: 'text' | 'voice';
  answered_at: string;
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
  };
  mediaBucketName: string;
  transcriptOutputKey: string;
}

export interface VoiceTrustReceiverEvent {
  status: 'COMPLETED' | 'FAILED';
  executionContext: VoiceTrustContext | V2TrustExecutionContext;
}

function isV2TrustExecutionContext(
  ctx: VoiceTrustContext | V2TrustExecutionContext,
): ctx is V2TrustExecutionContext {
  return (ctx as V2TrustExecutionContext).v2?.version === 'v2';
}

function trustQueueUrl(): string {
  const url = process.env.TRUST_ASSESSMENT_QUEUE_URL;
  if (!url) throw new Error('TRUST_ASSESSMENT_QUEUE_URL not set');
  return url;
}

function inboundV2QueueUrl(): string {
  const url = process.env.WHATSAPP_INBOUND_V2_QUEUE_URL;
  if (!url) throw new Error('WHATSAPP_INBOUND_V2_QUEUE_URL not set');
  return url;
}

async function readTranscript(bucket: string, key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await (res.Body as { transformToString: () => Promise<string> }).transformToString();
  const parsed = JSON.parse(raw);
  return parsed.results?.transcripts?.[0]?.transcript ?? '';
}

async function queueOutboxText(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  body: string,
): Promise<void> {
  await client.query(
    `INSERT INTO whatsapp_outbox
        (inbound_message_sid, sequence, whatsapp_number, body)
     VALUES (
       $1::varchar,
       (SELECT COALESCE(MAX(sequence), 0) + 1
          FROM whatsapp_outbox
         WHERE inbound_message_sid = $1::varchar),
       $2, $3
     )`,
    [inboundMessageSid, to.replace(/^whatsapp:/, ''), body],
  );
}

/**
 * v2 branch: the SAME Step Functions pipeline (Twilio media -> S3 ->
 * Transcribe) that feeds the legacy `building_custom_trust` flow above also
 * feeds v2's `trust.question.*` steps, but v2 re-entry does ZERO DB work
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
    transcript = await readTranscript(ctx.mediaBucketName, ctx.transcriptOutputKey);
    if (transcript.trim().length === 0) {
      finalStatus = 'FAILED';
    }
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
    await handleV2VoiceTrustCompletion(event.status, event.executionContext);
    return;
  }

  const ctx = event.executionContext;
  // 2026-07-27 observability pass: this Lambda previously had ZERO log
  // lines — a bad transcript or DB error surfaced only as the platform's
  // generic invocation error. Safe scalars only: never the transcript text,
  // the answer text, or a phone number.
  console.log(JSON.stringify({
    metric: 'VoiceTrustReceiverStarted',
    status: event.status,
    trustStep: ctx.trustStep,
    conversationId: ctx.conversationId,
  }));
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    const convRow = await client.query<{ state_context: Record<string, unknown> }>(
      'SELECT state_context FROM whatsapp_conversations WHERE id = $1',
      [ctx.conversationId],
    );
    const stateCtx = convRow.rows[0]?.state_context ?? {};
    const answers = (stateCtx.custom_trust_answers as TrustAnswer[]) ?? [];
    const questions =
      (stateCtx.custom_trust_questions as TrustQuestion[]) ?? ctx.trustQuestions;
    const professionRaw = String(stateCtx.custom_trust_profession ?? '');
    const professionKey = normalizeProfession(professionRaw);

    if (event.status === 'FAILED') {
      const retryMsg = ctx.language === 'es'
        ? 'Tuvimos un problema con tu mensaje de voz. Por favor escribe tu respuesta o intenta de nuevo.'
        : 'We had trouble processing your voice message. Please type your answer or try again.';
      await client.query(
        `UPDATE whatsapp_conversations
         SET conversation_state = 'building_custom_trust'
         WHERE id = $1`,
        [ctx.conversationId],
      );
      await queueOutboxText(client, ctx.inboundMessageSid, ctx.whatsappNumber, retryMsg);
      await sendPendingOutbox(client, ctx.inboundMessageSid);
      return;
    }

    const transcriptText = await readTranscript(
      ctx.mediaBucketName,
      ctx.transcriptOutputKey,
    );
    const step = ctx.trustStep;
    const newAnswer: TrustAnswer = {
      q_en: questions[step]?.q_en ?? '',
      answer_text: transcriptText,
      answer_source: 'voice',
      answered_at: new Date().toISOString(),
    };
    const updatedAnswers = [...answers, newAnswer];

    if (step < 2) {
      const nextQuestion = questions[step + 1];
      const nextText = ctx.language === 'es'
        ? nextQuestion.q_es
        : nextQuestion.q_en;
      await client.query(
        `UPDATE whatsapp_conversations
         SET conversation_state = 'building_custom_trust',
             state_context = state_context || $1::jsonb
         WHERE id = $2`,
        [
          JSON.stringify({
            custom_trust_step: step + 1,
            custom_trust_answers: updatedAnswers,
          }),
          ctx.conversationId,
        ],
      );
      await queueOutboxText(client, ctx.inboundMessageSid, ctx.whatsappNumber, nextText);
      await sendPendingOutbox(client, ctx.inboundMessageSid);
      return;
    }

    await client.query(
      `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status)
       VALUES ($1, $2, $3, $4::jsonb, 'pending')
       ON CONFLICT DO NOTHING`,
      [
        ctx.assessmentId,
        ctx.userId,
        professionKey,
        JSON.stringify(updatedAnswers),
      ],
    );

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: trustQueueUrl(),
        MessageBody: JSON.stringify({
          assessmentId: ctx.assessmentId,
          userId: ctx.userId,
          professionKey,
        }),
      }),
    );

    const confirmation = ctx.language === 'es'
      ? 'Gracias. Hemos registrado tu experiencia. Te avisaremos sobre trabajos que encajen.'
      : "Thanks! We've noted your experience. We'll be in touch with matching jobs.";
    await client.query(
      `UPDATE whatsapp_conversations
       SET conversation_state = 'idle', state_context = '{}'::jsonb
       WHERE id = $1`,
      [ctx.conversationId],
    );
    await queueOutboxText(client, ctx.inboundMessageSid, ctx.whatsappNumber, confirmation);
    await sendPendingOutbox(client, ctx.inboundMessageSid);
  } catch (err) {
    console.error(JSON.stringify({
      metric: 'VoiceTrustReceiverFailed',
      trustStep: ctx.trustStep,
      conversationId: ctx.conversationId,
      err: (err as Error)?.message?.slice(0, 300) ?? 'unknown',
    }));
    throw err;
  } finally {
    client.release();
  }
}

export const handler: Handler<VoiceTrustReceiverEvent> = async (event) => {
  await handleVoiceTrustCompletion(event);
};
