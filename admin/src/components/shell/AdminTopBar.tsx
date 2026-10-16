'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { AdminMobileNav } from './AdminMobileNav';
import type { AdminShellProps } from './AdminSidebar';
import { InboxBadge } from './InboxBadge';

/** Below 1024px: a sticky top bar whose menu button (with the Inbox badge) opens the nav. */
export function AdminTopBar(props: AdminShellProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = () => setOpen(false);
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] bg-[color-mix(in_srgb,var(--jale-card)_92%,transparent)] px-4 py-2.5 backdrop-blur lg:hidden">
      <Link
        href="/"
        prefetch={false}
        className="flex items-baseline gap-2 rounded text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <span className="text-2xl font-extrabold tracking-[-0.02em]">Jale</span>
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]">Admin</span>
      </Link>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-4 text-sm font-semibold text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <Menu aria-hidden size={18} />
        Menu
        <InboxBadge count={props.counts?.waitingOnUs ?? null} />
      </button>
      <AdminMobileNav {...props} open={open} onClose={close} pathname={pathname} />
    </header>
  );
}
