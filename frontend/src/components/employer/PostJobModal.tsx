'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { JobPosting } from '@/lib/mockData'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  onClose: () => void
  onSubmit: (job: JobPosting) => void
}

export function PostJobModal({ open, onClose, onSubmit }: Props) {
  const t = useTranslations('employer_dashboard')

  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const [jobType, setJobType] = useState('Full-time')

  if (!open) return null

  function handleSubmit() {
    if (!title.trim() || !location.trim()) return
    const job: JobPosting = {
      id: crypto.randomUUID(),
      title,
      location,
      jobType: jobType as 'Full-time' | 'Part-time' | 'Contract',
      status: 'active',
      applicants: 0,
      postedAt: new Date().toISOString().split('T')[0],
    }
    onSubmit(job)
    setTitle('')
    setLocation('')
    setJobType('Full-time')
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <div className="bg-card rounded-2xl p-6 w-full max-w-md mx-4 flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-foreground">{t('modal.title')}</h2>

        <div className="flex flex-col gap-1">
          <label htmlFor="post-job-title" className="text-sm font-medium text-foreground">{t('modal.job_title')}</label>
          <Input
            id="post-job-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('modal.job_title')}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="post-job-location" className="text-sm font-medium text-foreground">{t('modal.location')}</label>
          <Input
            id="post-job-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={t('modal.location')}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="post-job-type" className="text-sm font-medium text-foreground">{t('modal.job_type')}</label>
          <select
            id="post-job-type"
            value={jobType}
            onChange={(e) => setJobType(e.target.value)}
            className="w-full min-h-[44px] rounded-[var(--radius-input)] border border-border bg-input px-3 py-2.5 text-sm text-foreground transition-[background-color,border-color,box-shadow] duration-200 focus:outline-none focus:bg-input-focus focus:border-primary focus:shadow-[var(--shadow-focus)]"
          >
            <option value="Full-time">{t('modal.job_type_fulltime')}</option>
            <option value="Part-time">{t('modal.job_type_parttime')}</option>
            <option value="Contract">{t('modal.job_type_contract')}</option>
          </select>
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="outline" onClick={onClose}>
            {t('modal.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!title.trim() || !location.trim()}>
            {t('modal.submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
