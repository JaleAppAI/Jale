import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@/components/LocalTime';
import { ReportActionsPanel, ReportSettingsForm } from '@/components/inbox/ReportActions';
import { BACK_LINK, MUTED, PAGE_TITLE } from '@/components/inbox/styles';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { getAdminAuthConfig } from '@/lib/auth';
import { canReport } from '@/lib/report-policy';
import { getProblemReportSettings, recordReportSettingsDenied } from '@/lib/server/admin-reports';
import { requireAdminSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Report settings' };

export default async function ReportSettingsPage() {
  const session = await requireAdminSession();

  if (!canReport(session.role, 'view_settings')) {
    await recordReportSettingsDenied(session);
    return (
      <div className="mx-auto flex w-full max-w-[48rem] flex-col gap-4">
        <Link className={BACK_LINK} href="/inbox?tab=reports" prefetch={false}><span aria-hidden="true">←</span> Inbox</Link>
        <h1 className={PAGE_TITLE}>Report settings</h1>
        <p className={MUTED}>Only superadmins can see and change the report settings.</p>
      </div>
    );
  }

  const settings = await getProblemReportSettings(session);
  // The address in report emails defaults to this dashboard's own origin.
  const defaultBaseUrl = `https://${getAdminAuthConfig().hostedDomain}`;

  return (
    <div className="mx-auto flex w-full max-w-[48rem] flex-col gap-4">
      <Link className={BACK_LINK} href="/inbox?tab=reports" prefetch={false}><span aria-hidden="true">←</span> Inbox</Link>
      <div><Badge tone="info">Reports</Badge></div>
      <h1 className={PAGE_TITLE}>Report settings</h1>
      <p className={MUTED}>
        Pause reporting, signed-out reports, screenshots or the team email, and set the daily cap. Changes apply
        within a minute and are recorded. Last changed <LocalTime format="relative" iso={settings.updatedAt} nowIso={new Date().toISOString()} />.
      </p>
      <DashboardPanel as="div" className="p-5">
        <ReportActionsPanel>
          <ReportSettingsForm defaultBaseUrl={defaultBaseUrl} settings={settings} />
        </ReportActionsPanel>
      </DashboardPanel>
    </div>
  );
}
