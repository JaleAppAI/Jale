import { getLockoutActions } from '../action-policy';
import { LOCKOUT_RESET_REASONS } from '../lockout-reasons';
import type { AdminRole, IdentityLockout, IdentityLockoutKind, IdentityLockoutOutcome } from '../types';
import { isUuid } from './audit/codes';
import {
  recordAdminAccess,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AttemptOutcome,
  type AuditQueryClient,
} from './audit/record';
import type { CaseAction } from './inbox-actions';
import type { AdminSession } from './session-claims';

// The list's fixed window. admin_identity_lockouts() accepts 1–30 days.
export const LOCKOUT_WINDOW_DAYS = 7;

export type IdentityLockoutRow = {
  challenge_id: string;
  kind: string;
  masked_phone: string | null;
  outcome: string;
  lockout_count: number | string;
  attempts: number | string;
  locked_until: Date | string | null;
  last_event_at: Date | string;
  started_at: Date | string;
};

const KINDS: readonly IdentityLockoutKind[] = ['lockout', 'stuck'];

const OUTCOME_LABELS: Record<IdentityLockoutOutcome, string> = {
  locked: 'Locked',
  lock_expired: 'Lock expired, no retry',
  retrying: 'Retrying',
  verified: 'Verified since lockout',
  superseded: 'Superseded',
  code_expired: 'Code expired',
};

// Existing badge colours from globals.css, so the page needs no new CSS.
const OUTCOME_BADGES: Record<IdentityLockoutOutcome, string> = {
  locked: 'rejected',
  lock_expired: 'pending_worker',
  retrying: 'open',
  verified: 'approved',
  superseded: 'needs_more_info',
  code_expired: 'pending_worker',
};

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isOutcome(value: string): value is IdentityLockoutOutcome {
  return Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, value);
}

export function mapIdentityLockoutRow(row: IdentityLockoutRow): IdentityLockout {
  if (!KINDS.includes(row.kind as IdentityLockoutKind)) {
    throw new Error(`Unexpected lockout kind: ${row.kind}`);
  }
  if (!isOutcome(row.outcome)) {
    throw new Error(`Unexpected lockout outcome: ${row.outcome}`);
  }

  return {
    challengeId: row.challenge_id,
    kind: row.kind as IdentityLockoutKind,
    maskedPhone: row.masked_phone,
    outcome: row.outcome,
    lockoutCount: Number(row.lockout_count),
    attempts: Number(row.attempts),
    lockedUntil: row.locked_until === null ? null : asIso(row.locked_until),
    lastEventAt: asIso(row.last_event_at),
    startedAt: asIso(row.started_at),
  };
}

export function lockoutOutcomeBadge(outcome: IdentityLockoutOutcome): string {
  return OUTCOME_BADGES[outcome];
}

// "Locked until 3:42 PM" for a live lock; a fixed label otherwise.
export function lockoutOutcomeText(item: Pick<IdentityLockout, 'outcome' | 'lockedUntil'>): string {
  if (item.outcome === 'locked' && item.lockedUntil) {
    const time = new Date(item.lockedUntil).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return `Locked until ${time}`;
  }
  return OUTCOME_LABELS[item.outcome];
}

export async function listIdentityLockouts(
  client: AuditQueryClient,
  days: number = LOCKOUT_WINDOW_DAYS,
): Promise<IdentityLockout[]> {
  const result = await client.query<IdentityLockoutRow>(
    'SELECT * FROM admin_identity_lockouts($1)',
    [days],
  );
  return result.rows.map(mapIdentityLockoutRow);
}

// ---- Sprint 28 contract K2.6: lockout detail ----------------------------------
//
// The reasons live in the client-safe lib/lockout-reasons.ts so a client
// component can import them without this module's server imports; they are
// re-exported here so the K2.6 import path keeps working.
export type { LockoutResetReason } from '../lockout-reasons';
export { LOCKOUT_RESET_REASONS } from '../lockout-reasons';

export type LockoutDetail = {
  challengeId: string; ref: string;
  state: 'locked' | 'stuck_at_code' | 'in_progress' | 'verified' | 'expired' | 'superseded'; statusLabel: string;
  languageLabel: 'Spanish' | 'English'; maskedPhone: string;
  attemptsUsed: number; attemptsAllowed: number;    // 3
  startedAt: string; lockedUntil: string | null;
  earlierResets: number;
  typicalMinutesToVerify: number | null;            // median over the last 30 days, WhatsApp door
  timeline: { at: string; title: string; detail: string | null }[];   // oldest first
  supportCaseId: string | null;                     // an open case for the same number, if any
  actions: CaseAction[];                            // reset_lockout, open_support_from_lockout
};

/** Wrong codes a challenge allows before it locks. */
export const LOCKOUT_ATTEMPTS_ALLOWED = 3;

// One row for a known challenge, none for an unknown one. No phone hash and no
// user id leave SQL; the number arrives masked (migration 122).
export const LOCKOUT_DETAIL_SQL = `
  SELECT challenge_id, state, language, masked_phone, attempts, locked_until, started_at,
         earlier_resets, typical_minutes_to_verify, support_case_id, timeline
    FROM public.admin_identity_challenge_detail($1::uuid)
`;

const LOCKOUT_STATES: readonly LockoutDetail['state'][] = ['locked', 'stuck_at_code', 'in_progress', 'verified', 'expired', 'superseded'];

const LOCKOUT_STATE_LABELS: Readonly<Record<LockoutDetail['state'], string>> = {
  locked: 'Locked',
  stuck_at_code: 'Stuck at the code',
  in_progress: 'In progress',
  verified: 'Verified',
  expired: 'Expired',
  superseded: 'Superseded',
};

const CHALLENGE_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Waiting for the code',
  locked: 'Locked',
  verified: 'Verified',
  expired: 'Code expired',
  superseded: 'Replaced by a newer verification',
};

export type LockoutDetailRow = {
  challenge_id: string;
  state: string;
  language: string | null;
  masked_phone: string | null;
  attempts: number | string | null;
  locked_until: Date | string | null;
  started_at: Date | string;
  earlier_resets: number | string | null;
  typical_minutes_to_verify: number | string | null;
  support_case_id: string | null;
  timeline: unknown;
};

/** V-<first 8 hex of the challenge id, upper case> (K2.0). */
export function lockoutRef(challengeId: string): string {
  return `V-${challengeId.slice(0, 8).toUpperCase()}`;
}

function textField(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  return typeof value === 'string' && value ? value : null;
}

function reasonLabel(code: string | null): string | null {
  return LOCKOUT_RESET_REASONS.find((reason) => reason.code === code)?.label ?? null;
}

/** One timeline entry from the definer's JSON: a status change or an admin reset. Unknown shapes are dropped. */
export function mapLockoutTimelineItem(value: unknown): LockoutDetail['timeline'][number] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const at = textField(item, 'at');
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const when = asIso(at);

  if (item.kind === 'reset') {
    const role = textField(item, 'by_role');
    return {
      at: when,
      title: role === 'Superadmin' ? 'Reset by a superadmin' : role === 'Ops' ? 'Reset by an Ops admin' : 'Reset by an admin',
      detail: reasonLabel(textField(item, 'reason_code')),
    };
  }
  if (item.kind !== 'status') return null;

  const from = textField(item, 'from_status');
  const to = textField(item, 'to_status');
  const attempts = typeof item.attempts === 'number' ? item.attempts : null;
  const backfill = item.is_backfill === true ? ' (recorded before history was kept)' : '';
  let title: string;
  let detail: string | null = null;
  if (from === null) {
    title = 'Verification started';
  } else if (from === to && to === 'pending' && attempts !== null) {
    title = 'Wrong code';
    detail = `Attempt ${attempts} of ${LOCKOUT_ATTEMPTS_ALLOWED}`;
  } else if (to === 'locked') {
    title = 'Locked';
    detail = attempts !== null ? `After ${attempts} wrong codes` : null;
  } else if (from === 'locked' && to === 'pending') {
    title = 'Lock cleared';
  } else {
    title = (to && CHALLENGE_STATUS_LABELS[to]) ?? 'Status changed';
  }
  return { at: when, title: `${title}${backfill}`, detail };
}

function asCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(String(value ?? 0));
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function mapLockoutDetailRow(row: LockoutDetailRow, role: AdminRole): LockoutDetail {
  if (!LOCKOUT_STATES.includes(row.state as LockoutDetail['state'])) {
    throw new Error(`Unexpected lockout state: ${row.state}`);
  }
  const state = row.state as LockoutDetail['state'];
  const challengeId = row.challenge_id.toLowerCase();
  const typical = row.typical_minutes_to_verify === null ? null : Number(row.typical_minutes_to_verify);
  const timeline = Array.isArray(row.timeline)
    ? row.timeline.map(mapLockoutTimelineItem).filter((item): item is LockoutDetail['timeline'][number] => item !== null)
    : [];

  return {
    challengeId,
    ref: lockoutRef(challengeId),
    state,
    statusLabel: LOCKOUT_STATE_LABELS[state],
    languageLabel: row.language === 'en' ? 'English' : 'Spanish',
    maskedPhone: row.masked_phone ?? 'Masked',
    attemptsUsed: asCount(row.attempts),
    attemptsAllowed: LOCKOUT_ATTEMPTS_ALLOWED,
    startedAt: asIso(row.started_at),
    lockedUntil: row.locked_until === null ? null : asIso(row.locked_until),
    earlierResets: asCount(row.earlier_resets),
    typicalMinutesToVerify: typical !== null && Number.isFinite(typical) ? typical : null,
    timeline,
    supportCaseId: row.support_case_id ? row.support_case_id.toLowerCase() : null,
    actions: getLockoutActions({ state }, role),
  };
}

/**
 * One lockout and its history. Records the challenge id (the definer returns
 * no user id, so the record names no subject). An unknown challenge records
 * a not_found attempt once the transaction has ended; a read that fails
 * records a failed attempt once its client is released.
 */
export async function loadLockoutDetail(session: AdminSession, challengeId: string): Promise<LockoutDetail | null> {
  const attempt = (outcome: AttemptOutcome) => recordAdminAttempt(session, {
    surface: 'admin.lockout_detail',
    categories: ['verifications'],
    ...(isUuid(challengeId) ? { recordType: 'identity_challenge' as const, recordIds: [challengeId] } : {}),
    resultCount: 0,
    purpose: { kind: 'verification' },
    outcome,
  });

  if (!isUuid(challengeId)) {
    await attempt('not_found');
    return null;
  }

  let detail: LockoutDetail | null;
  try {
    detail = await withAdminReadTransaction(session, async (client) => {
      const row = (await client.query<LockoutDetailRow>(LOCKOUT_DETAIL_SQL, [challengeId])).rows[0];
      if (!row) {
        return null;
      }
      const mapped = mapLockoutDetailRow(row, session.role);
      await recordAdminAccess(session, {
        surface: 'admin.lockout_detail',
        categories: ['verifications'],
        recordType: 'identity_challenge',
        recordIds: [mapped.challengeId],
        resultCount: mapped.timeline.length,
        purpose: { kind: 'verification' },
      }, client);
      return mapped;
    });
  } catch (error) {
    await attempt('failed');
    throw error;
  }

  if (!detail) {
    await attempt('not_found');
  }
  return detail;
}
