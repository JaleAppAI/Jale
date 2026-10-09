import Link from 'next/link';
import { requireAdminSession } from '@/lib/server/session';
import {
  STALE_JOB_DAYS,
  getEmployerWeekly,
  getSlowestEmployers,
  getStaleJobs,
  parseFunnelWeeks,
} from '@/lib/server/admin-analytics';
import { bucketLabel } from '@/lib/analytics-format';
import {
  employersHref,
  firstResponseNote,
  formatDays,
  formatDuration,
  formatHours,
  hiresNote,
  replyNote,
  splitEmployerWeekly,
  staleJobsNote,
  weeklyTableRows,
} from '@/lib/employer-health';
import type { FunnelWeeks } from '@/lib/types';
import { AnalyticsTabs } from '@/components/analytics/AnalyticsTabs';
import { EmployerWeeklyTable } from '@/components/analytics/EmployerWeeklyTable';
import { KpiTile } from '@/components/analytics/KpiTile';
import { SlowestEmployers } from '@/components/analytics/SlowestEmployers';
import { StaleJobsList } from '@/components/analytics/StaleJobsList';
import { TrendChart } from '@/components/analytics/TrendChart';

export const dynamic = 'force-dynamic';

const WEEK_OPTIONS: FunnelWeeks[] = [4, 8, 12];

const FIRST_RESPONSE_BLUE = '#0179ff';
const REPLY_ORANGE = '#eb6834';

export default async function EmployersPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string | string[] }>;
}) {
  await requireAdminSession();
  const { weeks: weeksParam } = await searchParams;
  const weeks = parseFunnelWeeks(weeksParam);
  const now = new Date();

  // One wave of three queries: db.ts caps the shared pool at max: 5.
  const [weeklyRows, slowest, staleJobs] = await Promise.all([
    getEmployerWeekly(weeks),
    getSlowestEmployers(weeks),
    getStaleJobs(),
  ]);

  const { weekly, summary } = splitEmployerWeekly(weeklyRows);
  const labels = weekly.map((week) => bucketLabel(week.weekStart, '90d'));
  const lastWeek = weekly[weekly.length - 1];
  // A week with nothing to time has no median (null): the chart leaves a gap.
  const firstResponseSeries = weekly.map((week) => week.firstResponseP50Hours);
  const replySeries = weekly.map((week) => week.replyP50Hours);

  return (
    <main className="stack-gap">
      <section className="hero analytics-hero">
        <div>
          <AnalyticsTabs active="employers" />
          <h1>Employer health</h1>
          <p className="muted">How fast employers answer workers, week by week · computed live</p>
        </div>
        <nav className="range-picker" aria-label="Weeks">
          {WEEK_OPTIONS.map((value) => (
            <Link
              key={value}
              className="button"
              href={employersHref(value)}
              aria-current={value === weeks ? 'page' : undefined}
            >
              {value} weeks
            </Link>
          ))}
        </nav>
      </section>

      <section className="kpi-strip funnel-kpis" aria-label="Key figures">
        <KpiTile label="First response" value={formatDuration(summary.firstResponseP50Hours)} note={firstResponseNote(summary)} />
        <KpiTile label="Reply time" value={formatDuration(summary.replyP50Hours)} note={replyNote(summary)} />
        <KpiTile label="Time to hire" value={formatDays(summary.timeToHireP50Days)} note={hiresNote(summary)} />
        <KpiTile label="Stale jobs" value={staleJobs.length} note={staleJobsNote(summary.activeJobs)} />
      </section>

      <TrendChart
        title="Response times"
        subtitle="Median hours per week · blank where nothing was answered · the last two weeks are still settling"
        labels={labels}
        tableCaption="Median hours by week"
        partialLast
        series={[
          {
            key: 'firstResponse',
            label: 'First response',
            color: FIRST_RESPONSE_BLUE,
            values: firstResponseSeries,
            endLabel: formatHours(lastWeek?.firstResponseP50Hours ?? null),
          },
          {
            key: 'reply',
            label: 'Reply time',
            color: REPLY_ORANGE,
            values: replySeries,
            endLabel: formatHours(lastWeek?.replyP50Hours ?? null),
          },
        ]}
      />

      <EmployerWeeklyTable rows={weeklyTableRows(weekly, now)} />

      <SlowestEmployers rows={slowest} />

      <StaleJobsList rows={staleJobs} days={STALE_JOB_DAYS} />

      <p className="muted" style={{ fontSize: '0.78rem' }}>
        What counts as an employer action: a message to the worker, a details request, a hire with a recorded
        time, or a status change to contacted, details requested, hired or not interested. Status changes are
        recorded since Oct 2, 2026. Dropdown status changes before Oct 2 have no time, so they count as answered
        but not in the medians. Employer actions taken only through the status dropdown before Oct 2 were not
        recorded, so some jobs show as idle since posting. A job that was paused and reopened counts its idle
        days from the last employer action, which can be before the pause. Hires from before hire times were
        recorded are marked approx.: they count as answered but not timed, and their time to hire is approximate. Time to hire
        includes the worker completing their details. Worker messages: a run of consecutive messages from a
        worker counts once, and conversations closed without a reply are left out. The unanswered shares count
        only applications and worker messages at least 7 days old. Weeks marked settling are less than 14 days
        old, so their unanswered counts are not final; a late answer can still change an older week too. Deleted
        jobs drop out of every figure. Test employer accounts are left out.
      </p>
    </main>
  );
}
