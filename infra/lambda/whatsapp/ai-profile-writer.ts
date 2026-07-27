import type { Handler } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getDbPool, setRlsContext } from '../lib/db';
import { t, type Lang } from './lib/templates';
import { sendPendingOutbox } from './lib/outbox';
import { autoAdvanceProfileAfterAi } from './lib/profile-flow';
import {
  buildSyntheticVoiceInboundBody,
  syntheticVoiceSid,
  type ProfileIntakeVoiceEventV2,
  type VoiceExtractionFields,
} from './lib/voice-events';
import { hashNormalizedPhone } from './lib/runtime-controls';

// ── Module-level AWS clients ────────────────────────────────────
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});
const lambdaClient = new LambdaClient({});
const sqsClient = new SQSClient({});

const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-lite-v1:0';

const CONFIDENCE_THRESHOLD = parseFloat(
  process.env.AI_EXTRACTION_CONFIDENCE_THRESHOLD ?? '0.75',
);

const INDUSTRY_KEYWORDS: string[] = JSON.parse(
  process.env.AI_INDUSTRY_KEYWORDS ?? '[]',
);

// ── Types ───────────────────────────────────────────────────────

/**
 * Stream B (Task 8d): presence of this marker on an otherwise "v1-shaped"
 * `AiProfileWriterContext` is what selects the v2 completion branch — a
 * voice note ingested from the v2 lane's `profile.voice_choice` step
 * (processor.ts's `ingestProfileVoiceNote`) tags its Step Functions input
 * with this instead of inventing a parallel context shape. `startedAt` is
 * carried through only for `VoiceEventV2`'s common-envelope field —
 * nothing in this lambda or the router reads it back.
 */
export interface V2ProfileIntakeMarker {
  workflowRunId: string;
  expectedStepKey: string;
  startedAt: string;
}

export interface AiProfileWriterContext {
  userId: string;
  conversationId: string;
  inboundMessageSid?: string;
  whatsappNumber: string;
  language: Lang;
  mediaBucketName?: string;
  transcriptOutputKey?: string;
  voiceMessageMediaId?: string;
  v2?: V2ProfileIntakeMarker;
}

export interface VoicePipelineAiProfileWriterEvent {
  status: 'COMPLETED' | 'FAILED';
  executionContext: AiProfileWriterContext;
  /**
   * `$$.Execution.Id`, threaded in by the VoiceTranscriptionPipeline
   * construct's `invokeOnCompleted`/`invokeOnFailed` payloads (Task 8d's
   * one-line ASL change) — the deterministic execution ARN this lambda
   * embeds in the outbound `ProfileIntakeVoiceEventV2` so the router's
   * staleness check (`handleVoiceIntakeResult`) can compare it against
   * `state_context.v2VoiceExecutionArn`. Always present in practice for a
   * REAL Step Functions invocation; only ever absent in a hand-built legacy
   * event, which never carries a `v2` marker anyway.
   */
  executionArn?: string;
}

interface LegacyAiProfileWriterEvent extends AiProfileWriterContext {
  status: 'transcription_complete' | 'failed';
  errorMessage?: string;
}

export type AiProfileWriterEvent =
  | VoicePipelineAiProfileWriterEvent
  | LegacyAiProfileWriterEvent;

interface ExtractedFields {
  full_name?: string | null;
  city?: string | null;
  main_trade?: string | null;
  main_trade_other?: string | null;
  years_experience?: string | null;
  has_transportation?: boolean | null;
  availability?: string | null;
}

interface BedrockResult {
  extracted_fields: ExtractedFields;
  confidence_scores: Record<string, number>;
  summary_en: string;
  summary_es: string;
}

interface TrustQuestion {
  q_en: string;
  q_es: string;
}

function parseBedrockJsonResponse(responseText: string): BedrockResult {
  const trimmed = responseText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(jsonText) as BedrockResult;
}

// ── Transcript reader ────────────────────────────────────────────
async function readTranscript(bucketName: string, key: string): Promise<string> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucketName, Key: key }),
  );
  const raw = await (res.Body as any).transformToString();
  const parsed = JSON.parse(raw);
  return parsed.results?.transcripts?.[0]?.transcript ?? '';
}

// ── Bedrock extraction ───────────────────────────────────────────
async function extractProfileFromTranscript(
  transcript: string,
): Promise<BedrockResult> {
  const keywordsText =
    INDUSTRY_KEYWORDS.length > 0
      ? `\nKnown industry keywords: ${INDUSTRY_KEYWORDS.join(', ')}.`
      : '';

  const systemPrompt =
    `You are a profile extraction assistant for Jale, a bilingual job platform for blue-collar workers in the US.${keywordsText}\n` +
    `Extract structured profile information from voice message transcripts. Workers may speak English or Spanish.\n` +
    `Return ONLY valid JSON — no additional text, no markdown fences.`;

  const userPrompt =
    `Extract profile information from this transcript. Return JSON with exactly these keys:\n` +
    `{\n` +
    `  "extracted_fields": {\n` +
    `    "full_name": string or null,\n` +
    `    "city": string or null,\n` +
    `    "main_trade": one of ["electrician","plumber","carpenter","concrete","painting","other"] or null,\n` +
    `    "main_trade_other": string or null (only if main_trade is "other"),\n` +
    `    "years_experience": one of ["0-1","2-4","5-9","10+"] or null,\n` +
    `    "has_transportation": boolean or null,\n` +
    `    "availability": one of ["full_time","part_time","weekends","flexible"] or null\n` +
    `  },\n` +
    `  "confidence_scores": { same keys, values 0.0-1.0 indicating extraction confidence },\n` +
    `  "summary_en": "1-2 sentence profile summary in English",\n` +
    `  "summary_es": "1-2 sentence profile summary in Spanish"\n` +
    `}\n\n` +
    `Transcript: ${transcript}`;

  const res = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userPrompt }] }],
      inferenceConfig: { maxTokens: 1024 },
    }),
  );

  const responseText = res.output?.message?.content?.[0]?.text ?? '';
  return parseBedrockJsonResponse(responseText);
}

// ── DB helpers ───────────────────────────────────────────────────

/** Build a parameterized UPDATE users SET ... for fields above confidence threshold. */
function buildUserUpdateSql(
  userId: string,
  fields: ExtractedFields,
  scores: Record<string, number>,
): { sql: string; params: unknown[] } | null {
  const VALID_TRADES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'];
  const VALID_EXPERIENCE = ['0-1', '2-4', '5-9', '10+'];
  const VALID_AVAILABILITY = ['full_time', 'part_time', 'weekends', 'flexible'];

  const setClauses: string[] = [];
  const params: unknown[] = [];

  function maybeAdd(fieldName: keyof ExtractedFields, validator?: (v: unknown) => boolean) {
    const value = fields[fieldName];
    const confidence = scores[fieldName] ?? 0;
    if (value == null || confidence < CONFIDENCE_THRESHOLD) return;
    if (validator && !validator(value)) return;
    params.push(value);
    setClauses.push(`${fieldName} = $${params.length}`);
  }

  maybeAdd('full_name');
  maybeAdd('city');
  maybeAdd('main_trade', (v) => VALID_TRADES.includes(v as string));
  maybeAdd('main_trade_other');
  maybeAdd('years_experience', (v) => VALID_EXPERIENCE.includes(v as string));
  maybeAdd('has_transportation', (v) => typeof v === 'boolean');
  maybeAdd('availability', (v) => VALID_AVAILABILITY.includes(v as string));

  if (setClauses.length === 0) return null;

  params.push(userId);
  const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${params.length}`;
  return { sql, params };
}

async function queueOutboxText(
  client: PoolClient,
  inboundMessageSid: string,
  whatsappNumber: string,
  body: string,
): Promise<void> {
  const nextSeq = await client.query<{ next_seq: number }>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
       FROM whatsapp_outbox
      WHERE inbound_message_sid = $1`,
    [inboundMessageSid],
  );
  await client.query(
    `INSERT INTO whatsapp_outbox
       (inbound_message_sid, sequence, whatsapp_number, body)
     VALUES ($1, $2, $3, $4)`,
    [inboundMessageSid, nextSeq.rows[0].next_seq, whatsappNumber, body],
  );
}

async function setWorkerRlsContextByUserId(
  client: PoolClient,
  userId: string,
): Promise<void> {
  const userRow = await client.query<{ cognito_sub: string }>(
    `SELECT cognito_sub FROM users WHERE id = $1 AND user_type = 'worker'`,
    [userId],
  );
  const cognitoSub = userRow.rows[0]?.cognito_sub;
  if (!cognitoSub) throw new Error('worker cognito_sub missing before ai extraction write');
  await setRlsContext(client, cognitoSub);
}

function questionGeneratorArn(): string {
  const arn = process.env.QUESTION_GENERATOR_ARN;
  if (!arn) throw new Error('QUESTION_GENERATOR_ARN not set');
  return arn;
}

async function loadOrGenerateCustomTrustQuestions(
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

// ── Handler ─────────────────────────────────────────────────────
function normalizeEvent(event: AiProfileWriterEvent): {
  ctx: AiProfileWriterContext;
  status: 'COMPLETED' | 'FAILED';
  executionArn?: string;
} {
  if ('executionContext' in event) {
    return { ctx: event.executionContext, status: event.status, executionArn: event.executionArn };
  }

  const { status: legacyStatus, errorMessage: _errorMessage, ...ctx } = event;
  return {
    ctx,
    status: legacyStatus === 'failed' ? 'FAILED' : 'COMPLETED',
  };
}

function inboundV2QueueUrl(): string {
  const url = process.env.WHATSAPP_INBOUND_V2_QUEUE_URL;
  if (!url) throw new Error('WHATSAPP_INBOUND_V2_QUEUE_URL not set');
  return url;
}

/**
 * v2 branch (Task 8d): mirrors `voice-trust-receiver.ts`'s
 * `handleV2VoiceTrustCompletion` exactly — a synthetic `#vp`-suffixed event
 * on the SAME v2 inbound FIFO queue every other v2 message travels through,
 * so the processor's claim idempotency and per-phone ordering apply
 * unchanged. This lambda does NOT write `users`, does NOT touch the
 * outbox/state — every profile field write and the summary/fallback reply
 * happen in the router's turn, under the run lock, via the real
 * `ProfilePersistenceAdapter` methods (`handleVoiceIntakeResult`,
 * onboarding/steps/voice.ts).
 */
async function sendV2ProfileIntakeEvent(input: {
  status: 'COMPLETED' | 'FAILED';
  v2: V2ProfileIntakeMarker;
  whatsappNumber: string;
  language: Lang;
  origMessageSid: string;
  executionArn: string;
  extractionId: string | null;
  fields: VoiceExtractionFields | null;
  confidences: Record<string, number> | null;
  summaryEn: string | null;
  summaryEs: string | null;
}): Promise<void> {
  const phone = input.whatsappNumber.replace(/^whatsapp:/, '');
  const evt: ProfileIntakeVoiceEventV2 = {
    version: 'v2',
    kind: 'profile_intake',
    status: input.status,
    phone,
    runId: input.v2.workflowRunId,
    stepKey: input.v2.expectedStepKey,
    language: input.language,
    origMessageSid: input.origMessageSid,
    startedAt: input.v2.startedAt,
    executionArn: input.executionArn,
    extractionId: input.extractionId,
    fields: input.fields,
    confidences: input.confidences,
    summaryEn: input.summaryEn,
    summaryEs: input.summaryEs,
  };

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: inboundV2QueueUrl(),
      MessageBody: buildSyntheticVoiceInboundBody(evt),
      MessageGroupId: hashNormalizedPhone(phone),
      MessageDeduplicationId: syntheticVoiceSid(evt.origMessageSid, evt.kind),
    }),
  );

  console.log(JSON.stringify({
    metric: 'AiProfileWriterV2Requeued',
    kind: evt.kind,
    stepKey: evt.stepKey,
    status: evt.status,
  }));
}

export const handler: Handler<AiProfileWriterEvent> = async (event) => {
  const normalized = normalizeEvent(event);
  const {
    userId,
    conversationId,
    inboundMessageSid,
    whatsappNumber,
    language,
    mediaBucketName,
    transcriptOutputKey,
    voiceMessageMediaId,
    v2,
  } = normalized.ctx;
  const status = normalized.status;
  const outboxMessageSid = inboundMessageSid ?? conversationId;

  const pool = await getDbPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await setWorkerRlsContextByUserId(client, userId);

    if (status === 'FAILED') {
      // Write failed extraction record
      const failedExtraction = await client.query<{ id: string }>(
        `INSERT INTO worker_profile_ai_extractions
           (user_id, bedrock_model_id, status)
         VALUES ($1, $2, 'failed')
         RETURNING id`,
        [userId, BEDROCK_MODEL_ID],
      );

      if (v2) {
        if (!normalized.executionArn) {
          throw new Error('executionArn missing on v2 profile-intake completion (FAILED)');
        }
        // Task 8 fix: COMMIT before publishing the synthetic `#vp` event —
        // this transaction is held open across S3/Bedrock calls, and
        // publishing first meant a COMMIT failure left an event referencing
        // a rolled-back `extractionId` already delivered, with FIFO
        // deduplication then blocking any correction from ever landing. A
        // publish failure AFTER a successful commit is safe: the row
        // exists, so the pipeline's own retry/alarms cover it.
        await client.query('COMMIT');
        committed = true;
        await sendV2ProfileIntakeEvent({
          status: 'FAILED',
          v2,
          whatsappNumber,
          language,
          origMessageSid: outboxMessageSid,
          executionArn: normalized.executionArn,
          extractionId: failedExtraction.rows[0]?.id ?? null,
          fields: null,
          confidences: null,
          summaryEn: null,
          summaryEs: null,
        });
        return;
      }

      // ── v1 legacy path — UNCHANGED ──────────────────────────────
      await queueOutboxText(
        client,
        outboxMessageSid,
        whatsappNumber,
        t('ai_extraction_failed', language),
      );

      await autoAdvanceProfileAfterAi(
        client,
        {
          userId,
          conversationId,
          inboundMessageSid: outboxMessageSid,
          language,
          queueBody: (body) => queueOutboxText(client, outboxMessageSid, whatsappNumber, body),
          loadCustomTrustQuestions: loadOrGenerateCustomTrustQuestions,
        },
      );

      await client.query('COMMIT');
      committed = true;
      await sendPendingOutbox(client, outboxMessageSid);
      return;
    }

    // status === 'COMPLETED'
    if (!mediaBucketName || !transcriptOutputKey) {
      throw new Error('mediaBucketName and transcriptOutputKey required for completed transcription');
    }

    const transcript = await readTranscript(mediaBucketName, transcriptOutputKey);
    const result = await extractProfileFromTranscript(transcript);

    // Write extraction record (link voice media row if available) — SQL is
    // unchanged for v1/v2 alike; only `RETURNING id` was added so the v2
    // branch can thread `extractionId` into the outbound event.
    const extraction = await client.query<{ id: string }>(
      `INSERT INTO worker_profile_ai_extractions
         (user_id, voice_message_media_id, bedrock_model_id, transcript_text, extracted_fields, confidence_scores, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed')
       RETURNING id`,
      [
        userId,
        voiceMessageMediaId ?? null,
        BEDROCK_MODEL_ID,
        transcript,
        JSON.stringify(result.extracted_fields),
        JSON.stringify(result.confidence_scores),
      ],
    );

    if (v2) {
      if (!normalized.executionArn) {
        throw new Error('executionArn missing on v2 profile-intake completion (COMPLETED)');
      }
      // NO users UPDATE, NO outbox write, NO autoAdvanceProfileAfterAi — every
      // profile field write and the summary/fallback reply happen in the
      // router's turn, under the run lock, via the real
      // ProfilePersistenceAdapter methods (Task 8d).
      //
      // Task 8 fix: COMMIT before publishing — see the FAILED branch above
      // for why publish-then-commit is unsafe.
      await client.query('COMMIT');
      committed = true;
      await sendV2ProfileIntakeEvent({
        status: 'COMPLETED',
        v2,
        whatsappNumber,
        language,
        origMessageSid: outboxMessageSid,
        executionArn: normalized.executionArn,
        extractionId: extraction.rows[0]?.id ?? null,
        fields: result.extracted_fields,
        confidences: result.confidence_scores,
        summaryEn: result.summary_en,
        summaryEs: result.summary_es,
      });
      return;
    }

    // ── v1 legacy path — UNCHANGED ────────────────────────────────
    // Write high-confidence fields to users
    const update = buildUserUpdateSql(userId, result.extracted_fields, result.confidence_scores);
    if (update) {
      await client.query(update.sql, update.params);
    }

    // Queue confirmation summary
    const summary = language === 'en' ? result.summary_en : result.summary_es;
    await queueOutboxText(
      client,
      outboxMessageSid,
      whatsappNumber,
      t('ai_extraction_summary', language, { summary }),
    );

    await autoAdvanceProfileAfterAi(
      client,
      {
        userId,
        conversationId,
        inboundMessageSid: outboxMessageSid,
        language,
        queueBody: (body) => queueOutboxText(client, outboxMessageSid, whatsappNumber, body),
        loadCustomTrustQuestions: loadOrGenerateCustomTrustQuestions,
      },
    );

    await client.query('COMMIT');
    committed = true;
    await sendPendingOutbox(client, outboxMessageSid);
  } catch (err) {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    }
    console.error('[ai-profile-writer] failed:', (err as Error).message);
    throw err;
  } finally {
    client.release();
  }
};
