// Sprint 28 K2.7: POST /api/inbox-actions, end to end against a fake pool.
// The body is checked against its SHA-256 and parsed strictly; each action
// calls its migration 122 definer with the acting admin, never a phone
// number; a definer's refusal maps to the K2.7 error and HTTP status; a
// replayed request answers its first outcome without a second record; a
// media link is presigned only after COMMIT. The records themselves are
// checked in check-audit-actions.mjs.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
  name: 'action-dispatch',
  sources: ['src/app/api/inbox-actions/route.ts', 'src/lib/server/inbox-actions.ts', 'src/lib/server/audit/context.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    'src/lib/server/session.ts': 'scripts/fakes/session.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    '@aws-sdk/client-s3': 'scripts/fakes/s3-client.mjs',
    '@aws-sdk/s3-request-presigner': 'scripts/fakes/s3-request-presigner.mjs',
    'next/server': 'scripts/fakes/next-server.mjs',
  },
});

const route = await load('src/app/api/inbox-actions/route.ts');
const actions = await load('src/lib/server/inbox-actions.ts');
const context = await load('src/lib/server/audit/context.ts');

const check = (globalThis.__adminCheck ??= {});
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';

const ADMIN_ID = fakeUuid(0xb1);
const SESSION_ID = fakeUuid(0xb2);
const REQUEST_ID = 'cccccccc-dddd-4eee-8fff-000000000001';
const CASE_ID = fakeUuid(0xc1);
const CHALLENGE_ID = fakeUuid(0xc2);
const MEDIA_ID = fakeUuid(0xc3);
const OUTBOX_ID = fakeUuid(0xc4);
const NEW_CASE_ID = fakeUuid(0xc5);
const WORKER_ID = fakeUuid(0xc6);
const ACTION_ID = fakeUuid(0xc7);
// Synthetic values generated per run: none may reach a SQL parameter or a log line.
const PHONE = `+1555${randomBytes(3).toString('hex').replace(/[a-f]/g, '7').slice(0, 7)}`;
const TEXT = `Synthetic reply ${randomBytes(4).toString('hex')}`;
const BUCKET = `check-support-media-${randomBytes(4).toString('hex')}`;
const MEDIA_KEY = `support/${CASE_ID}/${fakeUuid(0xc8)}.jpg`;

function sessionFor(role) {
  return { sub: `check-${role}`, email: `${role}@example.test`, role, groups: [role], sessionId: SESSION_ID, adminUserId: ADMIN_ID, requestId: REQUEST_ID };
}
const ops = sessionFor('admin_ops');
const readonly = sessionFor('admin_readonly');
const superadmin = sessionFor('admin_superadmin');

const QUEUE_SQL = normalizeSql('SELECT result_id, replayed FROM public.admin_queue_support_message($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text)');
const REVEAL_SQL = normalizeSql('SELECT public.admin_support_reveal_phone($1::uuid) AS phone');
const MEDIA_SQL = normalizeSql('SELECT outcome, s3_key, content_type FROM public.admin_support_media_link($1::uuid, $2::uuid)');
const RESET_SQL = normalizeSql('SELECT result_id, replayed FROM public.admin_reset_identity_lockout($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid)');
const OPEN_SQL = normalizeSql('SELECT result_id, replayed FROM public.admin_open_support_from_lockout($1::uuid, $2::uuid, $3::uuid)');
const SUBJECTS_SQL = normalizeSql('SELECT user_id, employer_id FROM admin_cases WHERE id = $1::uuid');
const CONTEXT_SQL = normalizeSql(context.SET_AUDIT_CONTEXT_SQL);

assert.equal(normalizeSql(actions.QUEUE_SUPPORT_MESSAGE_SQL), QUEUE_SQL);
assert.equal(normalizeSql(actions.REVEAL_PHONE_SQL), REVEAL_SQL);
assert.equal(normalizeSql(actions.MEDIA_LINK_SQL), MEDIA_SQL);
assert.equal(normalizeSql(actions.RESET_LOCKOUT_SQL), RESET_SQL);
assert.equal(normalizeSql(actions.OPEN_SUPPORT_SQL), OPEN_SQL);
assert.equal(normalizeSql(actions.CASE_SUBJECTS_SQL), SUBJECTS_SQL);
for (const sql of [QUEUE_SQL, RESET_SQL, OPEN_SQL]) {
  assert.doesNotMatch(sql, /whatsapp_number|whatsapp_outbox|phone/, 'no number goes into or comes out of a mutation');
}

// The K2.7 status table.
assert.deepEqual({ ...actions.INBOX_ACTION_HTTP_STATUS }, {
  invalid_input: 400,
  reply_too_long_for_template: 400,
  unauthorized: 401,
  session_expired: 401,
  forbidden: 403,
  not_found: 404,
  no_reply_target: 404,
  case_closed: 409,
  not_locked: 409,
  media_expired: 410,
});

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Posts one request through the route. `respond(sql, params)` answers the
 * data statements (an Error is thrown as the database error).
 */
async function post({ session = ops, body, raw, hash = 'auto', respond = () => undefined, presign, hadCookie = false } = {}) {
  const { pool, log } = createFakePool({
    respond: ({ sql, params }) => {
      if (sql === RECORD_EVENT_SQL) return { rows: [{ seq: '1' }] };
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql === CONTEXT_SQL) return {};
      if (sql === SUBJECTS_SQL) return { rows: [{ user_id: WORKER_ID, employer_id: null }] };
      const rows = respond(sql, params);
      if (rows instanceof Error) throw rows;
      return rows ? { rows } : {};
    },
  });
  check.pool = pool;
  check.session = session;
  check.hadCookie = hadCookie;
  check.presign = { calls: [], behavior: presign, onPresign: () => log.push({ connection: '-', op: 'presign' }) };

  const text = raw ?? JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (hash === 'auto') headers['x-amz-content-sha256'] = sha256(text);
  else if (hash) headers['x-amz-content-sha256'] = hash;

  const { result, lines } = await captureConsole(async () => {
    const response = await route.POST(new Request('https://admin.example.test/api/inbox-actions', { method: 'POST', headers, body: text }));
    return { status: response.status, headers: response.headers, body: await response.json() };
  });
  return { ...result, log, lines, presignCalls: check.presign.calls };
}

const dataStatements = (log) => statements(log.filter((entry) => entry.sql !== CONTEXT_SQL));
const refusal = (code) => Object.assign(new Error(code), { code: { invalid_input: '22023', forbidden: '42501', not_found: 'P0002' }[code] ?? 'P0001' });

// --- 401 before anything else ------------------------------------------------------
{
  const result = await post({ session: null, body: { action: 'resolve', requestId: REQUEST_ID, caseId: CASE_ID } });
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'unauthorized' });
  assert.deepEqual(result.log, []);
  const expired = await post({ session: null, hadCookie: true, body: { action: 'resolve', requestId: REQUEST_ID, caseId: CASE_ID } });
  assert.deepEqual([expired.status, expired.body], [401, { error: 'session_expired' }]);
}

// --- reply: the definer with the acting admin; no number anywhere ------------------
{
  const result = await post({
    body: { action: 'reply', requestId: ACTION_ID, caseId: CASE_ID, text: `  ${TEXT}  ` },
    respond: (sql) => (sql === QUEUE_SQL ? [{ result_id: OUTBOX_ID, replayed: false }] : undefined),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, kind: 'done' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(dataStatements(result.log), [
    '1: <connect>', '1: BEGIN', `1: ${QUEUE_SQL}`, `1: ${SUBJECTS_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>',
  ]);
  const queue = result.log.find((entry) => entry.sql === QUEUE_SQL);
  assert.deepEqual(queue.params, [ADMIN_ID, CASE_ID, ACTION_ID, 'reply', TEXT]);
  const contextCall = result.log.find((entry) => entry.sql === CONTEXT_SQL);
  assert.deepEqual(contextCall.params, ['admin', ADMIN_ID, 'admin', 'admin.inbox.reply', REQUEST_ID]);
  assert.ok(result.log.indexOf(contextCall) < result.log.indexOf(queue), 'the audit context precedes the write');
  assert.doesNotMatch(JSON.stringify(result.log.map((entry) => entry.params)), new RegExp(PHONE.replace('+', '\\+')));
}

// request_info and resolve: the same definer, kind request_info / closing (no text).
{
  const info = await post({
    session: superadmin,
    body: { action: 'request_info', requestId: ACTION_ID, caseId: CASE_ID, text: TEXT },
    respond: (sql) => (sql === QUEUE_SQL ? [{ result_id: OUTBOX_ID, replayed: false }] : undefined),
  });
  assert.equal(info.status, 200);
  assert.deepEqual(info.log.find((entry) => entry.sql === QUEUE_SQL).params, [ADMIN_ID, CASE_ID, ACTION_ID, 'request_info', TEXT]);

  const resolve = await post({
    body: { action: 'resolve', requestId: ACTION_ID, caseId: CASE_ID, text: 'ignored' },
    respond: (sql) => (sql === QUEUE_SQL ? [{ result_id: OUTBOX_ID, replayed: false }] : undefined),
  });
  assert.equal(resolve.status, 200);
  assert.deepEqual(resolve.log.find((entry) => entry.sql === QUEUE_SQL).params, [ADMIN_ID, CASE_ID, ACTION_ID, 'closing', null]);
  assert.equal(resolve.log.find((entry) => entry.sql === CONTEXT_SQL).params[3], 'admin.inbox.resolve');
}

// A replay (same id, same payload) answers done again without a second record.
{
  const result = await post({
    body: { action: 'reply', requestId: ACTION_ID, caseId: CASE_ID, text: TEXT },
    respond: (sql) => (sql === QUEUE_SQL ? [{ result_id: OUTBOX_ID, replayed: true }] : undefined),
  });
  assert.deepEqual([result.status, result.body], [200, { ok: true, kind: 'done' }]);
  assert.equal(recordedEvents(result.log).length, 0, 'the first run was recorded; a replay is not');
  assert.ok(dataStatements(result.log).includes('1: COMMIT'));
}

// --- Every definer refusal maps to its K2.7 error and status -------------------------
for (const [code, status] of [
  ['case_closed', 409],
  ['reply_too_long_for_template', 400],
  ['no_reply_target', 404],
  ['not_found', 404],
  ['forbidden', 403],
  ['invalid_input', 400],
]) {
  const result = await post({
    body: { action: 'reply', requestId: ACTION_ID, caseId: CASE_ID, text: TEXT },
    respond: (sql) => (sql === QUEUE_SQL ? refusal(code) : undefined),
  });
  assert.equal(result.status, status, code);
  assert.deepEqual(result.body, code === 'reply_too_long_for_template'
    ? { ok: false, error: code, maxChars: 250 }
    : { ok: false, error: code });
  const lines = dataStatements(result.log);
  assert.deepEqual(lines.slice(0, 5), ['1: <connect>', '1: BEGIN', `1: ${QUEUE_SQL}`, '1: ROLLBACK', '1: <release>'], code);
  assert.equal(lines.includes('1: COMMIT'), false);
  assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome]), [[
    'attempt', code === 'not_found' ? 'not_found' : code === 'forbidden' ? 'denied' : 'failed',
  ]], code);
}
for (const [code, status] of [['not_locked', 409], ['no_reply_target', 404], ['not_found', 404]]) {
  const result = await post({
    body: { action: 'reset_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID, reasonCode: 'codes_not_arriving' },
    respond: (sql) => (sql === RESET_SQL ? refusal(code) : undefined),
  });
  assert.deepEqual([result.status, result.body], [status, { ok: false, error: code }], code);
}

// A database error that is not a refusal (or a refusal code with another
// message) is a 500 with a code-only log line; the message never leaks.
{
  const secretish = `relation detail ${PHONE}`;
  for (const error of [
    Object.assign(new Error(secretish), { code: 'P0001' }),
    Object.assign(new Error(secretish), { code: '23505' }),
    new Error(secretish),
  ]) {
    const result = await post({
      body: { action: 'reply', requestId: ACTION_ID, caseId: CASE_ID, text: TEXT },
      respond: (sql) => (sql === QUEUE_SQL ? error : undefined),
    });
    assert.deepEqual([result.status, result.body], [500, { ok: false, error: 'failed' }]);
    const logged = JSON.stringify(result.lines);
    assert.doesNotMatch(logged, /relation detail/);
    assert.doesNotMatch(logged, new RegExp(TEXT));
    assert.match(logged, /inbox_action_failed/);
  }
}

// --- Read-only: every mutation and the reveal are 403 before any definer -------------
for (const body of [
  { action: 'reply', requestId: ACTION_ID, caseId: CASE_ID, text: TEXT },
  { action: 'request_info', requestId: ACTION_ID, caseId: CASE_ID, text: TEXT },
  { action: 'resolve', requestId: ACTION_ID, caseId: CASE_ID },
  { action: 'reveal_phone', requestId: ACTION_ID, caseId: CASE_ID, justification: 'Calling the worker about the lockout today.' },
  { action: 'reset_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID, reasonCode: 'worker_confused' },
  { action: 'open_support_from_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID },
]) {
  const result = await post({ session: readonly, body });
  assert.deepEqual([result.status, result.body], [403, { ok: false, error: 'forbidden' }], body.action);
  const lines = dataStatements(result.log);
  assert.equal(lines.some((line) => /public\.admin_/.test(line)), false, `${body.action}: no definer runs`);
  assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome]), [['attempt', 'denied']]);
}

// --- Bodies that fail the hash or the parser: 400, never a definer -------------------
{
  const body = { action: 'reply', requestId: ACTION_ID, caseId: CASE_ID, text: TEXT };
  for (const options of [{ hash: null }, { hash: 'f'.repeat(64) }, { hash: 'not-a-hash' }]) {
    const result = await post({ body, ...options });
    assert.deepEqual([result.status, result.body], [400, { ok: false, error: 'invalid_input' }]);
    assert.equal(dataStatements(result.log).some((line) => /public\.admin_/.test(line)), false);
    assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome, event.surface]), [['attempt', 'failed', 'admin.inbox.reply']]);
  }
  for (const bad of [
    { ...body, requestId: 'not-a-uuid' },
    { ...body, text: '' },
    { ...body, text: 'x'.repeat(1001) },
    { action: 'reset_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID, reasonCode: 'other' },
  ]) {
    const result = await post({ body: bad });
    assert.deepEqual([result.status, result.body], [400, { ok: false, error: 'invalid_input' }]);
  }
  // A body that names no known action has no surface: answered, not recorded.
  for (const raw of ['{', JSON.stringify({ action: 'reply_whatsapp', requestId: ACTION_ID }), JSON.stringify([1])]) {
    const result = await post({ raw });
    assert.deepEqual([result.status, result.body], [400, { ok: false, error: 'invalid_input' }]);
    assert.equal(recordedEvents(result.log).length, 0);
  }
}

// --- reveal_phone: the number only after the record commits --------------------------
{
  const result = await post({
    body: { action: 'reveal_phone', requestId: ACTION_ID, caseId: CASE_ID, justification: 'Calling the worker about the lockout today.' },
    respond: (sql) => (sql === REVEAL_SQL ? [{ phone: PHONE }] : undefined),
  });
  assert.deepEqual([result.status, result.body], [200, { ok: true, kind: 'phone', phone: PHONE }]);
  assert.deepEqual(dataStatements(result.log), [
    '1: <connect>', '1: BEGIN', `1: ${SUBJECTS_SQL}`, `1: ${REVEAL_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>',
  ]);
  assert.equal(result.log.some((entry) => entry.sql === CONTEXT_SQL), false, 'a read sets no change-log context');
  assert.doesNotMatch(JSON.stringify(result.lines), new RegExp(PHONE.replace('+', '\\+')));

  const noNumber = await post({
    body: { action: 'reveal_phone', requestId: ACTION_ID, caseId: CASE_ID, justification: 'Calling the worker about the lockout today.' },
    respond: (sql) => (sql === REVEAL_SQL ? [{ phone: null }] : undefined),
  });
  assert.deepEqual([noNumber.status, noNumber.body], [404, { ok: false, error: 'no_reply_target' }]);
}

// --- open_media: every role; presigned after COMMIT, 300 s, signed at the recorded time ----
{
  process.env.SUPPORT_MEDIA_BUCKET = BUCKET;
  for (const session of [readonly, ops]) {
    const result = await post({
      session,
      body: { action: 'open_media', requestId: ACTION_ID, caseId: CASE_ID, mediaId: MEDIA_ID },
      respond: (sql) => (sql === MEDIA_SQL ? [{ outcome: 'ok', s3_key: MEDIA_KEY, content_type: 'image/jpeg' }] : undefined),
      presign: () => 'https://media.example.test/signed-link',
    });
    assert.equal(result.status, 200, session.role);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.kind, 'media');
    assert.equal(result.body.url, 'https://media.example.test/signed-link');
    const lines = dataStatements(result.log);
    assert.deepEqual(lines, [
      '1: <connect>', '1: BEGIN', `1: ${MEDIA_SQL}`, `1: ${SUBJECTS_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>', '-: <presign>',
    ]);
    const [call] = result.presignCalls;
    assert.equal(call.command, 'GetObject');
    assert.deepEqual(call.input, { Bucket: BUCKET, Key: MEDIA_KEY, ResponseContentType: 'image/jpeg', ResponseContentDisposition: 'inline' });
    assert.equal(call.options.expiresIn, 300);
    const [event] = recordedEvents(result.log);
    assert.equal(new Date(event.link_expires_at).getTime(), call.options.signingDate.getTime() + 300_000, 'the record names the link expiry');
    assert.equal(result.body.expiresAt, new Date(event.link_expires_at).toISOString());
    assert.doesNotMatch(JSON.stringify(result.lines), /support\//, 'the key is never logged');
  }

  const expired = await post({
    body: { action: 'open_media', requestId: ACTION_ID, caseId: CASE_ID, mediaId: MEDIA_ID },
    respond: (sql) => (sql === MEDIA_SQL ? [{ outcome: 'media_expired', s3_key: null, content_type: null }] : undefined),
  });
  assert.deepEqual([expired.status, expired.body, expired.presignCalls.length], [410, { ok: false, error: 'media_expired' }, 0]);
  const missing = await post({
    body: { action: 'open_media', requestId: ACTION_ID, caseId: CASE_ID, mediaId: MEDIA_ID },
    respond: (sql) => (sql === MEDIA_SQL ? [{ outcome: 'not_found', s3_key: null, content_type: null }] : undefined),
  });
  assert.deepEqual([missing.status, missing.body, missing.presignCalls.length], [404, { ok: false, error: 'not_found' }, 0]);

  // A stored type a browser should not render inline downloads instead.
  const html = await post({
    body: { action: 'open_media', requestId: ACTION_ID, caseId: CASE_ID, mediaId: MEDIA_ID },
    respond: (sql) => (sql === MEDIA_SQL ? [{ outcome: 'ok', s3_key: MEDIA_KEY, content_type: 'text/html' }] : undefined),
  });
  assert.deepEqual(
    [html.presignCalls[0].input.ResponseContentType, html.presignCalls[0].input.ResponseContentDisposition],
    ['application/octet-stream', 'attachment'],
  );

  // Without the bucket nothing is read or recorded as allowed: a failed attempt, 500.
  delete process.env.SUPPORT_MEDIA_BUCKET;
  const unset = await post({ body: { action: 'open_media', requestId: ACTION_ID, caseId: CASE_ID, mediaId: MEDIA_ID } });
  assert.equal(unset.status, 500);
  assert.equal(dataStatements(unset.log).some((line) => line.includes(MEDIA_SQL)), false);
  assert.deepEqual(recordedEvents(unset.log).map((event) => [event.kind, event.outcome]), [['attempt', 'failed']]);
}

// --- reset_lockout and open_support_from_lockout ---------------------------------------
{
  const reset = await post({
    body: { action: 'reset_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID, reasonCode: 'other', note: '  Confirmed on a call.  ' },
    respond: (sql) => (sql === RESET_SQL ? [{ result_id: NEW_CASE_ID, replayed: false }] : undefined),
  });
  assert.deepEqual([reset.status, reset.body], [200, { ok: true, kind: 'done' }]);
  assert.deepEqual(reset.log.find((entry) => entry.sql === RESET_SQL).params, [ADMIN_ID, CHALLENGE_ID, 'other', 'Confirmed on a call.', ACTION_ID]);
  assert.equal(reset.log.find((entry) => entry.sql === CONTEXT_SQL).params[3], 'admin.inbox.reset_lockout');

  const plain = await post({
    body: { action: 'reset_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID, reasonCode: 'typo_in_details' },
    respond: (sql) => (sql === RESET_SQL ? [{ result_id: NEW_CASE_ID, replayed: false }] : undefined),
  });
  assert.deepEqual(plain.log.find((entry) => entry.sql === RESET_SQL).params, [ADMIN_ID, CHALLENGE_ID, 'typo_in_details', null, ACTION_ID]);

  const open = await post({
    body: { action: 'open_support_from_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID },
    respond: (sql) => (sql === OPEN_SQL ? [{ result_id: NEW_CASE_ID.toUpperCase(), replayed: false }] : undefined),
  });
  assert.deepEqual([open.status, open.body], [200, { ok: true, kind: 'case', caseId: NEW_CASE_ID }]);
  assert.deepEqual(open.log.find((entry) => entry.sql === OPEN_SQL).params, [ADMIN_ID, CHALLENGE_ID, ACTION_ID]);
  assert.equal(open.log.find((entry) => entry.sql === CONTEXT_SQL).params[3], 'admin.inbox.open_support');

  const replay = await post({
    body: { action: 'open_support_from_lockout', requestId: ACTION_ID, challengeId: CHALLENGE_ID },
    respond: (sql) => (sql === OPEN_SQL ? [{ result_id: NEW_CASE_ID, replayed: true }] : undefined),
  });
  assert.deepEqual([replay.status, replay.body, recordedEvents(replay.log).length], [200, { ok: true, kind: 'case', caseId: NEW_CASE_ID }, 0]);
}

console.log('inbox action dispatch checks passed');
