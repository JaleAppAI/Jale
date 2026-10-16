import Link from 'next/link';
import { LocalTime } from '@/components/LocalTime';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import type { ActivityItem } from '@/lib/server/admin-inbox';
import { activityTone, isInAppPath, SECTION_HEADING, type ActivityTone } from './home-format';

const DOTS: Record<ActivityTone, string> = {
  info: 'bg-[var(--jale-blue-500)]',
  warning: 'bg-[var(--jale-warning)]',
  success: 'bg-[var(--jale-success)]',
};

/** K2.2: newest first; the text is server-built and names no person. */
export function RecentActivity({ items, nowIso }: { items: ActivityItem[] | null; nowIso: string }) {
  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-3.5">
      <h2 id="home-recent" className={SECTION_HEADING}>Recent activity</h2>
      {items === null ? (
        <DashboardPanel>
          <ErrorState kind="server" compact title="Activity unavailable" body="Recent activity could not be loaded. Refresh the page to try again." />
        </DashboardPanel>
      ) : items.length === 0 ? (
        <DashboardPanel>
          <EmptyState icon="clock" variant="filtered" title="No recent activity" body="Support messages, reports and lockouts show up here as they happen." />
        </DashboardPanel>
      ) : (
        <ul className="divide-y divide-[var(--jale-divider)] rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-card)]">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3.5 px-5 py-3.5">
              <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${DOTS[activityTone(item.kind)]}`} />
              <span className="min-w-0 flex-1 text-sm text-[var(--jale-ink)] [overflow-wrap:anywhere]">
                {isInAppPath(item.href) ? (
                  <Link href={item.href} prefetch={false} className="rounded font-semibold text-[var(--jale-blue-700)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]">
                    {item.text}
                  </Link>
                ) : (
                  item.text
                )}
              </span>
              <span className="shrink-0 text-xs text-[var(--jale-ink-2)]">
                <LocalTime iso={item.at} format="relative" nowIso={nowIso} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
