'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import type { CaseAction } from '@/lib/server/inbox-actions';
import { useInboxActions } from './inbox-actions-context';
import { inboxActionMessage, supportCaseHref } from './inbox-view';
import { BUTTON_LINK_OUTLINE, DANGER_TEXT, MUTED } from './styles';

/**
 * A support conversation for the locked-out number. An open case is a plain
 * link. Otherwise the action opens or reuses one (sending nothing) and goes
 * to it (K2.7).
 */
export function OpenSupportButton({ challengeId, supportCaseId, action }: { challengeId: string; supportCaseId: string | null; action: CaseAction }) {
  const router = useRouter();
  const { pending, run } = useInboxActions();
  const id = useId();
  const [failure, setFailure] = useState<string | null>(null);

  if (supportCaseId) {
    return <Link className={BUTTON_LINK_OUTLINE} href={supportCaseHref(supportCaseId)} prefetch={false}>Open a support conversation</Link>;
  }

  async function open() {
    setFailure(null);
    const result = await run({ action: 'open_support_from_lockout', challengeId });
    if (result.ok && result.kind === 'case') {
      router.push(supportCaseHref(result.caseId));
      return;
    }
    setFailure(inboxActionMessage('open_support_from_lockout', result)?.text ?? null);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        aria-describedby={action.enabled ? undefined : `${id}-disabled`}
        disabled={!action.enabled || pending !== null}
        loading={pending === 'open_support_from_lockout'}
        loadingLabel="Opening…"
        onClick={() => { void open(); }}
        type="button"
        variant="outline"
      >
        Open a support conversation
      </Button>
      {action.enabled ? null : <p className={MUTED} id={`${id}-disabled`}>{action.reason ?? 'Not available right now.'}</p>}
      {failure ? <p className={DANGER_TEXT} role="alert">{failure}</p> : null}
    </div>
  );
}
