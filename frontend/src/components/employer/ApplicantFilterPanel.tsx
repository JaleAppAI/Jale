'use client';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { ApplicantFilters } from '@/lib/api/employer';

interface Props {
  filters: ApplicantFilters;
  onChange: (filters: ApplicantFilters) => void;
}

export function ApplicantFilterPanel({ filters, onChange }: Props) {
  const t = useTranslations('employer_dashboard');

  return (
    <div className="flex flex-wrap gap-3 items-end p-4 bg-muted/30 rounded-lg mb-4">
      <div className="flex flex-col gap-1 min-w-[140px]">
        <label className="text-xs font-medium text-muted-foreground">{t('filter.status')}</label>
        <select
          value={filters.status ?? ''}
          onChange={(e) => onChange({ ...filters, status: e.target.value || undefined })}
          className="min-h-[36px] rounded border border-border bg-input px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">{t('filter.status_all')}</option>
          <option value="pending">{t('applicants.status.pending')}</option>
          <option value="reviewed">{t('applicants.status.reviewed')}</option>
          <option value="hired">{t('applicants.status.hired')}</option>
          <option value="rejected">{t('applicants.status.rejected')}</option>
        </select>
      </div>

      <div className="flex flex-col gap-1 min-w-[180px]">
        <label className="text-xs font-medium text-muted-foreground">{t('filter.skills')}</label>
        <Input
          value={filters.skills ?? ''}
          onChange={(e) => onChange({ ...filters, skills: e.target.value || undefined })}
          placeholder={t('filter.skills_placeholder')}
          className="h-[36px] text-sm"
        />
      </div>

      <div className="flex flex-col gap-1 min-w-[140px]">
        <label className="text-xs font-medium text-muted-foreground">{t('filter.availability')}</label>
        <select
          value={filters.availability ?? ''}
          onChange={(e) => onChange({ ...filters, availability: e.target.value || undefined })}
          className="min-h-[36px] rounded border border-border bg-input px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">{t('filter.availability_any')}</option>
          <option value="immediate">{t('filter.availability_immediate')}</option>
          <option value="2-weeks">{t('filter.availability_2weeks')}</option>
          <option value="1-month">{t('filter.availability_1month')}</option>
        </select>
      </div>

      <div className="flex flex-col gap-1 w-[120px]">
        <label className="text-xs font-medium text-muted-foreground">{t('filter.min_experience')}</label>
        <Input
          type="number"
          min={0}
          value={filters.min_experience ?? ''}
          onChange={(e) =>
            onChange({ ...filters, min_experience: e.target.value ? Number(e.target.value) : undefined })
          }
          className="h-[36px] text-sm"
        />
      </div>

      <Button variant="outline" size="sm" onClick={() => onChange({})} className="self-end">
        {t('filter.clear')}
      </Button>
    </div>
  );
}
