import Link from 'next/link';
import type { ReactNode } from 'react';
import { DashboardPanel } from './dashboard-panel';

/**
 * A boxed KPI tile: value, label, optional hint. With `href` the whole tile is
 * one link (never prefetched: the target page may record a read).
 */
export function StatTile({ label, value, hint, href }: { label: string; value: string; hint?: ReactNode; href?: string }) {
    const body = (
        <>
            <p className="text-[30px] font-extrabold leading-none tracking-[-0.02em] text-[var(--jale-ink)] tabular-nums [overflow-wrap:anywhere]">
                {value}
            </p>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]">{label}</p>
            {hint ? <div className="mt-2 text-xs font-medium text-[var(--jale-ink-2)]">{hint}</div> : null}
        </>
    );

    if (href) {
        return (
            <Link href={href} prefetch={false} className="block min-w-0 rounded-[var(--radius-card)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]">
                <DashboardPanel as="div" className="h-full p-5 transition-colors hover:border-[var(--jale-blue-500)]">
                    {body}
                </DashboardPanel>
            </Link>
        );
    }

    return (
        <DashboardPanel as="div" className="min-w-0 p-5">
            {body}
        </DashboardPanel>
    );
}
