'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { AdminClientAuthConfig } from '@/lib/auth';
import type { InboxCounts } from '@/lib/server/admin-inbox';
import type { AdminRole } from '@/lib/types';
import { AdminNavList } from './AdminNavList';
import { SidebarThemeToggle } from './SidebarThemeToggle';
import { SignOutButton } from './SignOutButton';
import { UserChip } from './UserChip';

export type AdminShellProps = {
  role: AdminRole;
  email: string;
  counts: InboxCounts | null;
  authConfig: AdminClientAuthConfig;
};

/** The navy sidebar, from 1024px: wordmark, nav, then who is signed in. */
export function AdminSidebar({ role, email, counts, authConfig }: AdminShellProps) {
  const pathname = usePathname();
  return (
    <div className="hidden bg-[var(--jale-sidebar)] text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:self-start">
      <div className="border-b border-white/10 px-6 pb-[22px] pt-7">
        <Link
          href="/"
          prefetch={false}
          className="rounded text-[30px] font-extrabold leading-none tracking-[-0.02em] text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          Jale
        </Link>
        <p className="mt-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-white/60">Admin console</p>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <AdminNavList role={role} pathname={pathname} waitingOnUs={counts?.waitingOnUs ?? null} tone="rail" />
      </div>
      <div className="flex flex-col gap-3 border-t border-white/10 px-5 py-[18px]">
        <UserChip email={email} role={role} />
        <div className="flex flex-wrap gap-2">
          <SidebarThemeToggle />
          <SignOutButton authConfig={authConfig} />
        </div>
      </div>
    </div>
  );
}
