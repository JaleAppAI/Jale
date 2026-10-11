import { emitEmfMetrics } from '../emf';
import { SURFACE_PATTERN } from './registry';

/**
 * The audit metrics, in namespace `Jale/Audit`:
 *
 * - `AuditWriteFailed`, dimension `Surface`: an access record could not be
 *   written in its request's transaction, so the request failed.
 * - `AuditFallbackEvents`, no dimensions: an attempt record went to the
 *   fallback log group.
 * - `AuditFallbackFailed`, no dimensions: the fallback failed too and the
 *   record is lost. The line carries codes and ids only.
 *
 * All three go out through the shared EMF helper (lib/emf.ts), so each is one
 * console.log line, the path whose lines CloudWatch turns into metrics. The
 * lost-record signal in particular must not travel on another path.
 */
export const AUDIT_METRIC_NAMESPACE = 'Jale/Audit';

type AuditMetric = 'AuditWriteFailed' | 'AuditFallbackEvents' | 'AuditFallbackFailed';

function emitAuditMetric(metric: AuditMetric, dimensions: Record<string, string>, fields: Record<string, unknown>): void {
  emitEmfMetrics(AUDIT_METRIC_NAMESPACE, [{ name: metric, value: 1 }], dimensions, {}, fields);
}

/** A surface code for a dimension: the surface when it is well formed, else `invalid`. */
export function surfaceDimension(surface: unknown): string {
  return typeof surface === 'string' && surface.length <= 100 && SURFACE_PATTERN.test(surface)
    ? surface
    : 'invalid';
}

export function emitAuditWriteFailed(surface: unknown, origin: string): void {
  emitAuditMetric('AuditWriteFailed', { Surface: surfaceDimension(surface) }, { origin });
}

export function emitAuditFallbackEvent(origin: string): void {
  emitAuditMetric('AuditFallbackEvents', {}, { origin });
}

/** `fields` must hold codes, ids and counts only: the lost record's identity, never content. */
export function emitAuditFallbackFailed(origin: string, fields: Record<string, unknown>): void {
  emitAuditMetric('AuditFallbackFailed', {}, { ...fields, origin });
}
