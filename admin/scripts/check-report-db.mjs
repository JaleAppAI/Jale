// DB-backed check of the Reports actions and reads against the real database
// functions, called as the dashboard's own login (jale_admin_console) over a
// real connection. Run it on a local test bed (see the npm script
// test:report-db); CI runs it on a standard bed in the database job.
//
// Real: the route, the actions module, the read models, the connection, the
// jale_cap.problem_report_* functions, their grants and row security, and the
// audit writer (jale_audit.record_event), called in the request's own
// transaction. The connection forwards every statement, keeps the payloads and
// the transaction state it saw, and can make the writer fail before the call
// reaches the database (trace.failEvent). Each report surface's stored row in
// jale_audit.events is then checked, as the bed's superuser.
// Fakes as in the other checks: the session and the S3 presigner.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { compileAdminSources, captureConsole, RECORD_EVENT_SQL } from './lib/check-harness.mjs';

const baseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!baseUrl) {
  console.error('check-report-db: JALE_TEST_DATABASE_URL is not set; run this on a local test bed.');
  process.exit(1);
}
const host = new URL(baseUrl).hostname;
assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host), 'only a local test bed is accepted');

const consoleUrl = new URL(baseUrl);
consoleUrl.username = 'jale_admin_console';
consoleUrl.password = 'test-adminconsole-pw';

const su = new pg.Client({ connectionString: baseUrl });
await su.connect();
const realPool = new pg.Pool({ connectionString: consoleUrl.toString(), max: 2 });

// --- The connection, recording what it forwards ------------------------------

const trace = { statements: [], events: [], failEvent: false };
function wrapClient(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return async (sql, params) => {
          const text = typeof sql === 'string' ? sql : sql.text;
          if (text === RECORD_EVENT_SQL) {
            trace.statements.push('record_event');
            if (trace.failEvent) throw Object.assign(new Error('audit writer unavailable'), { code: '08006' });
            trace.events.push(JSON.parse(params[0]));
            return target.query(sql, params);
          }
          const head = text.trim().split(/\s+/).slice(0, 4).join(' ');
          trace.statements.push(/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim()) ? text.trim() : head);
          return target.query(sql, params);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
const pool = {
  async connect() {
    return wrapClient(await realPool.connect());
  },
};

// --- What the audit writer stored -------------------------------------------
// Read as the bed's superuser, by seq: every row a call left.
async function lastEventSeq() {
  return (await su.query('SELECT coalesce(max(seq), 0)::text AS seq FROM jale_audit.events')).rows[0].seq;
}
async function eventsAfter(seq) {
  const { rows } = await su.query(
    `SELECT kind, outcome, surface, categories, record_type, record_ids::text[] AS record_ids,
            subject_user_ids::text[] AS subject_user_ids, field_names, purpose_kind, reason,
            link_expires_at, db_login::text AS db_login
       FROM jale_audit.events
      WHERE seq > $1::bigint
      ORDER BY seq`,
    [seq],
  );
  return rows;
}
/** The one stored row of a call, with its fixed shape checked; the rest is the caller's. */
function storedOnce(stored, expected) {
  assert.equal(stored.length, 1, `${expected.surface}: one stored row`);
  const [row] = stored;
  for (const [column, value] of Object.entries({ db_login: 'jale_admin_console', ...expected })) {
    assert.deepEqual(row[column], value, `${expected.surface}: ${column}`);
  }
  return row;
}
const surfacesStored = new Set();

const { load } = compileAdminSources({
  name: 'report-db',
  sources: ['src/app/api/report-actions/route.ts', 'src/lib/server/admin-reports.ts'],
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
const reads = await load('src/lib/server/admin-reports.ts');

const check = (globalThis.__adminCheck ??= {});
check.pool = pool;
const BUCKET = `check-report-images-${randomBytes(4).toString('hex')}`;
process.env.REPORT_IMAGES_BUCKET = BUCKET;

const ADMIN_ID = randomUUID();
const session = (role) => ({
  sub: `check-${role}`,
  email: `${role}@example.test`,
  role,
  groups: [role],
  sessionId: randomUUID(),
  adminUserId: ADMIN_ID,
  requestId: randomUUID(),
});
const superadmin = session('admin_superadmin');
const ops = session('admin_ops');

async function post(body, who = ops) {
  check.session = who;
  check.presign = { calls: [], behavior: undefined, onPresign: undefined };
  trace.statements = [];
  trace.events = [];
  const before = await lastEventSeq();
  const text = JSON.stringify(body);
  const { result, lines } = await captureConsole(async () => {
    const response = await route.POST(new Request('https://admin.example.test/api/report-actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amz-content-sha256': createHash('sha256').update(text).digest('hex') },
      body: text,
    }));
    return { status: response.status, body: await response.json() };
  });
  return { ...result, lines, statements: [...trace.statements], events: [...trace.events], stored: await eventsAfter(before) };
}

// --- Fixtures (superuser) -----------------------------------------------------

async function insertUser(type, { email = null, phone = null } = {}) {
  const sub = randomUUID();
  const { rows } = await su.query(
    'INSERT INTO public.users (cognito_sub, user_type, full_name, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [sub, type, 'Fixture Reporter', email, phone],
  );
  return { id: rows[0].id, sub };
}

async function seedReport({ role = 'worker', category = 'finding_jobs', verified = true, userId = null, sub = null,
  typed = null, imageKey = null, hasImage = false, erased = false } = {}) {
  const id = randomUUID();
  await su.query(
    `INSERT INTO public.problem_reports (id, client_key, role, verified, category, locale, include_technical, has_image)
     VALUES ($1, $2, $3, $4, $5, 'en', true, $6)`,
    [id, randomUUID(), role, verified, category, hasImage || imageKey !== null],
  );
  if (!erased) {
    await su.query(
      `INSERT INTO public.problem_report_contents
         (report_id, created_at, reporter_user_id, reporter_sub, description, typed_contact, image_key)
       SELECT id, created_at, $2, $3, 'The page stopped loading.', $4, $5 FROM public.problem_reports WHERE id = $1`,
      [id, userId, sub, typed, imageKey],
    );
  }
  return id;
}

const emailOf = () => `reporter-${randomBytes(5).toString('hex')}@example.test`;
const workerEmail = emailOf();
const workerPhone = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
const worker = await insertUser('worker', { email: workerEmail, phone: workerPhone });
let workerContact;
const employer = await insertUser('employer', { email: emailOf() });
const noContactUser = await insertUser('worker');
const typedContact = emailOf();
const REASON = 'Following up on a failed application for this report.';

const verifiedWorker = await seedReport({ userId: worker.id });
const verifiedBySub = await seedReport({ role: 'employer', category: 'billing', sub: employer.sub });
const verifiedNoContact = await seedReport({ userId: noContactUser.id });
const signedOut = await seedReport({ verified: false, typed: typedContact });
const signedOutNoContact = await seedReport({ verified: false });
const erased = await seedReport({ erased: true });
const missing = randomUUID();

async function revealed(id, who = superadmin) {
  return post({ action: 'reveal_contact', reportId: id, reason: REASON }, who);
}

// --- Reveal: account_user_id shapes and the order -------------------------------

{
  const r = await revealed(verifiedWorker);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.revealed.kind, 'account');
  assert.ok(r.body.revealed.contact);
  workerContact = r.body.revealed.contact;
  assert.deepEqual(r.statements, ['BEGIN', 'SELECT outcome, contact_kind, contact,', 'record_event', 'COMMIT']);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0].subject_user_ids, [worker.id], 'the access event names the account the function returned');
  assert.ok(!JSON.stringify(r.events[0]).includes(r.body.revealed.contact), 'the event never holds the contact');
  assert.ok(!r.lines.log.concat(r.lines.error).join(' ').includes(r.body.revealed.contact), 'no log line holds the contact');
  // Stored by the real writer, in the reveal's own transaction, with the purpose and the reason.
  storedOnce(r.stored, {
    kind: 'read', outcome: 'allowed', surface: 'admin.report_contact_reveal',
    categories: ['problem_reports', 'contact_details'], record_type: 'problem_report', record_ids: [verifiedWorker],
    subject_user_ids: [worker.id], field_names: ['contact'], purpose_kind: 'reveal', reason: REASON, link_expires_at: null,
  });
  assert.ok(!JSON.stringify(r.stored).includes(r.body.revealed.contact), 'the stored row never holds the contact');
  surfacesStored.add('admin.report_contact_reveal');
}
{
  // Verified by sign-in only: the account resolves through the sub.
  const r = await revealed(verifiedBySub);
  assert.equal(r.status, 200);
  assert.deepEqual(r.events[0].subject_user_ids, [employer.id]);
}
{
  // A signed-out report names no account: the typed contact, no subjects.
  const r = await revealed(signedOut);
  assert.equal(r.status, 200);
  assert.equal(r.body.revealed.kind, 'typed');
  assert.equal(r.body.revealed.contact, typedContact);
  assert.ok(!JSON.stringify(r.events[0]).includes(typedContact));
  assert.deepEqual(r.events[0].subject_user_ids, [], 'a signed-out report names no account');
}

// Outcome codes through the route (400 for refusals, 404 for not_found).
for (const [label, id, outcome, status] of [
  ['unknown report', missing, 'not_found', 404],
  ['erased content', erased, 'content_erased', 400],
  ['verified without a contact', verifiedNoContact, 'no_contact', 400],
  ['signed-out without a contact', signedOutNoContact, 'no_contact', 400],
]) {
  const r = await revealed(id);
  assert.equal(r.status, status, `reveal ${label}`);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, outcome, `reveal ${label}`);
  assert.ok(r.statements.includes('ROLLBACK'), `reveal ${label}: rolled back`);
  assert.ok(!r.events.some((event) => event.kind !== 'attempt'), `reveal ${label}: no access event kept`);
}

// Reveal order failure modes against the real functions.
{
  trace.failEvent = true;
  const r = await revealed(verifiedWorker);
  trace.failEvent = false;
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, false);
  const released = JSON.stringify(r.body);
  const logged = JSON.stringify([r.lines.log, r.lines.error]);
  for (const value of [workerContact, workerEmail, workerPhone]) {
    assert.ok(!released.includes(value), 'a failed access record releases no value');
    assert.ok(!logged.includes(value), 'a failed access record logs no value');
  }
  assert.ok(r.statements.includes('ROLLBACK'));
}

// --- Screenshots -------------------------------------------------------------------

const imageKey = (id, ext) => `images/${id}/${randomUUID()}.${ext}`;
{
  const id = await seedReport({ userId: worker.id });
  const key = imageKey(id, 'png');
  await su.query('UPDATE public.problem_reports SET has_image = true WHERE id = $1', [id]);
  await su.query('UPDATE public.problem_report_contents SET image_key = $2 WHERE report_id = $1', [id, key]);
  const r = await post({ action: 'view_screenshot', reportId: id });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.statements, ['BEGIN', 'SELECT outcome, image_key, content_type,', 'record_event', 'COMMIT']);
  assert.deepEqual(r.events[0].subject_user_ids, [worker.id], 'the image event names the account');
  assert.equal(check.presign.calls.length, 1);
  assert.equal(check.presign.calls[0].input.Key, key, 'the key is used exactly as the database returned it');
  assert.equal(check.presign.calls[0].input.Bucket, BUCKET);
  assert.equal(check.presign.calls[0].input.ResponseContentType, 'image/png');
  // The stored row carries the link's expiry: issued + 300 s, the presign's own lifetime.
  const shot = storedOnce(r.stored, {
    kind: 'read', outcome: 'allowed', surface: 'admin.report_screenshot', categories: ['problem_reports'],
    record_type: 'problem_report', record_ids: [id], subject_user_ids: [worker.id], purpose_kind: null, reason: null,
  });
  const { signingDate, expiresIn } = check.presign.calls[0].options;
  assert.equal(expiresIn, 300);
  assert.ok(shot.link_expires_at instanceof Date, 'the screenshot row records when the link expires');
  assert.ok(Math.abs(shot.link_expires_at.getTime() - (signingDate.getTime() + 300_000)) <= 1000,
    'the recorded expiry is the link\'s: issued + 300 s');
  surfacesStored.add('admin.report_screenshot');
}
for (const [label, id, outcome, status] of [
  ['unknown report', missing, 'not_found', 404],
  ['no image', await seedReport({ userId: worker.id }), 'no_image', 400],
  ['expired image', await seedReport({ userId: worker.id, hasImage: true }), 'image_expired', 400],
  ['erased content', erased, 'no_image', 400],
]) {
  const r = await post({ action: 'view_screenshot', reportId: id });
  assert.equal(r.status, status, `image ${label}`);
  assert.equal(r.body.error, outcome, `image ${label}`);
  assert.equal(check.presign.calls.length, 0, `image ${label}: no link`);
}

// --- Status and note ------------------------------------------------------------------

{
  const id = await seedReport({ userId: worker.id });
  const r = await post({ action: 'set_status', reportId: id, status: 'looking' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.statements, ['BEGIN', 'SELECT outcome, status FROM', 'record_event', 'COMMIT']);
  storedOnce(r.stored, {
    kind: 'action', outcome: 'done', surface: 'admin.report_status', categories: ['problem_reports'],
    record_type: 'problem_report', record_ids: [id], field_names: ['status'], purpose_kind: null, reason: null, link_expires_at: null,
  });
  surfacesStored.add('admin.report_status');
  const row = (await su.query('SELECT status, status_changed_at FROM public.problem_reports WHERE id = $1', [id])).rows[0];
  assert.equal(row.status, 'looking');
  assert.ok(row.status_changed_at);

  // The audit writer failing rolls the change back in the real database.
  trace.failEvent = true;
  const failed = await post({ action: 'set_status', reportId: id, status: 'fixed' });
  trace.failEvent = false;
  assert.equal(failed.status, 500);
  assert.equal(failed.body.ok, false);
  assert.ok(!JSON.stringify(failed.body).includes('fixed'), 'a failed status change releases no new value');
  assert.equal((await su.query('SELECT status FROM public.problem_reports WHERE id = $1', [id])).rows[0].status, 'looking');

  const gone = await post({ action: 'set_status', reportId: missing, status: 'fixed' });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error, 'not_found');

  // The note replaces, blank clears.
  const note = await post({ action: 'set_note', reportId: id, note: 'first note' });
  assert.equal(note.status, 200);
  storedOnce(note.stored, {
    kind: 'action', outcome: 'done', surface: 'admin.report_note', categories: ['problem_reports'],
    record_type: 'problem_report', record_ids: [id], field_names: ['internal_note'], purpose_kind: null, reason: null, link_expires_at: null,
  });
  assert.ok(!JSON.stringify(note.stored).includes('first note'), 'the stored row names the field, never the note');
  surfacesStored.add('admin.report_note');
  const replaced = await post({ action: 'set_note', reportId: id, note: 'second note' });
  assert.equal(replaced.status, 200);
  const stored = () => su.query('SELECT internal_note FROM public.problem_report_contents WHERE report_id = $1', [id]).then((q) => q.rows[0].internal_note);
  assert.equal(await stored(), 'second note');
  await post({ action: 'set_note', reportId: id, note: '   ' });
  assert.equal(await stored(), null);

  const erasedNote = await post({ action: 'set_note', reportId: erased, note: 'x' });
  assert.equal(erasedNote.body.error, 'content_erased');
  assert.equal((await post({ action: 'set_note', reportId: missing, note: 'x' })).status, 404);
}

// Codes the route validates before it asks: the database answers the same.
async function callAs(sql, params) {
  const client = await realPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(sql, params);
    await client.query('ROLLBACK');
    return rows[0];
  } finally {
    client.release();
  }
}
assert.equal((await callAs(actions.SET_STATUS_SQL, [verifiedWorker, 'bogus'])).outcome, 'invalid_status');
assert.equal((await callAs(actions.SET_NOTE_SQL, [verifiedWorker, 'x'.repeat(4001)])).outcome, 'invalid_note');
const settingsArgs = (over) => [ADMIN_ID, null, null, null, null, null, null, null].map((v, i) => over[i] ?? v);
assert.equal((await callAs(actions.SETTINGS_SET_SQL, settingsArgs({ 5: 'not-an-address' }))).outcome, 'invalid_recipient');
assert.equal((await callAs(actions.SETTINGS_SET_SQL, settingsArgs({ 6: 'http://example.test' }))).outcome, 'invalid_base_url');
assert.equal((await callAs(actions.SETTINGS_SET_SQL, settingsArgs({ 7: 5001 }))).outcome, 'invalid_cap');

// --- Settings through the route ---------------------------------------------------------

{
  const recipient = `team-${randomBytes(4).toString('hex')}@example.test`;
  const r = await post({
    action: 'update_settings',
    settings: { signedOutDailyCap: 25, teamRecipient: recipient },
  }, superadmin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await su.query('SELECT signed_out_daily_cap, team_recipient, updated_by_admin FROM public.problem_report_settings')).rows[0];
  assert.equal(row.signed_out_daily_cap, 25);
  assert.equal(row.team_recipient, recipient);
  assert.equal(row.updated_by_admin, ADMIN_ID);
  assert.ok(!JSON.stringify(r.events).includes(recipient), 'the event names fields, never values');
  storedOnce(r.stored, {
    kind: 'action', outcome: 'done', surface: 'admin.report_settings', categories: ['problem_reports'],
    record_type: null, record_ids: [], field_names: ['signed_out_daily_cap', 'team_recipient'], purpose_kind: null, reason: null,
  });
  assert.ok(!JSON.stringify(r.stored).includes(recipient), 'the stored row names fields, never values');
  surfacesStored.add('admin.report_settings');
}

// --- Reads as the console login ---------------------------------------------------------------

{
  check.session = superadmin;
  trace.statements = [];
  const beforeList = await lastEventSeq();
  const page = await reads.listProblemReports(superadmin, reads.parseInboxFilters({}));
  assert.ok(page.rows.length >= 6);
  for (const row of page.rows) {
    assert.match(row.numberLabel, /^JR-\d+$/);
    assert.ok(['new', 'looking', 'fixed', 'wont_fix'].includes(row.status));
  }
  storedOnce(await eventsAfter(beforeList), {
    kind: 'read', outcome: 'allowed', surface: 'admin.reports_list', categories: ['problem_reports'],
    record_type: 'problem_report', record_ids: page.rows.map((row) => row.id), purpose_kind: null, reason: null, link_expires_at: null,
  });
  surfacesStored.add('admin.reports_list');
  const beforeDetail = await lastEventSeq();
  const detail = await reads.getProblemReport(superadmin, verifiedWorker);
  assert.ok(detail, 'the detail loads');
  assert.equal(detail.id, verifiedWorker);
  storedOnce(await eventsAfter(beforeDetail), {
    kind: 'read', outcome: 'allowed', surface: 'admin.report_detail', categories: ['problem_reports'],
    record_type: 'problem_report', record_ids: [verifiedWorker], subject_user_ids: [worker.id],
    purpose_kind: null, reason: null, link_expires_at: null,
  });
  surfacesStored.add('admin.report_detail');
  const beforeMissing = await lastEventSeq();
  assert.equal(await reads.getProblemReport(superadmin, missing), null);
  // An unknown report leaves an attempt, on its own connection, through the same writer.
  storedOnce(await eventsAfter(beforeMissing), {
    kind: 'attempt', outcome: 'not_found', surface: 'admin.report_detail', categories: ['problem_reports'],
    record_type: 'problem_report', record_ids: [missing],
  });
  assert.equal(detail.accountUserId, worker.id);
}

// Every report surface left its row through the real writer.
assert.deepEqual([...surfacesStored].sort(), [
  'admin.report_contact_reveal', 'admin.report_detail', 'admin.report_note', 'admin.report_screenshot',
  'admin.report_settings', 'admin.report_status', 'admin.reports_list',
]);

// --- Direct table access stays closed to the console login ------------------------------------------
{
  const client = await realPool.connect();
  try {
    await assert.rejects(client.query('SELECT 1 FROM public.problem_report_contents LIMIT 1'), /permission denied|row-level/);
  } finally {
    client.release();
  }
}

await realPool.end();
await su.end();
console.log('report DB-backed checks passed');
