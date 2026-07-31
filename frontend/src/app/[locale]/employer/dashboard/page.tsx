'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/ui/icon';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { MetricCard } from '@/components/ui/metric-card';
import { ProgressRow } from '@/components/ui/progress-row';
import { JobPostingCard } from '@/components/employer/JobPostingCard';
import { PostJobModal } from '@/components/employer/PostJobModal';
import { DeleteJobDialog } from '@/components/employer/DeleteJobDialog';
import { ApiError, deleteJob, getJobs } from '@/lib/api/employer';
import type { Job } from '@/lib/api/employer';
import type { JobStatus } from '@/lib/status';

const statusFilters = ['all', 'active', 'paused', 'filled', 'closed'] as const;

export default function EmployerDashboardPage() {
    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const t = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [jobs, setJobs] = useState<Job[]>([]);
    const [jobToDelete, setJobToDelete] = useState<Job | null>(null);
    const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');

    useEffect(() => {
        if (!idToken) return;
        setLoading(true);
        getJobs(idToken)
            .then((nextJobs) => {
                setJobs(nextJobs);
            })
            .catch((err) => {
                try {
                    handleLegalWall(err, '/employer/dashboard');
                } catch {
                    setError(tCommon('error'));
                }
            })
            .finally(() => setLoading(false));
    }, [handleLegalWall, idToken, tCommon]);

    const filteredJobs = useMemo(() => {
        let result = jobs;
        if (statusFilter !== 'all') result = result.filter((job) => job.status === statusFilter);
        if (!search.trim()) return result;
        const q = search.toLowerCase();
        return result.filter((job) =>
            job.title.toLowerCase().includes(q) ||
            job.location.toLowerCase().includes(q) ||
            (job.trade_category ?? '').toLowerCase().includes(q)
        );
    }, [jobs, search, statusFilter]);

    const activeCount = jobs.filter((job) => job.status === 'active').length;
    const pausedCount = jobs.filter((job) => job.status === 'paused').length;
    const filledCount = jobs.filter((job) => job.status === 'filled').length;
    const closedCount = jobs.filter((job) => job.status === 'closed').length;
    const totalApplicants = jobs.reduce((sum, job) => sum + job.applicant_count, 0);
    const totalHired = jobs.reduce((sum, job) => sum + (job.hired_count ?? 0), 0);
    const totalOpenings = jobs.reduce((sum, job) => sum + (job.number_of_workers_needed ?? 0), 0);
    const openRoles = jobs.reduce((sum, job) => sum + (job.open_count ?? 0), 0);
    const hireProgress = totalOpenings > 0 ? Math.round((totalHired / totalOpenings) * 100) : 0;
    const applicantDensity = activeCount > 0 ? Math.round(totalApplicants / activeCount) : 0;
    const featuredJobs = filteredJobs.slice(0, 5);
    const recentJob = jobs[0];

    // `new Date()` must NOT be formatted during render: the server (Lambda, UTC) and the
    // browser (user's local timezone) can land on different calendar days, producing
    // different strings and a hydration mismatch (React #418/#423/#425). Compute it after
    // mount so the server HTML and the client's first render agree (empty), then fill in.
    const [todayLabel, setTodayLabel] = useState('');
    useEffect(() => {
        setTodayLabel(
            new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
            }).format(new Date()),
        );
    }, [locale]);

    function handleJobCreated(job: Job) {
        setJobs((prev) => [job, ...prev]);
        setModalOpen(false);
    }

    function openDeleteDialog(job: Job) {
        setDeletingJobId(null);
        setDeleteError(null);
        setJobToDelete(job);
    }

    function closeDeleteDialog() {
        setDeletingJobId(null);
        setDeleteError(null);
        setJobToDelete(null);
    }

    async function handleConfirmDelete() {
        if (!idToken || !jobToDelete || deletingJobId) return;

        const target = jobToDelete;
        setDeletingJobId(target.id);
        setDeleteError(null);
        try {
            await deleteJob(idToken, target.id);
            setJobs((cur) => cur.filter((job) => job.id !== target.id));
            closeDeleteDialog();
        } catch (err) {
            if (err instanceof ApiError && err.code === 'job_has_hired_workers') {
                setDeleteError(t('jobs.delete.error_hired'));
            } else {
                setDeleteError(t('jobs.delete.error_generic'));
            }
        } finally {
            setDeletingJobId(null);
        }
    }

    if (error) {
        return (
            <AppShell role="employer" title={t('shell.title')} subtitle={todayLabel}>
                <main className="flex min-h-screen items-center justify-center bg-[var(--jale-paper)] px-4">
                    <div className="rounded-2xl border border-[var(--jale-divider)] bg-white p-6 text-center shadow-[var(--shadow-card)]">
                        <p className="text-sm font-semibold text-error">{error}</p>
                    </div>
                </main>
            </AppShell>
        );
    }

    return (
        <>
            <AppShell
                role="employer"
                title={t('shell.title')}
                subtitle={todayLabel}
                actions={
                    <Button onClick={() => setModalOpen(true)} className="h-10">
                        <Icon name="plus" />
                        {t('jobs.post_job')}
                    </Button>
                }
            >
                <div className="mx-auto max-w-[1380px] px-4 py-6 pb-24 md:px-6">
                    <section className="mb-5 overflow-hidden rounded-3xl bg-[#111642] text-white shadow-[var(--shadow-card)]">
                        <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1.4fr)_minmax(280px,.9fr)] md:p-7">
                            <div>
                                <p className="mb-2 inline-flex rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase text-white/70">{t('hero.eyebrow')}</p>
                                <h2 className="text-3xl font-extrabold leading-tight md:text-4xl">{t('hero.title')}</h2>
                                <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">{t('hero.body')}</p>
                            </div>
                            <div className="rounded-2xl border border-white/10 bg-white/[0.08] p-4">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-bold">{t('panels.whatsapp_title')}</p>
                                    <Link href="/employer/conversations" className="text-xs font-bold text-white/75 hover:text-white hover:underline">{t('panels.open_messages')}</Link>
                                </div>
                                <div className="mt-4 rounded-2xl bg-white/10 p-4">
                                    <p className="text-sm font-bold">{recentJob?.title ?? t('panels.no_recent_job')}</p>
                                    <p className="mt-2 text-xs leading-5 text-white/70">{t('panels.whatsapp_body')}</p>
                                </div>
                                <Link
                                    href="/employer/conversations"
                                    className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-[var(--jale-blue-500)] px-4 text-xs font-bold text-white hover:bg-[var(--jale-blue-600)]"
                                >
                                    <Icon name="message" />
                                    {t('panels.open_messages')}
                                </Link>
                            </div>
                        </div>
                    </section>

                    <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <MetricCard label={t('stats.active_jobs')} value={loading ? '-' : activeCount} hint={t('stats.active_hint')} />
                        <MetricCard label={t('stats.total_applicants')} value={loading ? '-' : totalApplicants} hint={t('stats.applicants_hint', { count: applicantDensity })} tone="teal" />
                        <MetricCard label={t('stats.workers_hired')} value={loading ? '-' : totalHired} hint={t('stats.hired_hint', { count: openRoles })} tone="ink" />
                        <MetricCard label={t('stats.paused_closed')} value={loading ? '-' : pausedCount + closedCount + filledCount} hint={t('stats.paused_closed_hint', { paused: pausedCount, closed: closedCount, filled: filledCount })} tone="amber" />
                    </div>

                    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,.8fr)]">
                        <div className="space-y-5">
                            <DashboardPanel>
                                <PanelHeader
                                    title={t('jobs.title')}
                                    action={<Button size="sm" onClick={() => setModalOpen(true)}><Icon name="plus" />{t('jobs.post_job')}</Button>}
                                />
                                <div className="p-5">
                                    <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                                        <Input
                                            value={search}
                                            onChange={(e) => setSearch(e.target.value)}
                                            placeholder={t('jobs.search_placeholder')}
                                        />
                                        <div className="flex flex-wrap gap-2">
                                            {statusFilters.map((status) => (
                                                <button
                                                    key={status}
                                                    type="button"
                                                    onClick={() => setStatusFilter(status)}
                                                    className="rounded-full border px-3 py-1.5 text-xs font-bold"
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
                                    </div>

                                    {loading ? (
                                        <p className="rounded-2xl bg-[var(--jale-paper-2)] p-5 text-sm font-semibold text-[var(--jale-ink-2)]">{tCommon('loading')}</p>
                                    ) : featuredJobs.length > 0 ? (
                                        <div className="overflow-hidden rounded-2xl border border-[var(--jale-divider)]">
                                            {featuredJobs.map((job, index) => (
                                                <JobPostingCard
                                                    key={job.id}
                                                    job={job}
                                                    href={`/employer/jobs/${job.id}`}
                                                    isLast={index === featuredJobs.length - 1}
                                                    onDelete={openDeleteDialog}
                                                />
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="rounded-2xl border border-dashed border-[var(--jale-divider)] bg-[var(--jale-paper-2)] p-8 text-center">
                                            <p className="text-sm font-bold text-[var(--jale-ink)]">{t('jobs.empty_title')}</p>
                                            <p className="mt-2 text-sm text-[var(--jale-ink-2)]">{t('jobs.empty_body')}</p>
                                            <Button onClick={() => setModalOpen(true)} className="mt-5">
                                                <Icon name="plus" />
                                                {t('jobs.post_job')}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </DashboardPanel>

                            <DashboardPanel>
                                <PanelHeader title={t('quick_post.title')} />
                                <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                                    <div>
                                        <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('quick_post.body')}</p>
                                        <p className="mt-2 text-xs leading-5 text-[var(--jale-ink-2)]">{t('quick_post.hint')}</p>
                                    </div>
                                    <Button onClick={() => setModalOpen(true)}>
                                        <Icon name="plus" />
                                        {t('quick_post.cta')}
                                    </Button>
                                </div>
                            </DashboardPanel>

                        </div>

                        <div className="space-y-5">
                            <DashboardPanel className="!bg-[#111642] text-white">
                                <PanelHeader title={t('panels.trust_title')} />
                                <div className="space-y-4 p-5">
                                    <div className="rounded-2xl bg-white/10 p-4">
                                        <p className="text-4xl font-extrabold">{loading ? '-' : `${hireProgress}%`}</p>
                                        <p className="mt-1 text-xs font-semibold uppercase text-white/55">{t('panels.hiring_progress')}</p>
                                    </div>
                                    <ProgressRow label={t('panels.open_roles')} value={String(loading ? '-' : openRoles)} percent={Math.min(100, openRoles * 12)} />
                                    <ProgressRow label={t('panels.applicant_flow')} value={String(loading ? '-' : totalApplicants)} percent={Math.min(100, totalApplicants * 5)} />
                                    <p className="text-xs leading-5 text-white/60">{t('panels.trust_body')}</p>
                                </div>
                            </DashboardPanel>

                            <DashboardPanel>
                                <PanelHeader title={t('panels.hiring_status_title')} />
                                <div className="space-y-4 p-5">
                                    <ProgressRow label={t('jobs.status.active')} value={String(loading ? '-' : activeCount)} percent={jobs.length ? (activeCount / jobs.length) * 100 : 0} />
                                    <ProgressRow label={t('jobs.status.paused')} value={String(loading ? '-' : pausedCount)} percent={jobs.length ? (pausedCount / jobs.length) * 100 : 0} />
                                    <ProgressRow label={t('jobs.status.filled')} value={String(loading ? '-' : filledCount)} percent={jobs.length ? (filledCount / jobs.length) * 100 : 0} />
                                </div>
                            </DashboardPanel>
                        </div>
                    </div>
                </div>
            </AppShell>

            <PostJobModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onJobCreated={handleJobCreated}
            />

            <DeleteJobDialog
                key={jobToDelete?.id ?? 'closed'}
                open={jobToDelete !== null}
                jobTitle={jobToDelete?.title ?? ''}
                deleting={deletingJobId === jobToDelete?.id}
                error={deleteError}
                onCancel={closeDeleteDialog}
                onConfirm={handleConfirmDelete}
            />
        </>
    );
}
