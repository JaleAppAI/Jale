'use client'

import { useTranslations, useLocale } from 'next-intl'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { JobPosting } from '@/lib/mockData'

interface Props {
  job: JobPosting
  onToggle: (id: string) => void
}

export function JobPostingCard({ job, onToggle }: Props) {
  const t = useTranslations('employer_dashboard')
  const locale = useLocale()

  const isActive = job.status === 'active'
  const postedDate = new Date(job.postedAt).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold leading-tight">{job.title}</h3>
        <span
          className={[
            'rounded-full px-2 py-0.5 text-xs font-medium shrink-0',
            isActive
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-100 text-gray-500',
          ].join(' ')}
        >
          {isActive ? t('jobs.active') : t('jobs.closed')}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{job.location}</p>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('jobs.applicants_count', { count: job.applicants })}</span>
        <span>{t('jobs.posted')}: {postedDate}</span>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => onToggle(job.id)}
        className="self-start"
      >
        {isActive ? t('jobs.toggle.close') : t('jobs.toggle.activate')}
      </Button>
    </Card>
  )
}
