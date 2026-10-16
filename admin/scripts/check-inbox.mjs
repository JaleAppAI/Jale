// Sprint 28 K2.1-K2.3: the Inbox counts, the Home activity and the Inbox
// list (lib/server/admin-inbox.ts) against a fake pool.
//   - counts: one statement, null on any failure (the badge hides);
//   - activity: four sources merged newest first, text that names no person;
//   - list: three sources merged (waiting: oldest first; otherwise newest
//     first), a strict base64url cursor that round-trips, tab counts under
//     the status filter, the report filters (reportStatus included), and one
//     record per source under admin.inbox.
import assert from 'node:assert/strict';
import {
  RECORD_EVENT_SQL,
  captureConsole,
  compileAdminSources,
  createFakePool,
  fakeUuid,
  normalizeSql,
  recordedEvents,
  statements,
} from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'inbox',
  sources: ['src/lib/server/admin-inbox.ts', 'src/lib/server/admin-reports.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
  },
});

const inbox = await load('src/lib/server/admin-inbox.ts');
const reportsModule = await load('src/lib/server/admin-reports.ts');

const check = (globalThis.__adminCheck ??= {});
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';

const ADMIN_ID = fakeUuid(0xf1);
const SESSION_ID = fakeUuid(0xf2);
const REQUEST_ID = 'dddddddd-eeee-4fff-8000-111111111111';
const session = { sub: 'check-ops', email: 'ops@example.test', role: 'admin_ops', groups: ['admin_ops'], sessionId: SESSION_ID, adminUserId: ADMIN_ID, requestId: REQUEST_ID };

// Fixture people: none of these may reach an activity line or a list subject.
const WORKER_NAME = 'Synthetic Fixture Worker';
const WORKER_PHONE = '+15550104242';

const at = (minutes) => new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + minutes * 60_000);
const cursorOf = (date, micros = '000') => `${date.toISOString().slice(0, 23)}${micros}Z`;

// ---- parseInboxQuery ---------------------------------------------------------------
{
  assert.deepEqual(inbox.parseInboxQuery({}), { tab: 'all', status: 'waiting' });
  assert.deepEqual(inbox.parseInboxQuery({ tab: 'nope', status: 'open', q: '   ', before: 'junk' }), { tab: 'all', status: 'waiting' });
  assert.deepEqual(inbox.parseInboxQuery({ tab: 'support', status: 'resolved', q: '  S-124 ' }), { tab: 'support', status: 'resolved', q: 'S-124' });
  assert.deepEqual(inbox.parseInboxQuery({ tab: ['lockouts', 'all'], status: ['all'] }), { tab: 'lockouts', status: 'all' });
  assert.equal(inbox.parseInboxQuery({ q: 'x'.repeat(100) }).q.length, 40);

  // The report filters only on the reports tab; `status` stays the Inbox status.
  assert.deepEqual(inbox.parseInboxQuery({
    tab: 'reports', status: 'all', reportStatus: 'looking', role: 'employer', category: 'billing', verified: 'no', number: 'JR-1042',
  }), {
    tab: 'reports',
    status: 'all',
    report: {
      reportStatus: 'looking', role: 'employer', category: 'billing', verified: false,
      number: 1042, numberInput: 'JR-1042', numberInvalid: false,
    },
  });
  assert.deepEqual(inbox.parseInboxQuery({ tab: 'reports', status: 'new', reportStatus: 'closed', number: 'JR-10a2' }), {
    tab: 'reports',
    status: 'waiting',
    report: { reportStatus: null, role: null, category: null, verified: null, number: null, numberInput: 'JR-10a2', numberInvalid: true },
  });
  assert.equal(inbox.parseInboxQuery({ tab: 'all', reportStatus: 'new', role: 'worker' }).report, undefined, 'report filters only on the reports tab');
}

// ---- The cursor ------------------------------------------------------------------------
{
  const cursor = { sortKey: '2026-10-14T12:00:00.123456Z', source: 'report', id: fakeUuid(0x10) };
  const encoded = inbox.encodeInboxCursor(cursor);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'base64url');
  assert.deepEqual(inbox.decodeInboxCursor(encoded), cursor);
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
  for (const junk of [
    '', 'junk!', `${encoded}=`, encoded.toUpperCase(), b64('2026-10-14T12:00:00.123456Z|report'),
    b64(`2026-10-14T12:00:00.123Z|report|${fakeUuid(0x10)}`),
    b64(`2026-10-14T12:00:00.123456Z|ticket|${fakeUuid(0x10)}`),
    b64('2026-10-14T12:00:00.123456Z|case|not-a-uuid'),
    b64(`2026-13-45T12:00:00.123456Z|case|${fakeUuid(0x10)}`),
    b64('2026-10-14T12:00:00.123456Z|case|ABCDEF00-0000-4000-8000-00000000000A'),
    b64(`2026-10-14T12:00:00.123456Z|case|${fakeUuid(0x10)}|extra`),
    'A'.repeat(300),
  ]) {
    assert.equal(inbox.decodeInboxCursor(junk), null, `refused: ${junk.slice(0, 40)}`);
  }
}

// ---- Ref search ------------------------------------------------------------------------
{
  assert.deepEqual(inbox.parseRefSearch(undefined), { kind: 'none' });
  assert.deepEqual(inbox.parseRefSearch('S-124'), { kind: 'case', number: 124 });
  assert.deepEqual(inbox.parseRefSearch('s124'), { kind: 'case', number: 124 });
  assert.deepEqual(inbox.parseRefSearch('JR-1042'), { kind: 'report', number: 1042 });
  assert.deepEqual(inbox.parseRefSearch('r1042'), { kind: 'report', number: 1042 });
  assert.deepEqual(inbox.parseRefSearch('V-ABCD1234'), { kind: 'lockout', prefix: 'abcd1234' });
  for (const junk of ['hello', 'S-', 'V-XYZ', 'S-0', 'worker name']) {
    assert.deepEqual(inbox.parseRefSearch(junk), { kind: 'invalid' }, junk);
  }
}

// ---- A fake database for the list ---------------------------------------------------------
const CASES_ASC = normalizeSql(inbox.INBOX_CASES_ASC_SQL);
const CASES_DESC = normalizeSql(inbox.INBOX_CASES_DESC_SQL);
const CASES_COUNT = normalizeSql(inbox.INBOX_CASES_COUNT_SQL);
const REPORTS = normalizeSql(reportsModule.INBOX_SQL);
const LOCKOUTS = normalizeSql(inbox.INBOX_LOCKOUTS_SQL);

const caseRow = (n, { status = 'open', minutes, type = 'help_request', user = fakeUuid(0x500 + n), employer = null } = {}) => ({
  id: fakeUuid(0x100 + n),
  case_type: type,
  status,
  summary: `Case summary ${n}`,
  case_number: String(n),
  user_id: user,
  employer_id: employer,
  status_changed_at: at(minutes),
  sort_cursor: cursorOf(at(minutes)),
  user_name: WORKER_NAME,
});
const reportRow = (n, { status = 'new', minutes, role = 'worker' } = {}) => ({
  report_id: fakeUuid(0x200 + n),
  report_number: String(1000 + n),
  role,
  verified: true,
  category: 'finding_jobs',
  stops_work: false,
  status,
  has_image: false,
  created_at: at(minutes),
  content_erased: false,
  created_cursor: cursorOf(at(minutes)),
});
const lockoutRow = (n, { outcome = 'locked', minutes, kind = 'lockout' } = {}) => ({
  challenge_id: fakeUuid(0x300 + n),
  kind,
  outcome,
  last_event_at: at(minutes),
  sort_cursor: cursorOf(at(minutes)),
  masked_phone: '+1 555 *** 4242',
});

const CASE_WAITING = { all: () => true, waiting: (r) => ['open', 'pending_admin'].includes(r.status), waiting_on_worker: (r) => r.status === 'pending_worker', resolved: (r) => ['resolved', 'dismissed'].includes(r.status) };

/** The SQL's semantics for the case query: status, number, the cursor row comparison, order and limit. */
function caseQuery(rows, sql, params) {
  const [status, number, time, rank, id, limit] = params;
  const ascending = sql === CASES_ASC;
  const key = (r) => [r.sort_cursor, 0, r.id];
  const cmp = (a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? a[1] - b[1] : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  const cursor = time === null ? null : [time, rank, id];
  return rows
    .filter(CASE_WAITING[status])
    .filter((r) => number === null || Number(r.case_number) === number)
    .filter((r) => !cursor || (ascending ? cmp(key(r), cursor) > 0 : cmp(key(r), cursor) < 0))
    .sort((a, b) => (ascending ? 1 : -1) * cmp(key(a), key(b)))
    .slice(0, limit);
}

function listDatabase({ cases = [], reports = [], lockouts = [], fail } = {}) {
  return createFakePool({
    respond: ({ sql, params }) => {
      if (fail && fail.test(sql)) throw Object.assign(new Error('database read failed'), { code: '57014' });
      if (sql === RECORD_EVENT_SQL) return { rows: [{ seq: '1' }] };
      if (sql === CASES_ASC || sql === CASES_DESC) return { rows: caseQuery(cases, sql, params) };
      if (sql === CASES_COUNT) {
        const [status, number] = params;
        return { rows: [{ total: String(cases.filter(CASE_WAITING[status]).filter((r) => number === null || Number(r.case_number) === number).length) }] };
      }
      if (sql === REPORTS) {
        const [status, role, category, verified, number, limit, before] = params;
        return {
          rows: reports
            .filter((r) => (status === null || r.status === status) && (role === null || r.role === role)
              && (category === null || r.category === category) && (verified === null || r.verified === verified)
              && (number === null || Number(r.report_number) === number) && (before === null || r.created_cursor < before))
            .sort((a, b) => (a.created_cursor < b.created_cursor ? 1 : -1))
            .slice(0, limit),
        };
      }
      if (sql === LOCKOUTS) return { rows: lockouts };
      return {};
    },
  });
}

async function list(query, data) {
  const { pool, log } = listDatabase(data);
  check.pool = pool;
  const { result } = await captureConsole(() => inbox.loadInbox(session, query));
  return { page: result, log };
}

// ---- The merge: waiting is oldest first across the three sources -----------------------------
{
  const data = {
    cases: [
      caseRow(1, { minutes: 30 }),
      caseRow(2, { status: 'pending_admin', minutes: 10 }),
      caseRow(3, { status: 'pending_worker', minutes: 5 }),
      caseRow(4, { status: 'resolved', minutes: 1 }),
      caseRow(5, { status: 'open', minutes: 50, type: 'outbound_failure', user: null }),
    ],
    reports: [
      reportRow(1, { minutes: 20 }),
      reportRow(2, { status: 'looking', minutes: 40 }),
      reportRow(3, { status: 'fixed', minutes: 2 }),
    ],
    lockouts: [
      lockoutRow(1, { minutes: 15 }),
      lockoutRow(2, { outcome: 'retrying', minutes: 3 }),
      lockoutRow(3, { outcome: 'verified', minutes: 4 }),
    ],
  };
  const { page, log } = await list({ tab: 'all', status: 'waiting' }, data);
  assert.deepEqual(page.items.map((item) => item.ref), ['S-2', 'V-00000000', 'JR-1001', 'S-1', 'JR-1002', 'S-5']);
  assert.deepEqual(page.items.map((item) => item.waitingOn), ['us', 'us', 'us', 'us', 'us', 'us']);
  assert.ok(page.items.every((item) => item.unread === true));
  assert.deepEqual(page.tabCounts, { all: 6, support: 3, reports: 2, lockouts: 1 });
  assert.equal(page.total, 6);
  assert.equal(page.nextBefore, undefined);

  const [support, lockout, report] = page.items;
  assert.deepEqual(support, {
    kind: 'support', id: fakeUuid(0x102), ref: 'S-2', typeLabel: 'Support', subject: 'Case summary 2', from: 'Worker',
    statusLabel: 'Worker replied', waitingOn: 'us', waitingSince: at(10).toISOString(), unread: true, href: `/inbox/support/${fakeUuid(0x102)}`,
  });
  assert.deepEqual(lockout, {
    kind: 'lockout', id: fakeUuid(0x301), ref: 'V-00000000', typeLabel: 'Lockout', subject: 'Locked out of verification', from: 'Worker',
    statusLabel: 'Locked', waitingOn: 'us', waitingSince: at(15).toISOString(), unread: true, href: `/inbox/lockouts/${fakeUuid(0x301)}`,
  });
  assert.deepEqual(report, {
    kind: 'report', id: fakeUuid(0x201), ref: 'JR-1001', typeLabel: 'Problem report', subject: 'Finding jobs', from: 'Worker (web)',
    statusLabel: 'New', waitingOn: 'us', waitingSince: at(20).toISOString(), unread: true, href: `/inbox/reports/${fakeUuid(0x201)}`,
  });
  assert.equal(page.items[5].from, 'Unregistered number');
  assert.equal(page.items[5].kind, 'delivery_issue');
  assert.doesNotMatch(JSON.stringify(page), new RegExp(WORKER_NAME));
  assert.doesNotMatch(JSON.stringify(page), /\+1555/);

  // The reports source reads each waiting status; one record per source, all in the read's transaction.
  const reportCalls = log.filter((entry) => entry.sql === REPORTS).map((entry) => entry.params[0]);
  assert.deepEqual(reportCalls, ['new', 'looking']);
  const lines = statements(log);
  assert.deepEqual(lines.slice(0, 2), ['1: <connect>', '1: BEGIN']);
  assert.deepEqual(lines.slice(-2), ['1: COMMIT', '1: <release>']);
  const events = recordedEvents(log);
  assert.deepEqual(events.map((event) => [event.surface, event.categories, event.record_type, event.record_ids.length]), [
    ['admin.inbox', ['cases'], 'admin_case', 3],
    ['admin.inbox', ['problem_reports'], 'problem_report', 2],
    ['admin.inbox', ['verifications'], 'identity_challenge', 1],
  ]);
  assert.deepEqual(events[0].subject_user_ids, [fakeUuid(0x502), fakeUuid(0x501)]);
  assert.equal(events[2].purpose_kind, 'verification');
}

// ---- Other views are newest first; tab counts follow the status filter ------------------------
{
  const data = {
    cases: [caseRow(1, { status: 'resolved', minutes: 10 }), caseRow(2, { status: 'dismissed', minutes: 30 }), caseRow(3, { minutes: 50 })],
    reports: [reportRow(1, { status: 'fixed', minutes: 20 }), reportRow(2, { status: 'wont_fix', minutes: 40 }), reportRow(3, { minutes: 60 })],
    lockouts: [lockoutRow(1, { outcome: 'verified', minutes: 25 }), lockoutRow(2, { outcome: 'superseded', minutes: 5 })],
  };
  const { page, log } = await list({ tab: 'all', status: 'resolved' }, data);
  assert.deepEqual(page.items.map((item) => item.ref), ['JR-1002', 'S-2', 'V-00000000', 'JR-1001', 'S-1', 'V-00000000']);
  assert.ok(page.items.every((item) => item.waitingOn === 'nobody' && item.waitingSince === null && item.unread === false));
  assert.deepEqual(page.tabCounts, { all: 6, support: 2, reports: 2, lockouts: 2 });
  assert.deepEqual(log.filter((entry) => entry.sql === REPORTS).map((entry) => entry.params[0]), ['fixed', 'wont_fix']);

  const worker = await list({ tab: 'all', status: 'waiting_on_worker' }, {
    cases: [caseRow(1, { status: 'pending_worker', minutes: 10 })],
    reports: [reportRow(1, { minutes: 5 })],
    lockouts: [lockoutRow(1, { outcome: 'lock_expired', minutes: 20 }), lockoutRow(2, { outcome: 'code_expired', kind: 'stuck', minutes: 30 })],
  });
  assert.deepEqual(worker.page.items.map((item) => [item.ref, item.waitingOn]), [['V-00000000', 'worker'], ['V-00000000', 'worker'], ['S-1', 'worker']]);
  assert.equal(worker.page.items[0].subject, 'Stuck at the verification code');
  assert.deepEqual(worker.page.tabCounts, { all: 3, support: 1, reports: 0, lockouts: 2 });
  assert.equal(worker.log.some((entry) => entry.sql === REPORTS), false, 'no report waits on the worker');

  // A tab shows only its source; the counts still cover every tab.
  const supportTab = await list({ tab: 'support', status: 'resolved' }, data);
  assert.deepEqual(supportTab.page.items.map((item) => item.ref), ['S-2', 'S-1']);
  assert.equal(supportTab.page.total, 2);
  assert.deepEqual(supportTab.page.tabCounts, { all: 6, support: 2, reports: 2, lockouts: 2 });
}

// ---- The cursor round trip: 30 waiting items in two pages, no gaps or repeats -----------------
{
  const data = {
    cases: Array.from({ length: 12 }, (_, i) => caseRow(i + 1, { minutes: i * 3 })),
    reports: Array.from({ length: 10 }, (_, i) => reportRow(i + 1, { minutes: i * 3 + 1 })),
    lockouts: Array.from({ length: 8 }, (_, i) => lockoutRow(i + 1, { minutes: i * 3 + 2 })),
  };
  // Two items share a time: the source breaks the tie (case before report).
  data.reports[0].created_cursor = data.cases[0].sort_cursor;
  data.reports[0].created_at = data.cases[0].status_changed_at;

  const first = await list({ tab: 'all', status: 'waiting' }, data);
  assert.equal(first.page.items.length, 25);
  assert.ok(first.page.nextBefore);
  assert.equal(first.page.total, 30);
  const second = await list({ tab: 'all', status: 'waiting', before: first.page.nextBefore }, data);
  assert.equal(second.page.items.length, 5);
  assert.equal(second.page.nextBefore, undefined);
  const ids = [...first.page.items, ...second.page.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 30, 'every item exactly once');
  const times = [...first.page.items, ...second.page.items].map((item) => item.waitingSince);
  assert.deepEqual(times, [...times].sort(), 'oldest first across the page boundary');
  assert.deepEqual(first.page.items.slice(0, 2).map((item) => item.kind), ['support', 'report']);
  // The second page's case query carries the cursor, as text, rank and id.
  const decoded = inbox.decodeInboxCursor(first.page.nextBefore);
  const caseCall = second.log.find((entry) => entry.sql === CASES_ASC);
  assert.deepEqual(caseCall.params, ['waiting', null, decoded.sortKey, { case: 0, report: 1, lockout: 2 }[decoded.source], decoded.id, 26]);
  // A junk cursor is no cursor: the first page again.
  const junk = await list({ tab: 'all', status: 'waiting', before: 'not-a-cursor' }, data);
  assert.deepEqual(junk.page.items.map((item) => item.id), first.page.items.map((item) => item.id));
}

// ---- Report filters, reportStatus and ref search ---------------------------------------------
{
  const data = {
    cases: [caseRow(124, { minutes: 1 }), caseRow(7, { status: 'resolved', minutes: 2 })],
    reports: [
      reportRow(42, { minutes: 3, role: 'employer' }),
      reportRow(43, { status: 'fixed', minutes: 4, role: 'employer' }),
      reportRow(44, { status: 'fixed', minutes: 5, role: 'worker' }),
    ],
    lockouts: [lockoutRow(1, { minutes: 6 })],
  };
  const reportFilter = (over = {}) => ({ reportStatus: null, role: null, category: null, verified: null, number: null, numberInput: '', numberInvalid: false, ...over });

  const employer = await list({ tab: 'reports', status: 'all', report: reportFilter({ role: 'employer' }) }, data);
  assert.deepEqual(employer.page.items.map((item) => item.ref), ['JR-1043', 'JR-1042']);
  assert.deepEqual(employer.log.filter((entry) => entry.sql === REPORTS).map((entry) => entry.params.slice(0, 5)), [[null, 'employer', null, null, null]]);

  // reportStatus replaces the Inbox status on the reports tab.
  const fixed = await list({ tab: 'reports', status: 'waiting', report: reportFilter({ reportStatus: 'fixed' }) }, data);
  assert.deepEqual(fixed.page.items.map((item) => item.ref), ['JR-1044', 'JR-1043'], 'fixed reports, newest first');
  assert.deepEqual(fixed.log.filter((entry) => entry.sql === REPORTS).map((entry) => entry.params[0]), ['fixed']);
  assert.equal(fixed.page.tabCounts.reports, 2);
  assert.equal(fixed.page.total, 2);

  const invalidNumber = await list({ tab: 'reports', status: 'all', report: reportFilter({ numberInput: 'JR-1x', numberInvalid: true }) }, data);
  assert.deepEqual(invalidNumber.page.items, []);

  // q names one ref across every status.
  const byCase = await list({ tab: 'all', status: 'waiting', q: 'S-7' }, data);
  assert.deepEqual(byCase.page.items.map((item) => item.ref), ['S-7']);
  assert.equal(byCase.log.find((entry) => entry.sql === CASES_DESC).params[1], 7);
  assert.equal(byCase.log.some((entry) => entry.sql === REPORTS || entry.sql === LOCKOUTS), false);
  const byReport = await list({ tab: 'all', status: 'waiting', q: 'jr1044' }, data);
  assert.deepEqual(byReport.page.items.map((item) => item.ref), ['JR-1044']);
  const byLockout = await list({ tab: 'all', status: 'waiting', q: 'v-00000000' }, data);
  assert.deepEqual(byLockout.page.items.map((item) => item.ref), ['V-00000000']);
  const nonsense = await list({ tab: 'all', status: 'waiting', q: WORKER_NAME }, data);
  assert.deepEqual(nonsense.page, { items: [], tabCounts: { all: 0, support: 0, reports: 0, lockouts: 0 }, total: 0 });
  assert.deepEqual(nonsense.log, [], 'free text is never searched');
}

// ---- A failed read records a failed attempt and rethrows ------------------------------------
{
  const { pool, log } = listDatabase({ fail: /admin_identity_lockouts/ });
  check.pool = pool;
  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  await captureConsole(async () => {
    await assert.rejects(() => inbox.loadInbox(session, { tab: 'all', status: 'waiting' }), /database read failed/);
  });
  const lines = statements(log);
  assert.ok(lines.includes('1: ROLLBACK'));
  assert.equal(lines.includes('1: COMMIT'), false);
  assert.deepEqual(recordedEvents(log).map((event) => [event.kind, event.outcome, event.surface]), [['attempt', 'failed', 'admin.inbox']]);
}

// ---- getInboxCounts: one statement; null on any failure -------------------------------------
const COUNTS = normalizeSql(inbox.INBOX_COUNTS_SQL);
{
  const row = {
    cases_waiting: '4', support: '3', delivery_issues: '1', unread_support: '2', oldest_support: at(-90), cases_fresh: '2',
    reports_waiting: 5, oldest_report: at(-60), reports_fresh: '1',
    lockouts_waiting: '1', oldest_lockout: at(-5), lockouts_fresh: '1',
    since: at(-30),
  };
  const { pool, log } = createFakePool({ respond: ({ sql }) => (sql === COUNTS ? { rows: [row] } : {}) });
  check.pool = pool;
  const counts = await inbox.getInboxCounts(session);
  assert.deepEqual(counts, {
    waitingOnUs: 10,
    support: 3,
    reports: 5,
    lockouts: 1,
    deliveryIssues: 1,
    unreadSupport: 2,
    oldestWaiting: { support: at(-90).toISOString(), reports: at(-60).toISOString(), lockouts: at(-5).toISOString() },
    newSinceLastVisit: 4,
  });
  assert.deepEqual(statements(log), [`pool: ${COUNTS}`], 'one statement on the pool: the layout stays at one count query');
  assert.deepEqual(log[0].params, [ADMIN_ID, SESSION_ID]);

  // First visit: no earlier session, so nothing is "new since".
  const first = createFakePool({ respond: ({ sql }) => (sql === COUNTS ? { rows: [{ ...row, since: null }] } : {}) });
  check.pool = first.pool;
  assert.equal((await inbox.getInboxCounts(session)).newSinceLastVisit, null);

  // The local preview has no ids: it passes NULLs and still counts.
  const preview = createFakePool({ respond: ({ sql }) => (sql === COUNTS ? { rows: [{ ...row, since: null }] } : {}) });
  check.pool = preview.pool;
  await inbox.getInboxCounts({ preview: true, sub: 'local', role: 'admin_ops', groups: ['admin_ops'] });
  assert.deepEqual(preview.log[0].params, [null, null]);

  // T9: any failure hides the badge (null), with a code-only log line.
  for (const failure of [
    new Error('pool unavailable'),
    Object.assign(new Error('relation detail with values'), { code: '42P01' }),
  ]) {
    check.pool = failure;
    const { result, lines } = await captureConsole(() => inbox.getInboxCounts(session));
    assert.equal(result, null);
    assert.doesNotMatch(JSON.stringify(lines), /relation detail|pool unavailable/);
  }
  const broken = createFakePool({ respond: () => { throw Object.assign(new Error('statement timeout'), { code: '57014' }); } });
  check.pool = broken.pool;
  const { result: timedOut, lines } = await captureConsole(() => inbox.getInboxCounts(session));
  assert.equal(timedOut, null);
  assert.match(JSON.stringify(lines), /inbox_counts_unavailable/);
  assert.match(JSON.stringify(lines), /57014/);
  const garbled = createFakePool({ respond: ({ sql }) => (sql === COUNTS ? { rows: [{ ...row, support: 'many' }] } : {}) });
  check.pool = garbled.pool;
  assert.equal((await captureConsole(() => inbox.getInboxCounts(session))).result, null);
}

// ---- loadRecentActivity: four sources, newest first, no person named ----------------------
const ACT_EVENTS = normalizeSql(inbox.ACTIVITY_EVENTS_SQL);
const ACT_REPORTS = normalizeSql(inbox.ACTIVITY_REPORTS_SQL);
const ACT_LOCKOUTS = normalizeSql(inbox.ACTIVITY_LOCKOUTS_SQL);
const ACT_RESUMES = normalizeSql(inbox.ACTIVITY_JOB_RESUMES_SQL);
{
  const CASE_ID = fakeUuid(0x701);
  const event = (n, type, minutes, extra = {}) => ({
    id: fakeUuid(0x600 + n), event_type: type, actor_type: 'worker', created_at: at(minutes),
    by_role: null, media_type: null, case_id: CASE_ID, case_number: '124', case_type: 'help_request',
    // Columns the mapping must ignore if a query ever returned them.
    full_name: WORKER_NAME, whatsapp_number: WORKER_PHONE, detail: `My name is ${WORKER_NAME}`,
    ...extra,
  });
  const rows = {
    [ACT_EVENTS]: [
      event(1, 'worker_media', 50, { media_type: 'image' }),
      event(2, 'worker_message', 40),
      event(3, 'admin_reply_queued', 35, { actor_type: 'admin', by_role: 'Ops', case_number: '118' }),
      event(4, 'case_created', 30, { actor_type: 'worker' }),
      event(5, 'lockout_reset', 25, { actor_type: 'admin', by_role: 'Superadmin', case_type: 'verification_blocker' }),
      event(6, 'case_created', 24, { actor_type: 'admin', by_role: 'Superadmin', case_type: 'help_request' }),
    ],
    [ACT_REPORTS]: [{ report_id: fakeUuid(0x801), report_number: '1042', created_at: at(45) }],
    [ACT_LOCKOUTS]: [{ challenge_id: 'abcd1234-0000-4000-8000-000000000001', last_event_at: at(20) }],
    [ACT_RESUMES]: [{ event_id: fakeUuid(0x901), job_id: fakeUuid(0x902), changed_at: at(38) }],
  };
  const { pool, log } = createFakePool({ respond: ({ sql }) => ({ rows: rows[sql] ?? [] }) });
  check.pool = pool;
  const items = await inbox.loadRecentActivity(session);
  assert.deepEqual(items.map((item) => [item.kind, item.text, item.href]), [
    ['support_media', 'A worker sent a photo in support case S-124', `/inbox/support/${CASE_ID}`],
    ['report', 'New problem report JR-1042', `/inbox/reports/${fakeUuid(0x801)}`],
    ['support_message', 'A worker wrote in support case S-124', `/inbox/support/${CASE_ID}`],
    ['job_resumed', 'A paused job went live again after payment recovered', null],
    ['case_resolved', 'Ops admin resolved support case S-118', `/inbox/support/${CASE_ID}`],
    ['case_opened', 'New support case S-124', `/inbox/support/${CASE_ID}`],
    ['lockout', 'Superadmin reset a verification lockout', `/inbox/support/${CASE_ID}`],
    ['case_opened', 'Superadmin opened support case S-124', `/inbox/support/${CASE_ID}`],
  ]);
  assert.equal(items.length, 8, 'default 8');
  assert.equal(items[3].id, fakeUuid(0x901), 'a resume is identified by its event id');
  const text = JSON.stringify(items);
  assert.doesNotMatch(text, new RegExp(WORKER_NAME), 'no worker name');
  assert.doesNotMatch(text, /\+1555|4242/, 'no phone');
  assert.doesNotMatch(text, /My name is/, 'no message text');
  assert.doesNotMatch(text, /@example\.test/, 'no admin email');
  // One connection for the four reads; the limit reaches every source; nothing is recorded.
  assert.deepEqual(statements(log), ['1: <connect>', `1: ${ACT_EVENTS}`, `1: ${ACT_REPORTS}`, `1: ${ACT_LOCKOUTS}`, `1: ${ACT_RESUMES}`, '1: <release>']);
  assert.ok(log.filter((entry) => entry.sql).every((entry) => entry.params[0] === 8));
  assert.equal(recordedEvents(log).length, 0);

  const three = await inbox.loadRecentActivity(session, 3);
  assert.equal(three.length, 3);
  const clamped = createFakePool({ respond: () => ({ rows: [] }) });
  check.pool = clamped.pool;
  await inbox.loadRecentActivity(session, 500);
  assert.ok(clamped.log.filter((entry) => entry.sql).every((entry) => entry.params[0] === 50));

  // The resume source's errors are not swallowed (jale, 2026-10-14).
  const missing = createFakePool({
    respond: ({ sql }) => {
      if (sql === ACT_RESUMES) throw Object.assign(new Error('function does not exist'), { code: '42883' });
      return { rows: [] };
    },
  });
  check.pool = missing.pool;
  await assert.rejects(() => inbox.loadRecentActivity(session), /function does not exist/);
  assert.deepEqual(statements(missing.log).at(-1), '1: <release>', 'the connection goes back to the pool');
}

console.log('inbox list, counts and activity checks passed');
