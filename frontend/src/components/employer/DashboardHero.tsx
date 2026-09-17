'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Icon } from '@/components/ui/icon';
import { PostJobButton } from '@/components/employer/PostJobButton';
import { accountKeyFromIdToken, accountScopedKey } from '@/lib/account-key';

/**
 * The dashboard's welcome panel — once.
 *
 * The full hero is an introduction: it says what this board is for and offers
 * the two things a new employer should do first. An introduction is worth a
 * screenful the FIRST time and is furniture every time after, and it was
 * pushing the job list — the reason a returning employer opened the page — a
 * third of the way down the viewport on every visit.
 *
 * So it is shown once and then collapses to a one-line bar that keeps the one
 * control worth keeping. `localStorage`, not session: "I have seen the
 * introduction" is a fact about the person, not about the tab -- and so the key
 * carries WHICH person (see `lib/account-key`). Storage is per browser, and
 * without that an employer sharing a laptop would never be introduced to their
 * own board because a colleague had already read the introduction on it.
 */

const STORAGE_KEY = 'jale.employer.hero_seen';

/**
 * Null `account` means we cannot tell whose flag this would be, and both halves
 * then decline: nothing is read and nothing is written. The cost is one extra
 * showing of an introduction, which is the right side to fail on.
 */
function readSeen(account: string | null): boolean {
    if (account === null || typeof window === 'undefined') return false;
    try {
        return window.localStorage.getItem(accountScopedKey(STORAGE_KEY, account)) === '1';
    } catch {
        // Storage disabled (private mode, blocked cookies). Showing the full
        // hero is the safe side of this: it is the state that says more.
        return false;
    }
}

function rememberSeen(account: string | null): void {
    if (account === null || typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(accountScopedKey(STORAGE_KEY, account), '1');
    } catch {
        // The collapse just will not survive the next load. Not worth a crash.
    }
}

export function DashboardHero() {
    const t = useTranslations('employer_dashboard');
    const { idToken } = useAuth();
    // Known by the time this renders: the hero only exists inside the
    // dashboard's `ready` branch, which the page cannot reach without a token.
    const account = accountKeyFromIdToken(idToken);

    /*
     * Read synchronously on the first render, so a returning employer never
     * sees the full hero paint and then snap away (a flash plus a layout shift
     * on every visit). That is hydration-safe HERE for the same reason it is in
     * `SubscriptionBanner`: this component only renders inside the dashboard's
     * client-only `ready` branch, which never exists in the server HTML.
     */
    const [seen, setSeen] = useState(() => readSeen(account));

    // Seeing it once is what "seen" means, so the flag is written by the render
    // that showed it -- not by the dismiss button, which is an accelerator.
    useEffect(() => {
        if (!seen) rememberSeen(account);
    }, [account, seen]);

    if (seen) {
        return (
            <section className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] px-4 py-3 shadow-[var(--shadow-card)] md:px-5">
                <p className="text-sm font-bold text-[var(--jale-ink)]">{t('hero.slim_title')}</p>
                <PostJobButton size="sm" />
            </section>
        );
    }

    return (
        <section className="mb-5 overflow-hidden rounded-[var(--radius-card)] bg-[var(--jale-blue-900)] p-5 shadow-[var(--shadow-card)] md:p-7">
            <div className="flex items-start justify-between gap-3">
                <p className="mb-3 inline-flex rounded-full bg-[color-mix(in_srgb,var(--primary-fg)_12%,transparent)] px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[color-mix(in_srgb,var(--primary-fg)_80%,transparent)]">
                    {t('hero.eyebrow')}
                </p>
                {/* Collapses to the slim bar now rather than on the next visit.
                    The flag is already written by the effect above, so this
                    control only changes WHEN the collapse happens. */}
                <button
                    type="button"
                    onClick={() => setSeen(true)}
                    aria-label={t('hero.dismiss_aria')}
                    className="-mr-1 shrink-0 cursor-pointer rounded p-1 leading-none text-[color-mix(in_srgb,var(--primary-fg)_72%,transparent)] transition-colors hover:text-[var(--primary-fg)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                    <Icon name="x" />
                </button>
            </div>
            <h2 className="max-w-3xl text-3xl font-extrabold leading-tight text-[var(--primary-fg)] md:text-4xl">
                {t('hero.title')}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[color-mix(in_srgb,var(--primary-fg)_72%,transparent)]">
                {t('hero.body')}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
                <PostJobButton>{t('hero.primary_cta')}</PostJobButton>
                <Link
                    href="/employer/conversations"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--primary-fg)_25%,transparent)] px-5 text-sm font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-fg)_12%,transparent)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                    <Icon name="message" />
                    {t('hero.secondary_cta')}
                </Link>
            </div>
        </section>
    );
}
