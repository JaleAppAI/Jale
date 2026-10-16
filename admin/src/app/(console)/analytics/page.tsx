import { requireAdminSession } from '@/lib/server/session';
import {
  getAcquisition,
  getAnalyticsTotals,
  getDigestAdoption,
  getDigestSends,
  getJobsActivity,
  getMessageTraffic,
  getPayingWeekly,
  getSignups,
  loadPayingEmployers,
  parseFunnelWeeks,
  parseSignupsView,
} from '@/lib/server/admin-analytics';
import { formatCount, growthHref, percentOf, signedDelta, sum } from '@/lib/analytics-format';
import { splitDigestSends } from '@/lib/digest';
import { StatTile } from '@/components/ui/stat-tile';
import { AnalyticsHeader } from '@/components/analytics/AnalyticsHeader';
import { DeliveryHealth } from '@/components/analytics/DeliveryHealth';
import { PayingEmployersList } from '@/components/analytics/PayingEmployersList';
import {
  AcquisitionPanel,
  ApplicationsPanel,
  DigestAdoptionPanel,
  JobsPostedPanel,
  PayingPanel,
  SignupsPanel,
} from '@/components/analytics/panels/growth';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string | string[]; signups?: string | string[] }>;
}) {
  const session = await requireAdminSession();
  const { weeks: weeksParam, signups: signupsParam } = await searchParams;
  const weeks = parseFunnelWeeks(weeksParam);
  const signupsView = parseSignupsView(signupsParam);
  const now = new Date();

  // db.ts caps the shared pool at max: 5, so the page loads in waves of at
  // most three queries, each wave after the one before. The paying-employers
  // list names employers, so it loads in its own recorded transaction.
  const [signups, jobsActivity, messageTraffic] = await Promise.all([
    getSignups(weeks),
    getJobsActivity(weeks),
    getMessageTraffic(weeks),
  ]);
  const [totals, payingEmployers, paying] = await Promise.all([
    getAnalyticsTotals(),
    loadPayingEmployers(session),
    getPayingWeekly(weeks),
  ]);
  const [adoption, digestRows, acquisition] = await Promise.all([
    getDigestAdoption(),
    getDigestSends(weeks),
    getAcquisition(weeks),
  ]);

  const newWorkers = sum(signups.map((row) => row.workerSignups));
  const newEmployers = sum(signups.map((row) => row.employerSignups));
  const newVerified = sum(signups.map((row) => row.workerSignupsVerified));
  const payingShare = percentOf(totals.payingEmployers, totals.totalEmployers);
  const totalJobs = totals.jobsActive + totals.jobsPaused + totals.jobsFilled + totals.jobsClosed;
  const hireShare = percentOf(totals.jobsWithHire, totalJobs);
  const wide = weeks > 13 ? 'min-w-0 lg:col-span-2' : 'min-w-0';

  return (
    <div className="flex flex-col gap-6">
      <AnalyticsHeader active="growth" weeks={weeks} rangeHref={(value) => growthHref(value, signupsView)} />

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Workers" value={formatCount(totals.totalWorkers)} hint={`${signedDelta(newWorkers)} this period · ${formatCount(newVerified)} verified`} />
        <StatTile label="Employers" value={formatCount(totals.totalEmployers)} hint={`${signedDelta(newEmployers)} this period`} />
        <StatTile label="Paying employers" value={formatCount(totals.payingEmployers)} hint={payingShare ? `${payingShare} of employers` : 'Active, trialing, or past due'} />
        <StatTile label="Active jobs" value={formatCount(totals.jobsActive)} hint={`${formatCount(totals.jobsPaused)} paused · ${formatCount(totals.jobsClosed)} closed`} />
        <StatTile label="Hires" value={formatCount(totals.hiresTotal)} hint="All time" />
        <StatTile label="Jobs with ≥1 hire" value={formatCount(totals.jobsWithHire)} hint={hireShare ? `${hireShare} of all jobs` : 'All time'} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 lg:col-span-2">
          <SignupsPanel tag="#1" rows={signups} totals={totals} view={signupsView} weeks={weeks} />
        </div>
        <div className={wide}>
          <PayingPanel tag="#2" result={paying} />
        </div>
        <div className={wide}>
          <DigestAdoptionPanel tag="#13" adoption={adoption} sends={splitDigestSends(digestRows)} now={now} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <AcquisitionPanel tag="#16" result={acquisition} weeks={weeks} />
        </div>
        <div className={wide}>
          <JobsPostedPanel rows={jobsActivity} />
        </div>
        <div className={wide}>
          <ApplicationsPanel rows={jobsActivity} />
        </div>
        <div className="min-w-0">
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
        </div>
        <div className="min-w-0">
          <PayingEmployersList rows={payingEmployers} />
        </div>
      </div>
    </div>
  );
}
