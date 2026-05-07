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
        if (!search.trim()) return jobs;
        const q = search.toLowerCase();
        return jobs.filter(j =>
            j.title.toLowerCase().includes(q) || j.location.toLowerCase().includes(q)
        );
    }, [jobs, search]);

    const activeCount = jobs.filter(j => j.status === 'active').length;
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
                <div className="grid grid-cols-2 gap-4 mb-8">
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.active_jobs')}</p>
                        <p className="text-2xl font-bold">{loading ? '—' : activeCount}</p>
                    </Card>
                    <Card className="p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.total_applicants')}</p>
                        <p className="text-2xl font-bold">{loading ? '—' : totalApplicants}</p>
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
                    {loading ? (
                        <p className="text-sm text-muted">{tCommon('loading')}</p>
                    ) : (
                        <div className="space-y-3">
                            {filteredJobs.map(job => (
                                <JobPostingCard
                                    key={job.id}
                                    job={job}
                                    href={`/employer/jobs/${job.id}`}
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
