import { emitEmfMetrics } from '../../lib/emf';
import type { ReportRole } from './validate';

/**
 * The `Jale/Reports` metrics, as EMF lines. Dimension values are fixed codes
 * only: never report words, contact, context values, keys, tokens, addresses
 * or hashes.
 *
 * An alarm with no dimensions sees only datapoints published with none, so
 * the series an alarm reads (ReportsCreated, the clean-up's run total) are
 * emitted dimensionless, beside the dimensioned values.
 */
export const REPORTS_METRIC_NAMESPACE = 'Jale/Reports';

const one = (name: string) => [{ name, value: 1 }];

/** A new report (not a replay): dimensionless for the alarm, and by role and verified. */
export function emitReportCreated(role: ReportRole, verified: boolean): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportsCreated'));
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportsCreated'), { Role: role, Verified: String(verified) });
}

export type CaptureOutcome = 'ok' | 'timeout' | 'failed' | 'removed' | 'attached' | 'none';

export function emitReportCapture(outcome: CaptureOutcome): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportCapture'), { Outcome: outcome });
}

/** Why an uploaded object was not attached. */
export type UploadRejectReason = 'missing' | 'size' | 'encryption' | 'content_type' | 'magic' | 'changed' | 'refused';

export function emitUploadRejected(reason: UploadRejectReason): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportUploadRejected'), { Reason: reason });
}

export function emitRateLimited(scope: 'address' | 'global' | 'account'): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportRateLimited'), { Scope: scope });
}

/** The team-email switch is on but no email was queued (no recipient or base URL set). */
export function emitEmailSkipped(): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportEmailSkipped'));
}

export function emitIntakeError(): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportIntakeErrors'));
}

/** A signed-in report whose role neither the sign-in nor an account could tell. */
export function emitRoleUnknown(): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportRoleUnknown'));
}

export interface CleanupCounts {
  contents_erased: number;
  images_expired: number;
  pending_cleared: number;
  notifications_deleted: number;
  buckets_deleted: number;
}

/**
 * A completed clean-up run: each kind's count, then the run's total with no
 * dimensions, zero included, so every completed run leaves a datapoint the
 * missing-run alarm can count.
 */
export function emitCleanupCompleted(counts: CleanupCounts): void {
  let total = 0;
  for (const [kind, value] of Object.entries(counts) as Array<[keyof CleanupCounts, number]>) {
    emitEmfMetrics(REPORTS_METRIC_NAMESPACE, [{ name: 'ReportCleanupDeleted', value }], { Kind: kind });
    total += value;
  }
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, [{ name: 'ReportCleanupDeleted', value: total }]);
}

/** A failed clean-up run. It publishes no run total. */
export function emitCleanupFailed(): void {
  emitEmfMetrics(REPORTS_METRIC_NAMESPACE, one('ReportCleanupFailed'));
}
