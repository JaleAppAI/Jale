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
 *
 * `short` picks the `status_short` block (sprint 23). It exists for ONE
 * status: `details_requested`'s long label is a whole sentence ("Employer
 * wants to hire you — complete your details"), which is right in a banner and
 * far too long for an 11px chip in a list row. The short block covers every
 * status rather than just that one, so a chip never mixes two vocabularies.
 */
export function ApplicationStatusChip({
  status,
  short = false,
}: {
  status: ApplicationStatus | LegacyApplicationStatus;
  short?: boolean;
}) {
  const t = useTranslations('worker_applications');
  const normalized = normalizeApplicationStatus(status);

  return (
    <ApplicationStatusBadge status={normalized}>
      {t(`${short ? 'status_short' : 'status'}.${normalized}`)}
    </ApplicationStatusBadge>
  );
}
