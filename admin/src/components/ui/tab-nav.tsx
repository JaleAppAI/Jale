import Link from 'next/link';

export type TabNavItem = { label: string; href: string; count?: number; active: boolean };

/**
 * Page tabs as links (Inbox, Security, Analytics). The row scrolls inside
 * itself on a phone instead of widening the page.
 */
export function TabNav({ label, items }: { label: string; items: TabNavItem[] }) {
    return (
        <nav aria-label={label} className="max-w-full overflow-x-auto">
            <ul className="flex min-w-max gap-0.5 border-b sm:gap-1 border-[var(--jale-divider)]">
                {items.map((item) => (
                    <li key={item.href}>
                        <Link
                            href={item.href}
                            prefetch={false}
                            aria-current={item.active ? 'page' : undefined}
                            className={[
                                '-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-2 text-sm sm:px-3 transition-colors',
                                'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                                item.active
                                    ? 'border-[var(--jale-blue-500)] font-semibold text-[var(--jale-ink)]'
                                    : 'border-transparent font-medium text-[var(--jale-ink-2)] hover:text-[var(--jale-ink)]',
                            ].join(' ')}
                        >
                            {item.label}
                            {item.count !== undefined ? (
                                <span className="rounded-full bg-[var(--jale-paper-2)] px-2 py-0.5 text-[11px] font-bold tabular-nums text-[var(--jale-ink)]">
                                    {item.count.toLocaleString('en-US')}
                                </span>
                            ) : null}
                        </Link>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
