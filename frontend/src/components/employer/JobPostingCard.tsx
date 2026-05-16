'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { Job } from '@/lib/api/employer';

interface Props {
  job: Job;
  href: string;
  isLast?: boolean;
}

export function JobPostingCard({ job, href, isLast }: Props) {
  const t = useTranslations('employer_dashboard');
  const locale = useLocale();

  const isActive = job.status === 'active';
  const postedDate = new Date(job.created_at).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div
      className="grid grid-cols-1 gap-3 px-5 py-4 items-start hover:bg-[var(--jale-blue-50)] transition-colors duration-100 md:grid-cols-[minmax(0,2fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_auto_auto] md:items-center"
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
      </div>

      <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>
        {job.location}
      </p>

      <p className="text-sm font-semibold" style={{ color: 'var(--jale-blue-600)' }}>
        {t('jobs.applicants_count', { count: job.applicant_count })}
      </p>

      <span
        className="pill"
        style={isActive
          ? { background: 'var(--jale-success-bg)', color: '#1f7a44' }
          : { background: 'var(--jale-paper-2)', color: 'var(--jale-ink-2)', border: '1px solid var(--jale-divider)' }
        }
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: isActive ? 'var(--jale-success)' : 'var(--jale-ink-2)', marginRight: 4 }}
        />
        {isActive ? t('jobs.active') : t('jobs.closed')}
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
