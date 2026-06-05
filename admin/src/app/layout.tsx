import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jale Admin',
  description: 'Jale admin console',
};

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/cases', label: 'Cases' },
  { href: '/verifications', label: 'Verifications' },
  { href: '/audit', label: 'Audit' },
  { href: '/login', label: 'Login' },
];

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="admin-shell">
          <header className="admin-header">
            <Link className="brand" href="/" aria-label="Jale admin dashboard">
              <strong>Jale</strong>
              <span>Admin</span>
            </Link>
            <nav className="nav" aria-label="Primary navigation">
              {links.map((link) => (
                <Link key={link.href} href={link.href}>
                  {link.label}
                </Link>
              ))}
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
