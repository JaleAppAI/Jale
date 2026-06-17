import { useTranslations } from 'next-intl';
import { applicationStatusTone, normalizeApplicationStatus } from '@/lib/status';
import type { ApplicationStatus, LegacyApplicationStatus } from '@/lib/status';

export function ApplicationStatusChip({ status }: { status: ApplicationStatus | LegacyApplicationStatus }) {
  const t = useTranslations('worker_applications.status');
  const normalized = normalizeApplicationStatus(status);
  const s = applicationStatusTone(normalized);

  return (
    <span
      className="pill"
      style={{ background: s.bg, color: s.color }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: s.dot, marginRight: 4 }}
      />
      {t(normalized)}
    </span>
  );
}
