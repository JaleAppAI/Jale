'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { CognitoUserPool } from 'amazon-cognito-identity-js';
import type { AdminAuthConfig } from '@/lib/auth';
import type { AdminRole } from '@/lib/types';

type AdminNavProps = {
  isLoggedIn: boolean;
  config: AdminAuthConfig;
  /** New problem reports, from their own count query; hidden when unknown or zero. */
  reportsNewCount?: number;
  role?: AdminRole;
};

type NavLink = {
  href: string;
  label: string;
  exact: boolean;
  /** Shown to admin_superadmin only. The page checks the role again. */
  superadminOnly?: boolean;
};

// Admin links never prefetch: a page may record a read when it renders, and a
// prefetch must never record a read the admin did not make.
const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Dashboard', exact: true },
  { href: '/cases', label: 'Cases', exact: false },
  { href: '/reports', label: 'Reports', exact: false },
  { href: '/verifications', label: 'Lockouts', exact: false },
  { href: '/analytics', label: 'Analytics', exact: false },
  { href: '/access-history', label: 'Access history', exact: false, superadminOnly: true },
];

function NewReportsCount({ count }: { count: number }) {
  return (
    <>
      <span aria-hidden="true" className="nav-count">{count > 99 ? '99+' : count}</span>
      <span className="visually-hidden">, {count} new</span>
    </>
  );
}

function isActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

export function AdminNav({ isLoggedIn, config, reportsNewCount, role }: AdminNavProps) {
  const pathname = usePathname();
  const [isPending, setIsPending] = useState(false);

  async function handleSignOut() {
    setIsPending(true);
    try {
      if (config.userPoolId && config.clientId) {
        new CognitoUserPool({
          UserPoolId: config.userPoolId,
          ClientId: config.clientId,
        }).getCurrentUser()?.signOut();
      }

      await fetch('/api/session', { method: 'DELETE' }).catch(() => undefined);
    } finally {
      window.location.assign('/login');
    }
  }

  return (
    <nav className="nav" aria-label="Primary navigation">
      {isLoggedIn ? (
        <>
          {NAV_LINKS.map(({ href, label, exact, superadminOnly }) => (
            superadminOnly && role !== 'admin_superadmin' ? null : (
              <Link
                key={href}
                href={href}
                prefetch={false}
                aria-current={isActive(pathname, href, exact) ? 'page' : undefined}
              >
                {label}
                {href === '/reports' && reportsNewCount ? <NewReportsCount count={reportsNewCount} /> : null}
              </Link>
            )
          ))}
          <button
            className="nav-signout"
            disabled={isPending}
            onClick={() => { void handleSignOut(); }}
            type="button"
          >
            {isPending ? 'Signing out...' : 'Sign out'}
          </button>
        </>
      ) : (
        <Link aria-current={pathname === '/login' ? 'page' : undefined} href="/login" prefetch={false}>
          Login
        </Link>
      )}
    </nav>
  );
}
