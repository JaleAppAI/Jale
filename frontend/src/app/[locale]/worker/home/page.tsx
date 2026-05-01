'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Input } from '@/components/ui/input';
import { WorkerJobCard } from '@/components/worker/WorkerJobCard';
import { getJobs } from '@/lib/api/worker';
import type { Job } from '@/lib/api/worker';

type TypeFilter = 'all' | 'full-time' | 'part-time' | 'contract';

export default function WorkerHomePage() {
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_home');
  const tCommon = useTranslations('common');

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [jobType, setJobType] = useState<TypeFilter>('all');

  useEffect(() => {
    if (!idToken) return;
    setLoading(true);
    const filters: { search?: string; job_type?: string } = {};
    if (search.trim()) filters.search = search.trim();
    if (jobType !== 'all') filters.job_type = jobType;
    getJobs(idToken, filters)
      .then((res) => setJobs(res.jobs))
      .catch((err) => {
        try { handleLegalWall(err, '/worker/home'); }
        catch { setError(tCommon('error')); }
      })
      .finally(() => setLoading(false));
  }, [idToken, search, jobType]);

  if (error) {
    return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-error">{error}</p></main>;
  }

  const chips: TypeFilter[] = ['all', 'full-time', 'part-time', 'contract'];

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-[1.4rem] md:text-[1.7rem] font-bold tracking-[-0.03em] leading-[1.2] mb-6">{t('title')}</h1>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('search_placeholder')}
        className="mb-4"
      />
      <div className="flex flex-wrap gap-2 mb-6">
        {chips.map((c) => (
          <button
            key={c}
            onClick={() => setJobType(c)}
            className={[
              'rounded-full px-3 py-1 text-xs',
              jobType === c ? 'bg-blue-900 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80',
            ].join(' ')}
          >
            {t(`filter.${c.replace('-', '_')}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-muted">{tCommon('loading')}</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted">{t('empty')}</p>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <WorkerJobCard key={job.id} job={job} href={`/worker/jobs/${job.id}`} />
          ))}
        </div>
      )}
    </main>
  );
}
