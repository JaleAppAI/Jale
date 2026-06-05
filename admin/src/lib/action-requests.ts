import {
  getCaseActions,
  getVerificationActions,
  requiresPiiJustification,
  type AdminActionId,
} from './action-policy';
import { buildAdminAuditEvent, type AdminAuditEventDraft, type AdminAuditTargetType } from './audit-contract';
import type { AdminCaseStatus, AdminCaseType, AdminRole, VerificationRecord } from './types';

export type AdminActionRequest = {
  actionId: AdminActionId;
  targetType: AdminAuditTargetType;
  targetId: string;
  justification?: string;
  note?: string;
};

export type AdminActionRequestError =
  | 'invalid_action'
  | 'invalid_target_type'
  | 'target_id_required'
  | 'target_action_mismatch'
  | 'pii_justification_required';

export type ParseAdminActionRequestResult =
  | { ok: true; value: AdminActionRequest }
  | { ok: false; error: AdminActionRequestError };

export type ValidateAdminActionInput = {
  actor: string;
  role: AdminRole;
  request: AdminActionRequest;
} & (
  | {
      targetKind: 'case';
      targetStatus: AdminCaseStatus;
      targetCaseType: AdminCaseType;
    }
  | {
      targetKind: 'verification';
      targetStatus: VerificationRecord['status'];
      targetStep: VerificationRecord['step'];
    }
);

export type ValidateAdminActionResult =
  | {
      ok: false;
      status: 403;
      error: 'forbidden';
      message: string;
    }
  | {
      ok: false;
      status: 409;
      error: 'action_disabled';
      message: string;
    }
  | {
      ok: true;
      auditEvent: AdminAuditEventDraft;
    };

const CASE_ACTIONS = new Set<AdminActionId>([
  'reply_whatsapp',
  'request_more_info',
  'resend_outbound',
  'reveal_pii',
  'resolve_case',
]);
const VERIFICATION_ACTIONS = new Set<AdminActionId>([
  'approve_verification',
  'reject_verification',
  'request_more_info',
  'reset_verification_step',
]);
const ALL_ACTIONS = new Set<AdminActionId>([...CASE_ACTIONS, ...VERIFICATION_ACTIONS]);
const TARGET_TYPES = new Set<AdminAuditTargetType>(['admin_case', 'verification', 'whatsapp_outbox']);

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isActionTargetMismatch(actionId: AdminActionId, targetType: AdminAuditTargetType): boolean {
  if (targetType === 'verification') {
    return !VERIFICATION_ACTIONS.has(actionId);
  }

  return !CASE_ACTIONS.has(actionId);
}

export function parseAdminActionRequest(input: unknown): ParseAdminActionRequestResult {
  if (!isRecord(input)) {
    return { ok: false, error: 'invalid_action' };
  }

  const actionId = stringField(input.actionId) as AdminActionId | undefined;
  if (!actionId || !ALL_ACTIONS.has(actionId)) {
    return { ok: false, error: 'invalid_action' };
  }

  const targetType = stringField(input.targetType) as AdminAuditTargetType | undefined;
  if (!targetType || !TARGET_TYPES.has(targetType)) {
    return { ok: false, error: 'invalid_target_type' };
  }

  const targetId = stringField(input.targetId);
  if (!targetId) {
    return { ok: false, error: 'target_id_required' };
  }

  if (isActionTargetMismatch(actionId, targetType)) {
    return { ok: false, error: 'target_action_mismatch' };
  }

  const justification = stringField(input.justification);
  if (requiresPiiJustification(actionId) && (!justification || justification.length < 20)) {
    return { ok: false, error: 'pii_justification_required' };
  }

  return {
    ok: true,
    value: {
      actionId,
      targetType,
      targetId,
      justification,
      note: stringField(input.note),
    },
  };
}

export function formDataToAdminActionRequest(formData: FormData): ParseAdminActionRequestResult {
  return parseAdminActionRequest({
    actionId: formData.get('actionId'),
    targetType: formData.get('targetType'),
    targetId: formData.get('targetId'),
    justification: formData.get('justification'),
    note: formData.get('note'),
  });
}

export function validateAdminAction(input: ValidateAdminActionInput): ValidateAdminActionResult {
  const availableActions = input.targetKind === 'case'
    ? getCaseActions({ status: input.targetStatus, type: input.targetCaseType }, input.role)
    : getVerificationActions({ status: input.targetStatus, step: input.targetStep }, input.role);
  const matchingAction = availableActions.find((action) => action.id === input.request.actionId);

  if (!matchingAction) {
    return {
      ok: false,
      status: 409,
      error: 'action_disabled',
      message: 'Action is not available for this target state.',
    };
  }

  if (matchingAction.disabled) {
    if (matchingAction.reason?.startsWith('Requires')) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden',
        message: matchingAction.reason,
      };
    }

    return {
      ok: false,
      status: 409,
      error: 'action_disabled',
      message: matchingAction.reason ?? 'Action is disabled for this target.',
    };
  }

  return {
    ok: true,
    auditEvent: buildAdminAuditEvent({
      actor: input.actor,
      actionId: input.request.actionId,
      targetType: input.request.targetType,
      targetId: input.request.targetId,
      justification: input.request.justification,
      note: input.request.note,
    }),
  };
}
