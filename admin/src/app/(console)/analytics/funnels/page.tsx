import Link from 'next/link';
import { requireAdminSession } from '@/lib/server/session';
import {
  FUNNEL_STALLED_DAYS,
  getIdentityFunnel,
  getJobViewFunnel,
  getMatchToApply,
  getOnboardingCohorts,
  getOnboardingRestarts,
  getOnboardingStalled,
  getOnboardingSteps,
  getOperatorResets,
  getReferralFunnel,
  parseFunnelDoor,
  parseFunnelWeeks,
} from '@/lib/server/admin-analytics';
import { bucketLabel, formatCount, percentOf, sum } from '@/lib/analytics-format';
import {
  cohortWeekStarts,
  cohortsForDoor,
  funnelsHref,
  isSettling,
  onboardingStepStages,
  stalledForDoor,
  totalCounts,
  whatsappStages,
} from '@/lib/funnel';
import type { FunnelDoor } from '@/lib/types';
import { StatTile } from '@/components/ui/stat-tile';
import { AnalyticsHeader } from '@/components/analytics/AnalyticsHeader';
import { CohortTable } from '@/components/analytics/CohortTable';
import { OperatorResets } from '@/components/analytics/OperatorResets';
import { RestartsByStep } from '@/components/analytics/RestartsByStep';
import { StalledList } from '@/components/analytics/StalledList';
import {
  IdentityPanel,
  JobViewsPanel,
  MatchesPanel,
  OnboardingStepsPanel,
  ReferralPanel,
  WhatsAppPanel,
} from '@/components/analytics/panels/funnels';

export const dynamic = 'force-dynamic';

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

  // Three waves of three, each after the one before: db.ts caps the shared
  // pool at max: 5.
  const [cohortRows, stalledRows, steps] = await Promise.all([
    getOnboardingCohorts(weeks),
    getOnboardingStalled(),
    getOnboardingSteps(weeks, door),
  ]);
  const [identity, referrals, restartRows] = await Promise.all([
    getIdentityFunnel(weeks),
    getReferralFunnel(weeks),
    getOnboardingRestarts(weeks),
  ]);
  const [resetRows, jobViews, matches] = await Promise.all([
    getOperatorResets(weeks),
    getJobViewFunnel(weeks),
    getMatchToApply(weeks),
  ]);

  const cohorts = cohortsForDoor(cohortRows, door, cohortWeekStarts(weeks, now));
  const total = totalCounts(cohorts);
  const stalled = stalledForDoor(stalledRows, door);
  const stuckNow = sum(stalled.map((step) => step.workers));
  const doorLabel = DOOR_OPTIONS.find((option) => option.value === door)?.label ?? 'All';
  const tableRows = [...cohorts].reverse().map((week) => ({
    ...week,
    // bucketLabel's weekly form ("Week of Sep 28") is the '90d' branch.
    label: bucketLabel(week.cohortWeek, '90d'),
    settling: isSettling(week.cohortWeek, now),
  }));
  const wide = weeks > 13 ? 'min-w-0 lg:col-span-2' : 'min-w-0';

  return (
    <div className="flex flex-col gap-6">
      <AnalyticsHeader active="funnels" weeks={weeks} rangeHref={(value) => funnelsHref(value, door)} />

      <nav aria-label="Sign-up door" className="flex flex-wrap items-center gap-1 text-sm">
        <span className="mr-1 text-[var(--jale-ink-2)]">Door</span>
        {DOOR_OPTIONS.map(({ value, label }) => (
          <Link
            key={value}
            href={funnelsHref(weeks, value)}
            prefetch={false}
            aria-current={value === door ? 'page' : undefined}
            className="inline-flex min-h-9 items-center rounded-full border border-[var(--jale-divider)] px-3 font-semibold aria-[current=page]:bg-[var(--primary)] aria-[current=page]:text-[var(--primary-fg)]"
          >
            {label}
          </Link>
        ))}
      </nav>

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Started" value={formatCount(total.started)} hint={`${weeks} weeks · ${doorLabel}`} />
        <StatTile label="Verified" value={formatCount(total.verified)} hint={`${percentOf(total.verified, total.started) ?? '—'} of started`} />
        <StatTile label="Ready" value={formatCount(total.ready)} hint={`${percentOf(total.ready, total.started) ?? '—'} of started`} />
        <StatTile label="Stuck now" value={formatCount(stuckNow)} hint={`No progress for ${FUNNEL_STALLED_DAYS}+ days`} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <OnboardingStepsPanel tag="#14" stages={onboardingStepStages(steps)} />
        </div>
        <div className="min-w-0">
          <IdentityPanel tag="#15" funnel={identity} />
        </div>
        <div className="min-w-0">
          <WhatsAppPanel tag="#12" stages={whatsappStages(cohortRows, weeks, now)} />
        </div>
        <div className="min-w-0">
          <ReferralPanel tag="#21" result={referrals} />
        </div>
        <div className={wide}>
          <JobViewsPanel tag="#17" result={jobViews} weeks={weeks} />
        </div>
        <div className={wide}>
          <MatchesPanel tag="#20" result={matches} weeks={weeks} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <StalledList steps={stalled} days={FUNNEL_STALLED_DAYS} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <CohortTable rows={tableRows} showCode={door === 'whatsapp'} declined={total.declined} />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <RestartsByStep rows={restartRows} door={door} weeks={weeks} now={now} />
          <OperatorResets rows={resetRows} now={now} />
        </div>
      </div>
    </div>
  );
}
