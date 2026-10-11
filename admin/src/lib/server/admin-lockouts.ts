import type { IdentityLockout, IdentityLockoutKind, IdentityLockoutOutcome } from '../types';
import {
  recordAdminAccess,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AuditQueryClient,
} from './audit/record';
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

/**
 * The lockout list. Records every challenge id shown. The function
 * returns no user id (migration 102), so the record names no subject. A
 * read that fails records a failed attempt once its client is released.
 */
export async function loadLockouts(session: AdminSession): Promise<IdentityLockout[]> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const lockouts = await listIdentityLockouts(client);
      await recordAdminAccess(session, {
        surface: 'admin.lockouts',
        categories: ['verifications'],
        recordType: 'identity_challenge',
        recordIds: lockouts.map((item) => item.challengeId),
        purpose: { kind: 'verification' },
      }, client);
      return lockouts;
    });
  } catch (error) {
    await recordAdminAttempt(session, { surface: 'admin.lockouts', categories: ['verifications'], outcome: 'failed' });
    throw error;
  }
}
