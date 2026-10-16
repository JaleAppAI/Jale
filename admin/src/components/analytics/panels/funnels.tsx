import Link from 'next/link';
import type { ReactNode } from 'react';
import { KVList } from '@/components/ui/kv-list';
import { ANALYTICS_RELEASE_LABEL, formatRate, funnelLabel, weekLabel, wholePercent } from '@/lib/analytics-format';
import {
  ATTEMPT_LABELS,
  identityAttemptValues,
  identityOutcomes,
  identityStages,
  identityTimingText,
  jobViewChart,
  matchChart,
  onboardingCaption,
  referralNote,
  referralStages,
  type FunnelStageView,
  type WeeklyChart,
} from '@/lib/funnel';
import type { IdentityFunnel, JobViewWeek, MatchWeek, ReferralWeek } from '@/lib/server/admin-analytics';
import type { FunnelWeeks } from '@/lib/types';
import { ChartFrame } from '../charts/ChartFrame';
import { CollectingSince } from '../charts/CollectingSince';
import { FunnelChart } from '../charts/FunnelChart';
import { LineChart } from '../charts/LineChart';
import { seriesTable } from '../charts/text';
import type { ChartColor, ChartTable } from '../charts/types';

// The table twin of a funnel: each stage, its count and its share of the base.
function funnelTable(caption: string, stages: FunnelStageView[]): ChartTable {
  const base = stages[0]?.count ?? 0;
  return {
    caption,
    columns: ['Stage', 'Count', 'Share of the first stage'],
    rows: stages.map((stage) => [stage.label, stage.count, wholePercent(stage.count, base)]),
  };
}

function FunnelPanel({
  title,
  tag,
  stages,
  xTitle,
  yTitle,
  color,
  caption,
  howCounted,
}: {
  title: string;
  tag: string;
  stages: FunnelStageView[];
  xTitle: string;
  yTitle: string;
  color?: ChartColor;
  caption?: ReactNode;
  howCounted?: string;
}) {
  return (
    <ChartFrame title={title} tag={tag} caption={caption} howCounted={howCounted} table={funnelTable(`${title} by stage`, stages)}>
      <FunnelChart title={title} stages={stages} xTitle={xTitle} yTitle={yTitle} color={color} />
    </ChartFrame>
  );
}

// #14
export function OnboardingStepsPanel({ tag, stages }: { tag: string; stages: FunnelStageView[] }) {
  return (
    <FunnelPanel
      title="Worker onboarding, step by step"
      tag={tag}
      stages={stages}
      xTitle="Share of workers who started (%) · count"
      yTitle="Onboarding step"
      caption={onboardingCaption(stages)}
      howCounted="Workers by the week they started, counted at every step they reached; a step only some workers take is marked and never counts as a drop."
    />
  );
}

// #15 (WhatsApp door only)
export function IdentityPanel({ tag, funnel }: { tag: string; funnel: IdentityFunnel }) {
  const attempts = identityAttemptValues(funnel);
  return (
    <ChartFrame
      title="Identity verification"
      tag={tag}
      caption={
        <Link href="/inbox?tab=lockouts" prefetch={false} className="font-semibold">
          See locked-out workers →
        </Link>
      }
      howCounted="WhatsApp verifications by the week they started. Timings leave out records restored from before history was kept."
      table={funnelTable('Identity verification by stage', identityStages(funnel))}
    >
      <FunnelChart
        title="Identity verification"
        stages={identityStages(funnel)}
        xTitle="Share of workers who started verification (%) · count"
        yTitle="Verification step"
        color="chart-2"
      />
      <KVList
        items={[
          ...identityOutcomes(funnel),
          ...ATTEMPT_LABELS.map((label, i) => ({ label, value: funnelLabel(attempts[i], funnel.challenges) })),
          { label: 'Time to verify', value: identityTimingText(funnel) },
        ]}
      />
    </ChartFrame>
  );
}

// #12
export function WhatsAppPanel({ tag, stages }: { tag: string; stages: FunnelStageView[] }) {
  return (
    <FunnelPanel
      title="WhatsApp conversations"
      tag={tag}
      stages={stages}
      xTitle="Share of conversations (%) · count"
      yTitle="Conversation stage"
      howCounted="Workers whose first WhatsApp message was in these weeks; Requested a code means they chose a language and got as far as the code."
    />
  );
}

// #21
export function ReferralPanel({ tag, result }: { tag: string; result: { weeks: ReferralWeek[]; snapshotsSince: string | null } }) {
  return (
    <FunnelPanel
      title="Referrals"
      tag={tag}
      stages={referralStages(result.weeks)}
      xTitle="Share of opened links (%) · count"
      yTitle="Referral stage"
      color="chart-2"
      caption={referralNote(result.snapshotsSince)}
    />
  );
}

function RatePanel({
  title,
  tag,
  chart,
  collectingSince,
  yTitle,
  weeks,
  emptyTitle,
  caption,
  howCounted,
}: {
  title: string;
  tag: string;
  chart: WeeklyChart;
  collectingSince: string | null;
  yTitle: string;
  weeks: FunnelWeeks;
  emptyTitle: string;
  caption?: string;
  howCounted: string;
}) {
  return (
    <ChartFrame
      title={title}
      tag={tag}
      caption={caption ?? (collectingSince === null ? undefined : `Collecting since ${weekLabel(collectingSince)}.`)}
      howCounted={howCounted}
      table={seriesTable(`${title} by week (%)`, chart.labels, chart.series, { format: formatRate, unit: '%', partialLast: chart.partialLast })}
    >
      {chart.empty ? (
        <CollectingSince title={emptyTitle} xTitle="Week since release" yTitle={yTitle} unit="%" slots={weeks} />
      ) : (
        <LineChart
          title={title}
          labels={chart.labels}
          series={chart.series}
          xTitle="Week starting"
          yTitle={yTitle}
          unit="%"
          formatValue={formatRate}
          partialLast={chart.partialLast}
        />
      )}
    </ChartFrame>
  );
}

// #17
export function JobViewsPanel({ tag, result, weeks }: { tag: string; result: { weeks: JobViewWeek[]; collectingSince: string | null }; weeks: FunnelWeeks }) {
  const chart = jobViewChart(result);
  return (
    <RatePanel
      title="Job views to applications"
      tag={tag}
      chart={chart}
      collectingSince={result.collectingSince}
      yTitle="Views that apply (%)"
      weeks={weeks}
      emptyTitle="share of job views that become applications, by week"
      caption={
        result.collectingSince === null && !chart.empty
          ? `Signed-in workers: no data yet · collecting since ${ANALYTICS_RELEASE_LABEL}.`
          : undefined
      }
      howCounted="Public job page: visits (one per visitor per 30 minutes) that led to an application. Signed-in workers: job detail views (one per worker per hour)."
    />
  );
}

// #20
export function MatchesPanel({ tag, result, weeks }: { tag: string; result: { weeks: MatchWeek[]; collectingSince: string | null }; weeks: FunnelWeeks }) {
  return (
    <RatePanel
      title="Matches to applications"
      tag={tag}
      chart={matchChart(result)}
      collectingSince={result.collectingSince}
      yTitle="Matches that apply (%)"
      weeks={weeks}
      emptyTitle="share of matches shown to workers that become applications, by week"
      howCounted="A match is a job shown to a worker in the web feed or a WhatsApp job alert; it counts as applied when the worker applies within 7 days, so the latest week is still filling in."
    />
  );
}
