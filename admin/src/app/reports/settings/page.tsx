import Link from 'next/link';
import { ReportActionsPanel, ReportSettingsForm } from '@/components/ReportActionsPanel';
import { getAdminAuthConfig } from '@/lib/auth';
import { canReport } from '@/lib/report-policy';
import {
  formatRelativeTime,
  formatUtcTime,
  getProblemReportSettings,
  recordReportSettingsDenied,
} from '@/lib/server/admin-reports';
import { requireAdminSession } from '@/lib/server/session';

export default async function ReportSettingsPage() {
  const session = await requireAdminSession();

  if (!canReport(session.role, 'view_settings')) {
    await recordReportSettingsDenied(session);
    return (
      <main className="stack-gap">
        <section className="hero">
          <h1>Report settings</h1>
          <p className="muted">Only superadmins can see and change the report settings.</p>
        </section>
        <Link className="button secondary" href="/reports" prefetch={false}>Back to reports</Link>
      </main>
    );
  }

  const settings = await getProblemReportSettings(session);
  // The address in report emails defaults to this dashboard's own origin.
  const defaultBaseUrl = `https://${getAdminAuthConfig().hostedDomain}`;

  return (
    <main className="stack-gap">
      <section className="hero">
        <div className="meta">
          <span className="badge verification">Reports</span>
        </div>
        <h1>Report settings</h1>
        <p className="muted">
          Pause reporting, signed-out reports, screenshots or the team email, and set the daily cap. Changes apply
          within a minute and are recorded. Last changed{' '}
          <time dateTime={settings.updatedAt} title={formatUtcTime(settings.updatedAt)}>
            {formatRelativeTime(settings.updatedAt)}
          </time>
          .
        </p>
      </section>

      <section className="card settings-card">
        <ReportActionsPanel>
          <ReportSettingsForm defaultBaseUrl={defaultBaseUrl} settings={settings} />
        </ReportActionsPanel>
      </section>

      <Link className="button secondary" href="/reports" prefetch={false}>Back to reports</Link>
    </main>
  );
}
