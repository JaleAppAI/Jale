'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { ApplicantFilters } from '@/lib/api/employer';

const SELECT_CLASS = [
  'min-h-[40px] w-full rounded-[var(--radius-input)]',
  'border border-[var(--jale-divider)] bg-[var(--jale-input)]',
  'px-3 text-sm font-medium text-[var(--jale-ink)]',
  'focus:outline-none focus:bg-white focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)]',
  'transition-all duration-150',
].join(' ');

const INPUT_CLASS = [
  'min-h-[40px] w-full rounded-[var(--radius-input)]',
  'border border-[var(--jale-divider)] bg-[var(--jale-input)]',
  'px-3 text-sm font-medium text-[var(--jale-ink)] placeholder:text-[var(--jale-placeholder)]',
  'focus:outline-none focus:bg-white focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)]',
  'transition-all duration-150',
].join(' ');

interface Props {
  filters: ApplicantFilters;
  onChange: (filters: ApplicantFilters) => void;
}

export function ApplicantFilterPanel({ filters, onChange }: Props) {
  const t = useTranslations('employer_dashboard');

  return (
    <div
      className="flex flex-wrap gap-3 items-end rounded-[var(--radius-input)] p-4 mb-4"
      style={{ background: 'var(--jale-paper-2)', border: '1px solid var(--jale-divider)' }}
    >
      <div className="flex flex-col gap-1 min-w-[140px]">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
          {t('filter.status')}
        </label>
        <select
          value={filters.status ?? ''}
          onChange={(e) => onChange({ ...filters, status: e.target.value || undefined })}
          className={SELECT_CLASS}
        >
          <option value="">{t('filter.status_all')}</option>
          <option value="pending">{t('applicants.status.pending')}</option>
          <option value="contacted">{t('applicants.status.contacted')}</option>
          <option value="talking">{t('applicants.status.talking')}</option>
          <option value="hired">{t('applicants.status.hired')}</option>
          <option value="not_interested">{t('applicants.status.not_interested')}</option>
        </select>
      </div>

      <div className="flex flex-col gap-1 min-w-[180px]">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
          {t('filter.skills')}
        </label>
        <input
          value={filters.skills ?? ''}
          onChange={(e) => onChange({ ...filters, skills: e.target.value || undefined })}
          placeholder={t('filter.skills_placeholder')}
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex flex-col gap-1 min-w-[140px]">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
          {t('filter.availability')}
        </label>
        <select
          value={filters.availability ?? ''}
          onChange={(e) => onChange({ ...filters, availability: e.target.value || undefined })}
          className={SELECT_CLASS}
        >
          <option value="">{t('filter.availability_any')}</option>
          <option value="full_time">{t('filter.availability_full_time')}</option>
          <option value="part_time">{t('filter.availability_part_time')}</option>
          <option value="weekends">{t('filter.availability_weekends')}</option>
          <option value="flexible">{t('filter.availability_flexible')}</option>
        </select>
      </div>

      <div className="flex flex-col gap-1 w-[110px]">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
          {t('filter.min_experience')}
        </label>
        <input
          type="number"
          min={0}
          value={filters.min_experience ?? ''}
          onChange={(e) =>
            onChange({ ...filters, min_experience: e.target.value ? Number(e.target.value) : undefined })
          }
          className={INPUT_CLASS}
        />
      </div>

      <Button variant="ghost" size="sm" onClick={() => onChange({})}>
        {t('filter.clear')}
      </Button>
    </div>
  );
}
