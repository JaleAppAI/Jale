import Link from 'next/link';
import { requireAdminSession } from '@/lib/server/session';
import {
  FUNNEL_STALLED_DAYS,
  getOnboardingCohorts,
  getOnboardingStalled,
  parseFunnelDoor,
  parseFunnelWeeks,
} from '@/lib/server/admin-analytics';
import { bucketLabel, formatCount, percentOf, sum } from '@/lib/analytics-format';
import {
  cohortWeekStarts,
  cohortsForDoor,
  funnelStages,
  funnelsHref,
  isSettling,
  stalledForDoor,
  totalCounts,
} from '@/lib/funnel';
import type { FunnelDoor, FunnelWeeks } from '@/lib/types';
import { AnalyticsTabs } from '@/components/analytics/AnalyticsTabs';
import { CohortTable } from '@/components/analytics/CohortTable';
import { FunnelBars } from '@/components/analytics/FunnelBars';
import { KpiTile } from '@/components/analytics/KpiTile';
import { StalledList } from '@/components/analytics/StalledList';

export const dynamic = 'force-dynamic';

const WEEK_OPTIONS: FunnelWeeks[] = [4, 8, 12];
const DOOR_OPTIONS: { value: FunnelDoor; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'web', label: 'Web' },
];

export default async function FunnelsPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string | string[]; door?: string | string[] }>;
}) {
  await requireAdminSession();
  const { weeks: weeksParam, door: doorParam } = await searchParams;
  const weeks = parseFunnelWeeks(weeksParam);
  const door = parseFunnelDoor(doorParam);
  const now = new Date();

  // One wave of two queries: db.ts caps the shared pool at max: 5.
  const [cohortRows, stalledRows] = await Promise.all([getOnboardingCohorts(weeks), getOnboardingStalled()]);

  const cohorts = cohortsForDoor(cohortRows, door, cohortWeekStarts(weeks, now));
  const total = totalCounts(cohorts);
  const stages = funnelStages(total, door);
  const stalled = stalledForDoor(stalledRows, door);
  const stuckNow = sum(stalled.map((step) => step.workers));
  const doorLabel = DOOR_OPTIONS.find((option) => option.value === door)?.label ?? 'All';
  const tableRows = [...cohorts].reverse().map((week) => ({
    ...week,
    // bucketLabel's weekly form ("Week of Sep 28") is the '90d' branch.
    label: bucketLabel(week.cohortWeek, '90d'),
    settling: isSettling(week.cohortWeek, now),
  }));

  return (
    <main className="stack-gap">
      <section className="hero analytics-hero">
        <div>
          <AnalyticsTabs active="funnels" />
          <h1>Worker onboarding</h1>
          <p className="muted">Weekly cohorts by first contact · computed live</p>
        </div>
        <div className="funnel-pickers">
          <nav className="range-picker" aria-label="Cohort weeks">
            {WEEK_OPTIONS.map((value) => (
              <Link
                key={value}
                className="button"
                href={funnelsHref(value, door)}
                aria-current={value === weeks ? 'page' : undefined}
              >
                {value} weeks
              </Link>
            ))}
          </nav>
          <nav className="range-picker" aria-label="Sign-up door">
            {DOOR_OPTIONS.map(({ value, label }) => (
              <Link
                key={value}
                className="button"
                href={funnelsHref(weeks, value)}
                aria-current={value === door ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </section>

      <section className="kpi-strip funnel-kpis" aria-label="Key figures">
        <KpiTile label="Started" value={total.started} note={`${weeks} weeks · ${doorLabel}`} />
        <KpiTile label="Verified" value={total.verified} note={`${percentOf(total.verified, total.started) ?? '—'} of started`} />
        <KpiTile
          label="Ready"
          value={total.ready}
          note={`${percentOf(total.ready, total.started) ?? '—'} of started`}
          tone={total.ready > 0 ? 'positive' : 'muted'}
        />
        <KpiTile label="Stuck now" value={stuckNow} note={`No progress for ${FUNNEL_STALLED_DAYS}+ days`} />
      </section>

      <section className="grid analytics-bottom">
        <FunnelBars stages={stages} />
        <StalledList steps={stalled} days={FUNNEL_STALLED_DAYS} />
      </section>

      <CohortTable rows={tableRows} showCode={door === 'whatsapp'} />

      <p className="muted" style={{ fontSize: '0.78rem' }}>
        Workers reset by an operator and accounts from the retired web bypass are left out, so Verified
        here differs from the verified sign-ups on the Growth tab. Weeks before the onboarding
        funnel launched show no starters.
        {' '}{formatCount(total.declined)} declined the terms in these weeks.
      </p>
    </main>
  );
}
