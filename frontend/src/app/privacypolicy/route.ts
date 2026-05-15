import {
  getCurrentLegalDocumentVersion,
  legalDocumentHeaders,
  readLegalDocument,
} from '@/lib/legal-documents';

export const runtime = 'nodejs';

export async function GET() {
  const version = getCurrentLegalDocumentVersion('privacy');
  const document = await readLegalDocument('privacy', version);

  if (!document) {
    return new Response('Privacy policy document not found', { status: 404 });
  }

  return new Response(document, {
    headers: legalDocumentHeaders('privacy', version),
  });
}
