import { LocalTime } from '@/components/LocalTime';
import { roleLabel } from '@/components/shell/role-label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { TableScroll } from '@/components/ui/table-scroll';
import type { AdminListItem } from '@/lib/server/admin-users';
import {
  ADMIN_STATUS_LABELS,
  ADMIN_STATUS_TONES,
  ROW_ACTION_LABELS,
  rowActions,
  type AdminRowAction,
} from './admin-actions';
import { ResendInviteButton } from './ResendInviteButton';

const HEAD = 'px-5 py-3 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]';
const CELL = 'px-5 py-3.5 align-middle';

export type AdminsTableProps = {
  admins: readonly AdminListItem[];
  /** The server render's time, for "2h ago". */
  nowIso: string;
  busy: boolean;
  onAction: (action: AdminRowAction, admin: AdminListItem) => void;
};

function RowActions({ admin, busy, onAction }: {
  admin: AdminListItem;
  busy: boolean;
  onAction: AdminsTableProps['onAction'];
}) {
  if (admin.isSelf) {
    return <p className="text-right text-xs text-[var(--jale-ink-2)]">This is you</p>;
  }
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {rowActions(admin).map((action) => (action === 'resend_invite' ? (
        <ResendInviteButton admin={admin} busy={busy} key={action} onResend={() => onAction(action, admin)} />
      ) : (
        <Button
          disabled={busy}
          key={action}
          onClick={() => onAction(action, admin)}
          size="sm"
          type="button"
          variant={action === 'deactivate' ? 'error' : 'outline'}
        >
          {ROW_ACTION_LABELS[action]}
          <span className="sr-only">{` for ${admin.email}`}</span>
        </Button>
      )))}
    </div>
  );
}

export function AdminsTable({ admins, nowIso, busy, onAction }: AdminsTableProps) {
  return (
    <DashboardPanel>
      <TableScroll label="Admins">
        <table className="w-full min-w-[820px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--jale-divider)]">
              <th className={HEAD} scope="col">Admin</th>
              <th className={`${HEAD} w-[120px]`} scope="col">Role</th>
              <th className={`${HEAD} w-[130px]`} scope="col">Status</th>
              <th className={`${HEAD} w-[140px]`} scope="col">Last sign-in</th>
              <th className={`${HEAD} w-[130px]`} scope="col">Trusted browsers</th>
              <th className={`${HEAD} w-[250px] text-right`} scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {admins.length === 0 ? (
              <tr>
                <td className={`${CELL} text-[var(--jale-ink-2)]`} colSpan={6}>No admins to show.</td>
              </tr>
            ) : admins.map((admin) => (
              <tr className="border-b border-[var(--jale-divider)] last:border-b-0" data-admin={admin.id} key={admin.id}>
                <td className={CELL}>
                  <span className="font-semibold text-[var(--jale-ink)] [overflow-wrap:anywhere]" translate="no">{admin.email}</span>
                </td>
                <td className={`${CELL} font-semibold`}>{roleLabel(admin.role)}</td>
                <td className={CELL}>
                  <Badge tone={ADMIN_STATUS_TONES[admin.status]}>{ADMIN_STATUS_LABELS[admin.status]}</Badge>
                </td>
                <td className={`${CELL} text-[var(--jale-ink-2)]`}>
                  {admin.lastSignInAt ? <LocalTime format="relative" iso={admin.lastSignInAt} nowIso={nowIso} /> : 'Never'}
                </td>
                <td className={`${CELL} tabular-nums text-[var(--jale-ink-2)]`}>{admin.trustedBrowsers}</td>
                <td className={CELL}>
                  <RowActions admin={admin} busy={busy} onAction={onAction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </DashboardPanel>
  );
}
