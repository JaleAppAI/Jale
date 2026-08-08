'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { Icon } from '@/components/ui/icon';
import { workerPrimaryNav, isNavItemActive } from './nav-config';

/**
 * Mobile bottom tab bar — WORKER role only (workers are mobile-first).
 * Hidden at `lg` and above, where the desktop sidebar takes over.
 * Employers never render this (they stay header-only on mobile).
 */
export function BottomTabBar() {
    const t = useTranslations('header');
    const tShell = useTranslations('app_shell');
    const pathname = usePathname();

    return (
        <nav
            aria-label={tShell('mobile_nav')}
            className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--jale-divider)] bg-[color-mix(in_srgb,var(--jale-card)_95%,transparent)] backdrop-blur lg:hidden pb-[env(safe-area-inset-bottom)]"
        >
            <ul className="mx-auto flex max-w-lg items-stretch justify-around">
                {workerPrimaryNav.map((item) => {
                    const active = isNavItemActive(item, pathname);
                    return (
                        <li key={item.key} className="flex-1">
                            <Link
                                href={item.href}
                                aria-current={active ? 'page' : undefined}
                                className={[
                                    // min-h keeps every tab at the 48px touch
                                    // minimum even where the label wraps to one
                                    // short line.
                                    'flex min-h-12 flex-col items-center justify-center gap-1 py-3 text-[11px] font-semibold transition-colors',
                                    active ? 'text-[var(--jale-blue-700)]' : 'text-[var(--jale-ink-2)]',
                                ].join(' ')}
                            >
                                <Icon name={item.icon} />
                                {t(item.labelKey)}
                            </Link>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
