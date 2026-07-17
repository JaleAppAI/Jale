'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';

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
];

export function getInitials(value: string) {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'E';
    return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

export function Icon({ name }: { name: 'grid' | 'briefcase' | 'message' | 'user' | 'bell' | 'search' | 'spark' | 'chart' | 'clock' | 'plus' }) {
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

function DisabledPill({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/70">
            {children}
        </span>
    );
}

export type EmployerShellActive = 'dashboard' | 'billing' | 'settings';

export function EmployerShell({
    children,
    active,
    companyName,
    companyMeta,
    headerActions,
    headerSubtitle,
}: {
    children: ReactNode;
    active: EmployerShellActive;
    companyName?: string;
    companyMeta?: string;
    headerActions?: ReactNode;
    headerSubtitle?: ReactNode;
}) {
    const { logout } = useAuth();
    const t = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');
    const tHeader = useTranslations('header');
    const locale = useLocale();
    const pathname = usePathname();
    const otherLocale = locale === 'en' ? 'es' : 'en';

    const [signingOut, setSigningOut] = useState(false);

    const resolvedCompanyName = companyName?.trim() || t('shell.company_fallback');
    const resolvedCompanyMeta = companyMeta?.trim() || t('shell.plan_label');
    const companyInitials = getInitials(resolvedCompanyName);

    async function handleSignOut() {
        setSigningOut(true);
        try {
            await logout();
        } finally {
            setSigningOut(false);
        }
    }

    function navLinkClassName(isActive: boolean) {
        return `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${
            isActive ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'
        }`;
    }

    return (
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
                                <p className="truncate text-sm font-bold">{resolvedCompanyName}</p>
                                <p className="truncate text-xs text-white/55">{resolvedCompanyMeta}</p>
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
                                    className={navLinkClassName(active === 'dashboard' && item.key === 'dashboard')}
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
                                href="/employer/billing"
                                className={navLinkClassName(active === 'billing')}
                            >
                                <Icon name="chart" />
                                {t('nav.billing')}
                            </Link>
                            <Link
                                href="/employer/profile"
                                className={navLinkClassName(active === 'settings')}
                            >
                                <Icon name="user" />
                                {t('nav.settings')}
                            </Link>
                        </div>
                    </nav>

                    <div className="m-4 rounded-2xl border border-white/10 bg-white/10 p-4">
                        <p className="text-sm font-bold">{t('shell.plan_title')}</p>
                        <p className="mt-1 text-xs leading-5 text-white/60">{t('shell.plan_body')}</p>
                        <Link
                            href="/employer/billing"
                            className="mt-3 inline-flex h-9 items-center justify-center rounded-full border border-white/15 bg-white/10 px-4 text-xs font-bold text-white hover:bg-white/20"
                        >
                            {t('shell.upgrade')}
                        </Link>
                    </div>
                </aside>

                <section className="min-w-0">
                    <header className="sticky top-0 z-10 border-b border-[var(--jale-divider)] bg-white/92 px-4 py-3 backdrop-blur md:px-6">
                        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <div>
                                <p className="text-xs font-bold uppercase text-[var(--jale-ink-2)]">{new Intl.DateTimeFormat(locale, {
                                    weekday: 'long',
                                    month: 'short',
                                    day: 'numeric',
                                }).format(new Date())}</p>
                                <h1 className="text-2xl font-extrabold text-[var(--jale-ink)] md:text-3xl">{resolvedCompanyName}</h1>
                                {headerSubtitle}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {headerActions}
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

                    <section className="min-w-0">{children}</section>
                </section>
            </div>
        </main>
    );
}
