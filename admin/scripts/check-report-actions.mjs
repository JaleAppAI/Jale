// Checks the Reports actions route (src/app/api/report-actions/route.ts and
// src/lib/server/report-actions.ts): the payload-hash header, the five
// actions and nothing else, each action's order inside its transaction, the
// presigned link only after COMMIT, an attempt event on every refusal, and
// that a revealed contact never reaches a log line or an event.
//
// The pool, the session, the Logs client and the S3 presigner are fakes.
// The real S3 presigner is exercised separately at the end, with credentials
// generated at runtime and no network call.
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
  name: 'report-actions',
  sources: ['src/app/api/report-actions/route.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    'src/lib/server/session.ts': 'scripts/fakes/session.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    '@aws-sdk/client-s3': 'scripts/fakes/s3-client.mjs',
    '@aws-sdk/s3-request-presigner': 'scripts/fakes/s3-request-presigner.mjs',
  },
});

const route = await load('src/app/api/report-actions/route.ts');
const actions = await load('src/lib/server/report-actions.ts');

const check = (globalThis.__adminCheck ??= {});

const ADMIN_ID = fakeUuid(0xa1);
const SESSION_ID = fakeUuid(0xa2);
const REQUEST_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const REPORT_ID = fakeUuid(0x8001);
const ACCOUNT_ID = fakeUuid(0x8002);
// One key per upload, used exactly as returned.
const IMAGE_KEY = `images/${REPORT_ID}/${fakeUuid(0x8003)}.png`;
const BUCKET = `check-report-images-${randomBytes(4).toString('hex')}`;
const CONTACT = `reporter-${randomBytes(6).toString('hex')}@example.test`;
const REASON = 'Following up on a failed application for this report.';
const RECIPIENT = `team-${randomBytes(5).toString('hex')}@example.test`;

function sessionFor(role) {
  return {
    sub: `check-${role}`,
    email: `${role}@example.test`,
    role,
    groups: [role],
    sessionId: SESSION_ID,
    adminUserId: ADMIN_ID,
    requestId: REQUEST_ID,
  };
}
const ops = sessionFor('admin_ops');
const readonly = sessionFor('admin_readonly');
const superadmin = sessionFor('admin_superadmin');
const preview = { preview: true, sub: 'local-preview-admin', role: 'admin_superadmin', groups: ['admin_superadmin'] };

const actorOf = (session) => ({
  actor_kind: 'admin',
  actor_id: ADMIN_ID,
  actor_role: session.role,
  actor_session: SESSION_ID,
  channel: 'admin',
});

const REVEAL_SQL = normalizeSql('SELECT outcome, contact_kind, contact, account_user_id FROM jale_cap.problem_report_reveal_contact($1::uuid)');
const IMAGE_SQL = normalizeSql('SELECT outcome, image_key, content_type, account_user_id FROM jale_cap.problem_report_image($1::uuid)');
const STATUS_SQL = normalizeSql('SELECT outcome, status FROM jale_cap.problem_report_set_status($1::uuid, $2::text)');
const NOTE_SQL = normalizeSql('SELECT outcome FROM jale_cap.problem_report_set_note($1::uuid, $2::text)');
const SETTINGS_SET_SQL = normalizeSql(`
  SELECT outcome FROM jale_cap.problem_report_settings_set(
    $1::uuid, $2::boolean, $3::boolean, $4::boolean, $5::boolean, $6::text, $7::text, $8::integer)
`);

assert.equal(normalizeSql(actions.REVEAL_CONTACT_SQL), REVEAL_SQL);
assert.equal(normalizeSql(actions.REPORT_IMAGE_SQL), IMAGE_SQL);
assert.equal(normalizeSql(actions.SET_STATUS_SQL), STATUS_SQL);
assert.equal(normalizeSql(actions.SET_NOTE_SQL), NOTE_SQL);
assert.equal(normalizeSql(actions.SETTINGS_SET_SQL), SETTINGS_SET_SQL);

const ATTEMPT_CONNECTION = (n) => [`${n}: <connect>`, `${n}: BEGIN`, `${n}: ${RECORD_EVENT_SQL}`, `${n}: COMMIT`, `${n}: <release>`];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Posts one request through the route. `respond(sql, params)` returns rows
 * for the data statements; COMMIT and record_event succeed unless `fail`
 * says otherwise.
 */
async function post({ session, body, raw, hash = 'auto', respond = () => undefined, fail = {}, presign } = {}) {
  let eventWrites = 0;
  const { pool, log } = createFakePool({
    respond: ({ sql, params }) => {
      if (sql === RECORD_EVENT_SQL) {
        eventWrites += 1;
        if (fail.event === eventWrites) throw Object.assign(new Error('record_event: could not write'), { code: '08006' });
        return { rows: [{ seq: String(eventWrites) }] };
      }
      if (sql === 'COMMIT' && fail.commit) {
        fail.commit = false;
        throw Object.assign(new Error('could not commit: connection reset'), { code: '08006' });
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return {};
      }
      const rows = respond(sql, params);
      if (rows instanceof Error) throw rows;
      return rows ? { rows } : {};
    },
  });
  check.pool = pool;
  check.session = session;
  check.presign = {
    calls: [],
    behavior: presign,
    onPresign: () => log.push({ connection: '-', op: 'presign' }),
  };

  const text = raw ?? JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (hash === 'auto') headers['x-amz-content-sha256'] = sha256(text);
  else if (hash) headers['x-amz-content-sha256'] = hash;

  const { result, lines } = await captureConsole(async () => {
    const response = await route.POST(new Request('https://admin.example.test/api/report-actions', {
      method: 'POST',
      headers,
      body: text,
    }));
    return { status: response.status, headers: response.headers, body: await response.json() };
  });
  return { ...result, log, lines, presignCalls: check.presign.calls };
}

function consoleText(lines) {
  return JSON.stringify(lines);
}

function sqlRan(log, sql) {
  return log.some((entry) => entry.sql === sql);
}

function assertNoStore(result, label) {
  assert.equal(result.headers.get('cache-control'), 'no-store', `${label}: responses are never cached`);
}

// ---------------------------------------------------------------------------
// The route answers only signed-in admins, with a payload hash, and only the
// five actions.
// ---------------------------------------------------------------------------

// No session: 401, and an anonymous denied attempt for a known action. The
// anonymous attempt carries no reason: only an admin may give one.
{
  const result = await post({ session: undefined, body: { action: 'reveal_contact', reportId: REPORT_ID, reason: REASON } });
  assert.equal(result.status, 401);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, 'unauthorized');
  assertNoStore(result, '401');
  assert.deepEqual(statements(result.log), ATTEMPT_CONNECTION(1));
  assert.deepEqual(recordedEvents(result.log), [{
    kind: 'attempt',
    outcome: 'denied',
    actor_kind: 'anonymous',
    channel: 'admin',
    surface: 'admin.report_contact_reveal',
    categories: ['problem_reports', 'contact_details'],
    subject_user_ids: [],
    record_type: 'problem_report',
    record_ids: [REPORT_ID],
    result_count: 1,
    field_names: ['contact'],
    request_id: recordedEvents(result.log)[0].request_id,
  }]);
  assert.match(recordedEvents(result.log)[0].request_id, /^[0-9a-f-]{36}$/);
}

// No session and no known action: 401 with nothing recorded (no surface).
for (const raw of ['{"action":"delete_everything"}', 'not json', '']) {
  const result = await post({ session: undefined, raw });
  assert.equal(result.status, 401, `401 for ${JSON.stringify(raw)}`);
  assert.deepEqual(result.log, [], `nothing is recorded for ${JSON.stringify(raw)}`);
}

// The payload hash is required and must match the body exactly.
for (const [label, hash] of [
  ['a missing hash', null],
  ['a hash of another body', sha256('{"action":"set_status"}')],
  ['a malformed hash', 'not-a-hash'],
]) {
  const result = await post({
    session: ops,
    body: { action: 'set_status', reportId: REPORT_ID, status: 'looking' },
    hash,
    respond: () => assert.fail('no data statement may run'),
  });
  assert.equal(result.status, 400, label);
  assert.equal(result.body.error, 'invalid_request', label);
  assertNoStore(result, label);
  assert.deepEqual(statements(result.log), ATTEMPT_CONNECTION(1), `${label}: only the attempt is written`);
  const [attempt] = recordedEvents(result.log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.record_ids, attempt.field_names],
    ['attempt', 'failed', 'admin.report_status', [REPORT_ID], ['status']],
    label,
  );
}

// An upper-case hex digest is the same hash.
{
  const body = { action: 'set_status', reportId: REPORT_ID, status: 'looking' };
  const result = await post({
    session: ops,
    body,
    hash: sha256(JSON.stringify(body)).toUpperCase(),
    respond: (sql) => (sql === STATUS_SQL ? [{ outcome: 'ok', status: 'looking' }] : undefined),
  });
  assert.equal(result.status, 200);
}

// Unparseable JSON and unknown actions: 400 with nothing recorded.
for (const [label, raw] of [
  ['invalid JSON', '{"action": "set_status",'],
  ['an array', '[]'],
  ['an unknown action', JSON.stringify({ action: 'reveal_pii', reportId: REPORT_ID })],
  ['a case action', JSON.stringify({ action: 'resolve_case', reportId: REPORT_ID })],
  ['a prototype key', JSON.stringify({ action: '__proto__', reportId: REPORT_ID })],
  ['no action', JSON.stringify({ reportId: REPORT_ID })],
]) {
  const result = await post({ session: superadmin, raw });
  assert.equal(result.status, 400, label);
  assert.equal(result.body.error, 'invalid_request', label);
  assert.deepEqual(result.log, [], `${label}: nothing is recorded`);
}

// An oversized body is refused before it is parsed.
{
  const result = await post({ session: ops, raw: JSON.stringify({ action: 'set_note', reportId: REPORT_ID, note: 'n'.repeat(70_000) }) });
  assert.equal(result.status, 400);
  assert.deepEqual(result.log, []);
}

// ---------------------------------------------------------------------------
// Validation failures (400) and role refusals (403) record their attempt and
// run no data statement.
// ---------------------------------------------------------------------------
const noData = () => assert.fail('no data statement may run');

for (const [label, session, body, status, expected] of [
  ['a 19-character reason', ops, { action: 'reveal_contact', reportId: REPORT_ID, reason: 'r'.repeat(19) }, 400,
    { outcome: 'failed', surface: 'admin.report_contact_reveal', record_ids: [REPORT_ID], field_names: ['contact'], reason: 'r'.repeat(19) }],
  ['a 501-character reason', ops, { action: 'reveal_contact', reportId: REPORT_ID, reason: 'r'.repeat(501) }, 400,
    { outcome: 'failed', surface: 'admin.report_contact_reveal', record_ids: [REPORT_ID], field_names: ['contact'], reason: undefined }],
  ['a missing reason', ops, { action: 'reveal_contact', reportId: REPORT_ID }, 400,
    { outcome: 'failed', surface: 'admin.report_contact_reveal', record_ids: [REPORT_ID], field_names: ['contact'], reason: undefined }],
  ['a malformed report id', ops, { action: 'reveal_contact', reportId: 'JR-1042', reason: REASON }, 400,
    { outcome: 'failed', surface: 'admin.report_contact_reveal', record_ids: [], field_names: ['contact'], reason: REASON }],
  ['an unknown status', ops, { action: 'set_status', reportId: REPORT_ID, status: 'closed' }, 400,
    { outcome: 'failed', surface: 'admin.report_status', record_ids: [REPORT_ID], field_names: ['status'] }],
  ['a note over 4000 characters', ops, { action: 'set_note', reportId: REPORT_ID, note: 'n'.repeat(4001) }, 400,
    { outcome: 'failed', surface: 'admin.report_note', record_ids: [REPORT_ID], field_names: ['internal_note'] }],
  ['a note that is not text', ops, { action: 'set_note', reportId: REPORT_ID, note: 42 }, 400,
    { outcome: 'failed', surface: 'admin.report_note', record_ids: [REPORT_ID], field_names: ['internal_note'] }],
  ['a screenshot without a report', ops, { action: 'view_screenshot' }, 400,
    { outcome: 'failed', surface: 'admin.report_screenshot', record_ids: [], field_names: [] }],
  ['a cap over 5000', superadmin, { action: 'update_settings', settings: { signedOutDailyCap: 5001 } }, 400,
    { outcome: 'failed', surface: 'admin.report_settings', record_ids: [], field_names: [] }],
  ['a fractional cap', superadmin, { action: 'update_settings', settings: { signedOutDailyCap: 2.5 } }, 400,
    { outcome: 'failed', surface: 'admin.report_settings', record_ids: [], field_names: [] }],
  ['a switch that is not a boolean', superadmin, { action: 'update_settings', settings: { reportingEnabled: 'yes' } }, 400,
    { outcome: 'failed', surface: 'admin.report_settings', record_ids: [], field_names: [] }],
  ['nothing to change', superadmin, { action: 'update_settings', settings: {} }, 400,
    { outcome: 'failed', surface: 'admin.report_settings', record_ids: [], field_names: [] }],
  ['read-only reveal', readonly, { action: 'reveal_contact', reportId: REPORT_ID, reason: REASON }, 403,
    { outcome: 'denied', surface: 'admin.report_contact_reveal', record_ids: [REPORT_ID], field_names: ['contact'], reason: REASON }],
  ['read-only screenshot', readonly, { action: 'view_screenshot', reportId: REPORT_ID }, 403,
    { outcome: 'denied', surface: 'admin.report_screenshot', record_ids: [REPORT_ID], field_names: [] }],
  ['read-only status', readonly, { action: 'set_status', reportId: REPORT_ID, status: 'fixed' }, 403,
    { outcome: 'denied', surface: 'admin.report_status', record_ids: [REPORT_ID], field_names: ['status'] }],
  ['read-only note', readonly, { action: 'set_note', reportId: REPORT_ID, note: 'Seen.' }, 403,
    { outcome: 'denied', surface: 'admin.report_note', record_ids: [REPORT_ID], field_names: ['internal_note'] }],
  ['ops settings', ops, { action: 'update_settings', settings: { reportingEnabled: false } }, 403,
    { outcome: 'denied', surface: 'admin.report_settings', record_ids: [], field_names: [] }],
  ['read-only settings', readonly, { action: 'update_settings', settings: { reportingEnabled: false } }, 403,
    { outcome: 'denied', surface: 'admin.report_settings', record_ids: [], field_names: [] }],
]) {
  process.env.REPORT_IMAGES_BUCKET = BUCKET;
  const result = await post({ session, body, respond: noData });
  assert.equal(result.status, status, label);
  assert.equal(result.body.error, status === 403 ? 'forbidden' : 'invalid_request', label);
  assertNoStore(result, label);
  assert.deepEqual(statements(result.log), ATTEMPT_CONNECTION(1), `${label}: only the attempt is written`);
  const [attempt] = recordedEvents(result.log);
  assert.equal(attempt.kind, 'attempt', label);
  assert.equal(attempt.outcome, expected.outcome, label);
  assert.equal(attempt.surface, expected.surface, label);
  assert.deepEqual(attempt.record_ids, expected.record_ids, label);
  assert.deepEqual(attempt.field_names, expected.field_names, label);
  assert.equal(attempt.reason, expected.reason, `${label}: the reason is kept only when the audit can hold it`);
  assert.equal(attempt.actor_role, session.role, label);
}

// ---------------------------------------------------------------------------
// reveal_contact: the function, then the access event with its subject, then
// COMMIT; the value leaves only after COMMIT and is never logged or recorded.
// ---------------------------------------------------------------------------
const revealOk = (overrides = {}) => (sql, params) => {
  if (sql === REVEAL_SQL) {
    assert.deepEqual(params, [REPORT_ID]);
    return [{ outcome: 'ok', contact_kind: 'typed', contact: CONTACT, account_user_id: ACCOUNT_ID, ...overrides }];
  }
  return undefined;
};

{
  const result = await post({ session: ops, body: { action: 'reveal_contact', reportId: REPORT_ID.toUpperCase(), reason: `  ${REASON}  ` }, respond: revealOk() });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, revealed: { kind: 'typed', contact: CONTACT } });
  assertNoStore(result, 'reveal');
  assert.deepEqual(statements(result.log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${REVEAL_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: <release>',
  ]);
  assert.deepEqual(recordedEvents(result.log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actorOf(ops),
    surface: 'admin.report_contact_reveal',
    categories: ['problem_reports', 'contact_details'],
    subject_user_ids: [ACCOUNT_ID],
    record_type: 'problem_report',
    record_ids: [REPORT_ID],
    result_count: 1,
    field_names: ['contact'],
    purpose_kind: 'reveal',
    reason: REASON,
    request_id: REQUEST_ID,
  }]);
  assert.equal(consoleText(result.lines).includes(CONTACT), false, 'the revealed value is never logged');
  assert.equal(JSON.stringify(result.log).includes(CONTACT), false, 'the revealed value is never written to an event');
}

// A typed contact without an account names no subject.
{
  const result = await post({ session: superadmin, body: { action: 'reveal_contact', reportId: REPORT_ID, reason: REASON }, respond: revealOk({ account_user_id: null }) });
  assert.equal(result.status, 200);
  assert.deepEqual(recordedEvents(result.log)[0].subject_user_ids, []);
}

// Non-ok outcomes: rolled back with no access event, then the attempt.
for (const [outcome, status, attemptOutcome] of [
  ['not_found', 404, 'not_found'],
  ['content_erased', 400, 'failed'],
  ['no_contact', 400, 'failed'],
]) {
  const result = await post({
    session: ops,
    body: { action: 'reveal_contact', reportId: REPORT_ID, reason: REASON },
    respond: (sql) => (sql === REVEAL_SQL ? [{ outcome, contact_kind: null, contact: null, account_user_id: null }] : undefined),
  });
  assert.equal(result.status, status, outcome);
  assert.equal(result.body.error, outcome, outcome);
  assert.equal('revealed' in result.body, false);
  assert.deepEqual(statements(result.log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${REVEAL_SQL}`,
    '1: ROLLBACK',
    '1: <release>',
    ...ATTEMPT_CONNECTION(2),
  ], `${outcome}: no access event is kept, and the attempt follows the release`);
  assert.deepEqual(recordedEvents(result.log), [{
    kind: 'attempt',
    outcome: attemptOutcome,
    ...actorOf(ops),
    surface: 'admin.report_contact_reveal',
    categories: ['problem_reports', 'contact_details'],
    subject_user_ids: [],
    record_type: 'problem_report',
    record_ids: [REPORT_ID],
    result_count: 1,
    field_names: ['contact'],
    purpose_kind: 'reveal',
    reason: REASON,
    request_id: REQUEST_ID,
  }]);
}

// The access event cannot be written: rolled back, 500, a failed attempt
// afterwards, and the value appears nowhere.
{
  const result = await post({
    session: ops,
    body: { action: 'reveal_contact', reportId: REPORT_ID, reason: REASON },
    respond: revealOk(),
    fail: { event: 1 },
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'failed');
  assert.deepEqual(statements(result.log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${REVEAL_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: ROLLBACK',
    '1: <release>',
    ...ATTEMPT_CONNECTION(2),
  ]);
  const [attempt] = recordedEvents(result.log).slice(-1);
  assert.deepEqual([attempt.kind, attempt.outcome, attempt.surface], ['attempt', 'failed', 'admin.report_contact_reveal']);
  assert.equal(JSON.stringify(result.body).includes(CONTACT), false);
  assert.equal(consoleText(result.lines).includes(CONTACT), false);
  assert.equal(JSON.stringify(result.log).includes(CONTACT), false);
  assert.doesNotMatch(consoleText(result.lines), /could not write/, 'no database text is logged');
}

// COMMIT itself fails: 500 and no value in the response.
{
  const result = await post({
    session: ops,
    body: { action: 'reveal_contact', reportId: REPORT_ID, reason: REASON },
    respond: revealOk(),
    fail: { commit: true },
  });
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result.body).includes(CONTACT), false, 'no value leaves when COMMIT fails');
  assert.equal(consoleText(result.lines).includes(CONTACT), false);
  assert.deepEqual(statements(result.log).slice(0, 6), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${REVEAL_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: ROLLBACK',
  ]);
  assert.deepEqual(recordedEvents(result.log).slice(-1).map((event) => [event.kind, event.outcome]), [['attempt', 'failed']]);
}

// An outcome row that is not a usable contact fails closed.
{
  const result = await post({
    session: ops,
    body: { action: 'reveal_contact', reportId: REPORT_ID, reason: REASON },
    respond: revealOk({ contact_kind: 'raw' }),
  });
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result.body).includes(CONTACT), false);
  assert.equal(recordedEvents(result.log).filter((event) => event.kind === 'read').length, 0);
}

// ---------------------------------------------------------------------------
// view_screenshot: the function, then the access event with the link expiry,
// then COMMIT, and only then the 300-second presigned GET.
// ---------------------------------------------------------------------------
const imageOk = (overrides = {}) => (sql, params) => {
  if (sql === IMAGE_SQL) {
    assert.deepEqual(params, [REPORT_ID]);
    return [{ outcome: 'ok', image_key: IMAGE_KEY, content_type: 'image/png', account_user_id: ACCOUNT_ID, ...overrides }];
  }
  return undefined;
};

{
  process.env.REPORT_IMAGES_BUCKET = BUCKET;
  const before = Date.now();
  const result = await post({ session: ops, body: { action: 'view_screenshot', reportId: REPORT_ID }, respond: imageOk() });
  assert.equal(result.status, 200);
  assert.deepEqual(statements(result.log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${IMAGE_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: <release>',
    '-: <presign>',
  ], 'the link is minted only after COMMIT and the release');

  assert.equal(result.presignCalls.length, 1);
  const [call] = result.presignCalls;
  assert.equal(call.command, 'GetObject');
  assert.deepEqual(call.input, {
    Bucket: BUCKET,
    Key: IMAGE_KEY,
    ResponseContentType: 'image/png',
    ResponseContentDisposition: 'inline',
  });
  assert.equal(call.options.expiresIn, 300);
  assert.ok(call.options.signingDate instanceof Date);
  const issuedAt = call.options.signingDate.getTime();
  assert.ok(issuedAt >= before && issuedAt <= Date.now());

  const [event] = recordedEvents(result.log);
  assert.deepEqual(event, {
    kind: 'read',
    outcome: 'allowed',
    ...actorOf(ops),
    surface: 'admin.report_screenshot',
    categories: ['problem_reports'],
    subject_user_ids: [ACCOUNT_ID],
    record_type: 'problem_report',
    record_ids: [REPORT_ID],
    result_count: 1,
    field_names: [],
    link_expires_at: new Date(issuedAt + 300_000).toISOString(),
    request_id: REQUEST_ID,
  });
  assert.deepEqual(result.body, {
    ok: true,
    url: 'https://images.example.test/signed-link',
    expiresAt: new Date(issuedAt + 300_000).toISOString(),
  }, 'the recorded expiry is the link expiry');
  assertNoStore(result, 'screenshot');
  assert.equal(consoleText(result.lines).includes('signed-link'), false, 'the link is never logged');
  assert.equal(consoleText(result.lines).includes(IMAGE_KEY), false, 'the object key is never logged');
  assert.equal(JSON.stringify(recordedEvents(result.log)).includes(IMAGE_KEY), false, 'the object key is never recorded');
}

// No bucket configured: fail closed before any transaction.
{
  delete process.env.REPORT_IMAGES_BUCKET;
  const result = await post({ session: ops, body: { action: 'view_screenshot', reportId: REPORT_ID }, respond: noData });
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'failed');
  assert.deepEqual(statements(result.log), ATTEMPT_CONNECTION(1), 'no access event for a link that cannot be minted');
  assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome, event.surface, event.record_ids]), [
    ['attempt', 'failed', 'admin.report_screenshot', [REPORT_ID]],
  ]);
  assert.equal(result.presignCalls.length, 0);
  process.env.REPORT_IMAGES_BUCKET = '   ';
  const blank = await post({ session: ops, body: { action: 'view_screenshot', reportId: REPORT_ID }, respond: noData });
  assert.equal(blank.status, 500, 'a blank bucket name is unset');
  process.env.REPORT_IMAGES_BUCKET = BUCKET;
}

// Non-ok outcomes: rolled back, no access event, no link.
for (const [outcome, status, attemptOutcome] of [
  ['not_found', 404, 'not_found'],
  ['no_image', 400, 'failed'],
  ['image_expired', 400, 'failed'],
]) {
  const result = await post({
    session: ops,
    body: { action: 'view_screenshot', reportId: REPORT_ID },
    respond: (sql) => (sql === IMAGE_SQL ? [{ outcome, image_key: null, content_type: null, account_user_id: null }] : undefined),
  });
  assert.equal(result.status, status, outcome);
  assert.equal(result.body.error, outcome);
  assert.deepEqual(statements(result.log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${IMAGE_SQL}`,
    '1: ROLLBACK',
    '1: <release>',
    ...ATTEMPT_CONNECTION(2),
  ], outcome);
  assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome, event.surface]), [['attempt', attemptOutcome, 'admin.report_screenshot']]);
  assert.equal(result.presignCalls.length, 0);
}

// A stored type that is not one of the three image types: no link.
{
  const result = await post({ session: ops, body: { action: 'view_screenshot', reportId: REPORT_ID }, respond: imageOk({ content_type: 'text/html' }) });
  assert.equal(result.status, 500);
  assert.equal(result.presignCalls.length, 0);
  assert.equal(recordedEvents(result.log).filter((event) => event.kind === 'read').length, 0);
  assert.ok(statements(result.log).includes('1: ROLLBACK'));
}

// Minting fails after COMMIT: 500 and a failed attempt.
{
  const result = await post({
    session: ops,
    body: { action: 'view_screenshot', reportId: REPORT_ID },
    respond: imageOk(),
    presign: () => new Error('CredentialsProviderError: could not load credentials'),
  });
  assert.equal(result.status, 500);
  assert.equal('url' in result.body, false);
  assert.deepEqual(statements(result.log), [
    '1: <connect>',
    '1: BEGIN',
    `1: ${IMAGE_SQL}`,
    `1: ${RECORD_EVENT_SQL}`,
    '1: COMMIT',
    '1: <release>',
    '-: <presign>',
    ...ATTEMPT_CONNECTION(2),
  ]);
  assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome, event.surface]), [
    ['read', 'allowed', 'admin.report_screenshot'],
    ['attempt', 'failed', 'admin.report_screenshot'],
  ]);
  assert.doesNotMatch(consoleText(result.lines), /CredentialsProviderError/);
}

// ---------------------------------------------------------------------------
// set_status and set_note: the function, then the action event, then COMMIT.
// ---------------------------------------------------------------------------
{
  const result = await post({
    session: ops,
    body: { action: 'set_status', reportId: REPORT_ID, status: 'looking' },
    respond: (sql, params) => {
      if (sql === STATUS_SQL) {
        assert.deepEqual(params, [REPORT_ID, 'looking']);
        return [{ outcome: 'ok', status: 'looking' }];
      }
      return undefined;
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'looking');
  assert.deepEqual(statements(result.log), ['1: <connect>', '1: BEGIN', `1: ${STATUS_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  assert.deepEqual(recordedEvents(result.log), [{
    kind: 'action',
    outcome: 'done',
    ...actorOf(ops),
    surface: 'admin.report_status',
    categories: ['problem_reports'],
    subject_user_ids: [],
    record_type: 'problem_report',
    record_ids: [REPORT_ID],
    result_count: 1,
    field_names: ['status'],
    request_id: REQUEST_ID,
  }]);
}

for (const [outcome, status, attemptOutcome] of [['not_found', 404, 'not_found'], ['invalid_status', 400, 'failed']]) {
  const result = await post({
    session: superadmin,
    body: { action: 'set_status', reportId: REPORT_ID, status: 'wont_fix' },
    respond: (sql) => (sql === STATUS_SQL ? [{ outcome, status: null }] : undefined),
  });
  assert.equal(result.status, status, outcome);
  assert.deepEqual(statements(result.log), ['1: <connect>', '1: BEGIN', `1: ${STATUS_SQL}`, '1: ROLLBACK', '1: <release>', ...ATTEMPT_CONNECTION(2)]);
  assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome, event.surface]), [['attempt', attemptOutcome, 'admin.report_status']]);
}

// One note per report: a value replaces it; a blank value clears it.
for (const [note, param] of [['Checked the request logs; waiting on a fix.', 'Checked the request logs; waiting on a fix.'], ['   ', null], ['', null]]) {
  const result = await post({
    session: ops,
    body: { action: 'set_note', reportId: REPORT_ID, note },
    respond: (sql, params) => {
      if (sql === NOTE_SQL) {
        assert.deepEqual(params, [REPORT_ID, param]);
        return [{ outcome: 'ok' }];
      }
      return undefined;
    },
  });
  assert.equal(result.status, 200, JSON.stringify(note));
  assert.deepEqual(statements(result.log), ['1: <connect>', '1: BEGIN', `1: ${NOTE_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  const [event] = recordedEvents(result.log);
  assert.deepEqual(
    [event.kind, event.outcome, event.surface, event.record_ids, event.field_names],
    ['action', 'done', 'admin.report_note', [REPORT_ID], ['internal_note']],
  );
  if (param) assert.equal(JSON.stringify(event).includes(param), false, 'the note text is never in the event');
}

// A note of exactly 4000 characters (counted as the database counts them).
{
  const note = '\u{1F527}'.repeat(4000);
  const result = await post({ session: ops, body: { action: 'set_note', reportId: REPORT_ID, note }, respond: (sql) => (sql === NOTE_SQL ? [{ outcome: 'ok' }] : undefined) });
  assert.equal(result.status, 200, '4000 characters outside the basic plane are still 4000 characters');
}

for (const [outcome, status] of [['content_erased', 400], ['invalid_note', 400], ['not_found', 404]]) {
  const result = await post({
    session: ops,
    body: { action: 'set_note', reportId: REPORT_ID, note: 'Seen.' },
    respond: (sql) => (sql === NOTE_SQL ? [{ outcome }] : undefined),
  });
  assert.equal(result.status, status, outcome);
  assert.equal(result.body.error, outcome);
  assert.equal(recordedEvents(result.log).filter((event) => event.kind === 'action').length, 0);
}

// A database error (the stub raises 0A000 today): 500, a failed attempt, and
// a log line with codes only.
{
  const result = await post({
    session: ops,
    body: { action: 'set_note', reportId: REPORT_ID, note: 'Seen.' },
    respond: (sql) => (sql === NOTE_SQL
      ? Object.assign(new Error('jale_cap.problem_report_set_note is not implemented yet'), { code: '0A000' })
      : undefined),
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'failed');
  assert.deepEqual(statements(result.log), ['1: <connect>', '1: BEGIN', `1: ${NOTE_SQL}`, '1: ROLLBACK', '1: <release>', ...ATTEMPT_CONNECTION(2)]);
  assert.doesNotMatch(consoleText(result.lines), /not implemented/);
  const failure = result.lines.error
    .filter((args) => args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{'))
    .map((args) => JSON.parse(args[0]))
    .find((line) => line.event === 'report_action_failed');
  assert.deepEqual(failure, { event: 'report_action_failed', action: 'set_note', code: '0A000', request_id: REQUEST_ID });
}

// ---------------------------------------------------------------------------
// update_settings: superadmin only; NULL means unchanged; the admin id comes
// from the session; the mailbox never reaches a log line or an event.
// ---------------------------------------------------------------------------
{
  const result = await post({
    session: superadmin,
    body: {
      action: 'update_settings',
      settings: {
        reportingEnabled: true,
        signedOutEnabled: false,
        screenshotsEnabled: true,
        teamEmailEnabled: true,
        signedOutDailyCap: 150,
        teamRecipient: ` ${RECIPIENT} `,
        adminBaseUrl: ' https://Dashboard.Example.test/ ',
      },
    },
    respond: (sql, params) => {
      if (sql === SETTINGS_SET_SQL) {
        assert.deepEqual(params, [ADMIN_ID, true, false, true, true, RECIPIENT, 'https://dashboard.example.test', 150]);
        return [{ outcome: 'ok' }];
      }
      return undefined;
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(statements(result.log), ['1: <connect>', '1: BEGIN', `1: ${SETTINGS_SET_SQL}`, `1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  assert.deepEqual(recordedEvents(result.log), [{
    kind: 'action',
    outcome: 'done',
    ...actorOf(superadmin),
    surface: 'admin.report_settings',
    categories: ['problem_reports'],
    subject_user_ids: [],
    record_ids: [],
    result_count: 1,
    field_names: [
      'reporting_enabled',
      'signed_out_enabled',
      'screenshots_enabled',
      'team_email_enabled',
      'signed_out_daily_cap',
      'team_recipient',
      'admin_base_url',
    ],
    request_id: REQUEST_ID,
  }]);
  assert.equal(JSON.stringify(recordedEvents(result.log)).includes(RECIPIENT), false, 'the mailbox is never in an event');
  assert.equal(consoleText(result.lines).includes(RECIPIENT), false, 'the mailbox is never logged');
  assert.equal(JSON.stringify(result.body).includes(RECIPIENT), false, 'the mailbox is not echoed back');
}

// Left out or blank means unchanged (NULL), and only what was sent is named.
{
  const result = await post({
    session: superadmin,
    body: { action: 'update_settings', settings: { screenshotsEnabled: false, teamRecipient: '   ', adminBaseUrl: '' } },
    respond: (sql, params) => {
      if (sql === SETTINGS_SET_SQL) {
        assert.deepEqual(params, [ADMIN_ID, null, null, false, null, null, null, null]);
        return [{ outcome: 'ok' }];
      }
      return undefined;
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(recordedEvents(result.log)[0].field_names, ['screenshots_enabled']);
}

// The database refuses a value: rolled back, a failed attempt, no mailbox
// in any log line or event.
for (const outcome of ['invalid_recipient', 'invalid_base_url', 'invalid_cap']) {
  const result = await post({
    session: superadmin,
    body: { action: 'update_settings', settings: { teamRecipient: RECIPIENT, signedOutDailyCap: 10 } },
    respond: (sql) => (sql === SETTINGS_SET_SQL ? [{ outcome }] : undefined),
  });
  assert.equal(result.status, 400, outcome);
  assert.equal(result.body.error, outcome);
  assert.deepEqual(statements(result.log), ['1: <connect>', '1: BEGIN', `1: ${SETTINGS_SET_SQL}`, '1: ROLLBACK', '1: <release>', ...ATTEMPT_CONNECTION(2)]);
  assert.deepEqual(recordedEvents(result.log).map((event) => [event.kind, event.outcome, event.surface]), [['attempt', 'failed', 'admin.report_settings']]);
  assert.equal(JSON.stringify(recordedEvents(result.log)).includes(RECIPIENT), false);
  assert.equal(consoleText(result.lines).includes(RECIPIENT), false);
}

// The local preview session has no admin id: NULL, and nothing is recorded.
{
  const result = await post({
    session: preview,
    body: { action: 'update_settings', settings: { reportingEnabled: false } },
    respond: (sql, params) => {
      if (sql === SETTINGS_SET_SQL) {
        assert.equal(params[0], null, 'preview passes no admin id');
        return [{ outcome: 'ok' }];
      }
      return undefined;
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(statements(result.log), ['1: <connect>', '1: BEGIN', `1: ${SETTINGS_SET_SQL}`, '1: COMMIT', '1: <release>']);
}

// ---------------------------------------------------------------------------
// The real presigner: a 300-second GET that forces the stored image type and
// inline display, signed with credentials generated here. No network call.
// ---------------------------------------------------------------------------
{
  const imagesBuild = compileAdminSources({ name: 'report-images', sources: ['src/lib/server/report-images.ts'] });
  const images = await imagesBuild.load('src/lib/server/report-images.ts');

  assert.equal(images.REPORT_IMAGE_LINK_SECONDS, 300);
  assert.deepEqual(images.buildReportImageGetInput({ bucket: BUCKET, key: IMAGE_KEY, contentType: 'image/webp' }), {
    Bucket: BUCKET,
    Key: IMAGE_KEY,
    ResponseContentType: 'image/webp',
    ResponseContentDisposition: 'inline',
  });
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) assert.equal(images.isReportImageContentType(type), true, type);
  for (const type of ['image/svg+xml', 'text/html', 'image/gif', '', null]) assert.equal(images.isReportImageContentType(type), false, String(type));

  process.env.REPORT_IMAGES_BUCKET = ` ${BUCKET} `;
  assert.equal(images.reportImagesBucket(), BUCKET, 'read at call time and trimmed');
  delete process.env.REPORT_IMAGES_BUCKET;
  assert.equal(images.reportImagesBucket(), undefined);

  const client = images.createReportImagesClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: `CHECK${randomBytes(8).toString('hex').toUpperCase()}`,
      secretAccessKey: randomBytes(20).toString('base64url'),
    },
  });
  const issuedAt = new Date(Date.UTC(2026, 9, 2, 12, 0, 0));
  const signed = new URL(await images.presignReportImage({ bucket: BUCKET, key: IMAGE_KEY, contentType: 'image/webp', issuedAt }, client));
  assert.equal(signed.protocol, 'https:');
  assert.ok(signed.hostname.startsWith(`${BUCKET}.`), 'virtual-hosted bucket');
  assert.equal(decodeURIComponent(signed.pathname), `/${IMAGE_KEY}`, 'the key is used exactly as given');
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(signed.searchParams.get('X-Amz-Date'), '20261002T120000Z', 'signed at the recorded time');
  assert.equal(signed.searchParams.get('X-Amz-SignedHeaders'), 'host', 'a browser can open it with no extra header');
  assert.equal(signed.searchParams.get('response-content-type'), 'image/webp');
  assert.equal(signed.searchParams.get('response-content-disposition'), 'inline');
  assert.equal(signed.searchParams.has('x-amz-checksum-mode'), false);
}

console.log('admin report action checks passed');
