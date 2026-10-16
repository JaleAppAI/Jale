import type { ReactNode } from 'react';
import { AdminSidebar } from '@/components/shell/AdminSidebar';
import { AdminTopBar } from '@/components/shell/AdminTopBar';
import { ToastProvider } from '@/components/ui/toast';
import { getAdminClientAuthConfig } from '@/lib/auth';
import { getInboxCounts } from '@/lib/server/admin-inbox';
import { requireAdminSession } from '@/lib/server/session';

/**
 * The console shell around every signed-in page: the navy sidebar from
 * 1024px, a sticky top bar with a menu sheet below it. Pages render inside
 * the one <main id="main"> and never render their own <main>.
 */
export default async function ConsoleLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await requireAdminSession();
  // One count query per request (K2.1); null hides the badge. A failure must
  // not take every console page down: no error boundary sits beside a layout.
  const counts = await getInboxCounts(session).catch(() => null);
  // The pool id and client id only; the hosted domain and region stay here (K1.1).
  const authConfig = getAdminClientAuthConfig();
  const email = session.email ?? '';

  return (
    <ToastProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-[var(--jale-card)] focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--jale-ink)] focus:shadow-[var(--shadow-card)]"
      >
        Skip to content
      </a>
      <div className="grid min-h-screen bg-[var(--jale-shell)] text-[var(--jale-ink)] lg:grid-cols-[280px_minmax(0,1fr)]">
        <AdminSidebar role={session.role} email={email} counts={counts} authConfig={authConfig} />
        <div className="min-w-0">
          <AdminTopBar role={session.role} email={email} counts={counts} authConfig={authConfig} />
          <main id="main" tabIndex={-1} className="min-w-0 px-4 pb-14 pt-6 focus:outline-none md:px-6 lg:px-10 lg:pt-7">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
