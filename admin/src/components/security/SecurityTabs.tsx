import { securityTabItems } from '@/components/security/security-query';
import { TabNav } from '@/components/ui/tab-nav';
import type { AccessHistoryFilter } from '@/lib/access-history';

/** Access history, Admin actions, Sign-ins: links that preset the search (K1.6). */
export function SecurityTabs({ filter }: { filter: AccessHistoryFilter }) {
  return <TabNav items={securityTabItems(filter)} label="Security sections" />;
}
