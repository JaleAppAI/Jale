'use client'

import { useTranslations, useLocale } from 'next-intl'
import { Card } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import type { Job } from '@/lib/api/employer'

interface Props {
  job: Job
  href: string
}

export function JobPostingCard({ job, href }: Props) {
  const t = useTranslations('employer_dashboard')
  const locale = useLocale()

  const isActive = job.status === 'active'
  const postedDate = new Date(job.created_at).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  return (
    <Link href={href}>
      <Card className="p-4 flex flex-col gap-3 hover:shadow-md transition-shadow cursor-pointer">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold leading-tight">{job.title}</h3>
          <span
            className={[
              'rounded-full px-2 py-0.5 text-xs font-medium shrink-0',
              isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500',
            ].join(' ')}
          >
            {isActive ? t('jobs.active') : t('jobs.closed')}
          </span>
        </div>

        <p className="text-sm text-muted-foreground">{job.location}</p>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('jobs.applicants_count', { count: job.applicant_count })}</span>
          <span>{t('jobs.posted')}: {postedDate}</span>
        </div>
      </Card>
    </Link>
  )
}
