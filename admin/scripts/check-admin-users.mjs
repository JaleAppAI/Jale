// The Admins page backend (contract K1.5): loadAdmins and the five actions
// behind POST /api/admin-users. Superadmins only, every read and action
// recorded, the guards decided in SQL (migration 120's definers), and the
// directory (the admin pool) changed in the order BE-1 §4.4 sets:
//   invite      Cognito create -> add group -> DB row (a retry repairs)
//   resend      Cognito user must be FORCE_CHANGE_PASSWORD -> resend
//   change role DB (guards) -> add the new group -> remove the other admin groups
//   deactivate  DB (guards, inactive, sessions revoked, trust ended) ->
//               global sign-out -> forget every device -> disable (last);
//               a user the pool already has disabled was finished before
//   reactivate  enable -> group sync -> DB active
// A Cognito failure after the DB commit answers directory_sync_failed with
// saved: true; before it, saved: false. Every call on an existing admin names
// the user by its sign-in id (admin_users.cognito_sub), never by the stored
// email, whose case may differ from the pool's; the email names the user only
// when the invitation is created or sent again. The pool, the Logs client and the
// Cognito admin API are fakes; Cognito calls land in the same ordered log as
// the SQL, as `cognito: <Command>`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  RECORD_EVENT_SQL,
  compileAdminSources,
  createFakePool,
  fakeUuid,
  normalizeSql,
  recordedEvents,
  statements,
} from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'admin-users',
  sources: ['src/lib/server/admin-users.ts', 'src/app/api/admin-users/route.ts', 'src/lib/server/audit/context.ts'],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    '@aws-sdk/client-cognito-identity-provider': 'scripts/fakes/cognito-idp.mjs',
    'next/headers': 'scripts/fakes/next-headers.mjs',
    'next/server': 'scripts/fakes/next-server.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
    'aws-jwt-verify': 'scripts/fakes/aws-jwt-verify.mjs',
  },
});

process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID = 'check-region_CheckPool';
process.env.NEXT_PUBLIC_ADMIN_CLIENT_ID = 'check-client';
process.env.NEXT_PUBLIC_ADMIN_REGION = 'check-region';
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';
delete process.env.ADMIN_PREVIEW_ROLE;
delete process.env.ADMIN_ALLOW_LOCAL_PREVIEW;

const adminUsers = await load('src/lib/server/admin-users.ts');
const route = await load('src/app/api/admin-users/route.ts');
const context = await load('src/lib/server/audit/context.ts');

const check = (globalThis.__adminCheck = { cookies: new Map() });
const POOL = 'check-region_CheckPool';
const VIEWER = fakeUuid(0xd1);
const SESSION_ID = fakeUuid(0xd2);
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const TARGET = fakeUuid(0xd9);
const NEW_ADMIN = fakeUuid(0xda);
const ACTION_REQUEST = '22222222-3333-4444-8555-666666666666';
const TARGET_EMAIL = 'target-admin@example.test';
const TARGET_SUB = 'target-admin-sub';
// A hand-provisioned admin whose stored email differs in case from the pool's.
const MIXED_EMAIL = 'Target.Admin@Example.Test';
const CONTEXT_SQL = normalizeSql(context.SET_AUDIT_CONTEXT_SQL);
const CREATED = new Date('2026-10-01T12:00:00.000Z');

function sessionFor(role) {
  return {
    sub: 'check-admin-sub', email: 'viewer-admin@example.test', role, groups: [role],
    sessionId: SESSION_ID, adminUserId: VIEWER, requestId: REQUEST_ID,
  };
}
const superadmin = sessionFor('admin_superadmin');
const ops = sessionFor('admin_ops');

const cognitoError = (name) => Object.assign(new Error(name), { name });

function itemRow(overrides = {}) {
  return {
    id: TARGET, admin_email: TARGET_EMAIL, cognito_sub: TARGET_SUB, role: 'admin_ops', active: true, created_at: CREATED,
    last_sign_in_at: new Date('2026-10-10T08:00:00.000Z'), trusted_browsers: 1, ...overrides,
  };
}

/**
 * A database and a directory for one action. `definer` answers the 120
 * function calls (a row, or an Error); `rows` answers the item reads by id;
 * `cognito` answers each Cognito command by name (a result or an Error).
 */
function world({ definer, row = itemRow(), cognito = {}, revoked = 2, existing = false } = {}) {
  const { pool, log } = createFakePool({
    respond: ({ sql, params }) => {
      if (sql === INVITE_PRECHECK_SQL) return { rows: existing ? [{ id: fakeUuid(0xee) }] : [] };
      if (/^SELECT \* FROM public\.admin_user_(invite_record|set_role|set_active)\(/.test(sql)) {
        const outcome = typeof definer === 'function' ? definer(sql, params) : definer;
        if (outcome instanceof Error) throw outcome;
        return { rows: outcome ? [outcome] : [] };
      }
      if (sql.startsWith('WITH revoked AS')) return { rows: [{ revoked_count: revoked }] };
      if (sql.includes('FROM admin_users u') && sql.includes('WHERE u.id = $1')) {
        return { rows: row ? [row] : [] };
      }
      return {};
    },
  });
  check.pool = pool;
  check.cognito = {
    clients: [],
    sent: [],
    onSend: (command) => { log.push({ connection: 'cognito', op: command.name }); },
    behavior: (command) => {
      const answer = cognito[command.name];
      return typeof answer === 'function' ? answer(command.input) : answer;
    },
  };
  return { pool, log };
}

const sentInputs = (name) => check.cognito.sent.filter((command) => command.name === name).map((command) => command.input);
const dbError = (message, code) => Object.assign(new Error(message), { code });
const flow = (log) => statements(log.filter((entry) => entry.sql !== CONTEXT_SQL));
const contexts = (log) => log.filter((entry) => entry.sql === CONTEXT_SQL).map((entry) => entry.params[3]);

const act = (session, body) => adminUsers.runAdminUserAction(session, body);
const INVITE_PRECHECK_SQL = 'SELECT id FROM admin_users WHERE lower(admin_email) = $1';
const cognitoNames = (log) => flow(log).filter((line) => line.startsWith('cognito'));
const usernames = () => [...new Set(check.cognito.sent.map((command) => command.input.Username))];
const ENABLED_USER = { UserStatus: 'CONFIRMED', Enabled: true, UserAttributes: [{ Name: 'sub', Value: TARGET_SUB }] };
const DISABLED_USER = { UserStatus: 'CONFIRMED', Enabled: false, UserAttributes: [{ Name: 'sub', Value: TARGET_SUB }] };

// --- loadAdmins ----------------------------------------------------------------
{
  const rows = [
    itemRow({ id: VIEWER, admin_email: 'viewer-admin@example.test', role: 'admin_superadmin', trusted_browsers: 2 }),
    itemRow({ id: fakeUuid(0xe1), admin_email: 'invited-admin@example.test', last_sign_in_at: null, trusted_browsers: 0 }),
    itemRow({ id: fakeUuid(0xe2), admin_email: 'gone-admin@example.test', active: false, trusted_browsers: 0 }),
  ];
  const { pool, log } = createFakePool({
    respond: ({ sql }) => (sql.includes('FROM admin_users u') ? { rows } : {}),
  });
  check.pool = pool;
  const result = await adminUsers.loadAdmins(superadmin);
  assert.equal(result.status, 'ok', 'a superadmin gets the list');
  assert.equal(result.viewerId, VIEWER);
  assert.deepEqual(result.admins.map((a) => [a.email, a.status, a.isSelf, a.canResendInvite, a.trustedBrowsers]), [
    ['viewer-admin@example.test', 'active', true, false, 2],
    ['invited-admin@example.test', 'invited', false, true, 0],
    ['gone-admin@example.test', 'deactivated', false, false, 0],
  ]);
  assert.deepEqual(result.admins[0], {
    id: VIEWER, email: 'viewer-admin@example.test', role: 'admin_superadmin', status: 'active',
    lastSignInAt: '2026-10-10T08:00:00.000Z', trustedBrowsers: 2, createdAt: '2026-10-01T12:00:00.000Z',
    isSelf: true, canResendInvite: false,
  });
  assert.equal(result.admins[1].lastSignInAt, null);
  const lines = statements(log);
  assert.deepEqual([lines[0], lines[1]], ['1: <connect>', '1: BEGIN']);
  assert.match(lines[2], /^1: SELECT u\.id, u\.admin_email, u\.role, u\.active, u\.created_at/);
  // Active first, then invited, then deactivated; email order within.
  assert.match(lines[2], /ORDER BY CASE WHEN NOT u\.active THEN 2 WHEN s\.last_sign_in_at IS NULL THEN 1 ELSE 0 END, u\.admin_email, u\.id$/);
  // Live trust only: not ended and not past its 7 days.
  assert.match(lines[2], /d\.ended_at IS NULL AND d\.expires_at > now\(\)/);
  assert.deepEqual(lines.slice(3), [`1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  const [event] = recordedEvents(log);
  assert.deepEqual(
    [event.kind, event.outcome, event.surface, event.categories, event.record_type, event.record_ids, event.result_count],
    ['read', 'allowed', 'admin.admins_list', ['admin_access'], 'admin_user', rows.map((r) => r.id), 3],
  );
}
{
  const { pool, log } = createFakePool();
  check.pool = pool;
  assert.deepEqual(await adminUsers.loadAdmins(ops), { status: 'forbidden' });
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome, event.surface, event.actor_role], ['attempt', 'denied', 'admin.admins_list', 'admin_ops']);
  assert.equal(log.filter((entry) => entry.sql?.includes('FROM admin_users')).length, 0, 'nothing is read');
}

// --- Only superadmins act; refusals are recorded on the action's surface --------
for (const [body, surface] of [
  [{ action: 'invite', requestId: ACTION_REQUEST, email: 'new@example.test', role: 'admin_ops' }, 'admin.admin_invite'],
  [{ action: 'resend_invite', requestId: ACTION_REQUEST, adminUserId: TARGET }, 'admin.admin_resend_invite'],
  [{ action: 'change_role', requestId: ACTION_REQUEST, adminUserId: TARGET, role: 'admin_ops' }, 'admin.admin_role_change'],
  [{ action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET }, 'admin.admin_deactivate'],
  [{ action: 'reactivate', requestId: ACTION_REQUEST, adminUserId: TARGET }, 'admin.admin_reactivate'],
]) {
  const { log } = world();
  const outcome = await act(ops, body);
  assert.deepEqual(outcome, { status: 403, body: { ok: false, error: 'forbidden' } }, `${body.action} is superadmin-only`);
  assert.deepEqual(check.cognito.sent, []);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome, event.surface, event.record_ids], ['attempt', 'denied', surface, []]);
}

// --- Input is checked before anything happens ----------------------------------
for (const body of [
  undefined,
  { action: 'promote', requestId: ACTION_REQUEST, adminUserId: TARGET },
  { action: 'invite', requestId: 'not-a-uuid', email: 'new@example.test', role: 'admin_ops' },
  { action: 'invite', requestId: ACTION_REQUEST, email: 'not an email', role: 'admin_ops' },
  { action: 'invite', requestId: ACTION_REQUEST, email: 'new@example.test', role: 'root' },
  { action: 'change_role', requestId: ACTION_REQUEST, adminUserId: 'x', role: 'admin_ops' },
  { action: 'deactivate', requestId: ACTION_REQUEST },
]) {
  const { log } = world();
  assert.deepEqual(await act(superadmin, body), { status: 400, body: { ok: false, error: 'invalid_input' } });
  assert.deepEqual(check.cognito.sent, []);
  assert.equal(log.filter((entry) => entry.sql === 'BEGIN').length, 0);
}

// --- invite: create -> group -> row ---------------------------------------------
{
  const { log } = world({
    definer: { admin_user_id: NEW_ADMIN, email: 'new-admin@example.test', role: 'admin_ops', active: true, created_at: CREATED },
    row: itemRow({ id: NEW_ADMIN, admin_email: 'new-admin@example.test', last_sign_in_at: null, trusted_browsers: 0 }),
    cognito: { AdminCreateUser: { User: { Attributes: [{ Name: 'sub', Value: 'new-admin-sub' }] } } },
  });
  const outcome = await act(superadmin, { action: 'invite', requestId: ACTION_REQUEST, email: ' New-Admin@Example.Test ', role: 'admin_ops' });
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body.admin, {
    id: NEW_ADMIN, email: 'new-admin@example.test', role: 'admin_ops', status: 'invited', lastSignInAt: null,
    trustedBrowsers: 0, createdAt: CREATED.toISOString(), isSelf: false, canResendInvite: true,
  });
  assert.deepEqual(sentInputs('AdminCreateUser'), [{
    UserPoolId: POOL,
    Username: 'new-admin@example.test',
    UserAttributes: [{ Name: 'email', Value: 'new-admin@example.test' }, { Name: 'email_verified', Value: 'true' }],
    DesiredDeliveryMediums: ['EMAIL'],
  }]);
  assert.deepEqual(sentInputs('AdminAddUserToGroup'), [{ UserPoolId: POOL, Username: 'new-admin@example.test', GroupName: 'admin_ops' }]);
  const lines = flow(log);
  // No admin has the address yet (checked before the pool is asked).
  assert.deepEqual(lines.slice(0, 5), [
    `pool: ${INVITE_PRECHECK_SQL}`, 'cognito: <AdminCreateUser>', 'cognito: <AdminAddUserToGroup>', '1: <connect>', '1: BEGIN',
  ]);
  assert.deepEqual(log.find((entry) => entry.sql === INVITE_PRECHECK_SQL).params, ['new-admin@example.test']);
  assert.equal(lines[5], '1: SELECT * FROM public.admin_user_invite_record($1, $2, $3, $4)');
  assert.deepEqual(log.find((entry) => entry.sql?.includes('admin_user_invite_record')).params, [VIEWER, 'new-admin@example.test', 'admin_ops', 'new-admin-sub']);
  assert.deepEqual(lines.slice(-3), [`1: ${RECORD_EVENT_SQL}`, '1: COMMIT', '1: <release>']);
  assert.deepEqual(contexts(log), ['admin.admin_invite'], 'the audit context is set before the write');
  const [event] = recordedEvents(log);
  assert.deepEqual(
    [event.kind, event.outcome, event.surface, event.categories, event.record_type, event.record_ids, event.field_names],
    ['action', 'done', 'admin.admin_invite', ['admin_access'], 'admin_user', [NEW_ADMIN], ['role']],
  );
  assert.doesNotMatch(JSON.stringify(recordedEvents(log)), /new-admin@example|new-admin-sub/, 'no email or sign-in id in an event');
}

// invite retry: the user is already in the pool, still invited, with no row
// (the row write failed last time): the row is written and the group added.
{
  const { log } = world({
    definer: { admin_user_id: NEW_ADMIN, email: 'new-admin@example.test', role: 'admin_ops', active: true, created_at: CREATED },
    row: itemRow({ id: NEW_ADMIN, admin_email: 'new-admin@example.test', last_sign_in_at: null, trusted_browsers: 0 }),
    cognito: {
      AdminCreateUser: cognitoError('UsernameExistsException'),
      AdminGetUser: { UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: true, UserAttributes: [{ Name: 'sub', Value: 'new-admin-sub' }] },
    },
  });
  const outcome = await act(superadmin, { action: 'invite', requestId: ACTION_REQUEST, email: 'new-admin@example.test', role: 'admin_ops' });
  assert.equal(outcome.status, 200);
  assert.deepEqual(cognitoNames(log), ['cognito: <AdminCreateUser>', 'cognito: <AdminGetUser>', 'cognito: <AdminAddUserToGroup>']);
  assert.deepEqual(log.find((entry) => entry.sql?.includes('admin_user_invite_record')).params.at(-1), 'new-admin-sub');
}

// invite an address that already signed in somewhere in the pool: no row is
// written, already_exists, recorded as a failed attempt.
{
  const { log } = world({
    cognito: {
      AdminCreateUser: cognitoError('UsernameExistsException'),
      AdminGetUser: { UserStatus: 'CONFIRMED', Enabled: true, UserAttributes: [{ Name: 'sub', Value: 'someone' }] },
    },
  });
  const outcome = await act(superadmin, { action: 'invite', requestId: ACTION_REQUEST, email: 'taken@example.test', role: 'admin_ops' });
  assert.deepEqual(outcome, { status: 409, body: { ok: false, error: 'already_exists' } });
  assert.deepEqual(contexts(log), [], 'no action transaction');
  assert.deepEqual(sentInputs('AdminAddUserToGroup'), []);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome, event.surface], ['attempt', 'failed', 'admin.admin_invite']);
}

// invite an address an admin already has (any case): already_exists before
// the pool is asked, so no pool user is created and no email is sent.
{
  const { log } = world({ existing: true });
  const outcome = await act(superadmin, { action: 'invite', requestId: ACTION_REQUEST, email: 'Target-Admin@Example.Test', role: 'admin_ops' });
  assert.deepEqual(outcome, { status: 409, body: { ok: false, error: 'already_exists' } });
  assert.deepEqual(check.cognito.sent, [], 'no pool user and no invitation email');
  assert.deepEqual(log.find((entry) => entry.sql === INVITE_PRECHECK_SQL).params, ['target-admin@example.test']);
  assert.deepEqual(contexts(log), [], 'no action transaction');
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome, event.surface], ['attempt', 'failed', 'admin.admin_invite']);
}

// invite when the row appears between the check and the write: the definer
// refuses it.
{
  world({
    definer: dbError('admin_already_exists', '23505'),
    cognito: {
      AdminCreateUser: cognitoError('UsernameExistsException'),
      AdminGetUser: { UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: true, UserAttributes: [{ Name: 'sub', Value: 'new-admin-sub' }] },
    },
  });
  const outcome = await act(superadmin, { action: 'invite', requestId: ACTION_REQUEST, email: 'new-admin@example.test', role: 'admin_ops' });
  assert.deepEqual(outcome, { status: 409, body: { ok: false, error: 'already_exists' } });
}

// invite when the pool fails before the row: nothing saved.
for (const failing of ['AdminCreateUser', 'AdminAddUserToGroup']) {
  const { log } = world({
    cognito: {
      AdminCreateUser: failing === 'AdminCreateUser' ? cognitoError('InternalErrorException') : { User: { Attributes: [{ Name: 'sub', Value: 'x' }] } },
      AdminAddUserToGroup: failing === 'AdminAddUserToGroup' ? cognitoError('InternalErrorException') : {},
    },
  });
  const outcome = await act(superadmin, { action: 'invite', requestId: ACTION_REQUEST, email: 'new@example.test', role: 'admin_ops' });
  assert.deepEqual(outcome, { status: 502, body: { ok: false, error: 'directory_sync_failed', saved: false } }, failing);
  assert.deepEqual(contexts(log), [], `${failing}: no row`);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome, event.surface], ['attempt', 'failed', 'admin.admin_invite']);
}

// --- resend_invite --------------------------------------------------------------
{
  const { log } = world({
    row: itemRow({ last_sign_in_at: null, trusted_browsers: 0 }),
    cognito: { AdminGetUser: { UserStatus: 'FORCE_CHANGE_PASSWORD', Enabled: true, UserAttributes: [{ Name: 'sub', Value: 's' }] } },
  });
  const outcome = await act(superadmin, { action: 'resend_invite', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.admin.status, 'invited');
  // The pool user is looked up by its sign-in id; the invitation is sent
  // again by the address it was created with.
  assert.deepEqual(sentInputs('AdminGetUser'), [{ UserPoolId: POOL, Username: TARGET_SUB }]);
  assert.deepEqual(sentInputs('AdminCreateUser'), [{ UserPoolId: POOL, Username: TARGET_EMAIL, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }]);
  const lines = flow(log);
  assert.ok(lines.indexOf('cognito: <AdminGetUser>') < lines.indexOf('cognito: <AdminCreateUser>'));
  assert.deepEqual(contexts(log), ['admin.admin_resend_invite']);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome, event.surface, event.record_ids], ['action', 'done', 'admin.admin_resend_invite', [TARGET]]);
}
for (const status of ['CONFIRMED', undefined]) {
  const { log } = world({
    row: itemRow({ last_sign_in_at: null }),
    cognito: { AdminGetUser: status ? { UserStatus: status, Enabled: true, UserAttributes: [] } : cognitoError('UserNotFoundException') },
  });
  const outcome = await act(superadmin, { action: 'resend_invite', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.deepEqual(outcome, { status: 409, body: { ok: false, error: 'not_invited' } });
  assert.deepEqual(sentInputs('AdminCreateUser'), [], 'nothing is resent');
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome], ['attempt', 'failed']);
}
{
  world({ row: null });
  const outcome = await act(superadmin, { action: 'resend_invite', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.deepEqual(outcome, { status: 400, body: { ok: false, error: 'invalid_input' } });
}
// A row with no sign-in id was not created by an invitation: nothing to resend.
{
  world({ row: itemRow({ cognito_sub: null, last_sign_in_at: null }) });
  const outcome = await act(superadmin, { action: 'resend_invite', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.deepEqual(outcome, { status: 409, body: { ok: false, error: 'not_invited' } });
  assert.deepEqual(check.cognito.sent, []);
}

// --- change_role: row (guards) -> add the new group -> remove the others ---------
{
  const { log } = world({
    definer: { admin_user_id: TARGET, email: MIXED_EMAIL, role: 'admin_superadmin', active: true, created_at: CREATED },
    row: itemRow({ role: 'admin_superadmin', admin_email: MIXED_EMAIL }),
    cognito: { AdminListGroupsForUser: { Groups: [{ GroupName: 'admin_ops' }, { GroupName: 'admin_superadmin' }, { GroupName: 'other' }] } },
  });
  const outcome = await act(superadmin, { action: 'change_role', requestId: ACTION_REQUEST, adminUserId: TARGET, role: 'admin_superadmin' });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.admin.role, 'admin_superadmin');
  const lines = flow(log);
  const commit = lines.indexOf('1: COMMIT');
  assert.ok(commit > 0 && commit < lines.indexOf('cognito: <AdminAddUserToGroup>'), 'the row commits before the directory changes');
  assert.deepEqual(lines.filter((line) => line.startsWith('cognito')), [
    'cognito: <AdminAddUserToGroup>', 'cognito: <AdminListGroupsForUser>', 'cognito: <AdminRemoveUserFromGroup>',
  ]);
  // A stored email in another case still reaches the user: by its sign-in id.
  assert.deepEqual(sentInputs('AdminAddUserToGroup'), [{ UserPoolId: POOL, Username: TARGET_SUB, GroupName: 'admin_superadmin' }]);
  assert.deepEqual(sentInputs('AdminRemoveUserFromGroup'), [{ UserPoolId: POOL, Username: TARGET_SUB, GroupName: 'admin_ops' }]);
  assert.deepEqual(usernames(), [TARGET_SUB]);
  assert.deepEqual(log.find((entry) => entry.sql?.includes('admin_user_set_role')).params, [VIEWER, TARGET, 'admin_superadmin']);
  assert.deepEqual(contexts(log), ['admin.admin_role_change']);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.surface, event.record_ids, event.field_names], ['action', 'admin.admin_role_change', [TARGET], ['role']]);
}
// The guards are SQL's: refused, recorded as denied, and the directory untouched.
for (const [message, code, error] of [
  ['admin_last_superadmin', '55000', 'last_superadmin'],
  ['admin_self_change', '55000', 'self_change'],
  ['admin_forbidden', '42501', 'forbidden'],
]) {
  const { log } = world({ definer: dbError(message, code) });
  const outcome = await act(superadmin, { action: 'change_role', requestId: ACTION_REQUEST, adminUserId: TARGET, role: 'admin_ops' });
  assert.deepEqual(outcome, { status: error === 'forbidden' ? 403 : 409, body: { ok: false, error } });
  assert.deepEqual(check.cognito.sent, []);
  assert.ok(flow(log).includes('1: ROLLBACK'));
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.outcome, event.surface, event.record_ids], ['attempt', 'denied', 'admin.admin_role_change', [TARGET]]);
}
{
  world({ definer: dbError('admin_not_found', 'P0002') });
  const outcome = await act(superadmin, { action: 'change_role', requestId: ACTION_REQUEST, adminUserId: TARGET, role: 'admin_ops' });
  assert.deepEqual(outcome, { status: 400, body: { ok: false, error: 'invalid_input' } });
}
// The directory fails after the commit: saved, and a retry finishes it.
{
  const { log } = world({
    definer: { admin_user_id: TARGET, email: TARGET_EMAIL, role: 'admin_readonly', active: true, created_at: CREATED },
    row: itemRow({ role: 'admin_readonly' }),
    cognito: { AdminAddUserToGroup: cognitoError('InternalErrorException') },
  });
  const outcome = await act(superadmin, { action: 'change_role', requestId: ACTION_REQUEST, adminUserId: TARGET, role: 'admin_readonly' });
  assert.deepEqual(outcome, { status: 502, body: { ok: false, error: 'directory_sync_failed', saved: true } });
  assert.ok(flow(log).includes('1: COMMIT'), 'the role change stays saved');
  assert.deepEqual(recordedEvents(log).map((event) => [event.kind, event.outcome]), [['action', 'done'], ['attempt', 'failed']]);
}

// --- deactivate: row, sessions, trust -> sign-out -> forget devices -> disable ---
{
  const devicePages = [
    { Devices: [{ DeviceKey: 'check-region_device-1' }, { DeviceKey: 'check-region_device-2' }], PaginationToken: 'next' },
    { Devices: [{ DeviceKey: 'check-region_device-3' }] },
  ];
  const { log } = world({
    definer: { admin_user_id: TARGET, email: MIXED_EMAIL, role: 'admin_ops', active: false, created_at: CREATED },
    row: itemRow({ active: false, trusted_browsers: 0, admin_email: MIXED_EMAIL }),
    cognito: { AdminGetUser: ENABLED_USER, AdminListDevices: () => devicePages.shift() },
  });
  const outcome = await act(superadmin, { action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.admin.status, 'deactivated');
  const lines = flow(log);
  assert.deepEqual(lines.slice(0, 2), ['1: <connect>', '1: BEGIN']);
  assert.equal(lines[2], '1: SELECT * FROM public.admin_user_set_active($1, $2, $3)');
  assert.match(lines[3], /^1: WITH revoked AS/, 'sessions are revoked in the same transaction');
  assert.deepEqual(log.find((entry) => entry.sql?.startsWith('WITH revoked AS')).params, [TARGET, 'admin_deactivated']);
  assert.deepEqual(log.find((entry) => entry.sql?.includes('admin_user_set_active')).params, [VIEWER, TARGET, false]);
  // Disable last: sign-out and forgetting devices run on an enabled user.
  assert.deepEqual(lines.filter((line) => line.startsWith('cognito')), [
    'cognito: <AdminGetUser>', 'cognito: <AdminUserGlobalSignOut>',
    'cognito: <AdminListDevices>', 'cognito: <AdminListDevices>',
    'cognito: <AdminForgetDevice>', 'cognito: <AdminForgetDevice>', 'cognito: <AdminForgetDevice>',
    'cognito: <AdminDisableUser>',
  ]);
  assert.ok(lines.indexOf('1: COMMIT') < lines.indexOf('cognito: <AdminGetUser>'));
  assert.deepEqual(usernames(), [TARGET_SUB], 'every call names the user by its sign-in id');
  assert.deepEqual(sentInputs('AdminForgetDevice').map((input) => input.DeviceKey), [
    'check-region_device-1', 'check-region_device-2', 'check-region_device-3',
  ]);
  assert.deepEqual(sentInputs('AdminListDevices').map((input) => input.PaginationToken), [undefined, 'next']);
  assert.deepEqual(contexts(log), ['admin.admin_deactivate']);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.surface, event.record_ids, event.field_names], ['action', 'admin.admin_deactivate', [TARGET], ['active']]);
}
// Cognito fails after the commit: saved; a retry runs the (now no-op) row
// change again and finishes the directory.
{
  let fail = true;
  const { log } = world({
    definer: { admin_user_id: TARGET, email: TARGET_EMAIL, role: 'admin_ops', active: false, created_at: CREATED },
    row: itemRow({ active: false }),
    cognito: {
      AdminGetUser: ENABLED_USER,
      AdminUserGlobalSignOut: () => (fail ? cognitoError('InternalErrorException') : {}),
      AdminListDevices: { Devices: [] },
    },
  });
  const first = await act(superadmin, { action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.deepEqual(first, { status: 502, body: { ok: false, error: 'directory_sync_failed', saved: true } });
  fail = false;
  const second = await act(superadmin, { action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.equal(second.status, 200);
  assert.deepEqual(cognitoNames(log), [
    'cognito: <AdminGetUser>', 'cognito: <AdminUserGlobalSignOut>',
    'cognito: <AdminGetUser>', 'cognito: <AdminUserGlobalSignOut>', 'cognito: <AdminListDevices>', 'cognito: <AdminDisableUser>',
  ]);
}
// A retry after a lost answer: the pool already has the user disabled, which
// is the last step, so every step ran; nothing more is sent.
{
  const { log } = world({
    definer: { admin_user_id: TARGET, email: TARGET_EMAIL, role: 'admin_ops', active: false, created_at: CREATED },
    row: itemRow({ active: false }),
    cognito: { AdminGetUser: DISABLED_USER },
  });
  const outcome = await act(superadmin, { action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.equal(outcome.status, 200);
  assert.deepEqual(cognitoNames(log), ['cognito: <AdminGetUser>']);
  assert.deepEqual(sentInputs('AdminGetUser'), [{ UserPoolId: POOL, Username: TARGET_SUB }]);
}
// No pool user by that sign-in id (or no sign-in id on the row): the pool has
// no account to close, and a sign-in is matched by that id, so nothing can
// sign in as this admin; the row change stands and the answer is a success.
for (const [row, cognito, expected] of [
  [itemRow({ active: false }), { AdminGetUser: cognitoError('UserNotFoundException') }, ['cognito: <AdminGetUser>']],
  [itemRow({ active: false, cognito_sub: null }), {}, []],
]) {
  const { log } = world({
    definer: { admin_user_id: TARGET, email: TARGET_EMAIL, role: 'admin_ops', active: false, created_at: CREATED },
    row,
    cognito,
  });
  const outcome = await act(superadmin, { action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.equal(outcome.status, 200);
  assert.deepEqual(cognitoNames(log), expected);
  assert.ok(flow(log).includes('1: COMMIT'));
}
{
  const { log } = world({ definer: dbError('admin_last_superadmin', '55000') });
  const outcome = await act(superadmin, { action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.deepEqual(outcome, { status: 409, body: { ok: false, error: 'last_superadmin' } });
  assert.deepEqual(check.cognito.sent, []);
  assert.equal(log.filter((entry) => entry.sql?.startsWith('WITH revoked AS')).length, 0);
}

// --- reactivate: enable -> group sync -> row ------------------------------------
{
  const { log } = world({
    definer: { admin_user_id: TARGET, email: MIXED_EMAIL, role: 'admin_ops', active: true, created_at: CREATED },
    row: itemRow({ active: false, admin_email: MIXED_EMAIL }),
    cognito: { AdminListGroupsForUser: { Groups: [{ GroupName: 'admin_ops' }, { GroupName: 'admin_readonly' }] } },
  });
  const outcome = await act(superadmin, { action: 'reactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.equal(outcome.status, 200);
  const lines = flow(log);
  const cognitoLines = lines.filter((line) => line.startsWith('cognito'));
  assert.deepEqual(cognitoLines, [
    'cognito: <AdminEnableUser>', 'cognito: <AdminAddUserToGroup>', 'cognito: <AdminListGroupsForUser>', 'cognito: <AdminRemoveUserFromGroup>',
  ]);
  assert.ok(lines.indexOf('cognito: <AdminRemoveUserFromGroup>') < lines.indexOf('1: BEGIN'), 'the directory first, then the row');
  assert.deepEqual(sentInputs('AdminAddUserToGroup').map((input) => input.GroupName), ['admin_ops']);
  assert.deepEqual(sentInputs('AdminRemoveUserFromGroup').map((input) => input.GroupName), ['admin_readonly']);
  assert.deepEqual(usernames(), [TARGET_SUB]);
  assert.deepEqual(log.find((entry) => entry.sql?.includes('admin_user_set_active')).params, [VIEWER, TARGET, true]);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.kind, event.surface, event.field_names], ['action', 'admin.admin_reactivate', ['active']]);
}
{
  const { log } = world({ row: itemRow({ active: false }), cognito: { AdminEnableUser: cognitoError('InternalErrorException') } });
  const outcome = await act(superadmin, { action: 'reactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.deepEqual(outcome, { status: 502, body: { ok: false, error: 'directory_sync_failed', saved: false } });
  assert.deepEqual(contexts(log), [], 'no row change');
}
{
  world({ row: itemRow({ id: VIEWER, active: false }) });
  const outcome = await act(superadmin, { action: 'reactivate', requestId: ACTION_REQUEST, adminUserId: VIEWER });
  assert.deepEqual(outcome, { status: 409, body: { ok: false, error: 'self_change' } });
  assert.deepEqual(check.cognito.sent, []);
}

// A row with no sign-in id has no pool user to reach (a sign-in is matched by
// that id, so nothing can sign in as it): the row changes, the pool is not
// called.
for (const [body, definer] of [
  [{ action: 'change_role', requestId: ACTION_REQUEST, adminUserId: TARGET, role: 'admin_readonly' }, { admin_user_id: TARGET, email: TARGET_EMAIL, role: 'admin_readonly', active: true, created_at: CREATED }],
  [{ action: 'reactivate', requestId: ACTION_REQUEST, adminUserId: TARGET }, { admin_user_id: TARGET, email: TARGET_EMAIL, role: 'admin_ops', active: true, created_at: CREATED }],
]) {
  const { log } = world({ definer, row: itemRow({ cognito_sub: null, active: body.action !== 'reactivate' }) });
  const outcome = await act(superadmin, body);
  assert.equal(outcome.status, 200, body.action);
  assert.deepEqual(check.cognito.sent, [], `${body.action}: no pool call`);
  assert.ok(flow(log).includes('1: COMMIT'));
}

// --- The route: K1.3 session answers, the payload hash, then the action's answer --
// Every action body carries its SHA-256 in x-amz-content-sha256
// (lib/admin-fetch.ts), checked as the Inbox actions check it: a missing,
// malformed or wrong hash is 400 invalid_input before the action runs.
{
  const COOKIE = 'jale_admin_id_token_v2';
  const sessionRow = (role, overrides = {}) => ({
    session_id: SESSION_ID, admin_user_id: VIEWER, cognito_sub: 'check-admin-sub', admin_email: 'viewer-admin@example.test',
    role, expires_at: new Date(Date.now() + 600_000), active: true, ...overrides,
  });
  let routeLog = [];
  const routeWorld = (row) => {
    const { pool, log } = createFakePool({
      respond: ({ sql }) => {
        if (sql.includes('FROM admin_sessions s')) return { rows: row ? [row] : [] };
        if (sql.startsWith("UPDATE admin_sessions SET revoked_at = NOW(), revoke_reason = 'expired'")) return { rows: [{ id: SESSION_ID }] };
        return {};
      },
    });
    check.pool = pool;
    check.cognito = { clients: [], sent: [], behavior: undefined, onSend: undefined };
    routeLog = log;
  };
  const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  // `hash`: 'auto' sends the body's own hash, a string sends that, null none.
  const post = (body, { hash = 'auto' } = {}) => {
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/json' };
    if (hash === 'auto') headers['x-amz-content-sha256'] = sha256(text);
    else if (hash) headers['x-amz-content-sha256'] = hash;
    return route.POST(new Request('https://admin.example.test/api/admin-users', { method: 'POST', headers, body: text }));
  };
  const bodyOf = async (response) => (typeof response.json === 'function' ? response.json() : response.body);
  // What ran after the session read: the action's own statements and events.
  const actionStatements = () => statements(routeLog).filter((line) => !line.includes('admin_sessions'));

  // The session is checked first: no header is needed to learn it has ended.
  check.cookies = new Map();
  routeWorld(null);
  let response = await post({}, { hash: null });
  assert.deepEqual([response.status, await bodyOf(response)], [401, { error: 'unauthorized' }]);

  check.cookies = new Map([[COOKIE, 'raw-session-token']]);
  routeWorld(sessionRow('admin_superadmin', { active: false, expires_at: new Date(Date.now() - 1000) }));
  response = await post({}, { hash: null });
  assert.deepEqual([response.status, await bodyOf(response)], [401, { error: 'session_expired' }]);

  routeWorld(sessionRow('admin_ops'));
  response = await post({ action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET });
  assert.deepEqual([response.status, await bodyOf(response)], [403, { ok: false, error: 'forbidden' }]);

  routeWorld(sessionRow('admin_superadmin'));
  response = await post({ action: 'deactivate', requestId: ACTION_REQUEST });
  assert.deepEqual([response.status, await bodyOf(response)], [400, { ok: false, error: 'invalid_input' }]);

  // A missing, malformed or wrong hash: 400 before the action, whatever the
  // role, with nothing run or recorded and the directory untouched.
  const deactivate = { action: 'deactivate', requestId: ACTION_REQUEST, adminUserId: TARGET };
  for (const role of ['admin_superadmin', 'admin_ops']) {
    for (const hash of [null, 'not-a-hash', sha256(JSON.stringify({ action: 'reactivate' })), ` ${'f'.repeat(64)}`]) {
      routeWorld(sessionRow(role));
      response = await post(deactivate, { hash });
      assert.deepEqual([response.status, await bodyOf(response)], [400, { ok: false, error: 'invalid_input' }], `${role}, hash ${hash}`);
      assert.deepEqual(actionStatements(), [], `${role}, hash ${hash}: nothing runs`);
      assert.deepEqual(check.cognito.sent, [], `${role}, hash ${hash}: no pool call`);
    }
  }

  // The hash is compared as hex, in either case and with surrounding space:
  // the action is reached (an Ops admin is refused by the action itself).
  routeWorld(sessionRow('admin_ops'));
  response = await post(deactivate, { hash: ` ${sha256(JSON.stringify(deactivate)).toUpperCase()} ` });
  assert.deepEqual([response.status, await bodyOf(response)], [403, { ok: false, error: 'forbidden' }]);
  assert.deepEqual(recordedEvents(routeLog).map((event) => [event.kind, event.outcome]), [['attempt', 'denied']]);

  // A body over the action limit is refused unread, like the Inbox actions'.
  routeWorld(sessionRow('admin_superadmin'));
  const oversized = { ...deactivate, padding: 'x'.repeat(16_384) };
  response = await post(oversized);
  assert.deepEqual([response.status, await bodyOf(response)], [400, { ok: false, error: 'invalid_input' }]);
  assert.deepEqual(actionStatements(), []);
}

console.log('admin users checks passed');
