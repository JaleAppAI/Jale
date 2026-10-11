// Checks the admin session events: signed_in, a recorded
// sign_in_rejected in place of the swallowed error, signed_out, and expired
// recorded once. Route handlers run against fakes for next/*, the token
// verifier, the pool and the Logs client.
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
  name: 'audit-session',
  sources: ['src/app/api/session/route.ts', 'src/lib/server/session.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    'next/headers': 'scripts/fakes/next-headers.mjs',
    'next/server': 'scripts/fakes/next-server.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
    'aws-jwt-verify': 'scripts/fakes/aws-jwt-verify.mjs',
  },
});

process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID = 'us-east-1_CheckPool';
process.env.NEXT_PUBLIC_ADMIN_CLIENT_ID = 'check-client';
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';

const route = await load('src/app/api/session/route.ts');
const session = await load('src/lib/server/session.ts');

const check = (globalThis.__adminCheck = { cookies: new Map() });
const COOKIE = 'jale_admin_id_token_v2';
const ADMIN_ID = fakeUuid(0xd1);
const SESSION_ID = fakeUuid(0xd2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERIFIED_SUB = 'verified-sub-not-stored';

function sessionRow(overrides = {}) {
  return {
    session_id: SESSION_ID,
    admin_user_id: ADMIN_ID,
    cognito_sub: 'check-admin-sub',
    admin_email: 'ops-admin@example.test',
    role: 'admin_ops',
    expires_at: new Date(Date.now() + 30 * 60 * 1000),
    active: true,
    ...overrides,
  };
}

function signInRequest(body) {
  return new Request('https://admin.example.test/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'check-browser' },
    body: JSON.stringify(body),
  });
}

function sessionDb({ adminProvisioned = true, row = sessionRow(), revokeRows, expireRows } = {}) {
  return createFakePool({
    respond: ({ sql }) => {
      if (sql.startsWith('INSERT INTO admin_sessions')) {
        return { rows: adminProvisioned ? [{ expires_at: new Date(Date.now() + 3600 * 1000) }] : [] };
      }
      if (sql.includes('FROM admin_sessions s')) {
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("UPDATE admin_sessions SET revoked_at = NOW(), revoke_reason = 'expired'")) {
        return { rows: expireRows?.() ?? [] };
      }
      if (sql.startsWith('UPDATE admin_sessions')) {
        return { rows: revokeRows?.() ?? [] };
      }
      return {};
    },
  });
}

const eventStatements = (connection) => [
  `${connection}: <connect>`,
  `${connection}: BEGIN`,
  `${connection}: ${RECORD_EVENT_SQL}`,
  `${connection}: COMMIT`,
  `${connection}: <release>`,
];

// --- A token that fails verification is recorded, not swallowed -----------
{
  const { pool, log } = sessionDb();
  check.pool = pool;
  check.verifyToken = async () => { throw new Error('Token expired'); };
  const response = await route.POST(signInRequest({ idToken: 'token-value' }));
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'invalid_admin_token' });
  assert.deepEqual(response.cookieSets, []);
  assert.deepEqual(statements(log), eventStatements(1));
  const [event] = recordedEvents(log);
  assert.equal(event.kind, 'session');
  assert.equal(event.outcome, 'sign_in_rejected');
  assert.equal(event.actor_kind, 'anonymous');
  assert.equal(event.surface, 'admin.session');
  assert.deepEqual(event.categories, ['admin_access']);
  assert.equal('actor_id' in event, false);
  assert.match(event.request_id, UUID);
}

// --- A verified token with no active admin: rejected, and the sub is not stored
{
  const { pool, log } = sessionDb({ adminProvisioned: false });
  check.pool = pool;
  check.verifyToken = async () => ({ sub: VERIFIED_SUB, email: 'someone@example.test', 'cognito:groups': ['admin_ops'] });
  const response = await route.POST(signInRequest({ idToken: 'token-value' }));
  assert.equal(response.status, 401);
  assert.deepEqual(statements(log).slice(0, 1), ['pool: INSERT INTO admin_sessions (token_hash, admin_user_id, cognito_jti, expires_at, user_agent_hash) SELECT $1, id, NULL, $3, $4 FROM admin_users WHERE cognito_sub = $2 AND active = true AND role IN (\'admin_readonly\', \'admin_ops\', \'admin_superadmin\') RETURNING expires_at']);
  const events = recordedEvents(log);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'sign_in_rejected');
  assert.equal(events[0].actor_kind, 'anonymous');
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`${VERIFIED_SUB}|someone@example`));
}

// --- A missing token is a 400 and records nothing ---------------------------
{
  const { pool, log } = sessionDb();
  check.pool = pool;
  const response = await route.POST(signInRequest({}));
  assert.equal(response.status, 400);
  assert.deepEqual(log, []);
}

// --- A successful sign-in records signed_in for the new session ------------
{
  const { pool, log } = sessionDb();
  check.pool = pool;
  check.verifyToken = async () => ({ sub: 'check-admin-sub', email: 'ops-admin@example.test', 'cognito:groups': ['admin_ops'] });
  const response = await route.POST(signInRequest({ idToken: 'token-value' }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, role: 'admin_ops', email: 'ops-admin@example.test' });
  assert.equal(response.cookieSets.length, 1);
  assert.equal(response.cookieSets[0].name, COOKIE);
  const lines = statements(log);
  assert.match(lines[0], /^pool: INSERT INTO admin_sessions/);
  assert.match(lines[1], /^pool: SELECT s\.id AS session_id/);
  assert.deepEqual(lines.slice(2), eventStatements(1));
  const [event] = recordedEvents(log);
  assert.deepEqual(event, {
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
    request_id: event.request_id,
  });
  assert.match(event.request_id, UUID);
}

// --- Sign-out records signed_out once, for the session it revoked -----------
{
  let revoked = false;
  const { pool, log } = sessionDb({
    revokeRows: () => {
      if (revoked) return [];
      revoked = true;
      return [{ session_id: SESSION_ID, admin_user_id: ADMIN_ID, role: 'admin_superadmin', live: true }];
    },
  });
  check.pool = pool;
  check.cookies = new Map([[COOKIE, 'raw-session-token']]);
  const first = await route.DELETE();
  assert.equal(first.status, 200);
  assert.deepEqual(first.cookieSets.map((set) => [set.name, set.value, set.options.maxAge]), [[COOKIE, '', 0]]);
  const second = await route.DELETE();
  assert.equal(second.status, 200);
  const lines = statements(log);
  assert.match(lines[0], /^pool: UPDATE admin_sessions/);
  assert.deepEqual(lines.slice(1, 6), eventStatements(1));
  assert.match(lines[6], /^pool: UPDATE admin_sessions/);
  assert.equal(lines.length, 7, 'a second sign-out of the same session records nothing');
  const events = recordedEvents(log);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'signed_out');
  assert.equal(events[0].actor_id, ADMIN_ID);
  assert.equal(events[0].actor_role, 'admin_superadmin');
  assert.equal(events[0].actor_session, SESSION_ID);

  check.cookies = new Map();
  const { pool: emptyPool, log: emptyLog } = sessionDb();
  check.pool = emptyPool;
  const third = await route.DELETE();
  assert.equal(third.status, 200);
  assert.deepEqual(emptyLog, [], 'no cookie, no database call and no event');
}

// --- Signing out of a session that has already expired records the expiry --
// The session ended by expiring, not by signing out: one expired event and no
// signed_out, and a second sign-out records nothing.
{
  let ended = false;
  const { pool, log } = sessionDb({
    revokeRows: () => {
      if (ended) return [];
      ended = true;
      return [{ session_id: SESSION_ID, admin_user_id: ADMIN_ID, role: 'admin_ops', live: false }];
    },
  });
  check.pool = pool;
  check.cookies = new Map([[COOKIE, 'raw-session-token']]);
  const first = await route.DELETE();
  const second = await route.DELETE();
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.deepEqual(first.cookieSets.map((set) => [set.name, set.value, set.options.maxAge]), [[COOKIE, '', 0]]);
  assert.deepEqual(
    recordedEvents(log).map((event) => [event.kind, event.outcome, event.actor_id, event.actor_role, event.actor_session]),
    [['session', 'expired', ADMIN_ID, 'admin_ops', SESSION_ID]],
  );
}

// --- The cookie outlives the session, so a timeout can be seen ---------------
// A browser keeps the cookie for its Max-Age. The cookie outlives the session
// by hours, so the first request after the session times out still presents
// the token, and that request records the expiry.
{
  const { pool, log } = sessionDb();
  check.pool = pool;
  check.verifyToken = async () => ({ sub: 'check-admin-sub', email: 'ops-admin@example.test', 'cognito:groups': ['admin_ops'] });
  const signedInAt = Date.now();
  const response = await route.POST(signInRequest({ idToken: 'token-value' }));
  assert.equal(response.status, 200);
  const [cookie] = response.cookieSets;
  const insert = log.find((entry) => entry.sql?.startsWith('INSERT INTO admin_sessions'));
  const sessionEndsAt = insert.params[2].getTime();
  const cookieEndsAt = signedInAt + cookie.options.maxAge * 1000;
  assert.ok(cookieEndsAt - sessionEndsAt >= 60 * 60 * 1000, 'the cookie outlives the session by hours');

  const firstRequestAfterTimeout = sessionEndsAt + 1000;
  assert.ok(firstRequestAfterTimeout < cookieEndsAt, 'the browser still sends the cookie after the timeout');
  let marked = false;
  const { pool: laterPool, log: laterLog } = sessionDb({
    row: sessionRow({ active: false, expires_at: new Date(sessionEndsAt) }),
    expireRows: () => {
      if (marked) return [];
      marked = true;
      return [{ id: SESSION_ID }];
    },
  });
  check.pool = laterPool;
  check.cookies = new Map([[COOKIE, cookie.value]]);
  assert.equal(await session.getCurrentAdminSession(), undefined);
  assert.deepEqual(recordedEvents(laterLog).map((event) => [event.outcome, event.actor_session]), [['expired', SESSION_ID]]);
}

// --- An expired session is recorded once, even under parallel resolves -----
{
  let marked = false;
  const { pool, log } = sessionDb({
    row: sessionRow({ active: false, expires_at: new Date(Date.now() - 60 * 1000) }),
    expireRows: () => {
      if (marked) return [];
      marked = true;
      return [{ id: SESSION_ID }];
    },
  });
  check.pool = pool;
  check.cookies = new Map([[COOKIE, 'raw-session-token']]);
  const [layoutView, pageView] = await Promise.all([
    session.getCurrentAdminSession(),
    session.getCurrentAdminSession(),
  ]);
  assert.equal(layoutView, undefined);
  assert.equal(pageView, undefined);
  const expiries = log.filter((entry) => entry.sql?.startsWith("UPDATE admin_sessions SET revoked_at = NOW(), revoke_reason = 'expired'"));
  assert.equal(expiries.length, 2, 'both resolves try to mark the session');
  const events = recordedEvents(log);
  assert.equal(events.length, 1, 'only the resolve that marked it records the expiry');
  assert.equal(events[0].kind, 'session');
  assert.equal(events[0].outcome, 'expired');
  assert.equal(events[0].actor_id, ADMIN_ID);
  assert.equal(events[0].actor_session, SESSION_ID);
}

// --- A live session carries its ids and a fresh request id per resolve ------
{
  const { pool, log } = sessionDb();
  check.pool = pool;
  check.cookies = new Map([[COOKIE, 'raw-session-token']]);
  const first = await session.getCurrentAdminSession();
  const second = await session.getCurrentAdminSession();
  assert.equal(first.sessionId, SESSION_ID);
  assert.equal(first.adminUserId, ADMIN_ID);
  assert.equal(first.role, 'admin_ops');
  assert.equal(first.preview, undefined);
  assert.match(first.requestId, UUID);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(recordedEvents(log).length, 0);
}

// --- The local preview session is marked and has no ids ----------------------
{
  const original = { ...process.env };
  check.cookies = new Map();
  process.env.NODE_ENV = 'development';
  process.env.ADMIN_ALLOW_LOCAL_PREVIEW = 'true';
  process.env.ADMIN_PREVIEW_ROLE = 'admin_ops';
  try {
    const preview = await session.getCurrentAdminSession();
    assert.equal(preview.preview, true);
    assert.equal(preview.sessionId, undefined);
    assert.equal(preview.adminUserId, undefined);
  } finally {
    for (const key of ['NODE_ENV', 'ADMIN_ALLOW_LOCAL_PREVIEW', 'ADMIN_PREVIEW_ROLE']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

// --- No database at all: the rejection still leaves a trace (fallback) -------
{
  check.pool = new Error('pool unavailable');
  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  check.verifyToken = async () => { throw new Error('Token expired'); };
  const { result, lines } = await captureConsole(() => route.POST(signInRequest({ idToken: 'token-value' })));
  assert.equal(result.status, 401);
  const put = check.cloudwatch.sent.find((command) => command.name === 'PutLogEvents');
  assert.ok(put, 'the rejection goes to the fallback log');
  const line = JSON.parse(put.input.logEvents[0].message);
  assert.equal(line.outcome, 'sign_in_rejected');
  assert.equal(lines.error.length, 0);
}

console.log('admin session event checks passed');
