// Checks the recorded admin actions:
// a reveal is a read event with its reason in the reveal's transaction; the
// case actions and revoke-all are action events with no free text; refusals
// and failures are attempts after the rollback; nothing writes
// admin_audit_log; a reply's message body never reaches an event.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

const { load } = compileAdminSources({
  name: 'audit-actions',
  sources: [
    'src/lib/server/admin-action-dispatch.ts',
    'src/app/api/admin-sessions/revoke-all/route.ts',
    'src/lib/server/audit/context.ts',
  ],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    'next/headers': 'scripts/fakes/next-headers.mjs',
    'next/server': 'scripts/fakes/next-server.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
    'aws-jwt-verify': 'scripts/fakes/aws-jwt-verify.mjs',
  },
});

const dispatch = await load('src/lib/server/admin-action-dispatch.ts');
const revokeAll = await load('src/app/api/admin-sessions/revoke-all/route.ts');
const context = await load('src/lib/server/audit/context.ts');

const check = (globalThis.__adminCheck = { cookies: new Map() });
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';

const ADMIN_ID = fakeUuid(0xd1);
const SESSION_ID = fakeUuid(0xd2);
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const CASE_ID = fakeUuid(0xc1);
const WORKER_ID = fakeUuid(0xa1);
const EMPLOYER_ID = fakeUuid(0xe1);
const TARGET_ADMIN_ID = fakeUuid(0xd9);
const REASON = 'Synthetic callback reason for a support check.';
const MESSAGE = 'Synthetic reply body that must stay in the case timeline.';
const NOTE = 'Synthetic note that must not reach an event.';

function sessionFor(role) {
  return {
    sub: 'check-admin-sub',
    email: 'ops-admin@example.test',
    role,
    groups: [role],
    sessionId: SESSION_ID,
    adminUserId: ADMIN_ID,
    requestId: REQUEST_ID,
  };
}
const ops = sessionFor('admin_ops');
const readonly = sessionFor('admin_readonly');
const adminActor = (role) => ({
  actor_kind: 'admin',
  actor_id: ADMIN_ID,
  actor_role: role,
  actor_session: SESSION_ID,
  channel: 'admin',
});

// The change-log audit context: one set_config statement
// right after BEGIN in each action transaction, so the change records its
// writes leave name the admin, the action and the request. The statement
// order checks below read the statements without it.
const CONTEXT_SQL = normalizeSql(context.SET_AUDIT_CONTEXT_SQL);
function contextCalls(log) {
  return log.flatMap((entry, index) => {
    if (entry.sql !== CONTEXT_SQL) return [];
    const before = log.slice(0, index).filter((other) => other.connection === entry.connection).at(-1);
    return [{ connection: entry.connection, after: before?.sql ?? `<${before?.op}>`, params: entry.params }];
  });
}
const actionStatements = (log) => statements(log.filter((entry) => entry.sql !== CONTEXT_SQL));
const contextFor = (surface) => [{
  connection: 1,
  after: 'BEGIN',
  params: ['admin', ADMIN_ID, 'admin', surface, REQUEST_ID],
}];

assert.equal(
  CONTEXT_SQL,
  "SELECT set_config('app.audit_actor_kind', $1, true), set_config('app.audit_actor_id', $2, true), "
    + "set_config('app.audit_channel', $3, true), set_config('app.audit_surface', $4, true), "
    + "set_config('app.audit_request_id', $5, true)",
  'the five settings are set in one statement, transaction-locally (true), never for the session',
);

function caseDatabase({ target = { status: 'open', case_type: 'help_request', user_id: WORKER_ID, employer_id: EMPLOYER_ID }, fail, updateRows = 1, recipient, outboxRows } = {}) {
  return createFakePool({
    respond: ({ sql, params }) => {
      if (fail && fail.test(sql)) throw new Error('database write failed');
      if (/FROM admin_cases WHERE id = \$1 FOR UPDATE$/.test(sql)) return { rows: target ? [target] : [] };
      if (/^SELECT u\.id AS subject_user_id, u\.full_name, u\.phone, u\.email/.test(sql)) {
        return { rows: [{ subject_user_id: WORKER_ID, full_name: 'Test Person', phone: '+12025550123', email: 'person@example.test' }] };
      }
      if (/FOR UPDATE OF c$/.test(sql)) return { rows: recipient === undefined ? [{ status: 'open', case_type: 'help_request', user_id: WORKER_ID, whatsapp_number: '+12025550123', language: 'en' }] : recipient };
      if (/^INSERT INTO whatsapp_outbox/.test(sql)) return { rows: outboxRows ?? [{ id: fakeUuid(0x9001) }] };
      if (/^UPDATE admin_cases/.test(sql)) return { rows: [], rowCount: updateRows };
      return { rows: [], rowCount: 1 };
    },
  });
}

const attemptStatements = (connection) => [
  `${connection}: <connect>`,
  `${connection}: BEGIN`,
  `${connection}: ${RECORD_EVENT_SQL}`,
  `${connection}: COMMIT`,
  `${connection}: <release>`,
];

function noLegacyWrites(log) {
  assert.equal(log.some((entry) => /admin_audit_log/.test(entry.sql ?? '')), false, 'nothing reads or writes admin_audit_log');
}

const revealRequest = { actionId: 'reveal_pii', targetType: 'admin_case', targetId: CASE_ID, justification: REASON };
const revealEvent = {
  surface: 'admin.case_detail.reveal',
  categories: ['contact_details'],
  subject_user_ids: [WORKER_ID],
  record_type: 'admin_case',
  record_ids: [CASE_ID],
  field_names: ['full_name', 'phone', 'email'],
  purpose_kind: 'reveal',
  reason: REASON,
  request_id: REQUEST_ID,
};

// --- A reveal is one read event with its reason, in its transaction --------
{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, revealRequest);
  assert.deepEqual(result, {
    ok: true,
    message: 'Contact revealed.',
    revealed: { name: 'Test Person', phone: '+12025550123', email: 'person@example.test' },
  });
  const lines = actionStatements(log);
  assert.deepEqual(contextCalls(log), contextFor('admin.case_detail.reveal'));
  assert.deepEqual(lines.slice(0, 2), ['1: <connect>', '1: BEGIN']);
  assert.match(lines[2], /^1: SELECT status, case_type, user_id, employer_id FROM admin_cases WHERE id = \$1 FOR UPDATE$/);
  assert.match(lines[3], /^1: SELECT u\.id AS subject_user_id, u\.full_name, u\.phone, u\.email FROM admin_cases c JOIN users u/);
  assert.deepEqual(lines.slice(4), [`1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...adminActor('admin_ops'),
    surface: revealEvent.surface,
    categories: revealEvent.categories,
    subject_user_ids: revealEvent.subject_user_ids,
    record_type: revealEvent.record_type,
    record_ids: revealEvent.record_ids,
    result_count: 1,
    field_names: revealEvent.field_names,
    purpose_kind: 'reveal',
    reason: REASON,
    request_id: REQUEST_ID,
  }]);
  noLegacyWrites(log);
}

// A denied reveal (read-only role) records an attempt after the rollback,
// carrying the same reason; no contact is read.
{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(readonly, revealRequest);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.deepEqual(actionStatements(log), [
    '1: <connect>',
    '1: BEGIN',
    actionStatements(log)[2],
    '1: ROLLBACK',
    '1: <release>',
    ...attemptStatements(2),
  ]);
  const [attempt] = recordedEvents(log);
  assert.deepEqual(attempt, {
    kind: 'attempt',
    outcome: 'denied',
    ...adminActor('admin_readonly'),
    surface: revealEvent.surface,
    categories: revealEvent.categories,
    subject_user_ids: [WORKER_ID],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 0,
    field_names: revealEvent.field_names,
    purpose_kind: 'reveal',
    reason: REASON,
    request_id: REQUEST_ID,
  });
  noLegacyWrites(log);
}

// A reveal on a closed case is refused (409) and recorded as denied.
{
  const { pool, log } = caseDatabase({ target: { status: 'resolved', case_type: 'help_request', user_id: WORKER_ID, employer_id: null } });
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, revealRequest);
  assert.equal(result.status, 409);
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.reason], ['attempt', 'denied', REASON]);
}

// A reveal on a missing case records not_found.
{
  const { pool, log } = caseDatabase({ target: null });
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, revealRequest);
  assert.equal(result.status, 404);
  const [attempt] = recordedEvents(log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.subject_user_ids, attempt.record_ids, attempt.reason],
    ['attempt', 'not_found', [], [CASE_ID], REASON],
  );
}

// A reveal that fails mid-way rolls back, records a failed attempt with the
// reason, and rethrows.
{
  const { pool, log } = caseDatabase({ fail: /^SELECT u\.id AS subject_user_id/ });
  check.pool = pool;
  await assert.rejects(() => dispatch.dispatchAdminAction(ops, revealRequest), /database write failed/);
  const lines = actionStatements(log);
  assert.deepEqual(lines.slice(3, 6), [lines[3], '1: ROLLBACK', '1: <release>']);
  assert.deepEqual(lines.slice(6), attemptStatements(2));
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.reason, attempt.result_count], ['attempt', 'failed', REASON, 0]);
}

// A failed event write fails the reveal: no contact is returned.
{
  const { pool, log } = caseDatabase({ fail: /^SELECT jale_audit\.record_event/ });
  check.pool = pool;
  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  await captureConsole(async () => {
    await assert.rejects(() => dispatch.dispatchAdminAction(ops, revealRequest), /database write failed/);
  });
  assert.equal(actionStatements(log).includes('1: COMMIT'), false);
  assert.ok(actionStatements(log).includes('1: ROLLBACK'));
}

// A reason over 500 characters is refused before any read (400, not recorded).
{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, { ...revealRequest, justification: 'r'.repeat(501) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(log, []);
}

// A malformed case id is never queried; it records not_found with no ids.
{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, { ...revealRequest, targetId: 'case-not-a-uuid' });
  assert.equal(result.status, 404);
  assert.deepEqual(actionStatements(log), attemptStatements(1));
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.outcome, attempt.record_ids], ['not_found', []]);
  assert.doesNotMatch(JSON.stringify(log), /case-not-a-uuid/);
}

// --- request_more_info and resolve_case are action events ------------------
{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, {
    actionId: 'request_more_info', targetType: 'admin_case', targetId: CASE_ID, note: NOTE,
  });
  assert.deepEqual(result, { ok: true, message: 'Admin action applied.' });
  const lines = actionStatements(log);
  assert.deepEqual(contextCalls(log), contextFor('admin.case_detail.request_more_info'));
  assert.match(lines[3], /^1: UPDATE admin_cases SET status = \$2, details = details \|\| \$3::jsonb/);
  assert.deepEqual(lines.slice(4), [`1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'action',
    outcome: 'done',
    ...adminActor('admin_ops'),
    surface: 'admin.case_detail.request_more_info',
    categories: ['cases'],
    subject_user_ids: [WORKER_ID, EMPLOYER_ID],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 1,
    field_names: ['status', 'details'],
    purpose_kind: 'case',
    purpose_id: CASE_ID,
    request_id: REQUEST_ID,
  }]);
  assert.doesNotMatch(JSON.stringify(recordedEvents(log)), /Synthetic note/, 'no free text in an action event');
  noLegacyWrites(log);
}

{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  await dispatch.dispatchAdminAction(ops, { actionId: 'resolve_case', targetType: 'admin_case', targetId: CASE_ID });
  const [event] = recordedEvents(log);
  assert.deepEqual(
    [event.kind, event.surface, event.field_names, event.result_count],
    ['action', 'admin.case_detail.resolve_case', ['status', 'resolved_at'], 1],
  );
}

// A stale update (someone else changed the case) is refused and recorded.
{
  const { pool, log } = caseDatabase({ updateRows: 0 });
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, { actionId: 'resolve_case', targetType: 'admin_case', targetId: CASE_ID });
  assert.equal(result.status, 409);
  const lines = actionStatements(log);
  assert.deepEqual(lines.slice(4, 6), ['1: ROLLBACK', '1: <release>']);
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.surface], ['attempt', 'denied', 'admin.case_detail.resolve_case']);
}

// --- A reply records an action; the body stays in the case timeline --------
{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, {
    actionId: 'reply_whatsapp', targetType: 'admin_case', targetId: CASE_ID,
    requestId: '22222222-3333-4444-8555-666666666666', note: MESSAGE,
  });
  assert.deepEqual(result, { ok: true, message: 'WhatsApp reply queued for delivery.' });
  const lines = actionStatements(log);
  assert.deepEqual(contextCalls(log), contextFor('admin.case_detail.reply_whatsapp'));
  assert.match(lines[2], /^1: SELECT c\.status, c\.case_type, c\.user_id,/);
  assert.match(lines[3], /^1: INSERT INTO whatsapp_outbox/);
  assert.match(lines[4], /^1: INSERT INTO admin_case_events/);
  assert.match(lines[5], /^1: UPDATE admin_cases/);
  assert.deepEqual(lines.slice(6), [`1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'action',
    outcome: 'done',
    ...adminActor('admin_ops'),
    surface: 'admin.case_detail.reply_whatsapp',
    categories: ['cases', 'conversations'],
    subject_user_ids: [WORKER_ID],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 1,
    field_names: ['status', 'details'],
    purpose_kind: 'case',
    purpose_id: CASE_ID,
    request_id: REQUEST_ID,
  }]);
  const caseEvent = log.find((entry) => /^INSERT INTO admin_case_events/.test(entry.sql ?? ''));
  assert.match(JSON.stringify(caseEvent.params), /Synthetic reply body/, 'the body stays in the case timeline');
  for (const entry of log.filter((item) => item.sql === RECORD_EVENT_SQL)) {
    assert.doesNotMatch(entry.params[0], /Synthetic reply body/, 'the body never reaches an event');
  }
  noLegacyWrites(log);
}

// Not linked to a conversation: refused and recorded, without the body.
{
  const { pool, log } = caseDatabase({ recipient: [] });
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, {
    actionId: 'reply_whatsapp', targetType: 'admin_case', targetId: CASE_ID,
    requestId: '22222222-3333-4444-8555-666666666666', note: MESSAGE,
  });
  assert.equal(result.status, 409);
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.surface], ['attempt', 'denied', 'admin.case_detail.reply_whatsapp']);
  assert.doesNotMatch(JSON.stringify(recordedEvents(log)), /Synthetic reply body/);
}

// The idempotent replay changes nothing and records nothing.
{
  const { pool, log } = caseDatabase({ outboxRows: [] });
  check.pool = pool;
  const result = await dispatch.dispatchAdminAction(ops, {
    actionId: 'reply_whatsapp', targetType: 'admin_case', targetId: CASE_ID,
    requestId: '22222222-3333-4444-8555-666666666666', note: MESSAGE,
  });
  assert.deepEqual(result, { ok: true, message: 'WhatsApp reply is already queued.' });
  assert.equal(recordedEvents(log).length, 0);
}

// A failed reply rolls back, records a failed attempt without the body, rethrows.
{
  const { pool, log } = caseDatabase({ fail: /^INSERT INTO admin_case_events/ });
  check.pool = pool;
  await assert.rejects(() => dispatch.dispatchAdminAction(ops, {
    actionId: 'reply_whatsapp', targetType: 'admin_case', targetId: CASE_ID,
    requestId: '22222222-3333-4444-8555-666666666666', note: MESSAGE,
  }), /database write failed/);
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.kind, attempt.outcome], ['attempt', 'failed']);
  assert.doesNotMatch(JSON.stringify(log.filter((entry) => entry.sql === RECORD_EVENT_SQL)), /Synthetic reply body/);
}

// --- Revoke-all records an action naming the admin and the count -----------
function revokeDatabase({ role = 'admin_superadmin', fail } = {}) {
  return createFakePool({
    respond: ({ sql }) => {
      if (fail && fail.test(sql)) throw new Error('database write failed');
      if (sql.includes('FROM admin_sessions s')) {
        return { rows: [{ session_id: SESSION_ID, admin_user_id: ADMIN_ID, cognito_sub: 'check-admin-sub', admin_email: 'ops-admin@example.test', role, expires_at: new Date(Date.now() + 600_000), active: true }] };
      }
      if (sql.startsWith('WITH revoked AS')) return { rows: [{ revoked_count: 2 }] };
      return {};
    },
  });
}

function revokeRequest(body) {
  return new Request('https://admin.example.test/api/admin-sessions/revoke-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

{
  const { pool, log } = revokeDatabase();
  check.pool = pool;
  check.cookies = new Map([['jale_admin_id_token_v2', 'raw-session-token']]);
  const response = await revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, revokedCount: 2 });
  const lines = actionStatements(log);
  assert.match(lines[0], /^pool: SELECT s\.id AS session_id/);
  assert.deepEqual(lines.slice(1, 3), ['1: <connect>', '1: BEGIN']);
  assert.match(lines[3], /^1: WITH revoked AS/);
  const [revokeContext] = contextCalls(log);
  const [revokeEventPayload] = recordedEvents(log);
  assert.deepEqual(revokeContext, {
    connection: 1,
    after: 'BEGIN',
    params: ['admin', revokeEventPayload.actor_id, 'admin', 'admin.sessions_revoke', revokeEventPayload.request_id],
  }, 'revoke-all sets the context with the request id its event carries');
  assert.deepEqual(lines.slice(4), [`1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  const [event] = recordedEvents(log);
  assert.deepEqual(event, {
    kind: 'action',
    outcome: 'done',
    ...adminActor('admin_superadmin'),
    surface: 'admin.sessions_revoke',
    categories: ['admin_access'],
    subject_user_ids: [],
    record_type: 'admin_user',
    record_ids: [TARGET_ADMIN_ID],
    result_count: 2,
    field_names: [],
    request_id: event.request_id,
  });
  noLegacyWrites(log);
}

// Another role is refused (403) and recorded; a malformed id is a 400.
{
  const { pool, log } = revokeDatabase({ role: 'admin_ops' });
  check.pool = pool;
  const response = await revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID }));
  assert.equal(response.status, 403);
  assert.deepEqual(actionStatements(log).slice(1), attemptStatements(1));
  const [attempt] = recordedEvents(log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.actor_role, attempt.record_ids],
    ['attempt', 'denied', 'admin.sessions_revoke', 'admin_ops', []],
  );

  const { pool: pool2, log: log2 } = revokeDatabase();
  check.pool = pool2;
  const malformed = await revokeAll.POST(revokeRequest({ adminUserId: '-'.repeat(36) }));
  assert.equal(malformed.status, 400);
  assert.equal(recordedEvents(log2).length, 0);
}

// A failed revocation rolls back, records a failed attempt, and rethrows.
{
  const { pool, log } = revokeDatabase({ fail: /^WITH revoked AS/ });
  check.pool = pool;
  await assert.rejects(() => revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID })), /database write failed/);
  const lines = actionStatements(log);
  assert.deepEqual(lines.slice(3, 6), [lines[3], '1: ROLLBACK', '1: <release>']);
  const [attempt] = recordedEvents(log);
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.record_ids], ['attempt', 'failed', [TARGET_ADMIN_ID]]);
}

// --- The local preview has no admin id: it sets no audit context -----------
{
  const { pool, log } = caseDatabase();
  check.pool = pool;
  const preview = { preview: true, sub: 'local-preview-admin', role: 'admin_ops', groups: ['admin_ops'] };
  const result = await dispatch.dispatchAdminAction(preview, {
    actionId: 'request_more_info', targetType: 'admin_case', targetId: CASE_ID, note: NOTE,
  });
  assert.deepEqual(result, { ok: true, message: 'Admin action applied.' });
  assert.deepEqual(contextCalls(log), [], 'no context without an admin id');
  assert.equal(recordedEvents(log).length, 0);
}

// --- No admin_audit_log writer remains anywhere in the app ------------------
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}
for (const file of sourceFiles(join(adminRoot, 'src'))) {
  assert.doesNotMatch(readFileSync(file, 'utf8'), /INSERT\s+INTO\s+admin_audit_log/i, `${file} must not write admin_audit_log`);
}

console.log('admin action record checks passed');
