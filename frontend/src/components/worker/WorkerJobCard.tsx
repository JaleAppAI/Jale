'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import type { Job } from '@/lib/api/worker';

const DOC_LABELS: Record<string, string> = {
  resume: 'Resume',
  driver_license: "Driver's License",
  ssn: 'SSN',
};

function jobTypeLabel(type: string) {
  if (type === 'full-time') return '40 hrs/wk';
  if (type === 'part-time') return 'Part-time';
  return type.replace('-', ' ');
}

function getInitials(name: string) {
  return name.split(/\s+/).map((word) => word[0]).join('').toUpperCase().slice(0, 2);
}

export function WorkerJobCard({ job, href }: { job: Job; href: string }) {
  const t = useTranslations('worker_home');
  const initials = getInitials(job.company_name ?? 'JB');
  const pay = job.pay && job.pay !== 'Pay not specified' ? job.pay : null;

  return (
    <Link href={href} className="block">
      <Card
        className="p-4 flex gap-3 items-start transition-shadow hover:shadow-md"
        style={{ cursor: 'pointer' }}
      >
        <span
          className="avatar-initials square flex-shrink-0"
          style={{ width: 44, height: 44, fontSize: 15, background: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)', borderRadius: 12 }}
        >
          {initials}
        </span>

        <div className="flex-1 min-w-0">
          <p className="font-semibold leading-snug" style={{ fontSize: 14, color: 'var(--jale-ink)' }}>
            {job.title}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--jale-ink-2)' }}>
            {job.company_name}
            {job.location ? ` - ${job.location}` : ''}
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5 text-xs" style={{ color: 'var(--jale-ink-2)' }}>
            {pay && <span>{pay}</span>}
            {job.start_date && <span>{job.start_date}</span>}
            {job.shift_schedule && <span>{job.shift_schedule}</span>}
            {job.open_count != null && job.number_of_workers_needed != null && (
              <span>{t('openings_count', { open: job.open_count, total: job.number_of_workers_needed })}</span>
            )}
          </div>

          {job.required_docs.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {job.required_docs.map((doc) => (
                <span
                  key={doc}
                  className="pill pill-info"
                  style={{ fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase' }}
                >
                  {DOC_LABELS[doc] ?? doc}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span
            className="rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize"
            style={{ background: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)' }}
          >
            {jobTypeLabel(job.job_type)}
          </span>
        </div>
      </Card>
    </Link>
  );
}
