import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type LegalDocumentType = 'terms' | 'privacy';

type LegalDocumentVersion = {
  readonly version: string;
  readonly filename: string;
};

type LegalDocumentConfig = {
  readonly title: string;
  readonly currentVersion: string;
  readonly versions: readonly LegalDocumentVersion[];
};

export const LEGAL_DOCUMENT_CONTENT_TYPE = 'application/pdf';

export const LEGAL_DOCUMENTS: Record<LegalDocumentType, LegalDocumentConfig> = {
  terms: {
    title: 'Jale App Terms and Conditions',
    currentVersion: '2026-05-15',
    versions: [{ version: '2026-05-15', filename: '2026-05-15.pdf' }],
  },
  privacy: {
    title: 'Jale Privacy Policy',
    currentVersion: '2026-05-15',
    versions: [{ version: '2026-05-15', filename: '2026-05-15.pdf' }],
  },
};

export function getLegalDocumentConfig(type: LegalDocumentType) {
  return LEGAL_DOCUMENTS[type];
}

export function getCurrentLegalDocumentVersion(type: LegalDocumentType) {
  return getLegalDocumentConfig(type).currentVersion;
}

export function findLegalDocumentVersion(type: LegalDocumentType, version: string) {
  return getLegalDocumentConfig(type).versions.find((entry) => entry.version === version) ?? null;
}

export async function readLegalDocument(type: LegalDocumentType, version: string) {
  const entry = findLegalDocumentVersion(type, version);
  if (!entry) return null;

  return readFile(join(process.cwd(), 'public', 'legal', type, entry.filename));
}

export function legalDocumentHeaders(type: LegalDocumentType, version: string) {
  const config = getLegalDocumentConfig(type);

  return {
    'Content-Type': LEGAL_DOCUMENT_CONTENT_TYPE,
    'Content-Disposition': `inline; filename="${type}-${version}.pdf"`,
    'Cache-Control': 'no-store, max-age=0',
    'X-Jale-Legal-Document': type,
    'X-Jale-Legal-Document-Title': config.title,
    'X-Jale-Legal-Document-Version': version,
  };
}
