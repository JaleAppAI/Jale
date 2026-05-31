'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { Job } from '@/lib/api/employer';
import { jobStatusTone } from '@/lib/status';

interface Props {
  job: Job;
  href: string;
  isLast?: boolean;
}

export function JobPostingCard({ job, href, isLast }: Props) {
  const t = useTranslations('employer_dashboard');
  const locale = useLocale();

  const tone = jobStatusTone(job.status);
  const openCount = job.open_count ?? Math.max(0, (job.number_of_workers_needed ?? 0) - (job.hired_count ?? 0));
  const postedDate = new Date(job.created_at).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div
      className="grid grid-cols-1 gap-3 px-5 py-4 items-start hover:bg-[var(--jale-blue-50)] transition-colors duration-100 md:grid-cols-[minmax(0,2fr)_minmax(7rem,1fr)_minmax(6rem,0.8fr)_minmax(7rem,1fr)_auto_auto] md:items-center"
      style={{
        borderBottom: isLast ? 'none' : '1px solid var(--jale-divider)',
      }}
    >
      <div>
        <Link href={href} className="inline-block hover:underline">
          <p className="font-semibold text-sm" style={{ color: 'var(--jale-ink)' }}>
            {job.title}
          </p>
        </Link>
        <p className="text-xs mt-0.5" style={{ color: 'var(--jale-ink-2)' }}>
          {t('jobs.posted')} {postedDate}
        </p>
        {(job.pay || job.pay_min !== null || job.pay_max !== null) && (
          <p className="text-xs mt-1 font-medium" style={{ color: 'var(--jale-ink)' }}>
            {job.pay ?? t('jobs.pay_range_value', { min: job.pay_min ?? 0, max: job.pay_max ?? 0 })}
          </p>
        )}
      </div>

      <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>
        {job.location}
      </p>

      <p className="text-sm font-semibold" style={{ color: 'var(--jale-blue-600)' }}>
        {t('jobs.openings_count', { open: openCount, total: job.number_of_workers_needed })}
      </p>

      <p className="text-sm font-semibold" style={{ color: 'var(--jale-blue-600)' }}>
        {t('jobs.applicants_count', { count: job.applicant_count })}
      </p>

      <span
        className="pill"
        style={{ background: tone.bg, color: tone.color, border: job.status === 'closed' ? '1px solid var(--jale-divider)' : undefined }}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: tone.dot, marginRight: 4 }}
        />
        {t(`jobs.status.${job.status}`)}
      </span>

      <Link
        href={href}
        className="inline-flex h-9 items-center justify-center rounded-full border border-[var(--jale-divider)] bg-white px-4 text-xs font-semibold text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]"
      >
        {t('jobs.details')}
      </Link>
    </div>
  );
}
