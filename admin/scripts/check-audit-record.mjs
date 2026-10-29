// Checks the admin audit helpers (src/lib/server/audit/**): the record helpers,
// the read transaction's order, the 500-split, the preview no-op, and the
// fallback channel. The pool and the CloudWatch Logs client are fakes.
import assert from 'node:assert/strict';
import {
  RECORD_EVENT_SQL,
  captureConsole,
  compileAdminSources,
  createFakePool,
  fakeUuid,
  recordedEvents,
  statements,
} from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'audit-record',
  sources: ['src/lib/server/audit/record.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
  },
});

const record = await load('src/lib/server/audit/record.ts');
const codes = await load('src/lib/server/audit/codes.ts');
const fallback = await load('src/lib/server/audit/fallback.ts');

const check = (globalThis.__adminCheck = {});
const ADMIN_ID = fakeUuid(0xd1);
const SESSION_ID = fakeUuid(0xd2);
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const CASE_ID = fakeUuid(0xf1);
const SUBJECT_ID = fakeUuid(0xa2);
const REASON = 'Synthetic callback reason written for this check.';

const opsSession = {
  sub: 'check-admin-sub',
  email: 'ops-admin@example.test',
  role: 'admin_ops',
  groups: ['admin_ops'],
  sessionId: SESSION_ID,
  adminUserId: ADMIN_ID,
  requestId: REQUEST_ID,
};
const previewSession = {
  preview: true,
  sub: 'local-preview-admin',
  role: 'admin_ops',
  groups: ['admin_ops'],
};
const revealEvent = {
  surface: 'admin.case_detail.reveal',
  categories: ['contact_details'],
  subjectUserIds: [SUBJECT_ID],
  recordType: 'admin_case',
  recordIds: [CASE_ID],
  fieldNames: ['full_name', 'phone', 'email'],
  purpose: { kind: 'reveal', reason: REASON },
};

function emfLines(lines, metric) {
  return lines
    .filter((args) => args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{'))
    .map((args) => JSON.parse(args[0]))
    .filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Metrics?.some((m) => m.Name === metric));
}

// --- Code lists ------------------------------------------------------------
assert.deepEqual([...codes.AUDIT_CATEGORIES], [
  'application_answers', 'contact_details', 'documents', 'trust_assessments', 'conversations',
  'profile', 'posts', 'saved_application_details', 'cases', 'verifications', 'analytics',
  'billing', 'audit_history', 'problem_reports', 'admin_access',
]);
assert.deepEqual([...codes.AUDIT_RECORD_TYPES], [
  'job_application', 'worker_document', 'worker_post', 'job_conversation', 'admin_case',
  'identity_challenge', 'user', 'problem_report', 'admin_user',
]);
assert.deepEqual([...codes.AUDIT_PURPOSE_KINDS], ['job', 'case', 'verification', 'reveal', 'self', 'audit_review']);
for (const surface of codes.ADMIN_SURFACES) {
  assert.match(surface, /^admin(\.[a-z][a-z0-9_]*){1,3}$/, `${surface} must be an admin surface code`);
  assert.ok(surface.length <= 100);
}
for (const surface of [
  'admin.dashboard', 'admin.cases_list', 'admin.case_detail', 'admin.case_detail.reveal', 'admin.lockouts',
  'admin.analytics_paying_employers', 'admin.access_history', 'admin.session', 'admin.sessions_revoke',
  // The Employers analytics lists that name employers.
  'admin.analytics_slowest_employers', 'admin.analytics_stale_jobs',
  // Phase 5: the Companies panel and a company's members.
  'admin.analytics_companies', 'admin.analytics_company_members',
  // The problem-report inbox's surfaces, registered with the audit codes.
  'admin.reports_list', 'admin.report_detail', 'admin.report_contact_reveal', 'admin.report_screenshot',
  'admin.report_status', 'admin.report_note', 'admin.report_settings',
  // Sprint 28: the Admins page and its actions (K1).
  'admin.admins_list', 'admin.admin_invite', 'admin.admin_resend_invite', 'admin.admin_role_change',
  'admin.admin_deactivate', 'admin.admin_reactivate',
  // Sprint 28: the Inbox, the support conversation, lockout detail, and their actions (K2).
  'admin.inbox', 'admin.support_conversation', 'admin.lockout_detail',
  'admin.inbox.reply', 'admin.inbox.request_info', 'admin.inbox.resolve', 'admin.inbox.reveal_phone',
  'admin.inbox.open_media', 'admin.inbox.reset_lockout', 'admin.inbox.open_support',
]) {
  assert.ok(codes.ADMIN_SURFACES.includes(surface), `${surface} must be registered`);
}
// The Admins page's surfaces (K1.5) build valid events in admin_access,
// naming admin_user records and field names only.
for (const surface of ['admin.admins_list', 'admin.admin_invite', 'admin.admin_resend_invite', 'admin.admin_role_change', 'admin.admin_deactivate', 'admin.admin_reactivate']) {
  const [payload] = record.buildAuditEventPayloads({
    kind: surface === 'admin.admins_list' ? 'read' : 'action',
    outcome: surface === 'admin.admins_list' ? 'allowed' : 'done',
    actor: { actor_kind: 'admin', actor_id: ADMIN_ID, actor_role: 'admin_superadmin', actor_session: SESSION_ID },
    event: { surface, categories: ['admin_access'], recordType: 'admin_user', recordIds: [fakeUuid(0xd9)], fieldNames: ['role'] },
    requestId: REQUEST_ID,
  });
  assert.deepEqual(
    [payload.surface, payload.categories, payload.record_type, payload.record_ids, payload.field_names],
    [surface, ['admin_access'], 'admin_user', [fakeUuid(0xd9)], ['role']],
  );
}
assert.equal(record.RECORD_EVENT_SQL, RECORD_EVENT_SQL);
assert.equal(fallback.AUDIT_FALLBACK_LOG_GROUP_ENV, 'AUDIT_FALLBACK_LOG_GROUP');
assert.equal(fallback.AUDIT_METRIC_NAMESPACE, 'Jale/Audit');

// --- recordAdminAccess: one exact read event on the caller's client -------
{
  const { pool, log } = createFakePool({ respond: ({ sql }) => (sql === RECORD_EVENT_SQL ? { rows: [{ seq: '7' }] } : {}) });
  const client = await pool.connect();
  await record.recordAdminAccess(opsSession, revealEvent, client);
  assert.deepEqual(statements(log), ['1: <connect>', `1: ${RECORD_EVENT_SQL}`]);
  const [payload] = recordedEvents(log);
  const expected = {
    kind: 'read',
    outcome: 'allowed',
    actor_kind: 'admin',
    actor_id: ADMIN_ID,
    actor_role: 'admin_ops',
    actor_session: SESSION_ID,
    channel: 'admin',
    surface: 'admin.case_detail.reveal',
    categories: ['contact_details'],
    subject_user_ids: [SUBJECT_ID],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 1,
    field_names: ['full_name', 'phone', 'email'],
    purpose_kind: 'reveal',
    reason: REASON,
    request_id: REQUEST_ID,
  };
  assert.deepEqual(payload, expected);
  assert.equal(log[1].params[0], JSON.stringify(expected), 'the payload keeps one canonical key order');
}

// A case purpose names its case; explicit counts and link expiry pass through.
{
  const { pool, log } = createFakePool();
  const client = await pool.connect();
  await record.recordAdminAccess(opsSession, {
    surface: 'admin.case_detail',
    categories: ['cases', 'cases'],
    subjectUserIds: [SUBJECT_ID, SUBJECT_ID, fakeUuid(0xa3)],
    recordType: 'admin_case',
    recordIds: [CASE_ID],
    purpose: { kind: 'case', id: CASE_ID },
    linkExpiresAt: new Date('2026-10-02T12:15:00.000Z'),
    resultCount: 4,
  }, client);
  assert.deepEqual(recordedEvents(log)[0], {
    kind: 'read',
    outcome: 'allowed',
    actor_kind: 'admin',
    actor_id: ADMIN_ID,
    actor_role: 'admin_ops',
    actor_session: SESSION_ID,
    channel: 'admin',
    surface: 'admin.case_detail',
    categories: ['cases'],
    subject_user_ids: [SUBJECT_ID, fakeUuid(0xa3)],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 4,
    field_names: [],
    purpose_kind: 'case',
    purpose_id: CASE_ID,
    link_expires_at: '2026-10-02T12:15:00.000Z',
    request_id: REQUEST_ID,
  });
}

// Over 500 ids: parts share the request id; part 1 carries the count.
{
  const { pool, log } = createFakePool();
  const client = await pool.connect();
  const recordIds = Array.from({ length: 1001 }, (_, i) => fakeUuid(0x100000 + i));
  await record.recordAdminAccess(opsSession, {
    surface: 'admin.lockouts',
    categories: ['verifications'],
    recordType: 'identity_challenge',
    recordIds,
  }, client);
  const parts = recordedEvents(log);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => [p.part, p.parts, p.record_ids.length, p.result_count]), [
    [1, 3, 500, 1001],
    [2, 3, 500, 0],
    [3, 3, 1, 0],
  ]);
  assert.deepEqual(parts.flatMap((p) => p.record_ids), recordIds);
  assert.ok(parts.every((p) => p.request_id === REQUEST_ID));
}

// Invalid events fail closed before any write, and say which key, not the value.
for (const [label, event, message] of [
  ['a non-UUID subject', { ...revealEvent, subjectUserIds: ['not-a-uuid'] }, /invalid subject_user_ids/],
  ['record ids without a record type', { ...revealEvent, recordType: undefined }, /invalid record_type/],
  ['a 501-character reason', { ...revealEvent, purpose: { kind: 'reveal', reason: 'r'.repeat(501) } }, /invalid reason/],
  ['an empty reason', { ...revealEvent, purpose: { kind: 'reveal', reason: '   ' } }, /invalid reason/],
  ['an unregistered surface', { ...revealEvent, surface: 'admin.unknown_page' }, /invalid surface/],
  ['no categories', { ...revealEvent, categories: [] }, /invalid categories/],
  ['an unknown category', { ...revealEvent, categories: ['contacts'] }, /invalid categories/],
  ['a malformed field name', { ...revealEvent, fieldNames: ['Full Name'] }, /invalid field_names/],
  ['a case purpose without a case id', { ...revealEvent, purpose: { kind: 'case', id: 'case-1' } }, /invalid purpose_id/],
  ['a negative result count', { ...revealEvent, resultCount: -1 }, /invalid result_count/],
]) {
  const { pool, log } = createFakePool();
  const client = await pool.connect();
  const { lines } = await captureConsole(async () => {
    await assert.rejects(() => record.recordAdminAccess(opsSession, event, client), message, label);
  });
  assert.equal(recordedEvents(log).length, 0, `${label}: nothing is written`);
  assert.equal(emfLines(lines.log, 'AuditWriteFailed').length, 1, `${label}: AuditWriteFailed is emitted`);
  assert.doesNotMatch(JSON.stringify(lines), /not-a-uuid|rrrrrrrrrr|case-1|Full Name/, `${label}: no value is printed`);
}

// A database failure rethrows (the request fails) and emits AuditWriteFailed.
{
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (sql === RECORD_EVENT_SQL) throw Object.assign(new Error('record_event: invalid reason'), { code: '22023' });
      return {};
    },
  });
  const client = await pool.connect();
  const { lines } = await captureConsole(async () => {
    await assert.rejects(() => record.recordAdminAccess(opsSession, revealEvent, client), /record_event/);
  });
  assert.equal(statements(log).at(-1), `1: ${RECORD_EVENT_SQL}`);
  const [metric] = emfLines(lines.log, 'AuditWriteFailed');
  assert.deepEqual(metric._aws.CloudWatchMetrics, [{
    Namespace: 'Jale/Audit',
    Dimensions: [['Surface']],
    Metrics: [{ Name: 'AuditWriteFailed', Unit: 'Count' }],
  }]);
  assert.equal(metric.Surface, 'admin.case_detail.reveal');
  assert.equal(metric.AuditWriteFailed, 1);
  assert.equal(lines.error.length, 0);
}

// The preview session never writes; a real session without ids fails closed.
{
  const { pool, log } = createFakePool();
  const client = await pool.connect();
  await record.recordAdminAccess(previewSession, revealEvent, client);
  await record.recordAdminAction(previewSession, { surface: 'admin.case_detail.resolve_case', categories: ['cases'] }, client);
  assert.deepEqual(statements(log), ['1: <connect>']);

  const { sessionId: _dropped, ...noIds } = opsSession;
  await captureConsole(async () => {
    await assert.rejects(() => record.recordAdminAccess(noIds, revealEvent, client), /admin session/);
    await assert.rejects(() => record.recordAdminAccess({ ...opsSession, adminUserId: 'admin-1' }, revealEvent, client), /admin session/);
  });
  assert.equal(recordedEvents(log).length, 0);
}

// --- recordAdminAction: an action event with no free text ------------------
{
  const { pool, log } = createFakePool();
  const client = await pool.connect();
  await record.recordAdminAction(opsSession, {
    surface: 'admin.sessions_revoke',
    categories: ['admin_access'],
    recordType: 'admin_user',
    recordIds: [fakeUuid(0xd9)],
    resultCount: 3,
  }, client);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'action',
    outcome: 'done',
    actor_kind: 'admin',
    actor_id: ADMIN_ID,
    actor_role: 'admin_ops',
    actor_session: SESSION_ID,
    channel: 'admin',
    surface: 'admin.sessions_revoke',
    categories: ['admin_access'],
    subject_user_ids: [],
    record_type: 'admin_user',
    record_ids: [fakeUuid(0xd9)],
    result_count: 3,
    field_names: [],
    request_id: REQUEST_ID,
  }]);
}

// --- withAdminReadTransaction: BEGIN -> reads -> event -> COMMIT -> return --
{
  const { pool, log } = createFakePool({
    respond: async ({ sql, log: entries }) => {
      if (sql === 'COMMIT') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        entries.push({ connection: 1, op: 'commit_completed' });
      }
      return sql === 'SELECT 1 AS shown' ? { rows: [{ shown: 1 }] } : {};
    },
  });
  check.pool = pool;
  const value = await record.withAdminReadTransaction(opsSession, async (client) => {
    const result = await client.query('SELECT 1 AS shown');
    await record.recordAdminAccess(opsSession, revealEvent, client);
    return result.rows[0].shown;
  });
  log.push({ connection: '-', op: 'returned' });
  assert.equal(value, 1);
  assert.deepEqual(statements(log), [
    '1: <connect>',
    '1: BEGIN',
    '1: SELECT 1 AS shown',
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: <commit_completed>',
    '1: <release>',
    '-: <returned>',
  ]);
}

// A failed event write rolls back and nothing is returned.
{
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (sql === RECORD_EVENT_SQL) throw new Error('connection terminated');
      return {};
    },
  });
  check.pool = pool;
  await captureConsole(async () => {
    await assert.rejects(() => record.withAdminReadTransaction(opsSession, async (client) => {
      await client.query('SELECT 1 AS shown');
      await record.recordAdminAccess(opsSession, revealEvent, client);
      return 'data';
    }), /connection terminated/);
  });
  assert.deepEqual(statements(log), [
    '1: <connect>',
    '1: BEGIN',
    '1: SELECT 1 AS shown',
    `1: ${RECORD_EVENT_SQL}`,
    '1: ROLLBACK',
    '1: <release>',
  ]);
}

// A failed ROLLBACK destroys the connection; the original error still wins.
{
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (sql === 'SELECT 1 AS shown') throw new Error('read failed');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return {};
    },
  });
  check.pool = pool;
  await assert.rejects(
    () => record.withAdminReadTransaction(opsSession, (client) => client.query('SELECT 1 AS shown')),
    /read failed/,
  );
  assert.deepEqual(statements(log), ['1: <connect>', '1: BEGIN', '1: SELECT 1 AS shown', '1: ROLLBACK', '1: <release destroyed>']);
}

// A real session without ids is refused before a connection is taken; the
// preview session reads without writing.
{
  const { pool, log } = createFakePool();
  check.pool = pool;
  const { adminUserId: _dropped, ...noIds } = opsSession;
  await assert.rejects(() => record.withAdminReadTransaction(noIds, async () => 'data'), /admin session/);
  assert.deepEqual(statements(log), []);

  const value = await record.withAdminReadTransaction(previewSession, async (client) => {
    await record.recordAdminAccess(previewSession, revealEvent, client);
    return 'preview-data';
  });
  assert.equal(value, 'preview-data');
  assert.deepEqual(statements(log), ['1: <connect>', '1: BEGIN', '1: COMMIT', '1: <release>']);
}

// --- recordAdminAttempt: its own transaction on its own connection --------
{
  const { pool, log } = createFakePool();
  check.pool = pool;
  await record.recordAdminAttempt(opsSession, { ...revealEvent, outcome: 'denied' });
  assert.deepEqual(statements(log), ['1: <connect>', '1: BEGIN', `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  const [payload] = recordedEvents(log);
  assert.equal(payload.kind, 'attempt');
  assert.equal(payload.outcome, 'denied');
  assert.equal(payload.reason, REASON, 'a denied reveal keeps its reason');
  assert.equal(payload.request_id, REQUEST_ID);
}

// No session: an anonymous attempt with no actor ids.
{
  const { pool, log } = createFakePool();
  check.pool = pool;
  await record.recordAdminAttempt(null, {
    surface: 'admin.report_detail',
    categories: ['problem_reports'],
    outcome: 'denied',
  });
  const [payload] = recordedEvents(log);
  assert.deepEqual(Object.keys(payload).filter((key) => key.startsWith('actor')), ['actor_kind']);
  assert.equal(payload.actor_kind, 'anonymous');
  assert.match(payload.request_id, /^[0-9a-f-]{36}$/);
}

// The preview session never writes an attempt.
{
  const { pool, log } = createFakePool();
  check.pool = pool;
  await record.recordAdminAttempt(previewSession, { ...revealEvent, outcome: 'failed' });
  assert.deepEqual(statements(log), []);
}

// --- The fallback -----------------------------------------------------------
const GROUP = 'audit-fallback-check-group';
process.env.AUDIT_FALLBACK_LOG_GROUP = GROUP;
check.cloudwatch = { clients: [], sent: [], behavior: undefined };

// The database fails: one JSON line goes to the fallback group, and
// AuditFallbackEvents is emitted. The attempt itself never throws.
let streamName;
{
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (sql === RECORD_EVENT_SQL) throw new Error('could not write: terminating connection');
      return {};
    },
  });
  check.pool = pool;
  const before = Date.now();
  const { lines } = await captureConsole(() => record.recordAdminAttempt(opsSession, { ...revealEvent, outcome: 'failed' }));
  assert.deepEqual(statements(log), ['1: <connect>', '1: BEGIN', `1: ${RECORD_EVENT_SQL}`, '1: ROLLBACK', '1: <release>']);

  const sent = check.cloudwatch.sent;
  assert.deepEqual(sent.map((command) => command.name), ['CreateLogStream', 'PutLogEvents']);
  streamName = sent[0].input.logStreamName;
  assert.match(streamName, /^admin\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(sent[0].input, { logGroupName: GROUP, logStreamName: streamName });
  assert.equal(sent[1].input.logGroupName, GROUP);
  assert.equal(sent[1].input.logStreamName, streamName);
  assert.equal(sent[1].input.logEvents.length, 1, 'one PutLogEvents per event');
  const [logEvent] = sent[1].input.logEvents;
  assert.ok(logEvent.timestamp >= before && logEvent.timestamp <= Date.now());
  const line = JSON.parse(logEvent.message);
  assert.deepEqual(Object.keys(line).slice(0, 3), ['origin', 'occurred_at', 'kind']);
  assert.equal(line.origin, 'admin');
  assert.equal(new Date(line.occurred_at).getTime(), logEvent.timestamp);
  const { origin: _origin, occurred_at: _at, ...payload } = line;
  assert.deepEqual(payload, {
    kind: 'attempt',
    outcome: 'failed',
    actor_kind: 'admin',
    actor_id: ADMIN_ID,
    actor_role: 'admin_ops',
    actor_session: SESSION_ID,
    channel: 'admin',
    surface: 'admin.case_detail.reveal',
    categories: ['contact_details'],
    subject_user_ids: [SUBJECT_ID],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 1,
    field_names: ['full_name', 'phone', 'email'],
    purpose_kind: 'reveal',
    reason: REASON,
    request_id: REQUEST_ID,
  });
  assert.doesNotMatch(logEvent.message, /terminating connection/, 'no error text reaches the line');

  const [metric] = emfLines(lines.log, 'AuditFallbackEvents');
  assert.deepEqual(metric._aws.CloudWatchMetrics, [{
    Namespace: 'Jale/Audit',
    Dimensions: [[]],
    Metrics: [{ Name: 'AuditFallbackEvents', Unit: 'Count' }],
  }]);
  assert.equal(metric.AuditFallbackEvents, 1);
  assert.equal(lines.error.length, 0);
}

// The stream is per container: a second fallback reuses it.
{
  check.cloudwatch.sent = [];
  check.pool = new Error('pool unavailable');
  await captureConsole(() => record.recordAdminAttempt(null, {
    surface: 'admin.session',
    categories: ['admin_access'],
    outcome: 'failed',
  }));
  assert.deepEqual(check.cloudwatch.sent.map((command) => command.name), ['PutLogEvents']);
  assert.equal(check.cloudwatch.sent[0].input.logStreamName, streamName);
}

// Both fail: one AuditFallbackFailed line on console.error, as a single JSON
// argument, with codes and ids only (no reason, no error text).
{
  check.cloudwatch.sent = [];
  check.cloudwatch.behavior = (command) => (command.name === 'PutLogEvents' ? new Error('ThrottlingException: rate exceeded') : undefined);
  check.pool = new Error('pool unavailable');
  const { lines } = await captureConsole(() => record.recordAdminAttempt(opsSession, { ...revealEvent, outcome: 'denied' }));
  assert.equal(lines.error.length, 1);
  assert.equal(lines.error[0].length, 1, 'a single argument, so the line stays valid EMF');
  const line = JSON.parse(lines.error[0][0]);
  assert.deepEqual(line._aws.CloudWatchMetrics, [{
    Namespace: 'Jale/Audit',
    Dimensions: [[]],
    Metrics: [{ Name: 'AuditFallbackFailed', Unit: 'Count' }],
  }]);
  assert.equal(line.AuditFallbackFailed, 1);
  assert.equal(line.origin, 'admin');
  assert.equal(line.surface, 'admin.case_detail.reveal');
  assert.equal(line.outcome, 'denied');
  assert.equal(line.actor_id, ADMIN_ID);
  assert.equal(line.request_id, REQUEST_ID);
  assert.deepEqual(line.record_ids, [CASE_ID]);
  assert.equal('reason' in line, false, 'the reason never reaches the function log');
  assert.doesNotMatch(lines.error[0][0], /Synthetic callback|ThrottlingException|pool unavailable/);
  assert.equal(emfLines(lines.log, 'AuditFallbackEvents').length, 0);
  check.cloudwatch.behavior = undefined;
}

// An existing stream is fine; another CreateLogStream error is retried next time.
{
  process.env.AUDIT_FALLBACK_LOG_GROUP = `${GROUP}-existing`;
  check.cloudwatch.sent = [];
  check.cloudwatch.behavior = (command) => (command.name === 'CreateLogStream'
    ? Object.assign(new Error('The specified log stream already exists'), { name: 'ResourceAlreadyExistsException' })
    : undefined);
  check.pool = new Error('pool unavailable');
  const existing = await captureConsole(() => record.recordAdminAttempt(null, { surface: 'admin.session', categories: ['admin_access'], outcome: 'failed' }));
  assert.deepEqual(check.cloudwatch.sent.map((command) => command.name), ['CreateLogStream', 'PutLogEvents']);
  assert.equal(emfLines(existing.lines.log, 'AuditFallbackEvents').length, 1);

  process.env.AUDIT_FALLBACK_LOG_GROUP = `${GROUP}-flaky`;
  check.cloudwatch.sent = [];
  check.cloudwatch.behavior = (command) => (command.name === 'CreateLogStream' ? new Error('AccessDeniedException') : undefined);
  const denied = await captureConsole(() => record.recordAdminAttempt(null, { surface: 'admin.session', categories: ['admin_access'], outcome: 'failed' }));
  assert.equal(emfLines(denied.lines.error, 'AuditFallbackFailed').length, 1);
  check.cloudwatch.behavior = undefined;
  await captureConsole(() => record.recordAdminAttempt(null, { surface: 'admin.session', categories: ['admin_access'], outcome: 'failed' }));
  assert.deepEqual(check.cloudwatch.sent.map((command) => command.name), ['CreateLogStream', 'CreateLogStream', 'PutLogEvents']);
}

// No fallback group configured: AuditFallbackFailed, and no AWS call.
{
  delete process.env.AUDIT_FALLBACK_LOG_GROUP;
  check.cloudwatch.sent = [];
  check.pool = new Error('pool unavailable');
  const { lines } = await captureConsole(() => record.recordAdminAttempt(opsSession, { ...revealEvent, outcome: 'failed' }));
  assert.deepEqual(check.cloudwatch.sent, []);
  assert.equal(emfLines(lines.error, 'AuditFallbackFailed').length, 1);
}

// --- recordAdminSession: session events through the attempt channel -------
{
  process.env.AUDIT_FALLBACK_LOG_GROUP = GROUP;
  const { pool, log } = createFakePool();
  check.pool = pool;
  await record.recordAdminSession('signed_in', opsSession);
  await record.recordAdminSession('expired', { adminUserId: ADMIN_ID, role: 'admin_superadmin', sessionId: SESSION_ID });
  await record.recordAdminSession('sign_in_rejected', null);
  assert.deepEqual(statements(log), [
    '1: <connect>', '1: BEGIN', `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>',
    '2: <connect>', '2: BEGIN', `2: ${RECORD_EVENT_SQL}`, '2: COMMIT', '2: <release>',
    '3: <connect>', '3: BEGIN', `3: ${RECORD_EVENT_SQL}`, '3: COMMIT', '3: <release>',
  ]);
  const [signedIn, expired, rejected] = recordedEvents(log);
  assert.deepEqual(signedIn, {
    kind: 'session',
    outcome: 'signed_in',
    actor_kind: 'admin',
    actor_id: ADMIN_ID,
    actor_role: 'admin_ops',
    actor_session: SESSION_ID,
    channel: 'admin',
    surface: 'admin.session',
    categories: ['admin_access'],
    subject_user_ids: [],
    record_ids: [],
    result_count: 0,
    field_names: [],
    request_id: REQUEST_ID,
  });
  assert.equal(expired.outcome, 'expired');
  assert.equal(expired.actor_role, 'admin_superadmin');
  assert.match(expired.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { kind: rejected.kind, outcome: rejected.outcome, actor_kind: rejected.actor_kind, surface: rejected.surface },
    { kind: 'session', outcome: 'sign_in_rejected', actor_kind: 'anonymous', surface: 'admin.session' },
  );
  assert.equal('actor_id' in rejected, false);
}

// A session event may name field names (codes, never values): a sign-in that
// used a trusted browser records ['trusted_device'] (contract K1.2). A
// sign-in rejected for an admin who is known carries that admin, no session.
{
  const { pool, log } = createFakePool();
  check.pool = pool;
  await record.recordAdminSession('signed_in', opsSession, { fieldNames: ['trusted_device'] });
  await record.recordAdminSession('sign_in_rejected', { adminUserId: ADMIN_ID, role: 'admin_ops' });
  const [trusted, refused] = recordedEvents(log);
  assert.deepEqual(trusted.field_names, ['trusted_device']);
  assert.equal(trusted.outcome, 'signed_in');
  assert.deepEqual(
    [refused.outcome, refused.actor_kind, refused.actor_id, refused.actor_role, 'actor_session' in refused, refused.field_names],
    ['sign_in_rejected', 'admin', ADMIN_ID, 'admin_ops', false, []],
  );

  // A field name that is not a code is never written: the event is lost to
  // the fallback metric, and the caller is never interrupted.
  const before = recordedEvents(log).length;
  const { lines } = await captureConsole(() => record.recordAdminSession('signed_in', opsSession, { fieldNames: ['Trusted Device!'] }));
  assert.equal(recordedEvents(log).length, before);
  assert.equal(emfLines(lines.error, 'AuditFallbackFailed').length, 1);
}

console.log('admin audit record checks passed');
