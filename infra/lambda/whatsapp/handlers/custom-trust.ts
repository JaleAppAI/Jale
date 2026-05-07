import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { Lang } from '../lib/templates';
import type { TwilioSecret } from '../lib/twilio';
import {
  buildS3Key,
  detectMediaCategory,
  downloadTwilioMedia,
  uploadMediaToS3,
} from '../lib/media';

const lambdaClient = new LambdaClient({});
const sqsClient = new SQSClient({});
const secretsManager = new SecretsManagerClient({});

export interface TrustQuestion {
  q_en: string;
  q_es: string;
}

export interface TrustAnswer {
  q_en: string;
  answer_text: string;
  answer_source: 'text' | 'voice';
  answered_at: string;
}

interface ConvRow {
  id: string;
  user_id: string;
  language: Lang;
  state_context: Record<string, unknown>;
}

interface IncomingMessage {
  from: string;
  messageSid: string;
  body: string;
  mediaUrl?: string;
  mediaContentType?: string;
}

function questionGeneratorArn(): string {
  const arn = process.env.QUESTION_GENERATOR_ARN;
  if (!arn) throw new Error('QUESTION_GENERATOR_ARN not set');
  return arn;
}

function trustAssessmentQueueUrl(): string {
  const url = process.env.TRUST_ASSESSMENT_QUEUE_URL;
  if (!url) throw new Error('TRUST_ASSESSMENT_QUEUE_URL not set');
  return url;
}

function trustPipelineArn(): string {
  const arn = process.env.TRUST_PIPELINE_STATE_MACHINE_ARN;
  if (!arn) throw new Error('TRUST_PIPELINE_STATE_MACHINE_ARN not set');
  return arn;
}

// Contract: lowercase, trim, collapse whitespace, hyphens/punctuation to spaces,
// strip accents. Must match normalizeProfession() in lambda/ai/question-generator.ts.
export function normalizeProfession(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[-./]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

async function getTwilioSecret(): Promise<TwilioSecret> {
  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) throw new Error('TWILIO_SECRET_ARN not set');
  const result = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (!result.SecretString) throw new Error('TWILIO secret empty');
  return JSON.parse(result.SecretString) as TwilioSecret;
}

async function loadOrGenerateQuestions(
  client: PoolClient,
  professionKey: string,
  professionRaw: string,
): Promise<TrustQuestion[]> {
  const cached = await client.query<{ questions: TrustQuestion[] }>(
    'SELECT questions FROM trade_questions WHERE profession_key = $1',
    [professionKey],
  );
  if (cached.rows.length > 0) return cached.rows[0].questions;

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: questionGeneratorArn(),
      Payload: Buffer.from(JSON.stringify({ professionKey, professionRaw })),
    }),
  );
  return JSON.parse(Buffer.from(response.Payload ?? new Uint8Array()).toString()) as TrustQuestion[];
}

export async function handleBuildingCustomTrust(
  client: PoolClient,
  conv: ConvRow,
  msg: IncomingMessage,
): Promise<void> {
  if (!conv.user_id) throw new Error('user_id missing in building_custom_trust');

  const ctx = conv.state_context ?? {};
  const step = (ctx.custom_trust_step as number) ?? 0;
  const professionRaw = (ctx.custom_trust_profession as string) ?? '';
  const professionKey = normalizeProfession(professionRaw);
  const answers = (ctx.custom_trust_answers as TrustAnswer[]) ?? [];

  const existing = await client.query(
    `SELECT id FROM worker_trust_assessments
     WHERE user_id = $1 AND profession_key = $2
       AND status IN ('pending','scoring','scored','failed')`,
    [conv.user_id, professionKey],
  );
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE whatsapp_conversations
       SET conversation_state = 'idle', state_context = '{}'::jsonb
       WHERE id = $1`,
      [conv.id],
    );
    const confirmation = conv.language === 'es'
      ? 'Gracias. Hemos registrado tu experiencia. Te avisaremos sobre trabajos que encajen.'
      : "Thanks! We've noted your experience. We'll be in touch with matching jobs.";
    await queueOutboxText(client, msg.messageSid, msg.from, confirmation);
    return;
  }

  let questions = (ctx.custom_trust_questions as TrustQuestion[]) ?? [];
  if (questions.length === 0) {
    questions = await loadOrGenerateQuestions(client, professionKey, professionRaw);
  }

  const assessmentId = (ctx.custom_trust_assessment_id as string) ?? randomUUID();

  if (step === 0 && !msg.body.trim() && answers.length === 0) {
    const questionText = conv.language === 'es' ? questions[0].q_es : questions[0].q_en;
    await client.query(
      `UPDATE whatsapp_conversations
       SET state_context = state_context || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          custom_trust_questions: questions,
          custom_trust_assessment_id: assessmentId,
        }),
        conv.id,
      ],
    );
    await queueOutboxText(client, msg.messageSid, msg.from, questionText);
    return;
  }

  if (msg.mediaUrl && msg.mediaContentType) {
    const category = detectMediaCategory(msg.mediaContentType);
    if (category !== 'voice') {
      await queueOutboxText(
        client,
        msg.messageSid,
        msg.from,
        conv.language === 'es'
          ? 'Por favor manda una nota de voz o escribe tu respuesta.'
          : 'Please send a voice note or type your answer.',
      );
      return;
    }

    const bucketName = process.env.MEDIA_BUCKET_NAME;
    if (!bucketName) throw new Error('MEDIA_BUCKET_NAME not set');
    const twilioSecret = await getTwilioSecret();
    const mediaBuffer = await downloadTwilioMedia(
      msg.mediaUrl,
      twilioSecret.accountSid,
      twilioSecret.authToken,
    );
    const mediaId = `${assessmentId}-${step}`;
    const s3Key = buildS3Key(conv.user_id, mediaId, 'voice');
    await uploadMediaToS3(bucketName, s3Key, mediaBuffer, msg.mediaContentType);

    const transcriptionJobName = `jale-trust-${assessmentId.replace(/-/g, '')}-${step}`;
    const mediaS3Uri = `s3://${bucketName}/${s3Key}`;
    const transcriptOutputKey = `transcripts/trust/${assessmentId}-step${step}.json`;
    const sfn = await import('@aws-sdk/client-sfn');
    const sfnClient = new sfn.SFNClient({});
    await sfnClient.send(
      new sfn.StartExecutionCommand({
        stateMachineArn: trustPipelineArn(),
        input: JSON.stringify({
          transcriptionJobName,
          languageCode: conv.language === 'es' ? 'es-US' : 'en-US',
          mediaS3Uri,
          mediaBucketName: bucketName,
          transcriptOutputKey,
          userId: conv.user_id,
          conversationId: conv.id,
          inboundMessageSid: msg.messageSid,
          whatsappNumber: msg.from,
          language: conv.language,
          trustStep: step,
          assessmentId,
          trustQuestions: questions,
        }),
      }),
    );

    await client.query(
      `UPDATE whatsapp_conversations
       SET conversation_state = 'processing_ai',
           state_context = state_context || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          processing_ai_type: 'trust',
          custom_trust_questions: questions,
          custom_trust_assessment_id: assessmentId,
        }),
        conv.id,
      ],
    );
    return;
  }

  const currentQuestion = questions[step];
  const newAnswer: TrustAnswer = {
    q_en: currentQuestion.q_en,
    answer_text: msg.body.trim(),
    answer_source: 'text',
    answered_at: new Date().toISOString(),
  };
  const updatedAnswers = [...answers, newAnswer];

  if (step < 2) {
    const nextQuestion = questions[step + 1];
    const nextText = conv.language === 'es' ? nextQuestion.q_es : nextQuestion.q_en;
    await client.query(
      `UPDATE whatsapp_conversations
       SET state_context = state_context || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          custom_trust_step: step + 1,
          custom_trust_answers: updatedAnswers,
        }),
        conv.id,
      ],
    );
    await queueOutboxText(client, msg.messageSid, msg.from, nextText);
    return;
  }

  await client.query(
    `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status)
     VALUES ($1, $2, $3, $4::jsonb, 'pending')
     ON CONFLICT DO NOTHING`,
    [assessmentId, conv.user_id, professionKey, JSON.stringify(updatedAnswers)],
  );
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: trustAssessmentQueueUrl(),
      MessageBody: JSON.stringify({ assessmentId, userId: conv.user_id, professionKey }),
    }),
  );

  const confirmation = conv.language === 'es'
    ? 'Gracias. Hemos registrado tu experiencia. Te avisaremos sobre trabajos que encajen.'
    : "Thanks! We've noted your experience. We'll be in touch with matching jobs.";
  await client.query(
    `UPDATE whatsapp_conversations
     SET conversation_state = 'idle', state_context = '{}'::jsonb
     WHERE id = $1`,
    [conv.id],
  );
  await queueOutboxText(client, msg.messageSid, msg.from, confirmation);
}
