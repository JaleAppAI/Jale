import { requireAdminSession } from '@/lib/server/session';
import {
  getAnalyticsTotals,
  getDigestAdoption,
  getDigestSends,
  getEmployerWeekly,
  getTemplateReuse,
  loadSlowestEmployers,
  loadStaleJobs,
  parseFunnelWeeks,
  parseStaleDays,
} from '@/lib/server/admin-analytics';
import { splitDigestSends } from '@/lib/digest';
import {
  employersHref,
  firstResponseNote,
  formatDays,
  formatDuration,
  hiresNote,
  replyNote,
  splitEmployerWeekly,
  staleJobsNote,
  weeklyTableRows,
} from '@/lib/employer-health';
import { formatCount } from '@/lib/analytics-format';
import { StatTile } from '@/components/ui/stat-tile';
import { AnalyticsHeader } from '@/components/analytics/AnalyticsHeader';
import { DigestEmails } from '@/components/analytics/DigestEmails';
import { EmployerWeeklyTable } from '@/components/analytics/EmployerWeeklyTable';
import { SlowestEmployers } from '@/components/analytics/SlowestEmployers';
import { HiresPanel, ResponseTimePanel, StaleJobsPanel, TemplateReusePanel } from '@/components/analytics/panels/employers';

export const dynamic = 'force-dynamic';

export default async function EmployersPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string | string[]; stale?: string | string[] }>;
}) {
  const session = await requireAdminSession();
  const { weeks: weeksParam, stale: staleParam } = await searchParams;
  const weeks = parseFunnelWeeks(weeksParam);
  const staleDays = parseStaleDays(staleParam);
  const now = new Date();

  // Three waves of at most three, each after the one before: db.ts caps the
  // shared pool at max: 5. The two lists name employers, so each loads in its
  // own recorded transaction (one connection) and is recorded before render.
  const [weeklyRows, slowest, staleJobs] = await Promise.all([
    getEmployerWeekly(weeks),
    loadSlowestEmployers(session, weeks),
    loadStaleJobs(session, staleDays),
  ]);
  const [adoption, digestRows, templates] = await Promise.all([
    getDigestAdoption(),
    getDigestSends(weeks),
    getTemplateReuse(weeks),
  ]);
  const [totals] = await Promise.all([getAnalyticsTotals()]);

  const { weekly, summary } = splitEmployerWeekly(weeklyRows);
  const digest = splitDigestSends(digestRows);
  const wide = weeks > 13 ? 'min-w-0 lg:col-span-2' : 'min-w-0';

  return (
    <div className="flex flex-col gap-6">
      <AnalyticsHeader active="employers" weeks={weeks} rangeHref={(value) => employersHref(value, staleDays)} />

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="First response" value={formatDuration(summary.firstResponseP50Hours)} hint={firstResponseNote(summary)} />
        <StatTile label="Reply time" value={formatDuration(summary.replyP50Hours)} hint={replyNote(summary)} />
        <StatTile label="Time to hire" value={formatDays(summary.timeToHireP50Days)} hint={hiresNote(summary)} />
        <StatTile label="Stale jobs" value={formatCount(staleJobs.length)} hint={staleJobsNote(summary.activeJobs)} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={wide}>
          <HiresPanel tag="#3" totals={totals} weekly={weekly} now={now} />
        </div>
        <div className={wide}>
          <ResponseTimePanel tag="#8" weekly={weekly} summary={summary} now={now} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <StaleJobsPanel tag="#4" jobs={staleJobs} days={staleDays} weeks={weeks} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <TemplateReusePanel tag="#18" result={templates} weeks={weeks} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <EmployerWeeklyTable rows={weeklyTableRows(weekly, now)} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <SlowestEmployers rows={slowest} />
        </div>
        <div className="min-w-0 lg:col-span-2">
          <DigestEmails adoption={adoption} sends={digest} now={now} />
        </div>
      </div>
    </div>
  );
}
