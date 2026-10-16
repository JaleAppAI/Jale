'use client';

import { Sheet, SheetBody } from '@/components/ui/sheet';
import type { AdminShellProps } from './AdminSidebar';
import { AdminNavList } from './AdminNavList';
import { SidebarThemeToggle } from './SidebarThemeToggle';
import { SignOutButton } from './SignOutButton';
import { UserChip } from './UserChip';

/** Below 1024px: the same nav in a sheet, and the same navy footer at its foot. */
export function AdminMobileNav({
  open,
  onClose,
  pathname,
  role,
  email,
  counts,
  authConfig,
}: AdminShellProps & { open: boolean; onClose: () => void; pathname: string }) {
  return (
    <Sheet open={open} onClose={onClose} title="Menu" closeLabel="Close menu">
      <SheetBody className="px-3 py-4">
        <AdminNavList role={role} pathname={pathname} waitingOnUs={counts?.waitingOnUs ?? null} tone="surface" onNavigate={onClose} />
      </SheetBody>
      <div className="flex shrink-0 flex-col gap-3 bg-[var(--jale-sidebar)] px-5 py-[18px] text-white">
        <UserChip email={email} role={role} />
        <div className="flex flex-wrap gap-2">
          <SidebarThemeToggle />
          <SignOutButton authConfig={authConfig} />
        </div>
      </div>
    </Sheet>
  );
}
