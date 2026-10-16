// Sprint 28 contract K2.7: which Inbox actions an admin may take on a case
// or a lockout. Server-computed and shown as they are: an action that cannot
// be taken is disabled with its reason, never hidden. The route repeats the
// role check (lib/server/inbox-actions.ts), so this list is never the only
// guard.
import type { AdminCaseStatus, AdminRole } from './types';
import type { CaseAction, CaseActionId } from './server/inbox-actions';
import type { LockoutDetail } from './server/admin-lockouts';

/** The reason every action shows to a read-only admin. */
export const READ_ONLY_REASON = 'Requires Ops or Superadmin.';
export const CLOSED_CASE_REASON = 'This case is closed.';
export const NO_CONVERSATION_REASON = 'This case has no WhatsApp conversation.';
export const NOT_LOCKED_REASON = 'Only a locked or stuck verification can be reset.';

const MUTATING_ROLES: ReadonlySet<AdminRole> = new Set<AdminRole>(['admin_ops', 'admin_superadmin']);
const CLOSED_STATUSES: ReadonlySet<AdminCaseStatus> = new Set<AdminCaseStatus>(['resolved', 'dismissed']);
const RESETTABLE_STATES: ReadonlySet<LockoutDetail['state']> = new Set<LockoutDetail['state']>(['locked', 'stuck_at_code']);

/** Every Inbox mutation, and a phone reveal, needs Ops or Superadmin. */
export function canActOnInbox(role: AdminRole): boolean {
  return MUTATING_ROLES.has(role);
}

function action(id: CaseActionId, role: AdminRole, blockedReason?: string): CaseAction {
  const reason = canActOnInbox(role) ? blockedReason : READ_ONLY_REASON;
  return reason ? { id, enabled: false, reason } : { id, enabled: true };
}

export type SupportActionContext = {
  status: AdminCaseStatus;
  /** The case has a WhatsApp conversation, so a message can reach the worker. */
  hasConversation: boolean;
};

/**
 * reply, request_info, resolve and reveal_phone, in that order. A closed case
 * takes no message and cannot be resolved again; a case without a
 * conversation can be resolved (no message is sent) but not answered.
 */
export function getSupportActions(context: SupportActionContext, role: AdminRole): CaseAction[] {
  const closed = CLOSED_STATUSES.has(context.status) ? CLOSED_CASE_REASON : undefined;
  const noTarget = context.hasConversation ? undefined : NO_CONVERSATION_REASON;

  return [
    action('reply', role, closed ?? noTarget),
    action('request_info', role, closed ?? noTarget),
    action('resolve', role, closed),
    action('reveal_phone', role, noTarget),
  ];
}

export type LockoutActionContext = Pick<LockoutDetail, 'state'>;

/** reset_lockout (a locked or stuck challenge only) and open_support_from_lockout. */
export function getLockoutActions(context: LockoutActionContext, role: AdminRole): CaseAction[] {
  return [
    action('reset_lockout', role, RESETTABLE_STATES.has(context.state) ? undefined : NOT_LOCKED_REASON),
    action('open_support_from_lockout', role),
  ];
}
