import { LocalTime } from '@/components/LocalTime';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import type { LockoutDetail } from '@/lib/server/admin-lockouts';
import { MUTED, PANEL_TITLE } from './styles';

/** The challenge's history, oldest first (K2.6 timeline). */
export function LockoutTimeline({ timeline }: { timeline: LockoutDetail['timeline'] }) {
  return (
    <section aria-labelledby="lockout-timeline-heading" className="min-w-0 flex-[999_1_32rem]">
      <DashboardPanel as="div" className="flex flex-col gap-3 p-5">
        <h2 className={PANEL_TITLE} id="lockout-timeline-heading">Timeline</h2>
        {timeline.length === 0 ? (
          <p className={MUTED}>No events recorded.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-[var(--jale-divider)]">
            {timeline.map((event, index) => (
              <li className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3" key={`${event.at}-${index}`}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-[var(--jale-ink)] [overflow-wrap:anywhere]">{event.title}</span>
                  {event.detail ? <span className="text-xs text-[var(--jale-ink-2)] [overflow-wrap:anywhere]">{event.detail}</span> : null}
                </span>
                <span className="text-xs text-[var(--jale-ink-2)]"><LocalTime iso={event.at} /></span>
              </li>
            ))}
          </ol>
        )}
      </DashboardPanel>
    </section>
  );
}
