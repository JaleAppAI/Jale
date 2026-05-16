'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { WorkerJobCard } from '@/components/worker/WorkerJobCard';
import { getJobs } from '@/lib/api/worker';
import type { Job } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

type TypeFilter = 'all' | 'full-time' | 'part-time' | 'contract';

const FILTER_CHIPS: { value: TypeFilter; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'full-time', label: 'Full-time' },
  { value: 'part-time', label: 'Part-time' },
  { value: 'contract',  label: 'Contract' },
];

export default function WorkerHomePage() {
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_home');
  const tCommon = useTranslations('common');

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [jobType, setJobType] = useState<TypeFilter>('all');
  const hasLoadedJobs = useRef(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);

    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    if (!idToken) return;
    let ignore = false;
    setLoading(!hasLoadedJobs.current);
    const filters: { search?: string; job_type?: string } = {};
    if (debouncedSearch) filters.search = debouncedSearch;
    if (jobType !== 'all') filters.job_type = jobType;
    getJobs(idToken, filters)
      .then((res) => {
        if (ignore) return;
        hasLoadedJobs.current = true;
        setJobs(res.jobs);
      })
      .catch((err) => {
        if (ignore) return;
        try { handleLegalWall(err, '/worker/home'); }
        catch { setError(tCommon('error')); }
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [idToken, debouncedSearch, jobType]);

  if (error) {
    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
        <p className="text-sm" style={{ color: 'var(--jale-danger)' }}>{error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      {/* Header row */}
      <div className="mb-5">
        <h1
          className="font-semibold leading-tight"
          style={{ fontSize: '1.15rem', letterSpacing: '-0.02em', color: 'var(--jale-ink)' }}
        >
          {t('title')}
        </h1>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <svg
          className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
          width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="var(--jale-ink-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          className="w-full min-h-[44px] rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-input)] pl-10 pr-4 py-2.5 text-sm font-medium text-[var(--jale-ink)] placeholder:text-[var(--jale-placeholder)] focus:outline-none focus:bg-white focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)] transition-all duration-150"
          placeholder={t('search_placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
        {FILTER_CHIPS.map((chip) => (
          <button
            key={chip.value}
            onClick={() => setJobType(chip.value)}
            className="rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all duration-150 border"
            style={{
              background: jobType === chip.value ? 'var(--jale-blue-500)' : 'white',
              color:      jobType === chip.value ? '#fff'                   : 'var(--jale-ink-2)',
              border:     `1px solid ${jobType === chip.value ? 'transparent' : 'var(--jale-divider)'}`,
              cursor: 'pointer',
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Results */}
      {loading ? (
        <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>{tCommon('loading')}</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>{t('empty')}</p>
      ) : (
        <>
          <p
            className="text-xs font-semibold mb-3"
            style={{ color: 'var(--jale-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}
          >
            {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} found
          </p>
          <div className="flex flex-col gap-2.5">
            {jobs.map((job) => (
              <WorkerJobCard key={job.id} job={job} href={`/worker/jobs/${job.id}`} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
