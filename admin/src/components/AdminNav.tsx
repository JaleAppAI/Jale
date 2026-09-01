'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { CognitoUserPool } from 'amazon-cognito-identity-js';
import type { AdminAuthConfig } from '@/lib/auth';

type AdminNavProps = {
  isLoggedIn: boolean;
  config: AdminAuthConfig;
};

const NAV_LINKS = [
  { href: '/', label: 'Dashboard', exact: true },
  { href: '/cases', label: 'Cases', exact: false },
  { href: '/verifications', label: 'Verifications', exact: false },
  { href: '/analytics', label: 'Analytics', exact: false },
  { href: '/audit', label: 'Audit', exact: false },
];

function isActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

export function AdminNav({ isLoggedIn, config }: AdminNavProps) {
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
          {NAV_LINKS.map(({ href, label, exact }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(pathname, href, exact) ? 'page' : undefined}
            >
              {label}
            </Link>
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
        <Link aria-current={pathname === '/login' ? 'page' : undefined} href="/login">
          Login
        </Link>
      )}
    </nav>
  );
}
