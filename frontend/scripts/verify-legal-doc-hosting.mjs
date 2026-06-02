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
  'src/app/sms-opt-in/route.ts',
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
for (const publicPath of ['/legal/terms', '/legal/privacy', '/terms', '/privacypolicy', '/sms-opt-in']) {
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

const reviewRoutes = [
  {
    path: 'src/app/terms/route.ts',
    markers: [
      'text/html',
      'JaleApp.AI SMS Terms',
      'Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes.',
      'SMS opt-in consent is collected directly for JaleApp.AI account verification messages.',
      '<strong>HELP</strong>',
      '<strong>STOP</strong>',
      'https://www.jaleapp.ai/privacypolicy',
    ],
  },
  {
    path: 'src/app/privacypolicy/route.ts',
    markers: [
      'text/html',
      'JaleApp.AI Privacy Policy',
      'SMS opt-in consent data',
      'Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes.',
      'third parties or affiliates for marketing or promotional purposes',
      'https://www.jaleapp.ai/terms',
    ],
  },
  {
    path: 'src/app/sms-opt-in/route.ts',
    markers: [
      'text/html',
      'JaleApp.AI SMS Opt-In',
      'Workers opt in to receive JaleApp.AI SMS authentication messages when they actively request a one-time passcode.',
      'Web account verification',
      'WhatsApp onboarding',
      'Message frequency varies by account activity.',
      'Message and data rates may apply.',
      'https://www.jaleapp.ai/terms',
      'https://www.jaleapp.ai/privacypolicy',
    ],
  },
];

for (const route of reviewRoutes) {
  const source = readFileSync(join(root, route.path), 'utf8');
  for (const marker of route.markers) {
    if (!source.includes(marker)) {
      throw new Error(`${route.path} is missing public review marker: ${marker}`);
    }
  }
}

const privacySource = readFileSync(join(root, 'src/app/privacypolicy/route.ts'), 'utf8');
if (privacySource.includes('except as necessary')) {
  throw new Error('privacy policy contains ambiguous SMS consent sharing carveout: except as necessary');
}

console.log('Legal document hosting contract is present.');
