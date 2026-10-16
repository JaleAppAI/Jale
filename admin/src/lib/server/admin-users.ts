/**
 * Contract K1.5 (sprint 28): the Admins page (superadmin only). BE-1 owns
 * this module; FE-3 renders against it.
 *
 * Reads go through withAdminReadTransaction + recordAdminAccess. Each action
 * sets the audit context and records itself inside its own transaction, and
 * a refusal or failure records an attempt afterwards. The guards (never zero
 * active superadmins, never a change to oneself, superadmins only) are
 * decided in SQL by migration 120's definers, under row locks, so two
 * concurrent changes cannot both pass them.
 *
 * The admin pool (Cognito) changes in BE-1 §4.4's order:
 *   invite       create (sends the invitation) -> add group -> row
 *   resend       the user must still be FORCE_CHANGE_PASSWORD -> resend
 *   change role  row -> add the new group -> remove the other admin groups
 *   deactivate   row (inactive, sessions revoked, trusted browsers ended) ->
 *                global sign-out -> forget every device -> disable (last, so
 *                every call before it acts on an enabled user)
 *   reactivate   enable -> group sync -> row
 * A Cognito failure after the row commits answers directory_sync_failed with
 * saved: true; before it, saved: false. Every step repeats safely, so a retry
 * finishes the job: an invite whose user is already in the pool, still
 * invited, with no row, writes the row (the repair path); a deactivation
 * whose pool user is already disabled was finished by an earlier attempt.
 *
 * Every call on an existing admin names the pool user by its sign-in id
 * (admin_users.cognito_sub), which Cognito accepts as the username. The
 * stored email is never used for that: the pool's usernames are
 * case-sensitive and an admin added by hand may be stored in another case.
 * The email names the user only when the invitation is created or sent again
 * (rows written by an invite are lower case on both sides). A row with no
 * sign-in id has no pool user to reach, and nothing can sign in as it (a
 * sign-in is matched by that id), so its pool steps are skipped.
 */
import type { PoolClient } from 'pg';
import type { AdminRole } from '../types';
import { AdminSessionStore } from './admin-session-store';
import { isUuid } from './audit/codes';
import { setAdminAuditContext } from './audit/context';
import {
  recordAdminAccess,
  recordAdminAction,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AdminAuditEvent,
  type AdminSurface,
  type AttemptOutcome,
} from './audit/record';
import { directoryErrorName, getAdminDirectory, type AdminDirectory } from './cognito-admin';
import { getAdminDbPool } from './db';
import { forgetAllDevices } from './device-trust';
import type { AdminSession } from './session-claims';

export type { AdminRole };

export type AdminListItem = {
  id: string;                       // admin_users.id
  email: string;
  role: AdminRole;
  status: 'invited' | 'active' | 'deactivated';  // invited = active and never signed in
  lastSignInAt: string | null;      // ISO, latest session start
  trustedBrowsers: number;          // live trust records
  createdAt: string;                // ISO
  isSelf: boolean;
  canResendInvite: boolean;         // status === 'invited'
};

export type AdminsPageResult =
  | { status: 'ok'; viewerId: string; admins: AdminListItem[] }   // active first, then invited, then deactivated; email order within
  | { status: 'forbidden' };

export type AdminUserAction =
  | { action: 'invite'; requestId: string; email: string; role: AdminRole }
  | { action: 'resend_invite'; requestId: string; adminUserId: string }
  | { action: 'change_role'; requestId: string; adminUserId: string; role: AdminRole }
  | { action: 'deactivate'; requestId: string; adminUserId: string }
  | { action: 'reactivate'; requestId: string; adminUserId: string };

export type AdminUserActionResult =
  | { ok: true; admin: AdminListItem }
  | { ok: false; error: AdminUserActionError; saved?: boolean };

export type AdminUserActionError =
  | 'invalid_input' | 'unauthorized' | 'session_expired' | 'forbidden'
  | 'last_superadmin' | 'self_change' | 'already_exists' | 'not_invited' | 'directory_sync_failed';

/** An action's HTTP status and body (K1.5's table). */
export type AdminUserActionResponse = { status: number; body: AdminUserActionResult };

const ADMIN_ROLES: readonly AdminRole[] = ['admin_readonly', 'admin_ops', 'admin_superadmin'];

const SURFACES: Record<AdminUserAction['action'], AdminSurface> = {
  invite: 'admin.admin_invite',
  resend_invite: 'admin.admin_resend_invite',
  change_role: 'admin.admin_role_change',
  deactivate: 'admin.admin_deactivate',
  reactivate: 'admin.admin_reactivate',
};

/** The field each action changes (names only, never values). */
const FIELD_NAMES: Record<AdminUserAction['action'], readonly string[]> = {
  invite: ['role'],
  resend_invite: [],
  change_role: ['role'],
  deactivate: ['active'],
  reactivate: ['active'],
};

const HTTP_STATUS: Record<AdminUserActionError, number> = {
  invalid_input: 400,
  unauthorized: 401,
  session_expired: 401,
  forbidden: 403,
  last_superadmin: 409,
  self_change: 409,
  already_exists: 409,
  not_invited: 409,
  directory_sync_failed: 502,
};

/** Migration 120's errors (the message is the code), and what each answers. */
const DEFINER_ERRORS: Record<string, { error: AdminUserActionError; outcome: AttemptOutcome }> = {
  admin_invalid_input: { error: 'invalid_input', outcome: 'failed' },
  admin_not_found: { error: 'invalid_input', outcome: 'not_found' },
  admin_forbidden: { error: 'forbidden', outcome: 'denied' },
  admin_self_change: { error: 'self_change', outcome: 'denied' },
  admin_last_superadmin: { error: 'last_superadmin', outcome: 'denied' },
  admin_already_exists: { error: 'already_exists', outcome: 'failed' },
};

/** Cognito's status for an invited user who has not signed in yet. */
const INVITED_STATUS = 'FORCE_CHANGE_PASSWORD';

type AdminItemRow = {
  id: string;
  admin_email: string;
  cognito_sub: string | null;
  role: AdminRole;
  active: boolean;
  created_at: Date;
  last_sign_in_at: Date | null;
  trusted_browsers: number | string;
};

// Every admin with the latest session start and the live trusted browsers
// (not ended, inside their 7 days). Active first, then invited (never signed
// in), then deactivated; email order within.
const ADMIN_ITEMS_SQL = `SELECT u.id, u.admin_email, u.role, u.active, u.created_at, u.cognito_sub,
       s.last_sign_in_at,
       COALESCE(d.trusted_browsers, 0)::int AS trusted_browsers
  FROM admin_users u
  LEFT JOIN LATERAL (
    SELECT max(x.created_at) AS last_sign_in_at
      FROM admin_sessions x
     WHERE x.admin_user_id = u.id
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS trusted_browsers
      FROM admin_trusted_devices d
     WHERE d.admin_user_id = u.id AND d.ended_at IS NULL AND d.expires_at > now()
  ) d ON true`;
const ADMIN_ITEMS_ORDER = 'ORDER BY CASE WHEN NOT u.active THEN 2 WHEN s.last_sign_in_at IS NULL THEN 1 ELSE 0 END, u.admin_email, u.id';

function toItem(row: AdminItemRow, viewerId: string | undefined): AdminListItem {
  const status: AdminListItem['status'] = !row.active
    ? 'deactivated'
    : row.last_sign_in_at === null ? 'invited' : 'active';
  return {
    id: row.id,
    email: row.admin_email,
    role: row.role,
    status,
    lastSignInAt: row.last_sign_in_at === null ? null : new Date(row.last_sign_in_at).toISOString(),
    trustedBrowsers: Number(row.trusted_browsers),
    createdAt: new Date(row.created_at).toISOString(),
    isSelf: row.id === viewerId,
    canResendInvite: status === 'invited',
  };
}

type Queryable = {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

/**
 * An admin as an action needs it: the list item, and the pool username (the
 * sign-in id; undefined when the row has none). The sign-in id never leaves
 * the server.
 */
type AdminTarget = { item: AdminListItem; username: string | undefined };

async function loadTarget(db: Queryable, adminUserId: string, viewerId: string | undefined): Promise<AdminTarget | undefined> {
  const { rows } = await db.query<AdminItemRow>(`${ADMIN_ITEMS_SQL}\n WHERE u.id = $1`, [adminUserId]);
  const row = rows[0];
  if (!row) return undefined;
  return { item: toItem(row, viewerId), username: row.cognito_sub?.trim() || undefined };
}

async function loadItem(db: Queryable, adminUserId: string, viewerId: string | undefined): Promise<AdminListItem | undefined> {
  return (await loadTarget(db, adminUserId, viewerId))?.item;
}

function listEvent(recordIds: readonly string[] = []): AdminAuditEvent {
  return {
    surface: 'admin.admins_list',
    categories: ['admin_access'],
    ...(recordIds.length > 0 ? { recordType: 'admin_user' as const, recordIds } : {}),
  };
}

/** The Admins page's list. Superadmins only; the read is recorded. */
export async function loadAdmins(session: AdminSession): Promise<AdminsPageResult> {
  if (session.role !== 'admin_superadmin') {
    await recordAdminAttempt(session, { ...listEvent(), outcome: 'denied' });
    return { status: 'forbidden' };
  }

  const admins = await withAdminReadTransaction(session, async (client) => {
    const { rows } = await client.query<AdminItemRow>(`${ADMIN_ITEMS_SQL}\n ${ADMIN_ITEMS_ORDER}`);
    const items = rows.map((row) => toItem(row, session.adminUserId));
    await recordAdminAccess(session, listEvent(items.map((item) => item.id)), client);
    return items;
  });

  return { status: 'ok', viewerId: session.adminUserId ?? '', admins };
}

// --- Input ----------------------------------------------------------------------
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIONS = new Set<string>(Object.keys(SURFACES));

function isRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

function parseAction(input: unknown): AdminUserAction | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const body = input as Record<string, unknown>;
  const { action, requestId } = body;
  if (typeof action !== 'string' || !ACTIONS.has(action) || !isUuid(requestId)) return undefined;

  if (action === 'invite') {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL_PATTERN.test(email) || !isRole(body.role)) return undefined;
    return { action, requestId, email, role: body.role };
  }
  const adminUserId = typeof body.adminUserId === 'string' ? body.adminUserId.trim().toLowerCase() : '';
  if (!isUuid(adminUserId)) return undefined;
  if (action === 'change_role') {
    return isRole(body.role) ? { action, requestId, adminUserId, role: body.role } : undefined;
  }
  return { action: action as 'resend_invite' | 'deactivate' | 'reactivate', requestId, adminUserId };
}

// --- Answers ----------------------------------------------------------------------
function refused(error: AdminUserActionError, saved?: boolean): AdminUserActionResponse {
  return {
    status: HTTP_STATUS[error],
    body: { ok: false, error, ...(saved === undefined ? {} : { saved }) },
  };
}

function done(admin: AdminListItem): AdminUserActionResponse {
  return { status: 200, body: { ok: true, admin } };
}

class ActionRefused extends Error {
  constructor(readonly error: AdminUserActionError, readonly outcome: AttemptOutcome) {
    super(error);
  }
}

function definerRefusal(error: unknown): ActionRefused | undefined {
  const message = error instanceof Error ? error.message : undefined;
  const mapped = message ? DEFINER_ERRORS[message] : undefined;
  return mapped ? new ActionRefused(mapped.error, mapped.outcome) : undefined;
}

function actionEvent(action: AdminUserAction, targetId?: string): AdminAuditEvent {
  return {
    surface: SURFACES[action.action],
    categories: ['admin_access'],
    ...(targetId ? { recordType: 'admin_user' as const, recordIds: [targetId] } : {}),
    fieldNames: FIELD_NAMES[action.action],
  };
}

/**
 * One action's transaction: BEGIN -> audit context -> the change -> the
 * action event -> COMMIT. Anything thrown rolls it back and is rethrown after
 * the connection is released.
 */
async function inActionTransaction<T>(
  session: AdminSession,
  action: AdminUserAction,
  change: (client: PoolClient) => Promise<{ value: T; targetId: string }>,
): Promise<T> {
  const pool = await getAdminDbPool();
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await setAdminAuditContext(client, session, SURFACES[action.action]);
    const { value, targetId } = await change(client);
    await recordAdminAction(session, actionEvent(action, targetId), client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Sets the user's admin group to `role`: add it first, then remove the other admin groups. */
async function syncGroups(directory: AdminDirectory, username: string, role: AdminRole): Promise<void> {
  await directory.addToGroup(username, role);
  const groups = await directory.listGroups(username);
  for (const group of ADMIN_ROLES) {
    if (group !== role && groups.includes(group)) {
      await directory.removeFromGroup(username, group);
    }
  }
}

/**
 * Runs a directory step; a Cognito failure becomes directory_sync_failed
 * (saved or not by the action's order, ROW_FIRST).
 */
async function directoryStep(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    throw new ActionRefused('directory_sync_failed', 'failed');
  }
}

async function targetRow(adminUserId: string, viewerId: string | undefined): Promise<AdminTarget> {
  const pool = await getAdminDbPool();
  const target = await loadTarget(pool, adminUserId, viewerId);
  if (!target) throw new ActionRefused('invalid_input', 'not_found');
  return target;
}

/**
 * Closes a deactivated admin's pool account: global sign-out, forget every
 * remembered device, then disable. Disable comes last, so the two calls
 * before it always act on an enabled user, and a user the pool already has
 * disabled means an earlier attempt finished every step. No pool user by
 * this sign-in id leaves nothing to close.
 */
async function closePoolAccount(directory: AdminDirectory, username: string): Promise<void> {
  const user = await directory.getUser(username);
  if (!user || !user.enabled) return;
  await directory.globalSignOut(username);
  await forgetAllDevices(directory, username);
  await directory.disableUser(username);
}

// --- Actions ----------------------------------------------------------------------
const INVITE_PRECHECK_SQL = 'SELECT id FROM admin_users WHERE lower(admin_email) = $1';

async function invite(
  session: AdminSession,
  action: Extract<AdminUserAction, { action: 'invite' }>,
  directory: AdminDirectory,
): Promise<AdminListItem> {
  // An address an admin already has (in any case) is refused before the pool
  // is asked, so no pool user is created and no invitation is sent for it.
  // The definer still decides it under its lock if two invites race.
  const pool = await getAdminDbPool();
  const { rows: existing } = await pool.query<{ id: string }>(INVITE_PRECHECK_SQL, [action.email]);
  if (existing.length > 0) throw new ActionRefused('already_exists', 'failed');

  let sub: string;
  try {
    ({ sub } = await directory.createUser(action.email));
  } catch (error) {
    if (directoryErrorName(error) !== 'UsernameExistsException') {
      throw new ActionRefused('directory_sync_failed', 'failed');
    }
    // Already in the pool: an earlier invite whose row was never written is
    // finished here; anyone else already has an account.
    let existing;
    try {
      existing = await directory.getUser(action.email);
    } catch {
      throw new ActionRefused('directory_sync_failed', 'failed');
    }
    if (!existing || existing.status !== INVITED_STATUS || !existing.sub) {
      throw new ActionRefused('already_exists', 'failed');
    }
    sub = existing.sub;
  }
  await directoryStep(() => directory.addToGroup(action.email, action.role));

  return inActionTransaction(session, action, async (client) => {
    const { rows } = await client.query<{ admin_user_id: string }>(
      'SELECT * FROM public.admin_user_invite_record($1, $2, $3, $4)',
      [session.adminUserId, action.email, action.role, sub],
    );
    const id = rows[0]?.admin_user_id;
    const item = id ? await loadItem(client, id, session.adminUserId) : undefined;
    if (!id || !item) throw new Error('The invited admin could not be read back');
    return { value: item, targetId: id };
  });
}

async function resendInvite(
  session: AdminSession,
  action: Extract<AdminUserAction, { action: 'resend_invite' }>,
  directory: AdminDirectory,
): Promise<AdminListItem> {
  const { item: target, username } = await targetRow(action.adminUserId, session.adminUserId);
  // Only a row an invite wrote has a pool user still waiting to sign in.
  if (target.status === 'deactivated' || !username) throw new ActionRefused('not_invited', 'failed');
  let user;
  try {
    user = await directory.getUser(username);
  } catch {
    throw new ActionRefused('directory_sync_failed', 'failed');
  }
  if (!user || user.status !== INVITED_STATUS) throw new ActionRefused('not_invited', 'failed');
  await directoryStep(() => directory.resendInvitation(target.email));

  return inActionTransaction(session, action, async () => ({ value: target, targetId: target.id }));
}

async function changeRole(
  session: AdminSession,
  action: Extract<AdminUserAction, { action: 'change_role' }>,
  directory: AdminDirectory,
): Promise<AdminListItem> {
  const { item, username } = await inActionTransaction(session, action, async (client) => {
    await client.query(
      'SELECT * FROM public.admin_user_set_role($1, $2, $3)',
      [session.adminUserId, action.adminUserId, action.role],
    );
    const changed = await loadTarget(client, action.adminUserId, session.adminUserId);
    if (!changed) throw new Error('The admin could not be read back');
    return { value: changed, targetId: action.adminUserId };
  });
  if (username) {
    await directoryStep(() => syncGroups(directory, username, action.role));
  }
  return item;
}

async function deactivate(
  session: AdminSession,
  action: Extract<AdminUserAction, { action: 'deactivate' }>,
  directory: AdminDirectory,
): Promise<AdminListItem> {
  const { item, username } = await inActionTransaction(session, action, async (client) => {
    await client.query(
      'SELECT * FROM public.admin_user_set_active($1, $2, $3)',
      [session.adminUserId, action.adminUserId, false],
    );
    // Every live session ends now (the next request would refuse them anyway,
    // as the account is inactive); the revocation is on record.
    await new AdminSessionStore(client).revokeAllForAdmin(action.adminUserId, 'admin_deactivated');
    const changed = await loadTarget(client, action.adminUserId, session.adminUserId);
    if (!changed) throw new Error('The admin could not be read back');
    return { value: changed, targetId: action.adminUserId };
  });
  // The trusted browsers ended in the row change; the pool forgets them too,
  // since a global sign-out leaves remembered devices remembered.
  if (username) {
    await directoryStep(() => closePoolAccount(directory, username));
  }
  return item;
}

async function reactivate(
  session: AdminSession,
  action: Extract<AdminUserAction, { action: 'reactivate' }>,
  directory: AdminDirectory,
): Promise<AdminListItem> {
  if (action.adminUserId === session.adminUserId) throw new ActionRefused('self_change', 'denied');
  const { item: target, username } = await targetRow(action.adminUserId, session.adminUserId);
  if (username) {
    await directoryStep(async () => {
      await directory.enableUser(username);
      await syncGroups(directory, username, target.role);
    });
  }

  return inActionTransaction(session, action, async (client) => {
    await client.query(
      'SELECT * FROM public.admin_user_set_active($1, $2, $3)',
      [session.adminUserId, action.adminUserId, true],
    );
    const changed = await loadItem(client, action.adminUserId, session.adminUserId);
    if (!changed) throw new Error('The admin could not be read back');
    return { value: changed, targetId: action.adminUserId };
  });
}

/** Whether the row change of this action is already committed when its directory step runs. */
const ROW_FIRST: Record<AdminUserAction['action'], boolean> = {
  invite: false,
  resend_invite: false,
  change_role: true,
  deactivate: true,
  reactivate: false,
};

/**
 * Runs one Admins page action for the signed-in admin (POST /api/admin-users).
 * The caller has already answered a missing or ended session (K1.3).
 */
export async function runAdminUserAction(
  session: AdminSession,
  input: unknown,
  directory: AdminDirectory = getAdminDirectory(),
): Promise<AdminUserActionResponse> {
  const kind = input && typeof input === 'object' ? (input as Record<string, unknown>).action : undefined;
  if (typeof kind !== 'string' || !ACTIONS.has(kind)) {
    return refused('invalid_input');
  }
  const surface = SURFACES[kind as AdminUserAction['action']];
  if (session.role !== 'admin_superadmin' || session.preview === true) {
    await recordAdminAttempt(session, { surface, categories: ['admin_access'], outcome: 'denied' });
    return refused('forbidden');
  }
  const action = parseAction(input);
  if (!action) {
    return refused('invalid_input');
  }
  const targetId = 'adminUserId' in action ? action.adminUserId : undefined;

  try {
    switch (action.action) {
      case 'invite':
        return done(await invite(session, action, directory));
      case 'resend_invite':
        return done(await resendInvite(session, action, directory));
      case 'change_role':
        return done(await changeRole(session, action, directory));
      case 'deactivate':
        return done(await deactivate(session, action, directory));
      case 'reactivate':
        return done(await reactivate(session, action, directory));
      default:
        throw new Error('unknown admin action');
    }
  } catch (error) {
    const refusal = error instanceof ActionRefused ? error : definerRefusal(error);
    await recordAdminAttempt(session, {
      ...actionEvent(action, targetId),
      fieldNames: [],
      outcome: refusal?.outcome ?? 'failed',
    });
    if (!refusal) throw error;
    return refusal.error === 'directory_sync_failed'
      ? refused('directory_sync_failed', ROW_FIRST[action.action])
      : refused(refusal.error);
  }
}
