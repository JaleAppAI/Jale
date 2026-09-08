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
} from '@/lib/server/admin-analytics';
import type { AnalyticsRange } from '@/lib/types';
import { bucketLabel, formatCount, percentOf, perUnit, signedDelta, sum } from '@/lib/analytics-format';
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

const WORKERS_BLUE = '#0179ff';
const EMPLOYERS_ORANGE = '#eb6834';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams?: { range?: string | string[] };
}) {
  await requireAdminSession();
  const range = parseAnalyticsRange(searchParams?.range ?? DEFAULT_ANALYTICS_RANGE);
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

  const lastWorkers = workerSignups[workerSignups.length - 1] ?? 0;
  const lastEmployers = employerSignups[employerSignups.length - 1] ?? 0;

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
              href={`/analytics?range=${value}`}
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
        <KpiTile label="Active jobs" value={totals.jobsActive} note={`${formatCount(totals.jobsPaused)} paused`} />
        <KpiTile label="Filled jobs" value={totals.jobsFilled} note="All time" />
        <KpiTile label="Closed jobs" value={totals.jobsClosed} note="All time" />
      </section>

      <TrendChart
        title="Signups"
        subtitle={range === '90d' ? 'New accounts per week' : 'New accounts per day'}
        labels={labels}
        tableCaption="Signups by period"
        series={[
          { key: 'workers', label: 'Workers', color: WORKERS_BLUE, values: workerSignups, area: true, endLabel: `${formatCount(lastWorkers)} workers` },
          { key: 'employers', label: 'Employers', color: EMPLOYERS_ORANGE, values: employerSignups, endLabel: `${formatCount(lastEmployers)} employers` },
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
