import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReportDetail } from '@/components/inbox/ReportDetail';
import { buildReportSummary, getProblemReport, reportSummaryInput } from '@/lib/server/admin-reports';
import { requireAdminSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Problem report' };

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  const { id } = await params;
  // Records the report's content under admin.report_detail before rendering.
  const report = await getProblemReport(session, id);

  if (!report) {
    notFound();
  }

  return (
    <ReportDetail
      nowIso={new Date().toISOString()}
      report={report}
      role={session.role}
      summary={buildReportSummary(reportSummaryInput(report))}
    />
  );
}
