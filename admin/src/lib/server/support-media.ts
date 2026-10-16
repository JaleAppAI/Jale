// Short-lived links to what a worker sent in a support conversation.
//
// The same pattern as report screenshots (report-images.ts): the admin CSP
// keeps media out of the page, so an attachment opens in a new tab through a
// presigned GET that lasts 300 seconds. The link is minted only after its
// access event has committed (inbox-actions.ts), and it is signed at the
// time that event records, so it expires exactly when the record says.
// Object keys and links are never logged.
import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const SUPPORT_MEDIA_LINK_SECONDS = 300;
export const SUPPORT_MEDIA_BUCKET_ENV = 'SUPPORT_MEDIA_BUCKET';

// Types a browser may show inline. Anything else downloads as bytes, so a
// stored type can never make the bucket's origin render a page.
const INLINE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'application/pdf',
]);
const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

/** The support-media bucket, read when a link is requested. Undefined when unset. */
export function supportMediaBucket(): string | undefined {
  const bucket = process.env[SUPPORT_MEDIA_BUCKET_ENV]?.trim();
  return bucket ? bucket : undefined;
}

export type SupportMediaLinkRequest = {
  bucket: string;
  /** Exactly as admin_support_media_link returned it; never parsed or built here. */
  key: string;
  contentType: string | null;
};

export function buildSupportMediaGetInput({ bucket, key, contentType }: SupportMediaLinkRequest) {
  const normalized = contentType?.trim().toLowerCase() ?? '';
  const inline = INLINE_CONTENT_TYPES.has(normalized);
  return {
    Bucket: bucket,
    Key: key,
    ResponseContentType: inline ? normalized : DOWNLOAD_CONTENT_TYPE,
    ResponseContentDisposition: inline ? 'inline' : 'attachment',
  };
}

/** Checksum validation stays opt-in, so the link opens with nothing but the URL. */
export function createSupportMediaClient(config: S3ClientConfig = {}): S3Client {
  return new S3Client({ responseChecksumValidation: 'WHEN_REQUIRED', ...config });
}

// Created on first use, so importing this module needs no AWS configuration.
let defaultClient: S3Client | undefined;

function getDefaultClient(): S3Client {
  defaultClient ??= createSupportMediaClient();
  return defaultClient;
}

/** A 300-second presigned GET, signed at `issuedAt`. */
export function presignSupportMedia(
  request: SupportMediaLinkRequest & { issuedAt: Date },
  client: S3Client = getDefaultClient(),
): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand(buildSupportMediaGetInput(request)), {
    expiresIn: SUPPORT_MEDIA_LINK_SECONDS,
    signingDate: request.issuedAt,
  });
}
