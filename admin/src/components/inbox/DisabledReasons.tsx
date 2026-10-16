import type { CaseAction } from '@/lib/server/inbox-actions';
import { disabledReasons } from './inbox-view';
import { MUTED } from './styles';

/** The server's reasons for disabled actions, shown as text: an action is never hidden (K2.7). */
export function DisabledReasons({ actions, id }: { actions: readonly CaseAction[]; id: string }) {
  const reasons = disabledReasons(actions);
  if (reasons.length === 0) return null;
  return (
    <div className={`flex flex-col gap-0.5 ${MUTED}`} id={id}>
      {reasons.map((reason) => <p key={reason}>{reason}</p>)}
    </div>
  );
}
