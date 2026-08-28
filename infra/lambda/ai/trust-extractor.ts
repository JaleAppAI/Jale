// infra/lambda/ai/trust-extractor.ts
//
// R1-X: the trust-answer SKILL EXTRACTOR. Consumes the same
// `{ assessmentId, userId, professionKey }` payload the TrustScorer gets
// (fanned out by `whatsapp/domain-outbox-drain.ts`) and writes ONE row per
// `(assessment_id, extractor_version)` into `worker_trust_extractions`
// (migration 086) describing, in the worker's own terms, what their answers
// actually contained: skills, tools, experience signals, safety mentions,
// and anything else notable, each in English and Spanish, each pointing back
// at the 0-based indexes of the answers it came from.
//
// This lane is deliberately SEPARATE from scoring and FAIL-OPEN with respect
// to it:
//   - It never writes `worker_trust_assessments` and never writes `users`.
//     A failed extraction can therefore never block, delay, or corrupt a
//     trust score — the two lanes share only the source answers.
//   - The drain's fan-out to this queue is best-effort (see
//     `dispatchExtraction` there); a queue outage costs an extraction, never
//     an onboarding.
//
// Log safety: no answer text and no raw model output is ever logged. The
// scorer logs a truncated raw response on a parse failure because its model
// output is a scores/rationale JSON; this extractor's model output is a
// restatement of the worker's own words, so the failure KIND ('parse' |
// 'validation' | 'bedrock') is the only thing that reaches CloudWatch or the
// `error` column.
import type { SQSHandler, SQSEvent } from 'aws-lambda';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getDbPool } from '../lib/db';
import {
  EXTRACTION_ARRAY_KEYS,
  EXTRACTOR_SYSTEM_PROMPT,
  MAX_ITEMS_PER_ARRAY,
  MAX_LABEL_CHARS,
  MAX_SUMMARY_CHARS,
  NOT_ENOUGH_DETAIL_EN,
  NOT_ENOUGH_DETAIL_ES,
  buildExtractionUserMessage,
  type ExtractionArrayKey,
} from './trust-extractor-prompt';

const bedrock = new BedrockRuntimeClient({});
const sqsClient = new SQSClient({});
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-lite-v1:0';
const STALE_MINUTES = 15;

/**
 * Bumping this re-extracts every assessment on the next `reextract:trust`
 * run instead of overwriting history: the table's UNIQUE key is
 * `(assessment_id, extractor_version)`, so a new version writes a NEW row
 * beside the old one. Bump it whenever the prompt or the validated output
 * shape changes in a way a consumer could notice.
 */
export const EXTRACTOR_VERSION = 'v1';

export interface ExtractionItem {
  label_en: string;
  label_es: string;
  source: number[];
}

export type ExtractedArrays = Record<ExtractionArrayKey, ExtractionItem[]>;

export interface ExtractionResult extends ExtractedArrays {
  summary_en: string;
  summary_es: string;
}

export interface ExtractAssessmentEvent {
  assessmentId: string;
  userId: string;
  professionKey: string;
}

interface AnswerRow {
  q_en?: string;
  answer_text?: string;
}

export type ExtractorFailureKind = 'parse' | 'validation' | 'bedrock';

function extractionQueueUrl(): string {
  const url = process.env.TRUST_EXTRACTION_QUEUE_URL;
  if (!url) throw new Error('TRUST_EXTRACTION_QUEUE_URL not set');
  return url;
}

/** Tags an error with the failure kind so the caller emits the right metric
 *  and stores the right (content-free) value in `error`. */
function tagFailureKind(err: unknown, kind: ExtractorFailureKind): unknown {
  (err as { trustExtractorFailureKind?: ExtractorFailureKind }).trustExtractorFailureKind = kind;
  return err;
}

export function failureKindOf(err: unknown): ExtractorFailureKind {
  const kind = (err as { trustExtractorFailureKind?: ExtractorFailureKind })
    ?.trustExtractorFailureKind;
  return kind === 'validation' || kind === 'bedrock' ? kind : 'parse';
}

function emptyArrays(): ExtractedArrays {
  return EXTRACTION_ARRAY_KEYS.reduce((acc, key) => {
    acc[key] = [];
    return acc;
  }, {} as ExtractedArrays);
}

export function notEnoughDetailResult(): ExtractionResult {
  return {
    ...emptyArrays(),
    summary_en: NOT_ENOUGH_DETAIL_EN,
    summary_es: NOT_ENOUGH_DETAIL_ES,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates ONE item. Returns null (rather than throwing) for anything the
 * model got wrong: a hallucinated source index, a missing translation, an
 * over-long label. Dropping the offending item and keeping the rest is the
 * documented contract — a single bad item must not cost the worker the whole
 * extraction.
 */
function validateItem(raw: unknown, answered: ReadonlySet<number>): ExtractionItem | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as { label_en?: unknown; label_es?: unknown; source?: unknown };

  if (!isNonEmptyString(item.label_en) || !isNonEmptyString(item.label_es)) return null;
  const labelEn = item.label_en.trim();
  const labelEs = item.label_es.trim();
  if (labelEn.length > MAX_LABEL_CHARS || labelEs.length > MAX_LABEL_CHARS) return null;

  if (!Array.isArray(item.source) || item.source.length === 0) return null;
  const source: number[] = [];
  for (const entry of item.source) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) return null;
    if (!answered.has(entry)) return null;
    if (!source.includes(entry)) source.push(entry);
  }

  return { label_en: labelEn, label_es: labelEs, source };
}

function validateSummary(raw: unknown, fallback: string): string {
  if (!isNonEmptyString(raw)) return fallback;
  const trimmed = raw.trim();
  return trimmed.length > MAX_SUMMARY_CHARS ? fallback : trimmed;
}

/**
 * Strict validation of a parsed model response against the
 * `worker_trust_extractions.extracted` contract. Never partially fails: a
 * missing array becomes `[]`, an invalid item is dropped, an over-long array
 * is truncated. Only a non-object throws — that is a model failure, not a
 * content problem.
 */
export function validateExtraction(
  raw: unknown,
  answeredIndexes: readonly number[],
): ExtractionResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw tagFailureKind(
      new Error('trust_extractor_validation_failure: response is not a JSON object'),
      'validation',
    );
  }
  const answered = new Set(answeredIndexes);
  const source = raw as Record<string, unknown>;
  const result = { ...emptyArrays() } as ExtractionResult;

  for (const key of EXTRACTION_ARRAY_KEYS) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    const items: ExtractionItem[] = [];
    for (const entry of value) {
      if (items.length >= MAX_ITEMS_PER_ARRAY) break;
      const item = validateItem(entry, answered);
      if (item) items.push(item);
    }
    result[key] = items;
  }

  result.summary_en = validateSummary(source.summary_en, NOT_ENOUGH_DETAIL_EN);
  result.summary_es = validateSummary(source.summary_es, NOT_ENOUGH_DETAIL_ES);
  return result;
}

/**
 * Strips code fences and tolerates trailing prose (the two ways Nova Lite
 * actually deviates from "return only JSON"), then validates. Mirrors the
 * scorer's parse/repair idiom; the repair here is structural (find the JSON
 * object) rather than key-quoting, because this response's keys are already
 * quoted in every observed deviation while trailing chatter is common.
 */
export function parseExtraction(
  rawText: string,
  answeredIndexes: readonly number[],
): ExtractionResult {
  const trimmed = rawText.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const candidate = firstJsonValue(trimmed);
    if (candidate === null) {
      throw tagFailureKind(
        new Error('trust_extractor_parse_failure: response is not JSON'),
        'parse',
      );
    }
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw tagFailureKind(
        new Error('trust_extractor_parse_failure: response is not JSON'),
        'parse',
      );
    }
    void err;
  }

  return validateExtraction(parsed, answeredIndexes);
}

/**
 * Returns the first balanced `{...}` run in `text`, or null. String-aware, so
 * a brace inside a label (or inside a worker's quoted words) cannot end the
 * object early.
 */
function firstJsonValue(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

const CLAIM_SQL = `
  INSERT INTO worker_trust_extractions (assessment_id, user_id, status, extractor_version)
  VALUES ($1, $2, 'extracting', $3)
  ON CONFLICT (assessment_id, extractor_version) DO UPDATE
    SET status = 'extracting', updated_at = now()
    WHERE worker_trust_extractions.status IN ('pending','failed')
  RETURNING id`;

const COMPLETE_SQL = `
  UPDATE worker_trust_extractions
     SET status = 'completed',
         extracted = $1::jsonb,
         summary_en = $2,
         summary_es = $3,
         model_id = $4,
         error = NULL,
         updated_at = now()
   WHERE id = $5 AND status = 'extracting'`;

const FAIL_SQL = `
  UPDATE worker_trust_extractions
     SET status = 'failed', error = $1, updated_at = now()
   WHERE id = $2 AND status = 'extracting'`;

export async function extractAssessment(event: ExtractAssessmentEvent): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();
  let extractionId: string | undefined;

  try {
    // Idempotent claim. 0 rows means the row is already `extracting` or
    // `completed` for this version — a duplicate SQS delivery, or the
    // recovery cron racing a slow first attempt. Either way: do nothing.
    const claim = await client.query<{ id: string }>(CLAIM_SQL, [
      event.assessmentId,
      event.userId,
      EXTRACTOR_VERSION,
    ]);
    if (claim.rowCount === 0) {
      console.log(JSON.stringify({
        metric: 'TrustExtractorSkippedClaimed',
        assessmentId: event.assessmentId,
        extractor_version: EXTRACTOR_VERSION,
      }));
      return;
    }
    extractionId = claim.rows[0].id;

    const assessment = await client.query<{ answers: unknown; profession_key: string }>(
      'SELECT answers, profession_key FROM worker_trust_assessments WHERE id = $1',
      [event.assessmentId],
    );
    const answers: AnswerRow[] = Array.isArray(assessment.rows[0]?.answers)
      ? (assessment.rows[0].answers as AnswerRow[])
      : [];
    const professionKey = assessment.rows[0]?.profession_key ?? event.professionKey;

    // The indexes the model is allowed to cite. Computed over the FULL answers
    // array (not a filtered copy) so an index always means the same answer in
    // the prompt, in `source`, and in whatever renders this later.
    const answeredIndexes = answers
      .map((answer, index) => (isNonEmptyString(answer?.answer_text) ? index : -1))
      .filter((index) => index >= 0);

    if (answeredIndexes.length < 1) {
      await writeCompleted(client, extractionId, notEnoughDetailResult(), null);
      console.log(JSON.stringify({
        metric: 'TrustExtractorSkippedEmpty',
        assessmentId: event.assessmentId,
        extractor_version: EXTRACTOR_VERSION,
      }));
      return;
    }

    let rawText: string;
    try {
      const response = await bedrock.send(
        new ConverseCommand({
          modelId: BEDROCK_MODEL_ID,
          system: [{ text: EXTRACTOR_SYSTEM_PROMPT }],
          messages: [{
            role: 'user',
            content: [{ text: buildExtractionUserMessage(answers, professionKey) }],
          }],
        }),
      );
      rawText = response.output?.message?.content?.[0]?.text ?? '';
    } catch (err) {
      throw tagFailureKind(err, 'bedrock');
    }

    const extracted = parseExtraction(rawText, answeredIndexes);
    await writeCompleted(client, extractionId, extracted, BEDROCK_MODEL_ID);

    console.log(JSON.stringify({
      metric: 'TrustExtractorCompleted',
      assessmentId: event.assessmentId,
      skills: extracted.skills.length,
      extractor_version: EXTRACTOR_VERSION,
    }));
  } catch (err) {
    const kind = failureKindOf(err);
    if (extractionId) {
      // Best-effort: a DB failure here must not replace the original error,
      // which is what SQS retries (and eventually dead-letters) on.
      await client.query(FAIL_SQL, [kind, extractionId]).catch(() => undefined);
    }
    console.log(JSON.stringify({
      metric: 'TrustExtractorFailed',
      assessmentId: event.assessmentId,
      kind,
      extractor_version: EXTRACTOR_VERSION,
    }));
    throw err;
  } finally {
    client.release();
  }
}

/** Single-statement completion — guarded on `status = 'extracting'` so a row
 *  the recovery cron already reclaimed is never overwritten by a late writer.
 *  One statement, so no explicit transaction is needed (unlike the scorer,
 *  which writes two tables). */
async function writeCompleted(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  extractionId: string,
  result: ExtractionResult,
  modelId: string | null,
): Promise<void> {
  const extracted = EXTRACTION_ARRAY_KEYS.reduce((acc, key) => {
    acc[key] = result[key];
    return acc;
  }, {} as ExtractedArrays);

  await client.query(COMPLETE_SQL, [
    JSON.stringify(extracted),
    result.summary_en,
    result.summary_es,
    modelId,
    extractionId,
  ]);
}

/**
 * Re-queues extractions stuck in `extracting` for more than STALE_MINUTES
 * (a Lambda killed mid-flight leaves the claim held forever otherwise).
 *
 * Two deliberate differences from the scorer's equivalent:
 *   - staleness is measured on `updated_at`, not `created_at`: this row is
 *     REUSED by the claim's ON CONFLICT, so its `created_at` can predate the
 *     current attempt by days and would re-queue live work.
 *   - the rows are reset to `pending` BEFORE re-queueing, because the claim
 *     UPDATE only accepts `status IN ('pending','failed')`.
 * `profession_key` lives on the assessment, so the sweep joins it.
 */
export async function handleRecoveryCron(): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    const stale = await client.query<{
      id: string;
      assessment_id: string;
      user_id: string;
      profession_key: string;
    }>(
      `SELECT e.id, e.assessment_id, e.user_id, a.profession_key
         FROM worker_trust_extractions e
         JOIN worker_trust_assessments a ON a.id = e.assessment_id
        WHERE e.status = 'extracting'
          AND e.updated_at < now() - interval '${STALE_MINUTES} minutes'`,
    );
    if (stale.rows.length === 0) return;

    await client.query(
      `UPDATE worker_trust_extractions
          SET status = 'pending', updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'extracting'`,
      [stale.rows.map((row) => row.id)],
    );

    for (const row of stale.rows) {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: extractionQueueUrl(),
          MessageBody: JSON.stringify({
            assessmentId: row.assessment_id,
            userId: row.user_id,
            professionKey: row.profession_key,
          }),
        }),
      );
    }

    console.log(JSON.stringify({
      metric: 'TrustExtractorRecovered',
      count: stale.rows.length,
      extractor_version: EXTRACTOR_VERSION,
    }));
  } finally {
    client.release();
  }
}

export const handler: SQSHandler = async (event: SQSEvent | { source?: string }) => {
  if ('source' in event && event.source === 'cron.recovery') {
    await handleRecoveryCron();
    return;
  }

  for (const record of (event as SQSEvent).Records) {
    await extractAssessment(JSON.parse(record.body) as ExtractAssessmentEvent);
  }
};
