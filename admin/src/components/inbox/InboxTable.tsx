import Link from 'next/link';
import { LocalTime } from '@/components/LocalTime';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import type { InboxItem } from '@/lib/server/admin-inbox';
import { inboxFooterText, inboxListHref, waitingTone, type InboxListQuery } from './inbox-view';
import { FOCUS_RING } from './styles';

// Wide screens: one grid row per item under a visual header. Below lg the same
// markup stacks as a card, so there is one link per item and no table to scroll.
const GRID = 'lg:grid lg:grid-cols-[10rem_minmax(0,1fr)_10rem_10rem_7rem] lg:items-center lg:gap-4';
const PAGER_LINK = `inline-flex h-9 items-center rounded-full border border-[var(--jale-divider)] px-4 text-xs font-semibold text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)] ${FOCUS_RING}`;

/** Everything waiting on an admin, in the server's order (K2.3). Each row is one link to its own view. */
export function InboxTable({ items, nowIso }: { items: readonly InboxItem[]; nowIso: string }) {
  return (
    <DashboardPanel as="div" className="overflow-hidden">
      <div aria-hidden="true" className={`hidden border-b border-[var(--jale-divider)] px-5 py-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)] ${GRID}`}>
        <span>Type</span>
        <span>Subject</span>
        <span>From</span>
        <span>Status</span>
        <span className="text-right">Waiting</span>
      </div>
      <ul className="divide-y divide-[var(--jale-divider)]">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <Link className={`flex flex-col gap-1.5 px-4 py-3.5 text-[var(--jale-ink)] hover:bg-[var(--jale-paper)] lg:px-5 ${GRID} ${FOCUS_RING}`} href={item.href} prefetch={false}>
              <span className="inline-flex items-center gap-2 text-sm font-semibold">
                <span aria-hidden="true" className={item.unread ? 'size-2 shrink-0 rounded-full bg-[var(--jale-blue-500)]' : 'size-2 shrink-0 rounded-full border border-[var(--jale-divider)]'} />
                {item.unread ? <span className="sr-only">Unread</span> : null}
                {item.typeLabel}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold">{item.subject}</span>
                <span className="text-xs text-[var(--jale-ink-2)]" translate="no">{item.ref}</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:contents">
                <span className="text-sm text-[var(--jale-ink-2)]">{item.from}</span>
                <span><Badge tone={waitingTone(item.waitingOn)}>{item.statusLabel}</Badge></span>
                <span className="text-sm font-semibold tabular-nums lg:text-right">
                  {item.waitingSince ? <LocalTime format="relative" iso={item.waitingSince} nowIso={nowIso} /> : '—'}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </DashboardPanel>
  );
}

/** "Showing N of M", plus Newest when paged and Next from the keyset cursor (K2.3 nextBefore). */
export function InboxPager({ query, shown, total, nextBefore }: { query: InboxListQuery; shown: number; total: number; nextBefore?: string }) {
  if (shown === 0 && !query.before) return null;
  return (
    <nav aria-label="Inbox pages" className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--jale-ink-2)]">
      <p>{inboxFooterText(shown, total)}</p>
      <div className="flex gap-2">
        {query.before ? <Link className={PAGER_LINK} href={inboxListHref({ ...query, before: undefined })} prefetch={false}>Newest</Link> : null}
        {nextBefore ? <Link className={PAGER_LINK} href={inboxListHref({ ...query, before: nextBefore })} prefetch={false}>Next</Link> : null}
      </div>
    </nav>
  );
}
