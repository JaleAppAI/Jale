import Link from 'next/link';
import { Flag, Lock, MessageCircle, Send } from 'lucide-react';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { formatCount } from '@/lib/analytics-format';
import type { InboxCounts } from '@/lib/server/admin-inbox';
import { needsActionCards, SECTION_HEADING, type NeedsActionCard } from './home-format';

const ICONS = { support: MessageCircle, reports: Flag, lockouts: Lock, delivery: Send } as const;

function NeedsActionLink({ card }: { card: NeedsActionCard }) {
  const Icon = ICONS[card.key];
  return (
    <Link
      href={card.href}
      prefetch={false}
      className="flex w-full min-w-0 flex-col gap-2.5 rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] p-5 text-[var(--jale-ink)] shadow-[var(--shadow-card)] transition-colors hover:border-[var(--jale-blue-500)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold">
          <Icon aria-hidden size={18} className="shrink-0" />
          <span>{card.title}</span>
        </span>
        {card.tag ? (
          <span className="shrink-0 rounded-full bg-[var(--jale-blue-50)] px-2 py-0.5 text-[11px] font-bold text-[var(--jale-blue-700)]">{card.tag}</span>
        ) : null}
      </span>
      <span className="text-[36px] font-extrabold leading-none tabular-nums">{formatCount(card.count)}</span>
      {card.clear ? (
        <span className="text-[13px] font-semibold text-[var(--jale-success-text)]">All clear</span>
      ) : card.detail ? (
        <span className="text-[13px] text-[var(--jale-ink-2)]">{card.detail.lead} <strong className="font-bold text-[var(--jale-ink)]">{card.detail.value}</strong>{card.detail.tail}</span>
      ) : null}
    </Link>
  );
}

export function NeedsAction({ counts, nowMs }: { counts: InboxCounts | null; nowMs: number }) {
  return (
    <section aria-labelledby="home-needs" className="flex flex-col gap-3.5">
      <h2 id="home-needs" className={SECTION_HEADING}>Needs action</h2>
      {counts ? (
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-4">
          {needsActionCards(counts, nowMs).map((card) => (
            <li key={card.key} className="flex min-w-0">
              <NeedsActionLink card={card} />
            </li>
          ))}
        </ul>
      ) : (
        <DashboardPanel>
          <ErrorState kind="server" compact title="Counts unavailable" body="The inbox counts could not be loaded. Refresh the page to try again." />
        </DashboardPanel>
      )}
    </section>
  );
}
