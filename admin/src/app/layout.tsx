import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getAdminAuthConfig } from '@/lib/auth';
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

  return (
    <html lang="en">
      <body>
        <div className="admin-shell">
          <header className="admin-header">
            <Link className="brand" href="/" aria-label="Jale admin dashboard">
              <strong>Jale</strong>
              <span>Admin</span>
            </Link>
            <AdminNav isLoggedIn={Boolean(session)} config={config} />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
