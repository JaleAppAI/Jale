'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { WorkerJobCard } from '@/components/worker/WorkerJobCard';
import { CityMultiSelect } from '@/components/ui/CityMultiSelect';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { getJobs, updateWorkerProfile } from '@/lib/api/worker';
import type { Job, PreferredCity } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

type TypeFilter = 'all' | 'full-time' | 'part-time' | 'contract';

// Chip labels come from the worker_home.filter.* message keys.
const FILTER_CHIPS: { value: TypeFilter; labelKey: 'all' | 'full_time' | 'part_time' | 'contract' }[] = [
  { value: 'all',       labelKey: 'all' },
  { value: 'full-time', labelKey: 'full_time' },
  { value: 'part-time', labelKey: 'part_time' },
  { value: 'contract',  labelKey: 'contract' },
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
  const [otherJobs, setOtherJobs] = useState<Job[]>([]);
  const [preferredCities, setPreferredCities] = useState<PreferredCity[]>([]);
  const [editingCities, setEditingCities] = useState(false);
  const [savingCities, setSavingCities] = useState(false);
  const [cityVersion, setCityVersion] = useState(0);
  const [saveCitiesError, setSaveCitiesError] = useState<string | null>(null);
  const hasLoadedJobs = useRef(false);
  // Last list we know the server has. `preferredCities` is the draft the panel
  // edits in place; closing the panel without saving restores from here.
  const savedCitiesRef = useRef<PreferredCity[]>([]);
  // Set once a PATCH has landed, so a slow mount-time profile GET can't
  // resolve afterwards and clobber the list the user just saved.
  const savedOnceRef = useRef(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);

    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    if (!idToken) return;
    let ignore = false;
    apiFetch('/worker/profile', {}, idToken)
      .then((res) => (res.ok ? res.json() : null))
      .then((profile) => {
        if (ignore || savedOnceRef.current) return;
        if (profile?.preferred_cities) {
          savedCitiesRef.current = profile.preferred_cities;
          setPreferredCities(profile.preferred_cities);
        }
      })
      .catch(() => {});
    return () => { ignore = true; };
  }, [idToken]);

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
        setOtherJobs(res.other_jobs ?? []);
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
  }, [idToken, debouncedSearch, jobType, cityVersion]);

  async function saveCities() {
    if (!idToken) return;
    setSavingCities(true);
    setSaveCitiesError(null);
    try {
      const updated = await updateWorkerProfile(idToken, { preferred_cities: preferredCities });
      // Trust the server's echo of the saved list over our local draft.
      const saved = updated?.preferred_cities ?? preferredCities;
      savedOnceRef.current = true;
      savedCitiesRef.current = saved;
      setPreferredCities(saved);
      setEditingCities(false);
      setCityVersion((v) => v + 1); // refetch the feed with the new filter
    } catch {
      // Keep the panel open with the draft intact so the user can retry.
      setSaveCitiesError(tCommon('error'));
    } finally {
      setSavingCities(false);
    }
  }

  // Opening starts a fresh draft from the saved list; closing without saving
  // throws the draft away so the chips never show unpersisted cities.
  function toggleEditCities() {
    // Never let a cancel race an in-flight PATCH: reverting mid-save would
    // show the old chips while the server filters by the new list.
    if (savingCities) return;
    setSaveCitiesError(null);
    if (editingCities) {
      setPreferredCities(savedCitiesRef.current);
      setEditingCities(false);
    } else {
      setEditingCities(true);
    }
  }

  if (error) {
    return (
      <AppShell role="worker" title={t('title')}>
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4">
          <p className="text-sm" style={{ color: 'var(--jale-danger)' }}>{error}</p>
        </main>
      </AppShell>
    );
  }

  return (
    <AppShell role="worker" title={t('title')}>
      <main className="mx-auto max-w-2xl px-4 py-6 md:px-6">
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

        {/* Preferred cities */}
        <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1">
          {preferredCities.length === 0 ? (
            <span className="rounded-full border border-[var(--jale-divider)] bg-white px-3.5 py-1.5 text-xs font-semibold text-[var(--jale-ink-2)] whitespace-nowrap">
              {t('cities_all')}
            </span>
          ) : (
            preferredCities.map((c) => (
              <span
                key={c.city_key}
                className="rounded-full px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap text-white"
                style={{ background: 'var(--jale-blue-500)' }}
              >
                {c.city}, {c.state}
              </span>
            ))
          )}
          <button
            onClick={toggleEditCities}
            disabled={savingCities}
            aria-expanded={editingCities}
            className="rounded-full border border-[var(--jale-divider)] bg-white px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap text-[var(--jale-ink-2)] disabled:opacity-50"
            style={{ cursor: savingCities ? 'not-allowed' : 'pointer' }}
          >
            {t('cities_edit')}
          </button>
        </div>
        {editingCities && (
          <div className="mb-4 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-white p-3 space-y-3">
            {/* keyed so a save (or a cancel-then-reopen) remounts the field and
                drops any typed-but-unpicked text — see CityMultiSelect docs */}
            <CityMultiSelect key={cityVersion} value={preferredCities} onChange={setPreferredCities} />
            <div className="flex items-center justify-end gap-3">
              {saveCitiesError && (
                <p role="alert" className="text-xs" style={{ color: 'var(--jale-danger)' }}>
                  {saveCitiesError}
                </p>
              )}
              <Button onClick={saveCities} loading={savingCities} loadingLabel={tCommon('loading')}>
                {t('cities_done')}
              </Button>
            </div>
          </div>
        )}

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
              {t(`filter.${chip.labelKey}`)}
            </button>
          ))}
        </div>

        {/* Results */}
        <DashboardPanel className="p-4 md:p-5">
          {loading ? (
            <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>{tCommon('loading')}</p>
          ) : (
            <>
              {jobs.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--jale-ink-2)' }}>{t('empty')}</p>
              ) : (
                <>
                  <p
                    className="text-xs font-semibold mb-3"
                    style={{ color: 'var(--jale-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}
                  >
                    {t('results_count', { count: jobs.length })}
                  </p>
                  <div className="flex flex-col gap-2.5">
                    {jobs.map((job) => (
                      <WorkerJobCard key={job.id} job={job} href={`/worker/jobs/${job.id}`} />
                    ))}
                  </div>
                </>
              )}
              {otherJobs.length > 0 && (
                <div className="mt-6">
                  <p
                    className="text-xs font-semibold mb-3"
                    style={{ color: 'var(--jale-ink-2)', letterSpacing: '.04em', textTransform: 'uppercase' }}
                  >
                    {t('other_jobs_header')}
                  </p>
                  <div className="flex flex-col gap-2.5">
                    {otherJobs.map((job) => (
                      <WorkerJobCard key={job.id} job={job} href={`/worker/jobs/${job.id}`} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </DashboardPanel>
      </main>
    </AppShell>
  );
}
