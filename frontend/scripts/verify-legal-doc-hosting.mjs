import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const requiredFiles = [
  'public/legal/terms/2026-05-15.pdf',
  'public/legal/privacy/2026-05-15.pdf',
  'src/app/legal/terms/route.ts',
  'src/app/legal/privacy/route.ts',
  'src/app/legal/terms/[version]/route.ts',
  'src/app/legal/privacy/[version]/route.ts',
  'src/app/terms/route.ts',
  'src/app/privacypolicy/route.ts',
  'src/lib/legal-documents.ts',
];

const missing = requiredFiles.filter((file) => !existsSync(join(root, file)));

if (missing.length > 0) {
  throw new Error(`Missing legal hosting files:\n${missing.map((file) => `- ${file}`).join('\n')}`);
}

for (const pdfPath of requiredFiles.filter((file) => file.endsWith('.pdf'))) {
  const size = statSync(join(root, pdfPath)).size;
  if (size < 10_000) {
    throw new Error(`${pdfPath} looks too small to be a real PDF (${size} bytes)`);
  }
}

const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8');
for (const publicPath of ['/legal/terms', '/legal/privacy', '/terms', '/privacypolicy']) {
  if (!middleware.includes(publicPath)) {
    throw new Error(`middleware does not explicitly preserve ${publicPath}`);
  }
}

const registry = readFileSync(join(root, 'src/lib/legal-documents.ts'), 'utf8');
for (const marker of ['terms', 'privacy', '2026-05-15', 'application/pdf']) {
  if (!registry.includes(marker)) {
    throw new Error(`legal document registry is missing ${marker}`);
  }
}

console.log('Legal document hosting contract is present.');
