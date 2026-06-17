import type { AdminCaseStatus, AdminCaseType, AdminRole, VerificationRecord } from './types';

export type CaseActionId =
  | 'reply_whatsapp'
  | 'request_more_info'
  | 'resend_outbound'
  | 'reveal_pii'
  | 'resolve_case';

export type VerificationActionId =
  | 'approve_verification'
  | 'reject_verification'
  | 'request_more_info'
  | 'reset_verification_step';

export type AdminActionId = CaseActionId | VerificationActionId;

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

type VerificationActionContext = {
  status: VerificationRecord['status'];
  step: VerificationRecord['step'];
};

const MUTATING_ROLES = new Set<AdminRole>(['admin_ops', 'admin_superadmin']);
const CLOSED_CASE_STATUSES = new Set<AdminCaseStatus>(['resolved', 'dismissed']);
const CLOSED_VERIFICATION_STATUSES = new Set<VerificationRecord['status']>(['approved', 'rejected']);
const AUDITED_ACTIONS = new Set<AdminActionId>([
  'reply_whatsapp',
  'request_more_info',
  'resend_outbound',
  'reveal_pii',
  'resolve_case',
  'approve_verification',
  'reject_verification',
  'reset_verification_step',
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

export function getVerificationActions(context: VerificationActionContext, role: AdminRole): AdminAction[] {
  const closedReason = CLOSED_VERIFICATION_STATUSES.has(context.status)
    ? `Verification is already ${context.status.replace(/_/g, ' ')}.`
    : undefined;

  return [
    action(
      'approve_verification',
      'Approve',
      'Approve the current verification after evidence has been reviewed.',
      role,
      closedReason,
    ),
    action(
      'reject_verification',
      'Reject',
      'Reject the verification with an auditable reason.',
      role,
      closedReason,
      { dangerous: true },
    ),
    action(
      'request_more_info',
      'Request more info',
      'Ask for the minimum missing document or account detail required to continue.',
      role,
      closedReason,
    ),
    action(
      'reset_verification_step',
      'Reset step',
      `Reset the ${context.step} step so the user can try again.`,
      role,
      closedReason,
      { dangerous: true },
    ),
  ];
}

export function requiresAuditLog(actionId: AdminActionId): boolean {
  return AUDITED_ACTIONS.has(actionId);
}

export function requiresPiiJustification(actionId: AdminActionId): boolean {
  return actionId === 'reveal_pii';
}
