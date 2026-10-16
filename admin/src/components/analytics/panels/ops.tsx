import Link from 'next/link';
import { formatCount, formatRate, wholePercent } from '@/lib/analytics-format';
import { caseAgeChart, extractionChart, resetReasonChart, resetValueText, resolutionChart, type VoiceSplit } from '@/lib/ops-health';
import type { CaseAgeBucket, CaseResolutionWeek, ResetReasonCount } from '@/lib/server/admin-analytics';
import { BarChart } from '../charts/BarChart';
import { ChartFrame } from '../charts/ChartFrame';
import { ItemTag } from '../charts/ItemTag';
import { LineChart } from '../charts/LineChart';
import { seriesTable } from '../charts/text';

// #6: open cases by how long they have waited, and by whom they wait on.
export function CaseAgingPanel({ tag, buckets }: { tag: string; buckets: CaseAgeBucket[] }) {
  const chart = caseAgeChart(buckets);
  return (
    <ChartFrame
      title="Open cases by age"
      tag={tag}
      subtitle={`${formatCount(chart.total)} open right now`}
      howCounted="Age is the time since the case last changed status; waiting on the worker means we asked them for something."
      table={seriesTable('Open cases by age', chart.labels, chart.series, { format: formatCount, firstColumn: 'Waiting time' })}
    >
      <BarChart
        title="Open cases by age"
        orientation="horizontal"
        labels={chart.labels}
        series={chart.series}
        xTitle="Open cases"
        yTitle="Waiting time"
      />
    </ChartFrame>
  );
}

// #6: how long resolved cases took, per week.
export function CaseResolutionPanel({ tag, weeks }: { tag: string; weeks: CaseResolutionWeek[] }) {
  const chart = resolutionChart(weeks);
  const table = seriesTable('Hours to resolve by week', chart.labels, chart.series, { format: formatRate, unit: 'h', partialLast: chart.partialLast });
  return (
    <ChartFrame
      title="Time to resolve a case"
      tag={tag}
      howCounted="Hours from a case opening to its resolution, by the week it was resolved; a week with nothing resolved has no median."
      table={{ ...table, columns: [...table.columns, 'Resolved'], rows: table.rows.map((row, i) => [...row, formatCount(chart.resolved[i] ?? 0)]) }}
    >
      <LineChart
        title="Time to resolve a case"
        labels={chart.labels}
        series={chart.series}
        xTitle="Week resolved"
        yTitle="Hours to resolve"
        unit="h"
        formatValue={formatRate}
        partialLast={chart.partialLast}
      />
    </ChartFrame>
  );
}

// #5 (last 30 days), with the #7 link to the verification records.
export function ResetReasonsPanel({ tag, linkTag, rows }: { tag: string; linkTag: string; rows: ResetReasonCount[] }) {
  const chart = resetReasonChart(rows);
  const format = resetValueText(chart.total);
  return (
    <ChartFrame
      title="Verification resets by reason"
      tag={tag}
      caption={
        <Link href="/inbox?tab=lockouts" prefetch={false} className="font-semibold">
          Open a verification record (<ItemTag tag={linkTag} />: attempts and timeline) →
        </Link>
      }
      howCounted="Lockout resets by the reason an admin picked, plus operator resets as one row; the last 30 days."
      table={{
        caption: 'Verification resets by reason, last 30 days',
        columns: ['Reason', 'Resets', 'Share'],
        rows: chart.labels.map((label, i) => [label, formatCount(chart.values[i]), wholePercent(chart.values[i], chart.total)]),
      }}
    >
      {chart.labels.length === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No verification resets in the last 30 days.</p>
      ) : (
        <BarChart
          title="Verification resets by reason"
          orientation="horizontal"
          labels={chart.labels}
          series={[{ key: 'resets', label: 'Resets', color: 'chart-1', values: chart.values }]}
          xTitle={`Resets, last 30 days (${formatCount(chart.total)} total)`}
          yTitle="Reason"
          formatValue={format}
        />
      )}
    </ChartFrame>
  );
}

// #10: the axis starts at 80% only when every week is above it, and then says so.
export function ExtractionPanel({ tag, voice, now }: { tag: string; voice: VoiceSplit; now: Date }) {
  const chart = extractionChart(voice, now);
  const series = [{ key: 'usable', label: 'Usable voice notes', color: 'chart-1' as const, values: chart.values }];
  return (
    <ChartFrame
      title="AI extraction completeness"
      tag={tag}
      caption={chart.yMin === 80 ? 'The vertical axis starts at 80% so week-to-week changes are visible.' : undefined}
      howCounted="Voice notes the AI turned into usable profile fields, as a share of attempts, by the week they were processed."
      table={seriesTable('Usable voice notes by week (%)', chart.labels, series, { format: formatRate, unit: '%', partialLast: chart.partialLast })}
    >
      <LineChart
        title="AI extraction completeness"
        labels={chart.labels}
        series={series}
        xTitle="Week starting"
        yTitle="Usable voice notes (%)"
        unit="%"
        formatValue={formatRate}
        partialLast={chart.partialLast}
        yMin={chart.yMin}
      />
    </ChartFrame>
  );
}
