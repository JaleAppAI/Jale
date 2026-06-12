import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/action-dispatch');
const sourceFiles = [
  'src/lib/action-policy.ts',
  'src/lib/action-requests.ts',
  'src/lib/audit-contract.ts',
  'src/lib/server/db-secret.ts',
  'src/lib/server/db.ts',
  'src/lib/server/session-claims.ts',
  'src/lib/server/admin-cases.ts',
  'src/lib/server/admin-verifications.ts',
  'src/lib/server/admin-action-dispatch.ts',
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
  'admin action dispatch module should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(
      resolve(outDir, `${moduleName}.mjs`),
      data
        .replaceAll('"../action-requests"', '"./action-requests.mjs"')
        .replaceAll("'../action-requests'", "'./action-requests.mjs'")
        .replaceAll('"../audit-contract"', '"./audit-contract.mjs"')
        .replaceAll("'../audit-contract'", "'./audit-contract.mjs'")
        .replaceAll('"../action-policy"', '"./action-policy.mjs"')
        .replaceAll("'../action-policy'", "'./action-policy.mjs'")
        .replaceAll('"./action-policy"', '"./action-policy.mjs"')
        .replaceAll("'./action-policy'", "'./action-policy.mjs'")
        .replaceAll('"./audit-contract"', '"./audit-contract.mjs"')
        .replaceAll("'./audit-contract'", "'./audit-contract.mjs'")
        .replaceAll('"./db-secret"', '"./db-secret.mjs"')
        .replaceAll("'./db-secret'", "'./db-secret.mjs'")
        .replaceAll('"./admin-cases"', '"./admin-cases.mjs"')
        .replaceAll("'./admin-cases'", "'./admin-cases.mjs'")
        .replaceAll('"./admin-verifications"', '"./admin-verifications.mjs"')
        .replaceAll("'./admin-verifications'", "'./admin-verifications.mjs'")
        .replaceAll('"./db"', '"./db.mjs"')
        .replaceAll("'./db'", "'./db.mjs'"),
    );
  }
});

const dispatch = await import(pathToFileURL(resolve(outDir, 'admin-action-dispatch.mjs')));

assert.deepEqual(dispatch.buildCaseMutation('request_more_info', { note: 'Need registration.' }), {
  sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1`,
  params: ['case-id', 'pending_worker', JSON.stringify({ lastAdminNote: 'Need registration.' })],
});

assert.deepEqual(dispatch.buildCaseMutation('resolve_case', {}), {
  sql: `UPDATE admin_cases SET status = $2, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND status <> 'resolved'`,
  params: ['case-id', 'resolved'],
});

assert.equal(dispatch.buildCaseMutation('reply_whatsapp', {}), undefined);

assert.deepEqual(dispatch.buildVerificationMutation('approve_verification', {}), {
  sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker' AND status NOT IN ('resolved', 'dismissed')`,
  params: ['verification-id', 'resolved', JSON.stringify({ verificationStatus: 'approved' })],
});

assert.deepEqual(dispatch.buildVerificationMutation('reject_verification', { justification: 'Docs do not match.' }), {
  sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker' AND status NOT IN ('resolved', 'dismissed')`,
  params: ['verification-id', 'dismissed', JSON.stringify({ verificationStatus: 'rejected', rejectionReason: 'Docs do not match.' })],
});

console.log('admin action dispatch checks passed');
