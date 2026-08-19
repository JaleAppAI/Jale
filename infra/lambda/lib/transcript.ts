import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// ── Shared, provider-neutral transcript shape ────────────────────────────
//
// Both voice-pipeline consumers (ai-profile-writer.ts, voice-trust-receiver.ts)
// read a Transcribe batch-output JSON object from S3 today via their own
// duplicated `readTranscript` helpers. This module centralizes that parsing
// and adds a passthrough hook (`jaleTranscriptVersion: 1`) so a future
// provider adapter (Deepgram, OpenAI, ...) can write its own JSON shape
// directly to the same S3 key without either consumer needing to know which
// provider produced it.

export interface TranscriptWord {
  w: string;
  conf: number | null;
}

export interface TranscriptResult {
  /** Present iff written by a future provider adapter (passthrough hook). */
  jaleTranscriptVersion?: 1;
  text: string;
  /** Pronunciation items only — punctuation excluded. */
  words?: TranscriptWord[];
  /** e.g. ['es-US', 'en-US'] */
  languages?: string[];
  /** Mean of numeric word confidences; undefined if none. */
  avgConfidence?: number;
  /** 'transcribe' | 'deepgram' | 'openai' */
  provider?: string;
}

interface TranscribeAlternative {
  content?: string;
  confidence?: string;
}

interface TranscribeItem {
  type?: string;
  alternatives?: TranscribeAlternative[];
}

interface TranscribeLanguageCode {
  language_code?: string;
}

interface TranscribeBatchOutput {
  results?: {
    transcripts?: { transcript?: string }[];
    items?: TranscribeItem[];
    language_codes?: TranscribeLanguageCode[];
    language_code?: string;
  };
}

function isJaleTranscriptV1(parsed: unknown): parsed is Record<string, unknown> {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { jaleTranscriptVersion?: unknown }).jaleTranscriptVersion === 1
  );
}

/**
 * Minimally validates and passes through a future-provider payload: `text`
 * must be a string (coerced to '' otherwise); every other field is optional
 * and left as-is (undefined if missing), never fabricated.
 */
function parseJaleTranscriptV1(parsed: Record<string, unknown>): TranscriptResult {
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const result: TranscriptResult = { jaleTranscriptVersion: 1, text };

  if (Array.isArray(parsed.words)) {
    result.words = parsed.words as TranscriptWord[];
  }
  if (Array.isArray(parsed.languages)) {
    result.languages = parsed.languages as string[];
  }
  if (typeof parsed.avgConfidence === 'number') {
    result.avgConfidence = parsed.avgConfidence;
  }
  if (typeof parsed.provider === 'string') {
    result.provider = parsed.provider;
  }

  return result;
}

/**
 * Parses an Amazon Transcribe batch-output JSON object (the shape produced
 * by every Transcribe job this pipeline runs today, `IdentifyMultipleLanguages`
 * jobs included). Missing/partial fields degrade gracefully — a job with no
 * `results` at all still yields `{ text: '', provider: 'transcribe' }` rather
 * than throwing.
 */
function parseTranscribeBatchOutput(parsed: TranscribeBatchOutput): TranscriptResult {
  const text = parsed.results?.transcripts?.[0]?.transcript ?? '';

  const result: TranscriptResult = { text, provider: 'transcribe' };

  const rawItems = parsed.results?.items;
  if (Array.isArray(rawItems)) {
    const words: TranscriptWord[] = [];
    for (const item of rawItems) {
      if (item?.type !== 'pronunciation') continue;
      const alt = item.alternatives?.[0];
      const w = alt?.content ?? '';
      const parsedConf = parseFloat(alt?.confidence ?? '');
      const conf = Number.isNaN(parsedConf) ? null : parsedConf;
      words.push({ w, conf });
    }
    result.words = words;

    const numericConfs = words
      .map((word) => word.conf)
      .filter((conf): conf is number => conf !== null);
    if (numericConfs.length > 0) {
      result.avgConfidence =
        numericConfs.reduce((sum, conf) => sum + conf, 0) / numericConfs.length;
    }
  }

  const languageCodes = parsed.results?.language_codes;
  if (Array.isArray(languageCodes) && languageCodes.length > 0) {
    const languages = languageCodes
      .map((lc) => lc?.language_code)
      .filter((code): code is string => typeof code === 'string');
    if (languages.length > 0) {
      result.languages = languages;
    }
  } else if (typeof parsed.results?.language_code === 'string') {
    result.languages = [parsed.results.language_code];
  }

  return result;
}

/**
 * Parses raw transcript JSON text into a provider-neutral `TranscriptResult`.
 * `JSON.parse` throws propagate to the caller unmodified — callers own
 * S3/parse error handling (see both consumers' try/catch around the read).
 */
export function parseTranscriptJson(raw: string): TranscriptResult {
  const parsed: unknown = JSON.parse(raw);

  if (isJaleTranscriptV1(parsed)) {
    return parseJaleTranscriptV1(parsed);
  }

  return parseTranscribeBatchOutput(parsed as TranscribeBatchOutput);
}

/** GetObjectCommand + transformToString + parseTranscriptJson. */
export async function readTranscriptResult(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<TranscriptResult> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await (res.Body as { transformToString: () => Promise<string> }).transformToString();
  return parseTranscriptJson(raw);
}
