import Link from 'next/link';
import {
  ANALYTICS_RELEASE_LABEL,
  cumulativeSeries,
  formatCount,
  growthHref,
  perUnit,
  sum,
  weekLabel,
} from '@/lib/analytics-format';
import { digestHeadline, digestSendChart, type DigestSplit } from '@/lib/digest';
import { approximateNote, payingChart, payingHeadline } from '@/lib/employer-health';
import { acquisitionChart } from '@/lib/funnel';
import type { AcquisitionWeek, PayingWeek } from '@/lib/server/admin-analytics';
import type { AnalyticsTotals, DigestAdoption, FunnelWeeks, JobsActivityBucket, SignupBucket, SignupsView } from '@/lib/types';
import { Headline } from '../AnalyticsPanel';
import { BarChart } from '../charts/BarChart';
import { ChartFrame } from '../charts/ChartFrame';
import { CollectingSince } from '../charts/CollectingSince';
import { LineChart } from '../charts/LineChart';
import { StackedLines } from '../charts/StackedLines';
import { seriesTable } from '../charts/text';

const SIGNUP_VIEWS: { value: SignupsView; label: string }[] = [
  { value: 'total', label: 'Total' },
  { value: 'new', label: 'New' },
];

// #1: running totals of workers and companies (or new sign-ups per week);
// verified workers ride in the table twin.
export function SignupsPanel({
  tag,
  rows,
  totals,
  view,
  weeks,
}: {
  tag: string;
  rows: SignupBucket[];
  totals: AnalyticsTotals;
  view: SignupsView;
  weeks: FunnelWeeks;
}) {
  const cumulative = view === 'total';
  const labels = rows.map((row) => weekLabel(row.bucketStart));
  const workersNew = rows.map((row) => row.workerSignups);
  const employersNew = rows.map((row) => row.employerSignups);
  const verifiedNew = rows.map((row) => row.workerSignupsVerified);
  const workers = cumulative ? cumulativeSeries(workersNew, totals.totalWorkers) : workersNew;
  const employers = cumulative ? cumulativeSeries(employersNew, totals.totalEmployers) : employersNew;
  const verified = cumulative ? cumulativeSeries(verifiedNew, totals.totalVerifiedWorkers) : verifiedNew;
  const thisWeek = (workersNew.at(-1) ?? 0) + (employersNew.at(-1) ?? 0);
  const series = [
    { key: 'workers', label: 'Workers', color: 'chart-1' as const, values: workers },
    { key: 'employers', label: 'Companies', color: 'chart-2' as const, values: employers },
  ];
  const title = cumulative ? 'Signups, cumulative' : 'Signups per week';
  return (
    <ChartFrame
      title={title}
      tag={tag}
      tools={
        <nav aria-label="Signups view" className="flex gap-1 text-sm">
          {SIGNUP_VIEWS.map(({ value, label }) => (
            <Link
              key={value}
              href={growthHref(weeks, value)}
              prefetch={false}
              aria-current={value === view ? 'page' : undefined}
              className="rounded-full border border-[var(--jale-divider)] px-3 py-1 font-semibold aria-[current=page]:bg-[var(--primary)] aria-[current=page]:text-[var(--primary-fg)]"
            >
              {label}
            </Link>
          ))}
        </nav>
      }
      howCounted="Running totals count back from today's totals, so accounts deleted since then are missing from earlier weeks too. Employer sign-ups count companies; a team member joining a company is not counted."
      table={seriesTable(
        cumulative ? 'Total sign-ups by week' : 'New sign-ups by week',
        labels,
        [...series, { key: 'verified', label: 'Verified workers', color: 'chart-3', values: verified }],
        { format: formatCount, partialLast: true },
      )}
    >
      <Headline
        value={formatCount(totals.totalWorkers + totals.totalEmployers)}
        note={`+${formatCount(thisWeek)} this week so far`}
      />
      <LineChart
        title={title}
        labels={labels}
        series={series}
        xTitle="Week starting"
        yTitle={cumulative ? 'Total signups' : 'New signups'}
        partialLast
      />
    </ChartFrame>
  );
}

// #2
export function PayingPanel({ tag, result }: { tag: string; result: { weeks: PayingWeek[]; approximateBefore: string | null } }) {
  const chart = payingChart(result);
  const headline = payingHeadline(result.weeks);
  const caption = approximateNote(result.approximateBefore);
  const weeks = [...result.weeks].sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart));
  return (
    <ChartFrame
      title="New paying companies, by week"
      tag={tag}
      caption={caption ?? undefined}
      howCounted="Paying means active, trialing or past due, as of the end of each week; new paying is the first move into paying that week."
      table={{
        caption: 'Paying companies by week',
        columns: ['Week', 'Companies', 'Paying', 'New paying', 'Stopped paying'],
        rows: weeks.map((w, i) => [
          i === weeks.length - 1 && w.partial ? `${chart.labels[i]} (so far)` : chart.labels[i],
          formatCount(w.employers),
          formatCount(w.paying),
          formatCount(w.newPaying),
          formatCount(w.churned),
        ]),
      }}
    >
      <Headline value={headline.value} note={headline.note} />
      <BarChart
        title="New paying companies, by week"
        labels={chart.labels}
        series={chart.series}
        xTitle="Week starting"
        yTitle="New paying companies"
        partialLast={chart.partialLast}
      />
    </ChartFrame>
  );
}

// #13: "Digest adoption" (K3.1, D-A3): no email-open tracking exists, so the panel shows adoption and sends.
export function DigestAdoptionPanel({ tag, adoption, sends, now }: { tag: string; adoption: DigestAdoption; sends: DigestSplit; now: Date }) {
  const headline = digestHeadline(adoption);
  const chart = digestSendChart(sends, now);
  const series = [{ key: 'sent', label: 'Digest emails sent', color: 'chart-1' as const, values: chart.values }];
  return (
    <ChartFrame
      title="Digest adoption"
      tag={tag}
      howCounted="Employer logins with the applicant digest on and an email address, as of now; sends by the week they were queued."
      table={seriesTable('Digest emails sent by week', chart.labels, series, { format: formatCount, partialLast: chart.partialLast })}
    >
      <Headline value={headline.value} note={headline.note} />
      <LineChart
        title="Digest emails sent"
        labels={chart.labels}
        series={series}
        xTitle="Week starting"
        yTitle="Digest emails sent"
        partialLast={chart.partialLast}
      />
    </ChartFrame>
  );
}

// #16: collected from this release; until then, empty labelled axes.
export function AcquisitionPanel({
  tag,
  result,
  weeks,
}: {
  tag: string;
  result: { weeks: AcquisitionWeek[]; collectingSince: string | null };
  weeks: FunnelWeeks;
}) {
  const chart = acquisitionChart(result);
  return (
    <ChartFrame
      title="Where signups come from"
      tag={tag}
      howCounted="First-party only: the source code on Jale's own links, or the WhatsApp entry. No tracking cookies, referrers or ad tags."
      caption={result.collectingSince === null ? undefined : `Collecting since ${weekLabel(result.collectingSince)}.`}
      table={seriesTable('Signups by source and week', chart.labels, chart.series, { format: formatCount, partialLast: chart.partialLast })}
    >
      {chart.empty ? (
        <CollectingSince
          title="Signups per week by source"
          xTitle="Week since release"
          yTitle="Signups per week"
          slots={weeks}
          releaseLabel={ANALYTICS_RELEASE_LABEL}
          note="One line per source: shared links, campaign tags, referrals, direct."
        />
      ) : (
        <StackedLines
          title="Signups per week by source"
          labels={chart.labels}
          series={chart.series}
          xTitle="Week starting"
          yTitle="Signups per week"
          partialLast={chart.partialLast}
        />
      )}
    </ChartFrame>
  );
}

// Kept: jobs posted per week (was the old column chart).
export function JobsPostedPanel({ rows }: { rows: JobsActivityBucket[] }) {
  const labels = rows.map((row) => weekLabel(row.bucketStart));
  const values = rows.map((row) => row.jobsPosted);
  const series = [{ key: 'jobs', label: 'Jobs posted', color: 'chart-1' as const, values }];
  return (
    <ChartFrame
      title="Jobs posted"
      subtitle={`${formatCount(sum(values))} this period`}
      table={seriesTable('Jobs posted by week', labels, series, { format: formatCount, partialLast: true })}
    >
      <BarChart title="Jobs posted" labels={labels} series={series} xTitle="Week starting" yTitle="Jobs posted" partialLast />
    </ChartFrame>
  );
}

// Kept: applications per week.
export function ApplicationsPanel({ rows }: { rows: JobsActivityBucket[] }) {
  const labels = rows.map((row) => weekLabel(row.bucketStart));
  const values = rows.map((row) => row.applicationsSubmitted);
  const total = sum(values);
  const perJob = perUnit(total, sum(rows.map((row) => row.jobsPosted)));
  const series = [{ key: 'applications', label: 'Applications', color: 'chart-1' as const, values }];
  return (
    <ChartFrame
      title="Applications"
      subtitle={perJob ? `${formatCount(total)} this period · ${perJob} per job` : `${formatCount(total)} this period`}
      table={seriesTable('Applications by week', labels, series, { format: formatCount, partialLast: true })}
    >
      <LineChart title="Applications" labels={labels} series={series} xTitle="Week starting" yTitle="Applications" partialLast />
    </ChartFrame>
  );
}
