// ---------------------------------------------------------------------------
// Voice answers — the orchestration between "here is a recording" and "here is
// the text to put in the box" (S23 L6).
//
// Framework-free and DOM-free on purpose, exactly like `onboarding-flow.ts`
// next door: the browser bits (MediaRecorder, getUserMedia) live in the
// component, the network bits live in `api/worker.ts`, and the SEQUENCE lives
// here where it can be tested without either.
//
// WHY A POLL AND NOT A PUSH. The transcription runs as a Step Functions
// execution that finishes tens of seconds later, out of band. On WhatsApp its
// completion re-enters the message queue; on the web there is no queue and no
// socket, so the browser asks. Backoff rather than a fixed interval because
// almost every job finishes in the first fifteen seconds and the tail is long:
// polling every second for a minute would be forty wasted requests.
//
// WHY A CEILING. A worker staring at a spinner has to be told SOMETHING. At
// the cap this gives up and says so, with their textarea untouched and typing
// still available — which was always the primary path.
// ---------------------------------------------------------------------------

import {
  MAX_VOICE_BYTES,
  postOnboardingVoiceResult,
  postOnboardingVoiceTranscribe,
  postOnboardingVoiceUploadUrl,
  putVoiceRecording,
  VOICE_CONTENT_TYPES,
} from './api/worker';

/** Milliseconds between polls, then 5s forever after. Sums with the 5s tail to
 * the 60s ceiling below. */
export const VOICE_POLL_BACKOFF_MS = [1500, 2000, 3000, 4000, 5000] as const;
export const VOICE_POLL_CEILING_MS = 60_000;

export type VoiceAnswerOutcome =
  | { kind: 'transcribed'; transcript: string; confidence?: number }
  /** The recording is not something we can send (container, or size). */
  | { kind: 'rejected'; reason: 'invalid_content_type' | 'file_too_large' }
  /** Transcribe finished and produced nothing usable — silence, or a failure. */
  | { kind: 'unusable' }
  /** Still running when the ceiling was reached. */
  | { kind: 'timeout' }
  /** The run moved under us; the caller re-reads rather than retrying. */
  | { kind: 'conflict' }
  | { kind: 'failed' };

export interface VoiceAnswerRequest {
  token: string;
  blob: Blob;
  /** The BASE type (no codec parameters) — it is what gets signed. */
  contentType: string;
  stepKey: string;
  questionIndex: number;
  lockVersion: number;
  signal?: AbortSignal;
}

export interface VoiceAnswerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: VoiceAnswerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

/**
 * `MediaRecorder.mimeType` is `audio/webm;codecs=opus` on Chrome. The door's
 * allowlist is exact-match on the base type, so the parameters come off before
 * anything is signed — and the SAME base type has to be sent as the PUT's
 * Content-Type or S3 rejects the signature.
 */
export function baseContentType(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const base = raw.split(';')[0].trim().toLowerCase();
  return (VOICE_CONTENT_TYPES as readonly string[]).includes(base) ? base : null;
}

/**
 * The first container `MediaRecorder` will actually record in, or null when it
 * will not record anything we can send. Called before the mic is even shown.
 */
export function pickRecordingMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.isTypeSupported === 'function'
    && MediaRecorder.isTypeSupported(type),
): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const candidate of candidates) {
    try {
      if (isSupported(candidate)) return candidate;
    } catch {
      // A browser whose isTypeSupported throws is a browser we do not record on.
    }
  }
  return null;
}

/** presign -> PUT -> start -> poll. One call, one outcome, never a throw. */
export async function transcribeVoiceAnswer(
  request: VoiceAnswerRequest,
  clock: VoiceAnswerClock = realClock,
): Promise<VoiceAnswerOutcome> {
  const contentType = baseContentType(request.contentType);
  if (!contentType) return { kind: 'rejected', reason: 'invalid_content_type' };
  // Checked here as well as by the door: a worker who talked for ten minutes
  // should be told so instead of waiting out an upload that ends in a 400.
  if (request.blob.size === 0) return { kind: 'unusable' };
  if (request.blob.size > MAX_VOICE_BYTES) return { kind: 'rejected', reason: 'file_too_large' };

  const presigned = await postOnboardingVoiceUploadUrl(
    request.token,
    {
      stepKey: request.stepKey,
      questionIndex: request.questionIndex,
      contentType,
      sizeBytes: request.blob.size,
    },
    request.signal,
  );
  if (presigned.kind === 'rejected') return { kind: 'rejected', reason: presigned.reason };
  if (presigned.kind !== 'ready') return { kind: 'failed' };

  const uploaded = await putVoiceRecording(presigned.target.url, request.blob, contentType, request.signal);
  if (uploaded.kind !== 'uploaded') return { kind: 'failed' };

  const started = await postOnboardingVoiceTranscribe(
    request.token,
    {
      key: presigned.target.key,
      stepKey: request.stepKey,
      questionIndex: request.questionIndex,
      lockVersion: request.lockVersion,
    },
    request.signal,
  );
  if (started.kind === 'lock_conflict' || started.kind === 'step_mismatch') return { kind: 'conflict' };
  if (started.kind !== 'started') return { kind: 'failed' };

  const deadline = clock.now() + VOICE_POLL_CEILING_MS;
  for (let attempt = 0; ; attempt += 1) {
    const wait = VOICE_POLL_BACKOFF_MS[Math.min(attempt, VOICE_POLL_BACKOFF_MS.length - 1)];
    if (clock.now() + wait > deadline) return { kind: 'timeout' };
    await clock.sleep(wait);
    if (request.signal?.aborted) return { kind: 'failed' };

    const result = await postOnboardingVoiceResult(
      request.token,
      { transcriptOutputKey: started.transcriptOutputKey },
      request.signal,
    );
    if (result.kind === 'transcribed') {
      return {
        kind: 'transcribed',
        transcript: result.transcript,
        ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
      };
    }
    if (result.kind === 'unusable') return { kind: 'unusable' };
    // A single transport blip mid-poll is not a reason to throw away a
    // transcription that is probably about to finish; keep polling until the
    // ceiling decides.
    if (clock.now() >= deadline) return { kind: 'timeout' };
  }
}
