import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InboxActionsProvider } from '@/components/inbox/InboxActionsProvider';
import { LockoutResetForm } from '@/components/inbox/LockoutResetForm';
import { LockoutStats } from '@/components/inbox/LockoutStats';
import { LockoutTimeline } from '@/components/inbox/LockoutTimeline';
import { OpenSupportButton } from '@/components/inbox/OpenSupportButton';
import { caseAction, lockoutHeading, lockoutSubtitle, lockoutTone } from '@/components/inbox/inbox-view';
import { BACK_LINK, MUTED, PAGE_TITLE } from '@/components/inbox/styles';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { loadLockoutDetail } from '@/lib/server/admin-lockouts';
import { requireAdminSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Verification lockout' };

export default async function LockoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  const { id } = await params;
  // Records the challenge id under admin.lockout_detail before rendering.
  const detail = await loadLockoutDetail(session, id);
  if (!detail) {
    notFound();
  }
  const nowIso = new Date().toISOString();

  return (
    <InboxActionsProvider>
      <div className="mx-auto flex w-full max-w-[74rem] flex-col gap-5">
        <header className="flex flex-col gap-2">
          <Link className={BACK_LINK} href="/inbox?tab=lockouts" prefetch={false}><span aria-hidden="true">←</span> Inbox</Link>
          <div><Badge tone={lockoutTone(detail.state)}>{detail.statusLabel}</Badge></div>
          <h1 className={PAGE_TITLE}><span translate="no">{detail.ref}</span> · {lockoutHeading(detail.state)}</h1>
          <p className={MUTED}>{lockoutSubtitle(detail)}</p>
        </header>
        <LockoutStats detail={detail} nowIso={nowIso} />
        <div className="flex flex-wrap items-start gap-5">
          <LockoutTimeline timeline={detail.timeline} />
          <aside aria-label="Actions" className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4">
            <DashboardPanel as="div" className="flex flex-col gap-4 p-5">
              <LockoutResetForm
                action={caseAction(detail.actions, 'reset_lockout')}
                attemptsAllowed={detail.attemptsAllowed}
                challengeId={detail.challengeId}
                languageLabel={detail.languageLabel}
              />
              <OpenSupportButton action={caseAction(detail.actions, 'open_support_from_lockout')} challengeId={detail.challengeId} supportCaseId={detail.supportCaseId} />
            </DashboardPanel>
          </aside>
        </div>
      </div>
    </InboxActionsProvider>
  );
}
