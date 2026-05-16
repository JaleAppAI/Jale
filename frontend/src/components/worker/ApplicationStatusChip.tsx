import { useTranslations } from 'next-intl';

const STYLES: Record<string, { bg: string; color: string; dot: string }> = {
  pending:  { bg: 'var(--jale-paper-2)',    color: 'var(--jale-ink-2)',   dot: 'var(--jale-ink-2)' },
  reviewed: { bg: 'var(--jale-blue-50)',    color: 'var(--jale-blue-700)', dot: 'var(--jale-blue-500)' },
  hired:    { bg: 'var(--jale-success-bg)', color: '#1f7a44',              dot: 'var(--jale-success)' },
  rejected: { bg: 'var(--jale-danger-bg)',  color: 'var(--jale-danger)',   dot: 'var(--jale-danger)' },
};

export function ApplicationStatusChip({ status }: { status: 'pending' | 'reviewed' | 'hired' | 'rejected' }) {
  const t = useTranslations('worker_applications.status');
  const s = STYLES[status] ?? STYLES.pending;

  return (
    <span
      className="pill"
      style={{ background: s.bg, color: s.color }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: s.dot, marginRight: 4 }}
      />
      {t(status)}
    </span>
  );
}
