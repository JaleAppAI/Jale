// Checks the dashboard page loaders (Home, the support conversation, the
// lockout detail, analytics and the access history): each loads in one
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
    'src/lib/server/support-conversation.ts',
    'src/lib/server/admin-analytics.ts',
    'src/lib/server/admin-audit.ts',
    'src/lib/access-history.ts',
  ],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    // admin-analytics.ts reads queue depth and bounce metrics (aws-health.ts).
    '@aws-sdk/client-sqs': 'scripts/fakes/sqs.mjs',
    '@aws-sdk/client-cloudwatch': 'scripts/fakes/cloudwatch.mjs',
  },
});

const cases = await load('src/lib/server/admin-cases.ts');
const lockouts = await load('src/lib/server/admin-lockouts.ts');
const conversation = await load('src/lib/server/support-conversation.ts');
const analytics = await load('src/lib/server/admin-analytics.ts');
const audit = await load('src/lib/server/admin-audit.ts');
const history = await load('src/lib/access-history.ts');

// --- The Security page (contract K1.6) -----------------------------------------
// The access history lives at /security now. Every link the history writes
// goes there, and every parameter (filters, deep links, the paging cursor)
// keeps its name.
{
  const SUBJECT = fakeUuid(0xa9);
  const ACTOR = fakeUuid(0xd9);
  const RECORD = fakeUuid(0xc9);
  assert.equal(history.ACCESS_HISTORY_PATH, '/security');
  assert.equal(history.accessHistoryHref({}), '/security');
  assert.equal(history.accessHistoryHref({ actorId: ACTOR }), `/security?actor=${ACTOR}`);
  assert.equal(
    history.accessHistoryHref({
      subjectUserId: SUBJECT, actorId: ACTOR, recordId: RECORD,
      from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z',
      category: 'admin_access', outcome: 'done',
    }, '2026-10-07T12:00:00.000000Z'),
    `/security?subject=${SUBJECT}&actor=${ACTOR}&record=${RECORD}`
      + '&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T00%3A00%3A00.000Z'
      + '&category=admin_access&outcome=done&before=2026-10-07T12%3A00%3A00.000000Z',
  );
  assert.equal(history.accessHistorySearchHref({ subject: SUBJECT, category: 'admin_access' }), `/security?subject=${SUBJECT}&category=admin_access`);
  assert.equal(history.accessHistorySearchHref({}), '/security');
  // The tabs' presets are plain filters the parser already reads.
  const signIns = history.parseAccessHistoryQuery({ category: 'admin_access' });
  assert.deepEqual([signIns.filter.category, signIns.problems], ['admin_access', []]);
  const actions = history.parseAccessHistoryQuery({ outcome: 'done', actor: ACTOR });
  assert.deepEqual([actions.filter.outcome, actions.filter.actorId, actions.problems], ['done', ACTOR, []]);
}

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
    status_changed_at: new Date('2026-10-01T12:00:00Z'),
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
// The queue order the cases list and the dashboard preview share (roadmap 2d).
const QUEUE_ORDER = normalizeSql(cases.CASE_QUEUE_ORDER);
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BY_WAIT_SQL = normalizeSql(cases.OPEN_CASES_BY_WAIT_SQL);
const OPEN = ['1: <connect>', '1: BEGIN'];
const CLOSE = ['1: COMMIT', '1: <commit_completed>', '1: <release>', '-: <returned>'];

async function run(loader) {
  const result = await loader();
  check.log.push({ connection: '-', op: 'returned' });
  return result;
}

// --- The support conversation records the case, its subjects and the messages shown ---
const CONV_CASE = normalizeSql(conversation.CONVERSATION_CASE_SQL);
const CONV_EVENTS = normalizeSql(conversation.CONVERSATION_EVENTS_SQL);
const CONV_VIEW = normalizeSql(conversation.CONVERSATION_VIEW_SQL);
const CONV_EARLIER = normalizeSql(conversation.EARLIER_CASES_SQL);
const OUTBOX_1 = fakeUuid(0x9101);
const OUTBOX_2 = fakeUuid(0x9102);
const MEDIA_1 = fakeUuid(0x9201);
const CONVERSATION_1 = fakeUuid(0x9301);

function conversationCase(overrides = {}) {
  return {
    id: CASE_1, case_type: 'help_request', status: 'pending_admin', summary: 'Synthetic case summary',
    case_number: '124', user_id: WORKER_1, employer_id: null, conversation_id: CONVERSATION_1,
    created_at: new Date('2026-10-01T12:00:00Z'), status_changed_at: new Date('2026-10-01T13:00:00Z'),
    user_name: 'Test Worker', ...overrides,
  };
}
const conversationEvents = [
  { id: fakeUuid(0x7101), event_type: 'case_created', actor_type: 'worker', payload: { title: 'Support case opened', detail: 'A worker asked for help on WhatsApp' }, created_at: new Date('2026-10-01T12:00:00Z') },
  { id: fakeUuid(0x7102), event_type: 'worker_message', actor_type: 'worker', payload: { title: 'Worker message', detail: 'Synthetic worker words' }, created_at: new Date('2026-10-01T12:00:01Z') },
  { id: fakeUuid(0x7103), event_type: 'admins_notified', actor_type: 'system', payload: { title: 'Admins emailed', detail: '2 admins were emailed', count: 2 }, created_at: new Date('2026-10-01T12:00:02Z') },
  { id: fakeUuid(0x7104), event_type: 'worker_media', actor_type: 'worker', payload: { title: 'Worker sent a photo', mediaId: MEDIA_1, mediaType: 'image', caption: 'my id' }, created_at: new Date('2026-10-01T12:01:00Z') },
  { id: fakeUuid(0x7105), event_type: 'admin_reply_queued', actor_type: 'admin', payload: { title: 'Reply queued', detail: 'Synthetic admin words', outboxId: OUTBOX_1, via: null, kind: 'reply', byRole: 'Superadmin' }, created_at: new Date('2026-10-01T12:02:00Z') },
  { id: fakeUuid(0x7106), event_type: 'status_changed', actor_type: 'admin', payload: { title: 'Status changed', detail: 'Pending admin → Pending worker' }, created_at: new Date('2026-10-01T12:02:00Z') },
  { id: fakeUuid(0x7107), event_type: 'admin_reply_waiting_for_window', actor_type: 'system', payload: { title: 'Reply waiting for the worker', outboxId: OUTBOX_1 }, created_at: new Date('2026-10-01T12:03:00Z') },
  { id: fakeUuid(0x7108), event_type: 'admin_reply_sent', actor_type: 'system', payload: { title: 'WhatsApp reply accepted by Twilio', outboxId: OUTBOX_1, via: 'template' }, created_at: new Date('2026-10-01T12:04:00Z') },
  { id: fakeUuid(0x7109), event_type: 'admin_reply_queued', actor_type: 'admin', payload: { title: 'WhatsApp reply queued', detail: 'An older reply', outboxId: OUTBOX_2 }, created_at: new Date('2026-10-01T12:05:00Z') },
  { id: fakeUuid(0x710a), event_type: 'admin_reply_failed', actor_type: 'system', payload: { title: 'WhatsApp reply failed', detail: 'provider error text', outboxId: OUTBOX_2 }, created_at: new Date('2026-10-01T12:06:00Z') },
];
const conversationView = {
  has_conversation: true, language: 'es', window_open: false, window_closes_at: null,
  window_closed_at: new Date('2026-10-02T11:45:00Z'), registered: true, onboarding_step_key: 'profile.trade',
  failed_codes_today: 2, joined_at: new Date('2026-09-01T10:00:00Z'),
};
const earlierCases = [
  { id: CASE_2, case_number: '99', status: 'resolved', resolved_at: new Date('2026-09-20T10:00:00Z'), status_changed_at: new Date('2026-09-20T10:00:00Z') },
];
const conversationAnswers = (overrides = {}) => [
  [new RegExp(`^${escapeRe(CONV_CASE)}$`), [conversationCase(overrides.row)]],
  [new RegExp(`^${escapeRe(CONV_EVENTS)}$`), overrides.events ?? conversationEvents],
  [new RegExp(`^${escapeRe(CONV_VIEW)}$`), [overrides.view ?? conversationView]],
  [new RegExp(`^${escapeRe(CONV_EARLIER)}$`), earlierCases],
];

{
  const { pool, log } = database(conversationAnswers());
  check.pool = pool;
  check.log = log;
  const item = await run(() => conversation.loadSupportConversation(session, CASE_1));
  assertStatements(log, [...OPEN, `1: ${CONV_CASE}`, `1: ${CONV_EVENTS}`, `1: ${CONV_VIEW}`, `1: ${CONV_EARLIER}`, RECORD, ...CLOSE]);
  assert.deepEqual(log[2].params, [CASE_1]);
  assert.deepEqual(log[5].params, [CASE_1, CONVERSATION_1, WORKER_1]);
  assert.match(CONV_EVENTS, /ORDER BY created_at, \(event_type = 'status_changed'\), id$/);
  assert.doesNotMatch(`${CONV_CASE} ${CONV_VIEW}`, /phone|whatsapp_number/, 'no number is read');
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.support_conversation',
    categories: ['cases', 'conversations'],
    subject_user_ids: [WORKER_1],
    record_type: 'admin_case',
    record_ids: [CASE_1],
    result_count: 7,
    field_names: [],
    purpose_kind: 'case',
    purpose_id: CASE_1,
    request_id: REQUEST_ID,
  }]);

  assert.deepEqual(
    { ...item, messages: undefined, actions: undefined },
    {
      caseId: CASE_1, ref: 'S-124', kind: 'support', typeLabel: 'Support',
      status: 'pending_admin', statusLabel: 'Worker replied', subject: 'Synthetic case summary',
      language: 'es', languageLabel: 'Spanish',
      messages: undefined,
      window: { open: false, closesAt: null, closedAt: '2026-10-02T11:45:00.000Z' },
      reply: {
        mode: 'template',
        maxChars: 250,
        templatePreview: { before: 'Jale Soporte: «', after: '». Responde a este mensaje si necesitas más ayuda.' },
      },
      worker: {
        label: 'Test W.', registered: true, userId: WORKER_1,
        onboardingStepLabel: 'Trade', onboardingStepIndex: 8, onboardingStepCount: 17,
        failedCodesToday: 2, joinedAt: '2026-09-01T10:00:00.000Z',
      },
      facts: { openedAt: '2026-10-01T12:00:00.000Z', waitingSince: '2026-10-01T13:00:00.000Z', messageCount: 4, mediaCount: 1, adminsEmailed: 2 },
      earlierCases: [{ caseId: CASE_2, ref: 'S-99', statusLabel: 'Resolved', closedAt: '2026-09-20T10:00:00.000Z' }],
      actions: undefined,
    },
  );
  const media = item.messages.find((message) => message.kind === 'media');
  assert.deepEqual(item.messages.map((message) => [message.from, message.kind]), [
    ['system', 'note'], ['worker', 'text'], ['system', 'note'], ['worker', 'media'], ['admin', 'text'], ['system', 'note'], ['admin', 'text'],
  ]);
  assert.deepEqual(item.messages[0], { id: fakeUuid(0x7101), at: '2026-10-01T12:00:00.000Z', from: 'system', kind: 'note', text: 'Support case opened: A worker asked for help on WhatsApp' });
  assert.equal(item.messages[1].text, 'Synthetic worker words');
  assert.equal(item.messages[2].text, 'Admins emailed: 2 admins were emailed');
  // Media older than the 90-day retention shows as expired.
  assert.equal(media.mediaId, MEDIA_1);
  assert.equal(media.mediaType, 'image');
  assert.equal(media.caption, 'my id');
  assert.equal(media.expired, Date.now() >= new Date('2026-10-01T12:01:00Z').getTime() + 90 * 86_400_000);
  // Delivery comes from the dispatcher's events for the same outbox row; a
  // final outcome is never undone, and a reply without a role was an Ops one.
  assert.deepEqual(item.messages[4], {
    id: fakeUuid(0x7105), at: '2026-10-01T12:02:00.000Z', from: 'admin', kind: 'text', text: 'Synthetic admin words',
    byRole: 'Superadmin', delivery: 'sent', via: 'template',
  });
  assert.deepEqual(item.messages[6], {
    id: fakeUuid(0x7109), at: '2026-10-01T12:05:00.000Z', from: 'admin', kind: 'text', text: 'An older reply',
    byRole: 'Ops', delivery: 'failed', via: null,
  });
  assert.doesNotMatch(JSON.stringify(item.messages), /provider error text/, 'dispatcher details stay out of the conversation');
  // A read-only viewer sees every action, disabled with the reason.
  assert.deepEqual(item.actions, ['reply', 'request_info', 'resolve', 'reveal_phone'].map((id) => ({ id, enabled: false, reason: 'Requires Ops or Superadmin.' })));
}

// The window open: free text up to 1000, no preview; English; an unregistered number.
{
  const { pool } = database(conversationAnswers({
    row: { user_id: null, user_name: null, status: 'pending_worker' },
    view: { ...conversationView, language: 'en', window_open: true, window_closes_at: new Date('2026-10-02T11:45:00Z'), window_closed_at: null, registered: false, onboarding_step_key: null, failed_codes_today: 0, joined_at: null },
    events: [],
  }));
  check.pool = pool;
  const item = await conversation.loadSupportConversation({ ...session, role: 'admin_ops' }, CASE_1);
  assert.deepEqual(item.reply, { mode: 'freeform', maxChars: 1000, templatePreview: null });
  assert.deepEqual([item.language, item.languageLabel], ['en', 'English']);
  assert.deepEqual(item.window, { open: true, closesAt: '2026-10-02T11:45:00.000Z', closedAt: null });
  assert.deepEqual(item.worker, {
    label: 'Unregistered number', registered: false, userId: null,
    onboardingStepLabel: null, onboardingStepIndex: null, onboardingStepCount: null, failedCodesToday: 0, joinedAt: null,
  });
  assert.equal(item.facts.waitingSince, null, 'waiting on the worker is not a wait on us');
  assert.ok(item.actions.every((action) => action.enabled), 'Ops may act on an open case with a conversation');
  assert.equal(conversation.TEMPLATE_PREVIEWS.en.before, 'Jale Support replied to your help request: “');
  assert.equal(conversation.TEMPLATE_PREVIEWS.en.after, '”. Reply to this message if you need more help.');
}

// A case that does not exist: a not_found attempt after the transaction; a
// malformed id is never queried.
{
  const { pool, log } = database([[new RegExp(`^${escapeRe(CONV_CASE)}$`), []]]);
  check.pool = pool;
  check.log = log;
  assert.equal(await conversation.loadSupportConversation(session, CASE_2), null);
  assertStatements(log, [
    ...OPEN, `1: ${CONV_CASE}`, '1: COMMIT', '1: <commit_completed>', '1: <release>',
    '2: <connect>', '2: BEGIN', `2: ${RECORD_EVENT_SQL}`, '2: COMMIT', '2: <commit_completed>', '2: <release>',
  ]);
  const [attempt] = recordedEvents(log);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.categories, attempt.record_type, attempt.record_ids],
    ['attempt', 'not_found', 'admin.support_conversation', ['cases', 'conversations'], 'admin_case', [CASE_2]],
  );

  const { pool: pool2, log: log2 } = database([]);
  check.pool = pool2;
  assert.equal(await conversation.loadSupportConversation(session, 'not-a-case-id'), null);
  assert.equal(log2.filter((entry) => /admin_cases/.test(entry.sql ?? '')).length, 0, 'a malformed id is never queried');
  assert.doesNotMatch(JSON.stringify(log2), /not-a-case-id/);
}

// --- The lockout detail records the challenge, with no subject ----------------------
const LOCKOUT_DETAIL = normalizeSql(lockouts.LOCKOUT_DETAIL_SQL);
const CHALLENGE_1 = 'abcd1234-0000-4000-8000-000000000001';
{
  const detailRow = {
    challenge_id: CHALLENGE_1, state: 'locked', language: 'en', masked_phone: '+1 202 *** 0123', attempts: 3,
    locked_until: new Date('2026-10-01T16:00:00Z'), started_at: new Date('2026-10-01T15:00:00Z'), earlier_resets: 1,
    typical_minutes_to_verify: 4, support_case_id: CASE_1.toUpperCase(),
    timeline: [
      { kind: 'status', at: '2026-10-01T15:00:00.123456+00:00', from_status: null, to_status: 'pending', attempts: 0, locked_until: null, is_backfill: false },
      { kind: 'status', at: '2026-10-01T15:05:00+00:00', from_status: 'pending', to_status: 'pending', attempts: 1, locked_until: null, is_backfill: false },
      { kind: 'reset', at: '2026-10-01T15:10:00+00:00', reason_code: 'codes_not_arriving', by_role: 'Ops' },
      { kind: 'status', at: '2026-10-01T15:20:00+00:00', from_status: 'pending', to_status: 'locked', attempts: 3, locked_until: '2026-10-01T16:00:00+00:00', is_backfill: true },
      { kind: 'mystery', at: '2026-10-01T15:30:00+00:00' },
    ],
    phone_hash: 'must-not-leave', verified_user_id: WORKER_1,
  };
  const { pool, log } = database([[new RegExp(`^${escapeRe(LOCKOUT_DETAIL)}$`), [detailRow]]]);
  check.pool = pool;
  check.log = log;
  const detail = await run(() => lockouts.loadLockoutDetail({ ...session, role: 'admin_ops' }, CHALLENGE_1));
  assertStatements(log, [...OPEN, `1: ${LOCKOUT_DETAIL}`, RECORD, ...CLOSE]);
  assert.deepEqual(log[2].params, [CHALLENGE_1]);
  assert.doesNotMatch(LOCKOUT_DETAIL, /phone_hash|user_id/, 'the read names neither the hash nor a user');
  assert.deepEqual(detail, {
    challengeId: CHALLENGE_1, ref: 'V-ABCD1234', state: 'locked', statusLabel: 'Locked',
    languageLabel: 'English', maskedPhone: '+1 202 *** 0123', attemptsUsed: 3, attemptsAllowed: 3,
    startedAt: '2026-10-01T15:00:00.000Z', lockedUntil: '2026-10-01T16:00:00.000Z', earlierResets: 1,
    typicalMinutesToVerify: 4,
    timeline: [
      { at: '2026-10-01T15:00:00.123Z', title: 'Verification started', detail: null },
      { at: '2026-10-01T15:05:00.000Z', title: 'Wrong code', detail: 'Attempt 1 of 3' },
      { at: '2026-10-01T15:10:00.000Z', title: 'Reset by an Ops admin', detail: 'Codes not arriving' },
      { at: '2026-10-01T15:20:00.000Z', title: 'Locked (recorded before history was kept)', detail: 'After 3 wrong codes' },
    ],
    supportCaseId: CASE_1,
    actions: [{ id: 'reset_lockout', enabled: true }, { id: 'open_support_from_lockout', enabled: true }],
  });
  assert.doesNotMatch(JSON.stringify(detail), /must-not-leave|0000a1/, 'no hash and no user id leave the loader');
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    actor_role: 'admin_ops',
    surface: 'admin.lockout_detail',
    categories: ['verifications'],
    subject_user_ids: [],
    record_type: 'identity_challenge',
    record_ids: [CHALLENGE_1],
    result_count: 4,
    field_names: [],
    purpose_kind: 'verification',
    request_id: REQUEST_ID,
  }]);

  // Verified: no reset; read-only: everything disabled.
  const { pool: pool2 } = database([[new RegExp(`^${escapeRe(LOCKOUT_DETAIL)}$`), [{ ...detailRow, state: 'verified' }]]]);
  check.pool = pool2;
  const verified = await lockouts.loadLockoutDetail(session, CHALLENGE_1);
  assert.deepEqual(verified.actions, [
    { id: 'reset_lockout', enabled: false, reason: 'Requires Ops or Superadmin.' },
    { id: 'open_support_from_lockout', enabled: false, reason: 'Requires Ops or Superadmin.' },
  ]);
  assert.throws(() => lockouts.mapLockoutDetailRow({ ...detailRow, state: 'approved' }, 'admin_ops'), /Unexpected lockout state/);

  // Unknown and malformed ids.
  const { pool: pool3, log: log3 } = database([[new RegExp(`^${escapeRe(LOCKOUT_DETAIL)}$`), []]]);
  check.pool = pool3;
  assert.equal(await lockouts.loadLockoutDetail(session, CHALLENGE_1), null);
  const [attempt] = recordedEvents(log3);
  assert.deepEqual(
    [attempt.kind, attempt.outcome, attempt.surface, attempt.record_type, attempt.record_ids, attempt.purpose_kind],
    ['attempt', 'not_found', 'admin.lockout_detail', 'identity_challenge', [CHALLENGE_1], 'verification'],
  );
  const { pool: pool4, log: log4 } = database([]);
  check.pool = pool4;
  assert.equal(await lockouts.loadLockoutDetail(session, 'V-ABCD1234'), null);
  assert.equal(log4.filter((entry) => /admin_identity_challenge_detail/.test(entry.sql ?? '')).length, 0);
}

// --- The dashboard records the cases and the lockouts it shows ---------------
{
  const lockoutRows = [
    lockoutRow(1, 'lockout'), lockoutRow(2, 'lockout'), lockoutRow(3, 'stuck'),
    lockoutRow(4, 'lockout'), lockoutRow(5, 'lockout'),
  ];
  const { pool, log } = database([
    [/^SELECT CASE WHEN c\.status = 'pending_worker' THEN 'worker' ELSE 'us' END AS waiting_on/, [
      { waiting_on: 'us', bucket: 'under_1d', count: '4' },
      { waiting_on: 'us', bucket: 'over_7d', count: '1' },
      { waiting_on: 'worker', bucket: 'days_1_3', count: '2' },
    ]],
    [/FROM admin_cases c .* WHERE c\.status NOT IN .* LIMIT \$1$/, [caseRow(CASE_1, { employer_id: EMPLOYER_1 }), caseRow(CASE_2, { user_id: null, employer_id: null })]],
    [/jale_audit\.reveal_count/, [{ count: '4' }]],
    [/admin_identity_lockouts/, lockoutRows],
  ]);
  check.pool = pool;
  check.log = log;
  const dashboard = await run(() => cases.loadAdminDashboard(session));
  assertStatements(log, [
    ...OPEN,
    `1: ${BY_WAIT_SQL}`,
    new RegExp(`^1: SELECT c\\.id, .* WHERE c\\.status NOT IN \\('resolved', 'dismissed'\\) ${escapeRe(QUEUE_ORDER)} LIMIT \\$1$`),
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
  // The by-wait counts are aggregates: zero-filled, and never recorded.
  assert.deepEqual(dashboard.openByWait, {
    us: { under_1d: 4, days_1_3: 0, days_3_7: 0, over_7d: 1 },
    worker: { under_1d: 0, days_1_3: 2, days_3_7: 0, over_7d: 0 },
  });
  assert.equal(dashboard.revealCount, 4);
  assert.equal(dashboard.lockedOutCount, 4);
  assert.equal(dashboard.stuckCount, 1);
  assert.deepEqual(dashboard.openCases.map((item) => item.id), [CASE_1, CASE_2]);
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

// --- The Employers page: each list that names employers records them ---------
function slowestRow(n) {
  return {
    employer_id: fakeUuid(0xe00 + n), display_name: `Synthetic Co ${n}`, applications: '5',
    unanswered_7d: '2', first_response_p50_hours: '30.5', active_jobs: '1',
  };
}
function staleRow(n, employer) {
  return {
    job_id: fakeUuid(0xb00 + n), title: `Synthetic job ${n}`, employer_id: employer, display_name: 'Synthetic Co',
    posted_at: new Date('2026-09-01T12:00:00Z'), last_employer_action_at: new Date('2026-09-02T12:00:00Z'),
    days_idle: 20, waiting_applicants: '1', last_application_at: null,
  };
}
{
  const { pool, log } = database([[/admin_analytics_slowest_employers/, [slowestRow(1), slowestRow(2), slowestRow(3)]]]);
  check.pool = pool;
  check.log = log;
  const rows = await run(() => analytics.loadSlowestEmployers(session, 4));
  assertStatements(log, [...OPEN, '1: SELECT * FROM admin_analytics_slowest_employers($1, $2)', RECORD, ...CLOSE]);
  assert.deepEqual(log[2].params, [4, 10]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.analytics_slowest_employers',
    categories: ['analytics'],
    subject_user_ids: [fakeUuid(0xe01), fakeUuid(0xe02), fakeUuid(0xe03)],
    record_ids: [],
    result_count: 3,
    field_names: [],
    request_id: REQUEST_ID,
  }]);
  assert.deepEqual(rows.map((row) => row.employerId), [fakeUuid(0xe01), fakeUuid(0xe02), fakeUuid(0xe03)]);
}
{
  // 30 stale jobs: the tile counts all 30; the list shows the first 25, and
  // exactly those are recorded. Jobs 26-30 belong to an employer no shown
  // job has, so that employer is not recorded.
  const hidden = fakeUuid(0xe99);
  const jobs = Array.from({ length: 30 }, (_, i) => staleRow(i + 1, i < 25 ? (i % 2 === 0 ? EMPLOYER_1 : fakeUuid(0xe2)) : hidden));
  const { pool, log } = database([[/admin_analytics_stale_jobs/, jobs]]);
  check.pool = pool;
  check.log = log;
  const rows = await run(() => analytics.loadStaleJobs(session, 14));
  assertStatements(log, [...OPEN, '1: SELECT * FROM admin_analytics_stale_jobs($1)', RECORD, ...CLOSE]);
  assert.deepEqual(log[2].params, [14]);
  assert.deepEqual(recordedEvents(log), [{
    kind: 'read',
    outcome: 'allowed',
    ...actor,
    surface: 'admin.analytics_stale_jobs',
    categories: ['analytics'],
    subject_user_ids: [EMPLOYER_1, fakeUuid(0xe2)],
    record_ids: [],
    result_count: 25,
    field_names: [],
    request_id: REQUEST_ID,
  }]);
  assert.equal(rows.length, 30, 'every stale job comes back, for the tile');
}
{
  // K3.2 (sprint 28): the picker's day count reaches the SQL, and the record
  // is still exactly the rendered slice (the first 25).
  const jobs = Array.from({ length: 27 }, (_, i) => staleRow(i + 1, i < 25 ? EMPLOYER_1 : fakeUuid(0xe98)));
  const { pool, log } = database([[/admin_analytics_stale_jobs/, jobs]]);
  check.pool = pool;
  check.log = log;
  const rows = await run(() => analytics.loadStaleJobs(session, 30));
  assertStatements(log, [...OPEN, '1: SELECT * FROM admin_analytics_stale_jobs($1)', RECORD, ...CLOSE]);
  assert.deepEqual(log[2].params, [30], 'the chosen 30 days, not the default 14');
  assert.deepEqual(recordedEvents(log).map((e) => [e.surface, e.subject_user_ids, e.result_count]),
    [['admin.analytics_stale_jobs', [EMPLOYER_1], 25]]);
  assert.equal(rows.length, 27);
}
{
  // ?stale= accepts 7, 14 and 30; anything else (99, a repeated param,
  // nothing) is the default 14.
  assert.equal(analytics.parseStaleDays('7'), 7);
  assert.equal(analytics.parseStaleDays('14'), 14);
  assert.equal(analytics.parseStaleDays('30'), 30);
  assert.equal(analytics.parseStaleDays('99'), 14);
  assert.equal(analytics.parseStaleDays(['7']), 14);
  assert.equal(analytics.parseStaleDays(undefined), 14);
}
{
  // An empty list is still a recorded view.
  const { pool, log } = database([[/admin_analytics_stale_jobs/, []]]);
  check.pool = pool;
  check.log = log;
  assert.deepEqual(await run(() => analytics.loadStaleJobs(session, 14)), []);
  assert.deepEqual(recordedEvents(log).map((e) => [e.surface, e.subject_user_ids, e.result_count]), [['admin.analytics_stale_jobs', [], 0]]);
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
    name: 'a support conversation',
    loader: () => conversation.loadSupportConversation(session, CASE_1),
    answers: conversationAnswers(),
    attempt: { ...actor, surface: 'admin.support_conversation', categories: ['cases', 'conversations'], record_type: 'admin_case', record_ids: [CASE_1] },
  },
  {
    name: 'a lockout detail',
    loader: () => lockouts.loadLockoutDetail(session, CHALLENGE_1),
    answers: [[/admin_identity_challenge_detail/, [{
      challenge_id: CHALLENGE_1, state: 'locked', language: 'es', masked_phone: null, attempts: 3, locked_until: null,
      started_at: new Date('2026-10-01T15:00:00Z'), earlier_resets: 0, typical_minutes_to_verify: null, support_case_id: null, timeline: [],
    }]]],
    attempt: {
      ...actor, surface: 'admin.lockout_detail', categories: ['verifications'], record_type: 'identity_challenge',
      record_ids: [CHALLENGE_1], purpose_kind: 'verification',
    },
  },
  {
    name: 'the dashboard',
    loader: () => cases.loadAdminDashboard(session),
    answers: [
      [/^SELECT CASE WHEN c\.status = 'pending_worker' THEN 'worker' ELSE 'us' END AS waiting_on/, [{ waiting_on: 'us', bucket: 'under_1d', count: '1' }]],
      [/FROM admin_cases c .* LIMIT \$1$/, [caseRow(CASE_1)]],
      [/jale_audit\.reveal_count/, [{ count: '0' }]],
      [/admin_identity_lockouts/, [lockoutRow(1, 'lockout')]],
    ],
    attempt: { ...actor, surface: 'admin.dashboard', categories: ['cases', 'verifications'], record_ids: [] },
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
    name: 'the slowest employers list',
    loader: () => analytics.loadSlowestEmployers(session, 8),
    answers: [[/admin_analytics_slowest_employers/, [slowestRow(1)]]],
    attempt: { ...actor, surface: 'admin.analytics_slowest_employers', categories: ['analytics'], record_ids: [] },
  },
  {
    name: 'the stale jobs list',
    loader: () => analytics.loadStaleJobs(session, 14),
    answers: [[/admin_analytics_stale_jobs/, [staleRow(1, EMPLOYER_1)]]],
    attempt: { ...actor, surface: 'admin.analytics_stale_jobs', categories: ['analytics'], record_ids: [] },
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
    await assert.rejects(() => conversation.loadSupportConversation(session, CASE_1), (error) => error === failure);
  });
  assert.deepEqual(statements(log).slice(-3), [`2: ${RECORD_EVENT_SQL}`, '2: ROLLBACK', '2: <release>']);
  assert.deepEqual(
    fallbackLines().map((line) => [line.origin, line.kind, line.outcome, line.surface, line.actor_id, line.request_id]),
    [['admin', 'attempt', 'failed', 'admin.support_conversation', ADMIN_ID, REQUEST_ID]],
  );
  assert.deepEqual(output.error, [], 'the fallback took the attempt: nothing is lost');

  check.cloudwatch = { clients: [], sent: [], behavior: undefined };
  const unreachable = new Error('pool unavailable');
  check.pool = unreachable;
  await captureConsole(async () => {
    await assert.rejects(() => lockouts.loadLockoutDetail(session, CHALLENGE_1), (error) => error === unreachable);
  });
  assert.deepEqual(
    fallbackLines().map((line) => [line.kind, line.outcome, line.surface]),
    [['attempt', 'failed', 'admin.lockout_detail']],
  );
  delete process.env.AUDIT_FALLBACK_LOG_GROUP;
}

console.log('admin page loader checks passed');
