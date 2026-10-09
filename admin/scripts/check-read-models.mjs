import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Date helpers must print UTC whatever the host zone; CI runs in UTC, where a
// helper that forgot timeZone: 'UTC' would still pass.
process.env.TZ = 'America/Los_Angeles';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/read-models');
const sourceFiles = [
  'src/lib/server/db-secret.ts',
  'src/lib/server/db.ts',
  'src/lib/server/admin-cases.ts',
  'src/lib/server/admin-audit.ts',
  'src/lib/server/admin-lockouts.ts',
  'src/lib/case-aging.ts',
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
const aging = await import(pathToFileURL(resolve(outDir, 'case-aging.mjs')));

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
  updated_at: new Date('2026-06-04T15:00:00Z'), status_changed_at: new Date('2026-06-04T15:00:00Z'),
  assigned_admin_email: null,
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
  status_changed_at: new Date('2026-06-04T15:00:00Z'),
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
  status_changed_at: new Date('2026-06-04T15:00:00Z'),
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

// Roadmap 1b: dashboard tiles count with their own queries. Roadmap 2d: the
// Open cases tile reads its total from the by-wait counts, so the bare count is gone.
assert.equal(typeof cases.countOpenCasesByWait, 'function');
assert.equal(cases.countOpenAdminCases, undefined, 'countOpenCasesByWait replaced countOpenAdminCases');
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

// ---- Roadmap 2d: case aging (migration 117's admin_cases.status_changed_at) ----
const agingNow = new Date('2026-10-09T15:00:00.000Z'); // a Friday
const agingFlat = (sql) => sql.trim().replace(/\s+/g, ' ');

// The read model carries the time the case entered its current status.
assert.equal(mappedCase.statusChangedAt, '2026-06-04T15:00:00.000Z');
assert.equal(
  cases.mapAdminCaseRow({
    id: 'case-3', case_type: 'help_request', status: 'pending_worker', priority: 70,
    user_id: null, conversation_id: null, employer_id: null, summary: 'Help', details: null,
    created_at: '2026-10-07T12:00:00+00:00', updated_at: '2026-10-09T14:00:00+00:00',
    status_changed_at: '2026-10-09T10:00:00+00:00', assigned_admin_email: null,
    user_name: null, user_phone: null, user_email: null, employer_name: null,
  }).statusChangedAt,
  '2026-10-09T10:00:00.000Z',
  'a string timestamp is normalised to ISO',
);

// Queue order: waiting on us (open, pending admin), then waiting on the worker,
// then closed. Open groups: highest priority first, then the longest time in the
// current status. Closed: most recently closed first. id breaks every tie.
assert.equal(
  agingFlat(cases.CASE_QUEUE_ORDER),
  "ORDER BY CASE WHEN c.status IN ('resolved', 'dismissed') THEN 2 WHEN c.status = 'pending_worker' THEN 1 ELSE 0 END, "
    + "CASE WHEN c.status NOT IN ('resolved', 'dismissed') THEN c.priority END DESC, "
    + "CASE WHEN c.status NOT IN ('resolved', 'dismissed') THEN c.status_changed_at END, "
    + "CASE WHEN c.status IN ('resolved', 'dismissed') THEN c.status_changed_at END DESC, "
    + 'c.id',
);
const casesSource = readFileSync(resolve(root, 'src/lib/server/admin-cases.ts'), 'utf8');
assert.equal(
  (casesSource.match(/\$\{CASE_QUEUE_ORDER\}/g) ?? []).length,
  2,
  'the /cases queue and the Home preview share one order',
);
assert.doesNotMatch(
  casesSource,
  /ORDER BY c\.status, c\.priority DESC|ORDER BY c\.priority DESC, c\.created_at DESC/,
  'the old orders (status as text; newest first) are gone',
);
assert.equal(
  (casesSource.match(/c\.created_at, c\.updated_at, c\.status_changed_at,/g) ?? []).length,
  2,
  'the list select and the case-page select both read status_changed_at',
);
assert.match(
  casesSource,
  /WHERE \$\{OPEN_CASE_FILTER\}\s*\$\{CASE_QUEUE_ORDER\}\s*LIMIT \$1/,
  'the Home preview lists open cases only',
);
assert.match(casesSource, /pool\.query<OpenCasesByWaitRow>\(OPEN_CASES_BY_WAIT_SQL\)/, 'the Home counts run the pinned query');

// Timeline: events written in one transaction share created_at (117's
// status_changed and, e.g., admin_reply_queued). Newest first, the status change
// (the later write) sorts above the action that caused it; id breaks other ties.
assert.match(
  casesSource,
  /ORDER BY created_at DESC,\s*\(event_type = 'status_changed'\) DESC,\s*id`/,
  'events written in one transaction keep one order: the status change above the action that caused it',
);
assert.deepEqual(
  cases.mapAdminCaseEventRow({
    id: 'event-9', event_type: 'status_changed', actor_type: 'admin',
    payload: { title: 'Status changed', detail: 'Open → Pending worker', from: 'open', to: 'pending_worker' },
    created_at: '2026-10-09T10:00:00+00:00',
  }),
  { id: 'event-9', at: '2026-10-09T10:00:00.000Z', actor: 'admin', title: 'Status changed', detail: 'Open → Pending worker' },
  'a 117 status_changed event renders as the timeline entry the spec names',
);

// Home: one grouped query over open cases; buckets of now() - status_changed_at
// are [0, 24 h), [24 h, 72 h), [72 h, 168 h), [168 h, ∞). A time ahead of the
// clock falls in the first bucket.
assert.equal(
  agingFlat(cases.OPEN_CASES_BY_WAIT_SQL),
  "SELECT CASE WHEN c.status = 'pending_worker' THEN 'worker' ELSE 'us' END AS waiting_on, "
    + 'CASE '
    + "WHEN now() - c.status_changed_at < interval '24 hours' THEN 'under_1d' "
    + "WHEN now() - c.status_changed_at < interval '72 hours' THEN 'days_1_3' "
    + "WHEN now() - c.status_changed_at < interval '168 hours' THEN 'days_3_7' "
    + "ELSE 'over_7d' "
    + 'END AS bucket, COUNT(*) AS count '
    + 'FROM admin_cases c '
    + "WHERE c.status NOT IN ('resolved', 'dismissed') "
    + 'GROUP BY 1, 2',
);
const agingZeros = { under_1d: 0, days_1_3: 0, days_3_7: 0, over_7d: 0 };
assert.deepEqual(cases.mapOpenCasesByWaitRows([]), { us: agingZeros, worker: agingZeros }, 'no open cases: every cell is 0');
const agingByWait = cases.mapOpenCasesByWaitRows([
  { waiting_on: 'us', bucket: 'under_1d', count: '2' },
  { waiting_on: 'us', bucket: 'over_7d', count: '1' },
  { waiting_on: 'worker', bucket: 'days_1_3', count: '3' },
  { waiting_on: 'worker', bucket: 'days_3_7', count: '1234' },
]);
assert.deepEqual(agingByWait, {
  us: { under_1d: 2, days_1_3: 0, days_3_7: 0, over_7d: 1 },
  worker: { under_1d: 0, days_1_3: 3, days_3_7: 1234, over_7d: 0 },
});
assert.throws(
  () => cases.mapOpenCasesByWaitRows([{ waiting_on: 'closed', bucket: 'under_1d', count: '1' }]),
  /Unexpected waiting_on: closed/,
);
assert.throws(
  () => cases.mapOpenCasesByWaitRows([{ waiting_on: 'us', bucket: 'toString', count: '1' }]),
  /Unexpected wait bucket: toString/,
);

// The Home card: row and column labels, row totals, the tile's total and note.
assert.deepEqual(
  aging.WAIT_ROWS.map((row) => [row.id, row.label]),
  [['us', 'Waiting on us'], ['worker', 'Waiting on worker']],
);
assert.deepEqual(
  aging.WAIT_BUCKETS.map((bucket) => [bucket.id, bucket.label]),
  [['under_1d', 'Under 1 day'], ['days_1_3', '1–3 days'], ['days_3_7', '3–7 days'], ['over_7d', 'Over 7 days']],
);
assert.equal(aging.waitTotal(agingByWait.us), 3);
assert.equal(aging.waitTotal(agingByWait.worker), 1237);
assert.equal(aging.openCasesTotal(agingByWait), 1240);
assert.equal(aging.waitingOnUsNote(agingByWait), '3 waiting on us');
assert.equal(aging.waitingOnUsNote({ us: agingZeros, worker: agingByWait.worker }), '0 waiting on us');
assert.equal(
  aging.waitingOnUsNote({ us: { ...agingZeros, under_1d: 1200, over_7d: 34 }, worker: agingZeros }),
  '1,234 waiting on us',
);

// Who a case is waiting on, and the status labels (the badges' and 117's).
for (const [status, on, label] of [
  ['open', 'us', 'Open'],
  ['pending_admin', 'us', 'Pending admin'],
  ['pending_worker', 'worker', 'Pending worker'],
  ['resolved', 'closed', 'Resolved'],
  ['dismissed', 'closed', 'Dismissed'],
]) {
  assert.equal(aging.waitingOn(status), on, `waitingOn(${status})`);
  assert.equal(aging.statusLabel(status), label, `statusLabel(${status})`);
}
assert.throws(() => aging.waitingOn('archived'), /Unexpected case status: archived/);
assert.throws(() => aging.statusLabel('toString'), /Unexpected case status: toString/);

// Durations, floored: minutes under an hour (at least 1, also ahead of the
// clock), hours under a day, days under 14 days, then weeks.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
for (const [ms, text] of [
  [-5 * MIN, '1 min'],
  [0, '1 min'],
  [59_999, '1 min'],
  [MIN, '1 min'],
  [2 * MIN - 1, '1 min'],
  [2 * MIN, '2 min'],
  [HOUR - 1, '59 min'],
  [HOUR, '1 h'],
  [5 * HOUR + 59 * MIN, '5 h'],
  [DAY - 1, '23 h'],
  [DAY, '1 day'],
  [2 * DAY - 1, '1 day'],
  [2 * DAY, '2 days'],
  [14 * DAY - 1, '13 days'],
  [14 * DAY, '2 weeks'],
  [21 * DAY - 1, '2 weeks'],
  [21 * DAY, '3 weeks'],
  [400 * DAY, '57 weeks'],
]) {
  assert.equal(aging.formatWait(ms), text, `formatWait(${ms})`);
}

// Dates: UTC month and day; the year only when it is not the current UTC year.
// TZ is Los Angeles (top of file), so a helper that reads the local day or year fails.
for (const [iso, now, text] of [
  ['2026-10-03T10:00:00.000Z', agingNow, 'Oct 3'],
  ['2026-10-04T00:30:00.000Z', agingNow, 'Oct 4'], // Oct 3 on a US clock
  ['2026-01-01T00:00:00.000Z', agingNow, 'Jan 1'],
  ['2026-01-01T00:30:00.000Z', agingNow, 'Jan 1'], // Dec 31, 2025 on a US clock
  ['2025-12-31T23:59:59.000Z', agingNow, 'Dec 31, 2025'],
  ['2026-12-31T20:00:00.000Z', new Date('2027-01-01T07:30:00.000Z'), 'Dec 31, 2026'], // still 2026 on a US clock
]) {
  assert.equal(aging.formatCaseDate(iso, now), text, `formatCaseDate(${iso})`);
}

// Line text for /cases, the case page and the Home preview.
const agingCase = (status, createdAt, statusChangedAt) => ({ status, createdAt, statusChangedAt });
const agingOpen = agingCase('open', '2026-10-03T09:00:00.000Z', '2026-10-03T09:00:00.000Z');
const agingAdmin = agingCase('pending_admin', '2026-10-08T15:00:00.000Z', '2026-10-08T15:00:00.000Z');
const agingWorker = agingCase('pending_worker', '2026-10-07T12:00:00.000Z', '2026-10-09T10:00:00.000Z');
const agingResolved = agingCase('resolved', '2025-12-20T12:00:00.000Z', '2026-10-07T08:00:00.000Z');
const agingDismissed = agingCase('dismissed', '2026-09-20T10:00:00.000Z', '2026-10-08T02:00:00.000Z'); // closed Oct 7 on a US clock
const agingFresh = agingCase('open', '2026-10-09T14:59:30.000Z', '2026-10-09T14:59:30.000Z');
for (const [item, opened, wait, openedMeta, statusMeta, preview] of [
  [agingOpen, 'Opened Oct 3 · 6 days ago', 'Waiting on us for 6 days', 'Opened Oct 3 (6 days ago)', 'Open for 6 days', 'waiting 6 days'],
  [agingAdmin, 'Opened Oct 8 · 1 day ago', 'Waiting on us for 1 day', 'Opened Oct 8 (1 day ago)', 'Pending admin for 1 day', 'waiting 1 day'],
  [agingWorker, 'Opened Oct 7 · 2 days ago', 'Waiting on worker for 5 h', 'Opened Oct 7 (2 days ago)', 'Pending worker for 5 h', 'waiting 5 h'],
  [agingResolved, 'Opened Dec 20, 2025 · 41 weeks ago', 'Resolved Oct 7', 'Opened Dec 20, 2025 (41 weeks ago)', 'Resolved Oct 7', 'Resolved Oct 7'],
  [agingDismissed, 'Opened Sep 20 · 2 weeks ago', 'Dismissed Oct 8', 'Opened Sep 20 (2 weeks ago)', 'Dismissed Oct 8', 'Dismissed Oct 8'],
  [agingFresh, 'Opened Oct 9 · 1 min ago', 'Waiting on us for 1 min', 'Opened Oct 9 (1 min ago)', 'Open for 1 min', 'waiting 1 min'],
]) {
  assert.equal(aging.caseOpenedLine(item, agingNow), opened);
  assert.equal(aging.caseWaitLine(item, agingNow), wait);
  assert.equal(aging.caseOpenedMeta(item, agingNow), openedMeta);
  assert.equal(aging.caseStatusMeta(item, agingNow), statusMeta);
  assert.equal(aging.casePreviewWait(item, agingNow), preview);
}

console.log('admin read model checks passed');
