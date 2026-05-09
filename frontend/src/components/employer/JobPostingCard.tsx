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
    <Link href={href}>
      <div
        className="grid px-5 py-4 items-center hover:bg-[var(--jale-blue-50)] transition-colors duration-100 cursor-pointer"
        style={{
          gridTemplateColumns: '2fr 1fr 1fr auto',
          borderBottom: isLast ? 'none' : '1px solid var(--jale-divider)',
        }}
      >
        {/* Job title + posted date */}
        <div>
          <p className="font-semibold text-sm" style={{ color: 'var(--jale-ink)' }}>
            {job.title}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--jale-ink-2)' }}>
            Posted {postedDate}
          </p>
        </div>

        {/* Location */}
        <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>
          {job.location}
        </p>

        {/* Applicants */}
        <p className="text-sm font-semibold" style={{ color: 'var(--jale-blue-600)' }}>
          {job.applicant_count} {t('jobs.applicants_count', { count: job.applicant_count }).replace(String(job.applicant_count), '').trim() || ''}
          <span className="font-normal ml-1 text-xs" style={{ color: 'var(--jale-ink-2)' }}>
            {job.applicant_count === 1 ? 'applicant' : 'applicants'}
          </span>
        </p>

        {/* Status pill */}
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
      </div>
    </Link>
  );
}
