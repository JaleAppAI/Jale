import { legalDocumentHeaders, readLegalDocument } from '@/lib/legal-documents';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ version: string }> }) {
  const { version } = await params;
  const document = await readLegalDocument('terms', version);

  if (!document) {
    return new Response('Terms document version not found', { status: 404 });
  }

  return new Response(document, {
    headers: legalDocumentHeaders('terms', version),
  });
}
