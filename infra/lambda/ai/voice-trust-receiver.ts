import type { Handler } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getDbPool } from '../lib/db';
import type { Lang } from '../whatsapp/lib/templates';
import { sendPendingOutbox } from '../whatsapp/lib/outbox';
import { normalizeProfession } from '../whatsapp/handlers/custom-trust';
import {
  drainTrustAssessmentEnqueueOutbox,
  queueTrustAssessmentEnqueue,
} from '../whatsapp/lib/trust-assessment-outbox';

const s3 = new S3Client({});

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

export interface VoiceTrustReceiverEvent {
  status: 'COMPLETED' | 'FAILED';
  executionContext: VoiceTrustContext;
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

export async function handleVoiceTrustCompletion(
  event: VoiceTrustReceiverEvent,
): Promise<void> {
  const ctx = event.executionContext;
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

    await queueTrustAssessmentEnqueue(client, ctx.assessmentId, ctx.userId, professionKey);

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
    await drainTrustAssessmentEnqueueOutbox(client);
    await sendPendingOutbox(client, ctx.inboundMessageSid);
  } finally {
    client.release();
  }
}

export const handler: Handler<VoiceTrustReceiverEvent> = async (event) => {
  await handleVoiceTrustCompletion(event);
};
