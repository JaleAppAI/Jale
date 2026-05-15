import {
  getCurrentLegalDocumentVersion,
  legalDocumentHeaders,
  readLegalDocument,
} from '@/lib/legal-documents';

export const runtime = 'nodejs';

export async function GET() {
  const version = getCurrentLegalDocumentVersion('terms');
  const document = await readLegalDocument('terms', version);

  if (!document) {
    return new Response('Terms document not found', { status: 404 });
  }

  return new Response(document, {
    headers: legalDocumentHeaders('terms', version),
  });
}
