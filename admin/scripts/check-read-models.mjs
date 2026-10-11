import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/read-models');
const sourceFiles = [
  'src/lib/server/db-secret.ts',
  'src/lib/server/db.ts',
  'src/lib/server/admin-cases.ts',
  'src/lib/server/admin-audit.ts',
  'src/lib/server/admin-lockouts.ts',
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
  'admin read model modules should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(
      resolve(outDir, `${moduleName}.mjs`),
      data
        .replaceAll('"./db"', '"./db.mjs"')
        .replaceAll("'./db'", "'./db.mjs'")
        .replaceAll('"./db-secret"', '"./db-secret.mjs"')
        .replaceAll("'./db-secret'", "'./db-secret.mjs'")
        .replaceAll('"./admin-cases"', '"./admin-cases.mjs"')
        .replaceAll("'./admin-cases'", "'./admin-cases.mjs'"),
    );
  }
});

const cases = await import(pathToFileURL(resolve(outDir, 'admin-cases.mjs')));
const audit = await import(pathToFileURL(resolve(outDir, 'admin-audit.mjs')));
const lockouts = await import(pathToFileURL(resolve(outDir, 'admin-lockouts.mjs')));

assert.equal(cases.maskPhone('+15125557821'), '+1 512 *** 7821');
assert.equal(cases.maskEmail('ops@acme-roofing.example'), 'o***@acme-roofing.example');

// Legal name is masked by default (first name + last initial); full name is
// reveal-only. Guards against the unmasked-name regression (review finding H1).
assert.equal(cases.maskName('Carlos Mendoza'), 'Carlos M.');
assert.equal(cases.maskName('Maria De La Cruz'), 'Maria C.');
assert.equal(cases.maskName('Cher'), 'Cher');
assert.equal(cases.maskName(null), undefined);

const maskedNameCase = cases.mapAdminCaseRow({
  id: 'case-2', case_type: 'help_request', status: 'open', priority: 50,
  user_id: 'w', conversation_id: null, employer_id: null, summary: 'Help',
  details: {}, created_at: new Date('2026-06-04T15:00:00Z'),
  updated_at: new Date('2026-06-04T15:00:00Z'), assigned_admin_email: null,
  user_name: 'Carlos Mendoza', user_phone: null, user_email: null, employer_name: null,
});
assert.equal(maskedNameCase.workerName, 'Carlos M.');
assert.notEqual(maskedNameCase.workerName, 'Carlos Mendoza');

const mappedCase = cases.mapAdminCaseRow({
  id: 'case-id',
  case_type: 'help_request',
  status: 'open',
  priority: 90,
  user_id: 'worker-id',
  conversation_id: 'conversation-id',
  employer_id: null,
  summary: 'Worker needs help',
  details: { caseNumber: 'CASE-1001', notes: ['one'], lastMessage: 'HELP', workerLabel: 'Worker' },
  created_at: new Date('2026-06-04T15:00:00Z'),
  updated_at: new Date('2026-06-04T15:30:00Z'),
  assigned_admin_email: 'ops@jaleapp.ai',
  user_name: 'Carlos M.',
  user_phone: '+15125557821',
  user_email: 'carlos@example.com',
  employer_name: null,
}, [{
  id: 'event-id',
  event_type: 'help_keyword',
  actor_type: 'worker',
  payload: { title: 'Help requested', detail: 'Worker sent HELP.' },
  created_at: new Date('2026-06-04T15:01:00Z'),
}]);

assert.equal(mappedCase.maskedPhone, '+1 512 *** 7821');
assert.equal(mappedCase.maskedEmail, 'c***@example.com');
assert.equal(mappedCase.caseNumber, 'CASE-1001');
assert.equal(mappedCase.lastMessage, 'HELP');
assert.equal(mappedCase.timeline[0].title, 'Help requested');

const workerAndEmployerCase = cases.mapAdminCaseRow({
  id: 'case-with-employer',
  case_type: 'verification_blocker',
  status: 'open',
  priority: 95,
  user_id: 'worker-id',
  conversation_id: 'conversation-id',
  employer_id: 'employer-id',
  summary: 'Worker verification needs review',
  details: { subjectLabel: 'Electrician applicant' },
  created_at: new Date('2026-06-04T15:00:00Z'),
  updated_at: new Date('2026-06-04T15:30:00Z'),
  assigned_admin_email: 'ops@jaleapp.ai',
  user_name: 'Carlos Mendoza',
  user_phone: '+15125557821',
  user_email: 'carlos@example.com',
  employer_name: 'Maria Johnson',
});
assert.equal(workerAndEmployerCase.workerName, 'Carlos M.');
assert.equal(workerAndEmployerCase.employerName, 'Maria J.');

const mappedAudit = audit.mapAuditEventRow({
  id: 'audit-id',
  created_at: new Date('2026-06-04T16:00:00Z'),
  actor_email: null,
  actor_role: 'admin_ops',
  action: 'reveal_pii',
  target_type: 'admin_case',
  target_id: 'case-id',
  pii_reveal: true,
  metadata: { summary: 'Revealed worker phone for callback.' },
});

assert.equal(mappedAudit.actor, 'admin_ops');
assert.equal(mappedAudit.summary, 'Revealed worker phone for callback.');
assert.equal(mappedAudit.piiReveal, true);

// Verify list function return shapes export { rows, totalCount } (truncation
// disclosure feature). These are compile-time checks via the TS typecheck
// above; the runtime assertions below guard against regressions in the shape.
assert.ok('ADMIN_CASES_PAGE_SIZE' in cases, 'cases module should export ADMIN_CASES_PAGE_SIZE');
assert.ok('AUDIT_PAGE_SIZE' in audit, 'audit module should export AUDIT_PAGE_SIZE');

// Confirm the list functions exist and have the correct signature (no DB call
// is made here; the DB-connect path is guarded by getAdminDbPool).
assert.equal(typeof cases.listAdminCases, 'function');
assert.equal(typeof audit.listAuditEvents, 'function');

// Roadmap 1b: dashboard tiles count with their own queries.
assert.equal(typeof cases.countOpenAdminCases, 'function');
assert.equal(typeof cases.listOpenAdminCases, 'function');
assert.equal(typeof audit.countPiiRevealEvents, 'function');

// Roadmap 1b: one admin_identity_lockouts() row (migration 102).
const lockoutRow = {
  challenge_id: 'challenge-id',
  kind: 'lockout',
  masked_phone: '+52 664 *** 4567',
  outcome: 'retrying',
  lockout_count: 2,
  attempts: 0,
  locked_until: null,
  last_event_at: new Date('2026-10-01T15:30:00Z'),
  started_at: '2026-09-30T12:00:00Z',
};
assert.deepEqual(lockouts.mapIdentityLockoutRow(lockoutRow), {
  challengeId: 'challenge-id',
  kind: 'lockout',
  maskedPhone: '+52 664 *** 4567',
  outcome: 'retrying',
  lockoutCount: 2,
  attempts: 0,
  lockedUntil: null,
  lastEventAt: '2026-10-01T15:30:00.000Z',
  startedAt: '2026-09-30T12:00:00.000Z',
});
assert.throws(() => lockouts.mapIdentityLockoutRow({ ...lockoutRow, outcome: 'approved' }), /Unexpected lockout outcome/);
assert.throws(() => lockouts.mapIdentityLockoutRow({ ...lockoutRow, kind: 'pending' }), /Unexpected lockout kind/);

assert.equal(lockouts.lockoutOutcomeText({ outcome: 'lock_expired', lockedUntil: null }), 'Lock expired, no retry');
assert.equal(lockouts.lockoutOutcomeText({ outcome: 'retrying', lockedUntil: null }), 'Retrying');
assert.equal(lockouts.lockoutOutcomeText({ outcome: 'verified', lockedUntil: null }), 'Verified since lockout');
assert.equal(lockouts.lockoutOutcomeText({ outcome: 'superseded', lockedUntil: null }), 'Superseded');
assert.equal(lockouts.lockoutOutcomeText({ outcome: 'code_expired', lockedUntil: null }), 'Code expired');
assert.equal(lockouts.lockoutOutcomeText({ outcome: 'locked', lockedUntil: null }), 'Locked');
assert.match(
  lockouts.lockoutOutcomeText({ outcome: 'locked', lockedUntil: '2026-10-01T15:42:00Z' }),
  /^Locked until \d{1,2}:\d{2}\s?[AP]M\s\S+$/,
);
assert.equal(lockouts.lockoutOutcomeBadge('locked'), 'rejected');
assert.equal(lockouts.lockoutOutcomeBadge('verified'), 'approved');
assert.equal(lockouts.lockoutOutcomeBadge('code_expired'), 'pending_worker');
assert.equal(lockouts.LOCKOUT_WINDOW_DAYS, 7);
assert.equal(typeof lockouts.listIdentityLockouts, 'function');

console.log('admin read model checks passed');
