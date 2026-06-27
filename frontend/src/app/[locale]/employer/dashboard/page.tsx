'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JobPostingCard } from '@/components/employer/JobPostingCard';
import { PostJobModal } from '@/components/employer/PostJobModal';
import { getEmployerProfile, getJobs } from '@/lib/api/employer';
import type { EmployerProfileData, Job } from '@/lib/api/employer';
import type { JobStatus } from '@/lib/status';

type DisabledNavItem = {
    key: string;
    badge?: string;
};

const primaryNav = [
    { key: 'dashboard', href: '/employer/dashboard' },
    { key: 'jobs', href: '/employer/dashboard' },
    { key: 'messages', href: '/employer/conversations' },
] as const;

const hiringNav: DisabledNavItem[] = [
    { key: 'workers' },
    { key: 'interviews', badge: 'soon' },
    { key: 'search_workers' },
    { key: 'boost_job' },
    { key: 'jale_direct' },
];

const accountNav: DisabledNavItem[] = [
    { key: 'analytics' },
    { key: 'billing' },
];

const statusFilters = ['all', 'active', 'paused', 'filled', 'closed'] as const;

function getInitials(value: string) {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'E';
    return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function Icon({ name }: { name: 'grid' | 'briefcase' | 'message' | 'user' | 'bell' | 'search' | 'spark' | 'chart' | 'clock' | 'plus' }) {
    const common = {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
    };

    switch (name) {
        case 'briefcase':
            return <svg {...common}><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M4 7h16v12H4z" /><path d="M4 12h16" /></svg>;
        case 'message':
            return <svg {...common}><path d="M5 6h14v9H8l-3 3z" /></svg>;
        case 'user':
            return <svg {...common}><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
        case 'bell':
            return <svg {...common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>;
        case 'search':
            return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
        case 'spark':
            return <svg {...common}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></svg>;
        case 'chart':
            return <svg {...common}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 16v-5" /><path d="M12 16V8" /><path d="M16 16v-3" /></svg>;
        case 'clock':
            return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></svg>;
        case 'plus':
            return <svg {...common}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
        default:
            return <svg {...common}><path d="M4 4h7v7H4z" /><path d="M13 4h7v7h-7z" /><path d="M4 13h7v7H4z" /><path d="M13 13h7v7h-7z" /></svg>;
    }
}

function DashboardPanel({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <section className={`rounded-2xl border border-[var(--jale-divider)] bg-white shadow-[var(--shadow-card)] ${className}`}>
            {children}
        </section>
    );
}

function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
            <h2 className="text-base font-bold text-current">{title}</h2>
            {action}
        </div>
    );
}

function DisabledPill({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/70">
            {children}
        </span>
    );
}

function DisabledAction({ children }: { children: ReactNode }) {
    return (
        <button
            type="button"
            disabled
            aria-disabled="true"
            className="inline-flex h-9 items-center justify-center rounded-full border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-4 text-xs font-bold text-[var(--jale-ink-2)] opacity-70"
        >
            {children}
        </button>
    );
}

function MetricCard({ label, value, hint, tone = 'blue' }: { label: string; value: string | number; hint: string; tone?: 'blue' | 'teal' | 'amber' | 'ink' }) {
    const tones = {
        blue: 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]',
        teal: 'bg-[var(--jale-teal-50)] text-[#137965]',
        amber: 'bg-[var(--jale-warning-bg)] text-[#8a4400]',
        ink: 'bg-[#eef0f7] text-[var(--jale-blue-900)]',
    };

    return (
        <div className="min-h-[128px] rounded-2xl border border-[var(--jale-divider)] bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
            <div className={`mb-4 inline-flex h-9 w-9 items-center justify-center rounded-xl ${tones[tone]}`}>
                <Icon name={tone === 'teal' ? 'user' : tone === 'amber' ? 'clock' : tone === 'ink' ? 'chart' : 'briefcase'} />
            </div>
            <p className="text-3xl font-extrabold leading-none text-[var(--jale-ink)]">{value}</p>
            <p className="mt-2 text-xs font-bold uppercase text-[var(--jale-ink-2)]">{label}</p>
            <p className="mt-1 text-xs text-[var(--jale-ink-2)]">{hint}</p>
        </div>
    );
}

function ProgressRow({ label, value, percent }: { label: string; value: string; percent: number }) {
    return (
        <div>
            <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold">
                <span className="text-current">{label}</span>
                <span className="text-current opacity-70">{value}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--jale-paper-2)]">
                <div className="h-full rounded-full bg-[var(--jale-blue-500)]" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
            </div>
        </div>
    );
}

export default function EmployerDashboardPage() {
    const { idToken, logout } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const t = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');
    const tHeader = useTranslations('header');
    const locale = useLocale();
    const pathname = usePathname();
    const otherLocale = locale === 'en' ? 'es' : 'en';

    const [jobs, setJobs] = useState<Job[]>([]);
    const [profile, setProfile] = useState<EmployerProfileData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
    const [signingOut, setSigningOut] = useState(false);

    useEffect(() => {
        if (!idToken) return;
        setLoading(true);
        Promise.all([getJobs(idToken), getEmployerProfile(idToken)])
            .then(([nextJobs, nextProfile]) => {
                setJobs(nextJobs);
                setProfile(nextProfile);
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
    const companyName = profile?.company_name?.trim() || profile?.full_name?.trim() || t('shell.company_fallback');
    const contactName = profile?.contact_name?.trim() || profile?.full_name?.trim();
    const companyMeta = [profile?.city, profile?.service_area].map((item) => item?.trim()).filter(Boolean).join(' · ');
    const companyInitials = getInitials(companyName);

    const todayLabel = new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
    }).format(new Date());

    function handleJobCreated(job: Job) {
        setJobs((prev) => [job, ...prev]);
        setModalOpen(false);
    }

    async function handleSignOut() {
        setSigningOut(true);
        try {
            await logout();
        } finally {
            setSigningOut(false);
        }
    }

    if (error) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-[var(--jale-paper)] px-4">
                <div className="rounded-2xl border border-[var(--jale-divider)] bg-white p-6 text-center shadow-[var(--shadow-card)]">
                    <p className="text-sm font-semibold text-error">{error}</p>
                </div>
            </main>
        );
    }

    return (
        <>
            <main className="min-h-screen bg-[#eef2f7] text-[var(--jale-ink)]">
                <div className="grid min-h-screen lg:grid-cols-[280px_minmax(0,1fr)]">
                    <aside className="hidden bg-[#10143b] text-white lg:flex lg:flex-col">
                        <div className="border-b border-white/10 px-6 py-6">
                            <Link href="/employer/dashboard" className="text-3xl font-extrabold text-white">
                                Jale
                            </Link>
                            <p className="mt-1 text-xs font-semibold uppercase text-white/55">{t('shell.employer_workspace')}</p>
                        </div>

                        <div className="border-b border-white/10 px-6 py-5">
                            <div className="flex items-center gap-3">
                                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--jale-blue-500)] text-sm font-extrabold">
                                    {companyInitials}
                                </div>
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-bold">{companyName}</p>
                                    <p className="truncate text-xs text-white/55">{companyMeta || t('shell.plan_label')}</p>
                                </div>
                            </div>
                        </div>

                        <nav className="flex-1 overflow-y-auto px-4 py-5">
                            <p className="mb-2 px-2 text-[11px] font-bold uppercase text-white/45">{t('nav.main')}</p>
                            <div className="space-y-1">
                                {primaryNav.map((item) => (
                                    <Link
                                        key={item.key}
                                        href={item.href}
                                        className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-white/80 hover:bg-white/10 hover:text-white"
                                    >
                                        <Icon name={item.key === 'messages' ? 'message' : item.key === 'jobs' ? 'briefcase' : 'grid'} />
                                        {t(`nav.${item.key}`)}
                                    </Link>
                                ))}
                            </div>

                            <p className="mb-2 mt-6 px-2 text-[11px] font-bold uppercase text-white/45">{t('nav.hiring')}</p>
                            <div className="space-y-1">
                                {hiringNav.map((item) => (
                                    <button
                                        key={item.key}
                                        type="button"
                                        disabled
                                        aria-disabled="true"
                                        className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-white/35"
                                    >
                                        <span className="inline-flex items-center gap-3">
                                            <Icon name={item.key === 'workers' ? 'user' : item.key === 'interviews' ? 'clock' : item.key === 'search_workers' ? 'search' : item.key === 'boost_job' ? 'spark' : 'briefcase'} />
                                            {t(`nav.${item.key}`)}
                                        </span>
                                        <DisabledPill>{t(`nav.${item.badge ?? 'soon'}`)}</DisabledPill>
                                    </button>
                                ))}
                            </div>

                            <p className="mb-2 mt-6 px-2 text-[11px] font-bold uppercase text-white/45">{t('nav.account')}</p>
                            <div className="space-y-1">
                                {accountNav.map((item) => (
                                    <button
                                        key={item.key}
                                        type="button"
                                        disabled
                                        aria-disabled="true"
                                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-white/35"
                                    >
                                        <Icon name={item.key === 'analytics' ? 'chart' : 'briefcase'} />
                                        {t(`nav.${item.key}`)}
                                    </button>
                                ))}
                                <Link
                                    href="/employer/profile"
                                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-white/80 hover:bg-white/10 hover:text-white"
                                >
                                    <Icon name="user" />
                                    {t('nav.settings')}
                                </Link>
                            </div>
                        </nav>

                        <div className="m-4 rounded-2xl border border-white/10 bg-white/10 p-4">
                            <p className="text-sm font-bold">{t('shell.plan_title')}</p>
                            <p className="mt-1 text-xs leading-5 text-white/60">{t('shell.plan_body')}</p>
                            <DisabledAction>{t('shell.upgrade')}</DisabledAction>
                        </div>
                    </aside>

                    <section className="min-w-0">
                        <header className="sticky top-0 z-10 border-b border-[var(--jale-divider)] bg-white/92 px-4 py-3 backdrop-blur md:px-6">
                            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                                <div>
                                    <p className="text-xs font-bold uppercase text-[var(--jale-ink-2)]">{todayLabel}</p>
                                    <h1 className="text-2xl font-extrabold text-[var(--jale-ink)] md:text-3xl">{companyName}</h1>
                                    <p className="mt-1 text-sm font-semibold text-[var(--jale-ink-2)]">
                                        {contactName ? `${t('shell.title')} · ${contactName}` : t('shell.title')}
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        disabled
                                        aria-disabled="true"
                                        className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-4 text-xs font-bold text-[var(--jale-ink-2)] opacity-70"
                                    >
                                        <Icon name="bell" />
                                        {t('shell.alerts')}
                                    </button>
                                    <button
                                        type="button"
                                        disabled
                                        aria-disabled="true"
                                        className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-4 text-xs font-bold text-[var(--jale-ink-2)] opacity-70"
                                    >
                                        <Icon name="search" />
                                        {t('shell.search_workers')}
                                    </button>
                                    <Button onClick={() => setModalOpen(true)} className="h-10">
                                        <Icon name="plus" />
                                        {t('jobs.post_job')}
                                    </Button>
                                    <Link
                                        href={pathname}
                                        locale={otherLocale}
                                        className="inline-flex h-10 items-center rounded-full border border-[var(--jale-divider)] bg-white px-4 text-xs font-bold text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]"
                                    >
                                        {tHeader('language_toggle')}
                                    </Link>
                                    <Link
                                        href="/employer/profile"
                                        aria-label={tHeader('profile')}
                                        className="avatar-initials square h-10 w-10"
                                    >
                                        {companyInitials}
                                    </Link>
                                    <Button variant="outline" size="sm" onClick={handleSignOut} loading={signingOut} loadingLabel={tCommon('loading')} className="h-10">
                                        {tHeader('sign_out')}
                                    </Button>
                                </div>
                            </div>
                        </header>

                        <div className="mx-auto max-w-[1380px] px-4 py-6 md:px-6">
                            <section className="mb-5 overflow-hidden rounded-3xl bg-[#111642] text-white shadow-[var(--shadow-card)]">
                                <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1.4fr)_minmax(280px,.9fr)] md:p-7">
                                    <div>
                                        <p className="mb-2 inline-flex rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase text-white/70">{t('hero.eyebrow')}</p>
                                        <h2 className="text-3xl font-extrabold leading-tight md:text-4xl">{t('hero.title')}</h2>
                                        <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">{t('hero.body')}</p>
                                        <div className="mt-5 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setModalOpen(true)}
                                                className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-[#111642] shadow-[var(--shadow-btn)] transition-all duration-150 hover:bg-white/90 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] active:scale-[0.98]"
                                            >
                                                <Icon name="plus" />
                                                {t('hero.primary_cta')}
                                            </button>
                                            <Link
                                                href="/employer/conversations"
                                                className="inline-flex h-11 items-center gap-2 rounded-full border border-white/20 px-5 text-sm font-bold text-white hover:bg-white/10"
                                            >
                                                <Icon name="message" />
                                                {t('hero.secondary_cta')}
                                            </Link>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-3 rounded-2xl border border-white/10 bg-white/8 p-4">
                                        <div>
                                            <p className="text-2xl font-extrabold">{loading ? '-' : activeCount}</p>
                                            <p className="mt-1 text-[11px] font-semibold uppercase text-white/60">{t('stats.active_jobs')}</p>
                                        </div>
                                        <div>
                                            <p className="text-2xl font-extrabold">{loading ? '-' : totalApplicants}</p>
                                            <p className="mt-1 text-[11px] font-semibold uppercase text-white/60">{t('stats.total_applicants')}</p>
                                        </div>
                                        <div>
                                            <p className="text-2xl font-extrabold">{loading ? '-' : totalHired}</p>
                                            <p className="mt-1 text-[11px] font-semibold uppercase text-white/60">{t('stats.workers_hired')}</p>
                                        </div>
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
                                        <PanelHeader title={t('quick_post.title')} action={<DisabledAction>{t('disabled.label')}</DisabledAction>} />
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

                                    <DashboardPanel>
                                        <PanelHeader title={t('panels.applicants_title')} action={<DisabledAction>{t('disabled.coming_soon')}</DisabledAction>} />
                                        <div className="grid gap-3 p-5 md:grid-cols-3">
                                            {[0, 1, 2].map((item) => (
                                                <div key={item} className="rounded-2xl border border-dashed border-[var(--jale-divider)] bg-[var(--jale-paper-2)] p-4 opacity-75">
                                                    <p className="text-sm font-bold text-[var(--jale-ink)]">{t(`panels.applicant_stub_${item + 1}`)}</p>
                                                    <p className="mt-2 text-xs leading-5 text-[var(--jale-ink-2)]">{t('panels.applicants_body')}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </DashboardPanel>
                                </div>

                                <div className="space-y-5">
                                    <DashboardPanel className="!bg-[#111642] text-white">
                                        <PanelHeader title={t('panels.trust_title')} action={<DisabledPill>{t('disabled.preview')}</DisabledPill>} />
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
                                        <PanelHeader
                                            title={t('panels.whatsapp_title')}
                                            action={<Link href="/employer/conversations" className="text-xs font-bold text-[var(--jale-blue-700)] hover:underline">{t('panels.open_messages')}</Link>}
                                        />
                                        <div className="p-5">
                                            <div className="rounded-2xl bg-[var(--jale-paper-2)] p-4">
                                                <p className="text-sm font-bold text-[var(--jale-ink)]">{recentJob?.title ?? t('panels.no_recent_job')}</p>
                                                <p className="mt-2 text-xs leading-5 text-[var(--jale-ink-2)]">{t('panels.whatsapp_body')}</p>
                                            </div>
                                            <Link
                                                href="/employer/conversations"
                                                className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-[var(--jale-blue-500)] px-4 text-xs font-bold text-white hover:bg-[var(--jale-blue-600)]"
                                            >
                                                <Icon name="message" />
                                                {t('panels.open_messages')}
                                            </Link>
                                        </div>
                                    </DashboardPanel>

                                    <DashboardPanel>
                                        <PanelHeader title={t('panels.hiring_status_title')} action={<DisabledAction>{t('disabled.label')}</DisabledAction>} />
                                        <div className="space-y-4 p-5">
                                            <ProgressRow label={t('jobs.status.active')} value={String(loading ? '-' : activeCount)} percent={jobs.length ? (activeCount / jobs.length) * 100 : 0} />
                                            <ProgressRow label={t('jobs.status.paused')} value={String(loading ? '-' : pausedCount)} percent={jobs.length ? (pausedCount / jobs.length) * 100 : 0} />
                                            <ProgressRow label={t('jobs.status.filled')} value={String(loading ? '-' : filledCount)} percent={jobs.length ? (filledCount / jobs.length) * 100 : 0} />
                                        </div>
                                    </DashboardPanel>
                                </div>
                            </div>
                        </div>
                    </section>
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
