import Link from 'next/link';
import { requireAdminSession } from '@/lib/server/session';
import {
  DEFAULT_ANALYTICS_RANGE,
  getAnalyticsTotals,
  getJobsActivity,
  getMessageTraffic,
  getPayingEmployers,
  getSignups,
  parseAnalyticsRange,
  parseSignupsView,
} from '@/lib/server/admin-analytics';
import type { AnalyticsRange, SignupsView } from '@/lib/types';
import {
  analyticsHref,
  bucketLabel,
  cumulativeSeries,
  formatCount,
  percentOf,
  perUnit,
  signedDelta,
  sum,
} from '@/lib/analytics-format';
import { TrendChart } from '@/components/analytics/TrendChart';
import { ColumnChart } from '@/components/analytics/ColumnChart';
import { KpiTile } from '@/components/analytics/KpiTile';
import { DeliveryHealth } from '@/components/analytics/DeliveryHealth';
import { PayingEmployersList } from '@/components/analytics/PayingEmployersList';

export const dynamic = 'force-dynamic';

const RANGES: { value: AnalyticsRange; label: string; period: string }[] = [
  { value: '7d', label: 'Last 7 days', period: 'the last 7 days' },
  { value: '30d', label: 'Last 30 days', period: 'the last 30 days' },
  { value: '90d', label: 'Last 90 days', period: 'the last 90 days' },
];

const SIGNUP_VIEWS: { value: SignupsView; label: string }[] = [
  { value: 'total', label: 'Total' },
  { value: 'new', label: 'New' },
];

const WORKERS_BLUE = '#0179ff';
const EMPLOYERS_ORANGE = '#eb6834';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[]; signups?: string | string[] }>;
}) {
  await requireAdminSession();
  const { range: rangeParam, signups: signupsParam } = await searchParams;
  const range = parseAnalyticsRange(rangeParam ?? DEFAULT_ANALYTICS_RANGE);
  const signupsView = parseSignupsView(signupsParam);
  const period = RANGES.find((r) => r.value === range)?.period ?? 'this period';

  // db.ts caps the shared pool at max: 5, so running all five analytics queries
  // concurrently in one Promise.all would occupy the entire pool and could make a
  // concurrent admin request hit the connect timeout. Split into two waves instead.
  const [signups, jobsActivity, messageTraffic] = await Promise.all([
    getSignups(range),
    getJobsActivity(range),
    getMessageTraffic(range),
  ]);
  const [totals, payingEmployers] = await Promise.all([
    getAnalyticsTotals(),
    getPayingEmployers(),
  ]);

  const labels = signups.map((row) => bucketLabel(row.bucketStart, range));
  const workerSignups = signups.map((row) => row.workerSignups);
  const employerSignups = signups.map((row) => row.employerSignups);
  const jobsPosted = jobsActivity.map((row) => row.jobsPosted);
  const applications = jobsActivity.map((row) => row.applicationsSubmitted);

  const newWorkers = sum(workerSignups);
  const newEmployers = sum(employerSignups);
  const jobsPostedTotal = sum(jobsPosted);
  const applicationsTotal = sum(applications);
  const appsPerJob = perUnit(applicationsTotal, jobsPostedTotal);
  const payingShare = percentOf(totals.payingEmployers, totals.totalEmployers);
  const totalJobs = totals.jobsActive + totals.jobsPaused + totals.jobsFilled + totals.jobsClosed;
  const hireShare = percentOf(totals.jobsWithHire, totalJobs);

  // 'total' plots the running account count, which ends at today's total, so
  // nothing is in progress. 'new' plots per-bucket signups, whose last bucket
  // (today / this week) is still filling up and must not read as a drop.
  const cumulative = signupsView === 'total';
  const workerSeries = cumulative ? cumulativeSeries(workerSignups, totals.totalWorkers) : workerSignups;
  const employerSeries = cumulative ? cumulativeSeries(employerSignups, totals.totalEmployers) : employerSignups;
  const lastWorkers = workerSeries[workerSeries.length - 1] ?? 0;
  const lastEmployers = employerSeries[employerSeries.length - 1] ?? 0;
  const bucketWord = range === '90d' ? 'week' : 'day';
  // 'new' end labels are the partial bucket's delta, never a total -- spec:
  // the end-dot label must never be misread as a running total (audit finding 1).
  const newEndSuffix = bucketWord === 'week' ? 'this week' : 'today';
  const workerEndLabel = cumulative ? `${formatCount(lastWorkers)} workers` : `+${formatCount(lastWorkers)} ${newEndSuffix}`;
  const employerEndLabel = cumulative ? `${formatCount(lastEmployers)} employers` : `+${formatCount(lastEmployers)} ${newEndSuffix}`;

  const signupsToggle = (
    <nav className="range-picker" aria-label="Signups view">
      {SIGNUP_VIEWS.map(({ value, label }) => (
        <Link
          key={value}
          className="button"
          href={analyticsHref(range, value)}
          aria-current={value === signupsView ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );

  return (
    <main className="stack-gap">
      <section className="hero analytics-hero">
        <div>
          <h1>Analytics</h1>
          <p className="muted">Growth over {period} · computed live</p>
        </div>
        <nav className="range-picker" aria-label="Time range">
          {RANGES.map(({ value, label }) => (
            <Link
              key={value}
              className="button"
              href={analyticsHref(value, signupsView)}
              aria-current={value === range ? 'page' : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
      </section>

      <section className="kpi-strip" aria-label="Key figures">
        <KpiTile label="Workers" value={totals.totalWorkers} note={`${signedDelta(newWorkers)} this period`} tone={newWorkers > 0 ? 'positive' : 'muted'} />
        <KpiTile label="Employers" value={totals.totalEmployers} note={`${signedDelta(newEmployers)} this period`} tone={newEmployers > 0 ? 'positive' : 'muted'} />
        <KpiTile label="Paying employers" value={totals.payingEmployers} note={payingShare ? `${payingShare} of employers` : 'Active, trialing, or past due'} />
        <KpiTile label="Active jobs" value={totals.jobsActive} note={`${formatCount(totals.jobsPaused)} paused · ${formatCount(totals.jobsClosed)} closed`} />
        <KpiTile label="Hires" value={totals.hiresTotal} note="All time" />
        <KpiTile label="Jobs with ≥1 hire" value={totals.jobsWithHire} note={hireShare ? `${hireShare} of all jobs` : 'All time'} />
      </section>

      <TrendChart
        title="Signups"
        subtitle={cumulative ? `Total accounts at the end of each ${bucketWord}` : `New accounts per ${bucketWord}`}
        labels={labels}
        tableCaption={cumulative ? 'Total accounts by period' : 'New accounts by period'}
        partialLast
        right={130}
        tools={signupsToggle}
        series={[
          { key: 'workers', label: 'Workers', color: WORKERS_BLUE, values: workerSeries, area: true, endLabel: workerEndLabel },
          { key: 'employers', label: 'Employers', color: EMPLOYERS_ORANGE, values: employerSeries, endLabel: employerEndLabel },
        ]}
      />

      <section className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <ColumnChart
          title="Jobs posted"
          subtitle={`${formatCount(jobsPostedTotal)} this period`}
          labels={labels}
          values={jobsPosted}
          tableCaption="Jobs posted by period"
          valueHeader="Jobs posted"
        />
        <TrendChart
          title="Applications"
          subtitle={appsPerJob ? `${formatCount(applicationsTotal)} this period · ${appsPerJob} per job` : `${formatCount(applicationsTotal)} this period`}
          labels={labels}
          width={570}
          height={200}
          tableCaption="Applications by period"
          partialLast
          series={[{ key: 'applications', label: 'Applications', color: WORKERS_BLUE, values: applications, area: true }]}
        />
      </section>

      <section className="grid analytics-bottom">
        <DeliveryHealth
          channels={[
            {
              name: 'In-app',
              out: sum(messageTraffic.map((row) => row.jobMessagesOut)),
              in: sum(messageTraffic.map((row) => row.jobMessagesIn)),
              failed: sum(messageTraffic.map((row) => row.jobMessagesFailed)),
            },
            {
              name: 'WhatsApp',
              out: sum(messageTraffic.map((row) => row.waOutbound)),
              in: sum(messageTraffic.map((row) => row.waInbound)),
              failed: sum(messageTraffic.map((row) => row.waFailed)),
            },
          ]}
        />
        <PayingEmployersList rows={payingEmployers} />
      </section>
    </main>
  );
}
