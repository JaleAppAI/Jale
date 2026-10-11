import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getAdminAuthConfig } from '@/lib/auth';
import { getProblemReportCounts } from '@/lib/server/admin-reports';
import { getCurrentAdminSession } from '@/lib/server/session';
import { AdminNav } from '@/components/AdminNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jale Admin',
  description: 'Jale admin console',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getCurrentAdminSession();
  const config = getAdminAuthConfig();
  // The Reports badge has its own count query, for signed-in admins only. It
  // returns null when the count is unavailable, and the badge stays hidden.
  const reportCounts = session ? await getProblemReportCounts() : null;

  return (
    <html lang="en">
      <body>
        <div className="admin-shell">
          <header className="admin-header">
            <Link className="brand" href="/" aria-label="Jale admin dashboard" prefetch={false}>
              <strong>Jale</strong>
              <span>Admin</span>
            </Link>
            <AdminNav
              isLoggedIn={Boolean(session)}
              config={config}
              reportsNewCount={reportCounts?.newCount}
              role={session?.role}
            />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
