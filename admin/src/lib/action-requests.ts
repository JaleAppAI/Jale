// Sprint 28 contract K2.7: the body of POST /api/inbox-actions, parsed
// strictly. Pure on purpose (no server imports), so the rules can be checked
// without a database. Anything outside the rules is `invalid_input`; the
// database repeats every check that matters.
import type { InboxAction } from './server/inbox-actions';
import { LOCKOUT_RESET_REASONS, type LockoutResetReason } from './lockout-reasons';
import { REVEAL_REASON_MAX_LENGTH, REVEAL_REASON_MIN_LENGTH } from './report-policy';
import { FREEFORM_REPLY_MAX_CHARS } from './support-reply';

export const INBOX_ACTIONS = [
  'reply',
  'request_info',
  'resolve',
  'reveal_phone',
  'open_media',
  'reset_lockout',
  'open_support_from_lockout',
] as const satisfies readonly InboxAction['action'][];

/** A reset note: up to 300 characters, required for the reason "other". */
export const LOCKOUT_NOTE_MAX_LENGTH = 300;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_CODES: ReadonlySet<string> = new Set(LOCKOUT_RESET_REASONS.map((reason) => reason.code));

export type ParsedInboxAction = { ok: true; value: InboxAction } | { ok: false };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** Trimmed text of `min` to `max` UTF-16 code units, without NUL; null otherwise. */
function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length >= min && text.length <= max && !text.includes('\u0000') ? text : null;
}

export function isInboxActionName(value: unknown): value is InboxAction['action'] {
  return typeof value === 'string' && (INBOX_ACTIONS as readonly string[]).includes(value);
}

export function parseInboxAction(input: unknown): ParsedInboxAction {
  const body = asRecord(input);
  const action = body?.action;
  const requestId = uuid(body?.requestId);
  if (!body || !isInboxActionName(action) || !requestId) {
    return { ok: false };
  }

  switch (action) {
    case 'reply':
    case 'request_info': {
      const caseId = uuid(body.caseId);
      const text = boundedText(body.text, 1, FREEFORM_REPLY_MAX_CHARS);
      return caseId && text !== null ? { ok: true, value: { action, requestId, caseId, text } } : { ok: false };
    }
    case 'resolve': {
      const caseId = uuid(body.caseId);
      return caseId ? { ok: true, value: { action, requestId, caseId } } : { ok: false };
    }
    case 'reveal_phone': {
      const caseId = uuid(body.caseId);
      const justification = boundedText(body.justification, REVEAL_REASON_MIN_LENGTH, REVEAL_REASON_MAX_LENGTH);
      return caseId && justification !== null
        ? { ok: true, value: { action, requestId, caseId, justification } }
        : { ok: false };
    }
    case 'open_media': {
      const caseId = uuid(body.caseId);
      const mediaId = uuid(body.mediaId);
      return caseId && mediaId ? { ok: true, value: { action, requestId, caseId, mediaId } } : { ok: false };
    }
    case 'reset_lockout': {
      const challengeId = uuid(body.challengeId);
      const reasonCode = body.reasonCode;
      if (!challengeId || typeof reasonCode !== 'string' || !REASON_CODES.has(reasonCode)) {
        return { ok: false };
      }
      let note: string | undefined;
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') return { ok: false };
        const trimmed = body.note.trim();
        if (trimmed !== '') {
          const bounded = boundedText(trimmed, 1, LOCKOUT_NOTE_MAX_LENGTH);
          if (bounded === null) return { ok: false };
          note = bounded;
        }
      }
      if (reasonCode === 'other' && note === undefined) {
        return { ok: false };
      }
      return {
        ok: true,
        value: { action, requestId, challengeId, reasonCode: reasonCode as LockoutResetReason, ...(note !== undefined ? { note } : {}) },
      };
    }
    case 'open_support_from_lockout': {
      const challengeId = uuid(body.challengeId);
      return challengeId ? { ok: true, value: { action, requestId, challengeId } } : { ok: false };
    }
  }
}
