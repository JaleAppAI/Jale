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

/**
 * Uploads a buffer to S3 at the given key in the media bucket. Returns the
 * S3 object VersionId (or null if the bucket somehow isn't versioned) so
 * callers can pin presigned GETs / moderation calls to these exact bytes.
 */
export async function uploadMediaToS3(
  bucketName: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string | null> {
  const res = await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
  return res.VersionId ?? null;
}

// ── Job document category (PDF/JPEG/PNG work documents sent in chat) ──────

export const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
// web-policy parity (worker-doc-upload-url.ts:12)
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type DocumentMime = (typeof ALLOWED_DOCUMENT_TYPES)[number];

/**
 * Sniffs a document's real type from its magic bytes rather than trusting a
 * caller-supplied content type. Returns null for anything not in
 * ALLOWED_DOCUMENT_TYPES (e.g. GIF, HTML).
 */
export function sniffDocumentType(buf: Buffer): DocumentMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return 'image/png';
  return null;
}

/**
 * Uploads a job document to the documents bucket. Deliberately sends NO
 * ServerSideEncryption header: the documents bucket is SSE-KMS by default,
 * and an explicit AES256 header (as uploadMediaToS3 uses for the media
 * bucket) would override that bucket default. Do not reuse uploadMediaToS3
 * for documents, and do not add SSE here.
 */
export async function uploadDocumentToS3(
  bucketName: string,
  key: string,
  body: Buffer,
  contentType: DocumentMime,
): Promise<{ versionId: string | null }> {
  const res = await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { versionId: res.VersionId ?? null };
}

export type PhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** Magic-byte sniff for post photos — never trust Twilio's MediaContentType. */
export function sniffPhotoType(buf: Buffer): PhotoMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) return 'image/webp';
  return null;
}

/** Thrown by downloadTwilioMediaBounded when the media exceeds the caller's byte cap. */
export class MediaTooLargeError extends Error {
  constructor(message = 'Media exceeds the maximum allowed size') {
    super(message);
    this.name = 'MediaTooLargeError';
  }
}

/**
 * Downloads a Twilio media URL using Basic Auth, enforcing maxBytes twice:
 * first against the Content-Length response header (before any body is
 * read), then again against the actual buffered size (since Twilio doesn't
 * reject oversized uploads at the source, and a missing/lying Content-Length
 * header must not bypass the cap). Must be called immediately — Twilio media
 * URLs expire within minutes.
 */
export async function downloadTwilioMediaBounded(
  mediaUrl: string,
  accountSid: string,
  authToken: string,
  maxBytes: number,
): Promise<Buffer> {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`Twilio media download failed ${res.status}: ${mediaUrl}`);
  }

  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new MediaTooLargeError(
        `Media Content-Length ${contentLength} exceeds max ${maxBytes} bytes`,
      );
    }
  }

  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new MediaTooLargeError(
      `Media body ${arrayBuffer.byteLength} exceeds max ${maxBytes} bytes`,
    );
  }
  return Buffer.from(arrayBuffer);
}
