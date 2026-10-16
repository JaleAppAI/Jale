import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocalTime } from '@/components/LocalTime';
import { CaseContextPanel } from '@/components/inbox/CaseContextPanel';
import { ConversationThread } from '@/components/inbox/ConversationThread';
import { InboxActionsProvider } from '@/components/inbox/InboxActionsProvider';
import { ReplyComposer } from '@/components/inbox/ReplyComposer';
import { WindowBanner } from '@/components/inbox/WindowBanner';
import { WindowCountdown } from '@/components/inbox/WindowCountdown';
import { caseStatusTone, conversationSubtitle, hasWorkerMessages, templateCapSoon } from '@/components/inbox/inbox-view';
import { BACK_LINK, MUTED, PAGE_TITLE } from '@/components/inbox/styles';
import { Badge } from '@/components/ui/badge';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { loadSupportConversation } from '@/lib/server/support-conversation';
import { requireAdminSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Support conversation' };

export default async function SupportConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminSession();
  const { id } = await params;
  // Records the case, its messages and its subject under admin.support_conversation before rendering.
  const conversation = await loadSupportConversation(session, id);
  if (!conversation) {
    notFound();
  }
  const nowIso = new Date().toISOString();
  const { window: chat } = conversation;
  // The last 30 minutes of the window, when the server caps replies. Same `nowIso` as the countdown.
  const capSoon = chat.open && chat.closesAt !== null && templateCapSoon(chat.closesAt, nowIso);
  const timing = chat.open
    ? (chat.closesAt ? <WindowCountdown closesAt={chat.closesAt} nowIso={nowIso} /> : null)
    : (chat.closedAt ? <LocalTime format="relative" iso={chat.closedAt} nowIso={nowIso} /> : null);

  return (
    <InboxActionsProvider>
      <div className="mx-auto flex w-full max-w-[74rem] flex-col gap-5">
        <header className="flex flex-col gap-2">
          <Link className={BACK_LINK} href="/inbox" prefetch={false}><span aria-hidden="true">←</span> Inbox</Link>
          <div><Badge tone={caseStatusTone(conversation.status)}>{conversation.statusLabel}</Badge></div>
          <h1 className={PAGE_TITLE}><span translate="no">{conversation.ref}</span> · {conversation.subject}</h1>
          <p className={MUTED}>{conversationSubtitle(conversation)}</p>
        </header>
        <div className="flex flex-wrap items-start gap-5">
          <section aria-label="Conversation" className="min-w-0 flex-[999_1_32rem]">
            <DashboardPanel as="div" className="overflow-hidden">
              <ConversationThread caseId={conversation.caseId} messages={conversation.messages} workerLabel={conversation.worker.label} />
              <div className="flex flex-col gap-3 border-t border-[var(--jale-divider)] p-4 sm:p-5">
                <WindowBanner capSoon={capSoon} languageLabel={conversation.languageLabel} open={chat.open} timing={timing} />
                <ReplyComposer
                  actions={conversation.actions}
                  capSoon={capSoon}
                  caseId={conversation.caseId}
                  language={conversation.language}
                  languageLabel={conversation.languageLabel}
                  reply={conversation.reply}
                  startsConversation={!hasWorkerMessages(conversation.messages)}
                />
              </div>
            </DashboardPanel>
          </section>
          <CaseContextPanel conversation={conversation} nowIso={nowIso} role={session.role} />
        </div>
      </div>
    </InboxActionsProvider>
  );
}
