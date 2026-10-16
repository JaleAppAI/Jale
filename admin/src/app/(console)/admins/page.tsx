import { AdminsView } from '@/components/admins/AdminsView';
import { loadAdmins } from '@/lib/server/admin-users';
import { requireAdminSession } from '@/lib/server/session';

// Superadmins only (K1.5). Another role gets the 403 view (the response status
// stays 200) and loadAdmins records the attempt. The list is a recorded read.
export default async function AdminsPage() {
  const session = await requireAdminSession();
  const result = await loadAdmins(session);
  return <AdminsView nowIso={new Date().toISOString()} result={result} />;
}
