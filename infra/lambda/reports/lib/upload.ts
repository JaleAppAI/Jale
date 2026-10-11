import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { MAX_IMAGE_BYTES, type ImageType } from './validate';
import type { UploadRejectReason } from './metrics';

/**
 * Report images: the presigned POST that lets the browser upload one image,
 * and the check that pins it.
 *
 * The browser only ever writes `incoming/<uuid>`, a key the database chose,
 * under a POST policy that fixes the key, the size range, the declared type
 * and the encryption key. Before an image is attached the intake checks the
 * stored object (size, encryption, stored type), reads its first 16 bytes and
 * compares them with the declared type, then copies it, under the ETag it
 * checked, to `images/<report>/<upload uuid>.<ext>`. That final key is never
 * presigned, so nobody can replace an image after its check. Keys are never
 * logged: they are random, but they are still record identifiers.
 */

export const UPLOAD_EXPIRES_SECONDS = 10 * 60;
export const MAX_DELETE_KEYS = 1000;

const EXTENSIONS: Readonly<Record<ImageType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const PENDING_KEY = /^incoming\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface UploadGrant {
  url: string;
  fields: Record<string, string>;
  expires_at: string;
}

/** A presigned POST for exactly `key`, valid for 10 minutes. */
export async function presignUpload(
  s3: S3Client,
  o: { bucket: string; key: string; contentType: ImageType; kmsKeyId: string },
): Promise<UploadGrant> {
  // Taken before signing, so the time the client is told is never later
  // than the policy's own expiration.
  const expiresAt = new Date(Date.now() + UPLOAD_EXPIRES_SECONDS * 1000).toISOString();
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: o.bucket,
    Key: o.key,
    // Every field below also becomes an exact-match condition of the policy.
    Fields: {
      'Content-Type': o.contentType,
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': o.kmsKeyId,
    },
    Conditions: [['content-length-range', 1, MAX_IMAGE_BYTES]],
    Expires: UPLOAD_EXPIRES_SECONDS,
  });
  return { url, fields, expires_at: expiresAt };
}

const startsWith = (bytes: Uint8Array, at: number, expected: readonly number[]): boolean =>
  bytes.length >= at + expected.length && expected.every((b, i) => bytes[at + i] === b);

/** Whether the first bytes are the declared type's signature. */
export function magicMatches(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return startsWith(bytes, 0, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      // "RIFF", a 4-byte size, then "WEBP".
      return startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50]);
    default:
      return false;
  }
}

/** The one final key for an upload. Throws on a pending key or type the database never issues. */
export function finalImageKey(reportId: string, pendingKey: string, contentType: string): string {
  const match = PENDING_KEY.exec(pendingKey);
  const ext = (EXTENSIONS as Record<string, string | undefined>)[contentType];
  if (!match || !ext) throw new Error('report_upload_unexpected_pending_upload');
  return `images/${reportId}/${match[1]}.${ext}`;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

/**
 * Without a listing right S3 answers 403 rather than 404 for a key that does
 * not exist, so both read as "not there".
 */
function isMissing(err: unknown): boolean {
  const status = httpStatus(err);
  const name = (err as { name?: string } | null)?.name;
  return status === 404 || status === 403 || name === 'NotFound' || name === 'NoSuchKey';
}

function isPreconditionFailed(err: unknown): boolean {
  return httpStatus(err) === 412 || (err as { name?: string } | null)?.name === 'PreconditionFailed';
}

/** Deletes one object; a failure is logged (without the key) and reported, never thrown. */
export async function deleteObjectQuietly(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      tag: 'report_upload',
      event: 'object_delete_failed',
      error: (err as { name?: string } | null)?.name ?? 'Error',
    }));
    return false;
  }
}

export type PinResult =
  | { ok: true; finalKey: string; byteSize: number }
  | { ok: false; reason: UploadRejectReason };

/**
 * Checks the pending upload and copies it to its final key. A check failure
 * deletes the upload. Storage failures other than "not there" and "changed
 * under us" throw. The caller records the attach afterwards, outside any
 * database transaction that was open during these calls.
 */
export async function pinUpload(
  s3: S3Client,
  o: { bucket: string; reportId: string; pendingKey: string; contentType: ImageType; kmsKeyId: string },
): Promise<PinResult> {
  const finalKey = finalImageKey(o.reportId, o.pendingKey, o.contentType);
  const reject = async (reason: UploadRejectReason): Promise<PinResult> => {
    if (reason !== 'missing') await deleteObjectQuietly(s3, o.bucket, o.pendingKey);
    return { ok: false, reason };
  };

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: o.bucket, Key: o.pendingKey }));
  } catch (err) {
    if (isMissing(err)) return reject('missing');
    throw err;
  }

  const size = head.ContentLength;
  if (typeof size !== 'number' || size < 1 || size > MAX_IMAGE_BYTES) return reject('size');
  if (head.ServerSideEncryption !== 'aws:kms' || head.SSEKMSKeyId !== o.kmsKeyId) return reject('encryption');
  if (head.ContentType !== o.contentType) return reject('content_type');
  const etag = head.ETag;
  if (!etag) return reject('changed');

  let bytes: Uint8Array;
  try {
    const range = await s3.send(new GetObjectCommand({ Bucket: o.bucket, Key: o.pendingKey, Range: 'bytes=0-15', IfMatch: etag }));
    bytes = range.Body ? await range.Body.transformToByteArray() : new Uint8Array();
  } catch (err) {
    if (isPreconditionFailed(err)) return reject('changed');
    if (isMissing(err)) return reject('missing');
    throw err;
  }
  if (!magicMatches(bytes, o.contentType)) return reject('magic');

  try {
    await s3.send(new CopyObjectCommand({
      Bucket: o.bucket,
      Key: finalKey,
      CopySource: `${o.bucket}/${o.pendingKey}`,
      CopySourceIfMatch: etag,
      MetadataDirective: 'REPLACE',
      ContentType: o.contentType,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: o.kmsKeyId,
      BucketKeyEnabled: true,
    }));
  } catch (err) {
    if (isPreconditionFailed(err)) return reject('changed');
    if (isMissing(err)) return reject('missing');
    throw err;
  }

  // The checked copy is what gets attached; the upload has served its
  // purpose. If this delete fails, the incoming/ lifecycle rule removes it.
  await deleteObjectQuietly(s3, o.bucket, o.pendingKey);
  return { ok: true, finalKey, byteSize: size };
}

/**
 * Deletes `keys` in batches of at most 1000. Throws when S3 reports any key
 * it could not delete, giving only the count. Returns the number deleted.
 */
export async function deleteKeys(s3: S3Client, bucket: string, keys: readonly string[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < keys.length; start += MAX_DELETE_KEYS) {
    const chunk = keys.slice(start, start + MAX_DELETE_KEYS);
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
    }));
    const failed = result?.Errors?.length ?? 0;
    if (failed > 0) throw new Error(`report_cleanup_delete_failed: ${failed} of ${chunk.length} objects`);
    deleted += chunk.length;
  }
  return deleted;
}
