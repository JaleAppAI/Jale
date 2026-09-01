import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/mfa-setup');
const sourcePath = resolve(root, 'src/lib/otpauth.ts');

assert.equal(existsSync(sourcePath), true, `${sourcePath} should exist`);

mkdirSync(outDir, { recursive: true });

const program = ts.createProgram([sourcePath], {
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmitOnError: true,
  outDir,
});

const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(
  diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  [],
  'otpauth module should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(resolve(outDir, `${moduleName}.mjs`), data);
  }
});

const otpauth = await import(pathToFileURL(resolve(outDir, 'otpauth.mjs')));

assert.equal(
  otpauth.buildOtpauthUri('ABC234', 'ivan@jaleapp.ai'),
  'otpauth://totp/Jale%20Admin%3Aivan%40jaleapp.ai?secret=ABC234&issuer=Jale%20Admin',
);

assert.match(
  otpauth.buildOtpauthUri('ABC234', 'ivan@jaleapp.ai'),
  /^otpauth:\/\/totp\//,
  'the otpauth URI should use the otpauth://totp/ scheme',
);

assert.match(
  otpauth.buildOtpauthUri("A+B/C=", 'ivan@jaleapp.ai'),
  /secret=A%2BB%2FC%3D/,
  'URL-meaningful characters in the secret should be percent-encoded',
);

// Static source assertions on AdminLoginForm.tsx: guard the QR wiring and the
// manual-entry fallback so a future edit cannot silently drop either.
const loginFormSource = readFileSync(resolve(root, 'src/components/AdminLoginForm.tsx'), 'utf8');

assert.match(
  loginFormSource,
  /from ['"](@\/lib\/otpauth|\.\.\/lib\/otpauth)['"]/,
  'AdminLoginForm should import the otpauth helper',
);

assert.match(
  loginFormSource,
  /toDataURL/,
  'AdminLoginForm should render the TOTP secret as a QR code via qrcode.toDataURL',
);

assert.match(
  loginFormSource,
  /<code>\{totpSecret\}<\/code>/,
  'the manual setup-key fallback must still render alongside the QR code',
);

console.log('admin MFA setup checks passed');
