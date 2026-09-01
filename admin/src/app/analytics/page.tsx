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

export const dynamic = 'force-dynamic';

const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

function bucketLabel(iso: string, range: AnalyticsRange): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return range === '90d' ? `Week of ${day}` : day;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams?: { range?: string | string[] };
}) {
  await requireAdminSession();
  const range = parseAnalyticsRange(searchParams?.range ?? DEFAULT_ANALYTICS_RANGE);

  const [totals, signups, jobsActivity, messageTraffic, payingEmployers] = await Promise.all([
    getAnalyticsTotals(),
    getSignups(range),
    getJobsActivity(range),
    getMessageTraffic(range),
    getPayingEmployers(),
  ]);

  // Newest first: most recent numbers visible without scrolling.
  const signupRows = [...signups].reverse();
  const jobsRows = [...jobsActivity].reverse();
  const trafficRows = [...messageTraffic].reverse();

  return (
    <main className="stack-gap">
      <section className="hero">
        <h1>Analytics</h1>
        <p className="muted" style={{ marginTop: 6 }}>Platform health, computed live</p>
      </section>

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

      <section className="grid three">
        <article className="card kpi">
          <span className="muted">Workers</span>
          <strong>{totals.totalWorkers}</strong>
          <span>Total signed up</span>
        </article>
        <article className="card kpi">
          <span className="muted">Employers</span>
          <strong>{totals.totalEmployers}</strong>
          <span>Total signed up</span>
        </article>
        <article className="card kpi">
          <span className="muted">Paying employers</span>
          <strong>{totals.payingEmployers}</strong>
          <span>Active, trialing, or past due</span>
        </article>
      </section>

      <section className="grid three">
        <article className="card kpi">
          <span className="muted">Active jobs</span>
          <strong>{totals.jobsActive}</strong>
          <span>{totals.jobsPaused} paused</span>
        </article>
        <article className="card kpi">
          <span className="muted">Filled jobs</span>
          <strong>{totals.jobsFilled}</strong>
          <span>All time</span>
        </article>
        <article className="card kpi">
          <span className="muted">Closed jobs</span>
          <strong>{totals.jobsClosed}</strong>
          <span>All time</span>
        </article>
      </section>

      <section className="grid two">
        <article className="card">
          <div className="section-title"><h2>Signups</h2></div>
          <table className="data-table">
            <thead>
              <tr><th>Period</th><th>Workers</th><th>Employers</th></tr>
            </thead>
            <tbody>
              {signupRows.map((row) => (
                <tr key={row.bucketStart}>
                  <td>{bucketLabel(row.bucketStart, range)}</td>
                  <td>{row.workerSignups}</td>
                  <td>{row.employerSignups}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="card">
          <div className="section-title"><h2>Jobs activity</h2></div>
          <table className="data-table">
            <thead>
              <tr><th>Period</th><th>Jobs posted</th><th>Applications</th></tr>
            </thead>
            <tbody>
              {jobsRows.map((row) => (
                <tr key={row.bucketStart}>
                  <td>{bucketLabel(row.bucketStart, range)}</td>
                  <td>{row.jobsPosted}</td>
                  <td>{row.applicationsSubmitted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>

      <section className="card">
        <div className="section-title"><h2>Message traffic</h2></div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>In-app out</th>
              <th>In-app in</th>
              <th>In-app failed</th>
              <th>WhatsApp in</th>
              <th>WhatsApp out</th>
              <th>WhatsApp failed</th>
            </tr>
          </thead>
          <tbody>
            {trafficRows.map((row) => (
              <tr key={row.bucketStart}>
                <td>{bucketLabel(row.bucketStart, range)}</td>
                <td>{row.jobMessagesOut}</td>
                <td>{row.jobMessagesIn}</td>
                <td>{row.jobMessagesFailed}</td>
                <td>{row.waInbound}</td>
                <td>{row.waOutbound}</td>
                <td>{row.waFailed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="section-title"><h2>Paying employers</h2></div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Employer</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Period ends</th>
              <th>Cancels?</th>
            </tr>
          </thead>
          <tbody>
            {payingEmployers.map((row) => (
              <tr key={`${row.employerId}-${row.planCode}`}>
                <td>{row.displayName}</td>
                <td>{row.planCode}</td>
                <td><span className={`badge ${row.status}`}>{row.status}</span></td>
                <td>{row.currentPeriodEnd ? bucketLabel(row.currentPeriodEnd, '7d') : '—'}</td>
                <td>{row.cancelAtPeriodEnd ? 'At period end' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {payingEmployers.length === 0 ? <p className="muted">No paying employers yet.</p> : null}
      </section>
    </main>
  );
}
