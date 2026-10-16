'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { adminFetchJson } from '@/lib/admin-fetch';
import type { AdminUserActionResult } from '@/lib/server/admin-users';
import {
  createAdminActionRunner,
  refreshesListAfter,
  successMessage,
  type AdminActionInput,
  type FormFeedback,
} from './admin-actions';

/**
 * Runs Admins actions through POST /api/admin-users. admin-fetch adds the
 * payload hash and sends an ended session to sign-in. One action at a time;
 * a retry the server asked for resends the same request.
 */
export function useAdminAction() {
  const router = useRouter();
  const toast = useToast();
  const [runner] = useState(() => createAdminActionRunner({
    post: (action) => adminFetchJson<AdminUserActionResult>('/api/admin-users', { method: 'POST', body: action }),
    newId: () => crypto.randomUUID(),
  }));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FormFeedback | undefined>();

  async function run(input: AdminActionInput): Promise<boolean> {
    setBusy(true);
    setFeedback(undefined);
    const result = await runner.run(input);
    if (result.kind === 'busy') return false;
    // The browser is on its way to sign-in: nothing new is shown.
    if (result.kind === 'redirecting') return false;
    setBusy(false);
    if (result.kind === 'failed') {
      if (refreshesListAfter(result)) router.refresh();
      setFeedback({ message: result.message, retry: result.retry });
      return false;
    }
    toast.success(successMessage(input, result.admin));
    router.refresh();
    return true;
  }

  function reset() {
    runner.reset();
    setFeedback(undefined);
  }

  return { busy, feedback, run, reset };
}
