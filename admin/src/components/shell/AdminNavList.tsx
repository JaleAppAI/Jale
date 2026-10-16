import Link from 'next/link';
import type { AdminRole } from '@/lib/types';
import { InboxBadge } from './InboxBadge';
import { isNavActive, visibleNavItems } from './nav-items';

const LINK_BASE = 'flex min-h-11 items-center gap-3 rounded-xl px-3.5 text-sm transition-colors focus-visible:outline-none';

// Rail: the frontend sidebar's white focus ring (the token ring vanishes on
// navy). Surface: the token focus ring, as every light surface uses.
const TONES = {
  rail: {
    focus: 'focus-visible:ring-2 focus-visible:ring-white/60',
    active: 'bg-white/12 font-semibold text-white',
    idle: 'font-medium text-white/78 hover:bg-white/10 hover:text-white',
  },
  surface: {
    focus: 'focus-visible:shadow-[var(--shadow-focus)]',
    active: 'bg-[var(--jale-blue-50)] font-semibold text-[var(--jale-blue-700)]',
    idle: 'font-medium text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
  },
} as const;

/** The console nav (sidebar and mobile sheet). The current entry is marked by prefix. */
export function AdminNavList({
  role,
  pathname,
  waitingOnUs,
  tone,
  onNavigate,
}: {
  role: AdminRole;
  pathname: string;
  waitingOnUs: number | null;
  tone: 'rail' | 'surface';
  onNavigate?: () => void;
}) {
  const styles = TONES[tone];
  return (
    <nav aria-label="Admin">
      <ul className="flex flex-col gap-1">
        {visibleNavItems(role).map((item) => {
          const active = isNavActive(pathname, item);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={false}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={[LINK_BASE, styles.focus, active ? styles.active : styles.idle].join(' ')}
              >
                <Icon aria-hidden size={18} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.inboxBadge ? <InboxBadge count={waitingOnUs} /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
