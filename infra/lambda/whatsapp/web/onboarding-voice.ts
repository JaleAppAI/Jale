/**
 * VOICE ANSWERS ON THE WEB (Sprint 23 L6) — three actions on the existing
 * `/worker/onboarding/{action}` resource, and NOT ONE NEW API GATEWAY ROUTE.
 * ApiStack is at its resource ceiling (see `whatsapp-stack.ts`), which is why
 * the web door is a single `{action}` dispatcher in the first place; adding a
 * `/worker/onboarding/voice/*` subtree would have cost six resources for
 * behaviour three action names already carry.
 *
 *   POST voice-upload-url  -> a presigned PUT into the media bucket
 *   POST voice-transcribe  -> start the SAME trust pipeline WhatsApp uses
 *   POST voice-result      -> poll the transcript
 *
 * THE SHAPE OF THE FLOW, AND WHY IT ENDS WHERE IT DOES.
 * The transcript is handed BACK TO THE WORKER, not recorded. It lands in the
 * textarea they were already looking at, they read it, fix what Transcribe
 * misheard, and press the same button a typed answer presses — the ordinary
 * `answers` action, tagged `source: 'voice'`. Nothing in this module writes a
 * trust answer or advances the run. That is deliberate: dictation on a phone
 * in a noisy yard is not accurate enough to commit unseen, and it keeps the
 * one path that writes `worker_trust_assessments` (onboarding/steps/trust.ts's
 * `recordTrustAnswer`) unchanged and singular.
 *
 * THE TENANT BOUNDARY IS THE KEY PREFIX. Every object this module mints lives
 * under `voice/<workerId>/`, and every key a caller supplies is checked
 * against that prefix for the CALLER's own worker id. A key belonging to
 * another worker is a 404, never a 403: a 403 would confirm the object exists,
 * which is precisely the fact a prefix guess is trying to establish.
 *
 * WHY THE TRANSCRIPT LIVES UNDER THE SAME PREFIX. WhatsApp's pipeline writes
 * transcripts to `<workerId>/transcripts/`. This door writes them to
 * `voice/<workerId>/transcripts/` instead, so the audio and its transcript
 * share ONE prefix — one IAM grant on the Lambda and one ownership rule in
 * this file, rather than two of each that could drift apart.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { readTranscriptResult } from '../../lib/transcript';
import { fromS3Key } from '../lib/trust-transcription';
import type { PreferredLanguage } from '../lib/onboarding-types';

const s3 = new S3Client({});

/**
 * The WEB allowlist, deliberately NOT `media.ts`'s `ALLOWED_VOICE_TYPES`.
 * That list is Twilio's accept surface (ogg/mpeg/mp4) and must not grow; a
 * browser's `MediaRecorder` emits `audio/webm` on Chrome and Android and
 * `audio/mp4` on Safari, neither of which WhatsApp will ever send. Two
 * channels, two allowlists, no coupling.
 */
export const WEB_VOICE_MIME_TO_EXT: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/**
 * 5 MB. At the ~24 kbps Opus a browser records at, that is over twenty
 * minutes of audio for an answer the UI caps at 2000 characters — generous
 * for a worker on a bad connection, and far below `media.ts`'s 16 MB (which
 * is Twilio's cap, not a judgement about what a web recording should be).
 */
export const MAX_WEB_VOICE_BYTES = 5 * 1024 * 1024;

/** Long enough to survive a slow upload, short enough that a leaked URL is
 * worthless by the time it is found. */
export const VOICE_UPLOAD_URL_TTL_SECONDS = 300;

export const TRUST_STEP_KEYS = ['trust.question.1', 'trust.question.2', 'trust.question.3'] as const;
export type TrustStepKey = (typeof TRUST_STEP_KEYS)[number];

export interface VoiceActionResult {
  statusCode: number;
  body: Record<string, unknown>;
}

/** Every object for this worker, audio and transcript alike. */
export function voicePrefix(workerId: string): string {
  return `voice/${workerId}/`;
}

/**
 * `audio/webm;codecs=opus` is what `MediaRecorder.mimeType` reports, so the
 * parameters are stripped before the allowlist is consulted. The allowlist
 * itself is exact-match on the resulting type — no prefix matching, no
 * `startsWith('audio/')`.
 */
export function normalizeContentType(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(';')[0].trim().toLowerCase();
  return base.length > 0 ? base : null;
}

export function isTrustStepKey(value: unknown): value is TrustStepKey {
  return typeof value === 'string' && (TRUST_STEP_KEYS as readonly string[]).includes(value);
}

/** 0-based, the index `worker_trust_assessments` and the pipeline both use. */
export function questionIndexForStep(stepKey: TrustStepKey): number {
  return Number(stepKey.split('.').pop()) - 1;
}

function requireBucket(): string {
  const bucket = process.env.MEDIA_BUCKET_NAME;
  if (!bucket) throw new Error('MEDIA_BUCKET_NAME not set');
  return bucket;
}

function invalid(): VoiceActionResult {
  return { statusCode: 400, body: { error: 'invalid_request' } };
}

// ── voice-upload-url ─────────────────────────────────────────────────────

export interface VoiceUploadUrlInput {
  workerId: string;
  stepKey: unknown;
  questionIndex: unknown;
  contentType: unknown;
  sizeBytes: unknown;
  now: Date;
}

/**
 * Mints ONE presigned PUT. `sizeBytes` is validated here because rejecting a
 * 40 MB upload before it starts is kinder than after — but it is a CLAIM, not
 * a fact: nothing stops a client declaring 1 MB and PUTting fifty. The real
 * cap is enforced in `startVoiceTranscription` against the object's actual
 * `ContentLength`.
 */
export async function createVoiceUploadUrl(
  input: VoiceUploadUrlInput,
): Promise<VoiceActionResult> {
  if (!isTrustStepKey(input.stepKey)) return invalid();
  if (input.questionIndex !== questionIndexForStep(input.stepKey)) return invalid();

  const contentType = normalizeContentType(input.contentType);
  if (!contentType || !WEB_VOICE_MIME_TO_EXT[contentType]) {
    return {
      statusCode: 400,
      body: { error: 'invalid_content_type', allowed: Object.keys(WEB_VOICE_MIME_TO_EXT) },
    };
  }

  const sizeBytes = input.sizeBytes;
  if (!Number.isInteger(sizeBytes) || (sizeBytes as number) <= 0) return invalid();
  if ((sizeBytes as number) > MAX_WEB_VOICE_BYTES) {
    return { statusCode: 400, body: { error: 'file_too_large', maxBytes: MAX_WEB_VOICE_BYTES } };
  }

  const bucket = requireBucket();
  const key = `${voicePrefix(input.workerId)}${randomUUID()}.${WEB_VOICE_MIME_TO_EXT[contentType]}`;
  const url = await getSignedUrl(
    s3,
    // ContentType is SIGNED, so the browser's PUT must send the same one it
    // asked for — a client cannot presign a webm and upload an executable.
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: VOICE_UPLOAD_URL_TTL_SECONDS },
  );

  return {
    statusCode: 200,
    body: {
      key,
      url,
      expiresAt: new Date(input.now.getTime() + VOICE_UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

// ── voice-transcribe ─────────────────────────────────────────────────────

export interface VoiceTranscribeInput {
  workerId: string;
  phone: string | null;
  runId: string;
  language: PreferredLanguage;
  currentStepKey: string | null;
  key: unknown;
  stepKey: unknown;
  questionIndex: unknown;
}

/**
 * Adopts an uploaded object and starts the trust pipeline on it.
 *
 * 202, not 200: Transcribe takes tens of seconds and nothing about the run has
 * changed yet. The response is the key to poll and nothing else.
 *
 * The run's `lock_version` is NOT bumped — `fromS3Key`, like WhatsApp's
 * `fromTwilioMedia`, never advances the step or takes the run lock. The
 * browser keeps the version it already holds and spends it on the `answers`
 * call that follows.
 */
export async function startVoiceTranscription(
  client: PoolClient,
  input: VoiceTranscribeInput,
): Promise<VoiceActionResult> {
  if (!isTrustStepKey(input.stepKey)) return invalid();
  if (input.questionIndex !== questionIndexForStep(input.stepKey)) return invalid();
  if (input.stepKey !== input.currentStepKey) {
    return { statusCode: 422, body: { error: 'step_mismatch' } };
  }

  const key = input.key;
  if (typeof key !== 'string' || !key.startsWith(voicePrefix(input.workerId))) {
    // Deliberately indistinguishable from "no such object": a caller who
    // guesses another worker's prefix learns nothing from the answer.
    return { statusCode: 404, body: { error: 'not_found' } };
  }
  // A key with a further `/` would be a transcript (or an invented subtree),
  // not audio this door minted.
  const suffix = key.slice(voicePrefix(input.workerId).length);
  if (suffix.length === 0 || suffix.includes('/')) {
    return { statusCode: 404, body: { error: 'not_found' } };
  }
  const mediaId = suffix.replace(/\.[^.]*$/, '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mediaId)) {
    return { statusCode: 404, body: { error: 'not_found' } };
  }

  const bucket = requireBucket();
  let head: { ContentLength?: number; ContentType?: string };
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NotFound' || name === 'NoSuchKey') {
      return { statusCode: 404, body: { error: 'not_found' } };
    }
    throw err;
  }

  // The ACTUAL size, not the one the client declared at presign time. This is
  // the only place the cap is real.
  if ((head.ContentLength ?? 0) > MAX_WEB_VOICE_BYTES) {
    return { statusCode: 400, body: { error: 'file_too_large', maxBytes: MAX_WEB_VOICE_BYTES } };
  }
  if ((head.ContentLength ?? 0) === 0) {
    return { statusCode: 400, body: { error: 'empty_upload' } };
  }

  const contentType = normalizeContentType(head.ContentType) ?? 'audio/webm';

  const outcome = await fromS3Key(client, {
    workerId: input.workerId,
    // `phone` only travels in the v2 envelope, and a web-origin completion
    // never reaches the queue that would use it (voice-trust-receiver's trap).
    phone: input.phone ?? '',
    runId: input.runId,
    stepKey: input.stepKey,
    questionIndex: questionIndexForStep(input.stepKey),
    language: input.language,
    s3Key: key,
    mediaId,
    contentType,
    inboundMessageSid: `web:${mediaId}`,
  });

  if (!outcome.started || !outcome.transcriptOutputKey) {
    return { statusCode: 502, body: { error: 'transcription_unavailable' } };
  }

  console.log(JSON.stringify({
    metric: 'WebOnboardingVoiceTranscribeStarted',
    runId: input.runId,
    stepKey: input.stepKey,
  }));

  return { statusCode: 202, body: { transcriptOutputKey: outcome.transcriptOutputKey } };
}

// ── voice-result ─────────────────────────────────────────────────────────

export interface VoiceResultInput {
  workerId: string;
  transcriptOutputKey: unknown;
}

/**
 * The poll. Three answers, and only three:
 *
 *   202 — the object is not there yet. Transcribe writes it once, at the end,
 *         so "absent" is exactly "still working".
 *   200 — a transcript. `confidence` is the mean word confidence when the
 *         provider reported one; it is omitted rather than faked.
 *   410 — the attempt is over and produced nothing. Either Transcribe failed
 *         (voice-trust-receiver persisted an empty-text marker for exactly
 *         this) or it succeeded and heard silence. Gone, not "try again".
 */
export async function readVoiceResult(
  input: VoiceResultInput,
): Promise<VoiceActionResult> {
  const key = input.transcriptOutputKey;
  const prefix = `${voicePrefix(input.workerId)}transcripts/`;
  if (typeof key !== 'string' || !key.startsWith(prefix) || key.slice(prefix.length).includes('/')) {
    return { statusCode: 404, body: { error: 'not_found' } };
  }

  const bucket = requireBucket();
  let result;
  try {
    result = await readTranscriptResult(s3, bucket, key);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') {
      return { statusCode: 202, body: { status: 'pending' } };
    }
    // A transcript object that exists but is not JSON is a dead attempt, not a
    // server fault the browser should retry forever.
    if (err instanceof SyntaxError) {
      return { statusCode: 410, body: { error: 'transcription_failed' } };
    }
    throw err;
  }

  const transcript = result.text.trim();
  if (transcript.length === 0) {
    return { statusCode: 410, body: { error: 'transcription_failed' } };
  }

  return {
    statusCode: 200,
    body: {
      transcript,
      ...(typeof result.avgConfidence === 'number' ? { confidence: result.avgConfidence } : {}),
    },
  };
}
