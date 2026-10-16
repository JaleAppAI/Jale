import Link from 'next/link';
import { LocalTime } from '@/components/LocalTime';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { accessHistoryHref } from '@/lib/access-history';
import { isUuid } from '@/lib/server/audit/codes';
import type { SupportConversation } from '@/lib/server/support-conversation';
import type { AdminRole } from '@/lib/types';
import { RevealPhoneDialog } from './RevealPhoneDialog';
import { adminsToldText, caseAction, contentText, failedCodesText, onboardingText, supportCaseHref } from './inbox-view';
import { MUTED, PANEL_TITLE, TEXT_LINK } from './styles';

/** Who the worker is and what this case holds (K2.4 worker, facts, earlierCases). Null facts never print. */
export function CaseContextPanel({ conversation, nowIso, role }: { conversation: SupportConversation; nowIso: string; role: AdminRole }) {
  const { worker, facts, earlierCases } = conversation;
  const workerItems: KVItem[] = [
    { label: 'Onboarding', value: onboardingText(worker) },
    ...(worker.failedCodesToday === null ? [] : [{ label: 'Verification', value: failedCodesText(worker.failedCodesToday) }]),
    {
      label: 'Joined',
      value: worker.joinedAt ? <LocalTime format="date" iso={worker.joinedAt} /> : worker.registered ? '—' : 'Not registered',
    },
  ];
  const caseItems: KVItem[] = [
    { label: 'Opened', value: <LocalTime iso={facts.openedAt} /> },
    { label: 'Waiting', value: facts.waitingSince ? <LocalTime format="relative" iso={facts.waitingSince} nowIso={nowIso} /> : 'Not waiting' },
    { label: 'Content', value: contentText(facts.messageCount, facts.mediaCount) },
    { label: 'Admins told', value: adminsToldText(facts.adminsEmailed) },
  ];

  return (
    <aside aria-label="Worker and case" className="flex min-w-0 flex-[1_1_18rem] flex-col gap-4">
      <DashboardPanel as="div" className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-sm font-extrabold text-[var(--jale-blue-700)]">
            {worker.label.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[0.9375rem] font-bold text-[var(--jale-ink)] [overflow-wrap:anywhere]">{worker.label}</span>
            <span className="text-xs text-[var(--jale-ink-2)]">WhatsApp · {conversation.languageLabel}</span>
          </span>
        </div>
        <KVList items={workerItems} />
        <RevealPhoneDialog action={caseAction(conversation.actions, 'reveal_phone')} caseId={conversation.caseId} />
        {role === 'admin_superadmin' && isUuid(worker.userId) ? (
          <Link className={`text-sm ${TEXT_LINK}`} href={accessHistoryHref({ subjectUserId: worker.userId })} prefetch={false}>
            Access history for this person
          </Link>
        ) : null}
      </DashboardPanel>

      <section aria-labelledby="case-facts-heading">
        <DashboardPanel as="div" className="flex flex-col gap-2 p-5">
          <h2 className={PANEL_TITLE} id="case-facts-heading">Case</h2>
          <KVList items={caseItems} />
        </DashboardPanel>
      </section>

      <section aria-labelledby="earlier-cases-heading">
        <DashboardPanel as="div" className="flex flex-col gap-2 p-5">
          <h2 className={PANEL_TITLE} id="earlier-cases-heading">Earlier cases</h2>
          {earlierCases.length === 0 ? (
            <p className={MUTED}>No earlier cases.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {earlierCases.map((earlier) => (
                <li key={earlier.caseId}>
                  <Link className={`text-sm ${TEXT_LINK}`} href={supportCaseHref(earlier.caseId)} prefetch={false}>
                    <span translate="no">{earlier.ref}</span> · {earlier.statusLabel}
                    {earlier.closedAt ? <> · <LocalTime format="relative" iso={earlier.closedAt} nowIso={nowIso} /></> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </section>
    </aside>
  );
}
