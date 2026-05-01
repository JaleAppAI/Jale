import type { Handler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getDbPool } from '../lib/db';
import { t, type Lang } from './lib/templates';

// ── Module-level AWS clients ────────────────────────────────────
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'amazon.nova-lite-v1:0';

const CONFIDENCE_THRESHOLD = parseFloat(
  process.env.AI_EXTRACTION_CONFIDENCE_THRESHOLD ?? '0.75',
);

const INDUSTRY_KEYWORDS: string[] = JSON.parse(
  process.env.AI_INDUSTRY_KEYWORDS ?? '[]',
);

// ── Types ───────────────────────────────────────────────────────
export interface AiProfileWriterEvent {
  userId: string;
  conversationId: string;
  whatsappNumber: string;
  language: Lang;
  mediaBucketName?: string;
  transcriptOutputKey?: string;
  voiceMessageMediaId?: string;
  status: 'transcription_complete' | 'failed';
  errorMessage?: string;
}

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
  return JSON.parse(responseText) as BedrockResult;
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

// ── Handler ─────────────────────────────────────────────────────
export const handler: Handler<AiProfileWriterEvent> = async (event) => {
  const {
    userId,
    conversationId,
    whatsappNumber,
    language,
    mediaBucketName,
    transcriptOutputKey,
    voiceMessageMediaId,
    status,
  } = event;

  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (status === 'failed') {
      // Write failed extraction record
      await client.query(
        `INSERT INTO worker_profile_ai_extractions
           (user_id, bedrock_model_id, status)
         VALUES ($1, $2, 'failed')`,
        [userId, BEDROCK_MODEL_ID],
      );

      // Queue fallback reply
      const replyBody = t('ai_extraction_failed', language);
      const nextSeq = await client.query<{ next_seq: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
           FROM whatsapp_outbox
          WHERE inbound_message_sid = $1`,
        [conversationId],
      );
      await client.query(
        `INSERT INTO whatsapp_outbox
           (inbound_message_sid, sequence, whatsapp_number, body)
         VALUES ($1, $2, $3, $4)`,
        [conversationId, nextSeq.rows[0].next_seq, whatsappNumber, replyBody],
      );

      // Transition state to building_profile
      await client.query(
        `UPDATE whatsapp_conversations
            SET conversation_state = 'building_profile',
                updated_at = NOW()
          WHERE id = $1`,
        [conversationId],
      );

      await client.query('COMMIT');
      return;
    }

    // status === 'transcription_complete'
    if (!mediaBucketName || !transcriptOutputKey) {
      throw new Error('mediaBucketName and transcriptOutputKey required for transcription_complete');
    }

    const transcript = await readTranscript(mediaBucketName, transcriptOutputKey);
    const result = await extractProfileFromTranscript(transcript);

    // Write extraction record (link voice media row if available)
    await client.query(
      `INSERT INTO worker_profile_ai_extractions
         (user_id, voice_message_media_id, bedrock_model_id, transcript_text, extracted_fields, confidence_scores, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed')`,
      [
        userId,
        voiceMessageMediaId ?? null,
        BEDROCK_MODEL_ID,
        transcript,
        JSON.stringify(result.extracted_fields),
        JSON.stringify(result.confidence_scores),
      ],
    );

    // Write high-confidence fields to users
    const update = buildUserUpdateSql(userId, result.extracted_fields, result.confidence_scores);
    if (update) {
      await client.query(update.sql, update.params);
    }

    // Queue confirmation summary
    const summary = language === 'en' ? result.summary_en : result.summary_es;
    const summaryBody = t('ai_extraction_summary', language, { summary });
    const nextSeq = await client.query<{ next_seq: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
         FROM whatsapp_outbox
        WHERE inbound_message_sid = $1`,
      [conversationId],
    );
    await client.query(
      `INSERT INTO whatsapp_outbox
         (inbound_message_sid, sequence, whatsapp_number, body)
       VALUES ($1, $2, $3, $4)`,
      [conversationId, nextSeq.rows[0].next_seq, whatsappNumber, summaryBody],
    );

    // Transition state to building_profile
    await client.query(
      `UPDATE whatsapp_conversations
          SET conversation_state = 'building_profile',
              updated_at = NOW()
        WHERE id = $1`,
      [conversationId],
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    console.error('[ai-profile-writer] failed:', (err as Error).message);
    throw err;
  } finally {
    client.release();
  }
};
