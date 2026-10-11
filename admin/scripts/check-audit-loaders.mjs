// Checks the dashboard page loaders: each loads in one
// transaction and records exactly the records it shows before COMMIT, and
// returns data only after COMMIT, so the page renders after the record exists.
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
  name: 'audit-loaders',
  sources: [
    'src/lib/server/admin-cases.ts',
    'src/lib/server/admin-lockouts.ts',
    'src/lib/server/admin-analytics.ts',
    'src/lib/server/admin-audit.ts',
  ],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
  },
});

const cases = await load('src/lib/server/admin-cases.ts');
const lockouts = await load('src/lib/server/admin-lockouts.ts');
const analytics = await load('src/lib/server/admin-analytics.ts');
const audit = await load('src/lib/server/admin-audit.ts');

const check = (globalThis.__adminCheck = {});
const ADMIN_ID = fakeUuid(0xd1);
const SESSION_ID = fakeUuid(0xd2);
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const session = {
  sub: 'check-admin-sub',
  email: 'ops-admin@example.test',
  role: 'admin_readonly',
  groups: ['admin_readonly'],
  sessionId: SESSION_ID,
  adminUserId: ADMIN_ID,
  requestId: REQUEST_ID,
};
const actor = {
  actor_kind: 'admin',
  actor_id: ADMIN_ID,
  actor_role: 'admin_readonly',
  actor_session: SESSION_ID,
  channel: 'admin',
};

const CASE_1 = fakeUuid(0xc1);
const CASE_2 = fakeUuid(0xc2);
const WORKER_1 = fakeUuid(0xa1);
const WORKER_2 = fakeUuid(0xa2);
const EMPLOYER_1 = fakeUuid(0xe1);

function caseRow(id, overrides = {}) {
  return {
    id,
    case_type: 'help_request',
    status: 'open',
    priority: 50,
    user_id: WORKER_1,
    conversation_id: null,
    employer_id: null,
    summary: 'Synthetic case summary',
    details: {},
    created_at: new Date('2026-10-01T12:00:00Z'),
    updated_at: new Date('2026-10-01T12:30:00Z'),
    assigned_admin_email: null,
    user_name: 'Test Worker',
    user_phone: '+12025550123',
    user_email: 'worker@example.test',
    employer_name: null,
    ...overrides,
  };
}

function lockoutRow(n, kind) {
  return {
    challenge_id: fakeUuid(0x5000 + n),
    kind,
    masked_phone: '+1 202 *** 0123',
    outcome: kind === 'lockout' ? 'locked' : 'code_expired',
    lockout_count: kind === 'lockout' ? 1 : 0,
    attempts: 0,
    locked_until: null,
    last_event_at: new Date('2026-10-01T15:30:00Z'),
    started_at: new Date('2026-10-01T15:00:00Z'),
  };
}

// The fake database answers by statement and marks when COMMIT completes, so
// a check can prove the loader returns only after it.
function database(answers) {
  return createFakePool({
    respond: async ({ sql, connection, log }) => {
      if (sql === 'COMMIT') {
        await new Promise((resolve) => setTimeout(resolve, 2));
        log.push({ connection, op: 'commit_completed' });
        return {};
      }
      for (const [match, rows] of answers) {
        if (match.test(sql)) return { rows: typeof rows === 'function' ? rows() : rows };
      }
      return {};
    },
  });
}

function assertStatements(log, expected) {
  const lines = statements(log);
  assert.equal(lines.length, expected.length, `statements:\n${lines.join('\n')}`);
  expected.forEach((pattern, index) => {
    if (typeof pattern === 'string') assert.equal(lines[index], pattern);
    else assert.match(lines[index], pattern);
  });
}

const RECORD = `1: ${RECORD_EVENT_SQL}`;
const OPEN = ['1: <connect>', '1: BEGIN'];
const CLOSE = ['1: COMMIT', '1: <commit_completed>', '1: <release>', '-: <returned>'];

async function run(loader) {
  const result = await loader();
  check.log.push({ connection: '-', op: 'returned' });
  return result;
}

// --- The cases list records the case ids on the page and their subjects -------
{
  const { pool, log } = database([
    [/FROM admin_cases c .* LIMIT \$1$/, [caseRow(CASE_1, { employer_id: EMPLOYER_1 }), caseRow(CASE_2, { user_id: WORKER_2 })]],
    [/^SELECT COUNT\(\*\) AS count FROM admin_cases$/, [{ count: '5' }]],
  ]);
  check.pool = pool;
  check.log = log;
  const list = await run(() => cases.loadCasesList(session));
  assertStatements(log, [
    ...OPEN,
    /^1: SELECT c\.id, .* FROM admin_cases c .* ORDER BY c\.status, c\.priority DESC, c\.created_at DESC LIMIT \$1$/,
    '1: SELECT COUNT(*) AS count FROM admin_cases',
    RECORD,
    ...CLOSE,
  ]);
  assert.deepEqual(log[2].params, [200]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.cases_list',
    categories: ['cases'],
    subject_user_ids: [WORKER_1, EMPLOYER_1, WORKER_2],
    record_type: 'admin_case',
    record_ids: [CASE_1, CASE_2],
    result_count: 2,
    field_names: [],
    request_id: REQUEST_ID,
  }]);
  assert.equal(list.totalCount, 5);
  assert.deepEqual(list.rows.map((row) => row.id), [CASE_1, CASE_2]);
  assert.equal(list.rows[0].workerName, 'Test W.', 'names stay masked');
}

// --- Case detail records the case, its subjects and the timeline shown -------
{
  const events = [
    { id: fakeUuid(0x7001), event_type: 'help_keyword', actor_type: 'worker', payload: { title: 'Help requested' }, created_at: new Date('2026-10-01T12:01:00Z') },
    { id: fakeUuid(0x7002), event_type: 'admin_reply_queued', actor_type: 'admin', payload: { title: 'Reply queued' }, created_at: new Date('2026-10-01T12:05:00Z') },
  ];
  const { pool, log } = database([
    [/WHERE c\.id = \$1/, [caseRow(CASE_1, { employer_id: EMPLOYER_1 })]],
    [/FROM admin_case_events/, events],
  ]);
  check.pool = pool;
  check.log = log;
  const item = await run(() => cases.loadCaseDetail(session, CASE_1));
  assertStatements(log, [
    ...OPEN,
    /^1: SELECT c\.id, .* FROM admin_cases c .* WHERE c\.id = \$1 LIMIT 1$/,
    /^1: SELECT id, case_id, event_type, actor_type, payload, created_at FROM admin_case_events WHERE case_id = \$1 ORDER BY created_at DESC$/,
    RECORD,
    ...CLOSE,
  ]);
  assert.deepEqual(log[2].params, [CASE_1]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.case_detail',
    categories: ['cases'],
    subject_user_ids: [WORKER_1, EMPLOYER_1],
    record_type: 'admin_case',
    record_ids: [CASE_1],
    result_count: 2,
    field_names: [],
    purpose_kind: 'case',
    purpose_id: CASE_1,
    request_id: REQUEST_ID,
  }]);
  assert.equal(item.id, CASE_1);
  assert.equal(item.timeline.length, 2);
}

// A case that does not exist: nothing read is recorded, then a not_found
// attempt after the transaction has ended. A malformed id never reaches SQL.
{
  const { pool, log } = database([[/WHERE c\.id = \$1/, []]]);
  check.pool = pool;
  check.log = log;
  const missing = await cases.loadCaseDetail(session, CASE_2);
  assert.equal(missing, undefined);
  assertStatements(log, [
    ...OPEN,
    /^1: SELECT c\.id, .* WHERE c\.id = \$1 LIMIT 1$/,
    '1: COMMIT',
    '1: <commit_completed>',
    '1: <release>',
    '2: <connect>',
    '2: BEGIN',
    `2: ${RECORD_EVENT_SQL}`,
    '2: COMMIT',
    '2: <commit_completed>',
    '2: <release>',
  ]);
  const [attempt] = recordedEvents(log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.record_type, attempt.record_ids, attempt.result_count],
    ['attempt', 'not_found', 'admin.case_detail', 'admin_case', [CASE_2], 0],
  );

  const { pool: pool2, log: log2 } = database([]);
  check.pool = pool2;
  assert.equal(await cases.loadCaseDetail(session, 'not-a-case-id'), undefined);
  assert.equal(log2.filter((entry) => /admin_cases/.test(entry.sql ?? '')).length, 0, 'a malformed id is never queried');
  const [malformed] = recordedEvents(log2);
  assert.deepEqual([malformed.outcome, malformed.record_ids], ['not_found', []]);
  assert.doesNotMatch(JSON.stringify(log2), /not-a-case-id/, 'the malformed id is not recorded');
}

// A failed record rolls back, and the case is never returned. The failure is
// then recorded as a failed attempt on a connection of its own.
{
  const { pool, log } = createFakePool({
    respond: ({ sql, connection }) => {
      if (/WHERE c\.id = \$1/.test(sql)) return { rows: [caseRow(CASE_1)] };
      if (sql === RECORD_EVENT_SQL && connection === 1) throw new Error('record failed');
      return {};
    },
  });
  check.pool = pool;
  await captureConsole(async () => {
    await assert.rejects(() => cases.loadCaseDetail(session, CASE_1), /record failed/);
  });
  const lines = statements(log);
  assert.deepEqual(lines.slice(-7), [
    '1: ROLLBACK',
    '1: <release>',
    '2: <connect>',
    '2: BEGIN',
    `2: ${RECORD_EVENT_SQL}`,
    '2: COMMIT',
    '2: <release>',
  ]);
  assert.equal(lines.includes('1: COMMIT'), false);
  const attempts = recordedEvents(log.filter((entry) => entry.connection === 2));
  assert.deepEqual(attempts.map((event) => [event.kind, event.outcome, event.record_ids]), [['attempt', 'failed', [CASE_1]]]);
}

// The preview session reads without recording.
{
  const { pool, log } = database([[/WHERE c\.id = \$1/, [caseRow(CASE_1)]], [/FROM admin_case_events/, []]]);
  check.pool = pool;
  check.log = log;
  const item = await cases.loadCaseDetail({ preview: true, sub: 'local-preview-admin', role: 'admin_ops', groups: ['admin_ops'] }, CASE_1);
  assert.equal(item.id, CASE_1);
  assert.equal(recordedEvents(log).length, 0);
}

// --- The dashboard records the cases and the lockouts it shows ---------------
{
  const lockoutRows = [
    lockoutRow(1, 'lockout'), lockoutRow(2, 'lockout'), lockoutRow(3, 'stuck'),
    lockoutRow(4, 'lockout'), lockoutRow(5, 'lockout'),
  ];
  const { pool, log } = database([
    [/^SELECT COUNT\(\*\) AS count FROM admin_cases c WHERE c\.status NOT IN/, [{ count: '7' }]],
    [/FROM admin_cases c .* WHERE c\.status NOT IN .* LIMIT \$1$/, [caseRow(CASE_1, { employer_id: EMPLOYER_1 }), caseRow(CASE_2, { user_id: null, employer_id: null })]],
    [/jale_audit\.reveal_count/, [{ count: '4' }]],
    [/admin_identity_lockouts/, lockoutRows],
  ]);
  check.pool = pool;
  check.log = log;
  const dashboard = await run(() => cases.loadAdminDashboard(session));
  assertStatements(log, [
    ...OPEN,
    "1: SELECT COUNT(*) AS count FROM admin_cases c WHERE c.status NOT IN ('resolved', 'dismissed')",
    /^1: SELECT c\.id, .* WHERE c\.status NOT IN \('resolved', 'dismissed'\) ORDER BY c\.priority DESC, c\.created_at DESC LIMIT \$1$/,
    '1: SELECT jale_audit.reveal_count($1) AS count',
    '1: SELECT * FROM admin_identity_lockouts($1)',
    RECORD,
    RECORD,
    ...CLOSE,
  ]);
  assert.deepEqual(log[3].params, [3]);
  assert.deepEqual(log[4].params, [7]);
  assert.deepEqual(log[5].params, [7]);
  const [caseEvent, lockoutEvent] = recordedEvents(log);
  assert.deepEqual(caseEvent, {
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.dashboard',
    categories: ['cases'],
    subject_user_ids: [WORKER_1, EMPLOYER_1],
    record_type: 'admin_case',
    record_ids: [CASE_1, CASE_2],
    result_count: 2,
    field_names: [],
    request_id: REQUEST_ID,
  });
  assert.deepEqual(lockoutEvent, {
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.dashboard',
    categories: ['verifications'],
    subject_user_ids: [],
    record_type: 'identity_challenge',
    record_ids: [fakeUuid(0x5001), fakeUuid(0x5002), fakeUuid(0x5004)],
    result_count: 3,
    field_names: [],
    request_id: REQUEST_ID,
  });
  assert.deepEqual(dashboard.recentLockouts.map((item) => item.challengeId), lockoutEvent.record_ids,
    'the recorded lockouts are exactly the rendered ones');
  assert.equal(dashboard.openCaseCount, 7);
  assert.equal(dashboard.revealCount, 4);
  assert.equal(dashboard.lockedOutCount, 4);
  assert.equal(dashboard.stuckCount, 1);
  assert.deepEqual(dashboard.openCases.map((item) => item.id), [CASE_1, CASE_2]);
}

// --- The lockout list records every challenge id it shows -------------------
{
  const rows = [lockoutRow(1, 'lockout'), lockoutRow(2, 'stuck')];
  const { pool, log } = database([[/admin_identity_lockouts/, rows]]);
  check.pool = pool;
  check.log = log;
  const list = await run(() => lockouts.loadLockouts(session));
  assertStatements(log, [...OPEN, '1: SELECT * FROM admin_identity_lockouts($1)', RECORD, ...CLOSE]);
  assert.deepEqual(log[2].params, [7]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.lockouts',
    categories: ['verifications'],
    subject_user_ids: [],
    record_type: 'identity_challenge',
    record_ids: [fakeUuid(0x5001), fakeUuid(0x5002)],
    result_count: 2,
    field_names: [],
    purpose_kind: 'verification',
    request_id: REQUEST_ID,
  }]);
  assert.equal(list.length, 2);
}

// --- Only the paying-employers list names anyone; it records them -----------
{
  const employers = [
    { employer_id: EMPLOYER_1, display_name: 'Synthetic Co', plan_code: 'pro', status: 'active', current_period_end: null, cancel_at_period_end: false },
    { employer_id: fakeUuid(0xe2), display_name: 'Another Co', plan_code: 'pro', status: 'trialing', current_period_end: null, cancel_at_period_end: false },
  ];
  const { pool, log } = database([[/admin_analytics_paying_employers/, employers]]);
  check.pool = pool;
  check.log = log;
  const rows = await run(() => analytics.loadPayingEmployers(session));
  assertStatements(log, [...OPEN, '1: SELECT * FROM admin_analytics_paying_employers()', RECORD, ...CLOSE]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.analytics_paying_employers',
    categories: ['analytics', 'billing'],
    subject_user_ids: [EMPLOYER_1, fakeUuid(0xe2)],
    record_ids: [],
    result_count: 2,
    field_names: [],
    request_id: REQUEST_ID,
  }]);
  assert.deepEqual(rows.map((row) => row.employerId), [EMPLOYER_1, fakeUuid(0xe2)]);
}

// --- The access history ------------------------------------------------------
const superadmin = { ...session, role: 'admin_superadmin', groups: ['admin_superadmin'] };
const HISTORY = /jale_audit\.history_search/;
const HISTORY_SQL = normalizeSql(audit.HISTORY_SEARCH_SQL);

// One history_search row: every column, NULL unless the source fills it.
function historyRow(n, overrides = {}) {
  const at = new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - n * 1000);
  return {
    source: 'event', seq: String(1000 - n), entry_id: fakeUuid(0x9000 + n), occurred_at: at,
    cursor: `${at.toISOString().slice(0, 19)}.000000Z`, kind: 'read', outcome: 'allowed',
    actor_kind: 'admin', actor_id: ADMIN_ID, actor_role: 'admin_ops', actor_session: SESSION_ID,
    actor_email: 'ops-admin@example.test', channel: 'admin', surface: 'admin.case_detail',
    categories: ['cases'], subject_user_ids: [WORKER_1], record_type: 'admin_case', record_ids: [CASE_1],
    result_count: 1, field_names: [], purpose_kind: 'case', purpose_id: CASE_1, reason: null,
    link_expires_at: null, part: null, parts: null, table_name: null, operation: null, row_count: null,
    changed_fields: null, context_status: null, action: null, target_type: null, target_id: null,
    summary: null, pii_reveal: null, request_id: REQUEST_ID,
    ...overrides,
  };
}

assert.match(
  HISTORY_SQL,
  /FROM jale_audit\.history_search\(\$1::jsonb, \$2::jsonb, \$3, \$4::timestamptz\) AS h /,
  'the actor, the filter, the limit and the cursor are bound, never interpolated',
);
assert.match(
  HISTORY_SQL,
  /to_char\(h\.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS cursor/,
  'each row carries its time with microseconds, for the next page',
);
assert.match(
  HISTORY_SQL,
  /ORDER BY h\.occurred_at DESC, h\.source, h\.seq DESC, h\.entry_id$/,
  'the rows keep the function order, newest first',
);
assert.doesNotMatch(HISTORY_SQL, /\bh\.\*|db_login|db_pid/, 'the page selects only the columns it shows');

// Any role but superadmin is refused: one denied attempt, in its own
// transaction, naming no search input, and no search.
for (const role of ['admin_ops', 'admin_readonly']) {
  const { pool, log } = database([]);
  check.pool = pool;
  check.log = log;
  const result = await audit.loadAccessHistory(
    { ...session, role, groups: [role] },
    { subject: WORKER_1, record: CASE_1, actor: ADMIN_ID, category: 'contact_details' },
  );
  assert.deepEqual(result, { status: 'forbidden' });
  assertStatements(log, ['1: <connect>', '1: BEGIN', RECORD, '1: COMMIT', '1: <commit_completed>', '1: <release>']);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'attempt',
    outcome: 'denied',
    ...actor,
    actor_role: role,
    surface: 'admin.access_history',
    categories: ['audit_history'],
    subject_user_ids: [],
    record_ids: [],
    result_count: 0,
    field_names: [],
    purpose_kind: 'audit_review',
    request_id: REQUEST_ID,
  }]);
  assert.doesNotMatch(JSON.stringify(log), new RegExp(`${WORKER_1}|${CASE_1}|contact_details`), 'search inputs are never recorded');
}

// The local preview never searches: history_search needs an admin id.
{
  const { pool, log } = database([]);
  check.pool = pool;
  check.log = log;
  const preview = { preview: true, sub: 'local-preview-admin', groups: [] };
  assert.deepEqual(await audit.loadAccessHistory({ ...preview, role: 'admin_superadmin' }, {}), { status: 'preview' });
  assert.deepEqual(await audit.loadAccessHistory({ ...preview, role: 'admin_ops' }, {}), { status: 'forbidden' });
  assert.deepEqual(log, [], 'the preview touches no database');
}

// An invalid filter is shown back: no search and no event.
{
  const { pool, log } = database([]);
  check.pool = pool;
  check.log = log;
  const result = await audit.loadAccessHistory(superadmin, { subject: 'not-an-id', category: 'cases', from: '2026-10-01T00:00' });
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.query.problems, ['subject', 'from']);
  assert.equal(result.query.values.subject, 'not-an-id');
  assert.deepEqual(log, [], 'an invalid filter never reaches the database');
}

// A superadmin's search: one transaction around history_search, which records
// the search itself. The page records nothing of its own, and the entries come
// back only after COMMIT.
{
  const rows = [
    historyRow(1),
    historyRow(2, {
      source: 'legacy', seq: '12', kind: null, outcome: null, actor_id: null, actor_session: null,
      channel: null, surface: null, categories: null, subject_user_ids: null, record_type: null,
      record_ids: null, result_count: null, field_names: null, purpose_kind: null, purpose_id: null,
      action: 'resolve_case', target_type: 'admin_case', target_id: CASE_1,
      summary: 'admin_ops requested resolve_case for admin_case.', pii_reveal: false, request_id: null,
    }),
  ];
  const { pool, log } = database([[HISTORY, rows]]);
  check.pool = pool;
  check.log = log;
  const result = await run(() => audit.loadAccessHistory(superadmin, {
    subject: WORKER_1.toUpperCase(),
    category: 'contact_details',
    from: '2026-10-01T00:00:00.000Z',
  }));
  assertStatements(log, [...OPEN, `1: ${HISTORY_SQL}`, ...CLOSE]);
  assert.equal(recordedEvents(log).length, 0, 'history_search records the search; the page writes no event itself');

  const [pActor, pFilter, limit, before] = log[2].params;
  assert.deepEqual(Object.entries(JSON.parse(pActor)), [
    ['actor_id', ADMIN_ID],
    ['actor_role', 'admin_superadmin'],
    ['actor_session', SESSION_ID],
    ['request_id', REQUEST_ID],
  ], 'p_actor holds exactly the four keys history_search accepts');
  assert.deepEqual(JSON.parse(pFilter), {
    subject_user_id: WORKER_1,
    from: '2026-10-01T00:00:00.000Z',
    category: 'contact_details',
  });
  assert.equal(limit, audit.ACCESS_HISTORY_PAGE_SIZE);
  assert.equal(audit.ACCESS_HISTORY_PAGE_SIZE, 50, 'a page stays short enough to render without virtualizing');
  assert.equal(before, null);

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.entries.map((entry) => [entry.key, entry.source]), [
    [`event:${fakeUuid(0x9001)}`, 'event'],
    [`legacy:${fakeUuid(0x9002)}`, 'legacy'],
  ]);
  assert.equal(result.query.filter.subjectUserId, WORKER_1);
  assert.equal('nextBefore' in result, false, 'a short page has no older page');
}

// A full page offers the older page from its last row's microsecond cursor.
// Ties can make it longer than the limit: every row is shown, none dropped.
{
  const length = audit.ACCESS_HISTORY_PAGE_SIZE + 2;
  const rows = Array.from({ length }, (_, index) => historyRow(index + 1));
  rows[length - 1] = { ...rows[length - 1], cursor: '2026-10-01T11:58:18.000123Z' };
  const { pool, log } = database([[HISTORY, rows]]);
  check.pool = pool;
  check.log = log;
  const result = await audit.loadAccessHistory(superadmin, { before: '2026-10-01T12:00:00.123456Z' });
  assert.equal(log[2].params[3], '2026-10-01T12:00:00.123456Z', 'the cursor is bound as the text it arrived as');
  assert.deepEqual(JSON.parse(log[2].params[1]), {});
  assert.equal(result.entries.length, length, 'every row the function returned is shown');
  assert.equal(result.nextBefore, '2026-10-01T11:58:18.000123Z');
  assert.equal(result.query.before, '2026-10-01T12:00:00.123456Z');
}

// A failed search rolls back and shows nothing. The failure is then recorded
// as a failed attempt that names no search input.
{
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (HISTORY.test(sql)) throw new Error('search failed');
      return {};
    },
  });
  check.pool = pool;
  await assert.rejects(
    () => audit.loadAccessHistory(superadmin, { subject: WORKER_1, record: CASE_1, category: 'contact_details' }),
    /search failed/,
  );
  const lines = statements(log);
  assert.deepEqual(lines.slice(-7), [
    '1: ROLLBACK',
    '1: <release>',
    '2: <connect>',
    '2: BEGIN',
    `2: ${RECORD_EVENT_SQL}`,
    '2: COMMIT',
    '2: <release>',
  ]);
  assert.equal(lines.includes('1: COMMIT'), false);
  const [attempt] = recordedEvents(log.filter((entry) => entry.connection === 2));
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.surface], ['attempt', 'failed', 'admin.access_history']);
  assert.doesNotMatch(JSON.stringify(attempt), new RegExp(`${WORKER_1}|${CASE_1}|contact_details`), 'search inputs are never recorded');
}

// --- A failed read records a failed attempt, after its client is released ----
// Each page's read fails on its own connection: at its first query, at its
// access record, or at COMMIT. The transaction rolls back and its client is
// released; then one failed attempt is written in a transaction of its own,
// on another connection, and the page still fails with the original error.
// Only a failed access record emits AuditWriteFailed.
const FAILED_READS = [
  {
    name: 'the cases list',
    loader: () => cases.loadCasesList(session),
    answers: [
      [/FROM admin_cases c .* LIMIT \$1$/, [caseRow(CASE_1)]],
      [/^SELECT COUNT\(\*\) AS count FROM admin_cases$/, [{ count: '1' }]],
    ],
    attempt: { ...actor, surface: 'admin.cases_list', categories: ['cases'], record_ids: [] },
  },
  {
    name: 'a case detail',
    loader: () => cases.loadCaseDetail(session, CASE_1),
    answers: [[/WHERE c\.id = \$1/, [caseRow(CASE_1)]], [/FROM admin_case_events/, []]],
    attempt: { ...actor, surface: 'admin.case_detail', categories: ['cases'], record_type: 'admin_case', record_ids: [CASE_1] },
  },
  {
    name: 'the dashboard',
    loader: () => cases.loadAdminDashboard(session),
    answers: [
      [/^SELECT COUNT\(\*\) AS count FROM admin_cases c WHERE/, [{ count: '1' }]],
      [/FROM admin_cases c .* LIMIT \$1$/, [caseRow(CASE_1)]],
      [/jale_audit\.reveal_count/, [{ count: '0' }]],
      [/admin_identity_lockouts/, [lockoutRow(1, 'lockout')]],
    ],
    attempt: { ...actor, surface: 'admin.dashboard', categories: ['cases', 'verifications'], record_ids: [] },
  },
  {
    name: 'the lockout list',
    loader: () => lockouts.loadLockouts(session),
    answers: [[/admin_identity_lockouts/, [lockoutRow(1, 'lockout')]]],
    attempt: { ...actor, surface: 'admin.lockouts', categories: ['verifications'], record_ids: [] },
  },
  {
    name: 'the paying-employers list',
    loader: () => analytics.loadPayingEmployers(session),
    answers: [[/admin_analytics_paying_employers/, [{
      employer_id: EMPLOYER_1, display_name: 'Synthetic Co', plan_code: 'pro', status: 'active',
      current_period_end: null, cancel_at_period_end: false,
    }]]],
    attempt: { ...actor, surface: 'admin.analytics_paying_employers', categories: ['analytics', 'billing'], record_ids: [] },
  },
  {
    name: 'an access history search',
    // history_search writes the search's own record inside the function, so
    // the page has no record write of its own to fail.
    loader: () => audit.loadAccessHistory(superadmin, { subject: WORKER_1, category: 'contact_details' }),
    answers: [[HISTORY, [historyRow(1)]]],
    attempt: {
      ...actor,
      actor_role: 'admin_superadmin',
      surface: 'admin.access_history',
      categories: ['audit_history'],
      record_ids: [],
      purpose_kind: 'audit_review',
    },
    points: ['query', 'commit'],
  },
];

for (const { name, loader, answers, attempt, points = ['query', 'record', 'commit'] } of FAILED_READS) {
  for (const point of points) {
    const failure = new Error(`${point} failed`);
    let queried = false;
    const { pool, log } = createFakePool({
      respond: ({ sql, connection }) => {
        if (connection === 1) {
          if (point === 'query' && !queried && sql !== 'BEGIN' && sql !== 'ROLLBACK') {
            queried = true;
            throw failure;
          }
          if (point === 'record' && sql === RECORD_EVENT_SQL) throw failure;
          if (point === 'commit' && sql === 'COMMIT') throw failure;
        }
        for (const [match, rows] of answers) {
          if (match.test(sql)) return { rows };
        }
        return {};
      },
    });
    check.pool = pool;
    const { lines: output } = await captureConsole(async () => {
      await assert.rejects(loader, (error) => error === failure, `${name}: the page fails with the original error (${point})`);
    });

    const lines = statements(log);
    const released = lines.indexOf('1: <release>');
    assert.deepEqual(lines.slice(released - 1, released + 1), ['1: ROLLBACK', '1: <release>'], `${name}: rolled back and released (${point})`);
    assert.deepEqual(lines.slice(released + 1), [
      '2: <connect>',
      '2: BEGIN',
      `2: ${RECORD_EVENT_SQL}`,
      '2: COMMIT',
      '2: <release>',
    ], `${name}: the attempt follows the release, on its own connection (${point})`);
    assert.deepEqual(recordedEvents(log.filter((entry) => entry.connection === 2)), [{
      kind: 'attempt',
      outcome: 'failed',
      subject_user_ids: [],
      result_count: 0,
      field_names: [],
      request_id: REQUEST_ID,
      ...attempt,
    }], `${name}: one failed attempt (${point})`);

    const writeFailed = output.log.filter(([line]) => typeof line === 'string' && line.includes('"AuditWriteFailed"'));
    assert.equal(writeFailed.length, point === 'record' ? 1 : 0, `${name}: AuditWriteFailed only for a failed record (${point})`);
    assert.deepEqual(output.error, [], `${name}: nothing is lost (${point})`);
  }
}

// When the attempt cannot reach the database either, it goes to the fallback
// log: a failed read, then a failed attempt write; and a database that cannot
// be reached at all.
{
  process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';
  const fallbackLines = () => check.cloudwatch.sent
    .filter((command) => command.name === 'PutLogEvents')
    .map((command) => JSON.parse(command.input.logEvents[0].message));

  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  const failure = new Error('query failed');
  const { pool, log } = createFakePool({
    respond: ({ sql, connection }) => {
      if (connection === 1 && /FROM admin_cases c/.test(sql)) throw failure;
      if (connection === 2 && sql === RECORD_EVENT_SQL) throw new Error('attempt write failed');
      return {};
    },
  });
  check.pool = pool;
  const { lines: output } = await captureConsole(async () => {
    await assert.rejects(() => cases.loadCasesList(session), (error) => error === failure);
  });
  assert.deepEqual(statements(log).slice(-3), [`2: ${RECORD_EVENT_SQL}`, '2: ROLLBACK', '2: <release>']);
  assert.deepEqual(
    fallbackLines().map((line) => [line.origin, line.kind, line.outcome, line.surface, line.actor_id, line.request_id]),
    [['admin', 'attempt', 'failed', 'admin.cases_list', ADMIN_ID, REQUEST_ID]],
  );
  assert.deepEqual(output.error, [], 'the fallback took the attempt: nothing is lost');

  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  const unreachable = new Error('pool unavailable');
  check.pool = unreachable;
  await captureConsole(async () => {
    await assert.rejects(() => lockouts.loadLockouts(session), (error) => error === unreachable);
  });
  assert.deepEqual(
    fallbackLines().map((line) => [line.kind, line.outcome, line.surface]),
    [['attempt', 'failed', 'admin.lockouts']],
  );
  delete process.env.AUDIT_FALLBACK_LOG_GROUP;
}

console.log('admin page loader checks passed');
