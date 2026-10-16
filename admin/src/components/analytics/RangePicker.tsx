import Link from 'next/link';
import type { FunnelWeeks } from '@/lib/types';

// K3.0: the range picker. Links, so it needs no client code; every tab keeps
// its own other parameters through `hrefFor`.
export const RANGE_OPTIONS: readonly { weeks: FunnelWeeks; label: string }[] = [
  { weeks: 8, label: 'Last 8 weeks' },
  { weeks: 13, label: 'Last 13 weeks' },
  { weeks: 26, label: 'Last 26 weeks' },
];

export function RangePicker({ current, hrefFor }: { current: FunnelWeeks; hrefFor: (weeks: FunnelWeeks) => string }) {
  return (
    <nav aria-label="Range" className="flex flex-wrap gap-1 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] p-1">
      {RANGE_OPTIONS.map((option) => (
        <Link
          key={option.weeks}
          href={hrefFor(option.weeks)}
          prefetch={false}
          aria-current={option.weeks === current ? 'page' : undefined}
          className="inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold aria-[current=page]:bg-[var(--primary)] aria-[current=page]:text-[var(--primary-fg)]"
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
