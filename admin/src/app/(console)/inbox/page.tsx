import type { Metadata } from 'next';
import Link from 'next/link';
import { InboxFilters } from '@/components/inbox/InboxFilters';
import { InboxPager, InboxTable } from '@/components/inbox/InboxTable';
import { InboxTabs } from '@/components/inbox/InboxTabs';
import { inboxEmptyCopy } from '@/components/inbox/inbox-view';
import { BUTTON_LINK_OUTLINE, MUTED } from '@/components/inbox/styles';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { canReport } from '@/lib/report-policy';
import { loadInbox, parseInboxQuery } from '@/lib/server/admin-inbox';
import { requireAdminSession } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Inbox' };

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireAdminSession();
  const query = parseInboxQuery(await searchParams);
  // Records each source's rows under admin.inbox before rendering.
  const page = await loadInbox(session, query);
  const nowIso = new Date().toISOString();
  const empty = inboxEmptyCopy(query);

  return (
    <div className="mx-auto flex w-full max-w-[74rem] flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--jale-ink)]">Inbox</h1>
          <p className={`mt-1.5 ${MUTED}`}>Everything waiting on an admin, oldest first. Each item opens its own view and actions.</p>
        </div>
        {canReport(session.role, 'view_settings') ? (
          <Link className={BUTTON_LINK_OUTLINE} href="/reports/settings" prefetch={false}>Report settings</Link>
        ) : null}
      </header>
      <div className="flex flex-col gap-3">
        <InboxTabs counts={page.tabCounts} query={query} />
        <InboxFilters query={query} />
      </div>
      {page.items.length === 0 ? (
        <DashboardPanel as="div">
          <EmptyState body={empty.body} title={empty.title} variant={empty.filtered ? 'filtered' : 'default'} />
        </DashboardPanel>
      ) : (
        <InboxTable items={page.items} nowIso={nowIso} />
      )}
      <InboxPager nextBefore={page.nextBefore} query={query} shown={page.items.length} total={page.total} />
    </div>
  );
}
