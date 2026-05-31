'use client';
import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JobPostingCard } from '@/components/employer/JobPostingCard';
import { PostJobModal } from '@/components/employer/PostJobModal';
import { getJobs } from '@/lib/api/employer';
import type { Job } from '@/lib/api/employer';
import type { JobStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

export default function EmployerDashboardPage() {
    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const t = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');

    const [jobs, setJobs] = useState<Job[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');

    useEffect(() => {
        if (!idToken) return;
        setLoading(true);
        getJobs(idToken)
            .then(setJobs)
            .catch((err) => {
                try {
                    handleLegalWall(err, '/employer/dashboard');
                } catch {
                    setError(tCommon('error'));
                }
            })
            .finally(() => setLoading(false));
    }, [idToken]);

    const filteredJobs = useMemo(() => {
        let result = jobs;
        if (statusFilter !== 'all') result = result.filter((job) => job.status === statusFilter);
        if (!search.trim()) return result;
        const q = search.toLowerCase();
        return result.filter(j =>
            j.title.toLowerCase().includes(q) || j.location.toLowerCase().includes(q)
        );
    }, [jobs, search, statusFilter]);

    const activeCount = jobs.filter(j => j.status === 'active').length;
    const pausedCount = jobs.filter(j => j.status === 'paused').length;
    const filledCount = jobs.filter(j => j.status === 'filled').length;
    const totalApplicants = jobs.reduce((sum, j) => sum + j.applicant_count, 0);

    function handleJobCreated(job: Job) {
        setJobs(prev => [job, ...prev]);
        setModalOpen(false);
    }

    if (error) {
        return (
            <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
                <p className="text-sm text-error">{error}</p>
            </main>
        );
    }

    return (
        <>
            <main className="mx-auto max-w-5xl px-4 py-10">
                <div className="grid grid-cols-2 gap-4 mb-8 md:grid-cols-4">
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.active_jobs')}</p>
                        <p className="text-2xl font-bold">{loading ? '-' : activeCount}</p>
                    </Card>
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.paused_jobs')}</p>
                        <p className="text-2xl font-bold">{loading ? '-' : pausedCount}</p>
                    </Card>
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.filled_jobs')}</p>
                        <p className="text-2xl font-bold">{loading ? '-' : filledCount}</p>
                    </Card>
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.total_applicants')}</p>
                        <p className="text-2xl font-bold">{loading ? '-' : totalApplicants}</p>
                    </Card>
                </div>

                <div className="mb-8">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold">{t('jobs.title')}</h2>
                        <Button onClick={() => setModalOpen(true)}>{t('jobs.post_job')}</Button>
                    </div>
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t('jobs.search_placeholder')}
                        className="mb-4"
                    />
                    <div className="mb-4 flex flex-wrap gap-2">
                        {(['all', 'active', 'paused', 'filled', 'closed'] as const).map((status) => (
                            <button
                                key={status}
                                type="button"
                                onClick={() => setStatusFilter(status)}
                                className="rounded-full border px-3 py-1.5 text-xs font-semibold"
                                style={{
                                    borderColor: statusFilter === status ? 'var(--jale-blue-500)' : 'var(--jale-divider)',
                                    background: statusFilter === status ? 'var(--jale-blue-50)' : 'white',
                                    color: statusFilter === status ? 'var(--jale-blue-700)' : 'var(--jale-ink)',
                                }}
                            >
                                {status === 'all' ? t('jobs.status.all') : t(`jobs.status.${status}`)}
                            </button>
                        ))}
                    </div>
                    {loading ? (
                        <p className="text-sm text-muted">{tCommon('loading')}</p>
                    ) : (
                        <div className="space-y-3">
                            {filteredJobs.map((job, index) => (
                                <JobPostingCard
                                    key={job.id}
                                    job={job}
                                    href={`/employer/jobs/${job.id}`}
                                    isLast={index === filteredJobs.length - 1}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </main>
            <PostJobModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onJobCreated={handleJobCreated}
            />
        </>
    );
}
