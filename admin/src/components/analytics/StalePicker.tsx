import Link from 'next/link';
import type { StaleDays } from '@/lib/server/admin-analytics';

export const STALE_OPTIONS: readonly StaleDays[] = [7, 14, 30];

// #4: how long a job must go without employer action to count as stale (`?stale=`).
export function StalePicker({ current, hrefFor }: { current: StaleDays; hrefFor: (days: StaleDays) => string }) {
  return (
    <nav aria-label="Stale after" className="flex flex-wrap items-center gap-1 text-sm">
      <span className="mr-1 text-[var(--jale-ink-2)]">Stale after</span>
      {STALE_OPTIONS.map((days) => (
        <Link
          key={days}
          href={hrefFor(days)}
          prefetch={false}
          aria-current={days === current ? 'page' : undefined}
          className="inline-flex min-h-9 items-center rounded-full border border-[var(--jale-divider)] px-3 font-semibold aria-[current=page]:bg-[var(--primary)] aria-[current=page]:text-[var(--primary-fg)]"
        >
          {days} days
        </Link>
      ))}
    </nav>
  );
}
