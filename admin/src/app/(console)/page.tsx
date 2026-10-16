import { KeyMetrics } from '@/components/home/KeyMetrics';
import { NeedsAction } from '@/components/home/NeedsAction';
import { RecentActivity } from '@/components/home/RecentActivity';
import { SystemHealth } from '@/components/home/SystemHealth';
import { newSinceText, settledValue } from '@/components/home/home-format';
import { getHomeMetrics, getSystemHealth } from '@/lib/server/admin-analytics';
import { getInboxCounts, loadRecentActivity } from '@/lib/server/admin-inbox';
import { requireAdminSession } from '@/lib/server/session';

export default async function HomePage() {
  const session = await requireAdminSession();
  const now = new Date();
  // Two waves of at most three reads (K3.0): the pool holds five connections
  // and the console layout reads its count at the same time. A read that
  // fails blanks only its own section.
  const [counts, metrics, health] = await Promise.allSettled([
    getInboxCounts(session),
    getHomeMetrics(),
    getSystemHealth(),
  ]);
  const [activity] = await Promise.allSettled([loadRecentActivity(session)]);
  const inbox = settledValue(counts);
  const newSince = newSinceText(inbox?.newSinceLastVisit ?? null);

  return (
    <div className="flex w-full max-w-[1180px] flex-col gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-extrabold leading-tight tracking-[-0.02em] text-[var(--jale-ink)]">Home</h1>
          <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">What needs you first, then how the platform is doing.</p>
        </div>
        {newSince ? (
          <p className="text-[13px] text-[var(--jale-ink-2)]">
            <strong className="font-bold text-[var(--jale-ink)]">{newSince}</strong> since your last visit
          </p>
        ) : null}
      </header>
      <NeedsAction counts={inbox} nowMs={now.getTime()} />
      <SystemHealth result={settledValue(health)} />
      <KeyMetrics metrics={settledValue(metrics)} />
      <RecentActivity items={settledValue(activity)} nowIso={now.toISOString()} />
    </div>
  );
}
