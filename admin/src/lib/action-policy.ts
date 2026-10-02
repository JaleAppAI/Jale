import type { AdminCaseStatus, AdminCaseType, AdminRole } from './types';

export type CaseActionId =
  | 'reply_whatsapp'
  | 'request_more_info'
  | 'resend_outbound'
  | 'reveal_pii'
  | 'resolve_case';

// The four verification actions (approve, reject, request more info, reset
// step) were retired in roadmap 1b: they only edited demo admin_cases rows and
// never touched worker_identity_challenges. /verifications is now read-only.
export type AdminActionId = CaseActionId;

export type AdminAction = {
  id: AdminActionId;
  label: string;
  description: string;
  disabled: boolean;
  reason?: string;
  dangerous?: boolean;
  piiReveal?: boolean;
};

type CaseActionContext = {
  status: AdminCaseStatus;
  type: AdminCaseType;
};

const MUTATING_ROLES = new Set<AdminRole>(['admin_ops', 'admin_superadmin']);
const CLOSED_CASE_STATUSES = new Set<AdminCaseStatus>(['resolved', 'dismissed']);
const AUDITED_ACTIONS = new Set<AdminActionId>([
  'reply_whatsapp',
  'request_more_info',
  'resend_outbound',
  'reveal_pii',
  'resolve_case',
]);

function action(
  id: AdminActionId,
  label: string,
  description: string,
  role: AdminRole,
  blockedReason?: string,
  options: Pick<AdminAction, 'dangerous' | 'piiReveal'> = {},
): AdminAction {
  const roleBlocked = !MUTATING_ROLES.has(role);
  const reason = roleBlocked ? 'Requires admin_ops or admin_superadmin role.' : blockedReason;

  return {
    id,
    label,
    description,
    disabled: Boolean(reason),
    reason,
    ...options,
  };
}

export function getCaseActions(context: CaseActionContext, role: AdminRole): AdminAction[] {
  const closedReason = CLOSED_CASE_STATUSES.has(context.status)
    ? `Case is ${context.status.replace(/_/g, ' ')}.`
    : undefined;

  const actions: AdminAction[] = [];

  if (context.type === 'outbound_failure') {
    const resendUnavailableReason =
      closedReason ?? 'Resend outbound message is not available yet; use manual follow-up and record the resolution.';
    actions.push(
      action(
        'resend_outbound',
        'Resend outbound message',
        'Queue a safe resend for a previously failed WhatsApp delivery.',
        role,
        resendUnavailableReason,
      ),
    );
  } else {
    actions.push(
      action(
        'reply_whatsapp',
        'Reply in WhatsApp',
        'Send a bounded support reply through the existing WhatsApp conversation.',
        role,
        closedReason,
      ),
    );

    actions.push(
      action(
        'request_more_info',
        'Request more info',
        'Ask the worker or employer for the next specific missing item.',
        role,
        closedReason,
      ),
    );
  }

  actions.push(
    action(
      'reveal_pii',
      'Reveal PII',
      'Temporarily reveal masked contact data after entering a support justification.',
      role,
      closedReason,
      { dangerous: true, piiReveal: true },
    ),
  );

  actions.push(
    action(
      'resolve_case',
      'Resolve case',
      'Close the case after the blocking issue has been handled.',
      role,
      closedReason,
    ),
  );

  return actions;
}

export function requiresAuditLog(actionId: AdminActionId): boolean {
  return AUDITED_ACTIONS.has(actionId);
}

export function requiresPiiJustification(actionId: AdminActionId): boolean {
  return actionId === 'reveal_pii';
}
