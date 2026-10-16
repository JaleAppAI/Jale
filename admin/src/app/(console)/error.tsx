'use client';

import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';

/**
 * A console page failed. Logs nothing: an error can carry query text or
 * record values, and the server already logged it under its digest. The
 * message is never shown.
 */
export default function ConsoleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DashboardPanel className="w-full max-w-[1180px]">
      <ErrorState kind="server" onRetry={reset} />
    </DashboardPanel>
  );
}
