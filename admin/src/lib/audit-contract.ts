import { requiresPiiJustification, type AdminActionId } from './action-policy';

export type AdminAuditTargetType = 'admin_case' | 'verification' | 'whatsapp_outbox';

export type AdminAuditEventDraft = {
  id: string;
  at: string;
  actor: string;
  action: AdminActionId;
  targetType: AdminAuditTargetType;
  targetId: string;
  piiReveal: boolean;
  summary: string;
  justification?: string;
  note?: string;
};

type BuildAdminAuditEventInput = {
  actor: string;
  actionId: AdminActionId;
  targetType: AdminAuditTargetType;
  targetId: string;
  justification?: string;
  note?: string;
  now?: Date;
};

function compact(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'target';
}

function sentence(value: string): string {
  const trimmed = value.trim().replace(/[.!?]+$/g, '');
  return `${trimmed}.`;
}

export function buildAdminAuditEvent(input: BuildAdminAuditEventInput): AdminAuditEventDraft {
  const at = (input.now ?? new Date()).toISOString();
  const justification = compact(input.justification);
  const note = compact(input.note);
  const piiReveal = requiresPiiJustification(input.actionId);
  const summaryParts = [
    `${input.actor} requested ${input.actionId} for ${input.targetType} ${input.targetId}.`,
  ];

  if (justification) {
    summaryParts.push(`Justification: ${sentence(justification)}`);
  }

  if (note) {
    summaryParts.push(`Note: ${sentence(note)}`);
  }

  return {
    id: `audit_preview_${safeIdPart(input.actionId)}_${safeIdPart(input.targetId)}`,
    at,
    actor: input.actor,
    action: input.actionId,
    targetType: input.targetType,
    targetId: input.targetId,
    piiReveal,
    summary: summaryParts.join(' '),
    justification,
    note,
  };
}
