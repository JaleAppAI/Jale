import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/action-contract');
const sourceFiles = [
  'src/lib/action-policy.ts',
  'src/lib/action-requests.ts',
  'src/lib/audit-contract.ts',
].map((relativePath) => resolve(root, relativePath));

for (const sourcePath of sourceFiles) {
  assert.equal(existsSync(sourcePath), true, `${sourcePath.replace(`${root}/`, '')} should exist`);
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
  'admin action contract modules should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(
      resolve(outDir, `${moduleName}.mjs`),
      data
        .replaceAll('"./types"', '"./types.mjs"')
        .replaceAll("'./types'", "'./types.mjs'")
        .replaceAll('"./action-policy"', '"./action-policy.mjs"')
        .replaceAll("'./action-policy'", "'./action-policy.mjs'")
        .replaceAll('"./action-requests"', '"./action-requests.mjs"')
        .replaceAll("'./action-requests'", "'./action-requests.mjs'")
        .replaceAll('"./audit-contract"', '"./audit-contract.mjs"')
        .replaceAll("'./audit-contract'", "'./audit-contract.mjs'"),
    );
  }
});

const policy = await import(pathToFileURL(resolve(outDir, 'action-policy.mjs')));
const requests = await import(pathToFileURL(resolve(outDir, 'action-requests.mjs')));
const audit = await import(pathToFileURL(resolve(outDir, 'audit-contract.mjs')));

assert.deepEqual(policy.getCaseActions({ status: 'open', type: 'help_request' }, 'admin_ops').map((action) => action.id), [
  'reply_whatsapp',
  'request_more_info',
  'reveal_pii',
  'resolve_case',
]);

assert.deepEqual(policy.getCaseActions({ status: 'pending_worker', type: 'outbound_failure' }, 'admin_ops').map((action) => action.id), [
  'resend_outbound',
  'reveal_pii',
  'resolve_case',
]);
const outboundFailureActions = policy.getCaseActions(
  { status: 'pending_worker', type: 'outbound_failure' },
  'admin_ops',
);
assert.equal(outboundFailureActions[0].id, 'resend_outbound');
assert.equal(outboundFailureActions[0].disabled, true);
assert.match(outboundFailureActions[0].reason, /not available/);

assert.equal(
  policy.getCaseActions({ status: 'resolved', type: 'help_request' }, 'admin_ops').every((action) => action.disabled),
  true,
  'resolved cases should render historical actions as disabled',
);

assert.equal(
  policy.getCaseActions({ status: 'open', type: 'help_request' }, 'admin_readonly').every((action) => action.disabled),
  true,
  'readonly admins should not be able to trigger mutations or PII reveals',
);

assert.deepEqual(
  policy.getVerificationActions({ status: 'pending', step: 'identity' }, 'admin_ops').map((action) => action.id),
  ['approve_verification', 'reject_verification', 'request_more_info', 'reset_verification_step'],
);

assert.equal(
  policy.getVerificationActions({ status: 'approved', step: 'identity' }, 'admin_ops').every((action) => action.disabled),
  true,
  'approved verifications should not expose active mutation buttons',
);

assert.equal(policy.requiresAuditLog('reveal_pii'), true);
assert.equal(policy.requiresAuditLog('approve_verification'), true);
assert.equal(policy.requiresPiiJustification('reveal_pii'), true);
assert.equal(policy.requiresPiiJustification('request_more_info'), false);

const validPiiRequest = requests.parseAdminActionRequest({
  actionId: 'reveal_pii',
  targetType: 'admin_case',
  targetId: 'case_hel_1001',
  justification: 'Need callback phone to resolve OTP lockout.',
  note: 'Calling worker once.',
});
assert.equal(validPiiRequest.ok, true);
assert.equal(validPiiRequest.value.actionId, 'reveal_pii');

assert.deepEqual(
  requests.parseAdminActionRequest({
    actionId: 'reveal_pii',
    targetType: 'admin_case',
    targetId: 'case_hel_1001',
    justification: 'too short',
  }),
  { ok: false, error: 'pii_justification_required' },
);

assert.deepEqual(
  requests.parseAdminActionRequest({
    actionId: 'approve_verification',
    targetType: 'admin_case',
    targetId: 'case_hel_1001',
  }),
  { ok: false, error: 'target_action_mismatch' },
);

const preview = requests.validateAdminAction({
  actor: 'Luis',
  role: 'admin_ops',
  targetStatus: 'open',
  targetKind: 'case',
  targetCaseType: 'help_request',
  request: validPiiRequest.value,
});
assert.equal(preview.ok, true);
assert.equal(preview.auditEvent.piiReveal, true);
assert.equal(preview.auditEvent.targetId, 'case_hel_1001');
assert.equal(preview.auditEvent.summary.includes('Need callback phone'), true);

const readonlyPreview = requests.validateAdminAction({
  actor: 'Read Only Admin',
  role: 'admin_readonly',
  targetStatus: 'open',
  targetKind: 'case',
  targetCaseType: 'help_request',
  request: validPiiRequest.value,
});
assert.equal(readonlyPreview.ok, false);
assert.equal(readonlyPreview.status, 403);
assert.equal(readonlyPreview.error, 'forbidden');

const closedPreview = requests.validateAdminAction({
  actor: 'Luis',
  role: 'admin_ops',
  targetStatus: 'resolved',
  targetKind: 'case',
  targetCaseType: 'help_request',
  request: validPiiRequest.value,
});
assert.equal(closedPreview.ok, false);
assert.equal(closedPreview.status, 409);
assert.equal(closedPreview.error, 'action_disabled');

const auditEvent = audit.buildAdminAuditEvent({
  actor: 'Ivan',
  actionId: 'approve_verification',
  targetType: 'verification',
  targetId: 'verify_3001',
  justification: 'All documents reviewed.',
});
assert.equal(auditEvent.action, 'approve_verification');
assert.equal(auditEvent.piiReveal, false);
assert.equal(auditEvent.summary, 'Ivan requested approve_verification for verification verify_3001. Justification: All documents reviewed.');

console.log('admin action contract checks passed');
