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
    'src/lib/server/admin-action-dispatch.ts',
    'src/lib/server/admin-audit.ts',
    'src/app/api/admin-sessions/revoke-all/route.ts',
  ],
  fakes: {
    // No AWS: a fallback write would mean the database write failed, and the
    // checks below assert that it never happens.
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
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
const dispatch = await load('src/lib/server/admin-action-dispatch.ts');
const audit = await load('src/lib/server/admin-audit.ts');
const record = await load('src/lib/server/audit/record.ts');
const revokeAll = await load('src/app/api/admin-sessions/revoke-all/route.ts');

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
      body: JSON.stringify({ idToken: 'token-value' }),
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
      body: JSON.stringify({ idToken: 'token-value' }),
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
      body: JSON.stringify({ idToken: 'token-value' }),
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

  // --- A case-detail load and its events row -------------------------------
  await step('a case-detail load records one read event with its fields', async () => {
    const { admin, live, viewer } = await signedIn('admin_readonly');
    const worker = await createUser('worker');
    const employer = await createUser('employer');
    const { rows: [kase] } = await su.query(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, employer_id, summary, details)
       VALUES ('help_request', 'open', 60, $1, $2, 'Synthetic case for the access-record check', '{}'::jsonb)
       RETURNING id::text`,
      [worker, employer],
    );
    await su.query(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, payload)
       VALUES ($1, 'help_keyword', 'worker', '{"title": "Help requested"}'::jsonb),
              ($1, 'note_added', 'system', '{"title": "Noted"}'::jsonb)`,
      [kase.id],
    );

    const item = await cases.loadCaseDetail(viewer, kase.id);
    assert.equal(item.id, kase.id);
    assert.equal(item.timeline.length, 2);
    assert.equal(item.workerName, 'Test P.', 'the page still gets masked names');

    assert.deepEqual(await eventsFor('request_id', viewer.requestId), [{
      kind: 'read',
      outcome: 'allowed',
      actor_kind: 'admin',
      actor_id: admin.id,
      actor_role: 'admin_readonly',
      actor_session: live.id,
      channel: 'admin',
      surface: 'admin.case_detail',
      categories: ['cases'],
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

    // The list records the same case among the ids it shows.
    const listViewer = await session.getCurrentAdminSession();
    const list = await cases.loadCasesList(listViewer);
    const [listEvent] = await eventsFor('request_id', listViewer.requestId);
    assert.equal(listEvent.surface, 'admin.cases_list');
    assert.deepEqual(listEvent.record_ids, list.rows.map((row) => row.id));
    assert.ok(listEvent.record_ids.includes(kase.id));
    assert.ok(listEvent.subject_user_ids.includes(worker) && listEvent.subject_user_ids.includes(employer));
    assert.equal(listEvent.result_count, list.rows.length);

    // An unknown case records a not_found attempt after the read ended.
    const missingViewer = await session.getCurrentAdminSession();
    const missingId = randomUUID();
    assert.equal(await cases.loadCaseDetail(missingViewer, missingId), undefined);
    const [attempt] = await eventsFor('request_id', missingViewer.requestId);
    assert.deepEqual(
      [attempt.kind, attempt.outcome, attempt.surface, attempt.record_ids, attempt.result_count, attempt.db_login],
      ['attempt', 'not_found', 'admin.case_detail', [missingId], 0, 'jale_admin_console'],
    );
  });

  // --- The lockout list and the paying-employers list ----------------------
  await step('the lockout list and the paying-employers list are recorded', async () => {
    const { viewer } = await signedIn('admin_ops');
    const shown = await lockouts.loadLockouts(viewer);
    const [lockoutEvent] = await eventsFor('request_id', viewer.requestId);
    assert.equal(lockoutEvent.surface, 'admin.lockouts');
    assert.deepEqual(lockoutEvent.categories, ['verifications']);
    assert.deepEqual(lockoutEvent.record_ids, shown.map((item) => item.challengeId));
    assert.equal(lockoutEvent.purpose_kind, 'verification');

    const payingViewer = await session.getCurrentAdminSession();
    const paying = await analytics.loadPayingEmployers(payingViewer);
    const [payingEvent] = await eventsFor('request_id', payingViewer.requestId);
    assert.equal(payingEvent.surface, 'admin.analytics_paying_employers');
    assert.deepEqual(payingEvent.categories, ['analytics', 'billing']);
    assert.deepEqual(payingEvent.subject_user_ids, paying.map((row) => row.employerId));
    assert.equal(payingEvent.result_count, paying.length);
  });

  // --- A reveal is one read event with its reason -----------------------------
  const REASON = 'Synthetic callback reason for the access-record check.';
  const legacyRows = async () => (await su.query('SELECT count(*)::int AS n FROM admin_audit_log')).rows[0].n;

  await step('a reveal records one read event with its reason, and no admin_audit_log row', async () => {
    const { admin, live, viewer } = await signedIn('admin_ops');
    const worker = await createUser('worker');
    const { rows: [kase] } = await su.query(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, summary, details)
       VALUES ('help_request', 'open', 60, $1, 'Synthetic case for a reveal', '{}'::jsonb)
       RETURNING id::text`,
      [worker],
    );
    const legacyBefore = await legacyRows();
    // The dashboard tile counts reveals through jale_audit.reveal_count(7).
    const tile = async () => (await cases.loadAdminDashboard(await session.getCurrentAdminSession())).revealCount;
    const tileBefore = await tile();

    const result = await dispatch.dispatchAdminAction(viewer, {
      actionId: 'reveal_pii', targetType: 'admin_case', targetId: kase.id, justification: REASON,
    });
    assert.equal(result.ok, true);
    assert.equal(result.revealed.name, 'Test Person');
    assert.equal(await tile(), tileBefore + 1, 'the dashboard tile counts the reveal');

    assert.deepEqual(await eventsFor('request_id', viewer.requestId), [{
      kind: 'read',
      outcome: 'allowed',
      actor_kind: 'admin',
      actor_id: admin.id,
      actor_role: 'admin_ops',
      actor_session: live.id,
      channel: 'admin',
      surface: 'admin.case_detail.reveal',
      categories: ['contact_details'],
      subject_user_ids: [worker],
      record_type: 'admin_case',
      record_ids: [kase.id],
      result_count: 1,
      field_names: ['full_name', 'phone', 'email'],
      purpose_kind: 'reveal',
      purpose_id: null,
      reason: REASON,
      request_id: viewer.requestId,
      db_login: 'jale_admin_console',
    }]);
    assert.equal(await legacyRows(), legacyBefore, 'no admin_audit_log row is written');

    // A read-only admin is refused: an attempt after the rollback, same reason.
    const { viewer: readonlyViewer } = await signedIn('admin_readonly');
    const refused = await dispatch.dispatchAdminAction(readonlyViewer, {
      actionId: 'reveal_pii', targetType: 'admin_case', targetId: kase.id, justification: REASON,
    });
    assert.equal(refused.status, 403);
    const [attempt] = await eventsFor('request_id', readonlyViewer.requestId);
    assert.deepEqual(
      [attempt.kind, attempt.outcome, attempt.surface, attempt.subject_user_ids, attempt.reason, attempt.result_count],
      ['attempt', 'denied', 'admin.case_detail.reveal', [worker], REASON, 0],
    );
    assert.equal(await legacyRows(), legacyBefore);
    assert.equal(await tile(), tileBefore + 1, 'a refused reveal is not counted');
  });

  // --- A reply's body stays in the case timeline only -------------------------
  await step('a WhatsApp reply records an action, and its body stays in the case timeline', async () => {
    const { viewer } = await signedIn('admin_ops');
    const worker = await createUser('worker');
    const number = `+120255501${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
    const { rows: [conversation] } = await su.query(
      `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, language)
       VALUES ($1, $2, 'en') ON CONFLICT (whatsapp_number) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING id::text`,
      [worker, number],
    );
    const { rows: [kase] } = await su.query(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, conversation_id, summary, details)
       VALUES ('help_request', 'open', 60, $1, $2, 'Synthetic case for a reply', '{}'::jsonb)
       RETURNING id::text`,
      [worker, conversation.id],
    );
    const body = `Synthetic reply body ${randomUUID()}`;
    const legacyBefore = await legacyRows();
    const result = await dispatch.dispatchAdminAction(viewer, {
      actionId: 'reply_whatsapp', targetType: 'admin_case', targetId: kase.id, requestId: randomUUID(), note: body,
    });
    assert.deepEqual(result, { ok: true, message: 'WhatsApp reply queued for delivery.' });

    const [action] = await eventsFor('request_id', viewer.requestId);
    assert.deepEqual(
      [action.kind, action.outcome, action.surface, action.categories, action.subject_user_ids, action.record_ids, action.reason],
      ['action', 'done', 'admin.case_detail.reply_whatsapp', ['cases', 'conversations'], [worker], [kase.id], null],
    );
    const { rows: [timeline] } = await su.query(
      `SELECT count(*)::int AS n FROM admin_case_events WHERE case_id = $1 AND payload->>'detail' = $2`,
      [kase.id, body],
    );
    assert.equal(timeline.n, 1, 'the body is in the case timeline');
    const { rows: [inEvents] } = await su.query(
      `SELECT count(*)::int AS n FROM jale_audit.events e WHERE to_jsonb(e)::text LIKE '%' || $1 || '%'`,
      [body],
    );
    assert.equal(inEvents.n, 0, 'the body is in no event');
    // The change log names changed columns, never their values.
    const { rows: [inChanges] } = await su.query(
      `SELECT count(*)::int AS n FROM jale_audit.changes c WHERE to_jsonb(c)::text LIKE '%' || $1 || '%'`,
      [body],
    );
    assert.equal(inChanges.n, 0, 'the body is in no change record');
    // The case update's change record names the admin, the action and the
    // request: the action set the audit context.
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
        surface: 'admin.case_detail.reply_whatsapp',
        request_id: viewer.requestId,
        context_status: 'set',
        record_ids: [kase.id],
      },
    );
    assert.equal(await legacyRows(), legacyBefore, 'no admin_audit_log row is written');
  });

  // --- Revoke-all names the admin and the count ----------------------------------
  await step('revoke-all records an action naming the admin and the sessions revoked', async () => {
    const { viewer } = await signedIn('admin_superadmin');
    const target = await createAdmin('admin_ops');
    await createSession(target, { expiresInMs: 30 * 60_000 });
    await createSession(target, { expiresInMs: 30 * 60_000 });
    const legacyBefore = await legacyRows();
    const response = await revokeAll.POST(new Request('https://admin.example.test/api/admin-sessions/revoke-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminUserId: target.id }),
    }));
    assert.deepEqual(response.body, { ok: true, revokedCount: 2 });
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
    const { rows: [kase] } = await su.query(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, summary, details)
       VALUES ('help_request', 'open', 60, $1, 'Synthetic case for the access history', '{}'::jsonb)
       RETURNING id::text`,
      [worker],
    );
    assert.equal((await dispatch.dispatchAdminAction(opsViewer, {
      actionId: 'reveal_pii', targetType: 'admin_case', targetId: kase.id, justification: REASON,
    })).ok, true);

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
    const reveal = firstSearch.entries.find((entry) => entry.surface === 'admin.case_detail.reveal');
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
