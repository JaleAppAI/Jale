import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/session-helpers');
const sourceFiles = [
  'src/lib/server/session-claims.ts',
].map((relativePath) => resolve(root, relativePath));

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
  diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  [],
  'admin session helper module should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(resolve(outDir, `${moduleName}.mjs`), data);
  }
});

const session = await import(pathToFileURL(resolve(outDir, 'session-claims.mjs')));

assert.equal(session.selectHighestAdminRole(['admin_readonly']), 'admin_readonly');
assert.equal(session.selectHighestAdminRole(['admin_ops', 'admin_readonly']), 'admin_ops');
assert.equal(session.selectHighestAdminRole(['admin_readonly', 'admin_superadmin', 'admin_ops']), 'admin_superadmin');
assert.equal(session.selectHighestAdminRole(['workers', 'employers']), undefined);
assert.equal(session.selectHighestAdminRole(undefined), undefined);

const adminSession = session.buildAdminSessionFromClaims({
  sub: 'admin-sub',
  email: 'ops@jaleapp.ai',
  'cognito:groups': ['admin_ops', 'admin_readonly'],
});

assert.deepEqual(adminSession, {
  sub: 'admin-sub',
  email: 'ops@jaleapp.ai',
  role: 'admin_ops',
  groups: ['admin_ops', 'admin_readonly'],
});

assert.throws(
  () => session.buildAdminSessionFromClaims({
    sub: 'worker-sub',
    email: 'worker@example.com',
    'cognito:groups': ['worker'],
  }),
  /Admin token does not include an admin group/,
);

assert.equal(session.isLocalPreviewAllowed('development', 'admin_ops', 'true'), true);
assert.equal(session.isLocalPreviewAllowed('development', 'admin_ops', undefined), false);
assert.equal(session.isLocalPreviewAllowed('development', 'admin_ops', 'false'), false);
assert.equal(session.isLocalPreviewAllowed('production', 'admin_ops', 'true'), false);
assert.equal(session.isLocalPreviewAllowed('staging', 'admin_ops', 'true'), false);
assert.equal(session.isLocalPreviewAllowed(undefined, 'admin_ops', 'true'), false);
assert.equal(session.isLocalPreviewAllowed('development', 'not_admin', 'true'), false);

console.log('admin session helper checks passed');
