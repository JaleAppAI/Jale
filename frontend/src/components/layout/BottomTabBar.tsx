'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { Icon } from '@/components/ui/icon';
import { UnreadBadge } from './UnreadBadge';
import {
    employerMobileNav,
    workerPrimaryNav,
    isNavItemActive,
    type NavItem,
    type ShellRole,
} from './nav-config';

/**
 * Mobile bottom tab bar. Hidden at `lg` and above, where the desktop sidebar
 * takes over.
 *
 * Both roles render it. Employers used to be told they were "header-only on
 * mobile", which in practice meant they had NO persistent navigation below
 * `lg` at all: the sidebar is `lg:flex`, this bar was worker-only, and the
 * sticky header carries a language toggle and a sign-out button but no links.
 * An employer on a phone could reach a page and then only leave it by using
 * the browser's back button.
 */
export function BottomTabBar({
    role,
    unreadCount = 0,
    attentionCount = 0,
}: {
    role: ShellRole;
    /** Unread WhatsApp threads, badged on the Messages tab. See `Sidebar`. */
    unreadCount?: number;
    /** Applications that need the worker (F27). See `Sidebar`. */
    attentionCount?: number;
}) {
    const tShell = useTranslations('app_shell');
    const pathname = usePathname();
    const navRef = useRef<HTMLElement>(null);
    useTabBarOffset(navRef);

    return (
        <nav
            ref={navRef}
            aria-label={tShell('mobile_nav')}
            // A MINIMUM of the nominal height, never a fixed one: a label that
            // wraps grows the bar rather than being clipped, and the measured
            // height is what `useTabBarOffset` hands on.
            className="fixed inset-x-0 bottom-0 z-20 min-h-[calc(var(--jale-tab-bar-height)+env(safe-area-inset-bottom))] border-t border-[var(--jale-divider)] bg-[color-mix(in_srgb,var(--jale-card)_95%,transparent)] backdrop-blur lg:hidden pb-[env(safe-area-inset-bottom)]"
        >
            <ul className="mx-auto flex max-w-lg items-stretch justify-around">
                {role === 'employer' ? (
                    <EmployerTabs pathname={pathname} unreadCount={unreadCount} />
                ) : (
                    <WorkerTabs pathname={pathname} attentionCount={attentionCount} />
                )}
            </ul>
        </nav>
    );
}

const TAB_BAR_OFFSET = '--jale-tab-bar-offset';

/**
 * Keeps `--jale-tab-bar-offset` (see `globals.css`) equal to this bar's real
 * outer height, so the shell's bottom padding and the job page's Apply bar
 * meet it exactly even when a wrapped label has made it taller than nominal.
 *
 * - It watches the BORDER box: the safe-area padding and the top rule are part
 *   of what the content above has to clear, and a change in the inset alone
 *   (a phone rotating) leaves the content box as it was.
 * - The value goes inline on <html>, which wins over the stylesheet's nominal
 *   one. A hidden bar (`lg:hidden` measures 0) drops it, as does unmounting,
 *   so the nominal value is back for the next bar. It only drops a value it
 *   wrote itself, in case another bar has written since.
 * - Where there is no ResizeObserver it does nothing, and the nominal value
 *   stands.
 */
function useTabBarOffset(ref: RefObject<HTMLElement | null>) {
    useEffect(() => {
        const nav = ref.current;
        if (!nav || typeof ResizeObserver === 'undefined') return;
        const root = document.documentElement.style;
        let written: string | null = null;
        const drop = () => {
            if (written !== null && root.getPropertyValue(TAB_BAR_OFFSET) === written) {
                root.removeProperty(TAB_BAR_OFFSET);
            }
            written = null;
        };
        const observer = new ResizeObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            // Older engines give no box sizes; the element's own box is the same figure.
            const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
            if (height > 0) {
                written = `${height}px`;
                root.setProperty(TAB_BAR_OFFSET, written);
            } else {
                drop();
            }
        });
        observer.observe(nav, { box: 'border-box' });
        return () => {
            observer.disconnect();
            drop();
        };
    }, [ref]);
}

/*
 * The two roles read their labels from different namespaces -- employer nav
 * labels live under `employer_dashboard.nav.*`, worker ones under `header.*` --
 * so each gets its own component with its own `useTranslations` call. Same
 * split, and same reason, as `Sidebar`'s `EmployerNav` / `WorkerNav`. Calling
 * one hook or the other from a single component would be a conditional hook.
 */

function WorkerTabs({ pathname, attentionCount }: { pathname: string; attentionCount: number }) {
    const t = useTranslations('header');
    const tShell = useTranslations('app_shell');
    return (
        <>
            {workerPrimaryNav.map((item) => {
                const badged = item.key === 'applications';
                return (
                    <TabLink
                        key={item.key}
                        item={item}
                        pathname={pathname}
                        label={t(item.labelKey)}
                        badgeCount={badged ? attentionCount : 0}
                        badgeLabel={badged ? tShell('applications_attention_badge', { count: attentionCount }) : undefined}
                    />
                );
            })}
        </>
    );
}

function EmployerTabs({ pathname, unreadCount }: { pathname: string; unreadCount: number }) {
    const t = useTranslations('employer_dashboard');
    return (
        <>
            {employerMobileNav.map((item) => (
                <TabLink
                    key={item.key}
                    item={item}
                    pathname={pathname}
                    label={t(item.labelKey)}
                    badgeCount={item.key === 'messages' ? unreadCount : 0}
                />
            ))}
        </>
    );
}

function TabLink({
    item,
    pathname,
    label,
    badgeCount = 0,
    badgeLabel,
}: {
    item: NavItem;
    pathname: string;
    label: string;
    badgeCount?: number;
    badgeLabel?: string;
}) {
    const active = isNavItemActive(item, pathname);
    return (
        <li className="flex-1">
            <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                data-nav-key={item.key}
                className={[
                    // min-h keeps every tab at the 48px touch minimum even where
                    // the label wraps to one short line.
                    'flex min-h-12 flex-col items-center justify-center gap-1 py-3 text-[11px] font-semibold transition-colors',
                    active ? 'text-[var(--jale-blue-700)]' : 'text-[var(--jale-ink-2)]',
                ].join(' ')}
            >
                {/* The badge rides the icon rather than the label: the tabs
                    are 25% of a 360px bar and a pill after the word would push
                    the label into a second line on the longest one. */}
                <span className="relative inline-flex">
                    <Icon name={item.icon} />
                    {badgeCount > 0 ? (
                        <span className="absolute -right-2.5 -top-1.5">
                            <UnreadBadge count={badgeCount} tone="bar" srLabel={badgeLabel} />
                        </span>
                    ) : null}
                </span>
                {label}
            </Link>
        </li>
    );
}
