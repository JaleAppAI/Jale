import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';

export default function ReportNotFound() {
  return (
    <DashboardPanel as="div" className="mx-auto w-full max-w-[40rem]">
      <EmptyState action={{ label: 'Back to the Inbox', href: '/inbox' }} body="The link may be wrong, or the item no longer exists." title="Report not found" />
    </DashboardPanel>
  );
}
