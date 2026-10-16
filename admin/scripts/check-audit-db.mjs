// Real-database proof for the admin access records. The code under test runs
// over a real connection as jale_admin_console, the dashboard's only login;
// fixtures and assertions use the test bed's superuser URL. Run it through
// the local test bed:
//
//   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none \
//     --profile request --container <name> --port <port> \
//     -- bash -c 'cd admin && npm run test:audit-db'
//
// Without JALE_TEST_DATABASE_URL it reports a skip and exits 0. It refuses
// any database that is not on loopback.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { compileAdminSources } from './lib/check-harness.mjs';

const baseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!baseUrl) {
  console.log('admin audit DB checks skipped: JALE_TEST_DATABASE_URL is not set (run through bootstrap-testbed.sh)');
  process.exit(0);
}

const bed = new URL(baseUrl);
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(bed.hostname)) {
  throw new Error('check-audit-db: refusing a database that is not a local test bed');
}

// The dashboard's pool, pointed at the bed as its real login. The password is
// the bed's fixed test password for this login (bootstrap-testbed.sh step 8).
process.env.NODE_ENV = 'development';
delete process.env.ADMIN_ALLOW_LOCAL_PREVIEW;
delete process.env.ADMIN_PREVIEW_ROLE;
process.env.ADMIN_DB_SSL_MODE = 'disable';
process.env.ADMIN_LOCAL_DB_SECRET_JSON = JSON.stringify({
  host: bed.hostname,
  port: Number(bed.port || 5432),
  dbname: bed.pathname.replace(/^\//, ''),
  username: 'jale_admin_console',
  password: 'test-adminconsole-pw',
});
process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID = 'us-east-1_CheckPool';
process.env.NEXT_PUBLIC_ADMIN_CLIENT_ID = 'check-client';
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-db-check';

const { load } = compileAdminSources({
  name: 'audit-db',
  sources: [
    'src/app/api/session/route.ts',
    'src/lib/server/session.ts',
    'src/lib/server/admin-cases.ts',
    'src/lib/server/admin-lockouts.ts',
    'src/lib/server/admin-analytics.ts',
    'src/lib/server/admin-inbox.ts',
    'src/lib/server/support-conversation.ts',
    'src/lib/server/inbox-actions.ts',
    'src/lib/server/admin-audit.ts',
    'src/app/api/admin-sessions/revoke-all/route.ts',
    'src/lib/server/admin-users.ts',
    'src/lib/server/device-trust.ts',
  ],
  fakes: {
    // No AWS: a fallback write would mean the database write failed, and the
    // checks below assert that it never happens. The admin pool's directory
    // is a fake too: the console's own SQL is what runs for real here.
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    '@aws-sdk/client-cognito-identity-provider': 'scripts/fakes/cognito-idp.mjs',
    // No AWS for a media link either: the presign is a fake that records its call.
    '@aws-sdk/client-s3': 'scripts/fakes/s3-client.mjs',
    '@aws-sdk/s3-request-presigner': 'scripts/fakes/s3-request-presigner.mjs',
    'next/headers': 'scripts/fakes/next-headers.mjs',
    'next/server': 'scripts/fakes/next-server.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
    'aws-jwt-verify': 'scripts/fakes/aws-jwt-verify.mjs',
  },
});

const route = await load('src/app/api/session/route.ts');
const session = await load('src/lib/server/session.ts');
const db = await load('src/lib/server/db.ts');
const cases = await load('src/lib/server/admin-cases.ts');
const lockouts = await load('src/lib/server/admin-lockouts.ts');
const analytics = await load('src/lib/server/admin-analytics.ts');
const inbox = await load('src/lib/server/admin-inbox.ts');
const conversation = await load('src/lib/server/support-conversation.ts');
const inboxActions = await load('src/lib/server/inbox-actions.ts');
const audit = await load('src/lib/server/admin-audit.ts');
const record = await load('src/lib/server/audit/record.ts');
const revokeAll = await load('src/app/api/admin-sessions/revoke-all/route.ts');
const adminUsers = await load('src/lib/server/admin-users.ts');
const deviceTrust = await load('src/lib/server/device-trust.ts');

const COOKIE = 'jale_admin_id_token_v2';
const check = (globalThis.__adminCheck = {
  cookies: new Map(),
  cloudwatch: { clients: [], sent: [], behavior: undefined },
});

const su = new pg.Client({ connectionString: baseUrl });
await su.connect();

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function eventsFor(column, value) {
  const { rows } = await su.query(
    `SELECT kind, outcome, actor_kind, actor_id::text, actor_role, actor_session::text, channel, surface,
            categories, subject_user_ids::text[], record_type, record_ids::text[], result_count, field_names,
            purpose_kind, purpose_id::text, reason, request_id, db_login::text
       FROM jale_audit.events
      WHERE ${column} = $1
      ORDER BY seq`,
    [value],
  );
  return rows;
}

async function createAdmin(role) {
  const tag = randomUUID().slice(0, 8);
  const email = `check-admin-${tag}@example.test`;
  const { rows } = await su.query(
    `INSERT INTO admin_users (cognito_sub, admin_email, role, active)
     VALUES ($1, $2, $3, true)
     RETURNING id::text`,
    [`check-sub-${tag}`, email, role],
  );
  return { id: rows[0].id, sub: `check-sub-${tag}`, email, role };
}

async function createSession(admin, { expiresInMs }) {
  const rawToken = `check-token-${randomUUID()}`;
  const { rows } = await su.query(
    `INSERT INTO admin_sessions (token_hash, admin_user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     RETURNING id::text`,
    [sha256(rawToken), admin.id, expiresInMs / 1000],
  );
  return { id: rows[0].id, rawToken };
}

async function createUser(userType) {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await su.query(
    `INSERT INTO users (cognito_sub, user_type, full_name, phone, email)
     VALUES ($1, $2, 'Test Person', '+12025550123', $3)
     RETURNING id::text`,
    [`check-user-${tag}`, userType, `check-${tag}@example.test`],
  );
  return rows[0].id;
}

// A signed-in admin as the dashboard sees one: a live session row, resolved
// through the real session code with a fresh request id.
async function signedIn(role) {
  const admin = await createAdmin(role);
  const live = await createSession(admin, { expiresInMs: 30 * 60_000 });
  check.cookies = new Map([[COOKIE, live.rawToken]]);
  const viewer = await session.getCurrentAdminSession();
  assert.equal(viewer.adminUserId, admin.id);
  assert.equal(viewer.sessionId, live.id);
  return { admin, live, viewer };
}

// The admin pool, as a fake directory object for the Admins actions (the
// console's SQL is the code under test): every call is kept in order.
function fakeDirectory({ status = 'FORCE_CHANGE_PASSWORD', devices = [] } = {}) {
  const calls = [];
  const note = (name, ...args) => { calls.push([name, ...args]); };
  return {
    calls,
    async createUser(email) { note('createUser', email); return { sub: `check-sub-${randomUUID().slice(0, 8)}` }; },
    async resendInvitation(email) { note('resendInvitation', email); },
    async getUser(username) { note('getUser', username); return { sub: username, status, enabled: true }; },
    async addToGroup(username, group) { note('addToGroup', username, group); },
    async removeFromGroup(username, group) { note('removeFromGroup', username, group); },
    async listGroups(username) { note('listGroups', username); return []; },
    async disableUser(username) { note('disableUser', username); },
    async enableUser(username) { note('enableUser', username); },
    async globalSignOut(username) { note('globalSignOut', username); },
    async listDeviceKeys(username) { note('listDeviceKeys', username); return devices; },
    async forgetDevice(username, key) { note('forgetDevice', username, key); },
    async getDeviceRememberedStatus(username, key) { note('getDeviceRememberedStatus', username, key); return status; },
    async setDeviceRemembered(username, key, remembered) { note('setDeviceRemembered', username, key, remembered); },
  };
}

// One Inbox action through the real handler, with the body's SHA-256 as the
// admin origin sends it.
async function act(viewer, body) {
  const text = JSON.stringify(body);
  const response = await inboxActions.handleInboxActionRequest(new Request('https://admin.example.test/api/inbox-actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amz-content-sha256': sha256(text) },
    body: text,
  }), viewer);
  return { status: response.status, body: await response.json() };
}

const results = [];
async function step(label, fn) {
  await fn();
  results.push(label);
  console.log(`  ok - ${label}`);
}

try {
  console.log('admin audit DB checks (login jale_admin_console)');

  // --- Session expiry is recorded exactly once under parallel resolves ------
  await step('an expired session is recorded once under four parallel resolves', async () => {
    const admin = await createAdmin('admin_superadmin');
    const expired = await createSession(admin, { expiresInMs: -60_000 });
    check.cookies = new Map([[COOKIE, expired.rawToken]]);

    const resolved = await Promise.all(Array.from({ length: 4 }, () => session.getCurrentAdminSession()));
    assert.deepEqual(resolved, [undefined, undefined, undefined, undefined]);

    const events = await eventsFor('actor_session', expired.id);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      kind: 'session',
      outcome: 'expired',
      actor_kind: 'admin',
      actor_id: admin.id,
      actor_role: 'admin_superadmin',
      actor_session: expired.id,
      channel: 'admin',
      surface: 'admin.session',
      categories: ['admin_access'],
      subject_user_ids: [],
      record_type: null,
      record_ids: [],
      result_count: 0,
      field_names: [],
      purpose_kind: null,
      purpose_id: null,
      reason: null,
      request_id: events[0].request_id,
      db_login: 'jale_admin_console',
    });
    const { rows } = await su.query(
      'SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM admin_sessions WHERE id = $1',
      [expired.id],
    );
    assert.deepEqual(rows[0], { revoked: true, revoke_reason: 'expired' });

    // A later visit with the same cookie finds nothing live and records nothing.
    assert.equal(await session.getCurrentAdminSession(), undefined);
    assert.equal((await eventsFor('actor_session', expired.id)).length, 1);
  });

  // --- Session events: sign-in, rejected sign-in and sign-out ----------------
  await step('sign-in, a rejected sign-in and sign-out are recorded', async () => {
    const admin = await createAdmin('admin_ops');
    check.verifyToken = async () => ({ sub: admin.sub, 'cognito:groups': ['admin_ops'] });
    const signIn = await route.POST(new Request('https://admin.example.test/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'check-browser' },
      body: JSON.stringify({ idToken: 'token-value', accessToken: 'access-token-value', trustDevice: false }),
    }));
    assert.equal(signIn.status, 200);
    const rawToken = signIn.cookieSets[0].value;
    const { rows: [created] } = await su.query(
      'SELECT id::text FROM admin_sessions WHERE token_hash = $1',
      [sha256(rawToken)],
    );
    const [signedIn] = await eventsFor('actor_session', created.id);
    assert.equal(signedIn.kind, 'session');
    assert.equal(signedIn.outcome, 'signed_in');
    assert.equal(signedIn.actor_id, admin.id);
    assert.equal(signedIn.actor_role, 'admin_ops');
    assert.equal(signedIn.db_login, 'jale_admin_console');

    check.cookies = new Map([[COOKIE, rawToken]]);
    assert.equal((await route.DELETE()).status, 200);
    assert.equal((await route.DELETE()).status, 200);
    const sessionEvents = await eventsFor('actor_session', created.id);
    assert.deepEqual(sessionEvents.map((event) => event.outcome), ['signed_in', 'signed_out']);
    const { rows: [signedOut] } = await su.query('SELECT revoke_reason FROM admin_sessions WHERE id = $1', [created.id]);
    assert.equal(signedOut.revoke_reason, 'user_logout', 'a live session ends with the sign-out reason');

    const unknownSub = `check-sub-${randomUUID().slice(0, 8)}`;
    check.verifyToken = async () => ({ sub: unknownSub, 'cognito:groups': ['admin_ops'] });
    const before = (await su.query("SELECT count(*)::int AS n FROM jale_audit.events WHERE outcome = 'sign_in_rejected'")).rows[0].n;
    const rejected = await route.POST(new Request('https://admin.example.test/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'token-value', accessToken: 'access-token-value', trustDevice: false }),
    }));
    assert.equal(rejected.status, 401);
    const { rows: rejections } = await su.query(
      `SELECT actor_kind, actor_id, request_id, db_login::text
         FROM jale_audit.events WHERE outcome = 'sign_in_rejected' ORDER BY seq DESC`,
    );
    assert.equal(rejections.length, before + 1);
    assert.equal(rejections[0].actor_kind, 'anonymous');
    assert.equal(rejections[0].actor_id, null);
    assert.equal(rejections[0].db_login, 'jale_admin_console');
    const { rows: [stored] } = await su.query(
      'SELECT count(*)::int AS n FROM jale_audit.events WHERE request_id = $1 OR surface = $1',
      [unknownSub],
    );
    assert.equal(stored.n, 0, 'the rejected subject is not stored');
  });

  // --- A session that ended by expiring is recorded as expired ----------------
  const revokeReason = async (id) => (await su.query(
    'SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM admin_sessions WHERE id = $1',
    [id],
  )).rows[0];

  await step('signing out of an expired session records its expiry once, and no sign-out', async () => {
    const admin = await createAdmin('admin_ops');
    const expired = await createSession(admin, { expiresInMs: -60_000 });
    check.cookies = new Map([[COOKIE, expired.rawToken]]);
    assert.equal((await route.DELETE()).status, 200);
    assert.equal((await route.DELETE()).status, 200);
    assert.deepEqual(
      (await eventsFor('actor_session', expired.id)).map((event) => [
        event.kind, event.outcome, event.actor_id, event.actor_role, event.db_login,
      ]),
      [['session', 'expired', admin.id, 'admin_ops', 'jale_admin_console']],
    );
    assert.deepEqual(await revokeReason(expired.id), { revoked: true, revoke_reason: 'expired' });
  });

  await step('a sign-out racing page loads of an expired session records one expiry', async () => {
    const admin = await createAdmin('admin_superadmin');
    const expired = await createSession(admin, { expiresInMs: -60_000 });
    check.cookies = new Map([[COOKIE, expired.rawToken]]);
    const [signOut, ...views] = await Promise.all([
      route.DELETE(),
      session.getCurrentAdminSession(),
      session.getCurrentAdminSession(),
      session.getCurrentAdminSession(),
    ]);
    assert.equal(signOut.status, 200);
    assert.deepEqual(views, [undefined, undefined, undefined]);
    assert.deepEqual((await eventsFor('actor_session', expired.id)).map((event) => event.outcome), ['expired']);
    assert.deepEqual(await revokeReason(expired.id), { revoked: true, revoke_reason: 'expired' });
  });

  await step('the cookie outlives the session, and the first request after the timeout records the expiry', async () => {
    const admin = await createAdmin('admin_readonly');
    check.verifyToken = async () => ({ sub: admin.sub, 'cognito:groups': ['admin_readonly'] });
    const signedInAt = Date.now();
    const signIn = await route.POST(new Request('https://admin.example.test/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'token-value', accessToken: 'access-token-value', trustDevice: false }),
    }));
    assert.equal(signIn.status, 200);
    const [cookie] = signIn.cookieSets;
    const { rows: [created] } = await su.query(
      `SELECT id::text,
              extract(epoch FROM expires_at - created_at)::float8 AS lifetime_s,
              extract(epoch FROM expires_at)::float8 * 1000 AS ends_at_ms
         FROM admin_sessions WHERE token_hash = $1`,
      [sha256(cookie.value)],
    );
    assert.ok(cookie.options.maxAge - created.lifetime_s >= 60 * 60, 'the cookie outlives the stored session by hours');
    assert.ok(
      created.ends_at_ms + 1000 < signedInAt + cookie.options.maxAge * 1000,
      'a browser still sends the cookie after the session ends',
    );

    // The session times out (moved into the past here rather than waited
    // for). The next request presents the cookie and records the expiry once;
    // a sign-out from a page left open adds nothing.
    await su.query("UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [created.id]);
    check.cookies = new Map([[COOKIE, cookie.value]]);
    assert.equal(await session.getCurrentAdminSession(), undefined);
    assert.equal(await session.getCurrentAdminSession(), undefined);
    assert.equal((await route.DELETE()).status, 200);
    assert.deepEqual((await eventsFor('actor_session', created.id)).map((event) => event.outcome), ['signed_in', 'expired']);
    assert.deepEqual(await revokeReason(created.id), { revoked: true, revoke_reason: 'expired' });
  });

  // --- Sessions end after an idle hour or eight hours; a request touches -----
  await step('an idle hour and the eight-hour day end a session; a request moves the idle hour, once a minute', async () => {
    const admin = await createAdmin('admin_ops');
    const shaped = async (createdAgo, lastSeenAgo, expiresIn) => {
      const live = await createSession(admin, { expiresInMs: expiresIn });
      await su.query(
        `UPDATE admin_sessions
            SET created_at = now() - make_interval(secs => $2), last_seen_at = now() - make_interval(secs => $3)
          WHERE id = $1`,
        [live.id, createdAgo / 1000, lastSeenAgo / 1000],
      );
      return live;
    };
    const row = async (id) => (await su.query(
      `SELECT revoke_reason,
              extract(epoch FROM now() - last_seen_at)::float8 AS seen_ago_s,
              extract(epoch FROM expires_at - now())::float8 AS ends_in_s,
              extract(epoch FROM expires_at - (created_at + interval '8 hours'))::float8 AS past_day_s
         FROM admin_sessions WHERE id = $1`, [id])).rows[0];
    const resolveWith = async (live) => {
      check.cookies = new Map([[COOKIE, live.rawToken]]);
      return session.getCurrentAdminSession();
    };

    // Idle: no request for an hour, though the stored expiry is later.
    const idle = await shaped(2 * 3600_000, 61 * 60_000, 2 * 3600_000);
    assert.equal(await resolveWith(idle), undefined, 'an idle hour ends the session');
    assert.equal((await row(idle.id)).revoke_reason, 'expired');
    assert.deepEqual((await eventsFor('actor_session', idle.id)).map((event) => event.outcome), ['expired']);

    // The eight-hour day, however recent the last request.
    const day = await shaped(8 * 3600_000 + 60_000, 10_000, 30 * 60_000);
    assert.equal(await resolveWith(day), undefined, 'eight hours after sign-in the session ends');
    assert.equal((await row(day.id)).revoke_reason, 'expired');

    // A request five minutes after the last one moves the idle hour.
    const busy = await shaped(2 * 3600_000, 5 * 60_000, 55 * 60_000);
    assert.ok(await resolveWith(busy));
    const touched = await row(busy.id);
    assert.ok(touched.seen_ago_s < 5, 'last_seen_at is now');
    assert.ok(Math.abs(touched.ends_in_s - 3600) < 5, 'expires_at is an hour from now');
    // A second request within the minute writes nothing.
    await su.query(`UPDATE admin_sessions SET last_seen_at = now() - interval '30 seconds' WHERE id = $1`, [busy.id]);
    assert.ok(await resolveWith(busy));
    assert.ok((await row(busy.id)).seen_ago_s >= 29, 'no write within a minute');

    // Late in the day the touch stops at sign-in + eight hours.
    const late = await shaped(7 * 3600_000 + 50 * 60_000, 2 * 60_000, 10 * 60_000);
    assert.ok(await resolveWith(late));
    assert.ok(Math.abs((await row(late.id)).past_day_s) < 1, 'expires_at = sign-in + 8 hours');
  });

  // --- Trusted browsers, through the console's own rights --------------------
  await step('a trusted browser is recorded, used, expired and refused through the console login', async () => {
    const admin = await createAdmin('admin_ops');
    const pool = await db.getAdminDbPool();
    const deviceKey = `check-region_${randomUUID()}`;
    const hash = sha256(deviceKey);
    const apply = (status, trustDevice) => deviceTrust.applyDeviceTrust({
      db: pool, directory: fakeDirectory({ status }), adminUserId: admin.id, username: admin.sub, deviceKey, trustDevice,
    });
    const trustRows = async () => (await su.query(
      `SELECT end_reason, ended_at IS NULL AS live, extract(epoch FROM expires_at - trusted_at)::int AS span_s
         FROM admin_trusted_devices WHERE admin_user_id = $1 ORDER BY trusted_at, id`, [admin.id])).rows;

    assert.deepEqual(await apply('not_remembered', true), { outcome: 'code_sign_in', trusted: true });
    const [first] = await trustRows();
    assert.deepEqual([first.end_reason, first.live, first.span_s], [null, true, 7 * 24 * 3600]);
    const { rows: [stored] } = await su.query('SELECT device_key_hash FROM admin_trusted_devices WHERE admin_user_id = $1', [admin.id]);
    assert.equal(stored.device_key_hash, hash, 'the hash, never the key');

    assert.deepEqual(await apply('remembered', false), { outcome: 'trusted_device' });

    // Eight days later the same browser is refused and its record ends.
    await su.query(
      `UPDATE admin_trusted_devices SET trusted_at = now() - interval '8 days', expires_at = now() - interval '1 day'
        WHERE admin_user_id = $1`, [admin.id]);
    assert.deepEqual(await apply('remembered', true), { outcome: 'trust_expired' });
    assert.deepEqual((await trustRows()).map((r) => [r.end_reason, r.live]), [['expired', false]]);

    // Signing in with a code again and ticking the box starts a new trust.
    assert.deepEqual(await apply('not_remembered', true), { outcome: 'code_sign_in', trusted: true });
    assert.deepEqual((await trustRows()).map((r) => [r.end_reason, r.live]), [['expired', false], [null, true]]);

    // The sign-in route records the trusted browser on the signed_in event.
    check.verifyToken = async (token, config) => (config.tokenUse === 'access'
      ? { sub: admin.sub, username: admin.sub, device_key: deviceKey }
      : { sub: admin.sub, 'cognito:groups': ['admin_ops'] });
    check.cognito = {
      clients: [], sent: [],
      behavior: (command) => (command.name === 'AdminGetDevice'
        ? { Device: { DeviceAttributes: [{ Name: 'dev:device_remembered_status', Value: 'remembered' }] } }
        : {}),
    };
    const signIn = await route.POST(new Request('https://admin.example.test/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'token-value', accessToken: 'access-token-value', trustDevice: false }),
    }));
    assert.equal(signIn.status, 200);
    const { rows: [created] } = await su.query('SELECT id::text FROM admin_sessions WHERE token_hash = $1', [sha256(signIn.cookieSets[0].value)]);
    const [signedIn] = await eventsFor('actor_session', created.id);
    assert.deepEqual([signedIn.outcome, signedIn.field_names, signedIn.db_login], ['signed_in', ['trusted_device'], 'jale_admin_console']);
    check.cognito = undefined;
  });

  // --- The Admins page, through the console login and migration 120 ----------
  await step('the Admins actions write through the definers, record themselves, and reach live sessions', async () => {
    const { viewer } = await signedIn('admin_superadmin');
    const directory = fakeDirectory();
    const act = (body) => adminUsers.runAdminUserAction(viewer, { requestId: randomUUID(), ...body }, directory);
    const tag = randomUUID().slice(0, 8);

    // Invite: a row, lower-cased, invited; one action event and one change record.
    const invited = await act({ action: 'invite', email: `Invited-${tag}@Example.Test`, role: 'admin_readonly' });
    assert.equal(invited.status, 200);
    assert.deepEqual(
      [invited.body.admin.email, invited.body.admin.role, invited.body.admin.status, invited.body.admin.canResendInvite],
      [`invited-${tag}@example.test`, 'admin_readonly', 'invited', true],
    );
    const inviteEvents = (await eventsFor('request_id', viewer.requestId)).filter((event) => event.surface === 'admin.admin_invite');
    assert.deepEqual(inviteEvents.map((event) => [event.kind, event.outcome, event.record_ids, event.db_login]),
      [['action', 'done', [invited.body.admin.id], 'jale_admin_console']]);
    const { rows: inviteChanges } = await su.query(
      `SELECT operation, surface, context_status FROM jale_audit.changes
        WHERE request_id = $1 AND table_name = 'public.admin_users'`, [viewer.requestId]);
    assert.deepEqual(inviteChanges, [{ operation: 'insert', surface: 'admin.admin_invite', context_status: 'set' }]);
    // A second invite of the same address, in any case, is refused before the
    // pool is asked: no pool user and no second email.
    const callsBeforeAgain = directory.calls.length;
    const again = await act({ action: 'invite', email: `INVITED-${tag}@example.test`, role: 'admin_ops' });
    assert.deepEqual(again, { status: 409, body: { ok: false, error: 'already_exists' } });
    assert.deepEqual(directory.calls.slice(callsBeforeAgain), []);

    // A role change reaches the target's live session at its next request.
    // The target was provisioned by hand with its email in mixed case: the
    // pool is reached through its sign-in id, never through that email.
    const target = await createAdmin('admin_ops');
    await su.query('UPDATE admin_users SET admin_email = $2 WHERE id = $1', [target.id, `Check-Mixed-${tag}@Example.Test`]);
    const targetLive = await createSession(target, { expiresInMs: 30 * 60_000 });
    const callsBeforeRole = directory.calls.length;
    const changed = await act({ action: 'change_role', adminUserId: target.id, role: 'admin_readonly' });
    assert.equal(changed.status, 200);
    assert.deepEqual([...new Set(directory.calls.slice(callsBeforeRole).map(([, username]) => username))], [target.sub]);
    check.cookies = new Map([[COOKIE, targetLive.rawToken]]);
    assert.equal((await session.getCurrentAdminSession()).role, 'admin_readonly', 'the next request has the new role');

    // Deactivation: sessions revoked, trusted browsers ended, the next request
    // goes back to sign-in with the expiry notice.
    await su.query(
      `INSERT INTO admin_trusted_devices (admin_user_id, device_key_hash, expires_at)
       VALUES ($1, $2, now() + interval '7 days')`, [target.id, sha256(`device-${tag}`)]);
    const callsBefore = directory.calls.length;
    const off = await act({ action: 'deactivate', adminUserId: target.id });
    assert.equal(off.status, 200);
    assert.equal(off.body.admin.status, 'deactivated');
    const { rows: [revoked] } = await su.query('SELECT revoke_reason FROM admin_sessions WHERE id = $1', [targetLive.id]);
    assert.equal(revoked.revoke_reason, 'admin_deactivated');
    const { rows: ended } = await su.query('SELECT end_reason FROM admin_trusted_devices WHERE admin_user_id = $1', [target.id]);
    assert.deepEqual(ended, [{ end_reason: 'admin_deactivated' }]);
    check.cookies = new Map([[COOKIE, targetLive.rawToken]]);
    check.headers = { 'x-admin-next': '/cases?status=open' };
    await assert.rejects(() => session.requireAdminSession(), (error) => {
      const url = new URL(error.redirectTo, 'https://admin.example.test');
      assert.deepEqual([url.pathname, url.searchParams.get('next'), url.searchParams.get('reason')], ['/login', '/cases?status=open', 'expired']);
      return true;
    });
    check.headers = undefined;
    // The pool is told after the rows: sign out, forget the devices, and
    // disable last; every call names the user by its sign-in id.
    assert.deepEqual(
      directory.calls.slice(callsBefore).map(([name, username]) => [name, username]),
      [['getUser', target.sub], ['globalSignOut', target.sub], ['listDeviceKeys', target.sub], ['disableUser', target.sub]],
    );

    // Oneself: refused in SQL, recorded as denied.
    const self = await act({ action: 'deactivate', adminUserId: viewer.adminUserId });
    assert.deepEqual(self, { status: 409, body: { ok: false, error: 'self_change' } });

    // Reactivation.
    const on = await act({ action: 'reactivate', adminUserId: target.id });
    assert.equal(on.status, 200);
    assert.equal(on.body.admin.status, 'active');

    // The list, for a superadmin: every admin above, recorded as one read.
    const { viewer: lister } = await signedIn('admin_superadmin');
    const listed = await adminUsers.loadAdmins(lister);
    assert.equal(listed.status, 'ok');
    const byId = new Map(listed.admins.map((admin) => [admin.id, admin]));
    assert.equal(byId.get(invited.body.admin.id)?.status, 'invited');
    assert.equal(byId.get(target.id)?.status, 'active');
    assert.equal(byId.get(target.id)?.trustedBrowsers, 0);
    const [listEvent] = await eventsFor('request_id', lister.requestId);
    assert.deepEqual([listEvent.kind, listEvent.surface, listEvent.result_count], ['read', 'admin.admins_list', listed.admins.length]);
  });

  // --- The support conversation and the Inbox list -------------------------
  await step('a support conversation records one read event; the Inbox records the case it lists', async () => {
    const { admin, live, viewer } = await signedIn('admin_readonly');
    const worker = await createUser('worker');
    const employer = await createUser('employer');
    const { rows: [kase] } = await su.query(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, employer_id, summary, details)
       VALUES ('help_request', 'open', 60, $1, $2, 'Synthetic case for the access-record check', '{}'::jsonb)
       RETURNING id::text, case_number::text`,
      [worker, employer],
    );
    await su.query(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, payload)
       VALUES ($1, 'worker_message', 'worker', '{"title": "Worker message", "detail": "Synthetic words"}'::jsonb),
              ($1, 'note_added', 'system', '{"title": "Noted"}'::jsonb)`,
      [kase.id],
    );

    const item = await conversation.loadSupportConversation(viewer, kase.id);
    assert.equal(item.caseId, kase.id);
    assert.equal(item.ref, `S-${kase.case_number}`);
    assert.equal(item.messages.length, 2);
    assert.equal(item.worker.label, 'Test P.', 'the page still gets masked names');
    assert.equal(item.reply.mode, 'template', 'no conversation: no open window');
    assert.ok(item.actions.every((action) => action.enabled === false), 'read-only: every action disabled');

    assert.deepEqual(await eventsFor('request_id', viewer.requestId), [{
      kind: 'read',
      outcome: 'allowed',
      actor_kind: 'admin',
      actor_id: admin.id,
      actor_role: 'admin_readonly',
      actor_session: live.id,
      channel: 'admin',
      surface: 'admin.support_conversation',
      categories: ['cases', 'conversations'],
      subject_user_ids: [worker, employer],
      record_type: 'admin_case',
      record_ids: [kase.id],
      result_count: 2,
      field_names: [],
      purpose_kind: 'case',
      purpose_id: kase.id,
      reason: null,
      request_id: viewer.requestId,
      db_login: 'jale_admin_console',
    }]);

    // The Inbox finds the case by its ref and records it.
    const listViewer = await session.getCurrentAdminSession();
    const page = await inbox.loadInbox(listViewer, { tab: 'all', status: 'waiting', q: `S-${kase.case_number}` });
    assert.deepEqual(page.items.map((row) => row.id), [kase.id]);
    const [listEvent] = await eventsFor('request_id', listViewer.requestId);
    assert.deepEqual(
      [listEvent.surface, listEvent.categories, listEvent.record_type, listEvent.record_ids, listEvent.db_login],
      ['admin.inbox', ['cases'], 'admin_case', [kase.id], 'jale_admin_console'],
    );
    assert.ok(listEvent.subject_user_ids.includes(worker) && listEvent.subject_user_ids.includes(employer));

    // The whole waiting view loads on the console's login, across the three sources.
    const allViewer = await session.getCurrentAdminSession();
    const waiting = await inbox.loadInbox(allViewer, { tab: 'all', status: 'waiting' });
    assert.ok(waiting.items.some((row) => row.id === kase.id));
    assert.equal(waiting.total, waiting.tabCounts.all);

    // The counts run as the console in one statement.
    const counts = await inbox.getInboxCounts(await session.getCurrentAdminSession());
    assert.ok(counts, 'the counts load on the console login');
    assert.ok(counts.support >= 1 && counts.waitingOnUs >= counts.support);

    // An unknown case records a not_found attempt after the read ended.
    const missingViewer = await session.getCurrentAdminSession();
    const missingId = randomUUID();
    assert.equal(await conversation.loadSupportConversation(missingViewer, missingId), null);
    const [attempt] = await eventsFor('request_id', missingViewer.requestId);
    assert.deepEqual(
      [attempt.kind, attempt.outcome, attempt.surface, attempt.record_ids, attempt.result_count, attempt.db_login],
      ['attempt', 'not_found', 'admin.support_conversation', [missingId], 0, 'jale_admin_console'],
    );
  });

  // --- The Inbox counts: looking reports, and "new since the last visit" -------
  await step('the counts take looking reports as waiting on us, and "new since" starts at the last ended session', async () => {
    const admin = await createAdmin('admin_ops');
    // A session that ended two hours ago, a live one on another device seen a
    // minute ago, and the current one.
    const ended = await createSession(admin, { expiresInMs: 30 * 60_000 });
    await su.query(
      `UPDATE admin_sessions
          SET created_at = now() - interval '3 hours', last_seen_at = now() - interval '2 hours',
              revoked_at = now() - interval '2 hours', revoke_reason = 'signed_out'
        WHERE id = $1`,
      [ended.id],
    );
    const other = await createSession(admin, { expiresInMs: 30 * 60_000 });
    await su.query(
      `UPDATE admin_sessions SET created_at = now() - interval '50 minutes', last_seen_at = now() - interval '1 minute' WHERE id = $1`,
      [other.id],
    );
    const current = await createSession(admin, { expiresInMs: 30 * 60_000 });
    const viewer = { sub: admin.sub, role: admin.role, groups: [admin.role], adminUserId: admin.id, sessionId: current.id, requestId: randomUUID() };

    const before = await inbox.getInboxCounts(viewer);
    assert.ok(before && before.newSinceLastVisit !== null, 'an ended session exists, so "new since" is a number');

    // A support case and a report being looked into, both waiting on us since
    // an hour ago: after the ended session, before the other device's last look.
    const { rows: [kase] } = await su.query(
      `INSERT INTO admin_cases (case_type, status, priority, summary, details, status_changed_at)
       VALUES ('help_request', 'open', 60, 'Synthetic case for the counts check', '{}'::jsonb, now() - interval '1 hour')
       RETURNING id::text, status_changed_at > now() - interval '61 minutes' AND status_changed_at < now() - interval '59 minutes' AS hour_old`,
    );
    assert.equal(kase.hour_old, true, 'the case keeps its hour-old status time');
    const reportId = randomUUID();
    const { rows: [report] } = await su.query(
      `INSERT INTO public.problem_reports (id, client_key, role, verified, category, locale, include_technical, has_image, status, created_at)
       VALUES ($1, $2, 'worker', false, 'finding_jobs', 'en', false, false, 'looking', now() - interval '1 hour')
       RETURNING report_number::text`,
      [reportId, randomUUID()],
    );
    await su.query(
      `INSERT INTO public.problem_report_contents (report_id, created_at, description)
       SELECT id, created_at, 'The page stopped loading.' FROM public.problem_reports WHERE id = $1`,
      [reportId],
    );

    const delta = (a, b) => ({
      support: b.support - a.support,
      reports: b.reports - a.reports,
      waitingOnUs: b.waitingOnUs - a.waitingOnUs,
      newSinceLastVisit: b.newSinceLastVisit - a.newSinceLastVisit,
    });
    const after = await inbox.getInboxCounts(viewer);
    assert.deepEqual(delta(before, after), { support: 1, reports: 1, waitingOnUs: 2, newSinceLastVisit: 2 });

    // A session past its expiry has ended too, before anything marks it.
    await su.query(
      `UPDATE admin_sessions SET revoked_at = NULL, revoke_reason = NULL, expires_at = now() - interval '2 hours' WHERE id = $1`,
      [ended.id],
    );
    const expired = await inbox.getInboxCounts(viewer);
    assert.equal(expired.newSinceLastVisit, after.newSinceLastVisit);

    // The list agrees: the looking report waits on us.
    const page = await inbox.loadInbox({ ...viewer, requestId: randomUUID() }, { tab: 'reports', status: 'waiting', q: `JR-${report.report_number}` });
    const listed = page.items.find((row) => row.id === reportId);
    assert.ok(listed, 'the looking report is listed');
    assert.deepEqual([listed.waitingOn, listed.unread], ['us', true]);

    await su.query('DELETE FROM public.problem_report_contents WHERE report_id = $1', [reportId]);
    await su.query('DELETE FROM public.problem_reports WHERE id = $1', [reportId]);
    await su.query('DELETE FROM admin_cases WHERE id = $1', [kase.id]);
  });

  // --- A lockout's detail, its reset and the paying-employers list --------------
  await step('a lockout detail, a reset and the paying-employers list are recorded', async () => {
    const { viewer } = await signedIn('admin_ops');
    const number = `+1202555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    const worker = await createUser('worker');
    await su.query(
      `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, language)
       VALUES ($1, $2, 'en') ON CONFLICT (whatsapp_number) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [worker, number],
    );
    const { rows: [challenge] } = await su.query(
      `INSERT INTO worker_identity_challenges (phone_hash, current_step_key, preferred_language, status, attempts, locked_until)
       VALUES ($1, 'identity.verify_otp', 'en', 'locked', 3, now() + interval '20 minutes') RETURNING id::text`,
      [sha256(number)],
    );

    const detail = await lockouts.loadLockoutDetail(viewer, challenge.id);
    assert.equal(detail.state, 'locked');
    assert.equal(detail.maskedPhone.includes(number.slice(2, 8)), false, 'the number arrives masked');
    const [detailEvent] = await eventsFor('request_id', viewer.requestId);
    assert.deepEqual(
      [detailEvent.surface, detailEvent.categories, detailEvent.record_type, detailEvent.record_ids, detailEvent.purpose_kind, detailEvent.subject_user_ids],
      ['admin.lockout_detail', ['verifications'], 'identity_challenge', [challenge.id], 'verification', []],
    );

    const resetViewer = await session.getCurrentAdminSession();
    const reset = await act(resetViewer, { action: 'reset_lockout', requestId: randomUUID(), challengeId: challenge.id, reasonCode: 'codes_not_arriving' });
    assert.deepEqual(reset, { status: 200, body: { ok: true, kind: 'done' } });
    const [resetEvent] = await eventsFor('request_id', resetViewer.requestId);
    assert.deepEqual(
      [resetEvent.kind, resetEvent.outcome, resetEvent.surface, resetEvent.record_type, resetEvent.record_ids, resetEvent.field_names, resetEvent.db_login],
      ['action', 'done', 'admin.inbox.reset_lockout', 'identity_challenge', [challenge.id], ['status', 'attempts', 'locked_until', 'expires_at', 'context'], 'jale_admin_console'],
    );
    const { rows: [after] } = await su.query('SELECT status, attempts, locked_until FROM worker_identity_challenges WHERE id = $1', [challenge.id]);
    assert.deepEqual(after, { status: 'pending', attempts: 0, locked_until: null });

    const openViewer = await session.getCurrentAdminSession();
    const opened = await act(openViewer, { action: 'open_support_from_lockout', requestId: randomUUID(), challengeId: challenge.id });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.kind, 'case');
    const [openEvent] = await eventsFor('request_id', openViewer.requestId);
    assert.deepEqual([openEvent.surface, openEvent.record_ids], ['admin.inbox.open_support', [challenge.id]]);

    const payingViewer = await session.getCurrentAdminSession();
    const paying = await analytics.loadPayingEmployers(payingViewer);
    const [payingEvent] = await eventsFor('request_id', payingViewer.requestId);
    assert.equal(payingEvent.surface, 'admin.analytics_paying_employers');
    assert.deepEqual(payingEvent.categories, ['analytics', 'billing']);
    assert.deepEqual(payingEvent.subject_user_ids, paying.map((row) => row.employerId));
    assert.equal(payingEvent.result_count, paying.length);
  });

  // --- The analytics pages' reads, on the console's own login ----------------
  await step('every analytics read runs as the console; only the two employer lists are recorded', async () => {
    const { viewer } = await signedIn('admin_readonly');
    // A stale active job: posted 20 days ago, with no employer action since.
    const employer = await createUser('employer');
    const posted = new Date(Date.now() - 20 * 86_400_000);
    const { rows: [job] } = await su.query(
      `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at, updated_at)
       VALUES ($1, 'Synthetic stale job', 'Tijuana', 'full-time', 'active', $2, $2) RETURNING id::text`,
      [employer, posted],
    );

    // The aggregates: every definer the Growth, Funnels, Employers and Ops
    // pages call, through the page code, as jale_admin_console. None records.
    const eventCount = async () => (await su.query('SELECT count(*)::int AS n FROM jale_audit.events')).rows[0].n;
    const before = await eventCount();
    await analytics.getAnalyticsTotals();
    await analytics.getSignups('30d');
    await analytics.getOnboardingCohorts(8);
    await analytics.getOnboardingStalled();
    await analytics.getEmployerWeekly(8);
    await analytics.getDigestAdoption();
    await analytics.getDigestSends(8);
    await analytics.getMessageBacklog();
    await analytics.getMessageFailures(8);
    await analytics.getVoiceExtraction(8);
    await analytics.getTrustExtraction(8);
    await analytics.getBillingInbox(8);
    await analytics.getBillingInboxNow();
    await analytics.getOnboardingRestarts(8);
    await analytics.getOperatorResets(8);
    assert.equal(await eventCount(), before, 'the aggregates record nothing');

    const slowest = await analytics.loadSlowestEmployers(viewer, 8);
    const [slowestEvent] = await eventsFor('request_id', viewer.requestId);
    assert.deepEqual(
      [slowestEvent.kind, slowestEvent.outcome, slowestEvent.surface, slowestEvent.categories, slowestEvent.db_login],
      ['read', 'allowed', 'admin.analytics_slowest_employers', ['analytics'], 'jale_admin_console'],
    );
    assert.deepEqual(slowestEvent.subject_user_ids, slowest.map((row) => row.employerId));
    assert.equal(slowestEvent.result_count, slowest.length);

    const staleViewer = await session.getCurrentAdminSession();
    const stale = await analytics.loadStaleJobs(staleViewer, 14);
    assert.ok(stale.some((row) => row.jobId === job.id && row.employerId === employer), 'the stale job is listed');
    const shown = stale.slice(0, 25);
    const [staleEvent] = await eventsFor('request_id', staleViewer.requestId);
    assert.deepEqual(
      [staleEvent.kind, staleEvent.outcome, staleEvent.surface, staleEvent.categories, staleEvent.db_login],
      ['read', 'allowed', 'admin.analytics_stale_jobs', ['analytics'], 'jale_admin_console'],
    );
    assert.deepEqual(staleEvent.subject_user_ids, [...new Set(shown.map((row) => row.employerId))]);
    assert.ok(staleEvent.subject_user_ids.includes(employer));
    assert.equal(staleEvent.result_count, shown.length);
  });

  // --- A reveal is one read event with its reason -----------------------------
  const REASON = 'Synthetic callback reason for the access-record check.';
  const legacyRows = async () => (await su.query('SELECT count(*)::int AS n FROM admin_audit_log')).rows[0].n;

  // A support case with a conversation, as the bot opens one (121).
  async function supportCase(worker, summary) {
    const number = `+1202555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
    const { rows: [conv] } = await su.query(
      `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, language)
       VALUES ($1, $2, 'en') ON CONFLICT (whatsapp_number) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id::text`,
      [worker, number],
    );
    const { rows: [kase] } = await su.query(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, conversation_id, summary, details)
       VALUES ('help_request', 'open', 60, $1, $2, $3, '{"language": "en"}'::jsonb)
       RETURNING id::text`,
      [worker, conv.id, summary],
    );
    return { id: kase.id, number, conversationId: conv.id };
  }

  await step('a phone reveal records one read event with its reason, and no admin_audit_log row', async () => {
    const { admin, live, viewer } = await signedIn('admin_ops');
    const worker = await createUser('worker');
    const kase = await supportCase(worker, 'Synthetic case for a reveal');
    const legacyBefore = await legacyRows();
    // The dashboard tile counts reveals through jale_audit.reveal_count(7).
    const tile = async () => (await cases.loadAdminDashboard(await session.getCurrentAdminSession())).revealCount;
    const tileBefore = await tile();

    const result = await act(viewer, { action: 'reveal_phone', requestId: randomUUID(), caseId: kase.id, justification: REASON });
    assert.deepEqual(result, { status: 200, body: { ok: true, kind: 'phone', phone: kase.number } });
    assert.equal(await tile(), tileBefore + 1, 'the dashboard tile counts the reveal');

    assert.deepEqual(await eventsFor('request_id', viewer.requestId), [{
      kind: 'read',
      outcome: 'allowed',
      actor_kind: 'admin',
      actor_id: admin.id,
      actor_role: 'admin_ops',
      actor_session: live.id,
      channel: 'admin',
      surface: 'admin.inbox.reveal_phone',
      categories: ['contact_details'],
      subject_user_ids: [worker],
      record_type: 'admin_case',
      record_ids: [kase.id],
      result_count: 1,
      field_names: ['phone'],
      purpose_kind: 'reveal',
      purpose_id: null,
      reason: REASON,
      request_id: viewer.requestId,
      db_login: 'jale_admin_console',
    }]);
    assert.equal(await legacyRows(), legacyBefore, 'no admin_audit_log row is written');

    // A read-only admin is refused: a denied attempt with the same reason, nothing read.
    const { viewer: readonlyViewer } = await signedIn('admin_readonly');
    const refused = await act(readonlyViewer, { action: 'reveal_phone', requestId: randomUUID(), caseId: kase.id, justification: REASON });
    assert.deepEqual(refused, { status: 403, body: { ok: false, error: 'forbidden' } });
    const [attempt] = await eventsFor('request_id', readonlyViewer.requestId);
    assert.deepEqual(
      [attempt.kind, attempt.outcome, attempt.surface, attempt.reason, attempt.result_count],
      ['attempt', 'denied', 'admin.inbox.reveal_phone', REASON, 0],
    );
    assert.equal(await legacyRows(), legacyBefore);
    assert.equal(await tile(), tileBefore + 1, 'a refused reveal is not counted');
  });

  // --- A photo opens through a short link the record names -----------------------
  await step('opening a photo records one read event with the link expiry, for any role', async () => {
    const { viewer } = await signedIn('admin_readonly');
    const worker = await createUser('worker');
    const kase = await supportCase(worker, 'Synthetic case for a photo');
    const mediaId = randomUUID();
    const { rows: [mediaEvent] } = await su.query(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, payload)
       VALUES ($1, 'worker_media', 'worker', jsonb_build_object('title', 'Worker sent a photo', 'mediaId', $2::text, 'mediaType', 'image'))
       RETURNING id::text`,
      [kase.id, mediaId],
    );
    await su.query(
      `INSERT INTO support_case_media (id, case_id, event_id, s3_key, media_type, content_type, byte_size, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'image', 'image/jpeg', 1234, now(), now() + interval '90 days')`,
      [mediaId, kase.id, mediaEvent.id, `support/${kase.id}/${randomUUID()}.jpg`],
    );
    process.env.SUPPORT_MEDIA_BUCKET = 'check-support-media-bucket';
    check.presign = { calls: [], behavior: () => 'https://media.example.test/signed', onPresign: undefined };
    const opened = await act(viewer, { action: 'open_media', requestId: randomUUID(), caseId: kase.id, mediaId });
    delete process.env.SUPPORT_MEDIA_BUCKET;
    assert.equal(opened.status, 200);
    assert.equal(opened.body.kind, 'media');
    const { rows: [event] } = await su.query(
      `SELECT surface, categories, record_ids::text[], link_expires_at FROM jale_audit.events WHERE request_id = $1`,
      [viewer.requestId],
    );
    assert.deepEqual([event.surface, event.categories, event.record_ids], ['admin.inbox.open_media', ['cases', 'conversations'], [kase.id]]);
    const [call] = check.presign.calls;
    assert.equal(event.link_expires_at.getTime(), call.options.signingDate.getTime() + 300_000, 'the record names the link expiry');
    assert.equal(opened.body.expiresAt, event.link_expires_at.toISOString());
  });

  // --- A reply's text stays in the case timeline only; a repeat sends nothing twice ---
  await step('a WhatsApp reply records an action, its text stays in the case timeline, and a repeat queues nothing', async () => {
    const { viewer } = await signedIn('admin_ops');
    const worker = await createUser('worker');
    const kase = await supportCase(worker, 'Synthetic case for a reply');
    // The worker wrote a minute ago, so the window is open.
    await su.query(
      `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, first_seen_at)
       VALUES ($1, $2, now() - interval '1 minute')`,
      [`SMcheck${randomUUID().replace(/-/g, '').slice(0, 26)}`, kase.number],
    );
    const body = `Synthetic reply body ${randomUUID()}`;
    const requestId = randomUUID();
    const legacyBefore = await legacyRows();
    const result = await act(viewer, { action: 'reply', requestId, caseId: kase.id, text: body });
    assert.deepEqual(result, { status: 200, body: { ok: true, kind: 'done' } });

    const [action] = await eventsFor('request_id', viewer.requestId);
    assert.deepEqual(
      [action.kind, action.outcome, action.surface, action.categories, action.subject_user_ids, action.record_ids, action.reason],
      ['action', 'done', 'admin.inbox.reply', ['cases', 'conversations'], [worker], [kase.id], null],
    );
    const { rows: [timeline] } = await su.query(
      `SELECT count(*)::int AS n FROM admin_case_events WHERE case_id = $1 AND payload->>'detail' = $2`,
      [kase.id, body],
    );
    assert.equal(timeline.n, 1, 'the text is in the case timeline');
    const { rows: [inEvents] } = await su.query(
      `SELECT count(*)::int AS n FROM jale_audit.events e WHERE to_jsonb(e)::text LIKE '%' || $1 || '%'`,
      [body],
    );
    assert.equal(inEvents.n, 0, 'the text is in no event');
    const { rows: [inChanges] } = await su.query(
      `SELECT count(*)::int AS n FROM jale_audit.changes c WHERE to_jsonb(c)::text LIKE '%' || $1 || '%'`,
      [body],
    );
    assert.equal(inChanges.n, 0, 'the text is in no change record');
    // The case update's change record names the admin, the action and the
    // request: the action set the audit context before the definer ran.
    const { rows: caseChanges } = await su.query(
      `SELECT table_name, operation, row_count, changed_fields, actor_kind, actor_id::text, channel,
              surface, request_id, context_status, record_ids::text[]
         FROM jale_audit.changes WHERE request_id = $1 ORDER BY seq`,
      [viewer.requestId],
    );
    assert.equal(caseChanges.length, 1, 'one change record: the admin_cases update');
    const [caseChange] = caseChanges;
    assert.ok(caseChange.changed_fields.includes('status'));
    assert.deepEqual(
      { ...caseChange, changed_fields: undefined },
      {
        table_name: 'public.admin_cases',
        operation: 'update',
        row_count: 1,
        changed_fields: undefined,
        actor_kind: 'admin',
        actor_id: viewer.adminUserId,
        channel: 'admin',
        surface: 'admin.inbox.reply',
        request_id: viewer.requestId,
        context_status: 'set',
        record_ids: [kase.id],
      },
    );
    assert.equal(await legacyRows(), legacyBefore, 'no admin_audit_log row is written');

    // The same request again (a retry after a lost response): the first
    // outcome, one outbox row, no second record. Another payload under the
    // same id is invalid_input.
    const outboxRows = async () => (await su.query(
      `SELECT count(*)::int AS n FROM whatsapp_outbox WHERE source_type = 'admin_case' AND source_id = $1`, [kase.id],
    )).rows[0].n;
    assert.equal(await outboxRows(), 1);
    await su.query(`UPDATE admin_cases SET status = 'pending_admin' WHERE id = $1`, [kase.id]);
    const retryViewer = await session.getCurrentAdminSession();
    assert.deepEqual(await act(retryViewer, { action: 'reply', requestId, caseId: kase.id, text: body }), { status: 200, body: { ok: true, kind: 'done' } });
    assert.equal(await outboxRows(), 1, 'a repeat queues nothing');
    assert.equal((await eventsFor('request_id', retryViewer.requestId)).length, 0, 'a repeat records nothing');
    const otherViewer = await session.getCurrentAdminSession();
    assert.deepEqual(
      await act(otherViewer, { action: 'reply', requestId, caseId: kase.id, text: `${body} again` }),
      { status: 400, body: { ok: false, error: 'invalid_input' } },
    );
    assert.equal(await outboxRows(), 1);
  });

  // --- Revoke-all names the admin and the count ----------------------------------
  await step('revoke-all records an action naming the admin and the sessions revoked, and ends trusted browsers', async () => {
    const { viewer } = await signedIn('admin_superadmin');
    const target = await createAdmin('admin_ops');
    await createSession(target, { expiresInMs: 30 * 60_000 });
    await createSession(target, { expiresInMs: 30 * 60_000 });
    await su.query(
      `INSERT INTO admin_trusted_devices (admin_user_id, device_key_hash, expires_at)
       VALUES ($1, $2, now() + interval '7 days')`, [target.id, sha256(`device-${randomUUID()}`)]);
    check.cognito = {
      clients: [], sent: [],
      behavior: (command) => (command.name === 'AdminListDevices' ? { Devices: [{ DeviceKey: 'check-region_device-a' }] } : {}),
    };
    const legacyBefore = await legacyRows();
    const response = await revokeAll.POST(new Request('https://admin.example.test/api/admin-sessions/revoke-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminUserId: target.id }),
    }));
    assert.deepEqual(response.body, { ok: true, revokedCount: 2 });
    const { rows: trust } = await su.query(
      'SELECT end_reason FROM admin_trusted_devices WHERE admin_user_id = $1', [target.id]);
    assert.deepEqual(trust, [{ end_reason: 'signed_out_everywhere' }]);
    assert.deepEqual(
      check.cognito.sent.map(({ name, input }) => [name, input.Username, input.DeviceKey]),
      [['AdminListDevices', target.sub, undefined], ['AdminForgetDevice', target.sub, 'check-region_device-a']],
    );
    check.cognito = undefined;
    const { rows } = await su.query(
      `SELECT kind, outcome, surface, categories, record_type, record_ids::text[], result_count, actor_id::text
         FROM jale_audit.events WHERE surface = 'admin.sessions_revoke' AND $1::uuid = ANY (record_ids)`,
      [target.id],
    );
    assert.deepEqual(rows, [{
      kind: 'action',
      outcome: 'done',
      surface: 'admin.sessions_revoke',
      categories: ['admin_access'],
      record_type: 'admin_user',
      record_ids: [target.id],
      result_count: 2,
      actor_id: viewer.adminUserId,
    }]);
    assert.equal(await legacyRows(), legacyBefore, 'no admin_audit_log row is written');
  });

  // --- The access history ------------------------------------------------------
  await step('the access history refuses other roles, and a superadmin search records itself', async () => {
    // A person with a reveal on record.
    const { admin: opsAdmin, viewer: opsViewer } = await signedIn('admin_ops');
    const worker = await createUser('worker');
    const kase = await supportCase(worker, 'Synthetic case for the access history');
    assert.equal((await act(opsViewer, { action: 'reveal_phone', requestId: randomUUID(), caseId: kase.id, justification: REASON })).status, 200);

    // Another role is refused: one denied attempt that names no search input,
    // and no search.
    const deniedViewer = await session.getCurrentAdminSession();
    assert.deepEqual(await audit.loadAccessHistory(deniedViewer, { subject: worker, record: kase.id }), { status: 'forbidden' });
    assert.deepEqual(
      (await eventsFor('request_id', deniedViewer.requestId)).map((event) => [
        event.kind, event.outcome, event.actor_id, event.surface, event.categories,
        event.subject_user_ids, event.record_ids, event.result_count, event.purpose_kind, event.db_login,
      ]),
      [['attempt', 'denied', opsAdmin.id, 'admin.access_history', ['audit_history'], [], [], 0, 'audit_review', 'jale_admin_console']],
    );

    // A superadmin's search finds the reveal, and records the search itself in
    // the same transaction.
    const { admin: superAdmin, live: superLive, viewer: first } = await signedIn('admin_superadmin');
    const firstSearch = await audit.loadAccessHistory(first, { subject: worker });
    assert.equal(firstSearch.status, 'ok');
    for (const entry of firstSearch.entries) {
      for (const list of ['categories', 'subjectUserIds', 'recordIds', 'fieldNames', 'changedFields']) {
        assert.ok(Array.isArray(entry[list]), `${list} comes back from the driver as an array`);
      }
    }
    const reveal = firstSearch.entries.find((entry) => entry.surface === 'admin.inbox.reveal_phone');
    assert.ok(reveal, 'the reveal is in the person\'s history');
    assert.deepEqual(
      [reveal.source, reveal.kind, reveal.outcome, reveal.actorId, reveal.actorEmail, reveal.categories,
        reveal.subjectUserIds, reveal.recordType, reveal.recordIds, reveal.purposeKind, reveal.reason],
      ['event', 'read', 'allowed', opsAdmin.id, opsAdmin.email, ['contact_details'],
        [worker], 'admin_case', [kase.id], 'reveal', REASON],
    );
    assert.equal(firstSearch.entries.some((entry) => entry.source === 'legacy'), false, 'a subject search never matches a legacy record');

    assert.deepEqual(await eventsFor('request_id', first.requestId), [{
      kind: 'read',
      outcome: 'allowed',
      actor_kind: 'admin',
      actor_id: superAdmin.id,
      actor_role: 'admin_superadmin',
      actor_session: superLive.id,
      channel: 'admin',
      surface: 'admin.access_history',
      categories: ['audit_history'],
      subject_user_ids: [worker],
      record_type: null,
      record_ids: [],
      result_count: firstSearch.entries.length,
      field_names: [],
      purpose_kind: 'audit_review',
      purpose_id: null,
      reason: null,
      request_id: first.requestId,
      db_login: 'jale_admin_console',
    }], 'one event per search: the function\'s own, with the page\'s request id');

    // The next search shows the first one, newest first.
    const second = await session.getCurrentAdminSession();
    const secondSearch = await audit.loadAccessHistory(second, { subject: worker });
    const [newest] = secondSearch.entries;
    assert.deepEqual(
      [newest.source, newest.kind, newest.surface, newest.categories, newest.purposeKind, newest.resultCount,
        newest.requestId, newest.actorSession, newest.actorEmail],
      ['event', 'read', 'admin.access_history', ['audit_history'], 'audit_review', firstSearch.entries.length,
        first.requestId, superLive.id, superAdmin.email],
    );
    assert.equal(secondSearch.entries.length, firstSearch.entries.length + 1);

    // Paging with the real cursor: one-row pages walk the history without
    // repeating or skipping a row.
    const pager = await session.getCurrentAdminSession();
    const walk = [];
    let cursor;
    for (let page = 0; page < 50; page += 1) {
      const { entries, nextBefore } = await record.withAdminReadTransaction(
        pager,
        (client) => audit.searchAccessHistory(client, pager, { subjectUserId: worker }, cursor, 1),
      );
      walk.push(...entries.map((entry) => entry.key));
      if (!nextBefore) break;
      assert.match(nextBefore, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      cursor = nextBefore;
    }
    // Each page records its own search, newer than every row the walk reads.
    // Leaving those out, the whole history is exactly the walk, in order.
    const whole = await audit.loadAccessHistory(await session.getCurrentAdminSession(), { subject: worker });
    assert.deepEqual(
      walk,
      whole.entries.filter((entry) => entry.requestId !== pager.requestId).map((entry) => entry.key),
      'one-row pages walk the history once, in order, with no row repeated or skipped',
    );
    assert.ok(walk.length >= 3 && walk.includes(reveal.key) && walk.includes(newest.key));

    // A legacy record of the case: found by its record id, labelled as legacy,
    // with the summary and the reason as the freeze left them.
    await su.query(
      `INSERT INTO admin_audit_log (actor_admin_id, actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
       VALUES ($1, $2, 'admin_ops', 'reveal_pii', 'admin_case', $3, true, $4::jsonb)`,
      [opsAdmin.id, opsAdmin.email, kase.id, JSON.stringify({
        summary: 'Revealed +12025550123 for a callback',
        justification: 'Called +12025550123 about the case',
        note: 'Synthetic free text',
      })],
    );
    const byRecord = await audit.loadAccessHistory(await session.getCurrentAdminSession(), { record: kase.id });
    const legacy = byRecord.entries.filter((entry) => entry.source === 'legacy');
    assert.equal(legacy.length, 1);
    assert.deepEqual(
      [legacy[0].action, legacy[0].targetType, legacy[0].targetId, legacy[0].piiReveal, legacy[0].summary, legacy[0].actorEmail],
      ['reveal_pii', 'admin_case', kase.id, true, 'admin_ops requested reveal_pii for admin_case.', opsAdmin.email],
    );
    assert.match(legacy[0].reason, /\[removed\]/);
    assert.doesNotMatch(JSON.stringify(legacy[0]), /2025550123|Synthetic free text/, 'no contact value or note comes back');
    assert.ok(byRecord.entries.some((entry) => entry.key === reveal.key), 'the record search also finds the reveal');
  });

  assert.deepEqual(check.cloudwatch.sent, [], 'no event fell back: every write reached the database');
  console.log(`admin audit DB checks passed (${results.length} checks)`);
} finally {
  await su.end();
  await (await db.getAdminDbPool()).end();
}
