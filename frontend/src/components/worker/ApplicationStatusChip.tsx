import { useTranslations } from 'next-intl';
import { ApplicationStatusBadge } from '@/components/ui/badge';
import { normalizeApplicationStatus } from '@/lib/status';
import type { ApplicationStatus, LegacyApplicationStatus } from '@/lib/status';

/**
 * Worker-facing application status.
 *
 * The props are unchanged on purpose — `worker/jobs/[id]` renders this too, and
 * the whole point of a shared chip is that one restyle reaches every surface.
 * What changed is the paint: the tinted pill is gone, replaced by the app's one
 * badge language (coloured dot + muted text) via `ApplicationStatusBadge`.
 *
 * The status -> colour decision is NOT restated here. `ApplicationStatusBadge`
 * reads `lib/status.ts` at runtime, so a status whose meaning is retuned there
 * cannot leave this chip painting the old colour. Only the label is ours, and
 * it is keyed off the normalized status so the legacy `reviewed`/`rejected`
 * values still resolve to a real sentence.
 */
export function ApplicationStatusChip({ status }: { status: ApplicationStatus | LegacyApplicationStatus }) {
  const t = useTranslations('worker_applications.status');
  const normalized = normalizeApplicationStatus(status);

  return <ApplicationStatusBadge status={normalized}>{t(normalized)}</ApplicationStatusBadge>;
}
