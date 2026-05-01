import { useTranslations } from 'next-intl';

const STYLES: Record<string, string> = {
  pending:  'bg-gray-100 text-gray-500',
  reviewed: 'bg-blue-100 text-blue-700',
  hired:    'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-600',
};

export function ApplicationStatusChip({ status }: { status: 'pending' | 'reviewed' | 'hired' | 'rejected' }) {
  const t = useTranslations('worker_applications.status');
  return (
    <span className={['rounded-full px-2 py-0.5 text-xs font-medium shrink-0', STYLES[status] ?? STYLES.pending].join(' ')}>
      {t(status)}
    </span>
  );
}
