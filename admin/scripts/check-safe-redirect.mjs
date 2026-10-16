import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/safe-redirect');
const sourceFiles = ['src/lib/safe-redirect.ts'].map((p) => resolve(root, p));

for (const sourcePath of sourceFiles) {
  assert.equal(existsSync(sourcePath), true, `${sourcePath} should exist`);
}

mkdirSync(outDir, { recursive: true });

const program = ts.createProgram(sourceFiles, {
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
  diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  [],
  'safe-redirect module should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(resolve(outDir, `${moduleName}.mjs`), data);
  }
});

const { safeNextPath } = await import(pathToFileURL(resolve(outDir, 'safe-redirect.mjs')));

// Safe same-origin relative paths pass through unchanged.
assert.equal(safeNextPath('/cases/abc-123'), '/cases/abc-123');
assert.equal(safeNextPath('/verifications/1?step=docs'), '/verifications/1?step=docs');

// Open-redirect vectors are neutralized to '/'.
assert.equal(safeNextPath('//evil.com'), '/');
assert.equal(safeNextPath('https://evil.com'), '/');
assert.equal(safeNextPath('http://evil.com'), '/');
assert.equal(safeNextPath('/\\evil.com'), '/');
assert.equal(safeNextPath('evil.com'), '/');
assert.equal(safeNextPath('\\\\evil.com'), '/');

// ASCII control characters (C0 and DEL) are refused anywhere in the path,
// query or fragment: a header-split or a tab/newline some browsers strip
// before resolving the URL.
for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f]) {
  const char = String.fromCharCode(code);
  assert.equal(safeNextPath(`/cases${char}`), '/', `control 0x${code.toString(16)} at the end`);
  assert.equal(safeNextPath(`/${char}/evil.com`), '/', `control 0x${code.toString(16)} after the slash`);
  assert.equal(safeNextPath(`/cases?q=a${char}b`), '/', `control 0x${code.toString(16)} in the query`);
}
// Printable characters and percent-encoded controls stay as they are.
assert.equal(safeNextPath('/cases?q=a%0Ab&x=%20'), '/cases?q=a%0Ab&x=%20');
assert.equal(safeNextPath('/security?actor=00000000-0000-4000-8000-000000000001'), '/security?actor=00000000-0000-4000-8000-000000000001');

// Empty / missing defaults to '/'.
assert.equal(safeNextPath(undefined), '/');
assert.equal(safeNextPath(null), '/');
assert.equal(safeNextPath(''), '/');

console.log('admin safe-redirect checks passed');
