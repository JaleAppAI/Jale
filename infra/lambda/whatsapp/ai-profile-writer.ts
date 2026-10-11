import type { Handler } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getDbPool, setRlsContext } from '../lib/db';
import { readTranscriptResult, type TranscriptResult } from '../lib/transcript';
import { t, type Lang } from './lib/templates';
import { sendPendingOutbox } from './lib/outbox';
import {
  buildSyntheticVoiceInboundBody,
  syntheticVoiceSid,
  type ProfileIntakeVoiceEventV2,
  type VoiceExtractionFields,
} from './lib/voice-events';
import { hashNormalizedPhone } from './lib/runtime-controls';
import { canonicalizeWorkerTrade } from '../lib/trade-canonical';
import { requestTradeAliasGeneration } from '../lib/trade-alias-request';
import { TRADE_KEYS, EXPERIENCE_KEYS, AVAILABILITY_KEYS } from '../lib/worker-vocab';

// ── Module-level AWS clients ────────────────────────────────────
const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});
const sqsClient = new SQSClient({});

const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

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

function parseBedrockJsonResponse(responseText: string): BedrockResult {
  const trimmed = responseText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(jsonText) as BedrockResult;
}

// ── ASR metadata prompt block ─────────────────────────────────────
//
// Appended to the end of the user prompt, calibration-only: it never
// introduces new extractable content, only signals to Bedrock which parts
// of the transcript are less trustworthy. Each line is included only when
// its underlying data exists; the whole block (including its header) is
// omitted when none of the three lines would have anything to show.
function buildAsrMetadataPromptBlock(transcript: TranscriptResult): string {
  const lines: string[] = [];

  if (transcript.languages && transcript.languages.length > 0) {
    lines.push(`- Detected language(s): ${transcript.languages.join(', ')}`);
  }

  if (typeof transcript.avgConfidence === 'number') {
    lines.push(`- Overall transcription confidence: ${transcript.avgConfidence.toFixed(2)}`);
  }

  if (transcript.words && transcript.words.length > 0) {
    const lowConfidenceWords = transcript.words
      .filter((word) => word.conf !== null && word.conf < 0.5)
      .slice(0, 10);
    if (lowConfidenceWords.length > 0) {
      const wordsText = lowConfidenceWords
        .map((word) => `"${word.w}" (${(word.conf as number).toFixed(2)})`)
        .join(', ');
      lines.push(`- Possibly mistranscribed words: ${wordsText}`);
    }
  }

  if (lines.length === 0) return '';
  return `ASR metadata (calibration only, do not extract from it):\n${lines.join('\n')}`;
}

// ── Bedrock extraction ───────────────────────────────────────────
async function extractProfileFromTranscript(
  transcript: TranscriptResult,
): Promise<BedrockResult> {
  const keywordsText =
    INDUSTRY_KEYWORDS.length > 0
      ? `\nKnown industry keywords: ${INDUSTRY_KEYWORDS.join(', ')}.`
      : '';

  const systemPrompt =
    `You are a profile extraction assistant for Jale, a bilingual job platform for blue-collar workers in the US.${keywordsText}\n` +
    `Extract structured profile information from voice message transcripts. Workers may speak English or Spanish.\n` +
    `Return ONLY valid JSON — no additional text, no markdown fences.\n` +
    `You may be given ASR metadata about transcription quality. Use it only to calibrate confidence_scores (lower confidence for fields supported by low-confidence words); never copy it into extracted fields.`;

  const asrMetadataBlock = buildAsrMetadataPromptBlock(transcript);

  const userPrompt =
    `Extract profile information from this transcript. Return JSON with exactly these keys:\n` +
    `{\n` +
    `  "extracted_fields": {\n` +
    `    "full_name": string or null,\n` +
    `    "city": "City, ST" format using 2-letter US state abbreviation (e.g., "El Paso, TX"), infer state for unnamed US cities, null if no location or not a US location,\n` +
    // The three enumerations the model must choose from are rendered from
    // `lib/worker-vocab` rather than retyped: JSON.stringify of those key
    // tuples reproduces these arrays byte for byte (no spaces after the
    // commas), and a vocabulary change now reaches the prompt and the
    // validator below in the same edit instead of only one of them.
    `    "main_trade": one of ${JSON.stringify(TRADE_KEYS)} or null,\n` +
    `    "main_trade_other": string or null (only if main_trade is "other"),\n` +
    `    "years_experience": one of ${JSON.stringify(EXPERIENCE_KEYS)} or null,\n` +
    `    "has_transportation": boolean or null,\n` +
    `    "availability": one of ${JSON.stringify(AVAILABILITY_KEYS)} or null\n` +
    `  },\n` +
    `  "confidence_scores": { same keys, values 0.0-1.0 indicating extraction confidence },\n` +
    `  "summary_en": "1-2 sentence profile summary in English",\n` +
    `  "summary_es": "1-2 sentence profile summary in Spanish"\n` +
    `}\n\n` +
    `Transcript: ${transcript.text}` +
    (asrMetadataBlock ? `\n\n${asrMetadataBlock}` : '');

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

/**
 * Builds the `asr_metadata` JSONB value persisted alongside both the
 * completed and failed `worker_profile_ai_extractions` rows. NULL when no
 * transcript was ever successfully read (e.g. an already-FAILED Transcribe
 * job, or an S3 read error caught by the COMPLETED guard below).
 */
function buildAsrMetadata(
  transcript: TranscriptResult | undefined,
): Record<string, unknown> | null {
  if (!transcript) return null;
  return {
    provider: transcript.provider ?? null,
    languages: transcript.languages ?? null,
    avg_confidence: transcript.avgConfidence ?? null,
    word_count: transcript.words?.length ?? null,
    low_confidence_word_count:
      transcript.words?.filter((word) => word.conf !== null && word.conf < 0.5).length ?? null,
  };
}

/**
 * L6 — the canonicalised trade pair to force into the users UPDATE, replacing
 * whatever the extractor put in `main_trade`/`main_trade_other`.
 *
 * `requestAliasFor` is the text to hand the alias generator (non-null only
 * when `trade_aliases` had no row for it), so the cache learns the trade and
 * the NEXT write canonicalises.
 */
interface TradeOverride {
  main_trade: string;
  main_trade_other: string | null;
  requestAliasFor: string | null;
}

/**
 * Canonicalises the extracted free-text trade, or returns null when there is
 * nothing to canonicalise: no extraction, no `main_trade_other`, or a
 * confidence below the threshold this handler applies to every other field.
 *
 * MUST be called before the transaction opens — an errored statement aborts a
 * Postgres transaction, so a failed `trade_aliases` read after BEGIN would
 * take the extraction row down with it. `canonicalizeWorkerTrade` also fails
 * open, so a cache outage degrades to the worker's own words.
 */
async function resolveExtractedTradeOverride(
  client: PoolClient,
  extraction: BedrockResult | undefined,
  language: Lang,
): Promise<TradeOverride | null> {
  const raw = extraction?.extracted_fields?.main_trade_other;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  if ((extraction!.confidence_scores?.main_trade_other ?? 0) < CONFIDENCE_THRESHOLD) return null;

  // A confident STANDARD enum answer wins. The extractor is asked for
  // `main_trade` as one of TRADE_KEYS or null, with the free-text field as its
  // fallback; when it committed to a real enum key, canonicalising the free
  // text over it would throw away the better answer this handler used to
  // write. 'other' is not such an answer — that is precisely the case the
  // free text describes.
  const extractedTrade = extraction!.extracted_fields.main_trade;
  const standardAnswer =
    typeof extractedTrade === 'string' &&
    extractedTrade !== 'other' &&
    (TRADE_KEYS as readonly string[]).includes(extractedTrade) &&
    (extraction!.confidence_scores?.main_trade ?? 0) >= CONFIDENCE_THRESHOLD;
  if (standardAnswer) return null;

  const canonical = await canonicalizeWorkerTrade(client, { raw, lang: language });

  // Blank after tidying would mean main_trade='other' with a null other —
  // `chk_trade_other` (004_whatsapp.sql:66-70) rejects that pair, so skip.
  if (canonical.main_trade === 'other' && !canonical.main_trade_other) return null;

  return {
    main_trade: canonical.main_trade,
    main_trade_other: canonical.main_trade_other,
    requestAliasFor: canonical.resolved ? null : canonical.main_trade_other,
  };
}

/** Build a parameterized UPDATE users SET ... for fields above confidence threshold. */
function buildUserUpdateSql(
  userId: string,
  fields: ExtractedFields,
  scores: Record<string, number>,
  tradeOverride?: TradeOverride | null,
): { sql: string; params: unknown[] } | null {
  // Widened to readonly string[] on purpose: the callers below hand these
  // `unknown` values cast to string, which a narrowed literal-union tuple
  // would reject.
  const VALID_TRADES: readonly string[] = TRADE_KEYS;
  const VALID_EXPERIENCE: readonly string[] = EXPERIENCE_KEYS;
  const VALID_AVAILABILITY: readonly string[] = AVAILABILITY_KEYS;

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
  if (tradeOverride) {
    // Both columns are forced as a PAIR, `main_trade_other` included even when
    // null: `maybeAdd` skips nulls, which would leave the old free text
    // sitting beside a promoted standard enum key. The pair is already known
    // to satisfy `chk_trade_other` (see resolveExtractedTradeOverride).
    params.push(tradeOverride.main_trade);
    setClauses.push(`main_trade = $${params.length}`);
    params.push(tradeOverride.main_trade_other);
    setClauses.push(`main_trade_other = $${params.length}`);
  } else {
    maybeAdd('main_trade', (v) => VALID_TRADES.includes(v as string));
    maybeAdd('main_trade_other');
  }
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
  const outboxMessageSid = inboundMessageSid ?? conversationId;

  // ── Transcript read + Bedrock extraction — BEFORE the DB transaction ────
  // Neither needs DB state, and holding a Postgres transaction open across
  // two network calls (S3 + Bedrock) needlessly extends the lock window.
  // `effectiveStatus` starts as the incoming status; the guard below
  // downgrades it to FAILED on an S3 read error or an empty transcript,
  // mirroring voice-trust-receiver.ts's graceful degrade — the DB flow
  // below then runs the SAME FAILED branch it always has, exactly as if
  // Transcribe itself had reported failure. Bedrock JSON-parse failures are
  // out of scope for this guard and still throw uncaught, same as today.
  let effectiveStatus = normalized.status;
  let transcriptResult: TranscriptResult | undefined;
  let extraction: BedrockResult | undefined;

  if (effectiveStatus === 'COMPLETED') {
    if (!mediaBucketName || !transcriptOutputKey) {
      throw new Error('mediaBucketName and transcriptOutputKey required for completed transcription');
    }

    try {
      transcriptResult = await readTranscriptResult(s3, mediaBucketName, transcriptOutputKey);
      if (transcriptResult.text.trim().length === 0) {
        console.log(JSON.stringify({
          metric: 'AiProfileWriterTranscriptReadFailed',
          reason: 'empty_transcript',
          v2: !!v2,
        }));
        effectiveStatus = 'FAILED';
      }
    } catch {
      console.log(JSON.stringify({
        metric: 'AiProfileWriterTranscriptReadFailed',
        reason: 's3_error',
        v2: !!v2,
      }));
      effectiveStatus = 'FAILED';
    }

    if (effectiveStatus === 'COMPLETED' && transcriptResult) {
      console.log(JSON.stringify({
        metric: 'AiProfileWriterAsrQuality',
        languages: transcriptResult.languages,
        avgConfidence: transcriptResult.avgConfidence,
        wordCount: transcriptResult.words?.length,
        lowConfWordCount: transcriptResult.words?.filter(
          (word) => word.conf !== null && word.conf < 0.5,
        ).length,
        transcriptChars: transcriptResult.text.length,
        v2: !!v2,
      }));

      extraction = await extractProfileFromTranscript(transcriptResult);
    }
  }

  const asrMetadata = buildAsrMetadata(transcriptResult);
  const asrMetadataParam = asrMetadata ? JSON.stringify(asrMetadata) : null;

  const pool = await getDbPool();
  const client = await pool.connect();

  // L6: canonicalise the extracted trade BEFORE BEGIN — see
  // `resolveExtractedTradeOverride` for why the placement is load-bearing.
  // Only the v1 branch writes `users`; on v2 every profile write happens in
  // the router's turn, so there is nothing here to canonicalise.
  const tradeOverride = !v2 && effectiveStatus === 'COMPLETED'
    ? await resolveExtractedTradeOverride(client, extraction, language)
    : null;

  let committed = false;
  try {
    await client.query('BEGIN');
    await setWorkerRlsContextByUserId(client, userId);

    if (effectiveStatus === 'FAILED') {
      // Write failed extraction record
      const failedExtraction = await client.query<{ id: string }>(
        `INSERT INTO worker_profile_ai_extractions
           (user_id, bedrock_model_id, status, asr_metadata)
         VALUES ($1, $2, 'failed', $3)
         RETURNING id`,
        [userId, BEDROCK_MODEL_ID, asrMetadataParam],
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

      // Sprint 22 R1-A: `autoAdvanceProfileAfterAi` was called here. It was
      // the last writer of the v1 `building_trust_signal` /
      // `building_custom_trust` hand-off, whose numbered-menu questions are
      // gone. This whole v1 branch has had no producer since processor.ts
      // started tagging BOTH StartExecution payloads with the v2 marker; the
      // failed-extraction row and its notice still commit exactly as before.
      await client.query('COMMIT');
      committed = true;
      await sendPendingOutbox(client, outboxMessageSid);
      return;
    }

    // effectiveStatus === 'COMPLETED' — guaranteed by the guard above:
    // reaching this point means the transcript read succeeded and the
    // transcript was non-empty, so both are defined.
    const result = extraction as BedrockResult;
    const transcript = transcriptResult as TranscriptResult;

    // Write extraction record (link voice media row if available) — SQL is
    // unchanged for v1/v2 alike; only `RETURNING id` was added so the v2
    // branch can thread `extractionId` into the outbound event.
    const extractionRow = await client.query<{ id: string }>(
      `INSERT INTO worker_profile_ai_extractions
         (user_id, voice_message_media_id, bedrock_model_id, transcript_text, extracted_fields, confidence_scores, status, asr_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)
       RETURNING id`,
      [
        userId,
        voiceMessageMediaId ?? null,
        BEDROCK_MODEL_ID,
        transcript.text,
        JSON.stringify(result.extracted_fields),
        JSON.stringify(result.confidence_scores),
        asrMetadataParam,
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
        extractionId: extractionRow.rows[0]?.id ?? null,
        fields: result.extracted_fields,
        confidences: result.confidence_scores,
        summaryEn: result.summary_en,
        summaryEs: result.summary_es,
      });
      return;
    }

    // ── v1 legacy path — UNCHANGED ────────────────────────────────
    // Write high-confidence fields to users
    const update = buildUserUpdateSql(userId, result.extracted_fields, result.confidence_scores, tradeOverride);
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

    // Sprint 22 R1-A: `autoAdvanceProfileAfterAi` was called here — see the
    // FAILED branch above. The users UPDATE and the summary notice still
    // commit exactly as before.
    await client.query('COMMIT');
    committed = true;

    // L6: fire-and-forget, post-commit, and only for a trade `trade_aliases`
    // did not know — so the next write for this trade canonicalises. The text
    // sent is what was just stored (the worker's own words, tidied);
    // `requestTradeAliasGeneration` normalises it into the cache key itself,
    // so that spelling becomes one of the learned aliases. It never throws by
    // contract; the try/catch is defence in depth so a cache-growth attempt
    // can never fail a voice extraction that already committed.
    if (tradeOverride?.requestAliasFor) {
      try {
        await requestTradeAliasGeneration(tradeOverride.requestAliasFor);
      } catch {
        // Swallowed intentionally -- see comment above.
      }
    }

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
