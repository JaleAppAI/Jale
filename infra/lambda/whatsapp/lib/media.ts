import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ALLOWED_VOICE_TYPES = ['audio/ogg', 'audio/mpeg', 'audio/mp4'] as const;

export type MediaCategory = 'photo' | 'voice';
export type MediaS3Type = 'photo' | 'work_sample' | 'voice';

// Twilio WhatsApp media cap; enforced post-download since Twilio doesn't reject oversized uploads at the source.
export const MAX_VOICE_BYTES = 16 * 1024 * 1024;

/** Returns 'photo', 'voice', or null if the content type is not allowed. */
export function detectMediaCategory(contentType: string): MediaCategory | null {
  if ((ALLOWED_PHOTO_TYPES as readonly string[]).includes(contentType)) return 'photo';
  if ((ALLOWED_VOICE_TYPES as readonly string[]).includes(contentType)) return 'voice';
  return null;
}

/**
 * Maps a media type to its S3 prefix folder.
 * 'photo' maps to profile-photos (initial upload before worker classifies it).
 * After classification, the DB row updates media_type to profile_photo or work_sample.
 */
export function buildS3Key(userId: string, mediaId: string, type: MediaS3Type): string {
  const prefix =
    type === 'photo' ? 'profile-photos'
    : type === 'work_sample' ? 'work-samples'
    : 'voice-messages';
  return `${userId}/${prefix}/${mediaId}`;
}

/**
 * Downloads a Twilio media URL using Basic Auth from the Twilio secret.
 * Must be called immediately — Twilio media URLs expire within minutes.
 */
export async function downloadTwilioMedia(
  mediaUrl: string,
  accountSid: string,
  authToken: string,
): Promise<Buffer> {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`Twilio media download failed ${res.status}: ${mediaUrl}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

const s3 = new S3Client({});

/** Uploads a buffer to S3 at the given key in the media bucket. */
export async function uploadMediaToS3(
  bucketName: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
}
