import { TabNav } from '@/components/ui/tab-nav';
import type { InboxQuery, InboxTab } from '@/lib/server/admin-inbox';
import { INBOX_TABS, inboxListHref } from './inbox-view';

/**
 * The four Inbox tabs with their counts under the current status filter
 * (K2.3 tabCounts). A tab keeps the status and the search and starts again
 * from the newest page.
 */
export function InboxTabs({ query, counts }: { query: Pick<InboxQuery, 'tab' | 'status' | 'q'>; counts: Record<InboxTab, number> }) {
  return (
    <TabNav
      items={INBOX_TABS.map((tab) => ({
        label: tab.label,
        href: inboxListHref({ tab: tab.id, status: query.status, q: query.q }),
        count: counts[tab.id],
        active: tab.id === query.tab,
      }))}
      label="Inbox sections"
    />
  );
}
