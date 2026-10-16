import { Button } from '@/components/ui/button';
import type { AdminListItem } from '@/lib/server/admin-users';
import { ROW_ACTION_LABELS } from './admin-actions';

export function ResendInviteButton({ admin, busy, onResend }: {
  admin: AdminListItem;
  busy: boolean;
  onResend: () => void;
}) {
  return (
    <Button disabled={busy} onClick={onResend} size="sm" type="button" variant="outline">
      {ROW_ACTION_LABELS.resend_invite}
      <span className="sr-only">{` for ${admin.email}`}</span>
    </Button>
  );
}
