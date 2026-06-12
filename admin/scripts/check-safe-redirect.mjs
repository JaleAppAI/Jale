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

// Empty / missing defaults to '/'.
assert.equal(safeNextPath(undefined), '/');
assert.equal(safeNextPath(null), '/');
assert.equal(safeNextPath(''), '/');

console.log('admin safe-redirect checks passed');
