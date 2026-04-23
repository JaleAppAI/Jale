'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/contexts/AuthContext'
import { createJob } from '@/lib/api/employer'
import type { Job } from '@/lib/api/employer'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  onClose: () => void
  onJobCreated: (job: Job) => void
}

export function PostJobModal({ open, onClose, onJobCreated }: Props) {
  const t = useTranslations('employer_dashboard')
  const tCommon = useTranslations('common')
  const { idToken } = useAuth()

  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const [jobType, setJobType] = useState<'full-time' | 'part-time' | 'contract'>('full-time')
  const [jobDescription, setJobDescription] = useState('');
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  async function handleSubmit() {
    if (!title.trim() || !location.trim() || !idToken) return
    setLoading(true)
    setError(null)
    try {
      const job = await createJob(idToken, { title, location, job_type: jobType, description: jobDescription })
      setTitle('')
      setLocation('')
      setJobType('full-time')
      setJobDescription('')
      onJobCreated(job)
    } catch {
      setError(t('modal.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <div className="bg-card rounded-2xl p-6 w-full max-w-xl mx-4 flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-foreground">{t('modal.title')}</h2>

        {error && <p className="text-sm text-error">{error}</p>}

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
            onChange={(e) => setJobType(e.target.value as 'full-time' | 'part-time' | 'contract')}
            className="w-full min-h-[44px] rounded-[var(--radius-input)] border border-border bg-input px-3 py-2.5 text-sm text-foreground transition-[background-color,border-color,box-shadow] duration-200 focus:outline-none focus:bg-input-focus focus:border-primary focus:shadow-[var(--shadow-focus)]"
          >
            <option value="full-time">{t('modal.job_type_fulltime')}</option>
            <option value="part-time">{t('modal.job_type_parttime')}</option>
            <option value="contract">{t('modal.job_type_contract')}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="post-job-description" className="text-sm font-medium text-foreground over text-ellipsis">{t('modal.job_description')}</label>
          <textarea
            id="post-job-description"
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            placeholder={t('modal.job_description')}
            className="w-full min-h-[44px] rounded-[var(--radius-input)] border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-placeholder transition-[background-color,border-color,box-shadow] duration-200 focus:outline-none focus:bg-input-focus focus:border-primary focus:shadow-[var(--shadow-focus)] disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!title.trim() || !location.trim() || loading}
          >
            {loading ? tCommon('loading') : t('modal.submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
