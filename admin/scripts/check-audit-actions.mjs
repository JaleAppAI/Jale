// Checks the recorded admin actions:
// the Inbox actions (K2.7) record their surfaces: a reveal and a media link
// are read events in their own transaction (the reveal with its reason, the
// link with its expiry), the mutations are action events with no free text,
// refusals and failures are attempts after the rollback, a read-only admin
// is refused with a denied attempt; revoke-all is an action event; nothing
// writes admin_audit_log; a reply's text never reaches an event.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    'src/lib/server/inbox-actions.ts',
    'src/app/api/admin-sessions/revoke-all/route.ts',
    'src/lib/server/audit/context.ts',
    'src/lib/server/admin-users.ts',
  ],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    '@aws-sdk/client-cognito-identity-provider': 'scripts/fakes/cognito-idp.mjs',
    '@aws-sdk/client-s3': 'scripts/fakes/s3-client.mjs',
    '@aws-sdk/s3-request-presigner': 'scripts/fakes/s3-request-presigner.mjs',
    'next/headers': 'scripts/fakes/next-headers.mjs',
    'next/server': 'scripts/fakes/next-server.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
    'aws-jwt-verify': 'scripts/fakes/aws-jwt-verify.mjs',
  },
});

const inbox = await load('src/lib/server/inbox-actions.ts');
const revokeAll = await load('src/app/api/admin-sessions/revoke-all/route.ts');
const context = await load('src/lib/server/audit/context.ts');
const adminUsers = await load('src/lib/server/admin-users.ts');

const check = (globalThis.__adminCheck = { cookies: new Map() });
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';
process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID = 'check-region_CheckPool';
process.env.NEXT_PUBLIC_ADMIN_REGION = 'check-region';

const ADMIN_ID = fakeUuid(0xd1);
const SESSION_ID = fakeUuid(0xd2);
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const CASE_ID = fakeUuid(0xc1);
const CHALLENGE_ID = fakeUuid(0xc2);
const MEDIA_ID = fakeUuid(0xc3);
const ACTION_REQUEST_ID = fakeUuid(0xc4);
const NEW_CASE_ID = fakeUuid(0xc5);
const WORKER_ID = fakeUuid(0xa1);
const EMPLOYER_ID = fakeUuid(0xe1);
const TARGET_ADMIN_ID = fakeUuid(0xd9);
const REASON = 'Synthetic callback reason for a support check.';
const MESSAGE = 'Synthetic reply body that must stay in the case timeline.';
const NOTE = 'Synthetic note that must not reach an event.';
const PHONE = '+15550100000';
const MEDIA_KEY = `support/${CASE_ID}/${fakeUuid(0xc6)}.jpg`;

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

const QUEUE_SQL = normalizeSql(inbox.QUEUE_SUPPORT_MESSAGE_SQL);
const REVEAL_SQL = normalizeSql(inbox.REVEAL_PHONE_SQL);
const MEDIA_SQL = normalizeSql(inbox.MEDIA_LINK_SQL);
const RESET_SQL = normalizeSql(inbox.RESET_LOCKOUT_SQL);
const OPEN_SQL = normalizeSql(inbox.OPEN_SUPPORT_SQL);
const SUBJECTS_SQL = normalizeSql(inbox.CASE_SUBJECTS_SQL);

const refusalError = (code, state) => Object.assign(new Error(code), { code: state });

/**
 * One Inbox action through handleInboxActionRequest (the route adds only the
 * session check). `respond(sql)` answers the definers; an Error is thrown.
 */
async function act(session, body, { respond = () => undefined, fail } = {}) {
  const { pool, log } = createFakePool({
    respond: ({ sql }) => {
      if (fail && fail.test(sql)) throw new Error('database write failed');
      if (sql === SUBJECTS_SQL) return { rows: [{ user_id: WORKER_ID, employer_id: EMPLOYER_ID }] };
      if (sql === QUEUE_SQL) {
        const answer = respond(sql);
        if (answer instanceof Error) throw answer;
        return { rows: answer ?? [{ result_id: fakeUuid(0x9001), replayed: false }] };
      }
      const answer = respond(sql);
      if (answer instanceof Error) throw answer;
      return answer ? { rows: answer } : { rows: [], rowCount: 1 };
    },
  });
  check.pool = pool;
  check.presign = { calls: [], behavior: () => 'https://media.example.test/signed', onPresign: () => log.push({ connection: '-', op: 'presign' }) };
  const text = JSON.stringify(body);
  const request = new Request('https://admin.example.test/api/inbox-actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amz-content-sha256': createHash('sha256').update(text, 'utf8').digest('hex') },
    body: text,
  });
  const { result } = await captureConsole(async () => {
    const response = await inbox.handleInboxActionRequest(request, session);
    return { status: response.status, body: await response.json() };
  });
  return { ...result, log, presignCalls: check.presign.calls };
}

const caseEvent = (surface, fieldNames, categories = ['cases', 'conversations']) => ({
  kind: 'action',
  outcome: 'done',
  ...adminActor('admin_ops'),
  surface,
  categories,
  subject_user_ids: [WORKER_ID, EMPLOYER_ID],
  record_type: 'admin_case',
  record_ids: [CASE_ID],
  result_count: 1,
  field_names: fieldNames,
  purpose_kind: 'case',
  purpose_id: CASE_ID,
  request_id: REQUEST_ID,
});

// --- reply, request_info, resolve: one action event each, after the definer ---------
for (const [action, surface, fields, body] of [
  ['reply', 'admin.inbox.reply', ['status'], { text: MESSAGE }],
  ['request_info', 'admin.inbox.request_info', ['status'], { text: MESSAGE }],
  ['resolve', 'admin.inbox.resolve', ['status', 'resolved_at'], {}],
]) {
  const result = await act(ops, { action, requestId: ACTION_REQUEST_ID, caseId: CASE_ID, ...body });
  assert.equal(result.status, 200, action);
  assert.deepEqual(contextCalls(result.log), contextFor(surface), `${action}: the context right after BEGIN`);
  assert.deepEqual(actionStatements(result.log), [
    '1: <connect>', '1: BEGIN', `1: ${QUEUE_SQL}`, `1: ${SUBJECTS_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>',
  ], action);
  assert.deepEqual(recordedEvents(result.log), [caseEvent(surface, fields)], action);
  for (const entry of result.log.filter((item) => item.sql === RECORD_EVENT_SQL)) {
    assert.doesNotMatch(entry.params[0], /Synthetic reply body/, 'the text never reaches an event');
  }
  noLegacyWrites(result.log);
}

// --- reveal_phone: a read event with the reason, before COMMIT --------------------------
{
  const result = await act(ops, { action: 'reveal_phone', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, justification: REASON }, {
    respond: (sql) => (sql === REVEAL_SQL ? [{ phone: PHONE }] : undefined),
  });
  assert.deepEqual([result.status, result.body], [200, { ok: true, kind: 'phone', phone: PHONE }]);
  assert.deepEqual(contextCalls(result.log), [], 'a read sets no change-log context');
  assert.deepEqual(recordedEvents(result.log), [{
    kind: 'read',
    outcome: 'allowed',
    ...adminActor('admin_ops'),
    surface: 'admin.inbox.reveal_phone',
    categories: ['contact_details'],
    subject_user_ids: [WORKER_ID, EMPLOYER_ID],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 1,
    field_names: ['phone'],
    purpose_kind: 'reveal',
    reason: REASON,
    request_id: REQUEST_ID,
  }]);
  assert.doesNotMatch(JSON.stringify(recordedEvents(result.log)), /\+1555/, 'the number never reaches an event');

  // A failed event write fails the reveal: no number is returned.
  const failed = await act(ops, { action: 'reveal_phone', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, justification: REASON }, {
    respond: (sql) => (sql === REVEAL_SQL ? [{ phone: PHONE }] : undefined),
    fail: /^SELECT jale_audit\.record_event/,
  });
  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  assert.equal(failed.status, 500);
  assert.equal(JSON.stringify(failed.body).includes(PHONE), false);
  assert.equal(actionStatements(failed.log).includes('1: COMMIT'), false);

  // An unknown case: not_found, recorded as such with the reason.
  const { pool, log } = createFakePool({ respond: ({ sql }) => (sql === SUBJECTS_SQL ? { rows: [] } : {}) });
  check.pool = pool;
  const text = JSON.stringify({ action: 'reveal_phone', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, justification: REASON });
  const response = await inbox.handleInboxActionRequest(new Request('https://admin.example.test/api/inbox-actions', {
    method: 'POST',
    headers: { 'x-amz-content-sha256': createHash('sha256').update(text, 'utf8').digest('hex') },
    body: text,
  }), ops);
  assert.equal(response.status, 404);
  const [attempt] = recordedEvents(log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.record_ids, attempt.reason],
    ['attempt', 'not_found', 'admin.inbox.reveal_phone', [CASE_ID], REASON],
  );
}

// --- open_media: a read event whose link expiry is the presigned link's -----------------
{
  process.env.SUPPORT_MEDIA_BUCKET = 'check-support-media-bucket';
  const result = await act(readonly, { action: 'open_media', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, mediaId: MEDIA_ID }, {
    respond: (sql) => (sql === MEDIA_SQL ? [{ outcome: 'ok', s3_key: MEDIA_KEY, content_type: 'image/jpeg' }] : undefined),
  });
  delete process.env.SUPPORT_MEDIA_BUCKET;
  assert.equal(result.status, 200, 'a read-only admin may open media (K2.7 CCR-2)');
  const [event] = recordedEvents(result.log);
  const [call] = result.presignCalls;
  assert.deepEqual(event, {
    kind: 'read',
    outcome: 'allowed',
    ...adminActor('admin_readonly'),
    surface: 'admin.inbox.open_media',
    categories: ['cases', 'conversations'],
    subject_user_ids: [WORKER_ID, EMPLOYER_ID],
    record_type: 'admin_case',
    record_ids: [CASE_ID],
    result_count: 1,
    field_names: [],
    purpose_kind: 'case',
    purpose_id: CASE_ID,
    link_expires_at: event.link_expires_at,
    request_id: REQUEST_ID,
  });
  assert.equal(new Date(event.link_expires_at).getTime(), call.options.signingDate.getTime() + call.options.expiresIn * 1000);
  assert.equal(call.options.expiresIn, 300);
  const lines = actionStatements(result.log);
  assert.ok(lines.indexOf('1: COMMIT') < lines.indexOf('-: <presign>'), 'the link is minted only after COMMIT');
  assert.doesNotMatch(JSON.stringify(recordedEvents(result.log)), /support\//, 'the key never reaches an event');
}

// --- reset_lockout and open_support_from_lockout: action events on the challenge ---------
for (const [body, surface, fields, sql] of [
  [{ action: 'reset_lockout', requestId: ACTION_REQUEST_ID, challengeId: CHALLENGE_ID, reasonCode: 'other', note: NOTE },
    'admin.inbox.reset_lockout', ['status', 'attempts', 'locked_until', 'expires_at', 'context'], RESET_SQL],
  [{ action: 'open_support_from_lockout', requestId: ACTION_REQUEST_ID, challengeId: CHALLENGE_ID },
    'admin.inbox.open_support', [], OPEN_SQL],
]) {
  const result = await act(ops, body, { respond: (asked) => (asked === sql ? [{ result_id: NEW_CASE_ID, replayed: false }] : undefined) });
  assert.equal(result.status, 200, body.action);
  assert.deepEqual(contextCalls(result.log), contextFor(surface));
  assert.deepEqual(recordedEvents(result.log), [{
    kind: 'action',
    outcome: 'done',
    ...adminActor('admin_ops'),
    surface,
    categories: body.action === 'reset_lockout' ? ['verifications'] : ['verifications', 'cases'],
    subject_user_ids: [],
    record_type: 'identity_challenge',
    record_ids: [CHALLENGE_ID],
    result_count: 1,
    field_names: fields,
    purpose_kind: 'verification',
    request_id: REQUEST_ID,
  }], body.action);
  assert.doesNotMatch(JSON.stringify(recordedEvents(result.log)), /Synthetic note/, 'the note never reaches an event');
}

// --- Read-only: every mutation and the reveal are refused with a denied attempt ---------
for (const [body, surface] of [
  [{ action: 'reply', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, text: MESSAGE }, 'admin.inbox.reply'],
  [{ action: 'request_info', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, text: MESSAGE }, 'admin.inbox.request_info'],
  [{ action: 'resolve', requestId: ACTION_REQUEST_ID, caseId: CASE_ID }, 'admin.inbox.resolve'],
  [{ action: 'reveal_phone', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, justification: REASON }, 'admin.inbox.reveal_phone'],
  [{ action: 'reset_lockout', requestId: ACTION_REQUEST_ID, challengeId: CHALLENGE_ID, reasonCode: 'worker_confused' }, 'admin.inbox.reset_lockout'],
  [{ action: 'open_support_from_lockout', requestId: ACTION_REQUEST_ID, challengeId: CHALLENGE_ID }, 'admin.inbox.open_support'],
]) {
  const result = await act(readonly, body);
  assert.deepEqual([result.status, result.body], [403, { ok: false, error: 'forbidden' }], body.action);
  assert.deepEqual(actionStatements(result.log), attemptStatements(1), `${body.action}: only the attempt is written`);
  const [attempt] = recordedEvents(result.log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.actor_role, attempt.result_count],
    ['attempt', 'denied', surface, 'admin_readonly', 0],
    body.action,
  );
  if (body.action === 'reveal_phone') assert.equal(attempt.reason, REASON);
}

// --- Refusals and failures are attempts after the rollback ------------------------------
{
  const closed = await act(ops, { action: 'reply', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, text: MESSAGE }, {
    respond: (sql) => (sql === QUEUE_SQL ? refusalError('case_closed', 'P0001') : undefined),
  });
  assert.equal(closed.status, 409);
  assert.deepEqual(actionStatements(closed.log).slice(0, 5), ['1: <connect>', '1: BEGIN', `1: ${QUEUE_SQL}`, '1: ROLLBACK', '1: <release>']);
  assert.deepEqual(actionStatements(closed.log).slice(5), attemptStatements(2));
  const [attempt] = recordedEvents(closed.log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.record_ids, attempt.result_count],
    ['attempt', 'failed', 'admin.inbox.reply', [CASE_ID], 0],
  );
  assert.doesNotMatch(JSON.stringify(recordedEvents(closed.log)), /Synthetic reply body/);

  const missing = await act(ops, { action: 'resolve', requestId: ACTION_REQUEST_ID, caseId: CASE_ID }, {
    respond: (sql) => (sql === QUEUE_SQL ? refusalError('not_found', 'P0002') : undefined),
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(recordedEvents(missing.log).map((event) => [event.outcome, event.surface]), [['not_found', 'admin.inbox.resolve']]);

  // A failed event write rolls the action back: nothing is queued.
  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  const failed = await act(ops, { action: 'reply', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, text: MESSAGE }, { fail: /^SELECT jale_audit\.record_event/ });
  assert.equal(failed.status, 500);
  assert.equal(actionStatements(failed.log).includes('1: COMMIT'), false);
  assert.ok(actionStatements(failed.log).includes('1: ROLLBACK'));
}

// --- Revoke-all records an action naming the admin and the count -----------
function revokeDatabase({ role = 'admin_superadmin', fail, targetSub = 'target-admin-sub' } = {}) {
  return createFakePool({
    respond: ({ sql }) => {
      if (fail && fail.test(sql)) throw new Error('database write failed');
      if (sql.includes('FROM admin_sessions s')) {
        return { rows: [{ session_id: SESSION_ID, admin_user_id: ADMIN_ID, cognito_sub: 'check-admin-sub', admin_email: 'ops-admin@example.test', role, expires_at: new Date(Date.now() + 600_000), active: true }] };
      }
      if (sql.startsWith('WITH revoked AS')) return { rows: [{ revoked_count: 2 }] };
      if (sql.startsWith('UPDATE admin_trusted_devices')) return { rows: [{ id: fakeUuid(0x7001) }, { id: fakeUuid(0x7002) }] };
      if (sql.startsWith('SELECT cognito_sub FROM admin_users')) return { rows: [{ cognito_sub: targetSub }] };
      return {};
    },
  });
}

// The pool's devices for the revoked admin; each Cognito call lands in the
// log as `cognito: <Command>`.
function revokeDirectory(log, { fail } = {}) {
  check.cognito = {
    clients: [],
    sent: [],
    onSend: (command) => { log.push({ connection: 'cognito', op: command.name }); },
    behavior: (command) => {
      if (fail === command.name) return Object.assign(new Error('Service unavailable'), { name: 'InternalErrorException' });
      if (command.name === 'AdminListDevices') return { Devices: [{ DeviceKey: 'check-region_device-1' }, { DeviceKey: 'check-region_device-2' }] };
      return {};
    },
  };
}

// Revoke-all answers a missing session with the K1.3 codes: unauthorized
// without a cookie, session_expired when the cookie's session has ended.
{
  check.cookies = new Map();
  check.pool = revokeDatabase().pool;
  let response = await revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID }));
  assert.equal(response.status, 401);
  assert.deepEqual(typeof response.json === 'function' ? await response.json() : response.body, { error: 'unauthorized' });

  check.cookies = new Map([['jale_admin_id_token_v2', 'raw-session-token']]);
  const { pool } = createFakePool({
    respond: ({ sql }) => {
      if (sql.includes('FROM admin_sessions s')) {
        return { rows: [{ session_id: SESSION_ID, admin_user_id: ADMIN_ID, cognito_sub: 'check-admin-sub', admin_email: 'ops-admin@example.test', role: 'admin_superadmin', expires_at: new Date(Date.now() - 1000), active: false }] };
      }
      if (sql.startsWith("UPDATE admin_sessions SET revoked_at = NOW(), revoke_reason = 'expired'")) return { rows: [{ id: SESSION_ID }] };
      return {};
    },
  });
  check.pool = pool;
  response = await revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID }));
  assert.equal(response.status, 401);
  assert.deepEqual(typeof response.json === 'function' ? await response.json() : response.body, { error: 'session_expired' });
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
  revokeDirectory(log);
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
  assert.deepEqual(lines.slice(4, 7), [`1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  // Then, after the sessions are revoked: every live trusted browser ends as
  // signed_out_everywhere, and the pool forgets the admin's devices.
  assert.equal(lines[7], "pool: UPDATE admin_trusted_devices SET ended_at = now(), end_reason = $2 WHERE admin_user_id = $1 AND ended_at IS NULL RETURNING id");
  assert.deepEqual(log.find((entry) => entry.sql?.startsWith('UPDATE admin_trusted_devices')).params, [TARGET_ADMIN_ID, 'signed_out_everywhere']);
  // The pool user is named by its sign-in id, never by the stored email.
  assert.match(lines[8], /^pool: SELECT cognito_sub FROM admin_users WHERE id = \$1/);
  assert.deepEqual(lines.slice(9), [
    'cognito: <AdminListDevices>', 'cognito: <AdminForgetDevice>', 'cognito: <AdminForgetDevice>',
  ]);
  assert.deepEqual(
    check.cognito.sent.filter((command) => command.name === 'AdminForgetDevice').map((command) => [command.input.Username, command.input.DeviceKey]),
    [['target-admin-sub', 'check-region_device-1'], ['target-admin-sub', 'check-region_device-2']],
  );
  assert.deepEqual(
    check.cognito.sent.filter((command) => command.name === 'AdminListDevices').map((command) => command.input.Username),
    ['target-admin-sub'],
  );
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

// The pool fails while forgetting devices: the sessions stay revoked and the
// trust rows stay ended (the sign-in check reads them); the answer says the
// directory step failed after the save, and a failed attempt is recorded.
{
  const { pool, log } = revokeDatabase();
  check.pool = pool;
  revokeDirectory(log, { fail: 'AdminForgetDevice' });
  const response = await revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID }));
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { ok: false, error: 'directory_sync_failed', saved: true, revokedCount: 2 });
  const lines = actionStatements(log);
  assert.ok(lines.indexOf('1: COMMIT') < lines.findIndex((line) => line.startsWith('pool: UPDATE admin_trusted_devices')));
  assert.ok(lines.findIndex((line) => line.startsWith('pool: UPDATE admin_trusted_devices')) < lines.indexOf('cognito: <AdminListDevices>'));
  assert.deepEqual(
    recordedEvents(log).map((event) => [event.kind, event.outcome, event.surface]),
    [['action', 'done', 'admin.sessions_revoke'], ['attempt', 'failed', 'admin.sessions_revoke']],
  );
}

// An admin row with no sign-in id has no pool user to reach: the trust rows
// still end, the pool is not called, and the answer is a success.
{
  const { pool, log } = revokeDatabase({ targetSub: null });
  check.pool = pool;
  revokeDirectory(log);
  const response = await revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, revokedCount: 2 });
  assert.deepEqual(check.cognito.sent, []);
  assert.ok(actionStatements(log).some((line) => line.startsWith('pool: UPDATE admin_trusted_devices')));
}

// The trust step never blocks the revocation: a failed trust write leaves the
// sessions revoked (committed first), records a failed attempt, and rethrows.
{
  const { pool, log } = revokeDatabase({ fail: /^UPDATE admin_trusted_devices/ });
  check.pool = pool;
  revokeDirectory(log);
  await assert.rejects(() => revokeAll.POST(revokeRequest({ adminUserId: TARGET_ADMIN_ID })), /database write failed/);
  const lines = actionStatements(log);
  assert.ok(lines.includes('1: COMMIT'), 'the sessions were revoked first');
  assert.deepEqual(check.cognito.sent, [], 'no device is forgotten before its rows end');
  assert.deepEqual(recordedEvents(log).map((event) => [event.kind, event.outcome]), [['action', 'done'], ['attempt', 'failed']]);
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

// --- The Admins page's actions record on their own K1.5 surfaces -------------
// (Their full flows are in check-admin-users.mjs.) A refused action is a denied
// attempt on its surface, in admin_access, naming no target and no free text.
{
  const surfaces = {
    invite: 'admin.admin_invite',
    resend_invite: 'admin.admin_resend_invite',
    change_role: 'admin.admin_role_change',
    deactivate: 'admin.admin_deactivate',
    reactivate: 'admin.admin_reactivate',
  };
  for (const [action, surface] of Object.entries(surfaces)) {
    const { pool, log } = createFakePool();
    check.pool = pool;
    const outcome = await adminUsers.runAdminUserAction(readonly, {
      action, requestId: REQUEST_ID, adminUserId: TARGET_ADMIN_ID, email: 'new-admin@example.test', role: 'admin_ops',
    });
    assert.deepEqual(outcome, { status: 403, body: { ok: false, error: 'forbidden' } });
    assert.deepEqual(contextCalls(log), [], `${action}: a refusal writes nothing`);
    assert.deepEqual(recordedEvents(log), [{
      kind: 'attempt',
      outcome: 'denied',
      ...adminActor('admin_readonly'),
      surface,
      categories: ['admin_access'],
      subject_user_ids: [],
      record_ids: [],
      result_count: 0,
      field_names: [],
      request_id: REQUEST_ID,
    }]);
    assert.doesNotMatch(JSON.stringify(recordedEvents(log)), /new-admin@example/);
  }
}

// --- The local preview has no admin id: it sets no audit context -----------
{
  const preview = { preview: true, sub: 'local-preview-admin', role: 'admin_ops', groups: ['admin_ops'] };
  const result = await act(preview, { action: 'reply', requestId: ACTION_REQUEST_ID, caseId: CASE_ID, text: MESSAGE });
  assert.equal(result.status, 200);
  assert.deepEqual(contextCalls(result.log), [], 'no context without an admin id');
  assert.equal(recordedEvents(result.log).length, 0);
  // The definer receives no actor and refuses it in the database (42501).
  assert.equal(result.log.find((entry) => entry.sql === QUEUE_SQL).params[0], null);
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
