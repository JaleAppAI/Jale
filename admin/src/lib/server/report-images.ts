// Short-lived links to report screenshots.
//
// The admin CSP keeps img-src to the app itself, so a screenshot is never
// embedded: the admin opens it in a new tab through a presigned GET that
// lasts 300 seconds and forces the stored image type and inline display.
// The link is minted only after its access event has committed
// (report-actions.ts). Object keys and links are never logged.
import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const REPORT_IMAGE_LINK_SECONDS = 300;
export const REPORT_IMAGES_BUCKET_ENV = 'REPORT_IMAGES_BUCKET';

const REPORT_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ReportImageContentType = (typeof REPORT_IMAGE_CONTENT_TYPES)[number];

export function isReportImageContentType(value: unknown): value is ReportImageContentType {
  return typeof value === 'string' && (REPORT_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

/** The images bucket, read when a link is requested. Undefined when unset. */
export function reportImagesBucket(): string | undefined {
  const bucket = process.env[REPORT_IMAGES_BUCKET_ENV]?.trim();
  return bucket ? bucket : undefined;
}

export type ReportImageLinkRequest = {
  bucket: string;
  /** Exactly as problem_report_image returned it; never parsed or built here. */
  key: string;
  contentType: ReportImageContentType;
};

export function buildReportImageGetInput({ bucket, key, contentType }: ReportImageLinkRequest) {
  return {
    Bucket: bucket,
    Key: key,
    ResponseContentType: contentType,
    ResponseContentDisposition: 'inline',
  };
}

/**
 * Checksum validation stays opt-in, so the presigned GET carries no checksum
 * mode and a browser can open it with nothing but the URL.
 */
export function createReportImagesClient(config: S3ClientConfig = {}): S3Client {
  return new S3Client({ responseChecksumValidation: 'WHEN_REQUIRED', ...config });
}

// Created on first use, so importing this module needs no AWS configuration.
let defaultClient: S3Client | undefined;

function getDefaultClient(): S3Client {
  defaultClient ??= createReportImagesClient();
  return defaultClient;
}

/**
 * A 300-second presigned GET, signed at `issuedAt`, so the link expires
 * exactly when its access event says it does.
 */
export function presignReportImage(
  request: ReportImageLinkRequest & { issuedAt: Date },
  client: S3Client = getDefaultClient(),
): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand(buildReportImageGetInput(request)), {
    expiresIn: REPORT_IMAGE_LINK_SECONDS,
    signingDate: request.issuedAt,
  });
}
