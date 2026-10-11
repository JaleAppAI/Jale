import { AccessHistoryView } from '@/components/access-history/AccessHistoryView';
import { loadAccessHistory } from '@/lib/server/admin-audit';
import { requireAdminSession } from '@/lib/server/session';

type AccessHistoryPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Superadmins only. Another role gets the 403 view (an inline page; the
// response status stays 200) and its attempt is recorded. A search records
// itself through jale_audit.history_search, in the read's transaction.
export default async function AccessHistoryPage({ searchParams }: AccessHistoryPageProps) {
  const session = await requireAdminSession();
  const result = await loadAccessHistory(session, await searchParams);
  return <AccessHistoryView result={result} />;
}
