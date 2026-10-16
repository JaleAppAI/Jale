import type { AdminRole } from '@/lib/types';
import { emailInitials } from './initials';
import { roleLabel } from './role-label';

/** Who is signed in: initials, the email (the identity, K1.5) and the role label (K1.4). */
export function UserChip({ email, role }: { email: string; role: AdminRole }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--jale-teal-500)] text-[13px] font-extrabold text-[var(--jale-sidebar)]"
      >
        {emailInitials(email)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-semibold text-white" title={email || undefined}>
          {email || 'Signed in'}
        </span>
        <span className="text-[11px] text-white/60">{roleLabel(role)}</span>
      </span>
    </div>
  );
}
