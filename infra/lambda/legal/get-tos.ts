import type { APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders, requireAbsoluteBaseUrl } from '../lib/http';

const CORS_HEADERS = corsHeaders();

/**
 * Where the legal documents live when `FRONTEND_BASE_URL` is absent or
 * unusable. A literal rather than a throw: `GET /legal/tos` is the door every
 * signup walks through, and the production origin is not a secret.
 */
const DEFAULT_FRONTEND_BASE_URL = 'https://jaleapp.ai';

/**
 * `GET /legal/tos` — tells the client WHICH documents it must accept and WHERE
 * to read them.
 *
 * This used to presign two S3 objects, `tos.md` and `privacy-policy.md`, in
 * `jale-legal-docs-<account>`. Nothing ever put them there. The bucket was
 * EMPTY in production, so every signup that reached `LegalWall` got a working
 * presigned URL to a key that does not exist and rendered S3's `NoSuchKey` XML
 * where the terms of service should have been.
 *
 * The documents people actually read are the versioned PDFs served by the
 * Next.js routes `/legal/terms` and `/legal/privacy`
 * (`frontend/src/lib/legal-documents.ts`) — the same URLs the branded emails
 * and the WhatsApp flow already send. Two mechanisms for one thing, one of them
 * broken; the broken one is gone, along with the bucket, the S3 client and the
 * `grantRead` that made it look load-bearing.
 *
 * The response shape is UNCHANGED (`version`, `tosUrl`, `privacyUrl`): the
 * client contract in `frontend/src/components/legal/LegalWall.tsx` is the same,
 * only the URLs now point at documents that exist.
 */
export const handler = async (): Promise<APIGatewayProxyResult> => {
  // Validated, not interpolated raw: a relative or malformed value would build
  // `/legal/terms` with no origin, and these links are opened in a new tab and
  // also pasted into emails and WhatsApp, where an origin-less path is dead.
  const baseUrl =
    requireAbsoluteBaseUrl(process.env.FRONTEND_BASE_URL) ?? DEFAULT_FRONTEND_BASE_URL;

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      version: process.env.REQUIRED_TOS_VERSION,
      tosUrl: `${baseUrl}/legal/terms`,
      privacyUrl: `${baseUrl}/legal/privacy`,
    }),
  };
};
