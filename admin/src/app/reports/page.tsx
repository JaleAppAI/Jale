import Link from 'next/link';
import { ReportFilters } from '@/components/ReportFilters';
import { canReport, type ReportStatus } from '@/lib/report-policy';
import {
  formatRelativeTime,
  formatUtcTime,
  inboxHref,
  listProblemReports,
  parseInboxFilters,
  type ReportInboxRow,
} from '@/lib/server/admin-reports';
import { requireAdminSession } from '@/lib/server/session';

// Existing badge colours from globals.css.
const STATUS_BADGES: Record<ReportStatus, string> = {
  new: 'open',
  looking: 'verification',
  fixed: 'resolved',
  wont_fix: 'dismissed',
};

// Every report page records a read when it renders, so no link to one is
// prefetched: a prefetch must not record a read the admin did not make.
function ReportRow({ row, now }: { row: ReportInboxRow; now: number }) {
  return (
    <li>
      <Link className="report-row" href={`/reports/${row.id}`} prefetch={false}>
        <span className="stack report-row-main">
          <strong className="report-number">{row.numberLabel}</strong>
          <span className="muted">{row.roleLabel} · {row.categoryLabel}</span>
        </span>
        <span className="meta report-row-tags">
          <span className={row.verified ? 'pill success' : 'pill warning'}>{row.verified ? 'Verified' : 'Unverified'}</span>
          {row.stopsWork ? <span className="pill danger">Stops work</span> : null}
          {row.hasImage ? <span className="pill">Screenshot</span> : null}
          {row.contentErased ? <span className="pill">Erased</span> : null}
        </span>
        <span className={`badge report-row-status ${STATUS_BADGES[row.status]}`}>{row.statusLabel}</span>
        <time className="muted report-row-time" dateTime={row.createdAt} title={formatUtcTime(row.createdAt)}>
          {formatRelativeTime(row.createdAt, now)}
        </time>
      </Link>
    </li>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminSession();
  const filters = parseInboxFilters(await searchParams);
  const { rows, nextBefore } = await listProblemReports(session, filters);
  const now = Date.now();

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="section-title">
          <div className="stack">
            <div className="meta">
              <span className="badge verification">Reports</span>
            </div>
            <h1>Problem reports</h1>
            <p className="muted">From workers and employers, newest first. Every view is recorded.</p>
          </div>
          {canReport(session.role, 'view_settings') ? (
            <Link className="button secondary" href="/reports/settings" prefetch={false}>Settings</Link>
          ) : null}
        </div>
      </section>

      <ReportFilters filters={filters} />

      <section aria-label="Reports" className="card stack-gap">
        {rows.length === 0 ? (
          <p className="muted">No reports match these filters.</p>
        ) : (
          <ul className="report-list" role="list">
            {rows.map((row) => (
              <ReportRow key={row.id} now={now} row={row} />
            ))}
          </ul>
        )}
        <div className="report-paging">
          <p className="muted">
            Showing {rows.length} {rows.length === 1 ? 'report' : 'reports'}
            {filters.before ? ', older than the first page' : ''}
          </p>
          <div className="meta">
            {filters.before ? (
              <Link className="button secondary" href={inboxHref(filters, { before: null })} prefetch={false}>Newest</Link>
            ) : null}
            {nextBefore ? (
              <Link className="button secondary" href={inboxHref(filters, { before: nextBefore })} prefetch={false}>Next page</Link>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
