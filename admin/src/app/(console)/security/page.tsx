import { AccessHistoryView } from '@/components/security/AccessHistoryView';
import { adminFilterOptions } from '@/components/security/security-query';
import { loadAccessHistory } from '@/lib/server/admin-audit';
import { loadAdmins } from '@/lib/server/admin-users';
import { requireAdminSession } from '@/lib/server/session';

type SecurityPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Superadmins only (K1.6). Another role gets the 403 view (the response status
// stays 200) and its attempt is recorded once, by loadAccessHistory: the admin
// list for the Admin filter is read only when the history itself is shown, so
// a refused visit records one denied attempt, not two. A search records itself
// through jale_audit.history_search, in the read's transaction.
export default async function SecurityPage({ searchParams }: SecurityPageProps) {
  const session = await requireAdminSession();
  const result = await loadAccessHistory(session, await searchParams);
  const admins = result.status === 'ok' || result.status === 'invalid'
    ? adminFilterOptions(await loadAdmins(session))
    : [];
  return <AccessHistoryView admins={admins} nowIso={new Date().toISOString()} result={result} />;
}
