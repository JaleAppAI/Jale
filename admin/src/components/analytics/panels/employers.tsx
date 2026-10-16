import { StatTile } from '@/components/ui/stat-tile';
import { formatCount, formatRate } from '@/lib/analytics-format';
import { employersHref, formatDuration, hiresChart, responseChart, staleNote, templateReuseChart } from '@/lib/employer-health';
import type { StaleDays, TemplateReuseWeek } from '@/lib/server/admin-analytics';
import type { AnalyticsTotals, EmployerHealthSummary, EmployerWeek, FunnelWeeks, StaleJob } from '@/lib/types';
import { AnalyticsPanel, Headline } from '../AnalyticsPanel';
import { BarChart } from '../charts/BarChart';
import { ChartFrame } from '../charts/ChartFrame';
import { CollectingSince } from '../charts/CollectingSince';
import { LineChart } from '../charts/LineChart';
import { seriesTable } from '../charts/text';
import { StaleJobsList } from '../StaleJobsList';
import { StalePicker } from '../StalePicker';

// #3: hires, not "filled jobs" (a job is filled only when every opening is hired).
export function HiresPanel({ tag, totals, weekly, now }: { tag: string; totals: AnalyticsTotals; weekly: EmployerWeek[]; now: Date }) {
  const chart = hiresChart(weekly, now);
  return (
    <ChartFrame
      title="Hires"
      tag={tag}
      howCounted={'A job counts as "filled" only when every opening is hired, so most jobs with hires are not "filled".'}
      table={seriesTable('Hires by week', chart.labels, chart.series, { format: formatCount, partialLast: chart.partialLast })}
    >
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Workers hired" value={formatCount(totals.hiresTotal)} hint="All time" />
        <StatTile label="Jobs with a hire" value={formatCount(totals.jobsWithHire)} hint="All time" />
      </div>
      <BarChart
        title="Hires per week"
        labels={chart.labels}
        series={chart.series}
        xTitle="Week of the hire"
        yTitle="Hires"
        partialLast={chart.partialLast}
      />
    </ChartFrame>
  );
}

// #4: the stale-days picker drives the list and the count.
export function StaleJobsPanel({ tag, jobs, days, weeks }: { tag: string; jobs: StaleJob[]; days: StaleDays; weeks: FunnelWeeks }) {
  return (
    <AnalyticsPanel
      title="Stale jobs"
      tag={tag}
      tools={<StalePicker current={days} hrefFor={(value) => employersHref(weeks, value)} />}
      howCounted="What counts as an employer action: a message to the worker, a details request, a hire with a recorded time, or a status change to contacted, details requested, hired or not interested. Employer actions taken only through the status dropdown before Oct 2 were not recorded, so some jobs show as idle since posting."
      notes={['A job that was paused and reopened counts its idle days from the last employer action, which can be before the pause.']}
    >
      <Headline value={formatCount(jobs.length)} note={staleNote(jobs.length)} />
      <StaleJobsList rows={jobs} days={days} />
    </AnalyticsPanel>
  );
}

// #8: weekly medians, in hours.
export function ResponseTimePanel({ tag, weekly, summary, now }: { tag: string; weekly: EmployerWeek[]; summary: EmployerHealthSummary; now: Date }) {
  const chart = responseChart(weekly, now);
  return (
    <ChartFrame
      title="Employer response time"
      tag={tag}
      subtitle="Median hours per week · blank where nothing was answered · the last two weeks are still settling"
      howCounted="Status changes are recorded since Oct 2, 2026. Dropdown status changes before Oct 2 have no time, so they count as answered but not in the medians."
      table={seriesTable('Median hours by week', chart.labels, chart.series, { format: formatRate, unit: 'h', partialLast: chart.partialLast })}
    >
      <Headline value={formatDuration(summary.firstResponseP50Hours)} note="median from application to first employer response" />
      <LineChart
        title="Employer response time"
        labels={chart.labels}
        series={chart.series}
        xTitle="Week starting"
        yTitle="Median hours"
        unit="h"
        formatValue={formatRate}
        partialLast={chart.partialLast}
      />
    </ChartFrame>
  );
}

// #18: collected from this release.
export function TemplateReusePanel({
  tag,
  result,
  weeks,
}: {
  tag: string;
  result: { weeks: TemplateReuseWeek[]; collectingSince: string | null };
  weeks: FunnelWeeks;
}) {
  const chart = templateReuseChart(result);
  return (
    <ChartFrame
      title="Job template reuse"
      tag={tag}
      howCounted="A job counts as from a template when the employer applied a saved template, even if they edited it before posting."
      table={seriesTable('Jobs from a template by week (%)', chart.labels, chart.series, { format: formatRate, unit: '%', partialLast: chart.partialLast })}
    >
      {chart.empty ? (
        <CollectingSince
          title="share of new jobs posted from a template, by week"
          xTitle="Week since release"
          yTitle="Jobs from a template (%)"
          unit="%"
          slots={weeks}
        />
      ) : (
        <LineChart
          title="Job template reuse"
          labels={chart.labels}
          series={chart.series}
          xTitle="Week starting"
          yTitle="Jobs from a template (%)"
          unit="%"
          formatValue={formatRate}
          partialLast={chart.partialLast}
        />
      )}
    </ChartFrame>
  );
}
