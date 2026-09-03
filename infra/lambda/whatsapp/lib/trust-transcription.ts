/**
 * v2 trust-question voice-note transcription kickoff — the ONE place that
 * starts the trust Step Functions pipeline, for BOTH doors.
 *
 * Extracted verbatim from `processor.ts`'s `startTrustTranscription` (Sprint
 * 23 L6) so the WEB door can start the same pipeline without going anywhere
 * near the Twilio download. The two entry points differ ONLY in how the audio
 * reaches S3:
 *
 *   `fromTwilioMedia` — WhatsApp. Downloads the Twilio media URL, enforces
 *      the Twilio-shaped size cap, uploads it to the media bucket. Byte-for-
 *      byte the behaviour processor.ts had.
 *   `fromS3Key`       — WEB. The browser already PUT the audio through a
 *      presigned URL minted by the web door, so there is nothing to download
 *      and nothing to upload; the object is adopted as-is.
 *
 * Everything after the bytes are in S3 — the `worker_profile_media` row, the
 * Transcribe job name, the `v2` envelope, the deterministic execution name —
 * is shared.
 *
 * ORIGINAL COMMENT, preserved because it still governs both paths:
 *
 *   Mirrors handleAwaitingMediaVoice's Twilio-download -> S3 ->
 *   StartExecution pattern, but for the v2 lane's trust.question.* steps: it
 *   never advances the step or takes the run lock — recordTrustAnswer only
 *   runs when the transcript comes back (onboarding/steps/trust.ts), so a
 *   typed answer that arrives first still wins the race. Runs on the SAME
 *   client/transaction as the rest of the turn (closed over by the
 *   v2Deps.voiceIntake wiring), so a StartExecution failure rolls back the S3
 *   upload's worker_profile_media row along with everything else in this turn.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

import { setRlsContext } from '../../lib/db';

import {
  detectMediaCategory,
  buildS3Key,
  downloadTwilioMedia,
  uploadMediaToS3,
  MAX_VOICE_BYTES,
} from './media';
import type { TwilioSecret } from './twilio';
import type { Lang } from './templates';
import type { VoiceOrigin, VoicePipelineExecutionInputV2 } from './voice-events';

const sfn = new SFNClient({});

export interface TrustTranscriptionOutcome {
  started: boolean;
  reason?: string;
  executionArn?: string;
  /** Where the pipeline will write the transcript. Present iff `started`. */
  transcriptOutputKey?: string;
}

/**
 * Step Functions execution ARNs are deterministic:
 * `arn:...:stateMachine:<name>` -> `arn:...:execution:<name>:<executionName>`.
 * Deriving it (rather than trusting `StartExecutionCommand`'s response) gives
 * the caller a staleness anchor synchronously, and returns the SAME ARN for a
 * redelivery that resolves to `ExecutionAlreadyExists`.
 */
export function deriveExecutionArn(stateMachineArn: string, executionName: string): string {
  const parts = stateMachineArn.split(':');
  const [, , , region, account, , stateMachineName] = parts;
  return `arn:aws:states:${region}:${account}:execution:${stateMachineName}:${executionName}`;
}

/**
 * `worker_profile_media` is written under the COGNITO-SUB RLS lane
 * (`worker_profile_media_self`, migration 011). Callers on the internal-id
 * lane are covered by `worker_profile_media_self_internal` (083) as well, but
 * setting the sub lane keeps both doors on the policy 011 wrote for this
 * table.
 */
export async function setWorkerRlsContextByUserId(
  client: PoolClient,
  userId: string,
): Promise<void> {
  const userRow = await client.query<{ cognito_sub: string }>(
    `SELECT cognito_sub FROM users WHERE id = $1 AND user_type = 'worker'`,
    [userId],
  );
  const cognitoSub = userRow.rows[0]?.cognito_sub;
  if (!cognitoSub) throw new Error('worker cognito_sub missing before media write');
  await setRlsContext(client, cognitoSub);
}

interface PipelineEnv {
  bucketName: string;
  stateMachineArn: string;
}

function requirePipelineEnv(): PipelineEnv {
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const stateMachineArn = process.env.TRUST_PIPELINE_STATE_MACHINE_ARN;
  if (!bucketName) throw new Error('MEDIA_BUCKET_NAME not set');
  if (!stateMachineArn) throw new Error('TRUST_PIPELINE_STATE_MACHINE_ARN not set');
  return { bucketName, stateMachineArn };
}

interface StartPipelineInput {
  workerId: string;
  phone: string;
  runId: string;
  stepKey: string;
  questionIndex: number;
  language: Lang;
  inboundMessageSid: string;
  origin: VoiceOrigin;
  mediaId: string;
  s3Key: string;
  contentType: string;
  transcriptionJobName: string;
  transcriptOutputKey: string;
  executionName: string;
  env: PipelineEnv;
}

/**
 * The half both doors share: record the media row, then start the execution
 * under a DETERMINISTIC name so a redelivery (SQS, or a browser retry)
 * resolves to the SAME execution rather than starting a second transcription
 * job.
 */
async function startPipeline(
  client: PoolClient,
  input: StartPipelineInput,
): Promise<TrustTranscriptionOutcome> {
  await setWorkerRlsContextByUserId(client, input.workerId);
  // ON CONFLICT because the WEB door's `mediaId` is DETERMINISTIC — it is the
  // uuid in the key the browser was handed, which is what makes a retried
  // `voice-transcribe` resolve to the same execution and the same transcript
  // key. Without this, that retry (an apiFetch 401 replay, a lost response, a
  // double-tap) would die on the primary key and 500 instead of being the
  // no-op it is. Unreachable on the WhatsApp lane, whose `fromTwilioMedia`
  // mints a fresh uuid per call — but the SQL is shared, so it is stated here.
  await client.query(
    `INSERT INTO worker_profile_media
       (id, user_id, media_type, s3_key, content_type)
     VALUES ($1, $2, 'voice_message', $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [input.mediaId, input.workerId, input.s3Key, input.contentType],
  );

  const sfnInput: VoicePipelineExecutionInputV2 = {
    transcriptionJobName: input.transcriptionJobName,
    mediaS3Uri: `s3://${input.env.bucketName}/${input.s3Key}`,
    mediaBucketName: input.env.bucketName,
    transcriptOutputKey: input.transcriptOutputKey,
    v2: {
      version: 'v2',
      kind: 'trust_answer',
      phone: input.phone,
      runId: input.runId,
      stepKey: input.stepKey,
      language: input.language,
      origMessageSid: input.inboundMessageSid,
      startedAt: new Date().toISOString(),
      questionIndex: input.questionIndex,
      origin: input.origin,
    },
  };

  const executionArn = deriveExecutionArn(input.env.stateMachineArn, input.executionName);

  try {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: input.env.stateMachineArn,
      name: input.executionName,
      input: JSON.stringify(sfnInput),
    }));
  } catch (err: any) {
    if (err?.name !== 'ExecutionAlreadyExists') throw err;
  }

  return { started: true, executionArn, transcriptOutputKey: input.transcriptOutputKey };
}

export interface FromTwilioMediaInput {
  workerId: string;
  phone: string;
  runId: string;
  stepKey: string;
  questionIndex: number;
  language: Lang;
  mediaUrl: string;
  mediaContentType: string;
  inboundMessageSid: string;
  /** Module-cached in processor.ts; injected so this module holds no secret. */
  getTwilioSecret: () => Promise<TwilioSecret>;
}

/** WhatsApp door. Behaviour is unchanged from processor.ts's original. */
export async function fromTwilioMedia(
  client: PoolClient,
  input: FromTwilioMediaInput,
): Promise<TrustTranscriptionOutcome> {
  const category = detectMediaCategory(input.mediaContentType);
  if (category !== 'voice') return { started: false, reason: 'invalid_media_type' };

  const env = requirePipelineEnv();

  let mediaBuffer: Buffer;
  try {
    const twilioSecret = await input.getTwilioSecret();
    mediaBuffer = await downloadTwilioMedia(input.mediaUrl, twilioSecret.accountSid, twilioSecret.authToken);
  } catch (err) {
    // Task 7/B5 fix: an expired/unreachable Twilio media URL must never
    // throw bare here — this runs inside the claim transaction, so an
    // uncaught throw aborts it, poisons the phone's FIFO message group, and
    // burns all five retries. Degrade to the same graceful
    // `{started: false}` path a rejected file already takes; the existing
    // `v2_voice_failed` reprompt (handleTrustVoiceNote, onboarding/steps/
    // trust.ts) handles it from here.
    console.error(JSON.stringify({
      metric: 'OnboardingTrustVoiceDownloadFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    return { started: false, reason: 'download_failed' };
  }
  // Twilio does not reject oversized uploads at the source; enforce the cap
  // post-download rather than stranding the worker on a silent failure.
  if (mediaBuffer.byteLength > MAX_VOICE_BYTES) return { started: false, reason: 'file_too_large' };

  const mediaId = randomUUID();
  const s3Key = buildS3Key(input.workerId, mediaId, 'voice');
  await uploadMediaToS3(env.bucketName, s3Key, mediaBuffer, input.mediaContentType);

  const transcriptionJobName = `jale-vt-${input.workerId.replace(/-/g, '')}-${Date.now()}`;

  return startPipeline(client, {
    workerId: input.workerId,
    phone: input.phone,
    runId: input.runId,
    stepKey: input.stepKey,
    questionIndex: input.questionIndex,
    language: input.language,
    inboundMessageSid: input.inboundMessageSid,
    origin: 'whatsapp',
    mediaId,
    s3Key,
    contentType: input.mediaContentType,
    transcriptionJobName,
    transcriptOutputKey: `${input.workerId}/transcripts/${transcriptionJobName}.json`,
    // Deterministic execution name (same shape as sendErrorFallback's
    // `<sid>#err` idempotency key): an SQS redelivery of the same inbound
    // voice note resolves to the SAME execution.
    executionName: `vt-${input.inboundMessageSid}`,
    env,
  });
}

export interface FromS3KeyInput {
  workerId: string;
  phone: string;
  runId: string;
  stepKey: string;
  questionIndex: number;
  language: Lang;
  /** `voice/<workerId>/<mediaId>.<ext>` — already validated by the caller. */
  s3Key: string;
  mediaId: string;
  contentType: string;
  inboundMessageSid: string;
}

/**
 * WEB door. No download, no upload: the browser PUT the audio straight to the
 * media bucket through a presigned URL the door minted, and the door has
 * already proved the key is under this worker's prefix and that the object
 * exists and is within the size cap.
 *
 * EVERY name derived here is deterministic in `mediaId`, which the key
 * carries. That matters more on this door than on WhatsApp's: the browser
 * POLLS `transcriptOutputKey`, so a retried `voice-transcribe` must hand back
 * the same key it did the first time or the poll would watch an object the
 * pipeline is never going to write.
 *
 * The transcript is written under the SAME `voice/<workerId>/` prefix as the
 * audio (WhatsApp uses `<workerId>/transcripts/`) so the web door needs one
 * S3 prefix grant and one ownership rule, not two.
 */
export async function fromS3Key(
  client: PoolClient,
  input: FromS3KeyInput,
): Promise<TrustTranscriptionOutcome> {
  const env = requirePipelineEnv();
  const flatId = input.mediaId.replace(/-/g, '');
  const transcriptionJobName = `jale-vtw-${flatId}`;

  return startPipeline(client, {
    workerId: input.workerId,
    phone: input.phone,
    runId: input.runId,
    stepKey: input.stepKey,
    questionIndex: input.questionIndex,
    language: input.language,
    inboundMessageSid: input.inboundMessageSid,
    origin: 'web',
    mediaId: input.mediaId,
    s3Key: input.s3Key,
    contentType: input.contentType,
    transcriptionJobName,
    transcriptOutputKey: `voice/${input.workerId}/transcripts/${transcriptionJobName}.json`,
    executionName: `vtw-${flatId}`,
    env,
  });
}
