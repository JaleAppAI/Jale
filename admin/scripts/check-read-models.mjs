import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RECORD_EVENT_SQL,
  adminRoot,
  captureConsole,
  compileAdminSources,
  createFakePool,
  fakeUuid,
  normalizeSql,
  recordedEvents,
  statements,
} from './lib/check-harness.mjs';

// Date helpers must print UTC whatever the host zone; CI runs in UTC, where a
// helper that forgot timeZone: 'UTC' would still pass.
process.env.TZ = 'America/Los_Angeles';

// Structure-preserving compile: the read models import the audit helpers
// from src/lib/server/audit/, which a flattened emit cannot resolve.
const { load } = compileAdminSources({
  name: 'read-models',
  sources: [
    'src/lib/server/admin-cases.ts',
    'src/lib/server/admin-audit.ts',
    'src/lib/server/admin-lockouts.ts',
    'src/lib/access-history.ts',
    'src/lib/case-aging.ts',
  ],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
  },
});

const cases = await load('src/lib/server/admin-cases.ts');
const audit = await load('src/lib/server/admin-audit.ts');
const lockouts = await load('src/lib/server/admin-lockouts.ts');
const history = await load('src/lib/access-history.ts');
const aging = await load('src/lib/case-aging.ts');

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

// A case with no linked person falls back to the name in its details, masked
// the same way; with no name at all it says so.
const unlinkedCase = (details) => cases.mapAdminCaseRow({
  id: 'case-3', case_type: 'help_request', status: 'open', priority: 50,
  user_id: null, conversation_id: null, employer_id: null, summary: 'Help',
  details, created_at: new Date('2026-06-04T15:00:00Z'),
  updated_at: new Date('2026-06-04T15:00:00Z'), status_changed_at: new Date('2026-06-04T15:00:00Z'),
  assigned_admin_email: null,
  user_name: null, user_phone: null, user_email: null, employer_name: null,
});
assert.equal(unlinkedCase({ subjectName: 'Sample Subject' }).workerName, 'Sample S.');
assert.equal(unlinkedCase({ subjectName: '  ' }).workerName, 'Unknown subject');
assert.equal(unlinkedCase({}).workerName, 'Unknown subject');

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

// The /audit reader of admin_audit_log is gone. The access history reads
// those records through jale_audit.history_search, as legacy rows.
for (const name of ['listAuditEvents', 'mapAuditEventRow', 'AUDIT_PAGE_SIZE']) {
  assert.equal(name in audit, false, `admin-audit no longer exports ${name}`);
}

// --- Access history rows (AUDIT.md "history_search rows") -------------------
const H_ADMIN = '00000000-0000-4000-8000-0000000000d1';
const H_SESSION = '00000000-0000-4000-8000-0000000000d2';
const H_WORKER = '00000000-0000-4000-8000-0000000000a1';
const H_CASE = '00000000-0000-4000-8000-0000000000c1';
const H_REQUEST = '11111111-2222-4333-8444-555555555555';
const H_EVENT = '00000000-0000-4000-8000-0000000000e1';
const H_CHANGE = '00000000-0000-4000-8000-0000000000e2';
const H_LEGACY = '00000000-0000-4000-8000-0000000000e3';

// One history_search row: every column, NULL unless the source fills it.
function historyRow(source, overrides) {
  return {
    source, seq: '1', entry_id: null, occurred_at: null, cursor: null, kind: null, outcome: null,
    actor_kind: null, actor_id: null, actor_role: null, actor_session: null, actor_email: null,
    channel: null, surface: null, categories: null, subject_user_ids: null, record_type: null,
    record_ids: null, result_count: null, field_names: null, purpose_kind: null, purpose_id: null,
    reason: null, link_expires_at: null, part: null, parts: null, table_name: null, operation: null,
    row_count: null, changed_fields: null, context_status: null, action: null, target_type: null,
    target_id: null, summary: null, pii_reveal: null, request_id: null,
    ...overrides,
  };
}

assert.deepEqual(audit.mapHistoryRow(historyRow('event', {
  seq: '41',
  entry_id: H_EVENT,
  occurred_at: new Date('2026-10-01T12:00:00.123Z'),
  cursor: '2026-10-01T12:00:00.123456Z',
  kind: 'read',
  outcome: 'allowed',
  actor_kind: 'admin',
  actor_id: H_ADMIN,
  actor_role: 'admin_ops',
  actor_session: H_SESSION,
  actor_email: 'ops-admin@example.test',
  channel: 'admin',
  surface: 'admin.case_detail.reveal',
  categories: ['contact_details'],
  subject_user_ids: [H_WORKER],
  record_type: 'admin_case',
  record_ids: [H_CASE],
  result_count: 1,
  field_names: ['full_name', 'phone'],
  purpose_kind: 'reveal',
  reason: 'Synthetic callback reason.',
  link_expires_at: new Date('2026-10-01T12:15:00Z'),
  part: 1,
  parts: 2,
  request_id: H_REQUEST,
})), {
  key: `event:${H_EVENT}`,
  source: 'event',
  occurredAt: '2026-10-01T12:00:00.123Z',
  kind: 'read',
  outcome: 'allowed',
  actorKind: 'admin',
  actorId: H_ADMIN,
  actorRole: 'admin_ops',
  actorSession: H_SESSION,
  actorEmail: 'ops-admin@example.test',
  channel: 'admin',
  surface: 'admin.case_detail.reveal',
  categories: ['contact_details'],
  subjectUserIds: [H_WORKER],
  recordType: 'admin_case',
  recordIds: [H_CASE],
  resultCount: 1,
  fieldNames: ['full_name', 'phone'],
  purposeKind: 'reveal',
  reason: 'Synthetic callback reason.',
  linkExpiresAt: '2026-10-01T12:15:00.000Z',
  part: 1,
  parts: 2,
  changedFields: [],
  piiReveal: false,
  requestId: H_REQUEST,
}, 'an event row keeps every recorded field; NULL columns are left out');

assert.deepEqual(audit.mapHistoryRow(historyRow('change', {
  seq: '7',
  entry_id: H_CHANGE,
  occurred_at: new Date('2026-10-01T11:00:00Z'),
  cursor: '2026-10-01T11:00:00.000000Z',
  actor_kind: 'admin',
  actor_id: H_ADMIN,
  actor_email: 'ops-admin@example.test',
  channel: 'admin',
  surface: 'admin.case_detail.resolve_case',
  subject_user_ids: [H_WORKER],
  record_ids: [H_CASE],
  table_name: 'admin_cases',
  operation: 'UPDATE',
  row_count: 1,
  changed_fields: ['status', 'resolved_at'],
  context_status: 'ok',
  request_id: H_REQUEST,
})), {
  key: `change:${H_CHANGE}`,
  source: 'change',
  occurredAt: '2026-10-01T11:00:00.000Z',
  actorKind: 'admin',
  actorId: H_ADMIN,
  actorEmail: 'ops-admin@example.test',
  channel: 'admin',
  surface: 'admin.case_detail.resolve_case',
  categories: [],
  subjectUserIds: [H_WORKER],
  recordIds: [H_CASE],
  fieldNames: [],
  tableName: 'admin_cases',
  operation: 'UPDATE',
  rowCount: 1,
  changedFields: ['status', 'resolved_at'],
  contextStatus: 'ok',
  piiReveal: false,
  requestId: H_REQUEST,
}, 'a change row keeps its table, operation and changed fields');

assert.deepEqual(audit.mapHistoryRow(historyRow('legacy', {
  seq: '3',
  entry_id: H_LEGACY,
  occurred_at: '2026-09-01T09:00:00Z',
  cursor: '2026-09-01T09:00:00.000000Z',
  actor_kind: 'admin',
  actor_role: 'admin_ops',
  actor_email: 'ops-admin@example.test',
  reason: 'Called [removed] about the case.',
  action: 'reveal_pii',
  target_type: 'admin_case',
  target_id: H_CASE,
  summary: 'admin_ops requested reveal_pii for admin_case.',
  pii_reveal: true,
})), {
  key: `legacy:${H_LEGACY}`,
  source: 'legacy',
  occurredAt: '2026-09-01T09:00:00.000Z',
  actorKind: 'admin',
  actorRole: 'admin_ops',
  actorEmail: 'ops-admin@example.test',
  categories: [],
  subjectUserIds: [],
  recordIds: [],
  fieldNames: [],
  reason: 'Called [removed] about the case.',
  changedFields: [],
  action: 'reveal_pii',
  targetType: 'admin_case',
  targetId: H_CASE,
  summary: 'admin_ops requested reveal_pii for admin_case.',
  piiReveal: true,
}, 'a legacy row keeps the frozen action record fields');

assert.throws(
  () => audit.mapHistoryRow(historyRow('event', { entry_id: H_EVENT, occurred_at: new Date(), record_ids: `{${H_CASE}}` })),
  /access history: unexpected list/,
  'a list column that is not an array fails loudly instead of rendering wrong ids',
);
assert.throws(
  () => audit.mapHistoryRow(historyRow('elsewhere', { entry_id: H_EVENT, occurred_at: new Date() })),
  /access history: unexpected source/,
);

// --- Access history filters (URL search params) -------------------------
const H_ACTOR = '00000000-0000-4000-8000-0000000000d3';
const UPPER_WORKER = H_WORKER.toUpperCase();
const fullQuery = history.parseAccessHistoryQuery({
  subject: `  ${UPPER_WORKER}  `,
  actor: H_ACTOR,
  record: H_CASE,
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00+02:00',
  category: 'contact_details',
  outcome: 'denied',
  before: '2026-10-01T12:00:00.123456Z',
  unrelated: 'ignored',
});
assert.deepEqual(fullQuery, {
  filter: {
    subjectUserId: H_WORKER,
    actorId: H_ACTOR,
    recordId: H_CASE,
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00+02:00',
    category: 'contact_details',
    outcome: 'denied',
  },
  before: '2026-10-01T12:00:00.123456Z',
  problems: [],
  values: {
    subject: UPPER_WORKER,
    actor: H_ACTOR,
    record: H_CASE,
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00+02:00',
    category: 'contact_details',
    outcome: 'denied',
  },
});
assert.deepEqual(history.parseAccessHistoryQuery({}), { filter: {}, problems: [], values: {} });
assert.deepEqual(history.parseAccessHistoryQuery({ subject: '   ', category: '' }), { filter: {}, problems: [], values: {} },
  'an empty field is no filter');

const badQuery = history.parseAccessHistoryQuery({
  subject: 'not-an-id',
  actor: `${H_ACTOR}x`,
  record: '12345',
  from: '2026-10-01T00:00',
  to: '2026-02-30T00:00:00Z',
  category: 'everything',
  outcome: ['denied', 'failed'],
  before: '2026-10-01T12:00:00.123Z',
});
assert.deepEqual(badQuery.problems, ['subject', 'actor', 'record', 'from', 'to', 'category', 'outcome', 'before']);
assert.deepEqual(badQuery.filter, {});
assert.equal('before' in badQuery, false);
assert.equal(badQuery.values.subject, 'not-an-id', 'the form shows what was typed');
assert.equal(badQuery.values.outcome, undefined, 'a repeated parameter is refused, not guessed');
assert.equal(history.parseAccessHistoryQuery({ subject: 'x'.repeat(5000) }).values.subject.length, 200, 'echoed values are capped');

assert.deepEqual(history.parseAccessHistoryQuery({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }).problems, ['range']);
assert.deepEqual(history.parseAccessHistoryQuery({ from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }).problems, ['range'],
  'from is inclusive and to exclusive, so equal ends match nothing');

// The ends are compared to the microsecond, as history_search compares them:
// a range shorter than a millisecond is a real range, and the zone and the
// number of fraction digits never change which end comes first.
const rangeProblems = (from, to) => history.parseAccessHistoryQuery({ from, to }).problems;
for (const [from, to, label] of [
  ['2026-10-01T12:00:00.123001Z', '2026-10-01T12:00:00.123999Z', 'within one millisecond'],
  ['2026-10-01T12:00:00.5Z', '2026-10-01T12:00:00.500001Z', 'one microsecond apart, fractions of different lengths'],
  ['2026-10-01T14:00:00.000001+02:00', '2026-10-01T12:00:00.000002Z', 'one microsecond apart, in different zones'],
  ['2026-10-01T12:00:00.999999Z', '2026-10-01T12:00:01Z', 'across a second'],
  ['9999-12-31T23:59:59.999998Z', '9999-12-31T23:59:59.999999Z', 'one microsecond apart, at the end of the calendar'],
]) {
  assert.deepEqual(rangeProblems(from, to), [], `${label}: a range`);
  assert.deepEqual(rangeProblems(to, from), ['range'], `${label}, reversed: refused`);
}
for (const [from, to, label] of [
  ['2026-10-01T12:00:00.5Z', '2026-10-01T12:00:00.500000Z', 'the same instant written two ways'],
  ['2026-10-01T14:00:00.123456+02:00', '2026-10-01T12:00:00.123456Z', 'the same instant in two zones'],
]) {
  assert.deepEqual(rangeProblems(from, to), ['range'], `${label}: equal ends match nothing`);
}

// Instants must carry seconds and a zone, exactly as history_search accepts them.
for (const value of [
  '2026-10-01T00:00:00Z',
  '2026-10-01T00:00:00.123456+05:30',
  '2026-10-01T23:59:59.5-03:00',
  '2028-02-29T00:00:00Z',
]) {
  assert.equal(history.isAuditInstant(value), true, `${value} is an instant`);
}
for (const value of [
  '2026-10-01T00:00Z',
  '2026-10-01 00:00:00Z',
  '2026-10-01T00:00:00',
  '2026-13-01T00:00:00Z',
  '2026-02-29T00:00:00Z',
  '2026-04-31T00:00:00Z',
  '0000-01-01T00:00:00Z',
  '2026-10-01T24:00:00Z',
  '2026-10-01T00:00:00+16:00',
  '2026-10-01T00:00:00.1234567Z',
]) {
  assert.equal(history.isAuditInstant(value), false, `${value} is refused`);
}
assert.equal(history.isHistoryCursor('2026-10-01T12:00:00.123456Z'), true);
assert.equal(history.isHistoryCursor('2026-10-01T12:00:00.123Z'), false, 'a cursor keeps its microseconds');
assert.equal(history.isHistoryCursor('2026-10-01T12:00:00.123456+00:00'), false, 'a cursor is UTC text, as the page wrote it');

assert.equal(history.accessHistoryHref({}), '/access-history');
assert.equal(history.accessHistoryHref({ subjectUserId: H_WORKER }), `/access-history?subject=${H_WORKER}`);
const fullHref = history.accessHistoryHref(fullQuery.filter, fullQuery.before);
assert.equal(
  fullHref,
  `/access-history?subject=${H_WORKER}&actor=${H_ACTOR}&record=${H_CASE}`
    + '&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-02T00%3A00%3A00%2B02%3A00'
    + '&category=contact_details&outcome=denied&before=2026-10-01T12%3A00%3A00.123456Z',
);
const roundTrip = history.parseAccessHistoryQuery(Object.fromEntries(new URL(fullHref, 'https://admin.example.test').searchParams));
assert.deepEqual([roundTrip.filter, roundTrip.before], [fullQuery.filter, fullQuery.before], 'a link reproduces its search');

// Verify list function return shapes export { rows, totalCount } (truncation
// disclosure feature). These are compile-time checks via the TS typecheck
// above; the runtime assertions below guard against regressions in the shape.
assert.ok('ADMIN_CASES_PAGE_SIZE' in cases, 'cases module should export ADMIN_CASES_PAGE_SIZE');

// Confirm the list functions exist and have the correct signature (no DB call
// is made here; the DB-connect path is guarded by getAdminDbPool).
assert.equal(typeof cases.listAdminCaseRows, 'function');
assert.equal(typeof cases.loadCasesList, 'function');
assert.equal(typeof audit.loadAccessHistory, 'function');

// Roadmap 1b: dashboard tiles count with their own queries; the reveal
// tile reads the access records (jale_audit.reveal_count). Roadmap 2d: the
// Open cases tile reads its total from the by-wait counts, so the bare count is gone.
assert.equal(typeof cases.countOpenCasesByWait, 'function');
assert.equal(cases.countOpenAdminCases, undefined, 'countOpenCasesByWait replaced countOpenAdminCases');
assert.equal(typeof cases.listOpenAdminCaseRows, 'function');
assert.equal(typeof cases.loadAdminDashboard, 'function');
assert.equal(typeof audit.countRecentReveals, 'function');
assert.equal(audit.REVEAL_TILE_DAYS, 7);

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
assert.equal(typeof lockouts.loadLockouts, 'function');

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
const casesSource = readFileSync(resolve(adminRoot, 'src/lib/server/admin-cases.ts'), 'utf8');
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
  1,
  'the one shared select reads status_changed_at',
);
assert.match(
  casesSource,
  /getAdminCaseRow\(client: QueryClient, id: string\)[\s\S]*?`\$\{CASE_LIST_SELECT\}\s*WHERE c\.id = \$1/,
  'the case page reads through the shared select, so it reads status_changed_at too',
);
assert.match(
  casesSource,
  /WHERE \$\{OPEN_CASE_FILTER\}\s*\$\{CASE_QUEUE_ORDER\}\s*LIMIT \$1/,
  'the Home preview lists open cases only',
);
assert.match(casesSource, /client\.query<OpenCasesByWaitRow>\(OPEN_CASES_BY_WAIT_SQL\)/, 'the Home counts run the pinned query');

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

// ---------------------------------------------------------------------------
// The Reports inbox read models (src/lib/server/admin-reports.ts).
//
// They read through the jale_cap console functions inside
// withAdminReadTransaction and record the access event before COMMIT. The
// module imports the nested audit helpers, so it is compiled with the shared
// harness (a fake pool and a fake Logs client) instead of the flat emit above.
// ---------------------------------------------------------------------------
const reportsBuild = compileAdminSources({
  name: 'read-models-reports',
  sources: ['src/lib/server/admin-reports.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
  },
});
const reports = await reportsBuild.load('src/lib/server/admin-reports.ts');
const reportCheck = (globalThis.__adminCheck ??= {});

const REPORTS_ADMIN_ID = fakeUuid(0xc1);
const REPORTS_SESSION_ID = fakeUuid(0xc2);
const REPORTS_REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const reportsSession = {
  sub: 'check-reports-sub',
  email: 'reports-admin@example.test',
  role: 'admin_readonly',
  groups: ['admin_readonly'],
  sessionId: REPORTS_SESSION_ID,
  adminUserId: REPORTS_ADMIN_ID,
  requestId: REPORTS_REQUEST_ID,
};
const reportsActor = {
  actor_kind: 'admin',
  actor_id: REPORTS_ADMIN_ID,
  actor_role: 'admin_readonly',
  actor_session: REPORTS_SESSION_ID,
  channel: 'admin',
};

const INBOX_SQL = normalizeSql(`
  SELECT i.report_id, i.report_number, i.role, i.verified, i.category, i.stops_work, i.status,
         i.has_image, i.created_at, i.content_erased,
         to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor
    FROM jale_cap.problem_report_inbox($1::text, $2::text, $3::text, $4::boolean, $5::bigint, $6::integer, $7::timestamptz)
         WITH ORDINALITY AS i
   ORDER BY i.ordinality
`);
const DETAIL_SQL = normalizeSql(`
  SELECT report_id, report_number, role, verified, category, stops_work, locale, include_technical,
         status, has_image, created_at, updated_at, status_changed_at, content_erased,
         description, context, internal_note, contact_kind, contact_masked,
         account_user_id, account_exists, image_available
    FROM jale_cap.problem_report_detail($1::uuid)
`);
const COUNTS_SQL = normalizeSql('SELECT new_count, open_count FROM jale_cap.problem_report_counts()');
const SETTINGS_SQL = normalizeSql(`
  SELECT reporting_enabled, signed_out_enabled, screenshots_enabled, team_email_enabled,
         signed_out_daily_cap, team_recipient, admin_base_url, updated_at
    FROM jale_cap.problem_report_settings_get()
`);

assert.equal(normalizeSql(reports.INBOX_SQL), INBOX_SQL, 'the inbox SQL keeps the function order and a microsecond cursor');
assert.equal(normalizeSql(reports.DETAIL_SQL), DETAIL_SQL);
assert.equal(normalizeSql(reports.COUNTS_SQL), COUNTS_SQL);
assert.equal(normalizeSql(reports.SETTINGS_SQL), SETTINGS_SQL);
assert.equal(reports.REPORTS_PAGE_SIZE, 50);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_TIME = Date.UTC(2026, 9, 2, 12, 0, 0);

function inboxRow(n, overrides = {}) {
  const createdAt = new Date(BASE_TIME - n * 60_000);
  return {
    report_id: fakeUuid(0x5000 + n),
    report_number: String(1000 + n),
    role: 'worker',
    verified: true,
    category: 'applying',
    stops_work: null,
    status: 'new',
    has_image: false,
    created_at: createdAt,
    content_erased: false,
    // node-postgres gives a millisecond Date; the cursor keeps microseconds.
    created_cursor: createdAt.toISOString().replace('Z', '456Z'),
    ...overrides,
  };
}

function emfOrJsonLines(lines) {
  return [...lines.log, ...lines.error]
    .filter((args) => args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{'))
    .map((args) => JSON.parse(args[0]));
}

// --- Filters from searchParams ----------------------------------------------
{
  const filters = reports.parseInboxFilters({
    status: 'looking',
    role: ['employer', 'worker'],
    category: 'billing',
    verified: 'no',
    number: ' JR-1042 ',
    before: '2026-10-02T11:59:00.000456Z',
  });
  assert.deepEqual(filters, {
    status: 'looking',
    role: 'employer',
    category: 'billing',
    verified: false,
    number: 1042,
    numberInput: 'JR-1042',
    numberInvalid: false,
    before: '2026-10-02T11:59:00.000456Z',
  });
  assert.equal(
    reports.inboxHref(filters, { before: '2026-10-02T11:00:00.000001Z' }),
    '/reports?status=looking&role=employer&category=billing&verified=no&number=1042&before=2026-10-02T11%3A00%3A00.000001Z',
  );
  assert.equal(reports.inboxHref(filters, { before: null }), '/reports?status=looking&role=employer&category=billing&verified=no&number=1042');

  assert.deepEqual(reports.parseInboxFilters({}), {
    status: null,
    role: null,
    category: null,
    verified: null,
    number: null,
    numberInput: '',
    numberInvalid: false,
    before: null,
  });
  assert.equal(reports.inboxHref(reports.parseInboxFilters({}), {}), '/reports');

  const junk = reports.parseInboxFilters({
    status: 'closed',
    role: 'admin',
    category: 'bugs',
    verified: 'maybe',
    number: 'JR-10a2',
    before: '2026-10-02 11:59',
  });
  assert.deepEqual(
    { ...junk },
    { status: null, role: null, category: null, verified: null, number: null, numberInput: 'JR-10a2', numberInvalid: true, before: null },
    'values outside the code lists are ignored; a bad number is flagged',
  );
  assert.equal(reports.parseInboxFilters({ verified: 'yes' }).verified, true);
  assert.equal(reports.parseInboxFilters({ number: '1042' }).number, 1042);
  assert.equal(reports.parseInboxFilters({ number: 'x'.repeat(200) }).numberInput.length <= 40, true, 'the echoed number input is bounded');
}

// --- List: BEGIN -> inbox -> access event -> COMMIT -> return ----------------
{
  const rows = [inboxRow(1), inboxRow(2, { role: 'employer', category: 'billing', stops_work: true, verified: false, status: 'looking' }), inboxRow(3, { content_erased: true, status: 'fixed' })];
  const { pool, log } = createFakePool({
    respond: async ({ sql, log: entries }) => {
      if (sql === INBOX_SQL) return { rows };
      if (sql === 'COMMIT') {
        await delay(5);
        entries.push({ connection: 1, op: 'commit_completed' });
      }
      return {};
    },
  });
  reportCheck.pool = pool;
  const filters = reports.parseInboxFilters({ status: 'new', verified: 'yes', number: 'JR-1001' });
  const page = await reports.listProblemReports(reportsSession, filters);
  log.push({ connection: '-', op: 'returned' });

  assert.deepEqual(statements(log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${INBOX_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: <commit_completed>',
    '1: <release>',
    '-: <returned>',
  ], 'the list is recorded before COMMIT and returned only after it');
  assert.deepEqual(log.find((entry) => entry.sql === INBOX_SQL).params, ['new', null, null, true, 1001, 51, null]);

  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...reportsActor,
    surface: 'admin.reports_list',
    categories: ['problem_reports'],
    subject_user_ids: [],
    record_type: 'problem_report',
    record_ids: rows.map((row) => row.report_id),
    result_count: 3,
    field_names: [],
    request_id: REPORTS_REQUEST_ID,
  }]);

  assert.equal(page.nextBefore, null, 'fewer rows than a page: no next page');
  assert.deepEqual(page.rows.map((row) => row.id), rows.map((row) => row.report_id));
  assert.deepEqual(page.rows[1], {
    id: rows[1].report_id,
    number: 1002,
    numberLabel: 'JR-1002',
    role: 'employer',
    roleLabel: 'Employer',
    verified: false,
    category: 'billing',
    categoryLabel: 'Billing and plan',
    stopsWork: true,
    status: 'looking',
    statusLabel: 'Looking',
    hasImage: false,
    createdAt: new Date(BASE_TIME - 2 * 60_000).toISOString(),
    contentErased: false,
  });
  assert.equal(page.rows[2].contentErased, true);
  assert.equal('created_cursor' in page.rows[0] || 'cursor' in page.rows[0], false, 'rows carry no cursor; the page does');
}

// A full page: 51 rows read, 50 shown, exactly the 50 shown are recorded,
// and the next-page cursor is the last shown row's microsecond time.
{
  const rows = Array.from({ length: 51 }, (_, i) => inboxRow(i + 1));
  const { pool, log } = createFakePool({ respond: ({ sql }) => (sql === INBOX_SQL ? { rows } : {}) });
  reportCheck.pool = pool;
  const page = await reports.listProblemReports(reportsSession, reports.parseInboxFilters({ before: '2026-10-02T12:30:00.000001Z' }));
  assert.equal(page.rows.length, 50);
  const [event] = recordedEvents(log);
  assert.deepEqual(event.record_ids, rows.slice(0, 50).map((row) => row.report_id), 'the event names exactly the ids shown');
  assert.equal(event.result_count, 50);
  assert.equal(event.record_ids.includes(rows[50].report_id), false, 'the look-ahead row is never recorded');
  assert.equal(page.nextBefore, rows[49].created_cursor);
  assert.deepEqual(log.find((entry) => entry.sql === INBOX_SQL).params.slice(5), [51, '2026-10-02T12:30:00.000001Z']);
}

// An empty page is still a recorded view of the list.
{
  const { pool, log } = createFakePool();
  reportCheck.pool = pool;
  const page = await reports.listProblemReports(reportsSession, reports.parseInboxFilters({}));
  assert.deepEqual(page, { rows: [], nextBefore: null });
  const [event] = recordedEvents(log);
  assert.deepEqual([event.surface, event.record_ids, event.result_count], ['admin.reports_list', [], 0]);
}

// A failed event write rolls the read back; nothing is returned, and a
// 'failed' attempt is recorded on its own connection after the release.
{
  let failed = false;
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (sql === INBOX_SQL) return { rows: [inboxRow(1)] };
      if (sql === RECORD_EVENT_SQL && !failed) {
        failed = true;
        throw Object.assign(new Error('record_event: terminating connection due to administrator command'), { code: '57P01' });
      }
      return {};
    },
  });
  reportCheck.pool = pool;
  const { lines } = await captureConsole(async () => {
    await assert.rejects(
      () => reports.listProblemReports(reportsSession, reports.parseInboxFilters({})),
      (error) => !/terminating connection/.test(String(error?.message)),
      'the page fails without the database text',
    );
  });
  assert.deepEqual(statements(log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${INBOX_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: ROLLBACK',
    '1: <release>',
    '2: <connect>',
    '2: BEGIN',
    `2: ${RECORD_EVENT_SQL}`,
    '2: COMMIT',
    '2: <release>',
  ]);
  const [, attempt] = recordedEvents(log);
  assert.deepEqual(attempt, {
    kind: 'attempt',
    outcome: 'failed',
    ...reportsActor,
    surface: 'admin.reports_list',
    categories: ['problem_reports'],
    subject_user_ids: [],
    record_ids: [],
    result_count: 0,
    field_names: [],
    request_id: REPORTS_REQUEST_ID,
  });
  assert.doesNotMatch(JSON.stringify(lines), /terminating connection/, 'no database text is logged');
  const failure = emfOrJsonLines(lines).find((line) => line.event === 'report_read_failed');
  assert.deepEqual(failure, { event: 'report_read_failed', surface: 'admin.reports_list', code: '57P01', request_id: REPORTS_REQUEST_ID });
}

// A failed read (the stub raises 0A000 today) rolls back the same way.
{
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (sql === INBOX_SQL) throw Object.assign(new Error('jale_cap.problem_report_inbox is not implemented yet'), { code: '0A000' });
      return {};
    },
  });
  reportCheck.pool = pool;
  await captureConsole(async () => {
    await assert.rejects(() => reports.listProblemReports(reportsSession, reports.parseInboxFilters({})));
  });
  assert.deepEqual(statements(log).slice(0, 5), ['1: <connect>', '1: BEGIN', `1: ${INBOX_SQL}`, '1: ROLLBACK', '1: <release>']);
  assert.deepEqual(recordedEvents(log).map((event) => [event.kind, event.outcome, event.surface]), [['attempt', 'failed', 'admin.reports_list']]);
}

// An unexpected code from the database renders nothing.
{
  const { pool, log } = createFakePool({ respond: ({ sql }) => (sql === INBOX_SQL ? { rows: [inboxRow(1, { status: 'closed' })] } : {}) });
  reportCheck.pool = pool;
  await captureConsole(async () => {
    await assert.rejects(() => reports.listProblemReports(reportsSession, reports.parseInboxFilters({})));
  });
  assert.equal(recordedEvents(log).filter((event) => event.kind === 'read').length, 0);
  assert.ok(statements(log).includes('1: ROLLBACK'));
}

// --- Detail ------------------------------------------------------------------
const REPORT_ID = fakeUuid(0x7001);
const ACCOUNT_ID = fakeUuid(0x7002);

function detailRow(overrides = {}) {
  return {
    report_id: REPORT_ID,
    report_number: '1042',
    role: 'worker',
    verified: true,
    category: 'applying',
    stops_work: null,
    locale: 'es',
    include_technical: true,
    status: 'new',
    has_image: true,
    created_at: new Date(BASE_TIME - 9 * 60_000),
    updated_at: new Date(BASE_TIME - 9 * 60_000),
    status_changed_at: null,
    content_erased: false,
    description: 'Toque Aplicar y la pantalla se quedo cargando.\nNo se envio.',
    context: {
      v: 1,
      screen: { pattern: '/worker/jobs/:id', refs: { id: fakeUuid(0x7003) } },
      screens: ['/worker/home', '/worker/jobs/:id'],
      app: { build: '0123456789ab', locale: 'es', theme: 'light' },
      device: {
        kind: 'phone',
        browser: 'Safari',
        os: 'iOS',
        viewport: [390, 844],
        online: true,
        tz: 'America/Chicago',
        local_time: '2026-10-02T06:51:00-05:00',
      },
      requests: [
        { m: 'POST', p: '/worker/jobs/:id/apply', s: 500, ms: 2100, rid: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' },
        { m: 'GET', p: '/worker/jobs/:id', s: 200, ms: 300, rid: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' },
      ],
      errors: [{ k: 'api', msg: 'Application not sent', at: '2026-10-02T11:51:00.000Z' }],
      capture: { outcome: 'ok', ms: 820 },
    },
    internal_note: null,
    contact_kind: 'account',
    contact_masked: '+1 512 *** 7821',
    account_user_id: ACCOUNT_ID,
    account_exists: true,
    image_available: true,
    ...overrides,
  };
}

{
  const { pool, log } = createFakePool({
    respond: async ({ sql, log: entries }) => {
      if (sql === DETAIL_SQL) return { rows: [detailRow()] };
      if (sql === 'COMMIT') {
        await delay(5);
        entries.push({ connection: 1, op: 'commit_completed' });
      }
      return {};
    },
  });
  reportCheck.pool = pool;
  const detail = await reports.getProblemReport(reportsSession, REPORT_ID.toUpperCase());
  log.push({ connection: '-', op: 'returned' });
  assert.deepEqual(statements(log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${DETAIL_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: <commit_completed>',
    '1: <release>',
    '-: <returned>',
  ], 'the detail is recorded before COMMIT and returned only after it');
  assert.deepEqual(log.find((entry) => entry.sql === DETAIL_SQL).params, [REPORT_ID], 'the id is normalised');
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...reportsActor,
    surface: 'admin.report_detail',
    categories: ['problem_reports'],
    subject_user_ids: [ACCOUNT_ID],
    record_type: 'problem_report',
    record_ids: [REPORT_ID],
    result_count: 1,
    field_names: ['description', 'context', 'contact_masked', 'internal_note'],
    request_id: REPORTS_REQUEST_ID,
  }]);

  assert.equal(detail.numberLabel, 'JR-1042');
  assert.equal(detail.categoryLabel, 'Applying to a job');
  assert.equal(detail.description, 'Toque Aplicar y la pantalla se quedo cargando.\nNo se envio.');
  assert.equal(detail.contactKind, 'account');
  assert.equal(detail.contactMasked, '+1 512 *** 7821', 'the contact comes masked from SQL and is shown as given');
  assert.equal(detail.accountUserId, ACCOUNT_ID);
  assert.equal(detail.imageAvailable, true);
  assert.deepEqual(detail.context.screen, { pattern: '/worker/jobs/:id', refs: [{ name: 'id', id: fakeUuid(0x7003) }] });
  assert.deepEqual(detail.context.requests[0], {
    method: 'POST',
    pattern: '/worker/jobs/:id/apply',
    status: 500,
    ms: 2100,
    requestId: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
  });
  assert.deepEqual(detail.context.errors, [{ kind: 'api', message: 'Application not sent', at: '2026-10-02T11:51:00.000Z' }]);
  assert.deepEqual(detail.context.device.viewport, [390, 844]);
}

// No such report: rolled back, a not_found attempt after the release, null.
{
  const { pool, log } = createFakePool();
  reportCheck.pool = pool;
  const detail = await reports.getProblemReport(reportsSession, REPORT_ID);
  assert.equal(detail, null);
  assert.deepEqual(statements(log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${DETAIL_SQL}`,
    '1: ROLLBACK',
    '1: <release>',
    '2: <connect>',
    '2: BEGIN',
    `2: ${RECORD_EVENT_SQL}`,
    '2: COMMIT',
    '2: <release>',
  ]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'attempt',
    outcome: 'not_found',
    ...reportsActor,
    surface: 'admin.report_detail',
    categories: ['problem_reports'],
    subject_user_ids: [],
    record_type: 'problem_report',
    record_ids: [REPORT_ID],
    result_count: 1,
    field_names: [],
    request_id: REPORTS_REQUEST_ID,
  }]);
}

// A malformed id never reaches SQL; its attempt names no record.
{
  const { pool, log } = createFakePool();
  reportCheck.pool = pool;
  assert.equal(await reports.getProblemReport(reportsSession, 'JR-1042'), null);
  assert.deepEqual(statements(log), ['1: <connect>', '1: BEGIN', `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.surface, attempt.record_ids], ['attempt', 'not_found', 'admin.report_detail', []]);
}

// Erased content: nothing personal is shown, so no content field is recorded.
{
  const { pool, log } = createFakePool({
    respond: ({ sql }) => (sql === DETAIL_SQL
      ? {
          rows: [detailRow({
            content_erased: true,
            description: null,
            context: null,
            internal_note: null,
            contact_kind: 'none',
            contact_masked: null,
            account_user_id: null,
            account_exists: false,
            image_available: false,
          })],
        }
      : {}),
  });
  reportCheck.pool = pool;
  const detail = await reports.getProblemReport(reportsSession, REPORT_ID);
  assert.equal(detail.contentErased, true);
  assert.equal(detail.description, null);
  assert.equal(detail.context, null);
  assert.equal(detail.contactKind, 'none');
  const [event] = recordedEvents(log);
  assert.deepEqual([event.subject_user_ids, event.field_names, event.record_ids], [[], [], [REPORT_ID]]);
}

// A failed event write: rolled back, a failed attempt, nothing returned.
{
  let failed = false;
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (sql === DETAIL_SQL) return { rows: [detailRow()] };
      if (sql === RECORD_EVENT_SQL && !failed) {
        failed = true;
        throw new Error('record_event failed');
      }
      return {};
    },
  });
  reportCheck.pool = pool;
  await captureConsole(async () => {
    await assert.rejects(() => reports.getProblemReport(reportsSession, REPORT_ID));
  });
  assert.deepEqual(statements(log).slice(0, 6), ['1: <connect>', '1: BEGIN', `1: ${DETAIL_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: ROLLBACK', '1: <release>']);
  const attempts = recordedEvents(log).filter((event) => event.kind === 'attempt');
  assert.deepEqual(attempts.map((event) => [event.outcome, event.surface, event.record_ids]), [['failed', 'admin.report_detail', [REPORT_ID]]]);
}

// Typed contact on an unverified report, and a context that is not the
// expected shape: values are type-checked, bounded and never trusted.
{
  const typed = reports.mapReportDetailRow(detailRow({
    verified: false,
    contact_kind: 'typed',
    contact_masked: 'a***@example.test',
    account_user_id: null,
    account_exists: false,
    context: {
      v: 1,
      surprise: 'dropped',
      screen: { pattern: 42, refs: { id: 'not-a-uuid', job: fakeUuid(0x7004), 'Bad Key': fakeUuid(0x7005) } },
      screens: ['/a', '/b', '/c', '/d', '/e', '/f', 7],
      app: { build: 'x'.repeat(500) },
      device: { kind: 'phone', viewport: [390, 'tall'], online: 'yes' },
      requests: Array.from({ length: 25 }, (_, i) => ({ m: 'GET', p: `/r/${i}`, s: 200, ms: i, rid: i === 0 ? 'bad id with spaces' : `rid-${i}` })),
      errors: Array.from({ length: 12 }, (_, i) => ({ k: 'error', msg: `e${i}`.padEnd(300, '.'), at: 'not a time' })),
      capture: { outcome: 'exploded', ms: -5 },
    },
  }));
  assert.equal(typed.contactKind, 'typed');
  assert.equal(typed.accountUserId, null);
  assert.equal(typed.context.screen.pattern, null, 'a non-string pattern is dropped');
  assert.deepEqual(typed.context.screen.refs, [{ name: 'job', id: fakeUuid(0x7004) }], 'only well-named UUID refs survive');
  assert.deepEqual(typed.context.screens, ['/a', '/b', '/c', '/d', '/e'], 'at most five screens, strings only');
  assert.ok(typed.context.app.build.length <= 64, 'strings are bounded');
  assert.equal(typed.context.device.viewport, null);
  assert.equal(typed.context.device.online, null);
  assert.equal(typed.context.requests.length, 20, 'at most twenty requests');
  assert.equal(typed.context.requests[0].requestId, null, 'a malformed request id is dropped');
  assert.equal(typed.context.requests[1].requestId, 'rid-1');
  assert.equal(typed.context.errors.length, 10, 'at most ten errors');
  assert.ok(typed.context.errors.every((error) => error.message.length <= 200 && error.at === null));
  assert.equal(typed.context.capture, null, 'an unknown capture outcome is dropped');
  assert.equal(JSON.stringify(typed.context).includes('surprise'), false, 'unknown keys are dropped');

  assert.equal(reports.mapReportDetailRow(detailRow({ context: 'not an object' })).context, null);
  assert.throws(() => reports.mapReportDetailRow(detailRow({ role: 'admin' })), /Unexpected report role/);
  assert.throws(() => reports.mapReportDetailRow(detailRow({ contact_kind: 'raw' })), /Unexpected contact kind/);
  assert.throws(() => reports.mapReportDetailRow(detailRow({ category: 'bugs' })), /Unexpected report category/);
}

// --- Copy summary: number, category, role, verified, screen, build, device
// kind and the failing requests. Never the words, the contact or the note.
{
  assert.deepEqual(
    Object.keys(reports.reportSummaryInput(reports.mapReportDetailRow(detailRow()))).sort(),
    ['build', 'category', 'deviceKind', 'failingRequests', 'number', 'role', 'screenPattern', 'verified'],
    'the summary input is an explicit allowlist',
  );
  const summary = reports.buildReportSummary(reports.reportSummaryInput(reports.mapReportDetailRow(detailRow())));
  assert.equal(summary, [
    'JR-1042 · Applying to a job',
    'Worker · Verified',
    'Screen: /worker/jobs/:id',
    'Build: 0123456789ab',
    'Device: phone',
    'Failing requests:',
    '- POST /worker/jobs/:id/apply · 500 · request id 0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e',
  ].join('\n'));

  // Status 0 means no response was observed (a network failure, an abort or
  // a beacon): it reads "no response", never a status code, and it is not a
  // server failure. A 4xx is listed with its code.
  const mixed = reports.mapReportDetailRow(detailRow({
    role: 'employer',
    verified: false,
    category: 'billing',
    stops_work: true,
    context: {
      v: 1,
      screen: {},
      requests: [
        { m: 'GET', p: '/employer/billing', s: 0, ms: 15000 },
        { m: 'POST', p: '/employer/billing/checkout', s: 409, ms: 120, rid: 'req-409' },
        { m: 'GET', p: '/employer/jobs', s: 200, ms: 80, rid: 'req-200' },
        { m: 'GET', p: '/employer/profile', s: 'n/a', ms: 80, rid: 'req-unknown' },
      ],
    },
  }));
  assert.deepEqual(mixed.context.requests.map((request) => request.status), [0, 409, 200, null]);
  assert.deepEqual(mixed.context.requests.map((request) => reports.requestStatusText(request.status)), ['no response', '409', '200', 'unknown']);
  assert.deepEqual(mixed.context.requests.map((request) => reports.requestOutcome(request.status)), ['no_response', 'client_error', 'ok', 'unknown']);
  assert.equal(reports.requestOutcome(500), 'server_error');
  assert.equal(reports.requestOutcome(503), 'server_error');
  assert.equal(reports.requestOutcome(301), 'ok');
  assert.equal(reports.buildReportSummary(reports.reportSummaryInput(mixed)), [
    'JR-1042 · Billing and plan',
    'Employer · Unverified',
    'Screen: not recorded',
    'Build: not recorded',
    'Device: not recorded',
    'Failing requests:',
    '- GET /employer/billing · no response',
    '- POST /employer/billing/checkout · 409 · request id req-409',
  ].join('\n'));
  const quiet = reports.mapReportDetailRow(detailRow({ context: { v: 1, requests: [{ m: 'GET', p: '/worker/home', s: 200, ms: 10 }] } }));
  assert.ok(reports.buildReportSummary(reports.reportSummaryInput(quiet)).endsWith('Failing requests: none'));

  // Property test: seeded random tokens in every personal or free-text field
  // never reach the summary.
  let seed = 0x5eed1042;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const token = (label) => {
    let value = label;
    for (let i = 0; i < 14; i += 1) value += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)];
    return value;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const workerCategories = ['sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other'];
  const employerCategories = ['account', 'job_posting', 'applicants', 'messages', 'billing', 'emails', 'company_profile', 'other'];

  for (let run = 0; run < 300; run += 1) {
    const role = pick(['worker', 'employer', 'unknown']);
    const secrets = {
      words: [token('zw'), token('zw')],
      contact: token('zc'),
      note: token('zn'),
      error: token('ze'),
      browser: token('zb'),
      os: token('zo'),
      tz: token('zt'),
      okRid: token('zr'),
      screenVisited: `/${token('zs')}`,
    };
    const ref = fakeUuid(0x9000 + run);
    const failingRid = `${token('f')}`.slice(0, 30);
    const detail = reports.mapReportDetailRow(detailRow({
      report_number: String(1000 + run),
      role,
      verified: role !== 'unknown' && random() > 0.5,
      category: pick(role === 'employer' ? employerCategories : workerCategories),
      stops_work: role === 'employer' ? random() > 0.5 : null,
      description: `${secrets.words[0]} ${secrets.words[1]}`,
      internal_note: secrets.note,
      contact_kind: pick(['account', 'typed']),
      contact_masked: secrets.contact,
      context: {
        v: 1,
        screen: { pattern: '/worker/jobs/:id', refs: { id: ref } },
        screens: [secrets.screenVisited],
        app: { build: '0123456789ab', locale: 'es' },
        device: { kind: pick(['phone', 'tablet', 'desktop']), browser: secrets.browser, os: secrets.os, tz: secrets.tz, local_time: secrets.tz },
        requests: [
          { m: 'POST', p: '/worker/jobs/:id/apply', s: pick([0, 404, 500, 503]), ms: 10, rid: failingRid },
          { m: 'GET', p: '/worker/jobs/:id', s: 200, ms: 10, rid: secrets.okRid },
        ],
        errors: [{ k: 'error', msg: secrets.error, at: '2026-10-02T11:51:00.000Z' }],
      },
    }));
    const text = reports.buildReportSummary(reports.reportSummaryInput(detail));
    for (const [field, value] of Object.entries({ ...secrets, words: undefined, word0: secrets.words[0], word1: secrets.words[1], ref })) {
      if (value === undefined) continue;
      assert.equal(text.includes(value), false, `run ${run}: the summary must not contain the ${field}`);
    }
    assert.ok(text.startsWith(`JR-${1000 + run} · `), `run ${run}: the summary starts with the number`);
    assert.ok(text.includes(failingRid), `run ${run}: the failing request id is in the summary`);
  }
}

// --- Relative and absolute times -------------------------------------------
{
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  assert.equal(reports.formatRelativeTime('2026-10-02T11:59:40.000Z', now), 'just now');
  assert.equal(reports.formatRelativeTime('2026-10-02T11:51:00.000Z', now), '9 minutes ago');
  assert.equal(reports.formatRelativeTime('2026-10-02T10:00:00.000Z', now), '2 hours ago');
  assert.equal(reports.formatRelativeTime('2026-10-01T09:00:00.000Z', now), 'yesterday');
  assert.equal(reports.formatRelativeTime('2026-09-28T12:00:00.000Z', now), '4 days ago');
  assert.equal(reports.formatRelativeTime('2026-08-01T12:00:00.000Z', now), '2026-08-01');
  assert.equal(reports.formatUtcTime('2026-10-02T11:51:09.000Z'), '2026-10-02 11:51 UTC');
}

// --- Counts for the nav badge: their own query, never a recorded read ------
{
  const { pool, log } = createFakePool({ respond: ({ sql }) => (sql === COUNTS_SQL ? { rows: [{ new_count: 3, open_count: 5 }] } : {}) });
  reportCheck.pool = pool;
  assert.deepEqual(await reports.getProblemReportCounts(), { newCount: 3, openCount: 5 });
  assert.deepEqual(statements(log), [`pool: ${COUNTS_SQL}`], 'one COUNT query; no transaction and no event');

  const failing = createFakePool({
    respond: () => {
      throw Object.assign(new Error('jale_cap.problem_report_counts is not implemented yet'), { code: '0A000' });
    },
  });
  reportCheck.pool = failing.pool;
  const { result, lines } = await captureConsole(() => reports.getProblemReportCounts());
  assert.equal(result, null, 'a failed count hides the badge instead of failing the page');
  assert.doesNotMatch(JSON.stringify(lines), /not implemented/);
  assert.deepEqual(emfOrJsonLines(lines), [{ event: 'report_counts_unavailable', code: '0A000' }]);

  reportCheck.pool = new Error('pool unavailable');
  assert.equal((await captureConsole(() => reports.getProblemReportCounts())).result, null);
}

// --- Settings view: recorded, and the mailbox is shown by its domain only --
{
  const settingsRow = {
    reporting_enabled: true,
    signed_out_enabled: false,
    screenshots_enabled: true,
    team_email_enabled: true,
    signed_out_daily_cap: 200,
    team_recipient: 'team-inbox@reports.example.test',
    admin_base_url: 'https://dashboard.example.test',
    updated_at: new Date(BASE_TIME),
  };
  const sessionSuper = { ...reportsSession, role: 'admin_superadmin', groups: ['admin_superadmin'] };
  const { pool, log } = createFakePool({
    respond: async ({ sql, log: entries }) => {
      if (sql === SETTINGS_SQL) return { rows: [settingsRow] };
      if (sql === 'COMMIT') {
        await delay(5);
        entries.push({ connection: 1, op: 'commit_completed' });
      }
      return {};
    },
  });
  reportCheck.pool = pool;
  const settings = await reports.getProblemReportSettings(sessionSuper);
  log.push({ connection: '-', op: 'returned' });
  assert.deepEqual(statements(log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${SETTINGS_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: <commit_completed>',
    '1: <release>',
    '-: <returned>',
  ]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...reportsActor,
    actor_role: 'admin_superadmin',
    surface: 'admin.report_settings',
    categories: ['problem_reports'],
    subject_user_ids: [],
    record_ids: [],
    result_count: 1,
    field_names: [],
    request_id: REPORTS_REQUEST_ID,
  }]);
  assert.deepEqual(settings, {
    reportingEnabled: true,
    signedOutEnabled: false,
    screenshotsEnabled: true,
    teamEmailEnabled: true,
    signedOutDailyCap: 200,
    teamRecipientDomain: 'reports.example.test',
    adminBaseUrl: 'https://dashboard.example.test',
    updatedAt: new Date(BASE_TIME).toISOString(),
  });
  assert.equal(JSON.stringify(settings).includes('team-inbox'), false, 'the full mailbox never leaves the read model');
  assert.equal(reports.mapReportSettingsRow({ ...settingsRow, team_recipient: null }).teamRecipientDomain, null);

  // A non-superadmin view of the settings is a denied attempt.
  const denied = createFakePool();
  reportCheck.pool = denied.pool;
  await reports.recordReportSettingsDenied(reportsSession);
  assert.deepEqual(recordedEvents(denied.log).map((event) => [event.kind, event.outcome, event.surface, event.categories]), [
    ['attempt', 'denied', 'admin.report_settings', ['problem_reports']],
  ]);
}

// --- The local preview session reads without recording ---------------------
{
  const preview = { preview: true, sub: 'local-preview-admin', role: 'admin_ops', groups: ['admin_ops'] };
  const { pool, log } = createFakePool({ respond: ({ sql }) => (sql === INBOX_SQL ? { rows: [inboxRow(1)] } : {}) });
  reportCheck.pool = pool;
  const page = await reports.listProblemReports(preview, reports.parseInboxFilters({}));
  assert.equal(page.rows.length, 1);
  assert.deepEqual(statements(log), ['1: <connect>', '1: BEGIN', `1: ${INBOX_SQL}`, '1: COMMIT', '1: <release>']);
}

console.log('admin report read model checks passed');
