// The Admins page's decisions as plain functions (K1.5): which actions a row
// offers, what each answer from POST /api/admin-users says, and which request
// id a retry carries. The page's components and use-admin-action.ts call
// these; scripts/check-ui-admins-view.mjs checks them. Types only from the
// server module: nothing server-side reaches the browser.
import type {
  AdminListItem,
  AdminRole,
  AdminUserAction,
  AdminUserActionError,
} from '@/lib/server/admin-users';

// --- Rows ----------------------------------------------------------------------

export type AdminRowAction = 'resend_invite' | 'change_role' | 'deactivate' | 'reactivate';

export const ROW_ACTION_LABELS: Readonly<Record<AdminRowAction, string>> = {
  resend_invite: 'Resend invite',
  change_role: 'Change role',
  deactivate: 'Deactivate',
  reactivate: 'Reactivate',
};

/** The viewer's own row offers nothing; an invite offers a resend only. */
export function rowActions(admin: AdminListItem): AdminRowAction[] {
  if (admin.isSelf) return [];
  if (admin.status === 'invited') return admin.canResendInvite ? ['resend_invite'] : [];
  if (admin.status === 'active') return ['change_role', 'deactivate'];
  return ['change_role', 'reactivate'];
}

export const ADMIN_STATUS_LABELS: Readonly<Record<AdminListItem['status'], string>> = {
  invited: 'Invited',
  active: 'Active',
  deactivated: 'Deactivated',
};

/** Badge tones for each status (a subset of the Badge primitive's tones). */
export const ADMIN_STATUS_TONES: Readonly<Record<AdminListItem['status'], 'info' | 'success' | 'neutral'>> = {
  invited: 'info',
  active: 'success',
  deactivated: 'neutral',
};

// --- Roles and copy ------------------------------------------------------------------

export const ROLE_OPTIONS: readonly { role: AdminRole; title: string; description: string }[] = [
  { role: 'admin_readonly', title: 'Read-only', description: 'Sees everything, changes nothing' },
  { role: 'admin_ops', title: 'Ops', description: 'Works the Inbox: replies, resets, reports' },
  { role: 'admin_superadmin', title: 'Superadmin', description: 'Also manages admins and sees Security' },
];

/** The prototype's invite dialog starts on Ops. */
export const DEFAULT_INVITE_ROLE: AdminRole = 'admin_ops';

export const INVITE_NOTE =
  'They get a Jale-branded email with a temporary password, valid for 7 days. On first sign-in they set their own password and an authenticator app.';
export const CHANGE_ROLE_NOTE = 'The new role applies from their next page load. This is logged.';
export const FOOTNOTE = "There is always at least one active superadmin. You can't deactivate or demote yourself.";

const DEACTIVATE_BODY =
  "They are signed out everywhere right away, their trusted browsers are forgotten, and they can't sign in again until a superadmin reactivates them. This is logged.";
const REACTIVATE_BODY =
  'They can sign in again with their password and authenticator app. They start with no trusted browsers. This is logged.';

export function deactivateCopy(email: string): { title: string; body: string; confirmLabel: string } {
  return { title: `Deactivate ${email}?`, body: DEACTIVATE_BODY, confirmLabel: 'Deactivate' };
}

export function reactivateCopy(email: string): { title: string; body: string; confirmLabel: string } {
  return { title: `Reactivate ${email}?`, body: REACTIVATE_BODY, confirmLabel: 'Reactivate' };
}

export function changeRoleTitle(email: string): string {
  return `Change role for ${email}`;
}

function roleTitle(role: AdminRole): string {
  return ROLE_OPTIONS.find((option) => option.role === role)?.title ?? role;
}

// --- Answers -----------------------------------------------------------------------

type CopiedError = Exclude<AdminUserActionError, 'unauthorized' | 'session_expired' | 'directory_sync_failed'>;

/** K1.5's copy. unauthorized/session_expired never show: admin-fetch sends the admin to sign-in. */
export const ACTION_ERROR_COPY: Readonly<Record<CopiedError, string>> = {
  invalid_input: 'Check the email and role.',
  forbidden: 'Only superadmins can manage admins.',
  last_superadmin: 'There must always be at least one active superadmin.',
  self_change: "You can't change your own role or deactivate yourself.",
  already_exists: 'That email already has an admin account.',
  not_invited: 'This admin has already signed in, so there is no invite to resend.',
};
export const DIRECTORY_SYNC_SAVED_COPY = "Saved, but the sign-in directory didn't update. Try again to finish.";
export const DIRECTORY_SYNC_NOT_SAVED_COPY = 'Nothing changed. Try again.';
export const ACTION_UNCONFIRMED_COPY =
  "The change couldn't be confirmed. Refresh the page to see where it stands, then try again.";
export const ACTION_NETWORK_COPY =
  "Couldn't reach the console. Check your connection, refresh the page to see where it stands, then try again.";

/** adminFetchJson's answer, by shape. */
export type ActionPostOutcome =
  | { kind: 'ok'; status: number; data: unknown }
  | { kind: 'error'; status: number; data: unknown }
  | { kind: 'redirecting' }
  | { kind: 'network' };

export type RetryKind = 'same_request' | 'new_request';
export type FormFeedback = { message: string; retry: RetryKind };

export type ActionDecision =
  | { kind: 'done'; admin: AdminListItem }
  | { kind: 'redirecting' }
  | { kind: 'failed'; message: string; retry: RetryKind };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isListItem(value: unknown): value is AdminListItem {
  return isRecord(value) && typeof value.id === 'string' && typeof value.email === 'string';
}

export function decideActionOutcome(outcome: ActionPostOutcome): ActionDecision {
  if (outcome.kind === 'redirecting') return { kind: 'redirecting' };
  if (outcome.kind === 'network') return { kind: 'failed', message: ACTION_NETWORK_COPY, retry: 'new_request' };
  const data = outcome.data;
  if (outcome.kind === 'ok') {
    const changed = isRecord(data) && data.ok === true ? data.admin : undefined;
    return isListItem(changed)
      ? { kind: 'done', admin: changed }
      : { kind: 'failed', message: ACTION_UNCONFIRMED_COPY, retry: 'new_request' };
  }
  if (!isRecord(data) || data.ok !== false || typeof data.error !== 'string') {
    return { kind: 'failed', message: ACTION_UNCONFIRMED_COPY, retry: 'new_request' };
  }
  if (data.error === 'directory_sync_failed') {
    // Saved in the console but not yet in the sign-in directory: the same
    // request finishes it (K1.5 idempotency).
    return data.saved === true
      ? { kind: 'failed', message: DIRECTORY_SYNC_SAVED_COPY, retry: 'same_request' }
      : { kind: 'failed', message: DIRECTORY_SYNC_NOT_SAVED_COPY, retry: 'new_request' };
  }
  const copy = (ACTION_ERROR_COPY as Readonly<Record<string, string>>)[data.error];
  return { kind: 'failed', message: copy ?? ACTION_UNCONFIRMED_COPY, retry: 'new_request' };
}

/**
 * Whether a refused action still means the list is stale. A retried invite
 * whose first answer was lost finds the admin already created (K1.5
 * `already_exists`): the page shows that copy and reloads the list.
 */
export function refreshesListAfter(decision: ActionDecision): boolean {
  return decision.kind === 'failed' && decision.message === ACTION_ERROR_COPY.already_exists;
}

// --- Requests ----------------------------------------------------------------------

type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never;
/** An action as the page asks for it; the runner adds the request id. */
export type AdminActionInput = WithoutRequestId<AdminUserAction>;
export type PendingRequest = { action: AdminUserAction; retry: RetryKind };

function sameInput(action: AdminUserAction, input: AdminActionInput): boolean {
  const { requestId: _requestId, ...rest } = action;
  const sent = rest as Record<string, unknown>;
  const asked = input as Record<string, unknown>;
  const keys = new Set([...Object.keys(sent), ...Object.keys(asked)]);
  for (const key of keys) {
    if (sent[key] !== asked[key]) return false;
  }
  return true;
}

/**
 * The request for the next press: the same request only when the server saved
 * the change and asked for another try, and the admin asks for the same thing.
 */
export function nextRequest(
  input: AdminActionInput,
  previous: PendingRequest | undefined,
  newId: () => string,
): AdminUserAction {
  if (previous && previous.retry === 'same_request' && sameInput(previous.action, input)) {
    return previous.action;
  }
  return { ...input, requestId: newId() } as AdminUserAction;
}

export type RunResult = ActionDecision | { kind: 'busy' };
export type AdminActionRunner = { run(input: AdminActionInput): Promise<RunResult>; reset(): void };

/** One action at a time; remembers the last failure for nextRequest. */
export function createAdminActionRunner(deps: {
  post: (action: AdminUserAction) => Promise<ActionPostOutcome>;
  newId: () => string;
}): AdminActionRunner {
  let previous: PendingRequest | undefined;
  let inFlight = false;
  return {
    async run(input) {
      if (inFlight) return { kind: 'busy' };
      inFlight = true;
      const action = nextRequest(input, previous, deps.newId);
      let outcome: ActionPostOutcome;
      try {
        outcome = await deps.post(action);
      } catch {
        outcome = { kind: 'network' };
      } finally {
        inFlight = false;
      }
      const decision = decideActionOutcome(outcome);
      previous = decision.kind === 'failed' ? { action, retry: decision.retry } : undefined;
      return decision;
    },
    reset() {
      previous = undefined;
    },
  };
}

export function inviteInput(email: string, role: AdminRole): AdminActionInput {
  return { action: 'invite', email: email.trim(), role };
}

export function successMessage(input: AdminActionInput, admin: AdminListItem): string {
  switch (input.action) {
    case 'invite':
      return `Invite sent to ${admin.email}.`;
    case 'resend_invite':
      return `Invite sent again to ${admin.email}.`;
    case 'change_role':
      return `${admin.email} is now ${roleTitle(admin.role)}.`;
    case 'deactivate':
      return `${admin.email} is deactivated.`;
    case 'reactivate':
      return `${admin.email} can sign in again.`;
  }
}
